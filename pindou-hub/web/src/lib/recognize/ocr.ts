// tesseract.js 的懒加载封装：完全离线（worker / wasm / 语言包都在 public/ocr/ 下），复用同一个 worker。
import type { PixelSource } from "@engine/types";
import { isNativeApp } from "../sync";

export type OcrWord = { text: string; bbox: { x0: number; y0: number; x1: number; y1: number }; confidence: number };
export type OcrResult = { text: string; words: OcrWord[] };

/** 测试 / 非浏览器环境可注入自己的识别后端（node 下没有 document / canvas）。 */
export type OcrBackend = {
  recognize: (source: PixelSource | HTMLCanvasElement, signal: AbortSignal | undefined, opts: { scale?: number; psm?: string; whitelist?: string }) => Promise<OcrResult>;
  terminate?: () => Promise<void>;
};
let backend: OcrBackend | null = null;
// 同时挂在 globalThis 上：测试 / 脚本经不同的模块加载器（vite ssr）可能得到两份本模块，全局变量让它们共用同一个后端
const G = globalThis as unknown as { __phOcrBackend?: OcrBackend | null };
export function setOcrBackend(b: OcrBackend | null): void { backend = b; G.__phOcrBackend = b; }
const activeBackend = (): OcrBackend | null => backend ?? G.__phOcrBackend ?? null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Slot = { p: Promise<any> | null; busy: boolean; key: string };
/** 小型 worker 池：互相独立的识别可并发（桌面端 2 个，手机 App 1 个以省内存）；每个 worker 记住上次的参数，不变就不重复设置 */
const POOL = (() => {
  try { return !isNativeApp() && (navigator.hardwareConcurrency ?? 2) >= 4 ? 2 : 1; } catch { return 1; }
})();
const slots: Slot[] = Array.from({ length: POOL }, () => ({ p: null, busy: false, key: "" }));
const waiters: Array<() => void> = [];
let cache = new Map<string, OcrResult>();

function ocrBase(): string {
  // 应用以相对 base './' 部署（Hub 托管或 Android http://localhost），资源相对 document.baseURI
  return new URL("./", document.baseURI).href + "ocr/";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeWorker(slot: Slot): Promise<any> {
  if (!slot.p) {
    slot.p = (async () => {
      const mod = await import("tesseract.js");
      const base = ocrBase();
      const createWorker = (mod as any).createWorker ?? (mod as any).default?.createWorker;
      // 同时加载中文：中文图例的色名、数量单位（颗/粒）和抬头（尺寸/色/总计）都能读到。
      // 离线语言包由 scripts/copy-ocr-assets.mjs 复制到 public/ocr。
      return createWorker("eng+chi_sim", 1, {
        workerPath: base + "worker.min.js",
        corePath: base,
        langPath: base,
        // Android 打包时 aapt 会把 .gz 资源解压并去掉扩展名（APK 里是 eng.traineddata），
        // 所以原生 App 里按未压缩文件加载；浏览器里仍用 eng.traineddata.gz。
        gzip: !isNativeApp(),
        workerBlobURL: false
      });
    })();
    slot.p.catch(() => { slot.p = null; });
  }
  return slot.p;
}

async function acquire(): Promise<Slot> {
  for (;;) {
    const free = slots.find((x) => !x.busy);
    if (free) { free.busy = true; return free; }
    await new Promise<void>((res) => waiters.push(res));
  }
}
function release(slot: Slot): void { slot.busy = false; waiters.shift()?.(); }

export async function terminateOcr(): Promise<void> {
  cache = new Map();
  const be = activeBackend();
  if (be) { try { await be.terminate?.(); } catch { /* 忽略 */ } return; }
  for (const slot of slots) {
    const p = slot.p;
    slot.p = null;
    slot.key = "";
    if (!p) continue;
    try {
      const w = await p;
      await w.terminate();
    } catch {
      /* 已经失败/已终止 */
    }
  }
}

function toCanvas(source: PixelSource | HTMLCanvasElement, scale: number): { canvas: HTMLCanvasElement; scale: number } {
  const w0 = source.width;
  const h0 = source.height;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w0 * scale));
  canvas.height = Math.max(1, Math.round(h0 * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建画布");
  if (scale === 1 && !(source instanceof HTMLCanvasElement)) {
    ctx.putImageData(new ImageData(new Uint8ClampedArray(source.data), w0, h0), 0, 0);
  } else {
    let from: HTMLCanvasElement;
    if (source instanceof HTMLCanvasElement) from = source;
    else {
      from = document.createElement("canvas");
      from.width = w0;
      from.height = h0;
      from.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(source.data), w0, h0), 0, 0);
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(from, 0, 0, canvas.width, canvas.height);
  }
  return { canvas, scale };
}

