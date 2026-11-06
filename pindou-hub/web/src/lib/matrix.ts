// 图纸矩阵的压缩存储：色号字典 + 行内游程编码（RLE）。
// 3,000+ 格的矩阵直接 JSON 约 20–40 KB；压成一行字符串通常只要 2–6 KB，同步和 IndexedDB 都轻很多。
import type { Pattern } from "./model";

export type Matrix = Array<Array<string | null>>;
const MAX_CELLS = 400_000;

function runsOf(row: Array<string | null>): Array<[string | null, number]> {
  const out: Array<[string | null, number]> = [];
  for (const cell of row) {
    const last = out[out.length - 1];
    if (last && last[0] === cell) last[1] += 1;
    else out.push([cell, 1]);
  }
  return out;
}

/** 形如 `A1 A2 B3|0*4,~*2,1*10|...`：第一段是色号字典，之后每行用 `|` 分隔、每段用 `,` 分隔、`~` 表示空格。 */
export function encodeMatrix(matrix: Matrix): string {
  const codes: string[] = [];
  const seen = new Set<string>();
  for (const row of matrix) for (const cell of row) {
    if (cell && !seen.has(cell)) { seen.add(cell); codes.push(cell); }
  }
  codes.sort();
  const index = new Map(codes.map((code, i) => [code, i.toString(36)]));
  const body = matrix.map((row) => runsOf(row)
    .map(([cell, n]) => `${cell === null ? "~" : index.get(cell)}*${n}`)
    .join(",")).join("|");
  return `${codes.join(" ")}|${body}`;
}

export function decodeMatrix(text: string | undefined): Matrix | undefined {
  if (!text) return undefined;
  const bar = text.indexOf("|");
  if (bar < 0) return undefined;
  const codes = text.slice(0, bar) ? text.slice(0, bar).split(" ") : [];
  const body = text.slice(bar + 1);
  if (!body) return [];
  let cells = 0;
  const out: Matrix = [];
  for (const line of body.split("|")) {
    const row: Array<string | null> = [];
    if (line) {
      for (const token of line.split(",")) {
        const star = token.lastIndexOf("*");
        if (star <= 0) return undefined;
        const key = token.slice(0, star);
        const n = Number(token.slice(star + 1));
        if (!Number.isInteger(n) || n < 1) return undefined;
        cells += n;
        if (cells > MAX_CELLS) return undefined;
        const code = key === "~" ? null : codes[parseInt(key, 36)];
        if (key !== "~" && !code) return undefined;
        for (let i = 0; i < n; i += 1) row.push(code);
      }
    }
    out.push(row);
  }
  return out;
}

/** 新旧记录都兼容：老记录存 matrix，新记录存 matrixRle。 */
export function matrixOf(pattern: Pick<Pattern, "matrix" | "matrixRle">): Matrix | undefined {
  return pattern.matrix?.length ? pattern.matrix : decodeMatrix(pattern.matrixRle);
}
