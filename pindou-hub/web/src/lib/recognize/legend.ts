// 图例解析：纯字符串 / 词框处理，不依赖 OCR，便于单测。
import type { Counts, LegendItem, LegendReading, Rect } from "./types";

type Word = { text: string; bbox: { x0: number; y0: number; x1: number; y1: number } };

const CODE = "(ZG|[A-HMPQRTY])(\\d{1,2})";
// 分隔符：括号 冒号 乘号 等号，以及各种中点 / 连字符 / 句点（拼豆工坊导出为“A1 · 154 颗”，OCR 可能读成 - . *）
const SEP = "[(:×X*=·•・∙⋅.\\-–—]";
// 色号 + 必需分隔符（空白或 ( : × x * =）+ 数量（允许 OCR 把 0/1 认成 O/I/l/|，允许千分位逗号）
const INLINE = new RegExp(
  `(?<![A-Z0-9])${CODE}(?![0-9])\\s*(?:${SEP}\\s*|\\s)\\s*([0-9OIL|,]{1,8})(?![0-9])`,
  "g"
);
const CODE_ONLY = new RegExp(`(?<![A-Z0-9])${CODE}(?![0-9A-Z])`, "g");
const TOTAL = /(?:总计|合计|总数|总共|共计|共|TOTAL|SUM)\s*[:：]?\s*([0-9OIL|,]{2,8})(?![0-9OIL|,]|\s*[色种款])/;

export function normalizeText(text: string): string {
  return text.normalize("NFKC").replace(/[​﻿]/g, "").toUpperCase();
}

/** 把 OCR 读到的数字串转成整数；至少含一个真数字，否则视为不是数量。 */
function parseCount(raw: string): number | null {
  if (!/[0-9]/.test(raw)) return null;
  const s = raw.replace(/,/g, "").replace(/[OL]/g, (c) => (c === "O" ? "0" : "1")).replace(/[I|]/g, "1");
  if (!/^\d{1,6}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= 99999 ? n : null;
}

function addItem(map: Map<string, LegendItem>, code: string, count: number, source: string, valid: Set<string>) {
  if (!valid.has(code)) return;
  const prev = map.get(code);
  // 重复出现：取较大值（多个分区/重复列出时，大的更接近总量）
  if (!prev || count > prev.count) map.set(code, { code, count, source });
}

function finish(map: Map<string, LegendItem>, text: string): LegendReading {
  const items = [...map.values()];
  const counts: Counts = {};
  for (const it of items) counts[it.code] = it.count;
  return { items, counts, statedTotal: findStatedTotal(text), rawText: text.slice(0, 2000) };
}

// 拼豆工坊导出图的抬头：“… · 11128 颗豆 · …”
const TOTAL_DOU = /([0-9OIL|,]{2,8})\s*颗\s*(?:拼)?豆/;

export function findStatedTotal(text: string): number | null {
  const norm = normalizeText(text);
  const m = TOTAL.exec(norm) ?? TOTAL_DOU.exec(norm);
  if (!m) return null;
  return parseCount(m[1]);
}

function parseInline(norm: string, valid: Set<string>): Map<string, LegendItem> {
  const map = new Map<string, LegendItem>();
  INLINE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE.exec(norm))) {
    const count = parseCount(m[3]);
    if (count !== null) addItem(map, m[1] + m[2], count, "文字", valid);
  }
  return map;
}

/** 两行对应：上一行只有色号、下一行只有数字（色板式排版被 OCR 成纯文本时）。 */
function parseLinePairs(lines: string[], valid: Set<string>): Map<string, LegendItem> {
  const map = new Map<string, LegendItem>();
  for (let i = 0; i + 1 < lines.length; i += 1) {
    const codes: string[] = [];
    CODE_ONLY.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CODE_ONLY.exec(lines[i]))) if (valid.has(m[1] + m[2])) codes.push(m[1] + m[2]);
    if (!codes.length) continue;
    const rest = lines[i].replace(CODE_ONLY, " ").replace(/[\s,;，、|]/g, "");
    if (rest.length > 0 && /[0-9]/.test(rest)) continue; // 这行已含数字，交给行内策略
    const nums = lines[i + 1]
      .replace(/(颗|粒|个|PCS|PC|×|X|\(|\)|:)/g, " ")
      .split(/\s+/)
      .map((t) => (t ? parseCount(t) : null))
      .filter((v): v is number => v !== null);
    if (nums.length !== codes.length) continue;
    codes.forEach((c, j) => addItem(map, c, nums[j], "文字(两行)", valid));
  }
  return map;
}

