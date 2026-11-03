import { boardsNeeded } from "./boards";
import { labDistanceSquared, rgbToLab } from "./color";
import { autoFramePixelSource } from "./crop";
import { estimatePixelArtScale, isLikelyPixelArt } from "./conversion";
import type { Lab, MaxColors, PaletteColor, PixelSource } from "./types";

// 智能顾问：在主线程上用缩小后的图快速估算“这张图大概需要多少种颜色、多大尺寸”，
// 并给出可读的理由。只做建议，真正的转换仍由 Worker 按用户设置完成。

export type ColorShare = { code: string; share: number };

export type ColorAdvice = {
  // 按面积占比排序的色卡颜色（已映射到所选套装）。
  composition: ColorShare[];
  // 覆盖 95% 面积所需的颜色数。
  colorsFor95: number;
  recommended: Exclude<MaxColors, 1>;
  reason: string;
};

export type SizeAdvice = {
  longEdge: number;
  width: number;
  height: number;
  boards: { cols: number; rows: number; pins: number };
  reason: string;
};

export type SmartAdvice = {
  colors: ColorAdvice;
  size: SizeAdvice | null;
};

const COLOR_STEPS: Array<Exclude<MaxColors, 1 | "all">> = [8, 16, 24, 32, 48];
const SIZE_STEPS = [29, 40, 52, 72, 104, 156];
const COLOR_ANALYSIS_EDGE = 96;
const DETAIL_ANALYSIS_EDGE = 192;
// 平均色差（ΔE*76）阈值：约等于“并排对比才看得出”。
const COLOR_ERROR_TARGET = 4.5;
// 缩小后细节损失阈值（ΔE*76，按像素平均）。
const DETAIL_LOSS_TARGET = 5.5;

export function adviseForSource(
  source: PixelSource,
  palette: PaletteColor[],
  options: { autoFrame?: boolean; ignoreWhiteBg?: boolean; boardPins?: number } = {}
): SmartAdvice | null {
  if (palette.length === 0 || source.width < 1 || source.height < 1) return null;
  const framed = options.autoFrame === false ? source : autoFramePixelSource(source, { ignoreWhiteBg: options.ignoreWhiteBg ?? true });
  const colors = adviseColors(framed, palette);
  if (!colors) return null;
  return { colors, size: adviseSize(framed, options.boardPins ?? 52) };
}

/** 颜色组成与推荐色数：比较“只用前 k 种颜色”时其余像素被迫换色的平均色差。 */
export function adviseColors(source: PixelSource, palette: PaletteColor[]): ColorAdvice | null {
  const small = downsample(source, COLOR_ANALYSIS_EDGE);
  const labs: Lab[] = [];
  const nearest: number[] = [];
  const counts = new Array<number>(palette.length).fill(0);
  for (let index = 0; index < small.width * small.height; index += 1) {
    const offset = index * 4;
    if (small.data[offset + 3] < 128) continue;
    const lab = rgbToLab({ r: small.data[offset], g: small.data[offset + 1], b: small.data[offset + 2] });
    const match = nearestIndex(lab, palette);
    labs.push(lab);
    nearest.push(match);
    counts[match] += 1;
  }
  const total = labs.length;
  if (total === 0) return null;

  const ranked = counts
    .map((count, index) => ({ index, count }))
    .filter((entry) => entry.count > 0)
    .sort((left, right) => right.count - left.count);
  const composition = ranked.map((entry) => ({ code: palette[entry.index].code, share: entry.count / total }));
  let covered = 0;
  let colorsFor95 = ranked.length;
  for (let rank = 0; rank < ranked.length; rank += 1) {
    covered += ranked[rank].count;
    if (covered / total >= 0.95) {
      colorsFor95 = rank + 1;
      break;
    }
  }

  const errorFor = (k: number) => {
    const kept = ranked.slice(0, k).map((entry) => palette[entry.index]);
    const keptSet = new Set(ranked.slice(0, k).map((entry) => entry.index));
    let sum = 0;
    for (let index = 0; index < total; index += 1) {
      if (keptSet.has(nearest[index])) {
        sum += Math.sqrt(labDistanceSquared(labs[index], palette[nearest[index]].lab));
      } else {
        sum += Math.sqrt(labDistanceSquared(labs[index], kept[nearestIndex(labs[index], kept)].lab));
      }
    }
    return sum / total;
  };
  const baseline = errorFor(ranked.length);
  const errors = COLOR_STEPS.map((k) => ({ k, error: k >= ranked.length ? baseline : errorFor(k) }));
  // 取第一个“与使用全部颜色相比多出的色差足够小”的档位；都不满足则用最大档。
  const pick = errors.find((entry) => entry.error - baseline <= COLOR_ERROR_TARGET * 0.35 || entry.error <= COLOR_ERROR_TARGET)
    ?? errors[errors.length - 1];
  const recommended = pick.k >= ranked.length && ranked.length <= 48
    ? COLOR_STEPS.find((step) => step >= ranked.length) ?? 48
    : pick.k;
  const nextStep = errors.find((entry) => entry.k > recommended);
  const reason = ranked.length <= recommended
    ? `图片只用到约 ${ranked.length} 种颜色，${recommended} 色足够完整还原。`
    : `前 ${recommended} 色覆盖 ${percent(coverage(ranked, recommended, total))} 面积` +
      (nextStep ? `；增加到 ${nextStep.k} 色平均色差只再降低 ${(pick.error - nextStep.error).toFixed(1)}。` : "。");
  return { composition, colorsFor95, recommended, reason };
}

