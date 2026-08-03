import { applyAdjustmentsToGrid } from "./adjustments";
import { dropBorderWhite } from "./background";
import { clamp, findNearestCodeByLab, findNearestPaletteColor, rgbToLab } from "./color";
import { autoFramePixelSource } from "./crop";
import { computeCropRect, estimateFocus } from "./focus";
import { preparePalette } from "./palette";
import { medianSmoothGrid } from "./simplify";
import type {
  BeadDesign,
  BeadMatrix,
  ConversionSettings,
  FitMode,
  PaletteColor,
  PaletteSeed,
  PixelSource,
  Rgb,
  Rgba,
  SampledCell,
  SampledGrid
} from "./types";

export { preparePalette };

// 抖动模式是新增的扩展设置，类型上尚未写入 ConversionSettings（types.ts 不在本次改动范围）。
// 用交叉类型 + 可选字段保持向后兼容：未提供时默认仍走 Floyd-Steinberg。
export type ConversionSettingsWithDither = ConversionSettings & {
  ditherMode?: "floyd-steinberg" | "bayer";
};


// 最终落色函数已统一放到 color.ts（findNearestPaletteColor / findNearestCodeByLab），
// 这里仅转发导出，保证既有调用方从 ../domain/conversion 导入仍然可用。
export { findNearestPaletteColor };

export function convertPixelSourceToDesign(
  source: PixelSource,
  fileName: string,
  settings: ConversionSettings,
  palette: PaletteColor[]
): BeadDesign {
  const framedSource = settings.autoFrame === false
    ? source
    : autoFramePixelSource(source, { ignoreWhiteBg: settings.ignoreWhiteBg });
  const outputSize = resolveSmartGridSize(framedSource, settings);
  const effectiveSettings: ConversionSettings = {
    ...settings,
    boardWidth: outputSize.width,
    boardHeight: outputSize.height
  };
  const sampled = resampleToGrid(framedSource, effectiveSettings);
  // 半透明边缘像素先做去污染：把与背景混合的 RGB 反推回纯前景色，再做后续匹配，
  // 避免白底/花底图片的边缘格带着背景色参与选色，出现"脏边"。
  const decontaminated = decontaminateGridEdges(sampled);
  const cleaned = effectiveSettings.ignoreWhiteBg ? dropBorderWhite(decontaminated) : decontaminated;
  const adjusted = effectiveSettings.adjustments
    ? applyAdjustmentsToGrid(cleaned, effectiveSettings.adjustments)
    : cleaned;
  // 中值滤波传全色板：先量化到色板再取中值，中间色永远来自色板，不会合成新颜色。
  const grid = effectiveSettings.smooth
    ? medianSmoothGrid(adjusted, effectiveSettings.smooth, palette)
    : adjusted;
  const activePalette = selectActivePalette(grid, effectiveSettings, palette);
  // 抖动模式：默认 Floyd-Steinberg；ditherMode: "bayer" 可切换为有序抖动（Bayer 4x4）。
  const ditherMode = (effectiveSettings as ConversionSettingsWithDither).ditherMode ?? "floyd-steinberg";
  const quantized = effectiveSettings.dither
    ? (ditherMode === "bayer"
      ? quantizeWithBayer(grid, activePalette, effectiveSettings)
      : quantizeWithFloydSteinberg(grid, activePalette, effectiveSettings))
    : quantize(grid, activePalette, effectiveSettings);
  const matrix = effectiveSettings.outline ? outlineMatrix(quantized, OUTLINE_CODE) : quantized;

  return {
    id: createDesignId(fileName),
    fileName,
    boardWidth: effectiveSettings.boardWidth,
    boardHeight: effectiveSettings.boardHeight,
    matrix,
    colorCounts: countMatrixColors(matrix),
    settings: effectiveSettings
  };
}

export const OUTLINE_CODE = "H7"; // 黑色

// 给主体描边：优先把主体外侧空格扩成 H7，保留原本边缘的颜色和细肢；
// 如果主体已经贴到画布边缘、无法向外扩，才把画布边缘格改为 H7。
// 已经存在的 H7 外圈不会再膨胀一层。
export function outlineMatrix(matrix: BeadMatrix, code: string): BeadMatrix {
  const height = matrix.length;
  const width = height > 0 ? matrix[0].length : 0;
  const at = (x: number, y: number) =>
    x < 0 || y < 0 || x >= width || y >= height ? null : matrix[y][x];

  return matrix.map((row, y) =>
    row.map((cell, x) => {
      if (cell) {
        const touchesCanvasEdge = x === 0 || y === 0 || x === width - 1 || y === height - 1;
        return touchesCanvasEdge && cell !== code ? code : cell;
      }
      const neighbors = [at(x - 1, y), at(x + 1, y), at(x, y - 1), at(x, y + 1)];
      return neighbors.some((neighbor) => Boolean(neighbor && neighbor !== code)) ? code : null;
    })
  );
}

