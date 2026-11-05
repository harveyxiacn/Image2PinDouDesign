// 版式无关的图例读取器（色块 + 色号 + 数量）。
// 小红书上的图纸图例版式五花八门：色号写在色块里 / 色块旁 / 色块下，数量写在色块里 / 右边 / 下面（x321、×321、315、84 颗）。
// 做法：先找平涂色块（连通域），按行聚类并按排列规律补出“白色（和纸一样白）的隐形色块”，
// 再为每个色块分别裁出 ① 色号字段 ② 数量字段（选有字的位置：下方 / 右侧 / 块内），各自叠成一张小图（字高放大到 ~40px、
// 相对色块底色二值化，深浅两种字都行），各识别一遍（带白名单）。色号用色块颜色与色卡色的 ΔE 校验，数量保留多次识别的备选。
import type { PixelSource } from "@engine/types";
import { MARD_PALETTE } from "@engine/palette";
import { findFlatBlobs, findStatedTotal, chipStack, cellCodeCandidates, nearestCodesByColor, countAlternatives, parseCodeCountText, parseCountPattern, validateCodeCandidates } from "./legend";
import type { Chip } from "./legend";
import type { LegendItem, LegendReading } from "./types";

const VALID = new Set(MARD_PALETTE.map((c) => c.code));
const PAL = new Map(MARD_PALETTE.map((c) => [c.code, c]));
const colorOf = (code: string) => PAL.get(code)?.rgb ?? null;

type Rc = { x: number; y: number; width: number; height: number };
type Entry = {
  chip: Chip;
  synthetic: boolean;
  /** 数量字段所在位置 */
  countRect: Rc | null;
  below: Rc | null;
  right: Rc | null;
  label: Rc | null;
  where: "below" | "right" | "inside" | null;
  codeTexts: string[];
  countTexts: string[];
  code: string | null;
  dE: number | null;
  guessed: boolean;
  count: number | null;
  countAlts: number[];
  codeAlts: string[];
  votes: number;
  /** 色号 / 数量分段读出的数量（比整段混读可靠） */
  splitCounts: number[];
  /** 色号分段读过：色号按得票重新排 */
  splitCodes?: boolean;
};

export type ChipLegendResult = LegendReading & {
  /** 检测到的色块数（含补出的隐形块） */
  chipCount: number;
  /** 色号由文字读出（非按颜色猜）且数量也读到的条目数——判断这次读取是否可信 */
  confirmed: number;
  /** 每个条目的来源 / 把握（给 reconcile 用） */
  entries: Array<{ code: string; count: number | null; countAlts: number[]; codeAlts: string[]; dE: number | null; guessed: boolean; where: string | null }>;
};

function rowText(words: Array<{ text: string; bbox: { x0: number; y0: number; x1: number; y1: number } }>, y0: number, y1: number): string {
  return words
    .filter((w) => { const cy = (w.bbox.y0 + w.bbox.y1) / 2; return cy >= y0 && cy < y1; })
    .sort((a, b) => a.bbox.x0 - b.bbox.x0).map((w) => w.text).join(" ");
}

function inkIn(img: PixelSource, r: Rc, bg: [number, number, number]): number {
  const x0 = Math.max(0, Math.floor(r.x)), x1 = Math.min(img.width, Math.ceil(r.x + r.width));
  const y0 = Math.max(0, Math.floor(r.y)), y1 = Math.min(img.height, Math.ceil(r.y + r.height));
  let n = 0;
  for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) {
    const i = (y * img.width + x) * 4;
    if (Math.abs(img.data[i] - bg[0]) + Math.abs(img.data[i + 1] - bg[1]) + Math.abs(img.data[i + 2] - bg[2]) > 150) n += 1;
  }
  return n;
}

/** 同尺寸（±25% 高、±40% 宽）且总面积最大的一群才是图例色块；水印 / 文字团（数量多但面积小）/ 插图块被丢掉。 */
function dominantChips(blobs: Chip[]): Chip[] {
  let best: Chip[] = [], bestA = 0;
  for (const a of blobs) {
    const grp = blobs.filter((b) => Math.abs(b.height - a.height) <= 0.25 * a.height && Math.abs(b.width - a.width) <= 0.4 * a.width);
    const area = grp.reduce((s, c) => s + c.width * c.height, 0);
    if (grp.length >= 2 && area > bestA) { best = grp; bestA = area; }
  }
  return best;
}

function groupRows(chips: Chip[]): Chip[][] {
  const sorted = [...chips].sort((a, b) => a.y + a.height / 2 - (b.y + b.height / 2));
  const rows: Chip[][] = [];
  for (const c of sorted) {
    const cy = c.y + c.height / 2;
    const row = rows.find((r) => Math.abs(r[0].y + r[0].height / 2 - cy) <= 0.5 * c.height);
    if (row) row.push(c); else rows.push([c]);
  }
  for (const r of rows) r.sort((a, b) => a.x - b.x);
  return rows.sort((a, b) => a[0].y - b[0].y);
}

/** 色块里写了两行字（上：色号，下：×数量）时，按行的墨迹间隙切成两块；不是两行返回 null。 */
function splitTwoLines(img: PixelSource, c: Chip): { top: Rc; bottom: Rc } | null {
  const k = Math.max(2, Math.round(0.1 * c.height));
  const x0 = c.x + k, x1 = c.x + c.width - k, y0 = c.y + k, y1 = c.y + c.height - k;
  if (x1 - x0 < 8 || y1 - y0 < 16) return null;
  let ref = 0;
  const diffAt = (x: number, y: number) => { const i = (y * img.width + x) * 4; return Math.abs(img.data[i] - c.r) + Math.abs(img.data[i + 1] - c.g) + Math.abs(img.data[i + 2] - c.b); };
  for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) ref = Math.max(ref, diffAt(x, y));
  if (ref < 120) return null;
  const rows: boolean[] = [];
  for (let y = y0; y < y1; y += 1) { let n = 0; for (let x = x0; x < x1; x += 1) if (diffAt(x, y) > 0.5 * ref) n += 1; rows.push(n >= 1); }
  const segs: Array<[number, number]> = [];
  let st = -1;
  rows.forEach((on, i) => { if (on && st < 0) st = i; if ((!on || i === rows.length - 1) && st >= 0) { segs.push([st, on && i === rows.length - 1 ? i : i - 1]); st = -1; } });
  // 合并相隔 1 像素的碎段
  const merged: Array<[number, number]> = [];
  for (const sg of segs) { const l = merged[merged.length - 1]; if (l && sg[0] - l[1] <= 2) l[1] = sg[1]; else merged.push([...sg]); }
  const big = merged.filter((sg) => sg[1] - sg[0] + 1 >= 4);
  if (big.length !== 2) return null;
  const [a, b] = big;
  if (b[0] - a[1] < 2) return null;
  return { top: { x: x0, y: y0 + a[0] - 1, width: x1 - x0, height: a[1] - a[0] + 3 }, bottom: { x: x0, y: y0 + b[0] - 1, width: x1 - x0, height: b[1] - b[0] + 3 } };
}

