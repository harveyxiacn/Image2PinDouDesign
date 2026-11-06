// 批量队列的运行器：模块级单例（切换页签/进入检查视图时队列和进度都不丢），一次只识别一张（OCR 很重）。
import { useSyncExternalStore } from "react";
import { analyzePattern } from "../../lib/recognize/assistant";
import type { AnalyzeResult } from "../../lib/recognize/types";
import { imageContentId, loadPixelSource, saveImage } from "../../lib/images";
import { getSnapshot } from "../../lib/db";
import { reduceBatch, nextWaiting, type BatchAction, type BatchItem } from "../../lib/batch";
import type { PatternStatus } from "../../lib/model";
import { createPattern } from "./save";
import { parseTags } from "./SaveForm";

let items: BatchItem[] = [];
const subs = new Set<() => void>();
export const batchStore = {
  get: () => items,
  subscribe: (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; },
  dispatch(a: BatchAction) { const next = reduceBatch(items, a); if (next !== items) { items = next; subs.forEach((f) => f()); } }
};
export const useBatch = () => useSyncExternalStore(batchStore.subscribe, batchStore.get);

let current: { id: string; ctl: AbortController } | null = null;
let pumping = false;

/** 队列里只保留展示和保存要用的字段，释放簇/墨迹等大数组 */
function slim(res: AnalyzeResult): AnalyzeResult {
  if (!res.grid) return res;
  const { clusters: _c, cellInk: _i, cellCluster: _k, ...grid } = res.grid;
  return { ...res, grid };
}

async function runOne(it: BatchItem) {
  const ctl = new AbortController();
  current = { id: it.id, ctl };
  batchStore.dispatch({ type: "start", id: it.id });
  try {
    // 查重：图库里已经有同样内容（同一套存储规格的 SHA-256）就不重复识别；用户可点“仍然识别”强制跑
    if (!it.force) {
      const contentId = await imageContentId(it.file);
      if (getSnapshot().images.some((img) => img.id === contentId && !img.deleted)) {
        batchStore.dispatch({ type: "duplicate", id: it.id, imageId: contentId });
        return;
      }
    }
    const px = await loadPixelSource(it.file, 2400);
    const full = await loadPixelSource(it.file, 5000).catch(() => null);
    if (ctl.signal.aborted) return;
    const res = await analyzePattern(px, {
      region: null, ocr: true, legendOcr: true, cellCodes: true, treatBackgroundAsEmpty: true, signal: ctl.signal,
      ocrSource: full && full.width > px.width ? full : undefined,
      onProgress: (step) => batchStore.dispatch({ type: "step", id: it.id, step })
    });
    if (!ctl.signal.aborted) batchStore.dispatch({ type: "finish", id: it.id, result: slim(res) });
  } catch (e) {
    if (!ctl.signal.aborted) batchStore.dispatch({ type: "fail", id: it.id, error: e instanceof Error ? e.message : "识别失败" });
  } finally {
    if (current?.id === it.id) current = null;
  }
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    for (;;) {
      const it = nextWaiting(batchStore.get());
      if (!it) break;
      await runOne(it);
    }
  } finally { pumping = false; }
}

export function enqueue(files: File[]) { batchStore.dispatch({ type: "add", files }); void pump(); }
export function cancelRemaining() { batchStore.dispatch({ type: "cancelAll" }); current?.ctl.abort(); }
export function retryItem(id: string) { batchStore.dispatch({ type: "retry", id }); void pump(); }

/** 保存一张识别结果到图库（与单张识别保存方式一致：原图入库 + 图案记录） */
export async function saveItem(it: BatchItem, status: PatternStatus): Promise<string | null> {
  const res = it.result;
  if (!res || it.savedId || !Object.keys(res.counts).length) return null;
  const meta = await saveImage(it.file, it.file.name || it.name, "source");
  const method = res.method === "none" ? "manual" : res.method;
  const p = await createPattern(
    { name: it.name, tags: parseTags(it.tag), status, copies: 1 },
    { kind: "recognized", method, counts: res.counts, imageId: meta.id, width: res.grid?.grid.cols, height: res.grid?.grid.rows, matrix: res.grid?.matrix, confidence: res.confidence, colorMatch: res.colorMatch, reviewReasons: it.reasons.length ? it.reasons : undefined, verifiedAt: it.verifiedAt }
  );
  batchStore.dispatch({ type: "saved", id: it.id, patternId: p.id });
  return p.id;
}

/** 不是图纸的图：保留原图、存成“收藏”，不进入采购。 */
export async function saveIdea(it: BatchItem): Promise<string | null> {
  if (it.savedId || (it.state !== "notchart" && it.state !== "done")) return null;
  const meta = await saveImage(it.file, it.file.name || it.name, "source");
  const p = await createPattern(
    { name: it.name, tags: parseTags(it.tag), status: "idea", copies: 1 },
    { kind: "recognized", method: "manual", counts: {}, imageId: meta.id }
  );
  batchStore.dispatch({ type: "saved", id: it.id, patternId: p.id });
  return p.id;
}