export function countMatrixColors(matrix: BeadMatrix): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const row of matrix) {
    for (const code of row) {
      if (!code) {
        continue;
      }
      counts[code] = (counts[code] ?? 0) + 1;
    }
  }

  return counts;
}

export function summarizeProject(designs: Array<Pick<BeadDesign, "colorCounts">>): Record<string, number> {
  const totals: Record<string, number> = {};

  for (const design of designs) {
    for (const [code, count] of Object.entries(design.colorCounts)) {
      totals[code] = (totals[code] ?? 0) + count;
    }
  }

  return totals;
}

// 半透明边缘去污染：对 0 < alpha < 255 的格子，用 c' = (c - bg*(1-a))/a 反推纯前景色，
// 避免白底/透明抠图的边缘格带着背景混合色参与选色，出现"脏边"。
// bg 的估计：取 8 邻域不透明邻居色；多个候选时选择"能让反推前景更纯（饱和度更高）"
// 的一侧作为背景（纯灰边界则取较亮一侧，符合白底/透明边缘的常见情形），
// 只有一个邻居色时补上白色假设；反推结果非法（NaN）时退回邻近不透明像素色。
// 完全透明/完全不透明格子保持原样；可传入已知背景色跳过估计。
export function decontaminateGridEdges(grid: SampledGrid, knownBackground?: Rgb): SampledGrid {
  const { width, height, cells } = grid;
  if (width === 0 || height === 0) {
    return grid;
  }

  const out: SampledCell[] = cells.slice();
  const at = (x: number, y: number): SampledCell =>
    x < 0 || y < 0 || x >= width || y >= height ? null : cells[y * width + x];

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const cell = out[index];
      if (!cell || cell.a <= 0 || cell.a >= 255) {
        continue;
      }

      const neighbors: Rgb[] = [];
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) {
            continue;
          }
          const neighbor = at(x + dx, y + dy);
          if (neighbor && neighbor.a >= 224) {
            neighbors.push({ r: neighbor.r, g: neighbor.g, b: neighbor.b });
          }
        }
      }
      if (neighbors.length === 0) {
        continue; // 孤立半透明碎片，无邻近色可参考，保持原样
      }

      const alpha = cell.a / 255;
      let background: Rgb;
      if (knownBackground) {
        background = knownBackground;
      } else {
        // 去掉近似重复的邻居色（容差 6/通道），避免同一侧颜色互相竞争
        const candidates: Rgb[] = [];
        for (const neighbor of neighbors) {
          const duplicate = candidates.some((candidate) =>
            Math.abs(candidate.r - neighbor.r) <= 6 &&
            Math.abs(candidate.g - neighbor.g) <= 6 &&
            Math.abs(candidate.b - neighbor.b) <= 6);
          if (!duplicate) {
            candidates.push(neighbor);
          }
        }
        if (candidates.length === 1) {
          // 单一邻居色无法区分前景/背景，补上最常见的白底假设再比选
          candidates.push({ r: 255, g: 255, b: 255 });
        }
        // 选择能让反推前景更纯的背景色；饱和度相同取较亮一侧（更符合白底抠图）
        let best = candidates[0];
        let bestScore = -1;
        for (const candidate of candidates) {
          const fg = unmixRgb(cell, candidate, alpha);
          const chroma = Math.max(fg.r, fg.g, fg.b) - Math.min(fg.r, fg.g, fg.b);
          const score = chroma + (candidate.r + candidate.g + candidate.b) / 765_000;
          if (score > bestScore) {
            bestScore = score;
            best = candidate;
          }
        }
        background = best;
      }

      const fg = unmixRgb(cell, background, alpha);
      if (!Number.isFinite(fg.r) || !Number.isFinite(fg.g) || !Number.isFinite(fg.b)) {
        // 反推失败（如 alpha 为 0），退回邻近不透明像素色，保守不引入噪声
        out[index] = { r: neighbors[0].r, g: neighbors[0].g, b: neighbors[0].b, a: cell.a };
        continue;
      }
      out[index] = {
        r: clamp(fg.r, 0, 255),
        g: clamp(fg.g, 0, 255),
        b: clamp(fg.b, 0, 255),
        a: cell.a
      };
    }
  }

  return out.some((cell, index) => cell !== cells[index]) ? { width, height, cells: out } : grid;
}

