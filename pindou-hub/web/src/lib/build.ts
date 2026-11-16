// 拼装模式的纯逻辑：分板、板内按色统计、完成标记的紧凑编码、进度与“下一步”状态机、按行游程。
// 不依赖 React / DOM，方便单测。坐标一律用整张图的坐标；格子下标 = y * width + x。
import type { Matrix } from "./matrix";
import { cleanTimeMap, mergeTimeMaps, sameTimeMap, type TimeMap } from "./buildTime";

export type BuildMode = "color" | "row";

/** 保存在图纸记录里的拼装进度（随图纸同步）。done 见 encodeDone。 */
export type BuildState = {
  boardSize: number; // 0 = 整张图一块板
  board: number;
  colorIndex: number;
  mode: BuildMode;
  done: string;
  updatedAt: number;
  /** 最近一次“清空重来”的时间（毫秒）。没有就是没清空过。合并时清空之前的进度一律作废，见 mergeBuild。 */
  resetAt?: number;
  /** 拼装用时：{ 设备短码: 该设备累计毫秒 }，合并时按设备取较大值再相加，见 lib/buildTime.ts。旧版本设备会忽略它。 */
  timeMs?: TimeMap;
};

export const BOARD_SIZES = [29, 52, 58, 0] as const;
export const DEFAULT_BOARD_SIZE = 29;

export type Board = { index: number; col: number; row: number; x0: number; y0: number; w: number; h: number };
export type ColorCount = { code: string; count: number };
export type Progress = { total: number; done: number; percent: number };
export type Step = { kind: "color" | "board" | "finished"; board: number; colorIndex: number };

export function boardSizeLabel(size: number): string {
  return size > 0 ? `${size}×${size}` : "整张图";
}

/** 按 size×size 切板，最后一列/行的板可以更小；size<=0 或不小于整图时只有一块。 */
export function splitBoards(width: number, height: number, size: number): Board[] {
  const w = Math.max(0, Math.floor(width));
  const h = Math.max(0, Math.floor(height));
  if (!w || !h) return [];
  const s = size > 0 && size < Math.max(w, h) ? Math.floor(size) : Math.max(w, h);
  const out: Board[] = [];
  let row = 0;
  for (let y0 = 0; y0 < h; y0 += s, row += 1) {
    let col = 0;
    for (let x0 = 0; x0 < w; x0 += s, col += 1) {
      out.push({ index: out.length, col, row, x0, y0, w: Math.min(s, w - x0), h: Math.min(s, h - y0) });
    }
  }
  return out;
}

export function cellAt(matrix: Matrix, x: number, y: number): string | null {
  return matrix[y]?.[x] ?? null;
}

/** 色号排序：字母前缀，再按数字（A2 < A10 < B1）。 */
export function compareCodes(a: string, b: string): number {
  const pa = /^([A-Za-z]*)(\d*)/.exec(a) ?? ["", "", ""];
  const pb = /^([A-Za-z]*)(\d*)/.exec(b) ?? ["", "", ""];
  if (pa[1] !== pb[1]) return pa[1] < pb[1] ? -1 : 1;
  const na = Number(pa[2] || 0);
  const nb = Number(pb[2] || 0);
  if (na !== nb) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 这块板上出现的颜色：颗数多的在前，同数按色号。 */
export function boardColors(matrix: Matrix, board: Board): ColorCount[] {
  const map = new Map<string, number>();
  for (let y = board.y0; y < board.y0 + board.h; y += 1) {
    for (let x = board.x0; x < board.x0 + board.w; x += 1) {
      const c = cellAt(matrix, x, y);
      if (c) map.set(c, (map.get(c) ?? 0) + 1);
    }
  }
  return [...map].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || compareCodes(a.code, b.code));
}

export function newFlags(width: number, height: number): Uint8Array {
  return new Uint8Array(Math.max(0, width * height));
}

