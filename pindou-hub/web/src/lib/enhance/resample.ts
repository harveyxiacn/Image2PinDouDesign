// 高清化的底层像素运算：Lanczos3 放大、JPEG 去块、反锐化。全部纯 TS，只依赖 PixelSource。
import type { PixelSource } from "@engine/types";

export function abortError() { return new DOMException("已取消", "AbortError"); }
export function checkAbort(signal?: AbortSignal) { if (signal?.aborted) throw abortError(); }
export const yieldTick = () => new Promise<void>((r) => setTimeout(r, 0));

function lanczos3(x: number): number {
  if (x === 0) return 1;
  const ax = Math.abs(x);
  if (ax >= 3) return 0;
  const px = Math.PI * x;
  return (3 * Math.sin(px) * Math.sin(px / 3)) / (px * px);
}

/** 每个输出像素对应的 6 个源像素起点与归一化权重（放大时核不必随比例缩放） */
function makeTaps(srcLen: number, dstLen: number): { start: Int32Array; w: Float32Array } {
  const start = new Int32Array(dstLen);
  const w = new Float32Array(dstLen * 6);
  const s = dstLen / srcLen;
  for (let i = 0; i < dstLen; i++) {
    const c = (i + 0.5) / s - 0.5;
    const f = Math.floor(c);
    start[i] = f - 2;
    let sum = 0;
    for (let k = 0; k < 6; k++) { const v = lanczos3(c - (f - 2 + k)); w[i * 6 + k] = v; sum += v; }
    for (let k = 0; k < 6; k++) w[i * 6 + k] /= sum;
  }
  return { start, w };
}

/** Lanczos3 放大到 dw×dh（按行带检查取消 / 汇报进度，两遍可分离卷积） */
export async function lanczosResize(src: PixelSource, dw: number, dh: number, signal?: AbortSignal, onFrac?: (f: number) => void): Promise<PixelSource> {
  const sw = src.width, sh = src.height, sd = src.data;
  const tx = makeTaps(sw, dw);
  const ty = makeTaps(sh, dh);
  const tmp = new Uint8ClampedArray(dw * sh * 3); // 横向放大后的 RGB
  const BAND = 48;
  for (let y0 = 0; y0 < sh; y0 += BAND) {
    checkAbort(signal);
    const y1 = Math.min(sh, y0 + BAND);
    for (let y = y0; y < y1; y++) {
      const row = y * sw * 4;
      let o = y * dw * 3;
      for (let x = 0; x < dw; x++) {
        const s0 = tx.start[x], wb = x * 6;
        let r = 0, g = 0, b = 0;
        for (let k = 0; k < 6; k++) {
          let sx = s0 + k; if (sx < 0) sx = 0; else if (sx >= sw) sx = sw - 1;
          const wt = tx.w[wb + k], p = row + sx * 4;
          r += sd[p] * wt; g += sd[p + 1] * wt; b += sd[p + 2] * wt;
        }
        tmp[o++] = r; tmp[o++] = g; tmp[o++] = b;
      }
    }
    onFrac?.(0.4 * (y1 / sh));
    if ((y0 / BAND) % 6 === 5) await yieldTick();
  }
  const out = new Uint8ClampedArray(dw * dh * 4);
  const rowStride = dw * 3;
  for (let y0 = 0; y0 < dh; y0 += 64) {
    checkAbort(signal);
    const y1 = Math.min(dh, y0 + 64);
    for (let y = y0; y < y1; y++) {
      const s0 = ty.start[y], wb = y * 6;
      const rows: number[] = [];
      for (let k = 0; k < 6; k++) { let sy = s0 + k; if (sy < 0) sy = 0; else if (sy >= sh) sy = sh - 1; rows.push(sy * rowStride); }
      const w0 = ty.w[wb], w1 = ty.w[wb + 1], w2 = ty.w[wb + 2], w3 = ty.w[wb + 3], w4 = ty.w[wb + 4], w5 = ty.w[wb + 5];
      const [a0, a1, a2, a3, a4, a5] = rows;
      let o = y * dw * 4;
      for (let x = 0, p = 0; x < dw; x++, p += 3) {
        out[o++] = tmp[a0 + p] * w0 + tmp[a1 + p] * w1 + tmp[a2 + p] * w2 + tmp[a3 + p] * w3 + tmp[a4 + p] * w4 + tmp[a5 + p] * w5;
        out[o++] = tmp[a0 + p + 1] * w0 + tmp[a1 + p + 1] * w1 + tmp[a2 + p + 1] * w2 + tmp[a3 + p + 1] * w3 + tmp[a4 + p + 1] * w4 + tmp[a5 + p + 1] * w5;
        out[o++] = tmp[a0 + p + 2] * w0 + tmp[a1 + p + 2] * w1 + tmp[a2 + p + 2] * w2 + tmp[a3 + p + 2] * w3 + tmp[a4 + p + 2] * w4 + tmp[a5 + p + 2] * w5;
        out[o++] = 255;
      }
    }
    onFrac?.(0.4 + 0.5 * (y1 / dh));
    if ((y0 / 64) % 8 === 7) await yieldTick();
  }
  return { width: dw, height: dh, data: out };
}

