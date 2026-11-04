// 多张截图拼接：把真实样张（agumon，156×138，11128 颗）切成带手机状态栏和噪点的重叠截图，打乱顺序拼回去。
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { PixelSource } from "@engine/types";
import { detectGrid, readGrid } from "../lib/recognize/grid";
import { stitchScreens } from "../lib/stitch";
import { decodePng, downscaleArea, mulberry32 } from "./fixtures";

const SAMPLE = fileURLToPath(new URL("../../../../docs/samples/agumon-detail-20260907.png", import.meta.url));
const LEGEND_CODES = ["A1", "A13", "A14", "A17", "A21", "A26", "B4", "B11", "B22", "B23", "C6", "C7", "C9", "C11", "C12", "C17", "C29",
  "D10", "D15", "F1", "F6", "F8", "F10", "F11", "G6", "G20", "H7", "H19", "R5", "R7", "R10", "R22"];

function crop(src: PixelSource, x0: number, y0: number, w: number, h: number): PixelSource {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) out.set(src.data.subarray(((y0 + y) * src.width + x0) * 4, ((y0 + y) * src.width + x0 + w) * 4), y * w * 4);
  return { width: w, height: h, data: out };
}

/** 把内容裁片装进“手机截图”：顶部状态栏 + 标题栏、底部导航条（各张完全相同），内容区加独立的 JPEG 式噪点。 */
function phoneShot(content: PixelSource, top: number, bottom: number, noise: number, seed: number): PixelSource {
  const rnd = mulberry32(seed);
  const w = content.width, h = content.height + top + bottom;
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      let v: number[];
      if (y < top) {
        const dark = y < top * 0.5;
        const ink = (x % 97 < 9 && y % 11 < 7) || (x > w - 120 && x % 13 < 6);
        v = ink ? (dark ? [230, 230, 230] : [40, 40, 40]) : dark ? [24, 24, 28] : [245, 245, 245];
      } else if (y >= top + content.height) {
        v = x > w / 2 - 80 && x < w / 2 + 80 && Math.abs(y - (h - bottom / 2)) < 4 ? [60, 60, 60] : [250, 250, 250];
      } else {
        const i = ((y - top) * w + x) * 4;
        v = [content.data[i], content.data[i + 1], content.data[i + 2]];
      }
      const n = y >= top && y < top + content.height ? (rnd() - 0.5) * 2 * noise : 0;
      d[o] = v[0] + n; d[o + 1] = v[1] + n; d[o + 2] = v[2] + n; d[o + 3] = 255;
    }
  }
  return { width: w, height: h, data: d };
}

function bilinear(src: PixelSource, k: number): PixelSource {
  const w = Math.round(src.width * k), h = Math.round(src.height * k);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    const fx = Math.min(src.width - 1, Math.max(0, (x + 0.5) / k - 0.5)), fy = Math.min(src.height - 1, Math.max(0, (y + 0.5) / k - 0.5));
    const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(src.width - 1, x0 + 1), y1 = Math.min(src.height - 1, y0 + 1);
    const ax = fx - x0, ay = fy - y0;
    for (let c = 0; c < 4; c += 1) {
      const p = (xx: number, yy: number) => src.data[(yy * src.width + xx) * 4 + c];
      out[(y * w + x) * 4 + c] = (p(x0, y0) * (1 - ax) + p(x1, y0) * ax) * (1 - ay) + (p(x0, y1) * (1 - ax) + p(x1, y1) * ax) * ay;
    }
  }
  return { width: w, height: h, data: out };
}

const sum = (c: Record<string, number>) => Object.values(c).reduce((a, b) => a + b, 0);

