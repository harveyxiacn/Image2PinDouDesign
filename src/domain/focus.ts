import type { FitMode, PixelSource } from "./types";

export type FocusPoint = { x: number; y: number };
export type FocusCropMode = Extract<FitMode, "cover" | "contain">;
export type FocusCropRect = { x: number; y: number; width: number; height: number };

const GOLDEN_NEAR = 0.382;
const GOLDEN_FAR = 0.618;
const SALIENCY_MAX_DIMENSION = 64;

// cover 只保留与目标板面同宽高比的窗口；contain 保留整图。
// 偏侧主体落在靠近黄金分割线的位置，为主体朝向保留更多画面空间。
export function computeCropRect(
  source: Pick<PixelSource, "width" | "height">,
  focus: FocusPoint,
  mode: FocusCropMode,
  targetAspect: number
): FocusCropRect {
  const width = Math.max(1, Math.round(source.width));
  const height = Math.max(1, Math.round(source.height));
  const full = { x: 0, y: 0, width, height };
  if (mode === "contain" || !Number.isFinite(targetAspect) || targetAspect <= 0) {
    return full;
  }

  const sourceAspect = width / height;
  let cropWidth = width;
  let cropHeight = height;
  if (sourceAspect > targetAspect) {
    cropWidth = clamp(Math.round(height * targetAspect), 1, width);
  } else if (sourceAspect < targetAspect) {
    cropHeight = clamp(Math.round(width / targetAspect), 1, height);
  }

  const focusX = clamp(finiteOr(focus.x, (width - 1) / 2), 0, width - 1);
  const focusY = clamp(finiteOr(focus.y, (height - 1) / 2), 0, height - 1);
  const x = clamp(
    Math.round(focusX - cropWidth * anchorFor(focusX, width)),
    0,
    width - cropWidth
  );
  const y = clamp(
    Math.round(focusY - cropHeight * anchorFor(focusY, height)),
    0,
    height - cropHeight
  );
  return { x, y, width: cropWidth, height: cropHeight };
}

// 对降采样网格计算边缘、饱和度和 alpha 边界的加权质心。
// 没有显著差异时权重自然均匀或归零，稳定回退到几何中心。
export function estimateFocus(source: PixelSource): FocusPoint {
  if (source.width <= 0 || source.height <= 0 || source.data.length < source.width * source.height * 4) {
    return { x: 0, y: 0 };
  }

  const stride = Math.max(1, Math.ceil(Math.max(source.width, source.height) / SALIENCY_MAX_DIMENSION));
  let weightedX = 0;
  let weightedY = 0;
  let totalWeight = 0;

  for (let y = 0; y < source.height; y += stride) {
    for (let x = 0; x < source.width; x += stride) {
      const index = (y * source.width + x) * 4;
      const alpha = source.data[index + 3] / 255;
      if (alpha < 0.08) continue;

      const r = source.data[index];
      const g = source.data[index + 1];
      const b = source.data[index + 2];
      const saturation = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
      const luminance = relativeLuminance(r, g, b);
      let edge = 0;
      let alphaBoundary = 0;

      const compare = (nx: number, ny: number) => {
        const next = (ny * source.width + nx) * 4;
        edge = Math.max(edge, Math.abs(luminance - relativeLuminance(
          source.data[next], source.data[next + 1], source.data[next + 2]
        )) / 255);
        alphaBoundary = Math.max(alphaBoundary, Math.abs(source.data[index + 3] - source.data[next + 3]) / 255);
      };
      if (x + stride < source.width) compare(x + stride, y);
      if (y + stride < source.height) compare(x, y + stride);

      const normalizedX = source.width > 1 ? x / (source.width - 1) : 0.5;
      const normalizedY = source.height > 1 ? y / (source.height - 1) : 0.5;
      const centerDistance = Math.min(1, Math.hypot(normalizedX - 0.5, normalizedY - 0.5) / Math.SQRT1_2);
      const centerPrior = 0.72 + (1 - centerDistance) * 0.28;
      const weight = alpha * centerPrior * (edge * 0.68 + saturation * 0.24 + alphaBoundary * 0.8);
      weightedX += x * weight;
      weightedY += y * weight;
      totalWeight += weight;
    }
  }

  if (totalWeight <= 1e-6) {
    return { x: (source.width - 1) / 2, y: (source.height - 1) / 2 };
  }
  return {
    x: clamp(weightedX / totalWeight, 0, source.width - 1),
    y: clamp(weightedY / totalWeight, 0, source.height - 1)
  };
}

function anchorFor(value: number, extent: number): number {
  if (extent <= 1) return 0.5;
  const normalized = value / (extent - 1);
  if (normalized < 0.45) return GOLDEN_NEAR;
  if (normalized > 0.55) return GOLDEN_FAR;
  return 0.5;
}

function relativeLuminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