// c' = (c - bg*(1-a))/a：反推纯前景色（未 clamp，供上层统一处理）
function unmixRgb(cell: Rgba, background: Rgb, alpha: number): Rgb {
  const keep = 1 - alpha;
  return {
    r: (cell.r - background.r * keep) / alpha,
    g: (cell.g - background.g * keep) / alpha,
    b: (cell.b - background.b * keep) / alpha
  };
}
export function resampleToGrid(source: PixelSource, settings: ConversionSettings): SampledGrid {
  const fit: FitMode = settings.fit ?? "contain";
  const tw = settings.boardWidth;
  const th = settings.boardHeight;
  const sw = source.width;
  const sh = source.height;
  const sampling = settings.sampling ?? "area";
  const useNearest = sampling === "nearest" || (sampling === "auto" && isLikelyPixelArt(source));

  let scaleX: number;
  let scaleY: number;
  let offsetX: number;
  let offsetY: number;
  let scaledW: number;
  let scaledH: number;
  let sourceOffsetX = 0;
  let sourceOffsetY = 0;

  if (fit === "stretch") {
    scaleX = sw / tw;
    scaleY = sh / th;
    offsetX = 0;
    offsetY = 0;
    scaledW = tw;
    scaledH = th;
  } else if (fit === "cover") {
    const crop = computeCropRect(source, estimateFocus(source), "cover", tw / th);
    scaleX = crop.width / tw;
    scaleY = crop.height / th;
    offsetX = 0;
    offsetY = 0;
    scaledW = tw;
    scaledH = th;
    sourceOffsetX = crop.x;
    sourceOffsetY = crop.y;
  } else {
    const factor = Math.min(tw / sw, th / sh);
    scaleX = 1 / factor;
    scaleY = 1 / factor;
    scaledW = sw * factor;
    scaledH = sh * factor;
    offsetX = (tw - scaledW) / 2;
    offsetY = (th - scaledH) / 2;
  }

  const cells: SampledCell[] = new Array(tw * th);
  for (let ty = 0; ty < th; ty += 1) {
    for (let tx = 0; tx < tw; tx += 1) {
      const dx = tx - offsetX;
      const dy = ty - offsetY;
      if (dx < 0 || dx >= scaledW || dy < 0 || dy >= scaledH) {
        cells[ty * tw + tx] = null;
        continue;
      }
      const srcLeft = sourceOffsetX + dx * scaleX;
      const srcTop = sourceOffsetY + dy * scaleY;
      const srcRight = sourceOffsetX + (dx + 1) * scaleX;
      const srcBottom = sourceOffsetY + (dy + 1) * scaleY;
      cells[ty * tw + tx] = useNearest
        ? sampleNearest(source, (srcLeft + srcRight) / 2, (srcTop + srcBottom) / 2)
        : sampleArea(source, srcLeft, srcTop, srcRight, srcBottom);
    }
  }

  return { width: tw, height: th, cells };
}

function sampleNearest(source: PixelSource, x: number, y: number): SampledCell {
  const px = Math.max(0, Math.min(source.width - 1, Math.floor(x)));
  const py = Math.max(0, Math.min(source.height - 1, Math.floor(y)));
  const index = (py * source.width + px) * 4;
  return {
    r: source.data[index],
    g: source.data[index + 1],
    b: source.data[index + 2],
    a: source.data[index + 3]
  };
}

const pixelArtLikelihoodCache = new WeakMap<PixelSource, boolean>();
const pixelArtScaleCache = new WeakMap<PixelSource, number | null>();