/**
 * “色号 (数量)”写在同一段文字里（H12 (416)）：按墨迹列的最大空隙切成 色号 / 数量 两段。
 * 两段分别用各自的白名单识别，比整段混读准得多（括号不会把色号和数量连成一串）。切不出返回 null。
 */
function splitLabel(img: PixelSource, r: Rc, bg: [number, number, number]): { code: Rc; count: Rc } | null {
  const x0 = Math.max(0, Math.floor(r.x)), x1 = Math.min(img.width, Math.ceil(r.x + r.width));
  const y0 = Math.max(0, Math.floor(r.y)), y1 = Math.min(img.height, Math.ceil(r.y + r.height));
  if (x1 - x0 < 12 || y1 - y0 < 6) return null;
  const diff = (x: number, y: number) => { const i = (y * img.width + x) * 4; return Math.abs(img.data[i] - bg[0]) + Math.abs(img.data[i + 1] - bg[1]) + Math.abs(img.data[i + 2] - bg[2]); };
  let maxD = 0;
  for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) maxD = Math.max(maxD, diff(x, y));
  if (maxD < 120) return null;
  const thr = 0.4 * maxD;
  const col = new Array<boolean>(x1 - x0).fill(false);
  let ty0 = y1, ty1 = -1;
  for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) if (diff(x, y) > thr) { col[x - x0] = true; if (y < ty0) ty0 = y; if (y > ty1) ty1 = y; }
  const a = col.indexOf(true), b = col.lastIndexOf(true);
  if (a < 0 || b - a < 10) return null;
  let bestStart = -1, bestLen = 0;
  for (let i = a; i <= b;) {
    if (col[i]) { i += 1; continue; }
    let j = i; while (j <= b && !col[j]) j += 1;
    if (j - i > bestLen) { bestLen = j - i; bestStart = i; }
    i = j;
  }
  if (bestLen < 2 || bestStart - a < 4 || b - (bestStart + bestLen) < 3) return null;
  const h = ty1 - ty0 + 3;
  return {
    code: { x: x0 + a - 2, y: ty0 - 1, width: bestStart - a + 3, height: h },
    // 数量段两头各是一个括号（约 2 像素宽 + 1 像素空隙）：括号会被读成数字 1 / 7，宽度够时直接去掉
    count: (() => { const cx0 = bestStart + bestLen, cw = b - cx0 + 1, trim = 0; return { x: x0 + cx0 + trim - 1, y: ty0 - 1, width: cw - 2 * trim + 2, height: h }; })()
  };
}

/** 把若干矩形里的字（相对底色二值化 / 灰度）叠成一张图识别，返回每个矩形读到的文字。 */
async function ocrRects(img: PixelSource, rects: Rc[], bg: [number, number, number], wl: string, target: number, thr: number, bin: boolean, signal: AbortSignal): Promise<string[]> {
  const { ocrWords } = await import("./ocr");
  const out: string[] = rects.map(() => "");
  const pseudo = rects.map((r, i) => {
    const x = Math.max(0, Math.floor(r.x)), y = Math.max(0, Math.floor(r.y));
    return { x, y, width: Math.max(6, Math.min(Math.floor(r.width), img.width - x)), height: Math.max(6, Math.min(Math.floor(r.height), img.height - y)), r: bg[0], g: bg[1], b: bg[2], bg, tag: i, inkThr: thr };
  });
  const st = chipStack(img, pseudo, 1, target, thr, bin, true);
  if (!st.rows.length) return out;
  const res = await ocrWords(st.image, signal, { scale: 1, psm: "6", whitelist: wl });
  for (const row of st.rows) out[row.chip.tag ?? -1] = rowText(res.words, row.y0, row.y1);
  return out;
}

/**
 * 表格式图例：一列小色块，每块同一行上写着 颜色名 | 数量 | 色号（列顺序不定，色号可能零填充 H01）。
 * 按墨迹空隙把每行切成“字段”，取最右两段各读几遍（色号 / 数字混合白名单，汉字名称列不读），
 * 以字段内容区分谁是色号（字母开头）谁是数量；色号用色块颜色校验。
 */