export function parseLegendText(text: string, validCodes: Set<string>): LegendReading {
  const norm = normalizeText(text);
  const a = parseInline(norm, validCodes);
  const b = parseLinePairs(norm.split(/\r?\n/), validCodes);
  return finish(b.size > a.size ? b : a, text);
}

// ───────────────────────── 词框（空间配对） ─────────────────────────

function cleanWord(t: string): string {
  return normalizeText(t).replace(/^[\s,.;，。、'"“”‘’]+|[\s,.;，。、'"“”‘’]+$/g, "");
}

const CODE_WORD = /^(ZG|[A-HMPQRTY])(\d{1,2})$/;
const FUSED_WORD = new RegExp(`^${CODE}${SEP}+([0-9OIL|,]{1,8})\\)?(?:颗|粒|个|PCS)?$`);
const NUM_WORD = /^[(×X*=:·•・.\-]*([0-9OIL|,]{1,8})\)?(?:颗|粒|个|PCS|PC)?$/;

type W = { text: string; x0: number; y0: number; x1: number; y1: number; cx: number; cy: number; w: number; h: number };

function inside(w: W, r: Rect) {
  return w.cx >= r.x && w.cx <= r.x + r.width && w.cy >= r.y && w.cy <= r.y + r.height;
}

export function parseLegendWords(
  words: Word[],
  validCodes: Set<string>,
  exclude?: Rect | null
): LegendReading {
  const ws: W[] = [];
  for (const raw of words) {
    const text = cleanWord(raw.text);
    if (!text) continue;
    const { x0, y0, x1, y1 } = raw.bbox;
    const w: W = { text, x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: Math.max(1, y1 - y0) };
    if (exclude && inside(w, exclude)) continue;
    ws.push(w);
  }

  // 按行重建文本（用于总数 / 纯文本策略）
  const sorted = [...ws].sort((a, b) => a.cy - b.cy);
  const lines: W[][] = [];
  for (const w of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last[0].cy - w.cy) < 0.6 * Math.max(w.h, last[0].h)) last.push(w);
    else lines.push([w]);
  }
  const lineTexts = lines.map((l) => l.sort((a, b) => a.x0 - b.x0).map((w) => w.text).join(" "));
  const fullText = lineTexts.join("\n");

  const codeWords = ws.filter((w) => {
    const m = CODE_WORD.exec(w.text);
    return !!m && validCodes.has(m[1] + m[2]);
  });
  const numWords = ws.filter((w) => {
    if (CODE_WORD.test(w.text)) return false;
    const m = NUM_WORD.exec(w.text);
    return !!m && parseCount(m[1]) !== null;
  });

  // 粘连写法 A1(125) / A1:125
  const fused = new Map<string, LegendItem>();
  for (const w of ws) {
    const m = FUSED_WORD.exec(w.text);
    if (m) {
      const c = parseCount(m[3]);
      if (c !== null) addItem(fused, m[1] + m[2], c, "词框(粘连)", validCodes);
    }
  }

  type Pair = { d: number; ci: number; ni: number };
  const pairUp = (kind: "right" | "below"): Map<string, LegendItem> => {
    const cand: Pair[] = [];
    codeWords.forEach((c, ci) => {
      numWords.forEach((n, ni) => {
        const lh = Math.max(c.h, n.h);
        if (kind === "right") {
          const gap = n.x0 - c.x1;
          if (Math.abs(n.cy - c.cy) < 0.6 * lh && gap > -0.5 * lh && gap < 5 * lh) cand.push({ d: Math.abs(gap) + Math.abs(n.cy - c.cy), ci, ni });
        } else {
          const gap = n.y0 - c.y1;
          const overlap = Math.min(n.x1, c.x1) - Math.max(n.x0, c.x0);
          const near = Math.abs(n.cx - c.cx) < 0.75 * Math.max(n.w, c.w);
          if (n.cy > c.cy && gap < 1.6 * lh && gap > -0.5 * lh && overlap > 0 && near) cand.push({ d: Math.abs(gap) * 2 + Math.abs(n.cx - c.cx), ci, ni });
        }
      });
    });
    cand.sort((a, b) => a.d - b.d);
    const usedC = new Set<number>();
    const usedN = new Set<number>();
    const map = new Map<string, LegendItem>();
    for (const p of cand) {
      if (usedC.has(p.ci) || usedN.has(p.ni)) continue;
      usedC.add(p.ci);
      usedN.add(p.ni);
      const nm = NUM_WORD.exec(numWords[p.ni].text);
      const cnt = nm ? parseCount(nm[1]) : null;
      if (cnt !== null) addItem(map, codeWords[p.ci].text, cnt, kind === "right" ? "词框(同行)" : "词框(下方)", validCodes);
    }
    return map;
  };

  const strategies: Array<Map<string, LegendItem>> = [
    pairUp("right"),
    pairUp("below"),
    parseInline(normalizeText(fullText), validCodes),
    parseLinePairs(normalizeText(fullText).split("\n"), validCodes)
  ];
  // 粘连写法与任一策略互补：并入每个策略
  let best = strategies[0];
  for (const s of strategies) {
    for (const [k, v] of fused) addItem(s, k, v.count, v.source, validCodes);
    if (s.size > best.size) best = s;
  }
  return finish(best, fullText);
}

