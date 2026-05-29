import type { PixelSource } from "./types";

export type PixelRect = { x: number; y: number; width: number; height: number };

// 把归一化矩形（各分量 0..1，相对原图）换算成像素矩形并夹取到边界内。
export function rectFromFractions(
  source: Pick<PixelSource, "width" | "height">,
  fx: number,
  fy: number,
  fw: number,
  fh: number
): PixelRect {
  const x = Math.round(clamp01(fx) * source.width);
  const y = Math.round(clamp01(fy) * source.height);
  const width = Math.round(clamp01(fw) * source.width);
  const height = Math.round(clamp01(fh) * source.height);
  return clampRect(source, { x, y, width, height });
}

export function cropPixelSource(source: PixelSource, rect: PixelRect): PixelSource {
  const { x, y, width, height } = clampRect(source, rect);
  if (width <= 0 || height <= 0) {
    throw new Error("Crop rectangle is empty");
  }

  const data = new Uint8ClampedArray(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    const srcStart = ((y + row) * source.width + x) * 4;
    const dstStart = row * width * 4;
    data.set(source.data.subarray(srcStart, srcStart + width * 4), dstStart);
  }

  return { width, height, data };
}

// 找出 alpha 高于阈值的像素的最小包围盒；全透明返回 null。
export function findOpaqueBounds(source: PixelSource, alphaThreshold = 16): PixelRect | null {
  let minX = source.width;
  let minY = source.height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const alpha = source.data[(y * source.width + x) * 4 + 3];
      if (alpha > alphaThreshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < 0) {
    return null;
  }
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

// 抠图后把画面裁到主体（不透明区域）的包围盒，让主体填满后续板面。
// padding 以"占较短边的比例"留一点边距，避免贴边太死。
export function autoCropToContent(source: PixelSource, alphaThreshold = 16, paddingRatio = 0.02): PixelSource {
  const bounds = findOpaqueBounds(source, alphaThreshold);
  if (!bounds) {
    return source;
  }
  const pad = Math.round(Math.min(bounds.width, bounds.height) * paddingRatio);
  const padded: PixelRect = {
    x: bounds.x - pad,
    y: bounds.y - pad,
    width: bounds.width + pad * 2,
    height: bounds.height + pad * 2
  };
  return cropPixelSource(source, clampRect(source, padded));
}

function clampRect(source: Pick<PixelSource, "width" | "height">, rect: PixelRect): PixelRect {
  const x = Math.max(0, Math.min(source.width, rect.x));
  const y = Math.max(0, Math.min(source.height, rect.y));
  const width = Math.max(0, Math.min(source.width - x, rect.width));
  const height = Math.max(0, Math.min(source.height - y, rect.height));
  return { x, y, width, height };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
