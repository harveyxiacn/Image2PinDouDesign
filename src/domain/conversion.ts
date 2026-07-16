import { applyAdjustmentsToGrid } from "./adjustments";
import { dropBorderWhite } from "./background";
import { ciede2000, clamp, labDistanceSquared, rgbToLab } from "./color";
import { autoFramePixelSource } from "./crop";
import { preparePalette } from "./palette";
import { medianSmoothGrid } from "./simplify";
import type {
  BeadDesign,
  BeadMatrix,
  ConversionSettings,
  FitMode,
  Lab,
  PaletteColor,
  PaletteSeed,
  PixelSource,
  Rgb,
  Rgba,
  SampledCell,
  SampledGrid
} from "./types";

export { preparePalette };

// 最终落色：用 CIEDE2000 取感知最接近的拼豆色号。
export function findNearestPaletteColor(rgb: Rgb, palette: PaletteColor[]): PaletteColor {
  if (palette.length === 0) {
    throw new Error("Palette cannot be empty");
  }

  const lab = rgbToLab(rgb);
  let best = palette[0];
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const color of palette) {
    const distance = ciede2000(lab, color.lab);
    if (distance < bestDistance) {
      best = color;
      bestDistance = distance;
    }
  }

  return best;
}

// 粗筛：仅用于统计"哪些色更常用"以决定保留哪些色，结果只参与排序、
// 不直接呈现，因此用便宜的 ΔE*76 平方距离即可，避免在全色卡上重复跑 CIEDE2000。
function findNearestCodeByLab(lab: Lab, palette: PaletteColor[]): string {
  let bestCode = palette[0].code;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const color of palette) {
    const distance = labDistanceSquared(lab, color.lab);
    if (distance < bestDistance) {
      bestCode = color.code;
      bestDistance = distance;
    }
  }

  return bestCode;
}

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
  const cleaned = effectiveSettings.ignoreWhiteBg ? dropBorderWhite(sampled) : sampled;
  const adjusted = effectiveSettings.adjustments
    ? applyAdjustmentsToGrid(cleaned, effectiveSettings.adjustments)
    : cleaned;
  const grid = effectiveSettings.smooth ? medianSmoothGrid(adjusted, effectiveSettings.smooth) : adjusted;
  const activePalette = selectActivePalette(grid, effectiveSettings, palette);
  const quantized = effectiveSettings.dither
    ? quantizeWithFloydSteinberg(grid, activePalette, effectiveSettings)
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

  if (fit === "stretch") {
    scaleX = sw / tw;
    scaleY = sh / th;
    offsetX = 0;
    offsetY = 0;
    scaledW = tw;
    scaledH = th;
  } else {
    const factor = fit === "cover"
      ? Math.max(tw / sw, th / sh)
      : Math.min(tw / sw, th / sh);
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
      const srcLeft = dx * scaleX;
      const srcTop = dy * scaleY;
      const srcRight = (dx + 1) * scaleX;
      const srcBottom = (dy + 1) * scaleY;
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
  return {
    width: Math.max(8, Math.min(maximum.width, Math.round(logicalWidth * shrink))),
    height: Math.max(8, Math.min(maximum.height, Math.round(logicalHeight * shrink)))
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
