// 合成图纸构造器（测试用）：非整数格距、网格线/粗线、文字块、标题/图例带、噪点。
import { MARD_PALETTE } from "@engine/palette";
import { deflateSync, inflateSync } from "node:zlib";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PixelSource } from "@engine/types";

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const TEST_CODES = ["A4", "B5", "C7", "D20", "E3", "F5", "G7", "H7"];

export type ChartOpts = {
  cols: number;
  rows: number;
  pitch: number;
  lineWidth?: number; // 0 = 无网格线
  boldEvery?: number;
  margin?: { left: number; top: number; right: number; bottom: number };
  codes?: string[];
  offset?: number; // 渲染色相对色卡的每色偏移 ±
  emptyFrac?: number;
  textBlobs?: boolean;
  noise?: number; // 每通道 ±noise 的随机噪点
  solidBorder?: boolean; // 外圈格子全不为空（无线图纸需要）
  titleBand?: boolean;
  legendBand?: boolean;
  seed?: number;
  /** 空格画成浅灰 / 白的棋盘格（半格大小的方块，我嘞个豆等软件的画法） */
  checker?: boolean;
  /** 网格线颜色灰度（默认细线 160）；很浅（如 244）时只有彩色块之间才有强边缘 */
  lineColor?: number;
  /** 只有这个格子范围内才有豆子，其余全是空格（用来模拟“图形只占图纸一角”） */
  beadRect?: { c0: number; r0: number; c1: number; r1: number };
};

export type Chart = {
  src: PixelSource;
  matrix: Array<Array<string | null>>;
  counts: Record<string, number>;
  x0: number;
  y0: number;
  gridWidth: number;
  gridHeight: number;
  /** 每个色号实际渲染的 RGB（相对色卡有偏差） */
  render: Record<string, [number, number, number]>;
};