// 像素画通常同时具备：大面积相邻像素完全/近似相同、颜色种类较少、
// 色块边界是跳变而非渐变。大图还必须能检测到稳定网格周期，避免把带大块
// 纯色背景的普通插画误判成像素画；JPEG 压缩产生的少量软边不会阻断识别。
export function isLikelyPixelArt(source: PixelSource): boolean {
  const cached = pixelArtLikelihoodCache.get(source);
  if (cached !== undefined) {
    return cached;
  }
  if (source.width < 2 || source.height < 2) {
    pixelArtLikelihoodCache.set(source, true);
    return true;
  }

  const targetSamples = 24_000;
  const stride = Math.max(1, Math.floor(Math.sqrt((source.width * source.height) / targetSamples)));
  const coarseColors = new Set<number>();
  let evaluated = 0;
  let flat = 0;
  let soft = 0;
  let hard = 0;

  const inspectPair = (leftIndex: number, rightIndex: number) => {
    if (source.data[leftIndex + 3] < 32 || source.data[rightIndex + 3] < 32) {
      return;
    }
    const distance = Math.max(
      Math.abs(source.data[leftIndex] - source.data[rightIndex]),
      Math.abs(source.data[leftIndex + 1] - source.data[rightIndex + 1]),
      Math.abs(source.data[leftIndex + 2] - source.data[rightIndex + 2])
    );
    evaluated += 1;
    if (distance <= 10) {
      flat += 1;
    } else if (distance >= 42) {
      hard += 1;
    } else {
      soft += 1;
    }
  };

  for (let y = 0; y < source.height; y += stride) {
    for (let x = 0; x < source.width; x += stride) {
      const index = (y * source.width + x) * 4;
      if (source.data[index + 3] >= 32) {
        coarseColors.add(
          (source.data[index] >> 5) << 6 |
          (source.data[index + 1] >> 5) << 3 |
          (source.data[index + 2] >> 5)
        );
      }
      if (x + 1 < source.width) inspectPair(index, index + 4);
      if (y + 1 < source.height) inspectPair(index, index + source.width * 4);
    }
  }

  if (evaluated < 24) {
    const result = coarseColors.size <= 32;
    pixelArtLikelihoodCache.set(source, result);
    return result;
  }
  const flatRatio = flat / evaluated;
  const hardRatio = hard / evaluated;
  const blockLike = coarseColors.size <= 128 && flatRatio >= 0.48 && hardRatio >= 0.015 && hard > soft * 0.45;
  const needsPeriodicProof = source.width > 64 || source.height > 64;
  const result = blockLike && (!needsPeriodicProof || estimatePixelArtScale(source) !== null);
  pixelArtLikelihoodCache.set(source, result);
  return result;
}

export function estimatePixelArtScale(source: PixelSource): number | null {
  if (pixelArtScaleCache.has(source)) {
    return pixelArtScaleCache.get(source) ?? null;
  }
  const maxPeriod = Math.min(32, Math.floor(Math.min(source.width, source.height) / 8));
  if (maxPeriod < 2) {
    pixelArtScaleCache.set(source, null);
    return null;
  }

  const vertical = new Float64Array(source.width);
  const horizontal = new Float64Array(source.height);
  const rowStride = Math.max(1, Math.floor(source.height / 256));
  const columnStride = Math.max(1, Math.floor(source.width / 256));

  const edgeWeight = (leftIndex: number, rightIndex: number) => {
    const leftOpaque = source.data[leftIndex + 3] >= 32;
    const rightOpaque = source.data[rightIndex + 3] >= 32;
    if (leftOpaque !== rightOpaque) {
      return 255;
    }
    if (!leftOpaque) {
      return 0;
    }
    const distance = Math.max(
      Math.abs(source.data[leftIndex] - source.data[rightIndex]),
      Math.abs(source.data[leftIndex + 1] - source.data[rightIndex + 1]),
      Math.abs(source.data[leftIndex + 2] - source.data[rightIndex + 2])
    );
    return distance >= 30 ? distance : 0;
  };

  for (let y = 0; y < source.height; y += rowStride) {
    for (let x = 1; x < source.width; x += 1) {
      const right = (y * source.width + x) * 4;
      vertical[x] += edgeWeight(right - 4, right);
    }
  }
  for (let x = 0; x < source.width; x += columnStride) {
    for (let y = 1; y < source.height; y += 1) {
      const bottom = (y * source.width + x) * 4;
      horizontal[y] += edgeWeight(bottom - source.width * 4, bottom);
    }
  }

  const activeVerticalEdges = Array.from(vertical).filter((score) => score > 0).length;
  const activeHorizontalEdges = Array.from(horizontal).filter((score) => score > 0).length;
  if (activeVerticalEdges < 4 || activeHorizontalEdges < 4) {
    pixelArtScaleCache.set(source, null);
    return null;
  }

  const alignment = (scores: Float64Array, period: number) => {
    const buckets = new Float64Array(period);
    let total = 0;
    for (let position = 1; position < scores.length; position += 1) {
      const score = scores[position];
      buckets[position % period] += score;
      total += score;
    }
    if (total <= 0) {
      return 0;
    }
    let strongest = 0;
    for (const score of buckets) {
      if (score > strongest) strongest = score;
    }
    return strongest / total;
  };

  const candidates: Array<{ period: number; raw: number; gain: number }> = [];
  let bestGain = 0;
  for (let period = 2; period <= maxPeriod; period += 1) {
    const xAlignment = alignment(vertical, period);
    const yAlignment = alignment(horizontal, period);
    const raw = Math.sqrt(xAlignment * yAlignment);
    const gain = raw - 1 / period;
    if (gain > bestGain) bestGain = gain;
    candidates.push({ period, raw, gain });
  }

  const credible = candidates.filter(({ raw, gain }) =>
    raw >= 0.34 && gain >= Math.max(0.12, bestGain * 0.65));
  const result = credible.length > 0 ? credible[credible.length - 1].period : null;
  pixelArtScaleCache.set(source, result);
  return result;
}

