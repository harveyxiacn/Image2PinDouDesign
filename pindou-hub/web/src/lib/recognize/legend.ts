// 图例解析：纯字符串 / 词框处理，不依赖 OCR，便于单测。
import { ciede2000, rgbToLab } from "@engine/color";
import type { Counts, LegendItem, LegendReading, Rect } from "./types";

type Word = { text: string; bbox: { x0: number; y0: number; x1: number; y1: number } };

const CODE = "(ZG|[A-HMPQRTY])(\\d{1,3})";
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

/** 去掉数字部分的前导零：H07→H7、B08→B8（部分软件导出“零填充”色号）；ZG01→ZG1。非色号形式原样大写返回。 */
export function normalizeCode(code: string): string {
  const m = /^(ZG|[A-Z]{1,2})0*(\d+)$/i.exec(code.trim());
  return m ? `${m[1].toUpperCase()}${Number(m[2])}` : code.trim().toUpperCase();
}

export type HeaderInfo = { cols: number | null; rows: number | null; colors: number | null; total: number | null };

/**
 * 抬头文字（如“尺寸:55x61 · mard · 9 色 · 1806 颗”、“156 × 138 格 · MARD 32 色 · 11128 颗豆”、“总计 7024 颗 | 规格 116×88”）。
 * 英文识别模型读不出汉字，所以除汉字关键词外也有“只看数字顺序”的后备：尺寸之后第一个小数字是色数，最大的整数是总数。
 */