export function buildChart(o: ChartOpts): Chart {
  const rnd = mulberry32(o.seed ?? 1);
  const m = o.margin ?? { left: 40, top: 60, right: 40, bottom: 80 };
  const lw = o.lineWidth ?? 1;
  const codes = o.codes ?? TEST_CODES;
  const off = o.offset ?? 6;
  const gw = Math.round(o.cols * o.pitch);
  const gh = Math.round(o.rows * o.pitch);
  const width = m.left + gw + m.right;
  const height = m.top + gh + m.bottom;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  const fill = (x0: number, y0: number, x1: number, y1: number, r: number, g: number, b: number) => {
    for (let y = Math.max(0, y0); y < Math.min(height, y1); y += 1) {
      for (let x = Math.max(0, x0); x < Math.min(width, x1); x += 1) {
        const i = (y * width + x) * 4;
        data[i] = r; data[i + 1] = g; data[i + 2] = b;
      }
    }
  };
  // 每个色号的渲染色 = 色卡色 + 固定小偏移
  const render: Record<string, [number, number, number]> = {};
  for (const code of codes) {
    const p = MARD_PALETTE.find((c) => c.code === code)!;
    const j = () => Math.round((rnd() * 2 - 1) * off);
    render[code] = [p.rgb.r + j(), p.rgb.g + j(), p.rgb.b + j()].map((v) => Math.max(0, Math.min(255, v))) as [number, number, number];
  }
  const matrix: Array<Array<string | null>> = [];
  const counts: Record<string, number> = {};
  const x0 = m.left;
  const y0 = m.top;
  for (let cy = 0; cy < o.rows; cy += 1) {
    const row: Array<string | null> = [];
    for (let cx = 0; cx < o.cols; cx += 1) {
      const border = cx === 0 || cy === 0 || cx === o.cols - 1 || cy === o.rows - 1;
      const outside = !!o.beadRect && (cx < o.beadRect.c0 || cx > o.beadRect.c1 || cy < o.beadRect.r0 || cy > o.beadRect.r1);
      const empty = outside || (!(o.solidBorder && border) && rnd() < (o.emptyFrac ?? 0.1));
      const code = empty ? null : codes[Math.floor(rnd() * codes.length)];
      row.push(code);
      if (code) counts[code] = (counts[code] ?? 0) + 1;
      const xa = x0 + Math.round(cx * o.pitch), xb = x0 + Math.round((cx + 1) * o.pitch);
      const ya = y0 + Math.round(cy * o.pitch), yb = y0 + Math.round((cy + 1) * o.pitch);
      if (!code && o.checker) {
        const half = o.pitch / 2;
        for (let y = ya; y < yb; y += 1) for (let x = xa; x < xb; x += 1) {
          const v = (Math.floor((x - x0) / half) + Math.floor((y - y0) / half)) % 2 === 0 ? 255 : 226;
          fill(x, y, x + 1, y + 1, v, v, v);
        }
      }
      if (code) {
        const [r, g, b] = render[code];
        fill(xa, ya, xb, yb, r, g, b);
        if (o.textBlobs && rnd() < 0.6) {
          const cxm = Math.round((xa + xb) / 2), cym = Math.round((ya + yb) / 2);
          fill(cxm - 2, cym - 2, cxm + 1, cym + 2, 40, 40, 40);
        }
      }
    }
    matrix.push(row);
  }
  if (lw > 0) {
    for (let k = 0; k <= o.cols; k += 1) {
      const bold = o.boldEvery && k % o.boldEvery === 0;
      const w = bold ? lw + 1 : lw;
      const c = bold ? 70 : (o.lineColor ?? 160);
      const x = x0 + Math.round(k * o.pitch - w / 2);
      fill(x, y0, x + w, y0 + gh, c, c, c);
    }
    for (let k = 0; k <= o.rows; k += 1) {
      const bold = o.boldEvery && k % o.boldEvery === 0;
      const w = bold ? lw + 1 : lw;
      const c = bold ? 70 : (o.lineColor ?? 160);
      const y = y0 + Math.round(k * o.pitch - w / 2);
      fill(x0, y, x0 + gw, y + w, c, c, c);
    }
  }
  // 标题带 / 图例带：随机深色小块模拟文字，彩色块模拟色板
  if (o.titleBand !== false) {
    for (let x = 12; x < width - 60; x += 6 + Math.floor(rnd() * 14)) {
      fill(x, 14, x + 2 + Math.floor(rnd() * 5), 14 + 8 + Math.floor(rnd() * 8), 30, 30, 30);
    }
  }
  if (o.legendBand !== false) {
    let x = 14;
    for (const code of codes) {
      const [r, g, b] = render[code];
      fill(x, y0 + gh + 14, x + 16, y0 + gh + 30, r, g, b);
      fill(x, y0 + gh + 36, x + 14, y0 + gh + 44, 30, 30, 30);
      x += 34;
    }
  }
  if (o.noise) {
    const n = o.noise;
    for (let i = 0; i < data.length; i += 4) {
      for (let c = 0; c < 3; c += 1) {
        data[i + c] = Math.max(0, Math.min(255, data[i + c] + Math.round((rnd() * 2 - 1) * n)));
      }
    }
  }
  return { src: { width, height, data }, matrix, counts, x0, y0, gridWidth: gw, gridHeight: gh, render };
}

/** 在 buildChart 的结果上按自定义矩阵重画每个格子的内部（保留网格线）：code → 色卡色，null → 空白（白 / 棋盘格）。 */
export function repaintCells(chart: Chart, pitch: number, cell: (cx: number, cy: number) => string | null, empty: "white" | "checker" = "white", cols = chart.matrix[0].length, rows = chart.matrix.length) {
  const { data, width } = chart.src;
  for (let cy = 0; cy < rows; cy += 1) {
    for (let cx = 0; cx < cols; cx += 1) {
      const code = cell(cx, cy);
      const xa = chart.x0 + Math.round(cx * pitch) + 2, xb = chart.x0 + Math.round((cx + 1) * pitch) - 1;
      const ya = chart.y0 + Math.round(cy * pitch) + 2, yb = chart.y0 + Math.round((cy + 1) * pitch) - 1;
      const rgb = code ? (code === "WHITE" ? { r: 255, g: 255, b: 255 } : MARD_PALETTE.find((c) => c.code === code)!.rgb) : null;
      for (let y = ya; y < yb; y += 1) for (let x = xa; x < xb; x += 1) {
        const i = (y * width + x) * 4;
        let r: number, g: number, b: number;
        if (rgb) { r = rgb.r; g = rgb.g; b = rgb.b; }
        else if (empty === "checker") { const v = (Math.floor((x - chart.x0) / (pitch / 2)) + Math.floor((y - chart.y0) / (pitch / 2))) % 2 === 0 ? 255 : 226; r = g = b = v; }
        else { r = g = b = 255; }
        data[i] = r; data[i + 1] = g; data[i + 2] = b;
      }
    }
  }
}