/**
 * 推荐尺寸：计算各档长边“缩小再放大”后的平均细节损失，取收益拐点——
 * 损失已低于阈值，或已拿到最小档到最大档之间 75% 的改善，再加大主要只增加用豆量。
 */
export function adviseSize(source: PixelSource, pins: number): SizeAdvice | null {
  if (isLikelyPixelArt(source)) {
    const scale = estimatePixelArtScale(source) ?? 1;
    const width = Math.max(1, Math.round(source.width / scale));
    const height = Math.max(1, Math.round(source.height / scale));
    return withBoards(Math.max(width, height), width, height, pins, `检测为像素画，按原始像素还原为 ${width} × ${height} 最清晰。`);
  }
  const reference = downsample(source, DETAIL_ANALYSIS_EDGE);
  const referenceLab = toLab(reference);
  const longSource = Math.max(source.width, source.height);
  const candidates = SIZE_STEPS.filter((edge) => edge <= Math.max(SIZE_STEPS[0], longSource));
  const losses = candidates.map((edge) => ({ edge, loss: detailLoss(reference, referenceLab, edge) }));
  const maxLoss = Math.max(...losses.map((entry) => entry.loss));
  const minLoss = Math.min(...losses.map((entry) => entry.loss));
  const kneeTarget = minLoss + (maxLoss - minLoss) * 0.25;
  let pick = losses.find((entry) => entry.loss <= DETAIL_LOSS_TARGET);
  const reachedTarget = Boolean(pick);
  if (!pick) {
    // 各档损失几乎一样且都很高：细节比任何板型都细，只能用最大档尽量保留。
    pick = maxLoss - minLoss < 1
      ? losses[losses.length - 1]
      : losses.find((entry) => entry.loss <= kneeTarget) ?? losses[losses.length - 1];
  }
  const chosen = pick.edge;
  const ratio = source.width / source.height;
  const width = ratio >= 1 ? chosen : Math.max(1, Math.round(chosen * ratio));
  const height = ratio >= 1 ? Math.max(1, Math.round(chosen / ratio)) : chosen;
  const larger = losses.find((entry) => entry.edge > chosen);
  const reason = reachedTarget
    ? `长边 ${chosen} 格已能保留主要轮廓和细节，再加大主要是增加用豆量。`
    : larger
      ? `长边 ${chosen} 格已拿到大部分细节；加到 ${larger.edge} 格${describeGain(pick.loss - larger.loss, maxLoss - minLoss)}，用豆却多约 ${Math.round(((larger.edge / chosen) ** 2 - 1) * 100)}%。`
      : `图片细节很细，建议用到长边 ${chosen} 格尽量保留眼睛、纹理等小细节。`;
  return withBoards(chosen, width, height, pins, reason);
}

