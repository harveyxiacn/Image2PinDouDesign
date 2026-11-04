// 在 Web Worker 里拼接（和 lib/generate.ts 同一套路）：cancel() 直接终止 Worker。
import type { PixelSource } from "@engine/types";
import type { StitchResult } from "./index";

export type StitchRequest = { id: number; images: PixelSource[] };
export type StitchResponse =
  | { id: number; type: "progress"; percent: number; label: string }
  | { id: number; type: "done"; result: StitchResult }
  | { id: number; type: "error"; error: string };

export type StitchJob = { promise: Promise<StitchResult>; cancel: () => void };

let seq = 0;
export function startStitch(images: PixelSource[], onProgress?: (percent: number, label: string) => void): StitchJob {
  const worker = new Worker(new URL("./stitch.worker.ts", import.meta.url), { type: "module" });
  const id = ++seq;
  let reject!: (e: Error) => void;
  const promise = new Promise<StitchResult>((res, rej) => {
    reject = rej;
    worker.onmessage = (event: MessageEvent<StitchResponse>) => {
      const msg = event.data;
      if (msg.id !== id) return;
      if (msg.type === "progress") onProgress?.(msg.percent, msg.label);
      else if (msg.type === "done") { worker.terminate(); res(msg.result); }
      else { worker.terminate(); rej(new Error(msg.error)); }
    };
    worker.onerror = (event) => { worker.terminate(); rej(new Error(event.message || "拼接失败")); };
  });
  worker.postMessage({ id, images } satisfies StitchRequest);
  return { promise, cancel: () => { worker.terminate(); reject(new DOMException("已取消", "AbortError")); } };
}

/** 把拼好的像素编码成 PNG（无损，识别要用）。 */
export async function pixelsToPng(image: PixelSource): Promise<Blob> {
  const c = document.createElement("canvas");
  c.width = image.width; c.height = image.height;
  c.getContext("2d")!.putImageData(new ImageData(image.data as unknown as ImageData["data"], image.width, image.height), 0, 0);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("图片编码失败"))), "image/png"));
}