async function readTableLegend(img: PixelSource, chips: Chip[], bg: [number, number, number], signal: AbortSignal): Promise<ChipLegendResult | null> {
  // 同一列（x 基本对齐）的色块才是表格的色块列；列外的是插图 / 水印里恰好同尺寸的块
  let colChips: Chip[] = [];
  for (const a of chips) { const g = chips.filter((b) => Math.abs(b.x - a.x) <= 0.5 * a.width); if (g.length > colChips.length) colChips = g; }
  if (colChips.length < 3) return null;
  let sorted = [...colChips].sort((a, b) => a.y - b.y);
  const medW = [...sorted.map((c) => c.width)].sort((a, b) => a - b)[sorted.length >> 1];
  const medH = [...sorted.map((c) => c.height)].sort((a, b) => a - b)[sorted.length >> 1];
  const dys0 = sorted.slice(1).map((c, i) => c.y - sorted[i].y);
  if (dys0.some((d) => d < 0.8 * medH)) return null;
  // 行距规律：间隔是整数倍行距的地方补出隐形（和纸同色 / 白色）色块
  const pitch = [...dys0].sort((a, b) => a - b)[0];
  const filled: Chip[] = [];
  sorted.forEach((c, i) => {
    filled.push(c);
    if (i + 1 >= sorted.length) return;
    const dy = sorted[i + 1].y - c.y, k = Math.round(dy / pitch);
    if (k >= 2 && Math.abs(dy - k * pitch) <= 0.2 * pitch) for (let j = 1; j < k; j += 1) filled.push({ x: c.x, y: Math.round(c.y + (dy * j) / k), width: c.width, height: c.height, r: bg[0], g: bg[1], b: bg[2], bg });
  });
  sorted = filled;
  const dys = sorted.slice(1).map((c, i) => c.y - sorted[i].y);
  if (dys.some((d) => d < 0.8 * medH)) return null;
  // 表格右边界：第一条贯穿全部行带的竖线（面板边框）之前
  const top = sorted[0].y - 2, bottom = sorted[sorted.length - 1].y + sorted[sorted.length - 1].height + 2;
  const x0 = sorted[0].x + sorted[0].width + 2;
  const diffAt = (x: number, y: number) => { const i = (y * img.width + x) * 4; return Math.abs(img.data[i] - bg[0]) + Math.abs(img.data[i + 1] - bg[1]) + Math.abs(img.data[i + 2] - bg[2]); };
  let edge = img.width;
  for (let x = x0 + 4 * medW; x < img.width; x += 1) {
    let n = 0;
    for (let y = top; y < Math.min(img.height, bottom); y += 1) if (diffAt(x, y) > 60) n += 1;
    if (n >= 0.9 * (bottom - top)) { edge = x; break; }
  }
  if (edge - x0 < 6 * medW) return null;
  const segsOf = (c: Chip): Rc[] => {
    const ry0 = Math.max(0, c.y - 2), ry1 = Math.min(img.height, c.y + c.height + 2);
    let maxD = 0;
    for (let y = ry0; y < ry1; y += 1) for (let x = x0; x < edge; x += 1) maxD = Math.max(maxD, diffAt(x, y));
    if (maxD < 120) return [];
    const thr = 0.4 * maxD;
    const col = new Array<boolean>(edge - x0).fill(false);
    let ty0 = ry1, ty1 = ry0;
    for (let y = ry0; y < ry1; y += 1) for (let x = x0; x < edge; x += 1) if (diffAt(x, y) > thr) { col[x - x0] = true; if (y < ty0) ty0 = y; if (y > ty1) ty1 = y; }
    const H = Math.max(4, ty1 - ty0 + 1);
    const gapMin = Math.max(6, Math.round(0.8 * H));
    const segs: Rc[] = [];
    let st = -1, last = -1;
    for (let i = 0; i < col.length; i += 1) {
      if (!col[i]) continue;
      if (st < 0) { st = i; last = i; } else if (i - last > gapMin) { segs.push({ x: x0 + st - 2, y: ty0 - 2, width: last - st + 5, height: H + 4 }); st = i; }
      last = i;
    }
    if (st >= 0) segs.push({ x: x0 + st - 2, y: ty0 - 2, width: last - st + 5, height: H + 4 });
    return segs;
  };
  const rowSegs = sorted.map(segsOf);
  if (rowSegs.filter((sg) => sg.length >= 2).length < Math.max(3, 0.6 * sorted.length)) return null;
  const A: Rc[] = [], B: Rc[] = [];
  rowSegs.forEach((sg) => { const n = sg.length; A.push(n >= 2 ? sg[n - 2] : { x: 0, y: 0, width: 6, height: 6 }); B.push(n >= 2 ? sg[n - 1] : { x: 0, y: 0, width: 6, height: 6 }); });
  const wl = "ABCDEFGHMPQRTYZ0123456789";
  const codeVotes = sorted.map(() => new Map<string, number>());
  const countVotes = sorted.map(() => new Map<number, number>());
  const texts: string[] = sorted.map(() => "");
  for (const [target, thr, bin] of [[36, -1, false], [48, 0.4, true], [28, 0.5, false]] as const) {
    if (signal.aborted) break;
    for (const rects of [A, B]) {
      const rd = await ocrRects(img, rects, bg, wl, target, thr, bin, signal);
      rd.forEach((t, i) => {
        if (rowSegs[i].length < 2) return;
        texts[i] += `${t}|`;
        const tok = t.replace(/\s+/g, "");
        if (/^[A-Z]/.test(tok) && /[0-9OIL]/.test(tok)) {
          for (const c of cellCodeCandidates(tok, VALID)) codeVotes[i].set(c, (codeVotes[i].get(c) ?? 0) + 1);
        } else {
          const n = parseCountPattern(tok);
          if (n !== null) countVotes[i].set(n, (countVotes[i].get(n) ?? 0) + 1);
        }
      });
    }
  }
  const items: LegendItem[] = [];
  const counts: Record<string, number> = {};
  const colors: Record<string, { r: number; g: number; b: number }> = {};
  const palette: NonNullable<LegendReading["palette"]> = [];
  const detail: ChipLegendResult["entries"] = [];
  let confirmed = 0;
  sorted.forEach((c, i) => {
    const cands = [...codeVotes[i].entries()].sort((a, b) => b[1] - a[1]).map((x) => x[0]);
    const ok = validateCodeCandidates(cands, { r: c.r, g: c.g, b: c.b }, colorOf, 16);
    // 色块颜色与色卡对不上（有的图纸自己编了一套色号）：文字多遍读到同一个有效色号就照文字采用
    const strong = codeVotes[i].size && Math.max(...codeVotes[i].values()) >= 2 ? cands[0] : null;
    const code = ok[0]?.code ?? strong;
    if (!code) return;
    const cn = [...countVotes[i].entries()].sort((a, b) => b[1] - a[1]);
    const count = cn.length ? cn[0][0] : null;
    colors[code] = { r: c.r, g: c.g, b: c.b };
    palette.push({ code, rgb: { r: c.r, g: c.g, b: c.b }, count });
    detail.push({ code, count, countAlts: cn.slice(1).map((x) => x[0]), codeAlts: ok.map((o) => o.code), dE: ok[0]?.dE ?? null, guessed: false, where: "table" });
    if (count !== null && count > 0 && !(code in counts)) { items.push({ code, count, source: "色块图例", votes: cn[0][1], ...(cn.length > 1 ? { alts: cn.slice(1).map((x) => x[0]) } : {}) }); counts[code] = count; confirmed += 1; }
  });
  return { items, counts, statedTotal: null, rawText: texts.join("\n").slice(0, 2000), colors, palette, chipCount: sorted.length, confirmed, entries: detail };
}