/** 轻量去块：在 8×8 边界上，台阶很小（<阈值）时把两侧像素向中间拉一点；真实边缘（台阶大）不动。返回新图 */
export function deblock(src: PixelSource, strength = 1): PixelSource {
  const { width: w, height: h } = src;
  const d = new Uint8ClampedArray(src.data);
  const T = 14 + 6 * strength;
  for (let c = 0; c < 3; c++) {
    for (let y = 0; y < h; y++) {
      const row = y * w * 4 + c;
      for (let x = 8; x < w - 1; x += 8) {
        const p = row + x * 4, q = p - 4;
        const step = d[p] - d[q];
        if (Math.abs(step) > T) continue;
        const a = step / 4;
        d[q] += a; d[p] -= a;
        if (x >= 2 && x + 1 < w) { d[q - 4] += a / 2; d[p + 4] -= a / 2; }
      }
    }
    for (let y = 8; y < h - 1; y += 8) {
      const r1 = y * w * 4 + c, r0 = r1 - w * 4;
      for (let x = 0; x < w; x++) {
        const p = r1 + x * 4, q = r0 + x * 4;
        const step = d[p] - d[q];
        if (Math.abs(step) > T) continue;
        const a = step / 4;
        d[q] += a; d[p] -= a;
        if (y >= 2 && y + 1 < h) { d[q - w * 4] += a / 2; d[p + w * 4] -= a / 2; }
      }
    }
  }
  return { width: w, height: h, data: d };
}

/** 反锐化（5 点二项式模糊作底）：out = img + amount·(img − blur)，原地修改 */
export function unsharp(img: PixelSource, amount: number, threshold = 3) {
  const { width: w, height: h, data: d } = img;
  const tmp = new Uint8ClampedArray(w * h * 3);
  for (let y = 0; y < h; y++) {
    let o = y * w * 3;
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      const xm2 = Math.max(0, x - 2), xm1 = Math.max(0, x - 1), xp1 = Math.min(w - 1, x + 1), xp2 = Math.min(w - 1, x + 2);
      for (let c = 0; c < 3; c++) tmp[o++] = (d[row + xm2 * 4 + c] + 4 * d[row + xm1 * 4 + c] + 6 * d[row + x * 4 + c] + 4 * d[row + xp1 * 4 + c] + d[row + xp2 * 4 + c]) / 16;
    }
  }
  const st = w * 3;
  for (let y = 0; y < h; y++) {
    const ym2 = Math.max(0, y - 2) * st, ym1 = Math.max(0, y - 1) * st, y0 = y * st, yp1 = Math.min(h - 1, y + 1) * st, yp2 = Math.min(h - 1, y + 2) * st;
    let o = y * w * 4;
    for (let x = 0, p = 0; x < w; x++, p += 3, o += 4) {
      for (let c = 0; c < 3; c++) {
        const blur = (tmp[ym2 + p + c] + 4 * tmp[ym1 + p + c] + 6 * tmp[y0 + p + c] + 4 * tmp[yp1 + p + c] + tmp[yp2 + p + c]) / 16;
        const diff = d[o + c] - blur;
        if (Math.abs(diff) > threshold) d[o + c] = d[o + c] + amount * diff;
      }
    }
  }
}
