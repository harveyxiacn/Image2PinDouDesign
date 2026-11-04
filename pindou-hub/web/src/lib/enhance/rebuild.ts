// 按网格重建：每格取稳健纯色（中位数），格内文字墨迹单独按“离底色多远”做 1 通道场，放大后过对比度阈值，字就是锐利的；
// 格线单独检测并按放大后的宽度重画。网格以外（抬头 / 图例）保持 Lanczos + 反锐化的通用放大。
import type { PixelSource } from "@engine/types";
import type { GridDetection } from "../recognize/types";
import { checkAbort, deblock, lanczosResize, unsharp, yieldTick } from "./resample";

type Rgb = [number, number, number];

function median(vals: Uint8Array, n: number): number {
  const a = vals.subarray(0, n).sort();
  return a[n >> 1];
}

type Lines = { visible: boolean; color: Rgb };

/** 沿网格线抽样：线上的像素与两侧（同色）格内像素有稳定差异 → 有可见格线，返回线色 */
function detectLines(src: PixelSource, g: GridDetection, vertical: boolean): Lines {
  const { width: w, height: h, data: d } = src;
  const pitch = vertical ? g.pitchX : g.pitchY;
  const off = Math.max(2, Math.round(pitch * 0.3));
  let valid = 0, hit = 0;
  const rs: number[] = [], gs: number[] = [], bs: number[] = [];
  const nLines = vertical ? g.cols : g.rows;
  const nAlong = vertical ? g.rows : g.cols;
  const lumaAt = (x: number, y: number) => { x = Math.max(0, Math.min(w - 1, x)); y = Math.max(0, Math.min(h - 1, y)); const p = (y * w + x) * 4; return (d[p] * 77 + d[p + 1] * 150 + d[p + 2] * 29) >> 8; };
  for (let l = 1; l < nLines; l++) {
    const pos = (vertical ? g.x0 : g.y0) + l * pitch;
    for (let a = 0; a < nAlong; a += Math.max(1, Math.floor(nAlong / 24))) {
      const mid = (vertical ? g.y0 : g.x0) + (a + 0.5) * (vertical ? g.pitchY : g.pitchX);
      const m = Math.round(mid), pr = Math.round(pos);
      const at = (t: number) => (vertical ? lumaAt(pr + t, m) : lumaAt(m, pr + t));
      const l1 = at(-off), l2 = at(off);
      if (Math.abs(l1 - l2) > 8) continue;
      valid++;
      let best = 0, bt = 0;
      for (let t = -1; t <= 1; t++) { const dv = Math.abs(at(t) - (l1 + l2) / 2); if (dv >= best) { best = dv; bt = t; } }
      if (best > 12) {
        hit++;
        const x = Math.max(0, Math.min(w - 1, vertical ? pr + bt : m)), y = Math.max(0, Math.min(h - 1, vertical ? m : pr + bt));
        const p = (y * w + x) * 4; rs.push(d[p]); gs.push(d[p + 1]); bs.push(d[p + 2]);
      }
    }
  }
  if (valid < 8 || hit < valid * 0.6 || rs.length < 6) return { visible: false, color: [128, 128, 128] };
  const med = (a: number[]) => a.sort((x, y) => x - y)[a.length >> 1];
  return { visible: true, color: [med(rs), med(gs), med(bs)] };
}

