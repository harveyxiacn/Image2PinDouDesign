// 批量导入的纯逻辑：队列状态机、文件夹→标签、结果分类、图上标注核对。无 DOM / React 依赖，便于单测。
import type { AnalyzeResult, AssistantStep } from "./recognize/types";
import { totalOf } from "./model";

export type BatchState = "waiting" | "running" | "done" | "notchart" | "duplicate" | "failed" | "cancelled";

export type BatchItem = {
  id: string;
  file: File;
  name: string;
  /** 来自 webkitRelativePath 的上级文件夹名，选文件时为空 */
  folder: string;
  /** 可编辑的标签文本（逗号/空格分隔），默认等于文件夹名 */
  tag: string;
  state: BatchState;
  steps: AssistantStep[];
  result?: AnalyzeResult;
  error?: string;
  savedId?: string;
  /** 图库里已经有同一张图（SHA-256 相同） */
  duplicateImageId?: string;
  /** 用户点过“仍然识别”，本次跳过查重 */
  force?: boolean;
  /** done 且需要人工核对 */
  review: boolean;
  reasons: string[];
};

export type BatchAction =
  | { type: "add"; files: File[]; ids?: string[] }
  | { type: "start"; id: string }
  | { type: "step"; id: string; step: AssistantStep }
  | { type: "finish"; id: string; result: AnalyzeResult }
  | { type: "duplicate"; id: string; imageId: string }
  | { type: "fail"; id: string; error: string }
  | { type: "name"; id: string; name: string }
  | { type: "cancelAll" }
  | { type: "retry"; id: string }
  | { type: "tag"; id: string; tag: string }
  | { type: "remove"; id: string }
  | { type: "saved"; id: string; patternId: string }
  | { type: "clear" };

/** 识别流程里“通常会出现”的步骤数（grid / legend / read / cellcode / compare），用于确定进度条 */
export const EXPECTED_STEPS = 5;
export const LOW_CONFIDENCE = 0.7;

const IMG_EXT = /\.(jpe?g|png|webp|bmp|gif|heic|heif|avif)$/i;
export function isImageFile(f: { name: string; type?: string }): boolean {
  return !!f.type?.startsWith("image/") || IMG_EXT.test(f.name);
}

/** 文件所在的直接上级文件夹名（选整个文件夹时）；没有相对路径则为空 */
export function folderOf(f: { webkitRelativePath?: string }): string {
  const parts = (f.webkitRelativePath ?? "").split(/[\\/]/).filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : "";
}

export function baseName(name: string): string {
  return name.replace(/\.[^.]+$/, "") || name;
}

/** 文件名像内容哈希（32/40/64 位十六进制）：导入后应该提示改成可读的名字。 */
export function isHashName(name: string): boolean {
  return /^[0-9a-f]{32}$|^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(baseName(name));
}

let counter = 0;
const newId = () => `b${Date.now().toString(36)}${(counter++).toString(36)}`;

export function makeItem(file: File, id = newId()): BatchItem {
  const folder = folderOf(file as { webkitRelativePath?: string });
  return { id, file, name: baseName(file.name), folder, tag: folder, state: "waiting", steps: [], review: false, reasons: [] };
}

/** 图上标注（header）与实际读到的逐项核对。ok=null 表示读不到一方，无法比较。 */
export type HeaderCheck = { key: "size" | "colors" | "total"; label: string; stated: string; read: string | null; ok: boolean | null };
export function headerChecks(result: AnalyzeResult): HeaderCheck[] {
  const h = result.header;
  if (!h) return [];
  const out: HeaderCheck[] = [];
  const g = result.grid?.grid;
  if (h.cols != null && h.rows != null) {
    const read = g ? `${g.cols}×${g.rows}` : null;
    out.push({ key: "size", label: "尺寸", stated: `${h.cols}×${h.rows}`, read, ok: read ? g!.cols === h.cols && g!.rows === h.rows : null });
  }
  const colors = Object.values(result.counts).filter((n) => n > 0).length;
  if (h.colors != null) out.push({ key: "colors", label: "色数", stated: `${h.colors} 色`, read: colors ? `${colors} 色` : null, ok: colors ? colors === h.colors : null });
  const total = totalOf(result.counts);
  if (h.total != null) out.push({ key: "total", label: "总数", stated: `${h.total} 颗`, read: total ? `${total} 颗` : null, ok: total ? total === h.total : null });
  return out;
}