export function resolveSmartGridSize(
  source: PixelSource,
  settings: Pick<ConversionSettings, "boardWidth" | "boardHeight" | "smartSize">
): { width: number; height: number } {
  const maximum = { width: settings.boardWidth, height: settings.boardHeight };
  if (!settings.smartSize || !isLikelyPixelArt(source)) {
    return maximum;
  }

  const scale = estimatePixelArtScale(source);
  let logicalWidth: number;
  let logicalHeight: number;
  if (scale) {
    logicalWidth = Math.max(1, Math.round(source.width / scale));
    logicalHeight = Math.max(1, Math.round(source.height / scale));
  } else if (source.width <= maximum.width && source.height <= maximum.height) {
    logicalWidth = source.width;
    logicalHeight = source.height;
  } else {
    return maximum;
  }

  const shrink = Math.min(1, maximum.width / logicalWidth, maximum.height / logicalHeight);
  // 最小为 1：小于 8x8 的像素画按原始逻辑尺寸输出，不再被强制放大破坏点阵比例
  return {
    width: Math.max(1, Math.min(maximum.width, Math.round(logicalWidth * shrink))),
    height: Math.max(1, Math.min(maximum.height, Math.round(logicalHeight * shrink)))
  };
}

function sampleArea(source: PixelSource, left: number, top: number, right: number, bottom: number): SampledCell {
  const clampedLeft = Math.max(0, Math.min(source.width, left));
  const clampedRight = Math.max(0, Math.min(source.width, right));
  const clampedTop = Math.max(0, Math.min(source.height, top));
  const clampedBottom = Math.max(0, Math.min(source.height, bottom));

  if (clampedRight <= clampedLeft || clampedBottom <= clampedTop) {
    return null;
  }

  const xMin = Math.floor(clampedLeft);
  const xMax = Math.ceil(clampedRight);
  const yMin = Math.floor(clampedTop);
  const yMax = Math.ceil(clampedBottom);

  let weightedR = 0;
  let weightedG = 0;
  let weightedB = 0;
  let alphaSum = 0;
  let areaSum = 0;
  let alphaWeightSum = 0;

  for (let py = yMin; py < yMax; py += 1) {
    if (py < 0 || py >= source.height) {
      continue;
    }
    const yOverlap = Math.min(py + 1, clampedBottom) - Math.max(py, clampedTop);
    if (yOverlap <= 0) {
      continue;
    }
    for (let px = xMin; px < xMax; px += 1) {
      if (px < 0 || px >= source.width) {
        continue;
      }
      const xOverlap = Math.min(px + 1, clampedRight) - Math.max(px, clampedLeft);
      if (xOverlap <= 0) {
        continue;
      }
      const area = xOverlap * yOverlap;
      const index = (py * source.width + px) * 4;
      const r = source.data[index];
      const g = source.data[index + 1];
      const b = source.data[index + 2];
      const a = source.data[index + 3];

      const alphaWeight = (a / 255) * area;
      weightedR += r * alphaWeight;
      weightedG += g * alphaWeight;
      weightedB += b * alphaWeight;
      alphaSum += a * area;
      areaSum += area;
      alphaWeightSum += alphaWeight;
    }
  }

  if (areaSum <= 0) {
    return null;
  }

  const a = alphaSum / areaSum;
  if (alphaWeightSum <= 0) {
    return { r: 0, g: 0, b: 0, a };
  }

  return {
    r: weightedR / alphaWeightSum,
    g: weightedG / alphaWeightSum,
    b: weightedB / alphaWeightSum,
    a
  };
}