/** 板内某色的所有格子（整图下标）。 */
export function boardCells(matrix: Matrix, width: number, board: Board, code: string): number[] {
  const out: number[] = [];
  for (let y = board.y0; y < board.y0 + board.h; y += 1) {
    for (let x = board.x0; x < board.x0 + board.w; x += 1) {
      if (cellAt(matrix, x, y) === code) out.push(y * width + x);
    }
  }
  return out;
}

function percentOf(done: number, total: number): number {
  return total > 0 ? Math.floor((done * 100) / total) : 0;
}

export function boardProgress(matrix: Matrix, flags: Uint8Array, width: number, board: Board, code?: string): Progress {
  let total = 0;
  let done = 0;
  for (let y = board.y0; y < board.y0 + board.h; y += 1) {
    for (let x = board.x0; x < board.x0 + board.w; x += 1) {
      const c = cellAt(matrix, x, y);
      if (!c || (code && c !== code)) continue;
      total += 1;
      if (flags[y * width + x]) done += 1;
    }
  }
  return { total, done, percent: percentOf(done, total) };
}

export function overallProgress(matrix: Matrix, flags: Uint8Array, width: number, height: number): Progress {
  let total = 0;
  let done = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!cellAt(matrix, x, y)) continue;
      total += 1;
      if (flags[y * width + x]) done += 1;
    }
  }
  return { total, done, percent: percentOf(done, total) };
}

/** 设置一批格子的完成状态，返回真正发生变化的下标（供撤销）。 */
export function setCells(flags: Uint8Array, indices: number[], value: boolean): number[] {
  const changed: number[] = [];
  const v = value ? 1 : 0;
  for (const i of indices) {
    if (i >= 0 && i < flags.length && flags[i] !== v) { flags[i] = v; changed.push(i); }
  }
  return changed;
}

function colorComplete(matrix: Matrix, flags: Uint8Array, width: number, board: Board, code: string): boolean {
  const p = boardProgress(matrix, flags, width, board, code);
  return p.done >= p.total;
}

/** 这色拼完后去哪：本板下一个没拼完的颜色 → 下一块没拼完的板 → 全部完成。 */
export function nextStep(matrix: Matrix, flags: Uint8Array, width: number, boards: Board[], boardIdx: number, colorIndex: number): Step {
  const cur = boards[boardIdx];
  if (cur) {
    const colors = boardColors(matrix, cur);
    for (let k = 1; k <= colors.length; k += 1) {
      const i = (colorIndex + k) % colors.length;
      if (i !== colorIndex && !colorComplete(matrix, flags, width, cur, colors[i].code)) return { kind: "color", board: boardIdx, colorIndex: i };
    }
  }
  for (let k = 1; k <= boards.length; k += 1) {
    const b = (boardIdx + k) % boards.length;
    if (b === boardIdx) continue;
    const colors = boardColors(matrix, boards[b]);
    const i = colors.findIndex((c) => !colorComplete(matrix, flags, width, boards[b], c.code));
    if (i >= 0) return { kind: "board", board: b, colorIndex: i };
  }
  return { kind: "finished", board: boardIdx, colorIndex };
}

/** 单纯切换颜色（不标记完成）。counts[b] = 第 b 块板的颜色数；跨板时落在新板的第一个/最后一个颜色，空板跳过。 */
export function moveColor(counts: number[], board: number, colorIndex: number, dir: 1 | -1): { board: number; colorIndex: number } | null {
  const n = counts[board] ?? 0;
  const next = colorIndex + dir;
  if (next >= 0 && next < n) return { board, colorIndex: next };
  for (let b = board + dir; b >= 0 && b < counts.length; b += dir) {
    if (counts[b] > 0) return { board: b, colorIndex: dir > 0 ? 0 : counts[b] - 1 };
  }
  return null;
}

