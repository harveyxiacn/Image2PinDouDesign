import { describe, expect, it } from "vitest";
import {
  boardCells, boardColors, boardProgress, decodeDone, describeRow, encodeDone, firstOpenBoard, formatRuns, migrateFlags,
  moveColor, newFlags, nextStep, overallProgress, rowColumns, rowsWithColor, setCells, splitBoards,
  cellsBetween, mergeBuild, normalizeDone, sameBuild, unionDone, type BuildState
} from "../lib/build";
import type { Matrix } from "../lib/matrix";

function grid(w: number, h: number, f: (x: number, y: number) => string | null): Matrix {
  return Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) => f(x, y)));
}

describe("splitBoards", () => {
  it("splits with ragged last boards", () => {
    const boards = splitBoards(60, 35, 29);
    expect(boards).toHaveLength(6);
    expect(boards[2]).toMatchObject({ col: 2, row: 0, x0: 58, w: 2, h: 29 });
    expect(boards[5]).toMatchObject({ col: 2, row: 1, x0: 58, y0: 29, w: 2, h: 6 });
    expect(boards.reduce((s, b) => s + b.w * b.h, 0)).toBe(60 * 35);
  });
  it("whole chart / oversized board is one board", () => {
    expect(splitBoards(40, 30, 0)).toHaveLength(1);
    expect(splitBoards(20, 20, 29)).toHaveLength(1);
    expect(splitBoards(0, 5, 29)).toEqual([]);
  });
});

describe("boardColors / progress", () => {
  const m = grid(4, 2, (x, y) => (y === 0 ? (x < 3 ? "B2" : "A1") : x === 0 ? null : "A1"));
  const [b] = splitBoards(4, 2, 0);
  it("sorts by count desc then code", () => {
    expect(boardColors(m, b)).toEqual([{ code: "A1", count: 4 }, { code: "B2", count: 3 }]);
    const tie = grid(2, 1, (x) => (x ? "A10" : "A2"));
    expect(boardColors(tie, splitBoards(2, 1, 0)[0]).map((c) => c.code)).toEqual(["A2", "A10"]);
  });
  it("computes percentages", () => {
    const flags = newFlags(4, 2);
    expect(overallProgress(m, flags, 4, 2)).toEqual({ total: 7, done: 0, percent: 0 });
    setCells(flags, boardCells(m, 4, b, "B2"), true);
    expect(overallProgress(m, flags, 4, 2)).toEqual({ total: 7, done: 3, percent: 42 });
    expect(boardProgress(m, flags, 4, b, "B2").percent).toBe(100);
    setCells(flags, boardCells(m, 4, b, "A1"), true);
    expect(overallProgress(m, flags, 4, 2).percent).toBe(100);
  });
  it("setCells reports only real changes", () => {
    const f = newFlags(3, 1);
    expect(setCells(f, [0, 1], true)).toEqual([0, 1]);
    expect(setCells(f, [1, 2], true)).toEqual([2]);
    expect(setCells(f, [9], true)).toEqual([]);
  });
});