function selectActivePalette(
  grid: SampledGrid,
  settings: ConversionSettings,
  palette: PaletteColor[]
): PaletteColor[] {
  const pool = restrictPaletteByAllowed(palette, settings.allowedColorCodes);

  if (settings.maxColors === "all" || settings.maxColors >= pool.length) {
    return pool;
  }

  const counts: Record<string, number> = {};
  const nearestCodes: Array<string | null> = new Array(grid.cells.length).fill(null);
  for (let index = 0; index < grid.cells.length; index += 1) {
    const cell = grid.cells[index];
    if (!isOpaqueEnough(cell, settings)) {
      continue;
    }
    const nearestCode = findNearestCodeByLab(rgbToLab(cell), pool);
    nearestCodes[index] = nearestCode;
    counts[nearestCode] = (counts[nearestCode] ?? 0) + 1;
  }

  const byCode = new Map(pool.map((color) => [color.code, color]));
  const entries = Object.entries(counts);
  if (entries.length <= settings.maxColors) {
    return entries
      .sort(([leftCode], [rightCode]) =>
        (byCode.get(leftCode)?.sortOrder ?? 0) - (byCode.get(rightCode)?.sortOrder ?? 0))
      .map(([code]) => byCode.get(code))
      .filter((color): color is PaletteColor => Boolean(color));
  }

  const byFrequency = entries.sort(([leftCode, leftCount], [rightCode, rightCount]) => {
      if (rightCount !== leftCount) {
        return rightCount - leftCount;
      }
      return (byCode.get(leftCode)?.sortOrder ?? 0) - (byCode.get(rightCode)?.sortOrder ?? 0);
    });

  // 少量高对比色往往是眼睛、高光、徽章等识别关键。为它们保留少数名额，
  // 避免纯按数量限色时被大面积肤色/背景色挤掉。
  const detailSlots = settings.maxColors >= 8
    ? Math.min(4, Math.max(1, Math.floor(settings.maxColors / 8)))
    : 0;
  const frequentCodes = byFrequency
    .slice(0, settings.maxColors - detailSlots)
    .map(([code]) => code);
  const selected = new Set(frequentCodes);
  const detailScores: Record<string, number> = {};

  const scorePair = (leftIndex: number, rightIndex: number) => {
    const leftCode = nearestCodes[leftIndex];
    const rightCode = nearestCodes[rightIndex];
    const left = grid.cells[leftIndex];
    const right = grid.cells[rightIndex];
    if (!leftCode || !rightCode || leftCode === rightCode || !left || !right) {
      return;
    }
    const contrast = Math.hypot(left.r - right.r, left.g - right.g, left.b - right.b);
    const score = Math.min(6, contrast / 42);
    detailScores[leftCode] = (detailScores[leftCode] ?? 0) + score;
    detailScores[rightCode] = (detailScores[rightCode] ?? 0) + score;
  };

  for (let y = 0; y < grid.height; y += 1) {
    for (let x = 0; x < grid.width; x += 1) {
      const index = y * grid.width + x;
      if (x + 1 < grid.width) scorePair(index, index + 1);
      if (y + 1 < grid.height) scorePair(index, index + grid.width);
    }
  }

  const detailCodes = byFrequency
    .filter(([code]) => !selected.has(code))
    .sort(([leftCode, leftCount], [rightCode, rightCount]) => {
      const scoreDifference = (detailScores[rightCode] ?? 0) - (detailScores[leftCode] ?? 0);
      if (scoreDifference !== 0) {
        return scoreDifference;
      }
      return rightCount - leftCount;
    })
    .slice(0, detailSlots)
    .map(([code]) => code);

  const sorted = [...frequentCodes, ...detailCodes]
    .map((code) => byCode.get(code))
    .filter((color): color is PaletteColor => Boolean(color));

  return sorted.length > 0 ? sorted : pool.slice(0, settings.maxColors);
}