/** 图例与网格都有数字、且不一致的色号数（图例漏读后按网格补上的色号不算“不一致”）。 */
export function mismatchCount(result: AnalyzeResult): number {
  return result.diff.filter((d) => d.legend > 0 && d.legend !== d.grid).length;
}

/** 上述差异中，图例和网格都读到了数字、可以逐色对比的色号数。 */
export function comparableMismatchCount(result: AnalyzeResult): number {
  return result.diff.filter((d) => d.legend > 0 && d.grid > 0 && d.legend !== d.grid).length;
}

/** 网格容量硬校验：数出的豆子数是否超过网格格子总数。 */
export function gridCapacity(result: AnalyzeResult): { cols: number; rows: number; capacity: number; total: number } | null {
  const g = result.grid?.grid;
  if (!g) return null;
  const total = totalOf(result.counts);
  return { cols: g.cols, rows: g.rows, capacity: g.cols * g.rows, total };
}

/** 把一次识别结果里“需要检查”的原因提取出来；保存时也写入 reviewReasons。 */
export function reviewReasonsFor(result: AnalyzeResult): string[] {
  if (result.isChart === false || result.method === "none" || !Object.keys(result.counts).length) return [];
  const reasons: string[] = [];
  const mm = mismatchCount(result);
  if (mm) {
    const cmp = comparableMismatchCount(result);
    reasons.push(`${mm} 个色号图例与网格有差异${cmp && cmp !== mm ? `（其中 ${cmp} 个双方都有数）` : ""}`);
  }
  const cap = gridCapacity(result);
  if (cap && cap.total > cap.capacity) reasons.push(`网格 ${cap.cols}×${cap.rows} 最多 ${cap.capacity} 格，却数出 ${cap.total} 颗`);
  const bad = headerChecks(result).filter((c) => c.ok === false);
  if (bad.length) reasons.push(`与图上标注不符：${bad.map((c) => c.label).join("、")}`);
  if (result.paletteWarning) reasons.push("色号体系可能不是 MARD");
  // 其他具体疑点已经说明问题时，不再重复加一句笼统的“可信度偏低”
  if (!reasons.length && result.confidence < LOW_CONFIDENCE) reasons.push("可信度偏低");
  return reasons;
}

/** 把一次识别结果归类，并给出“需要检查”的原因 */
export function classify(result: AnalyzeResult): { state: "done" | "notchart" | "failed"; review: boolean; reasons: string[]; error?: string } {
  if (result.isChart === false) return { state: "notchart", review: false, reasons: [], error: result.notChartReason };
  if (result.method === "none" || !Object.keys(result.counts).length) {
    return { state: "failed", review: false, reasons: [], error: "没有读到图例，也没能确定网格" };
  }
  const reasons = reviewReasonsFor(result);
  return { state: "done", review: reasons.length > 0, reasons };
}