describe("encodeDone / decodeDone", () => {
  const m = grid(40, 30, (x, y) => ((x + y) % 7 === 0 ? null : ["A1", "B2", "C10"][(x * 3 + y) % 3]));
  it("round-trips", () => {
    const flags = newFlags(40, 30);
    for (let i = 0; i < flags.length; i += 1) if ((i * 7) % 5 < 2 || (i > 100 && i < 200)) flags[i] = 1;
    const text = encodeDone(m, flags, 40, 30);
    const back = decodeDone(text, m, 40, 30);
    // 空格不会被保存
    for (let i = 0; i < flags.length; i += 1) {
      const empty = m[Math.floor(i / 40)][i % 40] === null;
      expect(back[i]).toBe(empty ? 0 : flags[i]);
    }
    expect(text.length).toBeLessThan(flags.length * 2);
  });
  it("empty / garbage input is safe", () => {
    expect(decodeDone(undefined, m, 40, 30).every((v) => v === 0)).toBe(true);
    expect(decodeDone("w40;A1=zz-1;=;B2=", m, 40, 30).every((v) => v === 0)).toBe(true);
  });
  it("drops cells whose code changed, keeps others", () => {
    const flags = newFlags(40, 30);
    const keep = [1, 2, 3, 4].map((x) => 5 * 40 + x).filter((i) => m[5][i % 40]);
    setCells(flags, keep, true);
    const edited = m.map((r) => r.slice());
    const changed = keep[0];
    edited[5][changed % 40] = edited[5][changed % 40] === "A1" ? "B2" : "A1";
    const back = migrateFlags(m, flags, 40, 30, edited, 40, 30);
    expect(back[changed]).toBe(0);
    for (const i of keep.slice(1)) expect(back[i]).toBe(1);
  });
  it("remaps when the chart width changes", () => {
    const small = grid(3, 2, () => "A1");
    const flags = newFlags(3, 2);
    flags[3 + 1] = 1; // (1,1)
    const wide = grid(5, 2, () => "A1");
    const back = migrateFlags(small, flags, 3, 2, wide, 5, 2);
    expect(back[5 + 1]).toBe(1);
    expect(back.reduce((s, v) => s + v, 0)).toBe(1);
  });
});

describe("nextStep / moveColor", () => {
  // 两块 2×1 的板：板0 = A1,B2 ；板1 = A1
  const m: Matrix = [["A1", "B2", "A1", "A1"]];
  const boards = splitBoards(4, 1, 2);
  it("advances colour, then board, then finishes", () => {
    const flags = newFlags(4, 1);
    expect(boardColors(m, boards[0]).map((c) => c.code)).toEqual(["A1", "B2"]);
    setCells(flags, [0], true);
    expect(nextStep(m, flags, 4, boards, 0, 0)).toEqual({ kind: "color", board: 0, colorIndex: 1 });
    setCells(flags, [1], true);
    expect(nextStep(m, flags, 4, boards, 0, 1)).toEqual({ kind: "board", board: 1, colorIndex: 0 });
    setCells(flags, [2, 3], true);
    expect(nextStep(m, flags, 4, boards, 1, 0).kind).toBe("finished");
  });
  it("wraps back to an unfinished earlier colour", () => {
    const flags = newFlags(4, 1);
    setCells(flags, [1], true);
    expect(nextStep(m, flags, 4, boards, 0, 1)).toEqual({ kind: "color", board: 0, colorIndex: 0 });
  });
  it("moveColor crosses boards and skips empty ones", () => {
    expect(moveColor([2, 0, 3], 0, 1, 1)).toEqual({ board: 2, colorIndex: 0 });
    expect(moveColor([2, 0, 3], 2, 0, -1)).toEqual({ board: 0, colorIndex: 1 });
    expect(moveColor([2], 0, 0, -1)).toBeNull();
    expect(moveColor([2], 0, 1, 1)).toBeNull();
  });
  it("firstOpenBoard", () => {
    const flags = newFlags(4, 1);
    setCells(flags, [0, 1], true);
    expect(firstOpenBoard(m, flags, 4, boards)).toBe(1);
  });
});

describe("row runs", () => {
  it("formats runs with 1-based columns", () => {
    expect(formatRuns([2, 3, 4, 11, 19, 20])).toBe("3–5、12、20–21");
    expect(formatRuns([])).toBe("");
    expect(formatRuns([0])).toBe("1");
  });
  it("finds rows and columns within a board", () => {
    const m = grid(6, 3, (x, y) => (y === 1 && x !== 3 ? "H7" : "A1"));
    const [b] = splitBoards(6, 3, 0);
    expect(rowsWithColor(m, b, "H7")).toEqual([1]);
    const xs = rowColumns(m, b, "H7", 1);
    expect(xs).toEqual([0, 1, 2, 4, 5]);
    expect(describeRow(1, xs)).toBe("第 2 行：1–3、5–6");
  });
});

const bs = (done: string, updatedAt: number, extra: Partial<BuildState> = {}): BuildState => ({ boardSize: 29, board: 0, colorIndex: 0, mode: "color", done, updatedAt, ...extra });