describe.skipIf(!existsSync(SAMPLE))("多张截图拼接（agumon 样张）", () => {
  const full = existsSync(SAMPLE) ? decodePng(readFileSync(SAMPLE)) : null;
  const img = full ? downscaleArea(full, 2400) : null;

  it("2×2 四张重叠约 30% 的截图，打乱顺序，带状态栏和噪点：拼回 ≤2px，识别 156×138 / 11128", () => {
    const src = img!;
    const cw = 1400, ch = 1400;
    const xs = [0, src.width - cw], ys = [0, src.height - ch];
    const truth: Array<{ x: number; y: number }> = [];
    const shots: PixelSource[] = [];
    for (const y of ys) for (const x of xs) { truth.push({ x, y }); shots.push(phoneShot(crop(src, x, y, cw, ch), 70, 90, 4, shots.length + 1)); }
    const order = [2, 0, 3, 1];
    const sh = order.map((i) => shots[i]), tr = order.map((i) => truth[i]);
    const t0 = performance.now();
    const r = stitchScreens(sh);
    const ms = performance.now() - t0;
    // eslint-disable-next-line no-console
    console.log(`[stitch 2x2] ${ms.toFixed(0)} ms, out ${r.image.width}x${r.image.height}, confidence ${r.confidence.toFixed(3)}, crops ${JSON.stringify(r.crops[0])}, warnings ${JSON.stringify(r.warnings)}`);
    expect(r.included.every(Boolean)).toBe(true);
    for (const c of r.crops) { expect(c.top).toBeGreaterThanOrEqual(70); expect(c.bottom).toBeGreaterThanOrEqual(90); expect(c.top).toBeLessThan(200); }
    let worst = 0;
    for (let k = 1; k < sh.length; k += 1) {
      const ex = r.placements[k].x - r.placements[0].x - (tr[k].x - tr[0].x), ey = r.placements[k].y - r.placements[0].y - (tr[k].y - tr[0].y);
      worst = Math.max(worst, Math.abs(ex), Math.abs(ey));
      expect(r.placements[k].scale).toBeCloseTo(1, 6);
    }
    // eslint-disable-next-line no-console
    console.log(`[stitch 2x2] worst placement error ${worst} px`);
    expect(worst).toBeLessThanOrEqual(2);
    expect(r.confidence).toBeGreaterThan(0.85);
    expect(r.image.width).toBe(src.width);
    // 上下的纯色页边会被当作界面一起裁掉，所以允许略矮
    expect(r.image.height).toBeLessThanOrEqual(src.height);
    expect(r.image.height).toBeGreaterThan(src.height - 200);

    // 拼出来的图能被识别流程读成同样的图纸
    const g = detectGrid(r.image);
    expect(g).not.toBeNull();
    expect(g!.cols).toBe(156);
    expect(g!.rows).toBe(138);
    const reading = readGrid(r.image, g!, { legendCodes: LEGEND_CODES });
    expect(sum(reading.counts)).toBe(11128);
    expect(reading.emptyCells).toBe(156 * 138 - 11128);
  }, 180000);

  it("纵向 4 张 1080×2400 手机截图（约 1/4 重叠）：用时与精度", () => {
    const base = downscaleArea(full!, 1080);
    const H = 7300;
    const long = new Uint8ClampedArray(1080 * H * 4);
    for (let y = 0; y < H; y += 1) {
      // 4 种翻转 × 反色，8 段互不相同，避免整段重复造成多解
      const seg = Math.floor(y / base.height), yy = y % base.height;
      const sy = seg % 2 === 1 ? base.height - 1 - yy : yy;
      const inv = seg >= 4;
      for (let x = 0; x < 1080; x += 1) {
        const sx = Math.floor(seg / 2) % 2 === 1 ? 1079 - x : x;
        const si = (sy * 1080 + sx) * 4, di = (y * 1080 + x) * 4;
        for (let c = 0; c < 3; c += 1) long[di + c] = inv ? 255 - base.data[si + c] : base.data[si + c];
        long[di + 3] = 255;
      }
    }
    const tall: PixelSource = { width: 1080, height: H, data: long };
    const tops = [0, 1640, 3280, 4920];
    const shots = tops.map((y, i) => phoneShot(crop(tall, 0, y, 1080, 2180), 100, 120, 3, 10 + i));
    expect(shots[0].height).toBe(2400);
    const order = [1, 3, 0, 2];
    const t0 = performance.now();
    const r = stitchScreens(order.map((i) => shots[i]));
    const ms = performance.now() - t0;
    // eslint-disable-next-line no-console
    console.log(`[stitch 4x1080x2400] ${ms.toFixed(0)} ms, out ${r.image.width}x${r.image.height}, confidence ${r.confidence.toFixed(3)}`);
    expect(r.included.every(Boolean)).toBe(true);
    for (let k = 1; k < 4; k += 1) {
      const ey = r.placements[k].y - r.placements[0].y - (tops[order[k]] - tops[order[0]]);
      expect(Math.abs(ey)).toBeLessThanOrEqual(2);
      expect(Math.abs(r.placements[k].x - r.placements[0].x)).toBeLessThanOrEqual(2);
    }
    expect(r.image.width).toBe(1080);
    expect(r.image.height).toBe(7100);
    expect(ms).toBeLessThan(8000);
  }, 180000);

  it("缩放差异约 3%：自动对齐并给出提示", () => {
    const src = img!;
    const a = phoneShot(crop(src, 0, 0, 1400, 1300), 60, 80, 3, 21);
    // 第二张放大了 3%：取 (1300/1.03) 高的区域再放大
    const hh = Math.round(1300 / 1.03), ww = Math.round(1400 / 1.03);
    const b = phoneShot(bilinear(crop(src, 0, 900, ww, hh), 1.03), 60, 80, 3, 22);
    const r = stitchScreens([a, b]);
    expect(r.included).toEqual([true, true]);
    expect(Math.abs(r.placements[1].scale - 0.97)).toBeLessThan(0.012);
    expect(r.confidence).toBeGreaterThan(0.6);
  }, 180000);

  it("两张没有重叠：给出中文提示，可信度很低，只输出能接上的部分", () => {
    const src = img!;
    const a = phoneShot(crop(src, 0, 0, 1000, 900), 60, 80, 3, 31);
    const b = phoneShot(crop(src, 1300, 1300, 1000, 900), 60, 80, 3, 32);
    const r = stitchScreens([a, b]);
    // eslint-disable-next-line no-console
    console.log(`[stitch no-overlap] confidence ${r.confidence.toFixed(3)} included ${r.included} warnings ${JSON.stringify(r.warnings)}`);
    expect(r.included.filter(Boolean)).toHaveLength(1);
    expect(r.warnings.some((w) => w.includes("没有找到重叠部分") && w.includes("1/4"))).toBe(true);
    expect(r.confidence).toBeLessThan(0.5);
  }, 180000);

  it("单张图：原样返回", () => {
    const r = stitchScreens([img!]);
    expect(r.image).toBe(img);
    expect(r.confidence).toBe(1);
  });
});
