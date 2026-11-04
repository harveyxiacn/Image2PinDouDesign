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
export function setOcrBackend(b: OcrBackend | null): void { backend = b; }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let workerPromise: Promise<any> | null = null;

function ocrBase(): string {
  // 应用以相对 base './' 部署（Hub 托管或 Android http://localhost），资源相对 document.baseURI
  return new URL("./", document.baseURI).href + "ocr/";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getWorker(): Promise<any> {
  if (!workerPromise) {
    workerPromise = (async () => {
      const mod = await import("tesseract.js");
      const base = ocrBase();
      const createWorker = (mod as any).createWorker ?? (mod as any).default?.createWorker;
      const worker = await createWorker("eng", 1, {
        workerPath: base + "worker.min.js",
        corePath: base,
        langPath: base,
        // Android 打包时 aapt 会把 .gz 资源解压并去掉扩展名（APK 里是 eng.traineddata），
        // 所以原生 App 里按未压缩文件加载；浏览器里仍用 eng.traineddata.gz。
        gzip: !isNativeApp(),
        workerBlobURL: false
      });
      try {
        // 11 = SPARSE_TEXT：图例是零散排布的文字，不适合整页段落模式
        await worker.setParameters({ tessedit_pageseg_mode: "11", user_defined_dpi: "300" });
      } catch {
        /* 参数不被接受时沿用默认分页模式 */
      }
      return worker;
    })();
    workerPromise.catch(() => { workerPromise = null; });
  }
  return workerPromise;
}

export async function terminateOcr(): Promise<void> {
  if (backend) { try { await backend.terminate?.(); } catch { /* 忽略 */ } return; }
  const p = workerPromise;
  workerPromise = null;
  if (!p) return;
  try {
    const w = await p;
    await w.terminate();
  } catch {
    /* 已经失败/已终止 */
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

export async function ocrWords(
  source: PixelSource | HTMLCanvasElement,
  signal?: AbortSignal,
  opts: { scale?: number; psm?: string; whitelist?: string } = {}
): Promise<OcrResult> {
  if (signal?.aborted) throw abortError();
  if (backend) return backend.recognize(source, signal, opts);
  const maxSide = Math.max(source.width, source.height);
  // 小图放大 2 倍，图例小字更容易识别；过大的图不再放大
  const scale = opts.scale ?? (maxSide < 1600 ? 2 : 1);
  const { canvas } = toCanvas(source, scale);
  const worker = await getWorker();
  if (signal?.aborted) throw abortError();
  // 每次调用设置版面模式（色块叠放图用 6 整块文字，其余用 11 稀疏文字）；dpi 固定，避免反复估计分辨率
  try { await worker.setParameters({ tessedit_pageseg_mode: opts.psm ?? "11", user_defined_dpi: "300", tessedit_char_whitelist: opts.whitelist ?? "" }); } catch { /* 忽略 */ }
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => { void terminateOcr(); reject(abortError()); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const result = await Promise.race([worker.recognize(canvas, {}, { blocks: true, text: true }), aborted]);
    const data = (result as any)?.data ?? result;
    return { text: String(data?.text ?? ""), words: flatten(data, scale) };
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}
