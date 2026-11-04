/// <reference lib="webworker" />
import { runConversion, type GenerateRequest, type GenerateResponse } from "./generate";


function post(message: GenerateResponse) {
  (self as unknown as Worker).postMessage(message);
}

self.addEventListener("message", (event: MessageEvent<GenerateRequest>) => {
  const { id, source, fileName, settings } = event.data;
  try {
    post({ id, type: "progress", percent: 5 });
    const design = runConversion(source, fileName, settings);
    post({ id, type: "done", design });
  } catch (caught) {
    post({ id, type: "error", error: caught instanceof Error ? caught.message : "转换失败" });
  }
});