/** 板内含某色的行（整图 y 坐标，升序）。 */
export function rowsWithColor(matrix: Matrix, board: Board, code: string): number[] {
  const out: number[] = [];
  for (let y = board.y0; y < board.y0 + board.h; y += 1) {
    for (let x = board.x0; x < board.x0 + board.w; x += 1) {
      if (cellAt(matrix, x, y) === code) { out.push(y); break; }
    }
  }
  return out;
}

/** 板内某行某色所在的列（整图 x 坐标，升序）。 */
export function rowColumns(matrix: Matrix, board: Board, code: string, y: number): number[] {
  const out: number[] = [];
  for (let x = board.x0; x < board.x0 + board.w; x += 1) if (cellAt(matrix, x, y) === code) out.push(x);
  return out;
}

/** 列位置转游程文字，列号从 1 起：[2,3,4,11,19,20] → "3–5、12、20–21"。 */
export function formatRuns(xs: number[]): string {
  const parts: string[] = [];
  let i = 0;
  while (i < xs.length) {
    let j = i;
    while (j + 1 < xs.length && xs[j + 1] === xs[j] + 1) j += 1;
    parts.push(j > i ? `${xs[i] + 1}–${xs[j] + 1}` : `${xs[i] + 1}`);
    i = j + 1;
  }
  return parts.join("、");
}

export function describeRow(y: number, xs: number[]): string {
  return `第 ${y + 1} 行：${formatRuns(xs)}`;
}

// ---------- 完成标记的编码 ----------
// 形如 `w30;A1=0-5,9,k;B2=…`：先记图宽，再按色号记完成格的整图下标（36 进制，连续区间写成 a-b）。
// 记下色号是为了图纸被改动后能逐格核对：色号变了的格子自动失去完成标记，其余保留；图宽变了会换算坐标。

function runsOf36(indices: number[]): string {
  const parts: string[] = [];
  let i = 0;
  while (i < indices.length) {
    let j = i;
    while (j + 1 < indices.length && indices[j + 1] === indices[j] + 1) j += 1;
    parts.push(j > i ? `${indices[i].toString(36)}-${indices[j].toString(36)}` : indices[i].toString(36));
    i = j + 1;
  }
  return parts.join(",");
}

export function encodeDone(matrix: Matrix, flags: Uint8Array, width: number, height: number): string {
  const byCode = new Map<string, number[]>();
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      if (!flags[i]) continue;
      const c = cellAt(matrix, x, y);
      if (!c) continue;
      let list = byCode.get(c);
      if (!list) { list = []; byCode.set(c, list); }
      list.push(i);
    }
  }
  const body = [...byCode.keys()].sort(compareCodes).map((c) => `${c}=${runsOf36(byCode.get(c)!)}`);
  return [`w${width}`, ...body].join(";");
}

/** 解码并对照当前图纸：越界、空格、色号已变的格子一律丢弃。 */
export function decodeDone(text: string | undefined, matrix: Matrix, width: number, height: number): Uint8Array {
  const flags = newFlags(width, height);
  if (!text) return flags;
  const parts = text.split(";");
  let oldW = width;
  let start = 0;
  if (/^w\d+$/.test(parts[0])) { oldW = Math.max(1, Number(parts[0].slice(1))); start = 1; }
  for (let p = start; p < parts.length; p += 1) {
    const eq = parts[p].indexOf("=");
    if (eq <= 0) continue;
    const code = parts[p].slice(0, eq);
    for (const token of parts[p].slice(eq + 1).split(",")) {
      if (!token) continue;
      const [a, b] = token.split("-");
      const lo = parseInt(a, 36);
      const hi = b === undefined ? lo : parseInt(b, 36);
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo || hi - lo > width * height * 4) continue;
      for (let old = lo; old <= hi; old += 1) {
        const x = old % oldW;
        const y = Math.floor(old / oldW);
        if (x >= width || y >= height) continue;
        if (cellAt(matrix, x, y) === code) flags[y * width + x] = 1;
      }
    }
  }
  return flags;
}

