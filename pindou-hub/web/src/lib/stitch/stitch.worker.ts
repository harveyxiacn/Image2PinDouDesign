/// <reference lib="webworker" />
import { stitchScreens } from "./index";
import type { StitchRequest, StitchResponse } from "./client";

self.addEventListener("message", (event: MessageEvent<StitchRequest>) => {
  const { id, images } = event.data;
  const post = (m: StitchResponse, transfer?: Transferable[]) => (self as unknown as Worker).postMessage(m, transfer ?? []);
  try {
    const result = stitchScreens(images, { onProgress: (percent, label) => post({ id, type: "progress", percent, label }) });
    post({ id, type: "done", result }, [result.image.data.buffer]);
  } catch (caught) {
    post({ id, type: "error", error: caught instanceof Error ? caught.message : "拼接失败" });
  }
});
