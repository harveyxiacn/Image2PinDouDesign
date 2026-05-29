import { clamp } from "./color";
import type { ImageAdjustments, SampledGrid } from "./types";

export function hasAdjustments(adjustments?: ImageAdjustments): adjustments is ImageAdjustments {
  return Boolean(
    adjustments &&
    (adjustments.brightness !== 0 || adjustments.contrast !== 0 || adjustments.saturation !== 0)
  );
}

// 亮度/对比度/饱和度三者都是按通道仿射的点运算，与 box-filter 缩放可交换，
// 因此在重采样后的网格上调整与在原图上调整结果等价，但成本低得多（像素更少）。
// 调整顺序：亮度 → 对比度 → 饱和度，最后裁剪到 [0, 255]。
export function applyAdjustmentsToGrid(grid: SampledGrid, adjustments: ImageAdjustments): SampledGrid {
  if (!hasAdjustments(adjustments)) {
    return grid;
  }

  const brightnessOffset = (adjustments.brightness / 100) * 255;
  const contrastFactor = (100 + adjustments.contrast) / 100;
  const saturationFactor = (100 + adjustments.saturation) / 100;

  const cells = grid.cells.map((cell) => {
    if (!cell) {
      return cell;
    }

    let r = cell.r + brightnessOffset;
    let g = cell.g + brightnessOffset;
    let b = cell.b + brightnessOffset;

    r = (r - 128) * contrastFactor + 128;
    g = (g - 128) * contrastFactor + 128;
    b = (b - 128) * contrastFactor + 128;

    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    r = luma + (r - luma) * saturationFactor;
    g = luma + (g - luma) * saturationFactor;
    b = luma + (b - luma) * saturationFactor;

    return {
      r: clamp(r, 0, 255),
      g: clamp(g, 0, 255),
      b: clamp(b, 0, 255),
      a: cell.a
    };
  });

  return { width: grid.width, height: grid.height, cells };
}