// ───────────────────────── 图例色块（chip）处理 ─────────────────────────
// 不少图纸把“色号 · 数量”直接印在色块上（深色块上是白字）。直接 OCR 会因底色五花八门而漏读，
// 所以先找到平涂色块，把每块里“与底色不同的像素”画成黑字白底，再交给 OCR；
// 色块底色同时就是该色号在图上的真实渲染色，可用来校准格子匹配。

export type Chip = { x: number; y: number; width: number; height: number; r: number; g: number; b: number; /** 调用方自带的标识（格内色号 OCR 用来对应回代表格） */ tag?: number; /** 该块单独的墨迹阈值（相对最大反差），不设则用 chipStack 的默认值 */ inkThr?: number };

type PixelSrc = { width: number; height: number; data: Uint8ClampedArray };

/** 在 src 中找平涂的矩形色块（比周围背景深/浅，长度 ≥ minRun 的水平同色段，纵向相连）。 */
export function findChips(src: PixelSrc, minRun = 40): Chip[] {
  const { width: w, height: h, data: d } = src;
  // 背景：取四边与中心稀疏采样的最常见色
  const bgVotes = new Map<number, number>();
  for (let y = 0; y < h; y += Math.max(1, Math.floor(h / 40))) {
    for (let x = 0; x < w; x += Math.max(1, Math.floor(w / 80))) {
      const i = (y * w + x) * 4;
      const key = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
      bgVotes.set(key, (bgVotes.get(key) ?? 0) + 1);
    }
  }
  let bgKey = 0, bgBest = -1;
  for (const [k, v] of bgVotes) if (v > bgBest) { bgBest = v; bgKey = k; }
  const br = ((bgKey >> 8) << 4) + 8, bg = (((bgKey >> 4) & 15) << 4) + 8, bb = ((bgKey & 15) << 4) + 8;

  type Run = { y: number; x0: number; x1: number; r: number; g: number; b: number; parent: number };
  const runs: Run[] = [];
  let prevRows: number[] = [];
  const find = (i: number): number => { while (runs[i].parent !== i) { runs[i].parent = runs[runs[i].parent].parent; i = runs[i].parent; } return i; };
  for (let y = 0; y < h; y += 1) {
    const cur: number[] = [];
    let x = 0;
    while (x < w) {
      const i0 = (y * w + x) * 4;
      let e = x + 1;
      while (e < w) {
        const i = (y * w + e) * 4;
        if (Math.abs(d[i] - d[i0]) + Math.abs(d[i + 1] - d[i0 + 1]) + Math.abs(d[i + 2] - d[i0 + 2]) > 12) break;
        e += 1;
      }
      if (e - x >= minRun && Math.abs(d[i0] - br) + Math.abs(d[i0 + 1] - bg) + Math.abs(d[i0 + 2] - bb) > 24) {
        const idx = runs.length;
        runs.push({ y, x0: x, x1: e, r: d[i0], g: d[i0 + 1], b: d[i0 + 2], parent: idx });
        cur.push(idx);
        for (const pi of prevRows) {
          const p = runs[pi];
          const ov = Math.min(p.x1, e) - Math.max(p.x0, x);
          if (ov >= 0.5 * Math.min(p.x1 - p.x0, e - x) && Math.abs(p.r - d[i0]) + Math.abs(p.g - d[i0 + 1]) + Math.abs(p.b - d[i0 + 2]) <= 16) {
            runs[find(idx)].parent = find(pi);
          }
        }
      }
      x = e;
    }
    prevRows = cur;
  }
  const comps = new Map<number, { x0: number; y0: number; x1: number; y1: number; best: Run; n: number }>();
  runs.forEach((r, i) => {
    const root = find(i);
    const c = comps.get(root);
    if (!c) comps.set(root, { x0: r.x0, y0: r.y, x1: r.x1, y1: r.y + 1, best: r, n: 1 });
    else {
      c.x0 = Math.min(c.x0, r.x0); c.x1 = Math.max(c.x1, r.x1); c.y1 = Math.max(c.y1, r.y + 1); c.n += 1;
      if (r.x1 - r.x0 > c.best.x1 - c.best.x0) c.best = r;
    }
  });
  // 文字行中断会把同一色块在纵向拆成上下两段：x 范围一致且间隔很小的合并
  const parts = [...comps.values()].filter((c) => c.x1 - c.x0 >= minRun && c.y1 - c.y0 >= 3).sort((a, b) => a.y0 - b.y0);
  const merged: typeof parts = [];
  for (const p of parts) {
    const m = merged.find((q) => Math.abs(q.x0 - p.x0) <= 3 && Math.abs(q.x1 - p.x1) <= 3 && p.y0 - q.y1 <= 0.8 * (q.x1 - q.x0) && Math.abs(q.best.r - p.best.r) + Math.abs(q.best.g - p.best.g) + Math.abs(q.best.b - p.best.b) <= 16);
    if (m) { m.y1 = Math.max(m.y1, p.y1); m.y0 = Math.min(m.y0, p.y0); }
    else merged.push({ ...p });
  }
  return merged
    .filter((c) => c.y1 - c.y0 >= 10 && (c.x1 - c.x0) >= 1.5 * (c.y1 - c.y0))
    .map((c) => ({ x: c.x0, y: c.y0, width: c.x1 - c.x0, height: c.y1 - c.y0, r: c.best.r, g: c.best.g, b: c.best.b }));
}

