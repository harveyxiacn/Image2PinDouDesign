import { applyAdjustmentsToGrid } from "./adjustments";
import { dropBorderWhite } from "./background";
import { ciede2000, clamp, labDistanceSquared, rgbToLab } from "./color";
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
  const sampled = resampleToGrid(source, settings);
  const cleaned = settings.ignoreWhiteBg ? dropBorderWhite(sampled) : sampled;
  const adjusted = settings.adjustments ? applyAdjustmentsToGrid(cleaned, settings.adjustments) : cleaned;
  const grid = settings.smooth ? medianSmoothGrid(adjusted, settings.smooth) : adjusted;
  const activePalette = selectActivePalette(grid, settings, palette);
  const quantized = settings.dither
    ? quantizeWithFloydSteinberg(grid, activePalette, settings)
    : quantize(grid, activePalette, settings);
  const matrix = settings.outline ? outlineMatrix(quantized, OUTLINE_CODE) : quantized;

  return {
    id: createDesignId(fileName),
    fileName,
    boardWidth: settings.boardWidth,
    boardHeight: settings.boardHeight,
    matrix,
    colorCounts: countMatrixColors(matrix),
    settings
  };
}

export const OUTLINE_CODE = "H7"; // 黑色

// 给主体描边：任意非空格子，只要 4-邻域里有空格（透明/出界），就换成黑色 H7，
// 形成沿主体轮廓与内部空洞的 1 格黑边。仅在有透明区域（如抠图后）时有意义。
export function outlineMatrix(matrix: BeadMatrix, code: string): BeadMatrix {
  const height = matrix.length;
  const width = height > 0 ? matrix[0].length : 0;
  // 出界不算"空"：只对与真正透明格相邻的边缘描边；整幅不透明的图则不加边框。
  const isEmpty = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < width && y < height && !matrix[y][x];

  return matrix.map((row, y) =>
    row.map((cell, x) => {
      if (!cell) {
        return cell;
      }
      const edge = isEmpty(x - 1, y) || isEmpty(x + 1, y) || isEmpty(x, y - 1) || isEmpty(x, y + 1);
      return edge ? code : cell;
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
      cells[ty * tw + tx] = sampleArea(source, srcLeft, srcTop, srcRight, srcBottom);
    }
  }

  return { width: tw, height: th, cells };
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
  for (const cell of grid.cells) {
    if (!isOpaqueEnough(cell, settings)) {
      continue;
    }
    const nearestCode = findNearestCodeByLab(rgbToLab(cell), pool);
    counts[nearestCode] = (counts[nearestCode] ?? 0) + 1;
  }

  const byCode = new Map(pool.map((color) => [color.code, color]));
  const sorted = Object.entries(counts)
    .sort(([leftCode, leftCount], [rightCode, rightCount]) => {
      if (rightCount !== leftCount) {
        return rightCount - leftCount;
      }
      return (byCode.get(leftCode)?.sortOrder ?? 0) - (byCode.get(rightCode)?.sortOrder ?? 0);
    })
    .slice(0, settings.maxColors)
    .map(([code]) => byCode.get(code))
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