function restrictPaletteByAllowed(palette: PaletteColor[], allowed?: string[] | null): PaletteColor[] {
  if (!allowed || allowed.length === 0) {
    return palette;
  }
  const allowSet = new Set(allowed);
  const subset = palette.filter((color) => allowSet.has(color.code));
  return subset.length > 0 ? subset : palette;
}

function quantize(
  grid: SampledGrid,
  palette: PaletteColor[],
  settings: ConversionSettings
): BeadMatrix {
  const matrix: BeadMatrix = [];
  for (let y = 0; y < grid.height; y += 1) {
    const row: Array<string | null> = [];
    for (let x = 0; x < grid.width; x += 1) {
      const cell = grid.cells[y * grid.width + x];
      if (!isOpaqueEnough(cell, settings)) {
        row.push(null);
        continue;
      }
      row.push(findNearestPaletteColor(cell, palette).code);
    }
    matrix.push(row);
  }
  return matrix;
}

function quantizeWithFloydSteinberg(
  grid: SampledGrid,
  palette: PaletteColor[],
  settings: ConversionSettings
): BeadMatrix {
  const width = grid.width;
  const height = grid.height;
  const buffer: SampledCell[] = grid.cells.map((cell) => (cell ? { ...cell } : null));
  const matrix: BeadMatrix = [];

  const distribute = (x: number, y: number, factor: number, dr: number, dg: number, db: number) => {
    if (x < 0 || x >= width || y < 0 || y >= height) {
      return;
    }
    const idx = y * width + x;
    const target = buffer[idx];
    if (!target) {
      return;
    }
    target.r = clamp(target.r + dr * factor, 0, 255);
    target.g = clamp(target.g + dg * factor, 0, 255);
    target.b = clamp(target.b + db * factor, 0, 255);
  };

  for (let y = 0; y < height; y += 1) {
    const row: Array<string | null> = [];
    for (let x = 0; x < width; x += 1) {
      const cell = buffer[y * width + x];
      if (!isOpaqueEnough(cell, settings)) {
        row.push(null);
        continue;
      }
      const matched = findNearestPaletteColor(cell, palette);
      row.push(matched.code);

      const dr = cell.r - matched.rgb.r;
      const dg = cell.g - matched.rgb.g;
      const db = cell.b - matched.rgb.b;

      distribute(x + 1, y, 7 / 16, dr, dg, db);
      distribute(x - 1, y + 1, 3 / 16, dr, dg, db);
      distribute(x, y + 1, 5 / 16, dr, dg, db);
      distribute(x + 1, y + 1, 1 / 16, dr, dg, db);
    }
    matrix.push(row);
  }

  return matrix;
}

// 4x4 Bayer 有序抖动阈值矩阵：按格子位置加一个确定性小偏移代替误差扩散，
// 过渡区域不会像 Floyd-Steinberg 那样出现随机"脏点"，也更适合保留像素画细节。
const BAYER_4: ReadonlyArray<ReadonlyArray<number>> = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5]
];
// 偏移幅度：((bayer+0.5)/16 - 0.5) * STRENGTH，范围约 ±75/255，足以翻过相邻色号边界。
const BAYER_STRENGTH = 160;

function quantizeWithBayer(
  grid: SampledGrid,
  palette: PaletteColor[],
  settings: ConversionSettings
): BeadMatrix {
  const matrix: BeadMatrix = [];
  for (let y = 0; y < grid.height; y += 1) {
    const row: Array<string | null> = [];
    for (let x = 0; x < grid.width; x += 1) {
      const cell = grid.cells[y * grid.width + x];
      if (!isOpaqueEnough(cell, settings)) {
        row.push(null);
        continue;
      }
      const offset = ((BAYER_4[y % 4][x % 4] + 0.5) / 16 - 0.5) * BAYER_STRENGTH;
      const dithered: Rgb = {
        r: clamp(cell.r + offset, 0, 255),
        g: clamp(cell.g + offset, 0, 255),
        b: clamp(cell.b + offset, 0, 255)
      };
      row.push(findNearestPaletteColor(dithered, palette).code);
    }
    matrix.push(row);
  }
  return matrix;
}
function isOpaqueEnough(cell: SampledCell, settings: ConversionSettings): cell is Rgba {
  if (!cell) {
    return false;
  }
  if (settings.keepTransparent && cell.a <= settings.transparentThreshold) {
    return false;
  }
  return true;
}

function createDesignId(fileName: string): string {
  const safeName = fileName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${safeName || "design"}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export type { PaletteSeed };