export async function readChipLegend(img: PixelSource, signal: AbortSignal): Promise<ChipLegendResult | null> {
  const { ocrWords } = await import("./ocr");
  const t0 = performance.now();
  /** 图例已经读了 1.2 秒以上：读数两遍一致的就不再多读（快的图照常读满，留备选读法） */
  const hurry = () => performance.now() - t0 > 1200;
  // 找到了色块但读下去发现不是“色块 + 数量”图例：返回空结果（chipCount > 0），调用方不必再换个裁剪重试
  const gaveUp = (): ChipLegendResult => ({ items: [], counts: {}, statedTotal: null, rawText: "", chipCount: 1, confirmed: 0, entries: [] } as ChipLegendResult);
  // 贴着裁剪边缘的块是被截断的东西（图纸最后一行格子、标尺），不是图例色块
  const blobs = findFlatBlobs(img).filter((b) => b.x > 0 && b.y > 0 && b.x + b.width < img.width && b.y + b.height < img.height);
  const chips0 = dominantChips(blobs);
  // 少于 3 个不成图例；多于 40 个多半是标尺 / 格子本身（图例最多几十色），也不读
  if (chips0.length < 3 || chips0.length > 36) return null;
  const medW = [...chips0.map((c) => c.width)].sort((a, b) => a - b)[chips0.length >> 1];
  const medH = [...chips0.map((c) => c.height)].sort((a, b) => a - b)[chips0.length >> 1];
  const bg = chips0[0].bg ?? ([255, 255, 255] as [number, number, number]);
  const rows = groupRows(chips0);
  // 表格式图例（一列色块，每行 颜色名 | 数量 | 色号）：先试表格读法，读得出就不再走下面的色块 + 标签读法
  if (rows.length >= 3 && rows.length >= 0.5 * chips0.length) {
    const tr = await readTableLegend(img, chips0, bg, signal);
    if (tr && tr.confirmed >= Math.max(3, Math.ceil(0.6 * tr.chipCount))) return tr;
  }

  // 1) 按排列规律补出隐形色块（和纸同色的白色块）：行内间距为整数倍时补中间的；行首 / 行尾若有字也补
  const entries: Entry[] = [];
  const mk = (chip: Chip, synthetic: boolean): Entry => ({ chip, synthetic, countRect: null, below: null, right: null, label: null, where: null, codeTexts: [], countTexts: [], code: null, dE: null, guessed: false, count: null, countAlts: [], codeAlts: [], votes: 0, splitCounts: [] });
  const rowEntries: Entry[][] = [];
  const allPitches: number[] = [];
  for (const r of rows) for (let i = 1; i < r.length; i += 1) allPitches.push(r[i].x - r[i - 1].x);
  const pitch = allPitches.length ? [...allPitches].sort((a, b) => a - b)[Math.floor(allPitches.length * 0.3)] : 0;
  const rowCy = (r: Chip[]) => [...r.map((c) => c.y + c.height / 2)].sort((a, b) => a - b)[r.length >> 1];
  const mkSyn = (x: number, cy: number): Chip => ({ x: Math.round(x), y: Math.round(cy - medH / 2), width: medW, height: medH, r: bg[0], g: bg[1], b: bg[2], bg });
  for (const r of rows) {
    const list: Entry[] = [];
    const cy = rowCy(r);
    if (pitch > medW * 0.9) {
      // 行首补一个：左边有一个间距的位置上有字
      const lead = { x: r[0].x - pitch, y: cy - medH / 2, width: medW, height: medH };
      if (lead.x >= 0 && inkIn(img, { ...lead, width: Math.max(medW, Math.round(0.8 * pitch)), height: Math.round(1.8 * medH) }, bg) >= 30) list.push(mk(mkSyn(lead.x, cy), true));
    }
    r.forEach((c, i) => {
      list.push(mk(c, false));
      if (i + 1 < r.length && pitch > medW * 0.9) {
        const gap = r[i + 1].x - c.x;
        const k = Math.round(gap / pitch);
        if (k >= 2 && Math.abs(gap - k * pitch) <= 0.25 * pitch) {
          for (let j = 1; j < k; j += 1) {
            const sx = c.x + (gap * j) / k;
            // 该位置上要有字才补（避免把真正的空位当色块）
            if (inkIn(img, { x: sx, y: cy - medH / 2, width: Math.max(medW, Math.round(0.8 * pitch)), height: medH + Math.round(medH * 0.9) }, bg) >= 30) list.push(mk(mkSyn(sx, cy), true));
          }
        }
      }
    });
    if (pitch > medW * 0.9) {
      const last = r[r.length - 1];
      const tail = { x: last.x + pitch, y: cy - medH / 2, width: medW, height: medH };
      if (tail.x + tail.width <= img.width && inkIn(img, { ...tail, width: Math.min(img.width - tail.x, Math.max(medW, Math.round(0.8 * pitch))), height: Math.round(1.8 * medH) }, bg) >= 30) list.push(mk(mkSyn(tail.x, cy), true));
    }
    rowEntries.push(list);
    entries.push(...list);
  }

  if (entries.length > 44) return gaveUp();

  // 2) 数量字段位置：每个色块 下方 / 右侧 / 块内，选有字的
  rowEntries.forEach((list, ri) => {
    const nextRowTop = ri + 1 < rowEntries.length ? Math.min(...rowEntries[ri + 1].map((e) => e.chip.y)) : img.height;
    list.forEach((e, i) => {
      const c = e.chip;
      const prev = list[i - 1]?.chip, next = list[i + 1]?.chip;
      const left = prev ? (prev.x + prev.width + c.x) / 2 : Math.max(0, c.x - 0.3 * c.width);
      const rightB = next ? (c.x + c.width + next.x) / 2 : Math.min(img.width, c.x + 1.3 * c.width);
      const belowTop = c.y + c.height + 1;
      const belowH = Math.min(nextRowTop - 1 - belowTop, Math.round(1.0 * c.height));
      const below: Rc | null = belowH >= 10 ? { x: left, y: belowTop, width: rightB - left, height: belowH } : null;
      const rX = c.x + c.width + 2;
      const rW = Math.min((next ? next.x - 2 : Math.min(img.width, rX + 1.8 * c.width)) - rX, 3 * c.width + 12);
      const right: Rc | null = rW >= 12 ? { x: rX, y: c.y - 1, width: rW, height: c.height + 2 } : null;
      const lW = Math.min((next ? next.x - 2 : Math.min(img.width, rX + 5 * c.width)) - rX, 9 * c.width + 20);
      const label: Rc | null = lW >= 24 ? { x: rX, y: Math.max(0, c.y - 3), width: lW, height: c.height + 6 } : null;
      e.label = label && inkIn(img, label, bg) >= 20 ? label : null;
      e.below = below && inkIn(img, below, bg) >= 8 ? below : null;
      e.right = right && inkIn(img, right, bg) >= 8 ? right : null;
    });
  });

  // 3) 色号字段：色块内文字
  const runOcr = async (stackImg: PixelSource, whitelist: string) => ocrWords(stackImg, signal, { scale: 1, psm: "6", whitelist });
  const readCounts = async (list: Entry[], pick: (e: Entry) => Rc | null, target: number, thr: number, bin: boolean, wl = "0123456789xX*"): Promise<Map<Entry, string>> => {
    const out = new Map<Entry, string>();
    const items = list.filter((e) => pick(e));
    if (!items.length) return out;
    const pseudo = items.map((e, i) => {
      const r = pick(e)!;
      const x = Math.max(0, Math.floor(r.x)), y = Math.max(0, Math.floor(r.y));
      return { x, y, width: Math.max(6, Math.min(Math.floor(r.width), img.width - x)), height: Math.max(6, Math.min(Math.floor(r.height), img.height - y)), r: bg[0], g: bg[1], b: bg[2], bg, tag: i, inkThr: thr };
    });
    const st = chipStack(img, pseudo, 1, target, thr, bin, true);
    if (!st.rows.length) return out;
    const res = await runOcr(st.image, wl);
    for (const row of st.rows) out.set(items[row.chip.tag ?? -1], rowText(res.words, row.y0, row.y1));
    return out;
  };
  const codeWl = "ABCDEFGHMPQRTYZ0123456789():.";
  const readCodesRaw = async (list: Entry[], target: number, thr: number, bin: boolean, wl: string = codeWl): Promise<Array<[Entry, string]>> => {
    const chs = list.map((e, i) => {
      // 内缩：色块边缘（抗锯齿 / 圆角 / 描边）不是文字，否则会被当成墨迹撑大字高
      const k = Math.max(2, Math.round(0.14 * e.chip.height));
      return { ...e.chip, x: e.chip.x + k, y: e.chip.y + k, width: Math.max(4, e.chip.width - 2 * k), height: Math.max(4, e.chip.height - 2 * k), tag: i, inkThr: thr };
    });
    const st = chipStack(img, chs, 1, target, thr, bin, true);
    if (!st.rows.length) return [];
    const res = await runOcr(st.image, wl);
    return st.rows.map((row) => [list[row.chip.tag ?? -1], rowText(res.words, row.y0, row.y1)] as [Entry, string]);
  };
  const readCodes = async (list: Entry[], target: number, thr: number, bin: boolean, wl: string = codeWl) => {
    for (const [e, t] of await readCodesRaw(list, target, thr, bin, wl)) e.codeTexts.push(t);
  };
  /** 两组互相独立的参数并发读（worker 池），结果按顺序并入（平票取先读的那遍） */
  const readCodesPair = async (list: Entry[], a: readonly [number, number, boolean], b: readonly [number, number, boolean]) => {
    const [ra, rb2] = await Promise.all([readCodesRaw(list, a[0], a[1], a[2]), readCodesRaw(list, b[0], b[1], b[2])]);
    for (const [e, t] of ra) e.codeTexts.push(t);
    for (const [e, t] of rb2) e.codeTexts.push(t);
  };
  const resolveCodes = (list: Entry[]) => {
    for (const e of list) {
      e.code = null; e.dE = null;
      const cands: string[] = [];
      const tally = new Map<string, number>();
      for (const t of e.codeTexts) {
        const p = parseCodeCountText(t, VALID);
        for (const c of p.codes) { if (!cands.includes(c)) cands.push(c); tally.set(c, (tally.get(c) ?? 0) + 1); }
        for (const g of p.glued) if (!cands.includes(g.code)) cands.push(g.code);
      }
      // 色号 / 数量分段读出过：按得票排序（整段混读常把色号读歪）
      cands.sort((x, y) => (tally.get(y) ?? 0) - (tally.get(x) ?? 0));
      // 隐形（白）块没有颜色信息：色号文字读到什么就是什么，但必须是浅色号
      const rgb = { r: e.chip.r, g: e.chip.g, b: e.chip.b };
      const ok = validateCodeCandidates(cands, rgb, colorOf, e.synthetic ? 14 : 11);
      e.codeAlts = ok.map((o) => o.code);
      if (ok.length) { e.code = ok[0].code; e.dE = ok[0].dE; }
      // 读到的色号是某个更长色号的前缀（“D1”其实是 D11 掉了一笔），而色块颜色与更长的那个吻合得多：取更长的
      if (e.code && !e.synthetic && (e.dE ?? 0) > 3) {
        const longer = nearestCodesByColor(rgb, [...VALID].filter((c) => c.length > e.code!.length && c.startsWith(e.code!)), colorOf, 3, 1)[0];
        if (longer) { e.codeAlts = [longer.code, ...e.codeAlts.filter((c) => c !== longer.code)]; e.code = longer.code; e.dE = longer.dE; }
      }
    }
  };
  // 第一遍不加白名单：色块里常写“A1 · 154 颗”，白名单会把分隔符丢掉让色号和数量连成一串；不加白名单时分隔符能保留
  await readCodes(entries, 40, 0.5, false, "");
  resolveCodes(entries);
  // 数量写在色块里 / 旁边（“A26 (871)”）：多读两遍参数不同的，数量投票（括号常被认成 1，一遍不可靠）
  if (entries.filter((e) => e.codeTexts.some((t) => parseCodeCountText(t, VALID).count !== null || parseCodeCountText(t, VALID).glued.length)).length >= 0.4 * entries.length) {
    await readCodesPair(entries, [56, 0.4, true], [32, 0.6, false]);
  }
  // 色块里是两行字（上 色号 / 下 ×数量）：分行各读一遍（色号白名单 / 数字白名单），比整块混读准得多
  const twoLine = new Map<Entry, { top: Rc; bottom: Rc }>();
  for (const e of entries) { if (e.synthetic) continue; const sp = splitTwoLines(img, e.chip); if (sp) twoLine.set(e, sp); }
  if (twoLine.size >= Math.max(3, 0.5 * entries.filter((e) => !e.synthetic).length)) {
    const list = [...twoLine.keys()];
    for (const e of entries) e.codeTexts.length = 0;
    const mk2 = (sub: Entry[], pick: (sp: { top: Rc; bottom: Rc }) => Rc, tag: (e: Entry) => number) => sub.map((e) => { const r = pick(twoLine.get(e)!); return { x: r.x, y: r.y, width: r.width, height: r.height, r: e.chip.r, g: e.chip.g, b: e.chip.b, bg: [bg[0], bg[1], bg[2]] as [number, number, number], tag: tag(e) }; });
    // 第三遍只给前两遍还没“色号两遍读成同一个、数量两遍读成同一个”的块（其余再读一遍只是 2-0 变 3-0，结论不变）
    const normT = (t: string) => t.toUpperCase().replace(/[^0-9A-Z]/g, "");
    const needMore = (e: Entry) => {
      const cs = e.codeTexts.map(normT).filter(Boolean);
      return !(new Set(cs).size < cs.length) || !agreed(e.countTexts.map((t) => parseCountPattern(t)));
    };
    for (const [pi, [target, thr, bin]] of ([[40, 0.5, false], [48, -1, false], [32, 0.4, true]] as const).entries()) {
      const sub = pi === 2 ? list.filter(needMore) : list;
      if (!sub.length) break;
      const st = chipStack(img, mk2(sub, (sp) => sp.top, (e) => list.indexOf(e)).map((c) => ({ ...c, inkThr: thr })), 1, target, thr, bin, true);
      const st2 = chipStack(img, mk2(sub, (sp) => sp.bottom, (e) => list.indexOf(e)).map((c) => ({ ...c, inkThr: thr })), 1, target, thr, bin, true);
      // 色号行 / 数量行互相独立：并发识别（worker 池）
      const [resTop, resBot] = await Promise.all([
        st.rows.length ? runOcr(st.image, "ABCDEFGHMPQRTYZ0123456789") : null,
        st2.rows.length ? runOcr(st2.image, "0123456789xX*") : null
      ]);
      if (resTop) for (const row of st.rows) list[row.chip.tag ?? -1].codeTexts.push(rowText(resTop.words, row.y0, row.y1));
      if (resBot) for (const row of st2.rows) list[row.chip.tag ?? -1].countTexts.push(rowText(resBot.words, row.y0, row.y1));
      for (const e of entries) e.code = null;
      resolveCodes(entries);
    }
    // 数量读数互相矛盾（或一个都没读到）的块：换几组参数再读几遍，多数票
    const countVals = (e: Entry) => e.countTexts.map((t) => parseCountPattern(t)).filter((n): n is number => n !== null);
    const weak = list.filter((e) => { const v = countVals(e); return v.length < 2 || new Set(v).size > 1; });
    if (weak.length) {
      for (const [target, thr, bin] of [[64, 0.35, true], [24, -1, false], [44, 0.3, false], [56, 0.6, true]] as const) {
        const st2 = chipStack(img, weak.map((e) => { const r = twoLine.get(e)!.bottom; return { x: r.x, y: r.y, width: r.width, height: r.height, r: e.chip.r, g: e.chip.g, b: e.chip.b, bg: [bg[0], bg[1], bg[2]] as [number, number, number], tag: weak.indexOf(e), inkThr: thr }; }), 1, target, thr, bin, true);
        if (st2.rows.length) { const res = await runOcr(st2.image, "0123456789xX*"); for (const row of st2.rows) weak[row.chip.tag ?? -1].countTexts.push(rowText(res.words, row.y0, row.y1)); }
      }
    }
  }
  const unresolved = () => entries.filter((e) => !e.code);
  // 色块里没有数量、旁边 / 下面也没有字（只有色号的色板）：不是带数量的图例，立刻放弃，别浪费 OCR 时间
  {
    const hasInline = (e: Entry) => e.codeTexts.some((x) => parseCodeCountText(x, VALID).count !== null || parseCodeCountText(x, VALID).glued.length);
    const withText = entries.filter((e) => e.below || e.right || e.label || hasInline(e) || e.countTexts.some((x) => parseCountPattern(x) !== null)).length;
    if (withText < 0.4 * entries.length) return gaveUp();
  }
  // 色块上方的抬头条带（读总数）与下面的读数互不相干：现在就开始识别，让它和后面的几遍并行（worker 池里另一个 worker）
  const topY = Math.min(...rows.map((r) => Math.min(...r.map((c) => c.y))));
  let stripP: Promise<{ text: string } | null> | null = null;
  if (topY >= 14 && !signal.aborted) {
    // 抬头文字紧贴在色块上方：条带很高（> 120）说明上面是图纸 / 标尺（读上几秒也读不出总数），只取紧邻色块的 80 行
    const h0 = topY - 1, W = img.width;
    const h = h0 > 120 ? 80 : h0;
    const strip = new Uint8ClampedArray(W * h * 4);
    strip.set(img.data.subarray((h0 - h) * W * 4, h0 * W * 4));
    stripP = ocrWords({ width: W, height: h, data: strip }, signal, { scale: h < 40 ? 2 : 1 }).then((r) => r, () => null);
  }
  // 色块里没有字（小方块 + 右边写“H7 (735)”的版式）：读色块右侧的整段文字，同时得到色号和数量（多遍识别，数量投票）
  const labelLayout = unresolved().length >= 0.4 * entries.length && entries.some((e) => e.label);
  if (labelLayout) {
    for (const [target, thr, bin] of [[24, -1, false], [28, -1, false], [20, -1, false]] as const) {
      // 已经有两遍读法一致的就不再读（省 OCR 时间）
      const u = entries.filter((e) => e.label && !(target === 20 && hurry() && agreed(e.codeTexts.map((t) => parseCodeCountText(t, VALID).count))));
      if (!u.length) break;
      const m = await readCounts(u, (e) => e.label, target, thr, bin, codeWl + "xX*");
      for (const [e, t] of m) e.codeTexts.push(t);
      resolveCodes(u);
      // 第一遍就读不出几个数量：这不是“色块 + 数量”的图例（只有色号的色板等），不必再读
      if (target === 24 && entries.filter((e) => e.codeTexts.some((x) => parseCodeCountText(x, VALID).count !== null || parseCodeCountText(x, VALID).glued.length)).length < 0.3 * entries.length) return gaveUp();
    }
  }
  // 色号 (数量) 写在一起的标签：按墨迹空隙切成两段，色号用色号白名单、数量用数字白名单各读几遍（多数票）
  if (labelLayout) {
    const parts = new Map<Entry, { code: Rc; count: Rc }>();
    for (const e of entries) if (e.label) { const sp = splitLabel(img, e.label, bg); if (sp) parts.set(e, sp); }
    if (parts.size >= Math.max(3, 0.5 * entries.filter((e) => e.label).length)) {
      const all = [...parts.keys()];
      for (const [target, thr, bin] of [[36, -1, false], [48, 0.4, true], [28, 0.5, false]] as const) {
        // 第三遍只给前两遍数量没对上的
        const list = target === 28 && hurry() ? all.filter((e) => !agreed(e.splitCounts)) : all;
        if (!list.length) break;
        const mc = await readCounts(list, (e) => parts.get(e)!.code, target, thr, bin, "ABCDEFGHMPQRTYZ0123456789");
        for (const [e, t] of mc) { e.codeTexts.push(t); e.splitCodes = true; }
        const mn = await readCounts(list, (e) => parts.get(e)!.count, target, thr, bin, "0123456789()");
        for (const [e, t] of mn) { const n = parseCountPattern(t); if (n !== null) e.splitCounts.push(n); }
      }
      resolveCodes(all);
    }
  }
  const late = () => performance.now() - t0 > 3000;
  // 色块里一个字母都没读到（没有印色号的图例）：换几组参数再读色号也读不出来，省掉这几遍
  const noLetters = entries.every((e) => !e.codeTexts.some((t) => /[A-Za-z]/.test(t)));
  if (unresolved().length && !late() && !(noLetters && unresolved().length === entries.length)) {
    const u = unresolved(); await readCodesPair(u, [56, 0.4, true], [32, 0.6, false]); resolveCodes(u);
    if (unresolved().length && !late()) { const u2 = unresolved(); await readCodes(u2, 72, 0.3, true); resolveCodes(u2); }
  }

  // 4) 数量字段：下方 / 右侧两种版式各读一遍，看哪边读得出“数量”（整张图例版式一致），再对胜出的版式用另一组参数补读一遍留备选
  const parsedN = (m: Map<Entry, string>) => [...m.values()].filter((t) => parseCountPattern(t) !== null).length;
  // 数量已经写在色块里 / 紧跟色号的文字里（“A26 (871)”“A1 · 154 颗”）：不再单独读下方 / 右侧
  const hasInline2 = (e: Entry) => e.codeTexts.some((x) => parseCodeCountText(x, VALID).count !== null || parseCodeCountText(x, VALID).glued.length);
  const inlineLayout = entries.filter(hasInline2).length >= 0.5 * entries.length;
  const skipRegions = labelLayout || inlineLayout;
  const [rb, rr] = skipRegions ? [new Map<Entry, string>(), new Map<Entry, string>()] : await Promise.all([readCounts(entries, (e) => e.below, 40, 0.5, false), readCounts(entries, (e) => e.right, 40, 0.5, false)]);
  const useBelow = parsedN(rb) >= parsedN(rr);
  // 下方 / 右侧都读不出数量、色块里也没有数量：只有色号的色板，不是带数量的图例
  if (!skipRegions && Math.max(parsedN(rb), parsedN(rr)) < Math.max(2, 0.3 * entries.length)
    && entries.filter((e) => e.codeTexts.some((x) => parseCodeCountText(x, VALID).count !== null || parseCodeCountText(x, VALID).glued.length) || e.countTexts.some((x) => parseCountPattern(x) !== null)).length < 0.3 * entries.length) return gaveUp();
  const first = useBelow ? rb : rr, other = useBelow ? rr : rb;
  const pickWin = (e: Entry) => (useBelow ? e.below : e.right);
  for (const e of entries) {
    const t = first.get(e);
    if (pickWin(e)) {
      e.where = useBelow ? "below" : "right"; e.countRect = pickWin(e);
      if (t !== undefined) e.countTexts.push(t);
      continue;
    }
    const t2 = other.get(e);
    if (t2 !== undefined && parseCountPattern(t2) !== null) { e.where = useBelow ? "right" : "below"; e.countRect = useBelow ? e.right : e.below; e.countTexts.push(t2); }
  }
  {
    // 补读只给读数还没有两遍一致的色块；两组参数互相独立，并发读
    const need = entries.filter((e) => e.countRect && !(hurry() && agreed(e.countTexts.map((t) => parseCountPattern(t)))));
    if (need.length && !skipRegions) {
      const [m1, m2] = await Promise.all([readCounts(need, (e) => e.countRect, 56, 0.4, true), readCounts(need, (e) => e.countRect, 36, -1, false)]);
      for (const m of [m1, m2]) for (const [e, t] of m) e.countTexts.push(t);
    }
  }
  for (const e of entries) {
    const vals: number[] = [];
    for (const t of e.countTexts) { const n = parseCountPattern(t); if (n !== null) vals.push(n); }
    // 色块里 / 旁边的整段文字（“A26 (871)”“B13 315”）里带的数量
    if (e.splitCounts.length >= 2) vals.length = 0, vals.push(...e.splitCounts);
    else for (const t of e.codeTexts) {
      const p = parseCodeCountText(t, VALID);
      if (p.count !== null) vals.push(p.count);
      else { const g = p.glued.find((x) => x.code === e.code); if (g) vals.push(g.count); }
    }
    if (!vals.length) continue;
    // 多数票；平票取第一遍
    const tally = new Map<number, number>();
    for (const v of vals) tally.set(v, (tally.get(v) ?? 0) + 1);
    // OCR 常把连着的两个相同数字读成一个（66→6）：长读数的得票加上“去掉一个重复数字就等于它”的短读数的票
    const score = new Map(tally);
    for (const [v, n] of tally) { const sv = String(v); for (let i = 1; i < sv.length; i += 1) if (sv[i] === sv[i - 1] && !(i === 1 && sv[0] === "1" && sv.length >= 4)) { const u = Number(sv.slice(0, i) + sv.slice(i + 1)); if (tally.has(u) && u !== v) score.set(v, (score.get(v) ?? 0) + (tally.get(u) ?? 0)); } void n; }
    const ranked = [...tally.entries()].sort((a, b) => (score.get(b[0]) ?? 0) - (score.get(a[0]) ?? 0) || vals.indexOf(a[0]) - vals.indexOf(b[0]));
    e.count = ranked[0][0];
    e.votes = ranked[0][1];
    e.countAlts = ranked.slice(1).map((r) => r[0]);
  }

  // 图例按数量从大到小排列的版式（happy拼豆嘛 等）：数量读数违反这个顺序的，换成顺序内可行的备选读法
  {
    const seq = entries.filter((e) => e.count !== null);
    let ok = 0;
    for (let i = 1; i < seq.length; i += 1) if ((seq[i].count as number) <= (seq[i - 1].count as number)) ok += 1;
    if (seq.length >= 6 && ok >= 0.8 * (seq.length - 1)) {
      for (let i = 0; i < seq.length; i += 1) {
        const e = seq[i];
        const hi = i > 0 ? (seq[i - 1].count as number) : Infinity;
        let lo = 0;
        for (let k = i + 1; k < seq.length; k += 1) if ((seq[k].count as number) <= hi) { lo = seq[k].count as number; break; }
        const n = e.count as number;
        if (n <= hi && n >= lo) continue;
        const strip = String(n).length === 4 ? [Number(String(n).slice(1)), Number(String(n).slice(0, 3))] : [];
        const alts = [...e.countAlts, ...strip, ...countAlternatives(n)].filter((v, k, a) => v >= lo && v <= hi && a.indexOf(v) === k);
        if (alts.length) { e.countAlts = [n, ...e.countAlts.filter((v) => v !== alts[0])]; e.count = alts[0]; }
      }
    }
  }

  // 5) 没读出色号的：按色块颜色找最近且未占用的色号（只对真实色块；隐形块不猜）
  const used = new Set<string>();
  // 同一色号出现两次：颜色更吻合的保留，另一个重新找
  const byCode = new Map<string, Entry[]>();
  for (const e of entries) if (e.code) byCode.set(e.code, [...(byCode.get(e.code) ?? []), e]);
  for (const [code, list] of byCode) {
    list.sort((a, b) => (a.dE ?? 99) - (b.dE ?? 99));
    for (const e of list.slice(1)) {
      const alt = e.codeAlts.find((c) => c !== code && !byCode.has(c));
      e.code = alt ?? null; e.dE = null;
    }
    used.add(code);
  }
  for (const e of entries) if (e.code) used.add(e.code);
  for (const e of entries) {
    if (e.code || e.synthetic) continue;
    const near = nearestCodesByColor({ r: e.chip.r, g: e.chip.g, b: e.chip.b }, [...VALID].filter((c) => !used.has(c)), colorOf, 12, 3);
    if (near.length) { e.code = near[0].code; e.dE = near[0].dE; e.guessed = true; e.codeAlts = near.map((n) => n.code); used.add(e.code); }
  }

  const items: LegendItem[] = [];
  const counts: Record<string, number> = {};
  const colors: Record<string, { r: number; g: number; b: number }> = {};
  const palette: NonNullable<LegendReading["palette"]> = [];
  const detail: ChipLegendResult["entries"] = [];
  // 大多数色块都读到数量时，按颜色猜号、又没数量的零散块多半是图例旁的徽标 / 水印，不算色块
  const dropUnread = entries.filter((e) => e.count !== null).length >= 0.5 * entries.length;
  for (const e of entries) {
    if (!e.code) continue;
    if (dropUnread && e.count === null && e.guessed) continue;
    const rgb = e.synthetic ? (colorOf(e.code) ?? { r: e.chip.r, g: e.chip.g, b: e.chip.b }) : { r: e.chip.r, g: e.chip.g, b: e.chip.b };
    colors[e.code] = rgb;
    palette.push({ code: e.code, rgb, count: e.count, ...(e.guessed ? { guessed: true } : {}) });
    detail.push({ code: e.code, count: e.count, countAlts: e.countAlts, codeAlts: e.codeAlts, dE: e.dE, guessed: e.guessed, where: e.where });
    if (e.count !== null && e.count > 0) {
      items.push({ code: e.code, count: e.count, source: "色块图例", votes: e.votes, ...(e.countAlts.length ? { alts: e.countAlts } : {}) });
      counts[e.code] = e.count;
    }
  }
  const raw = entries.map((e) => `${e.code ?? "?"}|${e.codeTexts.join("/")}|${e.countTexts.join("/")}`).join("\n").slice(0, 2000);
  // 色块上方的一条抬头（“颜色图例 | 共 10 色 | 总计 2127 颗”）：读出图上写的总数，供上层对账
  let statedTotal: number | null = null;
  {
    if (stripP && items.length >= 3 && !signal.aborted) {
      try { const res = await stripP; if (!res) throw new Error("none"); statedTotal = findStatedTotal(res.text);
        // 汉字读坏了（“总计 2127 颗”读成 “Bit 2127 %”）：取行尾的 3–5 位数字，且必须比已读到的各色之和大一点点（有的色没读到）而不是离谱
        if (statedTotal === null) {
          const m = /(\d{3,5})\D{0,3}\s*$/.exec(res.text.trim().split("\n").pop() ?? "");
          const sum = items.reduce((t, it) => t + it.count, 0);
          if (m && Number(m[1]) >= sum && Number(m[1]) <= 1.6 * sum + 300) statedTotal = Number(m[1]);
        }
      } catch { /* 读不到就没有 */ }
    }
  }
  return { items, counts, statedTotal, rawText: raw, colors, palette, chipCount: entries.length, confirmed: entries.filter((e) => e.code && !e.guessed && e.count !== null).length, entries: detail };
}

/** 至少有两遍读出同一个数（非空）：读数已经可信，不必再多读 */
function agreed(vals: Array<number | null | undefined>): boolean {
  const seen = new Set<number>();
  for (const v of vals) { if (v === null || v === undefined) continue; if (seen.has(v)) return true; seen.add(v); }
  return false;
}