// 把“细节损失的下降量”换算成占全部可改善空间的比例，避免向用户展示难懂的色差数值。
function describeGain(gain: number, range: number): string {
  const share = range > 0 ? Math.max(0, gain) / range : 0;
  return share < 0.01 ? "细节几乎没有提升" : `细节只再多保留约 ${Math.round(share * 100)}%`;
}

function withBoards(longEdge: number, width: number, height: number, pins: number, reason: string): SizeAdvice {
  const boards = boardsNeeded(width, height, pins);
  return { longEdge, width, height, boards: { ...boards, pins }, reason };
}

function detailLoss(reference: PixelSource, referenceLab: Array<Lab | null>, longEdge: number): number {
  const scale = longEdge / Math.max(reference.width, reference.height);
  if (scale >= 1) return 0;
  const width = Math.max(1, Math.round(reference.width * scale));
  const height = Math.max(1, Math.round(reference.height * scale));
  const small = resize(reference, width, height);
  const smallLab = toLab(small);
  let sum = 0;
  let count = 0;
  for (let y = 0; y < reference.height; y += 1) {
    const sy = Math.min(height - 1, Math.floor((y / reference.height) * height));
    for (let x = 0; x < reference.width; x += 1) {
      const original = referenceLab[y * reference.width + x];
      if (!original) continue;
      const sx = Math.min(width - 1, Math.floor((x / reference.width) * width));
      const approx = smallLab[sy * width + sx];
      if (!approx) continue;
      sum += Math.sqrt(labDistanceSquared(original, approx));
      count += 1;
    }
  }
  return count > 0 ? sum / count : 0;
}

function coverage(ranked: Array<{ count: number }>, k: number, total: number): number {
  return ranked.slice(0, k).reduce((sum, entry) => sum + entry.count, 0) / total;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function nearestIndex(lab: Lab, palette: Array<Pick<PaletteColor, "lab">>): number {
  let best = 0;
  let bestDistance = Infinity;
  for (let index = 0; index < palette.length; index += 1) {
    const distance = labDistanceSquared(lab, palette[index].lab);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  }
  return best;
}

function toLab(source: PixelSource): Array<Lab | null> {
  const labs: Array<Lab | null> = new Array(source.width * source.height);
  for (let index = 0; index < labs.length; index += 1) {
    const offset = index * 4;
    labs[index] = source.data[offset + 3] < 128
      ? null
      : rgbToLab({ r: source.data[offset], g: source.data[offset + 1], b: source.data[offset + 2] });
  }
  return labs;
}

function downsample(source: PixelSource, maxEdge: number): PixelSource {
  const scale = Math.min(1, maxEdge / Math.max(source.width, source.height));
  if (scale >= 1) return source;
  return resize(source, Math.max(1, Math.round(source.width * scale)), Math.max(1, Math.round(source.height * scale)));
}

// 面积平均缩放（按 alpha 加权），用于分析，不追求和转换器逐值一致。
function resize(source: PixelSource, width: number, height: number): PixelSource {
  const data = new Uint8ClampedArray(width * height * 4);
  const scaleX = source.width / width;
  const scaleY = source.height / height;
  for (let y = 0; y < height; y += 1) {
    const top = Math.floor(y * scaleY);
    const bottom = Math.max(top + 1, Math.floor((y + 1) * scaleY));
    for (let x = 0; x < width; x += 1) {
      const left = Math.floor(x * scaleX);
      const right = Math.max(left + 1, Math.floor((x + 1) * scaleX));
      let r = 0; let g = 0; let b = 0; let a = 0; let weight = 0; let n = 0;
      for (let sy = top; sy < Math.min(bottom, source.height); sy += 1) {
        for (let sx = left; sx < Math.min(right, source.width); sx += 1) {
          const offset = (sy * source.width + sx) * 4;
          const alpha = source.data[offset + 3] / 255;
          r += source.data[offset] * alpha;
          g += source.data[offset + 1] * alpha;
          b += source.data[offset + 2] * alpha;
          a += source.data[offset + 3];
          weight += alpha;
          n += 1;
        }
      }
      const out = (y * width + x) * 4;
      if (weight > 0) {
        data[out] = r / weight;
        data[out + 1] = g / weight;
        data[out + 2] = b / weight;
      }
      data[out + 3] = n > 0 ? a / n : 0;
    }
  }
  return { width, height, data };
}