function abortError() {
  return new DOMException("已取消", "AbortError");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function flatten(data: any, scale: number): OcrWord[] {
  const out: OcrWord[] = [];
  const push = (w: any) => {
    if (!w || typeof w.text !== "string" || !w.bbox) return;
    out.push({
      text: w.text,
      confidence: typeof w.confidence === "number" ? w.confidence : 0,
      bbox: { x0: w.bbox.x0 / scale, y0: w.bbox.y0 / scale, x1: w.bbox.x1 / scale, y1: w.bbox.y1 / scale }
    });
  };
  for (const b of data?.blocks ?? []) {
    for (const p of b?.paragraphs ?? []) {
      for (const l of p?.lines ?? []) for (const w of l?.words ?? []) push(w);
    }
  }
  if (!out.length) for (const w of data?.words ?? []) push(w);
  return out;
}

/** 像素内容指纹（FNV-1a，按 32 位字）：相同的叠图 + 相同参数不重复识别 */
function fingerprint(source: PixelSource | HTMLCanvasElement): string | null {
  if (typeof HTMLCanvasElement !== "undefined" && source instanceof HTMLCanvasElement) return null;
  const d = (source as PixelSource).data;
  let h = 2166136261 >>> 0;
  if (d.byteOffset % 4 === 0 && d.byteLength % 4 === 0) {
    const w = new Uint32Array(d.buffer, d.byteOffset, d.byteLength >> 2);
    for (let i = 0; i < w.length; i += 1) h = Math.imul(h ^ w[i], 16777619) >>> 0;
  } else for (let i = 0; i < d.length; i += 1) h = Math.imul(h ^ d[i], 16777619) >>> 0;
  return `${source.width}x${source.height}:${h.toString(36)}`;
}

export async function ocrWords(
  source: PixelSource | HTMLCanvasElement,
  signal?: AbortSignal,
  opts: { scale?: number; psm?: string; whitelist?: string } = {}
): Promise<OcrResult> {
  if (signal?.aborted) throw abortError();
  const fp = fingerprint(source);
  const ck = fp ? `${fp}|${opts.scale ?? ""}|${opts.psm ?? ""}|${opts.whitelist ?? ""}` : null;
  const hit = ck ? cache.get(ck) : undefined;
  if (hit) return hit;
  const res = await ocrWordsRaw(source, signal, opts);
  if (ck) { if (cache.size >= 80) cache = new Map(); cache.set(ck, res); }
  return res;
}

async function ocrWordsRaw(
  source: PixelSource | HTMLCanvasElement,
  signal: AbortSignal | undefined,
  opts: { scale?: number; psm?: string; whitelist?: string }
): Promise<OcrResult> {
  const be = activeBackend();
  if (be) return be.recognize(source, signal, opts);
  const maxSide = Math.max(source.width, source.height);
  // 小图放大 2 倍，图例小字更容易识别；过大的图不再放大
  const scale = opts.scale ?? (maxSide < 1600 ? 2 : 1);
  const outW = source.width * scale, outH = source.height * scale;
  if (outW < 4 || outH < 4 || outW > 16000 || outH > 32000) throw new Error(`图像尺寸不适合识别 ${Math.round(outW)}x${Math.round(outH)}`);
  const { canvas } = toCanvas(source, scale);
  const slot = await acquire();
  let onAbort: (() => void) | undefined;
  try {
    const worker = await makeWorker(slot);
    if (signal?.aborted) throw abortError();
    // 版面模式（色块叠放图用 6 整块文字，其余用 11 稀疏文字）+ 白名单；参数没变就不重复设置。dpi 固定，避免反复估计分辨率
    const key = `${opts.psm ?? "11"}|${opts.whitelist ?? ""}`;
    if (key !== slot.key) {
      try { await worker.setParameters({ tessedit_pageseg_mode: opts.psm ?? "11", user_defined_dpi: "300", tessedit_char_whitelist: opts.whitelist ?? "" }); slot.key = key; } catch { /* 忽略 */ }
    }
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => { void terminateOcr(); reject(abortError()); };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    const result = await Promise.race([worker.recognize(canvas, {}, { blocks: true, text: true }), aborted]);
    const data = (result as any)?.data ?? result;
    return { text: String(data?.text ?? ""), words: flatten(data, scale) };
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    release(slot);
  }
}