export function gradientImage(w: number, h: number): PixelSource {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      data[i] = Math.round((x / w) * 255);
      data[i + 1] = Math.round((y / h) * 255);
      data[i + 2] = 128;
      data[i + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

/** 最小 PNG 解码：8 位 RGB / RGBA、非隔行（够读样张）。返回 RGBA。 */
export function decodePng(buf: Uint8Array): PixelSource {
  const b = Buffer.from(buf);
  let pos = 8;
  let w = 0, h = 0, depth = 0, ctype = 0, interlace = 0;
  const idat: Buffer[] = [];
  while (pos < b.length) {
    const len = b.readUInt32BE(pos);
    const type = b.toString("latin1", pos + 4, pos + 8);
    const body = b.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      w = body.readUInt32BE(0); h = body.readUInt32BE(4); depth = body[8]; ctype = body[9]; interlace = body[12];
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (depth !== 8 || interlace !== 0 || (ctype !== 2 && ctype !== 6)) {
    throw new Error(`unsupported PNG: depth=${depth} colorType=${ctype} interlace=${interlace}`);
  }
  const bpp = ctype === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = new Uint8ClampedArray(w * h * 4);
  let prev = new Uint8Array(stride);
  let cur = new Uint8Array(stride);
  for (let y = 0; y < h; y += 1) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i += 1) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const up = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (f === 1) v += a;
      else if (f === 2) v += up;
      else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) {
        const p = a + up - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
      }
      cur[i] = v & 255;
    }
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      out[o] = cur[x * bpp]; out[o + 1] = cur[x * bpp + 1]; out[o + 2] = cur[x * bpp + 2];
      out[o + 3] = bpp === 4 ? cur[x * bpp + 3] : 255;
    }
    const t = prev; prev = cur; cur = t;
  }
  return { width: w, height: h, data: out };
}