describe("mergeBuild", () => {
  it("unions cells of two devices per colour", () => {
    const a = bs("w10;A1=0-3,9", 100);
    const b = bs("w10;A1=2-5;B2=a", 200, { board: 1 });
    const m = mergeBuild(a, b)!;
    expect(m.done).toBe("w10;A1=0-5,9;B2=a");
    expect(m.board).toBe(1); // 位置取更新的一方
    expect(m.updatedAt).toBe(200);
    expect(m.resetAt).toBeUndefined();
  });
  it("is commutative, idempotent and keeps progress monotone", () => {
    const cases: Array<[BuildState, BuildState]> = [
      [bs("w10;A1=0-3", 5), bs("w10;A1=2-9;C3=1", 5, { mode: "row" })],
      [bs("w10;A1=0-3", 5, { resetAt: 4 }), bs("w10;A1=2-9", 6)],
      [bs("w10;A1=0-3", 5, { resetAt: 9 }), bs("w10;A1=2-9", 6, { resetAt: 4 })],
      [bs("w10;A1=0-3", 5), bs("w12;A1=2-9", 6)],
      [bs("w10;B1=3,2,1", 7), bs("w10;B1=1-3", 7)]
    ];
    for (const [a, b] of cases) {
      const ab = mergeBuild(a, b)!;
      expect(ab).toEqual(mergeBuild(b, a));
      expect(mergeBuild(ab, ab)).toEqual(ab);
      expect(mergeBuild(ab, a)).toEqual(ab);
      expect(mergeBuild(ab, b)).toEqual(ab);
    }
  });
  it("an explicit reset wins over older progress, newer progress after it survives", () => {
    const reset = bs("w10", 300, { resetAt: 300 });
    const stale = bs("w10;A1=0-5", 250); // 老设备在清空前拼的（老版本写回，无 resetAt）
    expect(mergeBuild(reset, stale)!.done).toBe("w10");
    const stale2 = bs("w10;A1=0-5", 250, { resetAt: 0 });
    expect(mergeBuild({ ...stale2, resetAt: undefined }, reset)!.done).toBe("w10");
    const after = bs("w10;A1=7", 400, { resetAt: 300 });
    expect(mergeBuild(reset, after)!.done).toBe("w10;A1=7");
    expect(mergeBuild(reset, after)!.resetAt).toBe(300);
    const legacyAfter = bs("w10;A1=7", 400); // 老版本在清空之后继续拼
    expect(mergeBuild(reset, legacyAfter)!.done).toBe("w10;A1=7");
    expect(mergeBuild(bs("w10;A1=0-5", 250, { resetAt: 100 }), reset)!.done).toBe("w10");
  });
  it("different chart widths fall back to the newer side", () => {
    expect(mergeBuild(bs("w10;A1=0-3", 5), bs("w12;A1=2", 6))!.done).toBe("w12;A1=2");
  });
  it("handles missing sides and junk", () => {
    const a = bs("w10;A1=0", 1);
    expect(mergeBuild(a, undefined)).toBe(a);
    expect(mergeBuild(undefined, a)).toBe(a);
    expect(unionDone("w10;A1=zz-0,!;=5", "w10;A1=1")).toBe("w10;A1=1");
    expect(normalizeDone("w4;A1=3,1,2,0")).toBe("w4;A1=0-3");
  });
  it("sameBuild ignores encoding order", () => {
    expect(sameBuild(bs("w4;A1=0-3", 1), bs("w4;A1=3,2,1,0", 9))).toBe(true);
    expect(sameBuild(bs("w4;A1=0-3", 1), bs("w4;A1=0-2", 1))).toBe(false);
  });
});

describe("cellsBetween", () => {
  it("covers every step of a fast swipe", () => {
    expect(cellsBetween(0, 0, 3, 0)).toEqual([[0, 0], [1, 0], [2, 0], [3, 0]]);
    expect(cellsBetween(2, 2, 2, 2)).toEqual([[2, 2]]);
    const d = cellsBetween(0, 0, 4, 2);
    expect(d[0]).toEqual([0, 0]);
    expect(d[d.length - 1]).toEqual([4, 2]);
    expect(d).toHaveLength(5);
  });
});
