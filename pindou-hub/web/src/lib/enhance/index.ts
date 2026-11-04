// 图片高清化（“豆探”识别前的预处理）：判断上传图是否太糊 / 太小，必要时离线放大成高清像素，
// 让格子颜色更纯、图例和格内的小字更清楚。纯 TS，可在 Web Worker、主线程和 Node（评测脚本）里运行。
//
// 接口约定（UI 与识别引擎都只依赖这里导出的类型和函数）：
//   assessQuality(src, grid?)      → 这张图清不清楚、建议放大几倍（毫秒级）
//   enhanceImage(src, opts)        → 放大后的高清图 + 方法说明（纯函数，同步计算包在 Promise 里）
//   enhanceInWorker(src, opts)     → 同上，但在 Web Worker 里算，不卡界面；可取消
import type { PixelSource } from "@engine/types";
import type { GridDetection } from "../recognize/types";
import { detectGrid } from "../recognize/grid";
import { assessQuality as assess, TARGET_PITCH } from "./assess";
import { chartRebuild } from "./rebuild";
import { checkAbort, deblock, lanczosResize, unsharp } from "./resample";

export type QualityLevel = "good" | "low" | "very-low";

export type ImageQuality = {
  width: number;
  height: number;
  /** 检测到的格子边长（像素），没有网格为 null */
  pitchPx: number | null;
  /** 估计的图例 / 抬头文字高度（像素），估不出为 null */
  textPx: number | null;
  /** 0–1：JPEG 8×8 方块感，越高越明显 */
  blockiness: number;
  /** 0–1：模糊程度，越高越糊 */
  blur: number;
  level: QualityLevel;
  /** 建议放大倍数（1 = 不需要） */
  suggestedScale: 1 | 2 | 3 | 4;
  /** 给用户看的中文原因，如 “格子只有 7 像素宽”“JPEG 压缩痕迹明显” */
  reasons: string[];
};

/** chart-rebuild：按网格重建（每格取纯色、文字墨迹单独放大锐化、重画格线）；sharp-upscale：通用放大 + 去块 + 锐化 */
export type EnhanceMethod = "chart-rebuild" | "sharp-upscale" | "none";

export type EnhanceOptions = {
  /** 放大倍数；"auto" 按 assessQuality 的建议（默认） */
  scale?: number | "auto";
  /** 方法；"auto" = 有可信网格用 chart-rebuild，否则 sharp-upscale（默认） */
  method?: EnhanceMethod | "auto";
  /** 输出长边上限，默认 5000（手机内存） */
  maxEdge?: number;
  /** 已检测到的网格（坐标基于 src），不传则内部自己检测 */
  grid?: GridDetection | null;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
};

export type EnhanceResult = {
  /** 高清图（未增强时就是原图） */
  image: PixelSource;
  /** 实际放大倍数（image.width / src.width），未增强为 1 */
  scale: number;
  method: EnhanceMethod;
  quality: ImageQuality;
  ms: number;
  /** 中文说明，如 “620×540 → 1860×1620（×3，按网格重建，格子 9→27 像素）” */
  detail: string;
};

/** 识别结果里附带的高清化概况（AnalyzeResult.enhance） */
export type EnhanceSummary = {
  applied: boolean;
  method: EnhanceMethod;
  scale: number;
  level: QualityLevel;
  from: { width: number; height: number };
  to: { width: number; height: number };
  detail: string;
};

// ---- 实现 ----

export const assessQuality = assess;

/** 内部自己检测网格时的可信门槛（与识别引擎一致：太小 / 置信低的多半是巧合周期） */
function trustedGrid(g: GridDetection | null | undefined): GridDetection | null {
  return g && g.cols >= 8 && g.rows >= 8 && g.score >= 0.45 ? g : null;
}