export async function chartRebuild(
  src: PixelSource, g: GridDetection, dw: number, dh: number, blockiness: number,
  signal?: AbortSignal, onFrac?: (f: number) => void
): Promise<PixelSource> {
  const sx = dw / src.width, sy = dh / src.height;
  const base = blockiness > 0.3 ? deblock(src, blockiness) : src;
  const out = await lanczosResize(base, dw, dh, signal, (f) => onFrac?.(f * 0.8));
  unsharp(out, 0.6);
  checkAbort(signal);

  const vLines = detectLines(src, g, true);
  const hLines = detectLines(src, g, false);
  const { width: w, height: h } = src;
  const sd = src.data, od = out.data;
  const lineIn = (vLines.visible || hLines.visible) ? 1 : 0;
  const inset = Math.max(1, Math.round(Math.min(g.pitchX, g.pitchY) * 0.1)) + lineIn * 0;
  const tmpR = new Uint8Array(4096), tmpG = new Uint8Array(4096), tmpB = new Uint8Array(4096);

  for (let r = 0; r < g.rows; r++) {
    if ((r & 7) === 7) { checkAbort(signal); onFrac?.(0.8 + 0.2 * (r / g.rows)); await yieldTick(); }
    const by0 = g.y0 + r * g.pitchY, by1 = by0 + g.pitchY;
    const oy0 = Math.max(0, Math.round(by0 * sy)), oy1 = Math.min(dh, Math.round(by1 * sy));
    if (oy1 <= oy0) continue;
    for (let c = 0; c < g.cols; c++) {
      const bx0 = g.x0 + c * g.pitchX, bx1 = bx0 + g.pitchX;
      const ox0 = Math.max(0, Math.round(bx0 * sx)), ox1 = Math.min(dw, Math.round(bx1 * sx));
      if (ox1 <= ox0) continue;
      // 取样窗：格内缩进，避开格线与相邻格的混色
      let ix0 = Math.ceil(bx0 + inset), ix1 = Math.floor(bx1 - inset), iy0 = Math.ceil(by0 + inset), iy1 = Math.floor(by1 - inset);
      if (ix1 - ix0 < 2) { const m = Math.round((bx0 + bx1) / 2); ix0 = m - 1; ix1 = m + 1; }
      if (iy1 - iy0 < 2) { const m = Math.round((by0 + by1) / 2); iy0 = m - 1; iy1 = m + 1; }
      ix0 = Math.max(0, ix0); iy0 = Math.max(0, iy0); ix1 = Math.min(w, ix1); iy1 = Math.min(h, iy1);
      const ww = ix1 - ix0, wh = iy1 - iy0;
      if (ww < 1 || wh < 1 || ww * wh > 4096) continue;
      let n = 0;
      for (let y = iy0; y < iy1; y++) for (let x = ix0; x < ix1; x++) { const p = (y * w + x) * 4; tmpR[n] = sd[p]; tmpG[n] = sd[p + 1]; tmpB[n] = sd[p + 2]; n++; }
      const fr = median(tmpR, n), fg = median(tmpG, n), fb = median(tmpB, n);
      // 整格填纯色
      for (let y = oy0; y < oy1; y++) {
        let o = (y * dw + ox0) * 4;
        for (let x = ox0; x < ox1; x++, o += 4) { od[o] = fr; od[o + 1] = fg; od[o + 2] = fb; }
      }
      // 墨迹：离底色最远的 10% 像素的平均色作为“墨色”
      const dev = new Float32Array(n);
      let maxDev = 0; n = 0;
      for (let y = iy0; y < iy1; y++) for (let x = ix0; x < ix1; x++) { const p = (y * w + x) * 4; const dv = Math.abs(sd[p] - fr) + Math.abs(sd[p + 1] - fg) + Math.abs(sd[p + 2] - fb); dev[n++] = dv; if (dv > maxDev) maxDev = dv; }
      if (maxDev < 90) continue;
      const cut = maxDev * 0.75;
      let ir = 0, ig = 0, ib = 0, ic = 0;
      n = 0;
      for (let y = iy0; y < iy1; y++) for (let x = ix0; x < ix1; x++) { if (dev[n++] >= cut) { const p = (y * w + x) * 4; ir += sd[p]; ig += sd[p + 1]; ib += sd[p + 2]; ic++; } }
      if (ic < 1) continue;
      ir /= ic; ig /= ic; ib /= ic;
      const vr = ir - fr, vg = ig - fg, vb = ib - fb;
      const vv = vr * vr + vg * vg + vb * vb;
      const a = new Float32Array(ww * wh);
      let strong = 0; n = 0;
      for (let y = iy0; y < iy1; y++) for (let x = ix0; x < ix1; x++) {
        const p = (y * w + x) * 4;
        let t = ((sd[p] - fr) * vr + (sd[p + 1] - fg) * vg + (sd[p + 2] - fb) * vb) / vv;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        if (t > 0.5) strong++;
        a[n++] = t;
      }
      if (strong < 2) continue; // 单个离群点是 JPEG 噪点，不是笔画
      // 窗口在输出里的范围，双线性放大 a 后过阈值
      const wx0 = Math.max(0, Math.round(ix0 * sx)), wx1 = Math.min(dw, Math.round(ix1 * sx));
      const wy0 = Math.max(0, Math.round(iy0 * sy)), wy1 = Math.min(dh, Math.round(iy1 * sy));
      for (let Y = wy0; Y < wy1; Y++) {
        let v = (Y + 0.5) / sy - 0.5 - iy0; v = v < 0 ? 0 : v > wh - 1 ? wh - 1 : v;
        const v0 = Math.floor(v), v1 = Math.min(wh - 1, v0 + 1), fy = v - v0;
        let o = (Y * dw + wx0) * 4;
        for (let X = wx0; X < wx1; X++, o += 4) {
          let u = (X + 0.5) / sx - 0.5 - ix0; u = u < 0 ? 0 : u > ww - 1 ? ww - 1 : u;
          const u0 = Math.floor(u), u1 = Math.min(ww - 1, u0 + 1), fx = u - u0;
          const t = (a[v0 * ww + u0] * (1 - fx) + a[v0 * ww + u1] * fx) * (1 - fy) + (a[v1 * ww + u0] * (1 - fx) + a[v1 * ww + u1] * fx) * fy;
          let k = (t - 0.36) / 0.28; k = k < 0 ? 0 : k > 1 ? 1 : k; k = k * k * (3 - 2 * k);
          if (k > 0) { od[o] = fr + vr * k; od[o + 1] = fg + vg * k; od[o + 2] = fb + vb * k; }
        }
      }
    }
  }
  // 重画格线
  const lw = Math.max(1, Math.round((sx + sy) / 2));
  const paint = (x0: number, y0: number, x1: number, y1: number, col: Rgb) => {
    x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(dw, x1); y1 = Math.min(dh, y1);
    for (let y = y0; y < y1; y++) { let o = (y * dw + x0) * 4; for (let x = x0; x < x1; x++, o += 4) { od[o] = col[0]; od[o + 1] = col[1]; od[o + 2] = col[2]; } }
  };
  const gx1 = Math.round((g.x0 + g.cols * g.pitchX) * sx), gy1 = Math.round((g.y0 + g.rows * g.pitchY) * sy);
  const gx0 = Math.round(g.x0 * sx), gy0 = Math.round(g.y0 * sy);
  if (vLines.visible) for (let c = 0; c <= g.cols; c++) { const x = Math.round((g.x0 + c * g.pitchX) * sx - lw / 2); paint(x, gy0, x + lw, gy1, vLines.color); }
  if (hLines.visible) for (let r = 0; r <= g.rows; r++) { const y = Math.round((g.y0 + r * g.pitchY) * sy - lw / 2); paint(gx0, y, gx1, y + lw, hLines.color); }
  onFrac?.(1);
  return out;
}