/** 图纸被改动后把已有标记迁到新矩阵上（等价于按旧图编码再按新图解码）。 */
export function migrateFlags(oldMatrix: Matrix, oldFlags: Uint8Array, oldW: number, oldH: number, newMatrix: Matrix, newW: number, newH: number): Uint8Array {
  return decodeDone(encodeDone(oldMatrix, oldFlags, oldW, oldH), newMatrix, newW, newH);
}

/** 读取已保存的进度并校正越界的位置。 */
export function restoreState(saved: BuildState | undefined, boards: Board[], boardSize: number): { board: number; colorIndex: number; mode: BuildMode } {
  if (!saved || saved.boardSize !== boardSize) return { board: 0, colorIndex: 0, mode: saved?.mode === "row" ? "row" : "color" };
  const board = Math.min(Math.max(0, Math.floor(saved.board) || 0), Math.max(0, boards.length - 1));
  return { board, colorIndex: Math.max(0, Math.floor(saved.colorIndex) || 0), mode: saved.mode === "row" ? "row" : "color" };
}

/** 第一块有未拼格子的板；全部完成返回 0。 */
export function firstOpenBoard(matrix: Matrix, flags: Uint8Array, width: number, boards: Board[]): number {
  const i = boards.findIndex((b) => { const p = boardProgress(matrix, flags, width, b); return p.total > 0 && p.done < p.total; });
  return i < 0 ? 0 : i;
}

// ---------- 两台设备合并进度 ----------
// 记录整条按“后写者胜”同步，所以两台设备各拼一部分时，后上传的会盖掉先上传的。
// 拼装进度只会往前走：合并时取两边已完成格子的并集；唯一的例外是“清空重来”，它用 resetAt 标记，
// 比较时 resetAt 更大的一方说了算（更早的进度作废）。老版本设备写回记录时会丢掉 resetAt，
// 那种记录按“拼装时间是否晚于清空时间”判断是不是清空之后的新进度。

type ParsedDone = { width: number | null; cells: Map<string, Set<number>> };

const MAX_RUN = 4_000_000;

function parseDone(text: string | undefined): ParsedDone {
  const out: ParsedDone = { width: null, cells: new Map() };
  if (!text) return out;
  const parts = text.split(";");
  let start = 0;
  if (/^w\d+$/.test(parts[0])) { out.width = Math.max(1, Number(parts[0].slice(1))); start = 1; }
  for (let p = start; p < parts.length; p += 1) {
    const eq = parts[p].indexOf("=");
    if (eq <= 0) continue;
    const code = parts[p].slice(0, eq);
    let set = out.cells.get(code);
    if (!set) { set = new Set(); out.cells.set(code, set); }
    for (const token of parts[p].slice(eq + 1).split(",")) {
      if (!token) continue;
      const [a, b] = token.split("-");
      const lo = parseInt(a, 36);
      const hi = b === undefined ? lo : parseInt(b, 36);
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo || lo < 0 || hi - lo > MAX_RUN) continue;
      for (let i = lo; i <= hi; i += 1) set.add(i);
    }
  }
  return out;
}

function formatDone(width: number | null, cells: Map<string, Set<number>>): string {
  const body = [...cells.keys()].filter((c) => cells.get(c)!.size > 0).sort(compareCodes)
    .map((c) => `${c}=${runsOf36([...cells.get(c)!].sort((x, y) => x - y))}`);
  return [...(width ? [`w${width}`] : []), ...body].join(";");
}

/** 把一串 done 文本规范化（排序、合并连续区间），结果与 encodeDone 的格式一致。 */
export function normalizeDone(text: string | undefined): string {
  const p = parseDone(text);
  return formatDone(p.width, p.cells);
}

