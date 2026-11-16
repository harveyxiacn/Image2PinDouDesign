// 分板打印的纯逻辑：页面清单、每板用量、范围选择、镜像坐标、纸张排版、字色与符号。
// 不依赖 React / DOM，方便单测。分板直接复用 lib/build.ts 的 splitBoards（只读），板号 = board.index + 1。
import { boardColors, compareCodes, splitBoards, type Board, type ColorCount } from "./build";
import type { Matrix } from "./matrix";
import { labelTextColor } from "./matrixLabels";

export type PrintStyle = "fill" | "code" | "symbol";
export type PaperSize = "a4" | "letter";
export type Orientation = "portrait" | "landscape";
export type PrintScope = "all" | "range";

export type PrintOptions = {
  boardSize: number; // 0 = 整张图一块板
  scope: PrintScope;
  rangeText: string;
  overview: boolean;
  style: PrintStyle;
  paper: PaperSize;
  orientation: Orientation;
  mirror: boolean;
};

export const PRINT_BOARD_SIZES = [15, 20, 29, 36, 52, 58, 0] as const;

export const DEFAULT_PRINT_OPTIONS: PrintOptions = {
  boardSize: 29, scope: "all", rangeText: "", overview: true, style: "fill", paper: "a4", orientation: "portrait", mirror: false
};

export type PlanBoard = {
  board: Board;
  /** 板号，从 1 起，与拼装模式一致（按行优先）。 */
  number: number;
  /** 行-列，如 “2-3”。 */
  label: string;
  counts: ColorCount[];
  total: number;
};

export type PrintPlan = {
  allBoards: Board[];
  /** 要打印的非空板（已按范围筛选）。 */
  boards: PlanBoard[];
  /** 被跳过的空板板号。 */
  skippedEmpty: number[];
  /** 整张图的用量（颗数多的在前）。 */
  totals: ColorCount[];
  total: number;
  boardCols: number;
  boardRows: number;
  rangeError?: string;
};

export function boardLabel(board: Board): string {
  return `${board.row + 1}-${board.col + 1}`;
}

/** “2-5, 8,10-” → 板号集合（1 起，最大 max）。写错的片段会被忽略并返回 error。 */
export function parseRange(text: string, max: number): { numbers: number[]; error?: string } {
  const set = new Set<number>();
  let bad = false;
  const parts = text.normalize("NFKC").replace(/[，、;；\s]+/g, ",").replace(/[~～—–－]/g, "-").split(",").filter(Boolean);
  for (const part of parts) {
    const m = /^(\d*)-(\d*)$/.exec(part) ?? /^(\d+)$/.exec(part);
    if (!m) { bad = true; continue; }
    let a: number; let b: number;
    if (m.length === 2) { a = b = Number(m[1]); } else {
      if (!m[1] && !m[2]) { bad = true; continue; }
      a = m[1] ? Number(m[1]) : 1;
      b = m[2] ? Number(m[2]) : max;
    }
    if (a > b) [a, b] = [b, a];
    if (a < 1 || b > max) bad = true;
    for (let n = Math.max(1, a); n <= Math.min(max, b); n += 1) set.add(n);
  }
  const numbers = [...set].sort((x, y) => x - y);
  return { numbers, error: bad ? "范围里有无法识别或超出板数的部分，已忽略" : undefined };
}

/** 生成打印页面清单。rangeText 为 undefined 表示全部板；空板不出页。 */
export function planPrint(matrix: Matrix, width: number, height: number, boardSize: number, rangeText?: string): PrintPlan {
  const allBoards = splitBoards(width, height, boardSize);
  const boardCols = allBoards.length ? Math.max(...allBoards.map((b) => b.col)) + 1 : 0;
  const boardRows = allBoards.length ? Math.max(...allBoards.map((b) => b.row)) + 1 : 0;
  let wanted: Set<number> | null = null;
  let rangeError: string | undefined;
  if (rangeText !== undefined) {
    const r = parseRange(rangeText, allBoards.length);
    wanted = new Set(r.numbers);
    rangeError = r.error;
  }
  const boards: PlanBoard[] = [];
  const skippedEmpty: number[] = [];
  const totalMap = new Map<string, number>();
  for (const board of allBoards) {
    const counts = boardColors(matrix, board);
    const total = counts.reduce((s, c) => s + c.count, 0);
    for (const c of counts) totalMap.set(c.code, (totalMap.get(c.code) ?? 0) + c.count);
    const number = board.index + 1;
    if (wanted && !wanted.has(number)) continue;
    if (!total) { skippedEmpty.push(number); continue; }
    boards.push({ board, number, label: boardLabel(board), counts, total });
  }
  const totals = [...totalMap].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || compareCodes(a.code, b.code));
  return { allBoards, boards, skippedEmpty, totals, total: totals.reduce((s, c) => s + c.count, 0), boardCols, boardRows, rangeError };
}