/** 面积平均缩小到最长边 ≤ maxSide（近似浏览器 drawImage 的高质量缩放）。 */
export function downscaleArea(src: PixelSource, maxSide: number): PixelSource {
  const k = Math.max(src.width, src.height) / maxSide;
  if (k <= 1) return src;
  const w = Math.round(src.width / k), h = Math.round(src.height / k);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    const ya = y * k, yb = (y + 1) * k;
    for (let x = 0; x < w; x += 1) {
      const xa = x * k, xb = (x + 1) * k;
      let r = 0, g = 0, bl = 0, wt = 0;
      for (let sy = Math.floor(ya); sy < Math.min(src.height, Math.ceil(yb)); sy += 1) {
        const wy = Math.min(sy + 1, yb) - Math.max(sy, ya);
        for (let sx = Math.floor(xa); sx < Math.min(src.width, Math.ceil(xb)); sx += 1) {
          const wx = Math.min(sx + 1, xb) - Math.max(sx, xa);
          const i = (sy * src.width + sx) * 4;
          const ww = wx * wy;
          r += src.data[i] * ww; g += src.data[i + 1] * ww; bl += src.data[i + 2] * ww; wt += ww;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = r / wt; out[o + 1] = g / wt; out[o + 2] = bl / wt; out[o + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

// ───────────── node 下的 OCR 后端（tesseract.js + 本地语言包），仅测试使用 ─────────────

function crc32(buf: Uint8Array): number {
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n += 1) {
    let c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function encodePng(img: PixelSource): Buffer {
  const { width: w, height: h, data } = img;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y += 1) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(data.buffer, data.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const chunk = (type: string, body: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
    const td = Buffer.concat([Buffer.from(type), body]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

function upscaleBilinear(src: PixelSource, s: number): PixelSource {
  if (s === 1) return src;
  const W = Math.round(src.width * s), H = Math.round(src.height * s);
  const o = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y += 1) {
    const sy = Math.min(src.height - 1, (y + 0.5) / s - 0.5), y0 = Math.max(0, Math.floor(sy)), y1 = Math.min(src.height - 1, y0 + 1), ty = Math.max(0, sy - y0);
    for (let x = 0; x < W; x += 1) {
      const sx = Math.min(src.width - 1, (x + 0.5) / s - 0.5), x0 = Math.max(0, Math.floor(sx)), x1 = Math.min(src.width - 1, x0 + 1), tx = Math.max(0, sx - x0);
      for (let c = 0; c < 3; c += 1) {
        const g = (xx: number, yy: number) => src.data[(yy * src.width + xx) * 4 + c];
        o[(y * W + x) * 4 + c] = (g(x0, y0) * (1 - tx) + g(x1, y0) * tx) * (1 - ty) + (g(x0, y1) * (1 - tx) + g(x1, y1) * tx) * ty;
      }
      o[(y * W + x) * 4 + 3] = 255;
    }
  }
  return { width: W, height: H, data: o };
}

/** 供 setOcrBackend 使用：node 里直接跑 tesseract.js（语言包取 web/public/ocr）。 */
export function createNodeOcrBackend() {
  // 小型 worker 池（默认 2 个）：互相独立的识别可以并发；每个 worker 记住自己上次设置的参数，避免重复 setParameters
  type W = { w: Promise<any> | null; busy: boolean; key: string }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const POOL = Math.max(1, Number(process.env.PH_OCR_POOL ?? 2) || 2);
  const slots: W[] = Array.from({ length: POOL }, () => ({ w: null, busy: false, key: "" }));
  const waiters: Array<() => void> = [];
  const acquire = async (): Promise<W> => {
    for (;;) {
      const free = slots.find((x) => !x.busy);
      if (free) { free.busy = true; return free; }
      await new Promise<void>((res) => waiters.push(res));
    }
  };
  const release = (x: W) => { x.busy = false; waiters.shift()?.(); };
  const log: Array<{ w: number; h: number; psm: string; ms: number }> = [];
  return {
    log,
    async recognize(input: PixelSource | { width: number; height: number }, _signal: AbortSignal | undefined, opts: { scale?: number; psm?: string; whitelist?: string }) {
      const source = input as PixelSource; // node 下只会传 PixelSource（没有 canvas）
      const scale = opts.scale ?? 1;
      const img = upscaleBilinear(source, scale);
      // tesseract 对极端长宽比 / 过大图会在 worker 线程里抛未捕获错误，直接拒绝
      if (img.width < 4 || img.height < 4 || img.width > 12000 || img.height > 30000 || img.height / img.width > 120) throw new Error(`图像尺寸不适合识别 ${img.width}x${img.height}`);
      const slot = await acquire();
      try {
        if (!slot.w) {
          slot.w = (async () => {
            const mod = await import("tesseract.js");
            const langPath = fileURLToPath(new URL("../../public/ocr/", import.meta.url));
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return (mod as any).createWorker("eng", 1, { langPath, gzip: true, cachePath: mkdtempSync(join(tmpdir(), "ph-ocr-")), logger: () => {}, errorHandler: () => {} });
          })();
        }
        const worker = await slot.w;
        if (process.env.PH_OCR_TRACE) console.log(`OCR ${img.width}x${img.height} psm=${opts.psm ?? "11"} wl=${!!opts.whitelist}`);
        const t0 = performance.now();
        const key = `${opts.psm ?? "11"}|${opts.whitelist ?? ""}`;
        if (key !== slot.key) { await worker.setParameters({ tessedit_pageseg_mode: opts.psm ?? "11", user_defined_dpi: "300", tessedit_char_whitelist: opts.whitelist ?? "" }); slot.key = key; }
        const png = encodePng(img);
        const t2 = performance.now();
        const res = await worker.recognize(png, {}, { blocks: true, text: true });
        log.push({ w: img.width, h: img.height, psm: opts.psm ?? "11", ms: Math.round(performance.now() - t0) });
        if (process.env.PH_OCR_TRACE) console.log(`OCR done ${img.width}x${img.height} rec=${Math.round(performance.now() - t2)}`);
        const words: Array<{ text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number } }> = [];
        for (const b of res.data.blocks ?? []) for (const p of b.paragraphs) for (const l of p.lines) for (const wd of l.words) {
          words.push({ text: wd.text, confidence: wd.confidence, bbox: { x0: wd.bbox.x0 / scale, y0: wd.bbox.y0 / scale, x1: wd.bbox.x1 / scale, y1: wd.bbox.y1 / scale } });
        }
        return { text: String(res.data.text ?? ""), words };
      } finally { release(slot); }
    },
    async terminate() {
      for (const x of slots) { if (x.w) { const p = x.w; x.w = null; x.key = ""; try { await (await p).terminate(); } catch { /* 忽略 */ } } }
    }
  };
}

/** 逐通道线性漂移 v*gain+offset（模拟别的软件 / 旧色卡 / 偏色截图），写入新的像素缓冲。 */
export function driftColors(src: PixelSource, gain: [number, number, number], offset: [number, number, number]): PixelSource {
  const o = new Uint8ClampedArray(src.data);
  for (let i = 0; i < o.length; i += 4) for (let c = 0; c < 3; c += 1) o[i + c] = o[i + c] * gain[c] + offset[c];
  return { width: src.width, height: src.height, data: o };
}

/** 平滑插画：渐变底 + 几个带柔和边缘的色块，没有周期结构（用来测“不是图纸”）。 */
export function illustrationImage(w: number, h: number): PixelSource {
  const data = new Uint8ClampedArray(w * h * 4);
  const discs = [[0.3, 0.4, 0.22, [230, 120, 120]], [0.65, 0.45, 0.18, [90, 140, 220]], [0.5, 0.75, 0.15, [240, 210, 90]]] as const;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      let r = 235 - (y / h) * 30, g = 238 - (x / w) * 20, b = 245;
      for (const [cx, cy, rad, col] of discs) {
        const d = Math.hypot(x / w - cx, (y / h - cy) * (h / w)) / rad;
        const t = Math.max(0, Math.min(1, (1.0 - d) * 6)); // 边缘 ~1/6 半径宽的柔和过渡
        r = r * (1 - t) + col[0] * t; g = g * (1 - t) + col[1] * t; b = b * (1 - t) + col[2] * t;
      }
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

// ───────────── 带标尺（坐标数字带）的合成图纸 ─────────────

const FONT_3X5: Record<string, string> = {
  "0": "111101101101111", "1": "010110010010111", "2": "111001111100111", "3": "111001111001111", "4": "101101111001001",
  "5": "111100111001111", "6": "111100111101111", "7": "111001001001001", "8": "111101111101111", "9": "111101111001111"
};

export type RulerChartOpts = ChartOpts & {
  /** blue：蓝紫色底白字；white：白（浅灰）底深色字 */
  ruler: "blue" | "white";
  /** 下 / 右标尺从大数往小数（比奇堡居民那类）；上 / 左仍从 1 开始 */
  reversed?: boolean;
};

/** 画一个数字串（3x5 点阵放大 sc 倍），居中于 (cx, cy)。 */
function drawNumber(data: Uint8ClampedArray, width: number, height: number, text: string, cx: number, cy: number, sc: number, rgb: [number, number, number]) {
  const w = text.length * 4 * sc - sc;
  let x = Math.round(cx - w / 2);
  const y = Math.round(cy - (5 * sc) / 2);
  for (const ch of text) {
    const bits = FONT_3X5[ch];
    for (let i = 0; i < 15; i += 1) {
      if (bits[i] !== "1") continue;
      const px = x + (i % 3) * sc, py = y + Math.floor(i / 3) * sc;
      for (let yy = 0; yy < sc; yy += 1) for (let xx = 0; xx < sc; xx += 1) {
        const X = px + xx, Y = py + yy;
        if (X < 0 || Y < 0 || X >= width || Y >= height) continue;
        const k = (Y * width + X) * 4;
        data[k] = rgb[0]; data[k + 1] = rgb[1]; data[k + 2] = rgb[2];
      }
    }
    x += 4 * sc;
  }
}

/** 在 buildChart 的图纸四周各加一圈整格宽的标尺（带网格线、格内数字），返回的 matrix / counts / cols / rows 仍是“不含标尺”的真值。 */
export function buildRulerChart(o: RulerChartOpts): Chart {
  const pitch = o.pitch;
  const pad = Math.ceil(pitch) + 12;
  const base = buildChart({ ...o, titleBand: o.titleBand ?? false, legendBand: o.legendBand ?? false, margin: { left: pad, top: pad + 40, right: pad, bottom: pad + 70 } });
  const { width, height, data } = base.src;
  const fill = (x0: number, y0: number, x1: number, y1: number, rgb: [number, number, number]) => {
    for (let y = Math.max(0, Math.round(y0)); y < Math.min(height, Math.round(y1)); y += 1) {
      for (let x = Math.max(0, Math.round(x0)); x < Math.min(width, Math.round(x1)); x += 1) {
        const i = (y * width + x) * 4;
        data[i] = rgb[0]; data[i + 1] = rgb[1]; data[i + 2] = rgb[2];
      }
    }
  };
  const bg: [number, number, number] = o.ruler === "blue" ? [133, 140, 209] : [244, 244, 244];
  const fg: [number, number, number] = o.ruler === "blue" ? [255, 255, 255] : [70, 70, 70];
  const line: [number, number, number] = o.ruler === "blue" ? [60, 66, 140] : [160, 160, 160];
  const { x0, y0, gridWidth: gw, gridHeight: gh } = base;
  const sc = pitch >= 26 ? 2 : 1;
  const num = (k: number, n: number, down: boolean) => String(down ? n - k : k + 1);
  // 上 / 下标尺（整行，含四个角）
  for (const side of ["t", "b"] as const) {
    const ya = side === "t" ? y0 - pitch : y0 + gh;
    fill(x0 - pitch, ya, x0 + gw + pitch, ya + pitch, bg);
    for (let k = 0; k < o.cols; k += 1) {
      const cx = x0 + (k + 0.5) * pitch;
      drawNumber(data, width, height, num(k, o.cols, side === "b" && !!o.reversed), cx, ya + pitch / 2, sc, fg);
    }
    for (let k = -1; k <= o.cols + 1; k += 1) fill(x0 + k * pitch, ya, x0 + k * pitch + 1, ya + pitch, line);
    fill(x0 - pitch, ya, x0 + gw + pitch, ya + 1, line);
    fill(x0 - pitch, ya + pitch - 1, x0 + gw + pitch, ya + pitch, line);
  }
  for (const side of ["l", "r"] as const) {
    const xa = side === "l" ? x0 - pitch : x0 + gw;
    fill(xa, y0, xa + pitch, y0 + gh, bg);
    for (let k = 0; k < o.rows; k += 1) {
      const cy = y0 + (k + 0.5) * pitch;
      drawNumber(data, width, height, num(k, o.rows, side === "r" && !!o.reversed), xa + pitch / 2, cy, sc, fg);
    }
    for (let k = 0; k <= o.rows; k += 1) fill(xa, y0 + k * pitch, xa + pitch, y0 + k * pitch + 1, line);
    fill(xa, y0, xa + 1, y0 + gh, line);
    fill(xa + pitch - 1, y0, xa + pitch, y0 + gh, line);
  }
  return base;
}