export function reduceBatch(items: BatchItem[], a: BatchAction): BatchItem[] {
  const patch = (id: string, f: (it: BatchItem) => BatchItem) => items.map((it) => (it.id === id ? f(it) : it));
  switch (a.type) {
    case "add": {
      const known = new Set(items.map((i) => `${i.folder}/${i.file.name}/${i.file.size}`));
      const fresh: BatchItem[] = [];
      for (const f of a.files) {
        if (!isImageFile(f)) continue;
        const it = makeItem(f, a.ids?.[fresh.length]);
        const key = `${it.folder}/${f.name}/${f.size}`;
        if (known.has(key)) continue; // 重复选择同一张不再入队
        known.add(key);
        fresh.push(it);
      }
      return fresh.length ? [...items, ...fresh] : items;
    }
    case "start": return patch(a.id, (it) => (it.state === "waiting" ? { ...it, state: "running", steps: [], error: undefined } : it));
    case "step": return patch(a.id, (it) => {
      if (it.state !== "running") return it;
      const i = it.steps.findIndex((s) => s.id === a.step.id);
      return { ...it, steps: i < 0 ? [...it.steps, a.step] : it.steps.map((s, k) => (k === i ? a.step : s)) };
    });
    case "finish": return patch(a.id, (it) => {
      if (it.state !== "running") return it; // 已取消的不再被覆盖
      const c = classify(a.result);
      return { ...it, state: c.state, result: a.result, steps: a.result.steps, review: c.review, reasons: c.reasons, error: c.error };
    });
    case "duplicate": return patch(a.id, (it) => (it.state === "waiting" || it.state === "running" ? { ...it, state: "duplicate", duplicateImageId: a.imageId } : it));
    case "fail": return patch(a.id, (it) => (it.state === "running" ? { ...it, state: "failed", error: a.error } : it));
    case "name": return patch(a.id, (it) => ({ ...it, name: a.name.trim() || it.name }));
    case "cancelAll": return items.map((it) => (it.state === "waiting" || it.state === "running" ? { ...it, state: "cancelled" as const } : it));
    case "retry": return patch(a.id, (it) => (it.state === "failed" || it.state === "cancelled" || it.state === "notchart" || it.state === "duplicate" || it.state === "done" && !it.savedId
      ? { ...it, state: "waiting", steps: [], result: undefined, error: undefined, duplicateImageId: undefined, review: false, reasons: [], force: it.state === "duplicate" ? true : it.force } : it));
    case "tag": return patch(a.id, (it) => ({ ...it, tag: a.tag }));
    case "remove": return items.filter((it) => it.id !== a.id || it.state === "running");
    case "saved": return patch(a.id, (it) => ({ ...it, savedId: a.patternId }));
    case "clear": return items.filter((it) => it.state === "running" || it.state === "waiting");
  }
}

export function nextWaiting(items: BatchItem[]): BatchItem | undefined {
  return items.find((it) => it.state === "waiting");
}

/** 单张的进度 0–1（运行中最多到 0.95，结束为 1） */
export function itemProgress(it: Pick<BatchItem, "state" | "steps">): number {
  if (it.state === "waiting") return 0;
  if (it.state === "running") return Math.min(0.95, it.steps.length / EXPECTED_STEPS);
  return 1;
}

export function stepsProgress(steps: AssistantStep[], running: boolean): number {
  return running ? Math.min(0.95, steps.length / EXPECTED_STEPS) : 1;
}

export type BatchSummary = {
  total: number; waiting: number; running: number; done: number; notchart: number; duplicate: number; failed: number; cancelled: number;
  saved: number; review: number;
  /** 可一键保存：识别完成、未保存、无需检查 */
  savable: number;
  /** 0–1 */
  progress: number;
  active: boolean;
};
export function summarize(items: BatchItem[]): BatchSummary {
  const s: BatchSummary = { total: items.length, waiting: 0, running: 0, done: 0, notchart: 0, duplicate: 0, failed: 0, cancelled: 0, saved: 0, review: 0, savable: 0, progress: 0, active: false };
  let acc = 0;
  for (const it of items) {
    s[it.state]++;
    if (it.savedId) s.saved++;
    if (it.state === "done" && it.review && !it.savedId) s.review++;
    if (it.state === "done" && !it.review && !it.savedId) s.savable++;
    acc += it.state === "waiting" ? 0 : it.state === "running" ? itemProgress(it) : 1;
  }
  s.progress = items.length ? acc / items.length : 0;
  s.active = s.waiting + s.running > 0;
  return s;
}

/** 屏幕阅读器播报：某张识别结束时的一句话 */
export function announceFor(it: BatchItem): string {
  const n = it.name;
  if (it.state === "done") return `${n} 识别完成，共 ${it.result ? totalOf(it.result.counts) : 0} 颗${it.review ? "，需要检查" : ""}`;
  if (it.state === "notchart") return `${n} 看起来不是图纸`;
  if (it.state === "duplicate") return `${n} 图库里已经有这张图，已跳过`;
  if (it.state === "failed") return `${n} 识别失败`;
  if (it.state === "cancelled") return `${n} 已取消`;
  return "";
}