/** 纸面第 i 列显示的是板内第几列（镜像时左右反过来）。 */
export function displayColumns(w: number, mirror: boolean): number[] {
  const out = Array.from({ length: w }, (_, i) => i);
  return mirror ? out.reverse() : out;
}

/** 边上的列号（板内 1 起；镜像时从大到小）。 */
export function axisLabels(w: number, mirror: boolean): number[] {
  return displayColumns(w, mirror).map((x) => x + 1);
}

/** 纸面上第 d 条竖线（0..w）是否是“每 5 格”的粗线：按板内从左数的格数算，镜像后仍对应真实板的 5 的倍数。 */
export function heavyBoundaries(w: number, mirror: boolean): boolean[] {
  return Array.from({ length: w + 1 }, (_, d) => { const b = mirror ? w - d : d; return b > 0 && b < w && b % 5 === 0; });
}
export function heavyRows(h: number): boolean[] {
  return Array.from({ length: h + 1 }, (_, b) => b > 0 && b < h && b % 5 === 0);
}

/** 整图上板的纸面列位置（镜像时板的列也左右反过来）。 */
export function displayBoardCol(col: number, boardCols: number, mirror: boolean): number {
  return mirror ? boardCols - 1 - col : col;
}

export function textColorFor(hex: string | undefined, style: PrintStyle): string {
  // 只印色号 / 符号的样式没有底色，一律黑字；有底色按亮度选黑白
  return style === "fill" ? labelTextColor(hex) : "#111111";
}

/** 符号表：按整图颗数从多到少依次分配；超过符号数的色号回退用色号文字（返回 undefined）。 */
export const SYMBOLS = [
  "●", "■", "▲", "◆", "★", "✚", "✖", "○", "□", "△", "◇", "☆", "♥", "♣", "♠", "♦",
  "◐", "◑", "▼", "◀", "▶", "◢", "◣", "◤", "◥", "✿", "❖", "✦", "✧", "※", "＃", "＠",
  "＆", "＄", "％", "＋", "＝", "？", "！", "Ω", "Σ", "Δ", "Π", "Ψ", "Ξ", "Λ", "Φ", "Γ"
];
export function symbolMap(totals: ColorCount[]): Map<string, string> {
  const map = new Map<string, string>();
  totals.forEach((c, i) => { if (i < SYMBOLS.length) map.set(c.code, SYMBOLS[i]); });
  return map;
}

const PAPER_MM: Record<PaperSize, [number, number]> = { a4: [210, 297], letter: [215.9, 279.4] };
export const PAGE_MARGIN_MM = 10;
const HEADER_MM = 16;
const AXIS_MM = 6;
const MAX_CELL_MM = 10;

export type Layout = {
  pageW: number; pageH: number; margin: number;
  cellMm: number; gridW: number; gridH: number;
  /** 横向纸张时右侧放小地图与用量，纵向放在图下面。 */
  side: boolean;
};

export function pageMm(paper: PaperSize, orientation: Orientation): { w: number; h: number } {
  const [w, h] = PAPER_MM[paper];
  return orientation === "landscape" ? { w: h, h: w } : { w, h };
}

/** 一块板在一页里的格子大小（毫米）：纵向图在上、信息在下；横向图在左、信息在右。 */
export function boardLayout(paper: PaperSize, orientation: Orientation, w: number, h: number): Layout {
  const { w: pageW, h: pageH } = pageMm(paper, orientation);
  const side = orientation === "landscape";
  const innerW = pageW - 2 * PAGE_MARGIN_MM - AXIS_MM;
  const innerH = pageH - 2 * PAGE_MARGIN_MM - HEADER_MM - AXIS_MM;
  const availW = side ? innerW - 72 : innerW;
  const availH = side ? innerH : innerH - 62;
  const cellMm = Math.max(1, Math.min(MAX_CELL_MM, availW / Math.max(1, w), availH / Math.max(1, h)));
  return { pageW, pageH, margin: PAGE_MARGIN_MM, cellMm, gridW: cellMm * w, gridH: cellMm * h, side };
}

/** 总览页里整张图的格子大小（毫米），给图例留出下半页。 */
export function overviewLayout(paper: PaperSize, orientation: Orientation, w: number, h: number): Layout {
  const { w: pageW, h: pageH } = pageMm(paper, orientation);
  const availW = pageW - 2 * PAGE_MARGIN_MM;
  const availH = (pageH - 2 * PAGE_MARGIN_MM - HEADER_MM) * (orientation === "landscape" ? 0.62 : 0.6);
  const cellMm = Math.max(0.5, Math.min(MAX_CELL_MM, availW / Math.max(1, w), availH / Math.max(1, h)));
  return { pageW, pageH, margin: PAGE_MARGIN_MM, cellMm, gridW: cellMm * w, gridH: cellMm * h, side: false };
}

/** 页数（总览 + 每块非空板），供界面显示。 */
export function pageCount(plan: PrintPlan, overview: boolean): number {
  return plan.boards.length + (overview ? 1 : 0);
}
