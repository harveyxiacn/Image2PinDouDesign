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
export function autoCropToContent(source: PixelSource, alphaThreshold = 16, paddingRatio = 0.04): PixelSource {
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

type AutoFrameOptions = {
  alphaThreshold?: number;
  ignoreWhiteBg?: boolean;
  paddingRatio?: number;
};

// 转换前智能紧贴主体。透明底按 alpha 找边界；当四周主要是白色时，
// 再把与画面留白同类的近白像素排除。它只改变取景，不修改主体像素。
export function autoFramePixelSource(source: PixelSource, options: AutoFrameOptions = {}): PixelSource {
  const alphaThreshold = options.alphaThreshold ?? 16;
  // 约留一个原始逻辑像素的安全边。以亚古兽 9px 像素块为例，4% 会把
  // 190×264 的紧边界扩到约 206×280，恰好恢复为 23×31 的成品网格。
  const paddingRatio = options.paddingRatio ?? 0.04;
  const trimWhite = Boolean(options.ignoreWhiteBg && hasMostlyWhiteOpaqueBorder(source));
  const bounds = findBounds(source, (index) => {
    const alpha = source.data[index + 3];
    if (alpha <= alphaThreshold) {
      return false;
    }
    if (!trimWhite) {
      return true;
    }
    return source.data[index] < 238 || source.data[index + 1] < 238 || source.data[index + 2] < 238;
  });

  if (!bounds) {
    return source;
  }

  const pad = Math.max(1, Math.round(Math.min(bounds.width, bounds.height) * paddingRatio));
  const padded = clampRect(source, {
    x: bounds.x - pad,
    y: bounds.y - pad,
    width: bounds.width + pad * 2,
    height: bounds.height + pad * 2
  });
  if (padded.x === 0 && padded.y === 0 && padded.width === source.width && padded.height === source.height) {
    return source;
  }
  return cropPixelSource(source, padded);
}

function findBounds(source: PixelSource, isContent: (index: number) => boolean): PixelRect | null {
  let minX = source.width;
  let minY = source.height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      if (!isContent((y * source.width + x) * 4)) {
        continue;
      }
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  return maxX < 0
    ? null
    : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function hasMostlyWhiteOpaqueBorder(source: PixelSource): boolean {
  const perimeter = Math.max(1, source.width * 2 + source.height * 2 - 4);
  const step = Math.max(1, Math.floor(perimeter / 2_048));
  let sampled = 0;
  let white = 0;

  const inspect = (x: number, y: number) => {
    const index = (y * source.width + x) * 4;
    sampled += 1;
    if (
      source.data[index + 3] >= 224 &&
      source.data[index] >= 238 &&
      source.data[index + 1] >= 238 &&
      source.data[index + 2] >= 238
    ) {
      white += 1;
    }
  };

  for (let x = 0; x < source.width; x += step) {
    inspect(x, 0);
    if (source.height > 1) inspect(x, source.height - 1);
  }
  for (let y = step; y < source.height - 1; y += step) {
    inspect(0, y);
    if (source.width > 1) inspect(source.width - 1, y);
  }

  return sampled > 0 && white / sampled >= 0.58;
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