/** 两份 done 的并集。图宽不同（图纸被改过）无法按下标合并，返回 null。 */
export function unionDone(a: string | undefined, b: string | undefined): string | null {
  const pa = parseDone(a);
  const pb = parseDone(b);
  if (pa.width && pb.width && pa.width !== pb.width) return null;
  const cells = new Map<string, Set<number>>();
  for (const src of [pa, pb]) {
    for (const [code, set] of src.cells) {
      let t = cells.get(code);
      if (!t) { t = new Set(); cells.set(code, t); }
      for (const i of set) t.add(i);
    }
  }
  return formatDone(pa.width ?? pb.width, cells);
}

export function isBuildState(v: unknown): v is BuildState {
  if (!v || typeof v !== "object") return false;
  const b = v as Record<string, unknown>;
  return typeof b.done === "string" && typeof b.updatedAt === "number" && Number.isFinite(b.updatedAt)
    && typeof b.boardSize === "number" && typeof b.board === "number" && typeof b.colorIndex === "number";
}

function tieKey(b: BuildState): string {
  return `${b.boardSize}|${b.board}|${b.colorIndex}|${b.mode}|${b.done}`;
}

function newerOf(a: BuildState, b: BuildState): BuildState {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
  return tieKey(a) >= tieKey(b) ? a : b;
}

/**
 * 合并两份拼装进度：已完成格子取并集，清空重来（resetAt）更晚的一方说了算；
 * 当前板/颜色/模式取更新的一方。满足交换律和幂等：merge(a,b)=merge(b,a)，merge(m,m)=m。
 */
export function mergeBuild(a: BuildState | undefined, b: BuildState | undefined): BuildState | undefined {
  if (!a || !b) return a ?? b;
  const ra = a.resetAt ?? 0;
  const rb = b.resetAt ?? 0;
  const reset = Math.max(ra, rb);
  const alive = (x: BuildState): boolean => {
    if (reset === 0) return true;
    if (x.resetAt === undefined) return x.updatedAt > reset; // 老版本写回的记录：看它是不是清空之后才拼的
    return x.resetAt === reset;
  };
  const sources = [a, b].filter(alive);
  const pool = sources.length ? sources : [newerOf(a, b)];
  const newest = pool.reduce(newerOf);
  let done = newest.done;
  const timeMs = pool.length === 2 ? mergeTimeMaps(pool[0].timeMs, pool[1].timeMs) : cleanTimeMap(newest.timeMs);
  if (pool.length === 2) {
    const u = unionDone(pool[0].done, pool[1].done);
    done = u ?? newest.done;
  } else {
    done = normalizeDone(newest.done);
  }
  const out: BuildState = {
    boardSize: newest.boardSize, board: newest.board, colorIndex: newest.colorIndex, mode: newest.mode,
    done, updatedAt: Math.max(a.updatedAt, b.updatedAt)
  };
  if (reset > 0) out.resetAt = reset;
  if (timeMs) out.timeMs = timeMs;
  return out;
}

/** 两份进度的内容是否相同（比较前先规范化 done）。 */
export function sameBuild(a: BuildState | undefined, b: BuildState | undefined): boolean {
  if (!a || !b) return a === b;
  return a.boardSize === b.boardSize && a.board === b.board && a.colorIndex === b.colorIndex && a.mode === b.mode
    && (a.resetAt ?? 0) === (b.resetAt ?? 0) && normalizeDone(a.done) === normalizeDone(b.done) && sameTimeMap(a.timeMs, b.timeMs);
}

// ---------- 拖动连续标记 ----------

/** 两个格子之间（含两端）经过的格子，供手指划过时不漏格；(x0,y0)→(x1,y1) 按格直线插值。 */
export function cellsBetween(x0: number, y0: number, x1: number, y1: number): Array<[number, number]> {
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  const out: Array<[number, number]> = [];
  for (let i = 0; i <= n; i += 1) {
    const t = n === 0 ? 0 : i / n;
    out.push([Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t)]);
  }
  return out;
}