export async function enhanceImage(src: PixelSource, opts: EnhanceOptions = {}): Promise<EnhanceResult> {
  const t0 = performance.now();
  checkAbort(opts.signal);
  let grid = opts.grid === undefined ? null : trustedGrid(opts.grid);
  if (opts.grid === undefined) { try { grid = trustedGrid(detectGrid(src, null)); } catch { grid = null; } }
  const quality = assess(src, grid);
  const none = (detail: string): EnhanceResult => ({ image: src, scale: 1, method: "none", quality, ms: Math.round(performance.now() - t0), detail });
  if (opts.method === "none") return none("未放大");

  let scale = opts.scale === undefined || opts.scale === "auto" ? quality.suggestedScale : Math.max(1, opts.scale);
  if (scale <= 1) return none("图片已足够清晰，未放大");
  const maxEdge = opts.maxEdge ?? 5000;
  scale = Math.min(scale, maxEdge / Math.max(src.width, src.height));
  if (scale < 1.2) return none(`图片已接近输出上限（${maxEdge} 像素），未放大`);
  const dw = Math.round(src.width * scale), dh = Math.round(src.height * scale);

  const useRebuild = opts.method === "chart-rebuild" ? !!grid : opts.method === undefined || opts.method === "auto" ? !!grid && grid.score >= 0.6 : false;
  let image: PixelSource;
  let method: EnhanceMethod;
  const prog = opts.onProgress;
  if (useRebuild && grid) {
    method = "chart-rebuild";
    image = await chartRebuild(src, grid, dw, dh, quality.blockiness, opts.signal, prog);
  } else {
    method = "sharp-upscale";
    const base = quality.blockiness > 0.3 ? deblock(src, quality.blockiness) : src;
    image = await lanczosResize(base, dw, dh, opts.signal, (f) => prog?.(f));
    unsharp(image, 0.5 + 0.4 * quality.blur);
    prog?.(1);
  }
  const s = image.width / src.width;
  const how = method === "chart-rebuild" ? "按网格重建" : "锐化放大";
  const cell = method === "chart-rebuild" && quality.pitchPx ? `，格子 ${Math.round(quality.pitchPx)}→${Math.round(quality.pitchPx * s)} 像素` : "";
  return { image, scale: s, method, quality, ms: Math.round(performance.now() - t0), detail: `${src.width}×${src.height} → ${image.width}×${image.height}（×${Number(s.toFixed(2))}，${how}${cell}）` };
}

// ---- Worker 客户端（与 generate.ts 同一模式）----

export type EnhanceRequest = { id: number; width: number; height: number; buffer: ArrayBuffer; opts: Omit<EnhanceOptions, "signal" | "onProgress"> };
export type EnhanceResponse =
  | { id: number; type: "progress"; fraction: number }
  | { id: number; type: "done"; result: Omit<EnhanceResult, "image"> & { width: number; height: number; buffer: ArrayBuffer | null } }
  | { id: number; type: "error"; error: string };

let seq = 0;
/** 在 Web Worker 里高清化，界面不卡；cancel() 直接终止 Worker。没有 Worker（Node / 老环境）时退回主线程。 */
export function enhanceInWorker(src: PixelSource, opts: Omit<EnhanceOptions, "signal" | "onProgress"> = {}): { promise: Promise<EnhanceResult>; cancel: () => void } {
  if (typeof Worker === "undefined") {
    const ac = new AbortController();
    return { promise: enhanceImage(src, { ...opts, signal: ac.signal }), cancel: () => ac.abort() };
  }
  const id = ++seq;
  let worker: Worker;
  try { worker = new Worker(new URL("./enhance.worker.ts", import.meta.url), { type: "module" }); }
  catch {
    const ac = new AbortController();
    return { promise: enhanceImage(src, { ...opts, signal: ac.signal }), cancel: () => ac.abort() };
  }
  let reject!: (e: Error) => void;
  const promise = new Promise<EnhanceResult>((res, rej) => {
    reject = rej;
    worker.onmessage = (event: MessageEvent<EnhanceResponse>) => {
      const msg = event.data;
      if (msg.id !== id || msg.type === "progress") return;
      worker.terminate();
      if (msg.type === "error") { rej(new Error(msg.error)); return; }
      const r = msg.result;
      const image: PixelSource = r.buffer ? { width: r.width, height: r.height, data: new Uint8ClampedArray(r.buffer) } : src;
      res({ image, scale: r.scale, method: r.method, quality: r.quality, ms: r.ms, detail: r.detail });
    };
    worker.onerror = (event) => { worker.terminate(); rej(new Error(event.message || "高清化失败")); };
  });
  // 复制一份再转移：调用方还要继续用 src
  const copy = src.data.slice().buffer as ArrayBuffer;
  worker.postMessage({ id, width: src.width, height: src.height, buffer: copy, opts } satisfies EnhanceRequest, [copy]);
  return { promise, cancel: () => { worker.terminate(); reject(new DOMException("已取消", "AbortError")); } };
}

export function summarizeEnhance(src: PixelSource, r: EnhanceResult): EnhanceSummary {
  return { applied: r.method !== "none" && r.scale > 1, method: r.method, scale: r.scale, level: r.quality.level, from: { width: src.width, height: src.height }, to: { width: r.image.width, height: r.image.height }, detail: r.detail };
}

export { TARGET_PITCH };
