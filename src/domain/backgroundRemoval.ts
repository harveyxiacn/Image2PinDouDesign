import { blobToPixelSource, pixelSourceToBlob } from "./image";
import type { PixelSource } from "./types";

export type RemovalProgress = { stage: string; ratio: number };

// AI 去背景：动态 import @imgly/background-removal，让模型与运行时成为独立懒加载 chunk，
// 不进首屏；模型资源由 imgly CDN 提供（源站零负担）。输出带 alpha 的 PixelSource，
// 交给"透明=空格"管线，再自动裁到主体即可让主体填满板面。
// 选用 isnet_fp16：质量与首次下载体积的折中。
export async function removeBackgroundFromSource(
  source: PixelSource,
  onProgress?: (progress: RemovalProgress) => void
): Promise<PixelSource> {
  const { removeBackground } = await import("@imgly/background-removal");
  const input = await pixelSourceToBlob(source);
  const output = await removeBackground(input, {
    model: "isnet_fp16",
    output: { format: "image/png" },
    progress: (stage, current, total) => {
      onProgress?.({ stage, ratio: total > 0 ? current / total : 0 });
    }
  });
  return blobToPixelSource(output);
}