export function parseHeaderText(text: string): HeaderInfo {
  const out: HeaderInfo = { cols: null, rows: null, colors: null, total: null };
  const t = text.normalize("NFKC").replace(/[Oo](?=\d)|(?<=\d)[Oo]/g, "0");
  const num = (s: string) => Number(s.replace(/[,，\s]/g, ""));
  const size = /(?:尺寸|规格|SIZE)\s*[:：]?\s*(\d{1,3})\s*[xX×*]\s*(\d{1,3})/i.exec(t) ?? /(?<![\d.])(\d{2,3})\s*[xX×*]\s*(\d{2,3})(?![\d])/.exec(t);
  let rest = t;
  if (size) {
    const c = Number(size[1]), r = Number(size[2]);
    if (c >= 5 && c <= 400 && r >= 5 && r <= 400) { out.cols = c; out.rows = r; }
    rest = t.slice((size.index ?? 0) + size[0].length);
  }
  const tot = /(?:总用豆数|总豆数|总计|合计|共计|总数|总共|TOTAL)[^0-9]{0,8}(\d[\d,，]{1,8})/i.exec(t) ?? /(\d[\d,，]{2,8})\s*(?:颗|粒)\s*(?:拼)?豆?/.exec(t);
  if (tot) out.total = num(tot[1]);
  const col = /(?:总色卡数|色卡数)[^0-9]{0,4}(\d{1,3})/.exec(t) ?? /(\d{1,3})\s*色/.exec(t);
  if (col) out.colors = num(col[1]);
  if (size && (out.colors === null || out.total === null)) {
    // 后备：尺寸之后的整数序列（含千分位）
    const ints = [...rest.matchAll(/(?<![\d.])(\d{1,3}(?:[,，]\d{3})+|\d+)(?![\d.])/g)].map((m) => num(m[1]));
    if (out.colors === null) out.colors = ints.find((n) => n >= 1 && n <= 300 && n < 1000) ?? null;
    if (out.total === null) {
      const big = ints.filter((n) => n >= 20).sort((a, b) => b - a)[0];
      if (big !== undefined && (out.colors === null || big > out.colors)) out.total = big;
    }
  }
  if (out.total !== null && (out.total < 5 || (out.cols && out.rows && out.total > out.cols * out.rows))) out.total = null;
  if (out.colors !== null && out.total !== null && out.colors >= out.total) out.colors = null;
  return out;
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
    if (count !== null) addItem(map, normalizeCode(m[1] + m[2]), count, "文字", valid);
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
    while ((m = CODE_ONLY.exec(lines[i]))) if (valid.has(normalizeCode(m[1] + m[2]))) codes.push(normalizeCode(m[1] + m[2]));
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

const CODE_WORD = /^(ZG|[A-HMPQRTY])(\d{1,3})$/;
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
    return !!m && validCodes.has(normalizeCode(m[1] + m[2]));
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
      if (c !== null) addItem(fused, normalizeCode(m[1] + m[2]), c, "词框(粘连)", validCodes);
    }
  }

  type Pair = { d: number; ci: number; ni: number };
  const pairUp = (kind: "right" | "left" | "below"): Map<string, LegendItem> => {
    const cand: Pair[] = [];
    codeWords.forEach((c, ci) => {
      numWords.forEach((n, ni) => {
        const lh = Math.max(c.h, n.h);
        if (kind === "right") {
          const gap = n.x0 - c.x1;
          if (Math.abs(n.cy - c.cy) < 0.6 * lh && gap > -0.5 * lh && gap < 5 * lh) cand.push({ d: Math.abs(gap) + Math.abs(n.cy - c.cy), ci, ni });
        } else if (kind === "left") {
          // 表格：数量列在色号列左边（颜色 | 数量 | 色号）
          const gap = c.x0 - n.x1;
          if (Math.abs(n.cy - c.cy) < 0.6 * lh && gap > -0.5 * lh && gap < 8 * lh) cand.push({ d: Math.abs(gap) + Math.abs(n.cy - c.cy) * 3, ci, ni });
        } else {
          const gap = n.y0 - c.y1;
          const overlap = Math.min(n.x1, c.x1) - Math.max(n.x0, c.x0);
          const near = Math.abs(n.cx - c.cx) < 0.75 * Math.max(n.w, c.w);
          if (n.cy > c.cy && gap < 2.6 * lh && gap > -0.5 * lh && overlap > 0 && near) cand.push({ d: Math.abs(gap) * 2 + Math.abs(n.cx - c.cx), ci, ni });
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
      if (cnt !== null) addItem(map, normalizeCode(codeWords[p.ci].text), cnt, kind === "right" ? "词框(同行)" : kind === "left" ? "词框(表格)" : "词框(下方)", validCodes);
    }
    return map;
  };

  const strategies: Array<Map<string, LegendItem>> = [
    pairUp("right"),
    pairUp("left"),
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

export type Chip = { x: number; y: number; width: number; height: number; r: number; g: number; b: number; /** 调用方自带的标识（格内色号 OCR 用来对应回代表格） */ tag?: number; /** 页面底色（findChips 给出） */ bg?: [number, number, number]; /** 色块下方一并读取的条带高度（数量印在色块下面的图例） */ below?: number; /** 该块单独的墨迹阈值（相对最大反差），不设则用 chipStack 的默认值 */ inkThr?: number };

type PixelSrc = { width: number; height: number; data: Uint8ClampedArray };

/** 在 src 中找平涂的矩形色块（比周围背景深/浅，长度 ≥ minRun 的水平同色段，纵向相连）。 */
export function findChips(src: PixelSrc, minRun = 40, minAspect = 1.5): Chip[] {
  const a = findChipsRuns(src, minRun, minAspect);
  if (minAspect >= 1.5) return a;
  // 色块里的字大、平涂行很少时，水平“同色段”法会漏掉；再用连通域法，取找到更多的那个
  const b = findChipsCC(src);
  return b.length > a.length ? b : a;
}

/** 连通域法：与底色不同、颜色相近且连通的一块（允许里面有文字形成的洞），面积 / 外接矩形比足够大。 */
export function findChipsCC(src: PixelSrc): Chip[] {
  const { width: w, height: h, data: d } = src;
  const votes = new Map<number, number>();
  for (let y = 0; y < h; y += Math.max(1, Math.floor(h / 40))) for (let x = 0; x < w; x += Math.max(1, Math.floor(w / 80))) {
    const i = (y * w + x) * 4;
    const k = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
    votes.set(k, (votes.get(k) ?? 0) + 1);
  }
  let bk = 0, bv = -1;
  for (const [k, v] of votes) if (v > bv) { bv = v; bk = k; }
  const br = ((bk >> 8) << 4) + 8, bg = (((bk >> 4) & 15) << 4) + 8, bb = ((bk & 15) << 4) + 8;
  const seen = new Uint8Array(w * h);
  const out: Chip[] = [];
  const stack: number[] = [];
  for (let y0 = 0; y0 < h; y0 += 1) {
    for (let x0 = 0; x0 < w; x0 += 1) {
      const p0 = y0 * w + x0;
      if (seen[p0]) continue;
      const i0 = p0 * 4;
      if (Math.abs(d[i0] - br) + Math.abs(d[i0 + 1] - bg) + Math.abs(d[i0 + 2] - bb) <= 40) { seen[p0] = 1; continue; }
      const sr = d[i0], sg = d[i0 + 1], sb = d[i0 + 2];
      let minX = x0, maxX = x0, minY = y0, maxY = y0, n = 0, rs = 0, gs = 0, bs = 0;
      stack.length = 0;
      stack.push(p0);
      seen[p0] = 1;
      while (stack.length) {
        const p = stack.pop()!;
        const x = p % w, y = (p - x) / w;
        const i = p * 4;
        n += 1; rs += d[i]; gs += d[i + 1]; bs += d[i + 2];
        if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
        for (const q of [p - 1, p + 1, p - w, p + w]) {
          if (q < 0 || q >= w * h || seen[q]) continue;
          if ((q === p - 1 && x === 0) || (q === p + 1 && x === w - 1)) continue;
          const j = q * 4;
          if (Math.abs(d[j] - sr) + Math.abs(d[j + 1] - sg) + Math.abs(d[j + 2] - sb) <= 36) { seen[q] = 1; stack.push(q); }
        }
      }
      const bwid = maxX - minX + 1, bhei = maxY - minY + 1;
      if (bwid >= 14 && bhei >= 10 && n >= 200 && n / (bwid * bhei) >= 0.4 && bwid / bhei >= 0.6 && bwid / bhei <= 8 && bwid * bhei < 0.4 * w * h) {
        out.push({ x: minX, y: minY, width: bwid, height: bhei, r: Math.round(rs / n), g: Math.round(gs / n), b: Math.round(bs / n), bg: [br, bg, bb] });
      }
    }
  }
  return out;
}

function findChipsRuns(src: PixelSrc, minRun = 40, minAspect = 1.5): Chip[] {
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
    .filter((c) => c.y1 - c.y0 >= 10 && (c.x1 - c.x0) >= minAspect * (c.y1 - c.y0))
    .map((c) => ({ x: c.x0, y: c.y0, width: c.x1 - c.x0, height: c.y1 - c.y0, r: c.best.r, g: c.best.g, b: c.best.b, bg: [br, bg, bb] as [number, number, number] }));
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

/**
 * 数量印在色块正下方的图例（画像素 / 比奇堡居民 / 宠物小精灵那类）：给每个色块算出“下方条带”高度——
 * 色块正下方到下一排色块（或图底）之间的空隙，至少半个色块高才算有数量；条带高度封顶 0.85 个色块高。
 */
export function assignBelowBands(chips: Chip[], imgHeight: number): void {
  for (const c of chips) {
    let next = imgHeight;
    for (const o of chips) if (o !== c && o.y >= c.y + c.height && o.x < c.x + c.width && o.x + o.width > c.x) next = Math.min(next, o.y);
    const gap = next - (c.y + c.height);
    if (gap >= 0.5 * c.height) c.below = Math.min(gap - 2, Math.round(0.85 * c.height));
    else delete c.below;
  }
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
export function chipStack(src: PixelSrc, chips: Chip[], scale: number, targetGlyphH?: number, inkThr = 0.5, binarize = false, keepTail = false): ChipStack {
  const { width: w, data: d } = src;
  const sorted = [...chips].sort((a, b) => (Math.abs(a.y - b.y) > 0.5 * a.height ? a.y - b.y : a.x - b.x));
  const pad = targetGlyphH ? 14 : Math.max(6, Math.round(6 * scale));
  type Piece = { chip: Chip; bx: number; by: number; bw: number; bh: number; ink: Float32Array; s: number };
  const pieces: Piece[] = [];
  for (const c of sorted) {
    // 色块内“墨迹强度”：与底色的差，封顶 255
    const th = Math.min(c.height + (c.below ?? 0), Math.max(0, src.height - c.y));
    const bgc = c.bg ?? [255, 255, 255];
    const refAt = (yy: number): [number, number, number] => (yy < c.height ? [c.r, c.g, c.b] : bgc);
    const ink = new Float32Array(c.width * th);
    let x0 = c.width, x1 = -1, y0 = th, y1 = -1;
    // 格内文字笔画细：以本块最大反差的一半为界做陡峭映射，避免放大后笔画糊成一团
    let refDiff = 0;
    if (targetGlyphH) {
      for (let y = 0; y < th; y += 1) for (let x = 0; x < c.width; x += 1) {
        const i = ((c.y + y) * w + c.x + x) * 4;
        refDiff = Math.max(refDiff, Math.abs(d[i] - c.r) + Math.abs(d[i + 1] - c.g) + Math.abs(d[i + 2] - c.b));
      }
    }
    for (let y = 0; y < th; y += 1) {
      const [rr, gg, bb2] = refAt(y);
      for (let x = 0; x < c.width; x += 1) {
        const i = ((c.y + y) * w + c.x + x) * 4;
        const diff = Math.abs(d[i] - rr) + Math.abs(d[i + 1] - gg) + Math.abs(d[i + 2] - bb2);
        const v = targetGlyphH
          ? (refDiff < 60 ? 0 : (c.inkThr ?? inkThr) < 0 ? Math.min(255, (diff / refDiff) * 255) : Math.min(255, Math.max(0, ((diff - (c.inkThr ?? inkThr) * refDiff) / (0.2 * refDiff)) * 128 + 128)))
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
      if (!keepTail && big.length >= 3) {
        const lastTok = big[big.length - 1];
        const lh = heightOf(lastTok);
        const others = big.slice(0, -1).map(heightOf);
        if (lh >= 0.9 * (y1 - y0 + 1) && lastTok[1] - lastTok[0] + 1 >= 0.8 * lh && others.some((o) => o <= 0.85 * lh)) {
          for (let y = 0; y < th; y += 1) for (let x = x0 + lastTok[0]; x <= x0 + lastTok[1] + 2 && x < c.width; x += 1) ink[y * c.width + x] = 0;
          x1 = x0 + big[big.length - 2][1];
        }
      }
    }
    const bwi = Math.min(c.width, x1 + 3) - Math.max(0, x0 - 2);
    const bhi = Math.min(th, y1 + 3) - Math.max(0, y0 - 2);
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
        const g = binarize ? (v > 110 ? 0 : 255) : 255 - Math.min(255, v);
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

export function codeCandidates(token: string, valid: Set<string>): string[] {
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
    for (const c of combos) { const z = c.replace(/^0+(?=\d)/, ""); if (valid.has(series + z)) out.add(series + z); }
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
  const t = token.normalize("NFKC").toUpperCase().replace(/,/g, "").replace(/^[X×]/, "");
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
): LegendReading & { colors: Record<string, { r: number; g: number; b: number }>; perChip: Array<{ chip: Chip; code: string | null; count: number | null }> } {
  const map = new Map<string, LegendItem>();
  const perChip: Array<{ chip: Chip; code: string | null; count: number | null }> = [];
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
    let cands: string[] = [];
    if (count === null) {
      // 只有色号没有数量（数量被另一次识别补）：也记下来
      for (let j = 0; j < tokens.length && !cands.length; j += 1) cands = codeCandidates(tokens[j], valid);
      perChip.push({ chip, code: cands.length ? cands[0] : null, count: null });
      continue;
    }
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
    perChip.push({ chip, code: best, count });
  }
  const items = [...map.values()];
  const counts: Counts = {};
  for (const it of items) counts[it.code] = it.count;
  return { items, counts, statedTotal: null, rawText: raw.slice(0, 2000), colors, perChip };
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


// ───────────────────────── 版式无关的图例读取：纯函数部分（解析 / 校验 / 色块查找） ─────────────────────────

/**
 * 数量的各种写法：x321、×321、X321、*321、321颗、321，以及“B13 315”（取最后一个数字串）。
 * 允许 OCR 把 0/1/5/8/2 认成 O/I/L/S/B/Z；千分位逗号；一个真数字都没有的不算。
 */
export function parseCountPattern(text: string): number | null {
  const t = text.normalize("NFKC").toUpperCase().replace(/[颗粒个]|PCS?/g, " ");
  const toks = t.split(/[\s:：()（）=·•・]+/).filter(Boolean);
  for (let i = toks.length - 1; i >= 0; i -= 1) {
    let k = toks[i].replace(/^[X×*]+/, "").replace(/[X×*]+$/, "");
    if (!k) continue;
    // 一个 token 里混着色号和数量（“B13315”）不拆
    if (!/^[0-9OILSBZ|,]{1,7}$/.test(k) || !/[0-9]/.test(k)) continue;
    // 字母只允许在数字占多数时当混淆处理
    const nDigit = (k.match(/[0-9]/g) ?? []).length;
    if (nDigit * 2 < k.replace(/,/g, "").length) continue;
    k = k.replace(/,/g, "").replace(/[OQD]/g, "0").replace(/[IL|]/g, "1").replace(/S/g, "5").replace(/B/g, "8").replace(/Z/g, "2");
    const n = Number(k);
    if (Number.isFinite(n) && n >= 1 && n <= 99999) return n;
  }
  return null;
}

/** 色块里的一段文字：可能是“A13”，也可能是“B13 315”或“A13·84颗”。返回色号候选（按改动代价排序）与数量（有则）。 */
export function splitGlued(token: string, valid: Set<string>): Array<{ code: string; count: number }> {
  const m = /^(ZG|[A-Z])(\d{3,8})[A-Z]{0,2}$/.exec(token);
  if (!m) return [];
  const out: Array<{ code: string; count: number }> = [];
  for (let k = 1; k <= 3 && k < m[2].length; k += 1) {
    const rest = m[2].slice(k);
    if (rest[0] === "0" || rest.length > 4) continue;
    const code = m[1] + m[2].slice(0, k);
    if (valid.has(code)) out.push({ code, count: Number(rest) });
  }
  return out;
}

export function parseCodeCountText(text: string, valid: Set<string>): { codes: string[]; count: number | null; /** 色号与数量连写（“A10195”，冒号 / 空格被丢）时的各种拆法 */ glued: Array<{ code: string; count: number }> } {
  const norm = text.normalize("NFKC").toUpperCase();
  // 数量后面粘着的单位字（“7TH”“95H”里的 TH / H 是“颗”被读错）：只在不像色号（≥ 2 个 token、不是第一个）时去掉
  const toks = norm.split(/[\s·•・∙⋅:：()（）=]+/).filter(Boolean).map((tk, i) => (i >= 1 && /^[0-9]{1,5}[A-Z|]{1,2}$/.test(tk) ? tk.replace(/[A-Z|]+$/, "") : tk));
  let count: number | null = null;
  let countIdx = toks.length;
  // 数量必须在色号之后：从后往前找第一个“像数量”的 token（≥ 2 个 token 时纯数字也算，单个 token 只认带 x 前缀的）；
  // 数量后面跟着的短杂质（“颗”被读成 Hi / P| 之类）跳过
  for (let i = toks.length - 1; i >= 0; i -= 1) {
    const tk = toks[i];
    const prefixed = /^[X×*][0-9OILSBZ|,]+$/.test(tk);
    const plain = i >= 1 && /^[0-9,]+(?:颗|粒)?$/.test(tk);
    if (!prefixed && !plain) { if (i === toks.length - 1 || i === toks.length - 2) continue; break; }
    // “51 48”：数量后面的单位字（颗）被读成 1–2 位的假数字 → 数量是前一个数字 token
    const prev = toks[i - 1];
    const j = plain && !prefixed && tk.length <= 2 && i >= 2 && prev !== undefined && /^[0-9,]{1,6}$/.test(prev) ? i - 1 : i;
    const n = parseCountPattern(toks[j]);
    if (n !== null) { count = n; countIdx = j; }
    break;
  }
  const codes: string[] = [];
  for (const tk of toks.slice(0, countIdx)) for (const c of cellCodeCandidates(tk, valid)) if (!codes.includes(c)) codes.push(c);
  const glued = count === null ? toks.flatMap((tk) => splitGlued(tk, valid)) : [];
  return { codes, count, glued };
}

export type ColorOf = (code: string) => { r: number; g: number; b: number } | null;

export function deltaE(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): number {
  return ciede2000(rgbToLab(a), rgbToLab(b));
}

/**
 * 色号候选校验：色块实际颜色必须与该色号的色卡色接近（ΔE ≤ maxDE，色块被 JPEG / 水印轻微改色）。
 * 返回通过校验的候选，顺序：OCR 候选原有顺序（改动代价小的在前）；颜色相差很远的候选（如绿色块上的 E20）被剔除。
 */
export function validateCodeCandidates(cands: string[], rgb: { r: number; g: number; b: number }, colorOf: ColorOf, maxDE = 12): Array<{ code: string; dE: number }> {
  const out: Array<{ code: string; dE: number }> = [];
  for (const code of cands) {
    const pc = colorOf(code);
    if (!pc) continue;
    const d = deltaE(rgb, pc);
    if (d <= maxDE) out.push({ code, dE: d });
  }
  return out;
}

/** 与色块颜色最接近的色号（按 ΔE 升序，≤ maxDE，最多 k 个）。 */
export function nearestCodesByColor(rgb: { r: number; g: number; b: number }, codes: Iterable<string>, colorOf: ColorOf, maxDE = 8, k = 4): Array<{ code: string; dE: number }> {
  const lab = rgbToLab(rgb);
  const out: Array<{ code: string; dE: number }> = [];
  for (const code of codes) {
    const pc = colorOf(code);
    if (!pc) continue;
    const d = ciede2000(lab, rgbToLab(pc));
    if (d <= maxDE) out.push({ code, dE: d });
  }
  return out.sort((a, b) => a.dE - b.dE).slice(0, k);
}

/**
 * 数字写法的邻近混淆（OCR 常把 3↔8、1↔7、5↔6、0↔8↔6 认混）：给一个数量，列出把某一位换成混淆数字后的备选。
 */
const CONFUSE: Record<string, string[]> = { "0": ["8", "6", "9"], "1": ["7"], "2": ["7"], "3": ["8", "5"], "5": ["6", "3", "8"], "6": ["5", "8", "0"], "7": ["1"], "8": ["3", "0", "6", "9"], "9": ["8", "0", "4"], "4": ["9"] };
export function countAlternatives(n: number): number[] {
  const s = String(n);
  const out = new Set<number>();
  for (let i = 0; i < s.length; i += 1) for (const d of CONFUSE[s[i]] ?? []) out.add(Number(s.slice(0, i) + d + s.slice(i + 1)));
  out.delete(n);
  return [...out].filter((v) => v >= 1);
}

/**
 * 相邻色块之间只隔 1–2 像素（缝里是一道浅色的描边 / 阴影，同样被当成色块像素）时会连成一个宽块。
 * 逐列取“最常见的颜色”（文字笔画是少数，不影响），相邻列的主色突变（三通道绝对差之和 > 60）并且新颜色持续 ≥ 6 列，
 * 就是换了一个色块：返回各色块的列范围（含缝：缝归后一个，随后的收边步骤会按颜色把它去掉）。只有一个色块返回 null。
 */
function splitMergedChips(members: number[], w: number, d: ArrayLike<number>, minX: number, maxX: number, bh: number): Array<[number, number]> | null {
  const nc = maxX - minX + 1;
  const hist: Array<Map<number, number[]>> = Array.from({ length: nc }, () => new Map());
  for (const p of members) {
    const i = p * 4, k = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
    const m = hist[(p % w) - minX];
    const e = m.get(k);
    if (e) { e[0] += 1; e[1] += d[i]; e[2] += d[i + 1]; e[3] += d[i + 2]; } else m.set(k, [1, d[i], d[i + 1], d[i + 2]]);
  }
  const mode = hist.map((m) => {
    let best: number[] | null = null;
    for (const e of m.values()) if (!best || e[0] > best[0]) best = e;
    return best && best[0] >= 6 ? [best[1] / best[0], best[2] / best[0], best[3] / best[0]] : null;
  });
  const dist = (a: number[], b: number[]) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
  const starts: number[] = [0];
  let prev: number[] | null = null;
  for (let x = 0; x < nc; x += 1) {
    const c = mode[x];
    if (!c) continue;
    if (!prev) { prev = c; continue; }
    if (dist(c, prev) <= 60) { prev = c; continue; }
    // 新颜色要持续 ≥ 6 列（且这些列彼此接近）才算换了色块；浅色缝 / 笔画只有 1–3 列
    let ok = true;
    for (let k = 1; k < 6; k += 1) { const n = mode[x + k]; if (!n || dist(n, c) > 40 || dist(n, prev) <= 60) { ok = false; break; } }
    if (ok) { starts.push(x); prev = c; }
  }
  if (starts.length < 2) return null;
  const ranges: Array<[number, number]> = [];
  starts.forEach((s0, i) => {
    const r: [number, number] = [minX + s0, minX + (i + 1 < starts.length ? starts[i + 1] - 1 : nc - 1)];
    const prev = ranges[ranges.length - 1];
    // 过窄的一段（缝 / 色块边缘的阴影）并入前一段
    if (prev && r[1] - r[0] + 1 < 0.5 * bh) prev[1] = r[1]; else ranges.push(r);
  });
  // 第一段过窄（最左一列的描边）并入后一段
  if (ranges.length >= 2 && ranges[0][1] - ranges[0][0] + 1 < 0.5 * bh) { ranges[1][0] = ranges[0][0]; ranges.shift(); }
  if (ranges.length < 2) return null;
  // 合并的是同样大小的色块：各段宽度相近（最宽 ≤ 1.6 × 最窄），否则不是“相邻色块”，不拆
  const ws = ranges.map(([a, b]) => b - a + 1);
  if (Math.max(...ws) > 1.6 * Math.min(...ws)) return null;
  return ranges;
}

/**
 * 平涂色块查找（版式无关）：与页面底色明显不同的像素连成块（4 连通），块的外接矩形足够“实心”（内部的文字空洞允许）。
 * 色块颜色取块内像素的逐通道中位数（文字像素是少数，中位数就是底色）。浅到几乎和纸一样的色块（如白色 H1 / H2）
 * 找不到——由调用方按排列规律补全。
 */
export function findFlatBlobs(src: PixelSrc, diffThr = 45): Chip[] {
  const { width: w, height: h, data: d } = src;
  const votes = new Map<number, number>();
  const sx = Math.max(1, Math.floor(w / 120)), sy = Math.max(1, Math.floor(h / 60));
  for (let y = 0; y < h; y += sy) for (let x = 0; x < w; x += sx) {
    const i = (y * w + x) * 4;
    const k = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
    votes.set(k, (votes.get(k) ?? 0) + 1);
  }
  let bk = 0, bv = -1;
  for (const [k, v] of votes) if (v > bv) { bv = v; bk = k; }
  // 底色：取该桶内像素的平均，比桶中心准
  let br = 0, bg = 0, bb = 0, bn = 0;
  for (let y = 0; y < h; y += sy) for (let x = 0; x < w; x += sx) {
    const i = (y * w + x) * 4;
    const k = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
    if (k === bk) { br += d[i]; bg += d[i + 1]; bb += d[i + 2]; bn += 1; }
  }
  br = Math.round(br / bn); bg = Math.round(bg / bn); bb = Math.round(bb / bn);
  const mask = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p += 1) {
    const i = p * 4;
    if (Math.abs(d[i] - br) + Math.abs(d[i + 1] - bg) + Math.abs(d[i + 2] - bb) > diffThr) mask[p] = 1;
  }
  // 腐蚀一次（3×3）：把 1–2 像素宽的边框线 / 笔画切掉，色块不会通过描边连到旁边的数量框
  {
    const er = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y += 1) for (let x = 1; x < w - 1; x += 1) {
      const p = y * w + x;
      if (mask[p] && mask[p - 1] && mask[p + 1] && mask[p - w] && mask[p + w] && mask[p - w - 1] && mask[p - w + 1] && mask[p + w - 1] && mask[p + w + 1]) er[p] = 1;
    }
    mask.set(er);
  }
  const out: Chip[] = [];
  const stack: number[] = [];
  const members: number[] = [];
  for (let p0 = 0; p0 < w * h; p0 += 1) {
    if (mask[p0] !== 1) continue;
    let minX = w, maxX = 0, minY = h, maxY = 0;
    stack.length = 0; members.length = 0;
    stack.push(p0); mask[p0] = 2;
    while (stack.length) {
      const p = stack.pop()!;
      members.push(p);
      const x = p % w, y = (p - x) / w;
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (x > 0 && mask[p - 1] === 1) { mask[p - 1] = 2; stack.push(p - 1); }
      if (x < w - 1 && mask[p + 1] === 1) { mask[p + 1] = 2; stack.push(p + 1); }
      if (y > 0 && mask[p - w] === 1) { mask[p - w] = 2; stack.push(p - w); }
      if (y < h - 1 && mask[p + w] === 1) { mask[p + w] = 2; stack.push(p + w); }
    }
    const emit = (members: number[], minX: number, maxX: number, minY: number, maxY: number): void => {
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    const n = members.length;
    if (bw < 8 || bh < 8 || n < 40 || n / (bw * bh) < 0.45 || bw / bh < 0.6 || bw / bh > 9 || bw * bh > 0.3 * w * h) return;
    const rs: number[] = [], gs: number[] = [], bs: number[] = [];
    const step = Math.max(1, Math.floor(n / 600));
    for (let k = 0; k < n; k += step) { const i = members[k] * 4; rs.push(d[i]); gs.push(d[i + 1]); bs.push(d[i + 2]); }
    const med = (a: number[]) => a.sort((x, y) => x - y)[a.length >> 1];
    const cr = med(rs), cg = med(gs), cb = med(bs);
    // 水印 / 相邻文字常粘在色块边上，把外接矩形撑大：只保留“接近色块颜色”的列 / 行连续段
    let tx = minX, ty = minY, tw = bw, th = bh;
    if (n >= 150) {
      const cp = new Int32Array(bw), rp = new Int32Array(bh);
      for (const p of members) {
        const i = p * 4;
        if (Math.abs(d[i] - cr) + Math.abs(d[i + 1] - cg) + Math.abs(d[i + 2] - cb) <= 60) { const x = p % w, y = (p - x) / w; cp[x - minX] += 1; rp[y - minY] += 1; }
      }
      const run = (prof: Int32Array): [number, number] => {
        const thr = 0.3 * Math.max(...prof);
        let a0 = 0, a1 = prof.length - 1;
        while (a0 < a1 && prof[a0] < thr) a0 += 1;
        while (a1 > a0 && prof[a1] < thr) a1 -= 1;
        return [a0, a1 - a0 + 1];
      };
      const [cx0, cl] = run(cp), [ry0, rl] = run(rp);
      if (cl >= 8 && rl >= 8) { tx = minX + cx0; tw = cl; ty = minY + ry0; th = rl; }
    }
    out.push({ x: tx - 1, y: ty - 1, width: tw + 2, height: th + 2, r: cr, g: cg, b: cb, bg: [br, bg, bb] });
    };
    const bw0 = maxX - minX + 1, bh0 = maxY - minY + 1;
    // 相邻色块之间只隔 1 像素（甚至粘在一起）时会连成一个宽块：按缝（几乎没有色块像素的列）拆成各自的色块
    const parts = members.length >= 150 && members.length >= 0.85 * bw0 * bh0 && bw0 >= 1.9 * bh0 && bw0 <= 9 * bh0 && bw0 * bh0 <= 0.3 * w * h ? splitMergedChips(members, w, d, minX, maxX, bh0) : null;
    if (parts) {
      for (const [a0, a1] of parts) {
        const sub = members.filter((p) => { const x = p % w; return x >= a0 && x <= a1; });
        let y0 = h, y1 = 0;
        for (const p of sub) { const y = (p - (p % w)) / w; if (y < y0) y0 = y; if (y > y1) y1 = y; }
        emit(sub, a0, a1, y0, y1);
      }
    } else emit(members, minX, maxX, minY, maxY);
  }
  return out;
}
