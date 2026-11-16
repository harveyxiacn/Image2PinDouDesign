import { describe, expect, it } from "vitest";
import type { Pattern, Txn } from "../lib/model";
import {
  buildDurationMs, collectWorks, completedPattern, dateInputValue, durationLabel, filterOptions, filterWorks, groupByMonth, monthlyDone,
  parseDateInput, sanitizeEntry, withWorkAdded, withWorkPatch, withWorkRemoved, workTotals, worksOf
} from "../lib/worklog";

function pat(id: string, extra: Partial<Pattern> = {}): Pattern {
  return { id, name: id, kind: "manual", method: "manual", counts: { A1: 10, A2: 5 }, status: "planned", copies: 1, tags: [], notes: "", createdAt: 1, updatedAt: 10, ...extra };
}
const d = (y: number, m: number, day: number, h = 12) => new Date(y, m - 1, day, h).getTime();

describe("entries", () => {
  it("sanitizes fields and rejects invalid ones", () => {
    expect(sanitizeEntry(null)).toBeNull();
    expect(sanitizeEntry({ id: "x", at: 0 })).toBeNull();
    expect(sanitizeEntry({ id: "x", at: 5, rating: 9, note: "  hi ", tag: " ", durationMs: -1, photoId: "" })).toEqual({ id: "x", at: 5, rating: 5, note: "hi" });
  });
  it("completedPattern appends and keeps earlier completions (finish again)", () => {
    const first = completedPattern(pat("a", { copies: 2 }), { at: d(2026, 3, 1) }, { id: "w1", now: 100 });
    expect(first.status).toBe("done");
    expect(first.works).toEqual([{ id: "w1", at: d(2026, 3, 1), copies: 2, createdAt: 100 }]);
    const again = completedPattern({ ...first, status: "making" }, { at: d(2026, 5, 1), note: "再拼一份" }, { id: "w2", now: 200 });
    expect(worksOf(again).map((e) => e.id)).toEqual(["w2", "w1"]);
    expect(again.updatedAt).toBeGreaterThan(first.updatedAt);
  });
  it("patch, add and remove", () => {
    const p = completedPattern(pat("a"), { at: 1000 }, { id: "w1", now: 100 });
    const edited = withWorkPatch(p, "w1", { rating: 4, tag: "给妈妈" }, 300);
    expect(edited.works![0]).toMatchObject({ rating: 4, tag: "给妈妈", at: 1000 });
    expect(withWorkAdded(pat("b", { status: "done" }), { at: 50 }, { id: "n" }).works).toHaveLength(1);
    expect(withWorkRemoved(edited, "w1", 400).works).toBeUndefined();
  });
  it("reads build duration loosely", () => {
    expect(buildDurationMs(undefined)).toBeUndefined();
    expect(buildDurationMs({ done: "" })).toBeUndefined();
    expect(buildDurationMs({ activeMs: 90000 })).toBe(90000);
    expect(durationLabel(45 * 60000)).toBe("45 分钟");
    expect(durationLabel(80 * 60000)).toBe("1 小时 20 分");
  });
});

describe("date input", () => {
  const now = d(2026, 6, 15, 18);
  it("round-trips, keeps now for today, noon for past, clamps future, rejects junk", () => {
    expect(dateInputValue(d(2026, 1, 5))).toBe("2026-01-05");
    expect(parseDateInput("2026-06-15", now)).toBe(now);
    expect(parseDateInput("2026-06-01", now)).toBe(d(2026, 6, 1, 12));
    expect(parseDateInput("2026-07-01", now)).toBe(now);
    expect(parseDateInput("2026-02-31", now)).toBeNull();
    expect(parseDateInput("", now)).toBeNull();
  });
});

describe("collectWorks and views", () => {
  const txns: Txn[] = [{ id: "t1", code: "A1", delta: -10, kind: "consume", patternId: "old", at: d(2026, 2, 3), updatedAt: 1 }];
  const patterns = [
    pat("new", { copies: 2, tags: ["猫"], previewId: "pv", works: [{ id: "w1", at: d(2026, 6, 1), copies: 2, tag: "给妈妈", photoId: "ph" }, { id: "w2", at: d(2025, 12, 24) }] }),
    pat("old", { status: "done", imageId: "img", tags: ["猫"] }),
    pat("gone", { status: "done", deleted: true }),
    pat("wip")
  ];
  const items = collectWorks(patterns, txns);
  it("lists entries plus legacy done patterns, newest first", () => {
    expect(items.map((i) => i.key)).toEqual(["new:w1", "old:legacy", "new:w2"]);
    expect(items[0]).toMatchObject({ beads: 30, copies: 2, photoId: "ph", fallbackId: "pv", tags: ["猫", "给妈妈"], estimated: false });
    expect(items[1]).toMatchObject({ estimated: true, at: d(2026, 2, 3), fallbackId: "img", beads: 15 });
    expect(items[2].beads).toBe(30); // 条目没记份数时按图纸当前份数
  });
  it("totals this year", () => {
    const t = workTotals(items, d(2026, 8, 1));
    expect(t).toMatchObject({ pieces: 3, thisYear: 2 });
    expect(t.beads).toBe(items.reduce((s, i) => s + i.beads, 0));
  });
  it("filters and groups", () => {
    expect(filterWorks(items, { year: 2025 }).map((i) => i.key)).toEqual(["new:w2"]);
    expect(filterWorks(items, { year: 2026, month: 6 }).map((i) => i.key)).toEqual(["new:w1"]);
    expect(filterWorks(items, { tag: "给妈妈" })).toHaveLength(1);
    expect(filterWorks(items, { tag: "猫" })).toHaveLength(3);
    const o = filterOptions(items, 2026);
    expect(o.years).toEqual([2026, 2025]);
    expect(o.months).toEqual([6, 2]);
    expect(o.tags[0]).toBe("猫");
    expect(groupByMonth(items).map((g) => g.key)).toEqual(["2026-06", "2026-02", "2025-12"]);
  });
});

describe("monthlyDone", () => {
  it("prefers real dates, falls back to unrefunded consume txns, never double counts", () => {
    const patterns = [pat("rec", { works: [{ id: "w", at: d(2026, 6, 2) }] }), pat("old", { status: "done" }), pat("mis", { status: "planned" })];
    const txns: Txn[] = [
      { id: "a", code: "A1", delta: -1, kind: "consume", patternId: "rec", at: d(2026, 5, 1), updatedAt: 1 },
      { id: "b", code: "A1", delta: -1, kind: "consume", patternId: "old", at: d(2026, 5, 1), updatedAt: 1 },
      { id: "b2", code: "A2", delta: -1, kind: "consume", patternId: "old", at: d(2026, 5, 2), updatedAt: 1 },
      { id: "c", code: "A1", delta: -1, kind: "consume", patternId: "mis", at: d(2026, 4, 1), updatedAt: 1 },
      { id: "r", code: "A1", delta: 1, kind: "adjust", refundOf: "c", at: d(2026, 4, 2), updatedAt: 1 }
    ];
    expect(monthlyDone(patterns, txns)).toEqual({ "2026-06": { real: 1, estimated: 0 }, "2026-05": { real: 0, estimated: 1 } });
  });
});