/** 白底画布，色块内与底色差异明显的像素画成黑色（文字），色块外全白。 */
export function chipInkImage(src: PixelSrc, chips: Chip[]): PixelSrc {
  const { width: w, height: h, data: d } = src;
  const out = new Uint8ClampedArray(w * h * 4).fill(255);
  for (const c of chips) {
    for (let y = c.y; y < Math.min(h, c.y + c.height); y += 1) {
      for (let x = c.x; x < Math.min(w, c.x + c.width); x += 1) {
        const i = (y * w + x) * 4;
        if (Math.abs(d[i] - c.r) + Math.abs(d[i + 1] - c.g) + Math.abs(d[i + 2] - c.b) > 90) { out[i] = 0; out[i + 1] = 0; out[i + 2] = 0; }
      }
    }
  }
  return { width: w, height: h, data: out };
}

export type ChipStack = {
  image: PixelSrc;
  /** 每个色块在叠放图里占的纵向范围 */
  rows: Array<{ chip: Chip; y0: number; y1: number }>;
};

/**
 * 把每个色块里的文字（黑字白底、双线性放大 scale 倍）按阅读顺序竖向叠成一张小图，
 * 一块一行，交给 OCR 的“整块文字”模式：版面规整，比整张图稀疏识别准得多，也快得多。
 */
