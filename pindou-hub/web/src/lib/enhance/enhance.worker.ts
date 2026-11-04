/// <reference lib="webworker" />
import { enhanceImage, type EnhanceRequest, type EnhanceResponse } from "./index";

function post(message: EnhanceResponse, transfer: Transferable[] = []) {
  (self as unknown as Worker).postMessage(message, transfer);
}

self.addEventListener("message", async (event: MessageEvent<EnhanceRequest>) => {
  const { id, width, height, buffer, opts } = event.data;
  try {
    const src = { width, height, data: new Uint8ClampedArray(buffer) };
    const r = await enhanceImage(src, { ...opts, onProgress: (fraction) => post({ id, type: "progress", fraction }) });
    const same = r.image === src;
    const out = same ? null : (r.image.data.buffer as ArrayBuffer);
    post({ id, type: "done", result: { scale: r.scale, method: r.method, quality: r.quality, ms: r.ms, detail: r.detail, width: r.image.width, height: r.image.height, buffer: out } }, out ? [out] : []);
  } catch (caught) {
    post({ id, type: "error", error: caught instanceof Error ? caught.message : "高清化失败" });
  }
});
