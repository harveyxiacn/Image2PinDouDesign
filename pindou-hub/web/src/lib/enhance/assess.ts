// 画质评估：毫秒级估计格子大小、JPEG 方块感、模糊程度，决定要不要放大、放大几倍。
import type { PixelSource } from "@engine/types";
import type { GridDetection } from "../recognize/types";
import type { ImageQuality, QualityLevel } from "./index";

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** 目标格子边长（像素）：放大后格子至少这么大，格内色号 / 小字才读得清 */
export const TARGET_PITCH = 24;

function luma(d: Uint8ClampedArray, p: number) { return (d[p] * 77 + d[p + 1] * 150 + d[p + 2] * 29) >> 8; }

/** 8×8 边界上的小台阶 / 其它位置的小台阶：JPEG 方块感越重，比值越大于 1 */
export function measureBlockiness(src: PixelSource): number {
  const { width: w, height: h, data: d } = src;
  if (w < 32 || h < 32) return 0;
  let bs = 0, bn = 0, os = 0, on = 0;
  const ry = Math.max(1, Math.floor(h / 260));
  for (let y = 0; y < h; y += ry) {
    const row = y * w * 4;
    let prev = luma(d, row);
    for (let x = 1; x < w; x++) {
      const cur = luma(d, row + x * 4);
      const df = Math.abs(cur - prev); prev = cur;
      if (df > 20) continue;
      if ((x & 7) === 0) { bs += df; bn++; } else { os += df; on++; }
    }
  }
  const cx = Math.max(1, Math.floor(w / 260));
  for (let x = 0; x < w; x += cx) {
    let prev = luma(d, x * 4);
    for (let y = 1; y < h; y++) {
      const cur = luma(d, (y * w + x) * 4);
      const df = Math.abs(cur - prev); prev = cur;
      if (df > 20) continue;
      if ((y & 7) === 0) { bs += df; bn++; } else { os += df; on++; }
    }
  }
  if (bn < 200 || on < 800) return 0;
  const ratio = (bs / bn + 0.3) / (os / on + 0.3);
  return clamp01((ratio - 1.08) / 0.5);
}

/** 强边缘的“陡度”：一个台阶在 1 像素内完成 → 1；被缩放 / 糊开后摊在 2–3 像素 → 0.4–0.6。返回 0（清晰）–1（糊） */
export function measureBlur(src: PixelSource): number {
  const { width: w, height: h, data: d } = src;
  if (w < 16 || h < 16) return 0;
  let sum = 0, n = 0;
  const ry = Math.max(1, Math.floor(h / 260));
  const scan = (get: (i: number) => number, len: number) => {
    for (let x = 1; x < len - 2; x++) {
      const a = get(x - 1), b = get(x), c = get(x + 1), e = get(x + 2);
      const total = e - a;
      if (Math.abs(total) < 60) continue;
      const d1 = b - a, d2 = c - b, d3 = e - c;
      const sg = Math.sign(total);
      if (d1 * sg < -3 || d2 * sg < -3 || d3 * sg < -3) continue;
      // 只取台阶的起点（前一个像素还没开始变），避免一条边算 2–3 次
      if (Math.abs(get(x - 1) - get(Math.max(0, x - 2))) * 1 > Math.abs(total) * 0.25) continue;
      sum += Math.max(Math.abs(d1), Math.abs(d2), Math.abs(d3)) / Math.abs(total); n++;
    }
  };
  for (let y = 0; y < h; y += ry) { const row = y * w * 4; scan((i) => luma(d, row + i * 4), w); }
  const cx = Math.max(1, Math.floor(w / 260));
  for (let x = 0; x < w; x += cx) scan((i) => luma(d, (i * w + x) * 4), h);
  if (n < 40) return 0;
  return clamp01((0.8 - sum / n) / 0.35);
}

export function scaleFor(pitch: number | null, w: number, h: number): 1 | 2 | 3 | 4 {
  if (pitch && pitch > 0) return Math.max(2, Math.min(4, Math.ceil(TARGET_PITCH / pitch))) as 2 | 3 | 4;
  return Math.max(w, h) < 700 ? 3 : 2;
}

export function assessQuality(src: PixelSource, grid?: GridDetection | null): ImageQuality {
  const { width, height } = src;
  const pitchPx = grid ? Math.min(grid.pitchX, grid.pitchY) : null;
  const blockiness = measureBlockiness(src);
  const blur = measureBlur(src);
  const reasons: string[] = [];
  let level: QualityLevel = "good";
  const small = pitchPx !== null && pitchPx < 14;
  if (pitchPx !== null && pitchPx < 8) { level = "very-low"; reasons.push(`格子只有 ${Math.round(pitchPx)} 像素宽`); }
  else if (small) { level = "low"; reasons.push(`格子只有 ${Math.round(pitchPx!)} 像素宽`); }
  const smallish = pitchPx === null || pitchPx < TARGET_PITCH;
  if (blockiness > 0.55 && smallish) { if (level === "good") level = "low"; reasons.push("JPEG 压缩痕迹明显"); }
  if (blur > 0.5 && smallish) { if (level === "good") level = "low"; reasons.push("图片偏模糊"); }
  if (pitchPx === null && Math.max(width, height) < 600) { if (level === "good") level = "low"; reasons.push(`图片只有 ${width}×${height} 像素`); }
  const suggestedScale = level === "good" ? 1 : scaleFor(pitchPx, width, height);
  return { width, height, pitchPx, textPx: pitchPx ? Math.round(pitchPx * 0.45) : null, blockiness, blur, level, suggestedScale, reasons };
}