export function chipStack(src: PixelSrc, chips: Chip[], scale: number, targetGlyphH?: number, inkThr = 0.5): ChipStack {
  const { width: w, data: d } = src;
  const sorted = [...chips].sort((a, b) => (Math.abs(a.y - b.y) > 0.5 * a.height ? a.y - b.y : a.x - b.x));
  const pad = targetGlyphH ? 14 : Math.max(6, Math.round(6 * scale));
  type Piece = { chip: Chip; bx: number; by: number; bw: number; bh: number; ink: Float32Array; s: number };
  const pieces: Piece[] = [];
  for (const c of sorted) {
    // 色块内“墨迹强度”：与底色的差，封顶 255
    const ink = new Float32Array(c.width * c.height);
    let x0 = c.width, x1 = -1, y0 = c.height, y1 = -1;
    // 格内文字笔画细：以本块最大反差的一半为界做陡峭映射，避免放大后笔画糊成一团
    let refDiff = 0;
    if (targetGlyphH) {
      for (let y = 0; y < c.height; y += 1) for (let x = 0; x < c.width; x += 1) {
        const i = ((c.y + y) * w + c.x + x) * 4;
        refDiff = Math.max(refDiff, Math.abs(d[i] - c.r) + Math.abs(d[i + 1] - c.g) + Math.abs(d[i + 2] - c.b));
      }
    }
    for (let y = 0; y < c.height; y += 1) {
      for (let x = 0; x < c.width; x += 1) {
        const i = ((c.y + y) * w + c.x + x) * 4;
        const diff = Math.abs(d[i] - c.r) + Math.abs(d[i + 1] - c.g) + Math.abs(d[i + 2] - c.b);
        const v = targetGlyphH
          ? (refDiff < 60 ? 0 : Math.min(255, Math.max(0, ((diff - (c.inkThr ?? inkThr) * refDiff) / (0.2 * refDiff)) * 128 + 128)))
          : Math.min(255, Math.max(0, (diff - 30) * 1.0));
        ink[y * c.width + x] = v;
        if (v > 120) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
    }
    if (x1 < 0) continue;
    // 行尾的“颗/粒/个”等汉字单位 OCR 常读成粘在数字后的乱码：识别出行尾比数字更高的方块字就抹掉
    {
      const cols: boolean[] = [];
      const top: number[] = [];
      const bot: number[] = [];
      for (let x = x0; x <= x1; x += 1) {
        let t = -1, b = -1;
        for (let y = y0; y <= y1; y += 1) if (ink[y * c.width + x] > 120) { if (t < 0) t = y; b = y; }
        cols.push(t >= 0); top.push(t); bot.push(b);
      }
      const gap = Math.max(3, Math.round(0.3 * (y1 - y0 + 1)));
      const toks: Array<[number, number]> = [];
      let start = -1, last = -1;
      cols.forEach((on, i) => {
        if (!on) return;
        if (start < 0) { start = i; last = i; }
        else if (i - last > gap) { toks.push([start, last]); start = i; }
        last = i;
      });
      if (start >= 0) toks.push([start, last]);
      const heightOf = ([a, b]: [number, number]) => {
        let tp = Infinity, bt = -1;
        for (let i = a; i <= b; i += 1) if (top[i] >= 0) { tp = Math.min(tp, top[i]); bt = Math.max(bt, bot[i]); }
        return bt - tp + 1;
      };
      const big = toks.filter((t) => heightOf(t) >= 0.4 * (y1 - y0 + 1));
      if (big.length >= 3) {
        const lastTok = big[big.length - 1];
        const lh = heightOf(lastTok);
        const others = big.slice(0, -1).map(heightOf);
        if (lh >= 0.9 * (y1 - y0 + 1) && lastTok[1] - lastTok[0] + 1 >= 0.8 * lh && others.some((o) => o <= 0.85 * lh)) {
          for (let y = 0; y < c.height; y += 1) for (let x = x0 + lastTok[0]; x <= x0 + lastTok[1] + 2 && x < c.width; x += 1) ink[y * c.width + x] = 0;
          x1 = x0 + big[big.length - 2][1];
        }
      }
    }
    const bwi = Math.min(c.width, x1 + 3) - Math.max(0, x0 - 2);
    const bhi = Math.min(c.height, y1 + 3) - Math.max(0, y0 - 2);
    // 指定字高时按每块文字实际高度单独放大（格内色号：字高 ≈ 28–32px 最利于识别）
    const sp = targetGlyphH ? Math.min(8, Math.max(1, targetGlyphH / Math.max(1, y1 - y0 + 1))) : scale;
    pieces.push({ chip: c, bx: Math.max(0, x0 - 2), by: Math.max(0, y0 - 2), bw: bwi, bh: bhi, ink, s: sp });
  }
  const outW = Math.ceil(Math.max(1, ...pieces.map((p) => p.bw * p.s))) + pad * 2;
  const outH = pieces.reduce((s, p) => s + Math.ceil(p.bh * p.s) + pad * 2, 0);
  const out = new Uint8ClampedArray(outW * outH * 4).fill(255);
  const rows: ChipStack["rows"] = [];
  let oy = 0;
  for (const p of pieces) {
    const scale = p.s;
    const hh = Math.ceil(p.bh * scale);
    const ww = Math.ceil(p.bw * scale);
    for (let y = 0; y < hh; y += 1) {
      const sy = Math.min(p.bh - 1, y / scale - 0.5 / scale);
      const fy0 = Math.max(0, Math.floor(sy)), fy1 = Math.min(p.bh - 1, fy0 + 1), ty = Math.max(0, sy - fy0);
      for (let x = 0; x < ww; x += 1) {
        const sx = Math.min(p.bw - 1, x / scale - 0.5 / scale);
        const fx0 = Math.max(0, Math.floor(sx)), fx1 = Math.min(p.bw - 1, fx0 + 1), tx = Math.max(0, sx - fx0);
        const at = (xx: number, yy: number) => p.ink[(p.by + yy) * p.chip.width + p.bx + xx];
        const v = (at(fx0, fy0) * (1 - tx) + at(fx1, fy0) * tx) * (1 - ty) + (at(fx0, fy1) * (1 - tx) + at(fx1, fy1) * tx) * ty;
        const o = ((oy + pad + y) * outW + pad + x) * 4;
        const g = 255 - Math.min(255, v);
        out[o] = g; out[o + 1] = g; out[o + 2] = g;
      }
    }
    rows.push({ chip: p.chip, y0: oy, y1: oy + hh + pad * 2 });
    oy += hh + pad * 2;
  }
  return { image: { width: outW, height: outH, data: out }, rows };
}

// ───────────────────────── 色块文字解析（带 OCR 混淆纠正 + 色卡配色验证） ─────────────────────────

const SERIES_FIX: Record<string, string[]> = { "6": ["G"], "8": ["B"], "0": ["D"], "5": ["S"] };
const DIGIT_FIX: Record<string, string[]> = {
  L: ["1"], I: ["1"], "|": ["1"], O: ["0"], S: ["5"], B: ["8"], Z: ["2"], G: ["6"], T: ["7", "1"], Q: ["0"], D: ["0"],
  g: ["9", "8"], r: ["7"], o: ["0", "6"], q: ["9"], l: ["1"], i: ["1"]
};

function codeCandidates(token: string, valid: Set<string>): string[] {
  const t = token.normalize("NFKC").replace(/[^0-9A-Za-z|]/g, "");
  if (t.length < 2 || t.length > 4) return [];
  const out = new Set<string>();
  const seriesOpts = (c: string): string[] => {
    const up = c.toUpperCase();
    return [up, ...(SERIES_FIX[c] ?? [])];
  };
  const digitOpts = (c: string): string[] => (/[0-9]/.test(c) ? [c] : DIGIT_FIX[c] ?? DIGIT_FIX[c.toUpperCase()] ?? []);
  const tryBuild = (series: string, rest: string) => {
    let combos: string[] = [""];
    for (const ch of rest) {
      const opts = digitOpts(ch);
      if (!opts.length) return;
      combos = combos.flatMap((c) => opts.map((o) => c + o));
    }
    for (const c of combos) if (valid.has(series + c)) out.add(series + c);
  };
  // 系列字母：1 位（A-H,M,P,Q,R,T,Y）或 2 位 ZG
  for (const s1 of seriesOpts(t[0])) tryBuild(s1, t.slice(1));
  if (t.length >= 3) for (const s1 of seriesOpts(t[0])) for (const s2 of seriesOpts(t[1])) if (s1 + s2 === "ZG") tryBuild("ZG", t.slice(2));
  if (!out.size && t.length >= 3) {
    // 多读了一个字符（如 Filo → F10、AZ21 → A21）：逐个删掉再试；删字母（多半是杂质）优先于删数字
    const byCost: string[][] = [[], []];
    for (let i = 1; i < t.length; i += 1) {
      const cost = /[0-9]/.test(t[i]) ? 1 : 0;
      for (const c of codeCandidates(t.slice(0, i) + t.slice(i + 1), valid)) if (!byCost[cost].includes(c)) byCost[cost].push(c);
    }
    for (const c of [...byCost[0], ...byCost[1]]) out.add(c);
  }
  return [...out];
}

function parseCountToken(token: string): number | null {
  const t = token.normalize("NFKC").toUpperCase().replace(/,/g, "");
  if (!/[0-9]/.test(t) || !/^[0-9OILSBZ|]{1,6}$/.test(t)) return null;
  const s = t.replace(/[OQD]/g, "0").replace(/[IL|]/g, "1").replace(/S/g, "5").replace(/B/g, "8").replace(/Z/g, "2");
  const n = Number(s);
  return n >= 1 && n <= 99999 ? n : null;
}

/**
 * 每个色块一行文字（形如“A13 · 84 颗”）：先取最后一个像数字的词作为数量，再把前面的词当色号。
 * 色号带 OCR 混淆（l/I→1、O→0 …）展开成候选，用色块实际颜色与色卡色的 ΔE 选最像的。
 */
export function parseChipTexts(
  rows: Array<{ text: string; chip: Chip }>,
  valid: Set<string>,
  colorOf: (code: string) => { r: number; g: number; b: number } | null
): LegendReading & { colors: Record<string, { r: number; g: number; b: number }> } {
  const map = new Map<string, LegendItem>();
  const colors: Record<string, { r: number; g: number; b: number }> = {};
  let raw = "";
  for (const { text, chip } of rows) {
    raw += text + "\n";
    const tokens = text.split(/[\s·•・∙⋅.\-–—:：()（）×*=]+/).filter(Boolean);
    let ci = -1;
    let count: number | null = null;
    for (let i = tokens.length - 1; i >= 0; i -= 1) {
      const c = parseCountToken(tokens[i]);
      if (c !== null) { count = c; ci = i; break; }
    }
    if (count === null) continue;
    let cands: string[] = [];
    for (let j = 0; j < ci && !cands.length; j += 1) cands = codeCandidates(tokens[j], valid);
    let guessed = false;
    if (!cands.length) {
      // 文字没读出色号：用色块颜色找最接近（且很接近）的色卡色号
      let bd = 14, bc = "";
      for (const code of valid) {
        const pc = colorOf(code);
        if (!pc || map.has(code)) continue;
        const d = Math.hypot(pc.r - chip.r, pc.g - chip.g, pc.b - chip.b);
        if (d < bd) { bd = d; bc = code; }
      }
      if (!bc) continue;
      cands = [bc];
      guessed = true;
    }
    let best = cands[0];
    if (cands.length > 1) {
      let bd = Infinity;
      for (const c of cands) {
        const pc = colorOf(c);
        if (!pc) continue;
        const d = Math.hypot(pc.r - chip.r, pc.g - chip.g, pc.b - chip.b);
        if (d < bd) { bd = d; best = c; }
      }
    }
    const prev = map.get(best);
    if (!prev || count > prev.count) map.set(best, { code: best, count, source: guessed ? "色块颜色+数量" : "色块文字" });
    colors[best] = { r: chip.r, g: chip.g, b: chip.b };
  }
  const items = [...map.values()];
  const counts: Counts = {};
  for (const it of items) counts[it.code] = it.count;
  return { items, counts, statedTotal: null, rawText: raw.slice(0, 2000), colors };
}

/** 格内文字（一个格子 OCR 出来的一小段）→ 可能的 MARD 色号（含 OCR 混淆展开）。 */
export function cellCodeCandidates(text: string, valid: Set<string>): string[] {
  const out: string[] = [];
  const norm = text.normalize("NFKC");
  for (const tok of norm.split(/[^0-9A-Za-z|]+/).filter(Boolean)) {
    for (const c of codeCandidates(tok, valid)) if (!out.includes(c)) out.push(c);
  }
  return out; // 已按“修改代价”从小到大排序
}
