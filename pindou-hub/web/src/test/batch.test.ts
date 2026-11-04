import { describe, expect, it } from "vitest";
import { classify, folderOf, headerChecks, isImageFile, itemProgress, nextWaiting, reduceBatch, summarize, announceFor, type BatchItem } from "../lib/batch";
import type { AnalyzeResult } from "../lib/recognize/types";

const file = (name: string, rel = "", size = 10) => ({ name, type: "image/jpeg", size, webkitRelativePath: rel }) as unknown as File;
const step = (id: string) => ({ id, label: id, status: "ok" as const, detail: "" });
function result(over: Partial<AnalyzeResult> = {}): AnalyzeResult {
  return {
    steps: [step("grid")], legend: null, grid: { grid: { x0: 0, y0: 0, pitchX: 10, pitchY: 10, cols: 55, rows: 61, score: 1 }, matrix: [], counts: {}, colors: [], emptyCells: 0, backgroundHex: null },
    counts: { A1: 100, B2: 50 }, method: "legend+grid", confidence: 0.95, diff: [], source: { width: 100, height: 100 }, ...over
  };
}
const add = (names: string[]) => reduceBatch([], { type: "add", files: names.map((n) => file(n, `游戏王/${n}`)), ids: names.map((n) => `id-${n}`) });

describe("folderOf / isImageFile", () => {
  it("takes the immediate parent folder", () => {
    expect(folderOf({ webkitRelativePath: "拼豆图/游戏王/黑魔导士.jpg" })).toBe("游戏王");
    expect(folderOf({ webkitRelativePath: "游戏王/a.jpg" })).toBe("游戏王");
    expect(folderOf({ webkitRelativePath: "a.jpg" })).toBe("");
    expect(folderOf({})).toBe("");
  });
  it("accepts images by mime or extension, rejects others", () => {
    expect(isImageFile({ name: "x.JPG" })).toBe(true);
    expect(isImageFile({ name: "x", type: "image/png" })).toBe(true);
    expect(isImageFile({ name: "Thumbs.db", type: "" })).toBe(false);
  });
});

describe("queue reducer", () => {
  it("adds only images, defaults tag to folder, skips duplicates", () => {
    let items = reduceBatch([], { type: "add", files: [file("a.jpg", "游戏王/a.jpg"), { name: "n.txt", type: "text/plain" } as File] });
    expect(items).toHaveLength(1);
    expect(items[0].tag).toBe("游戏王");
    expect(items[0].name).toBe("a");
    const again = reduceBatch(items, { type: "add", files: [file("a.jpg", "游戏王/a.jpg")] });
    expect(again).toBe(items);
    items = reduceBatch(items, { type: "add", files: [file("a.jpg", "高达/a.jpg")] });
    expect(items).toHaveLength(2);
  });
  it("runs strictly one after another and lands in final states", () => {
    let items = add(["a.jpg", "b.jpg", "c.jpg"]);
    expect(nextWaiting(items)?.id).toBe("id-a.jpg");
    items = reduceBatch(items, { type: "start", id: "id-a.jpg" });
    items = reduceBatch(items, { type: "step", id: "id-a.jpg", step: step("grid") });
    items = reduceBatch(items, { type: "step", id: "id-a.jpg", step: { ...step("grid"), detail: "again" } });
    expect(items[0].steps).toHaveLength(1);
    expect(itemProgress(items[0])).toBeCloseTo(0.2);
    items = reduceBatch(items, { type: "finish", id: "id-a.jpg", result: result() });
    expect(items[0].state).toBe("done");
    expect(nextWaiting(items)?.id).toBe("id-b.jpg");
    items = reduceBatch(items, { type: "start", id: "id-b.jpg" });
    items = reduceBatch(items, { type: "finish", id: "id-b.jpg", result: result({ isChart: false, notChartReason: "像插画" }) });
    expect(items[1].state).toBe("notchart");
    expect(items[1].error).toBe("像插画");
    items = reduceBatch(items, { type: "start", id: "id-c.jpg" });
    items = reduceBatch(items, { type: "fail", id: "id-c.jpg", error: "boom" });
    expect(items[2].state).toBe("failed");
    const s = summarize(items);
    expect(s).toMatchObject({ total: 3, done: 1, notchart: 1, failed: 1, active: false, progress: 1 });
  });
  it("cancel stops remaining; a late finish does not resurrect a cancelled item; retry re-queues", () => {
    let items = add(["a.jpg", "b.jpg"]);
    items = reduceBatch(items, { type: "start", id: "id-a.jpg" });
    items = reduceBatch(items, { type: "cancelAll" });
    expect(items.map((i) => i.state)).toEqual(["cancelled", "cancelled"]);
    items = reduceBatch(items, { type: "finish", id: "id-a.jpg", result: result() });
    expect(items[0].state).toBe("cancelled");
    items = reduceBatch(items, { type: "retry", id: "id-b.jpg" });
    expect(items[1].state).toBe("waiting");
    expect(nextWaiting(items)?.id).toBe("id-b.jpg");
  });
  it("saved items are not savable again and cannot be retried; running cannot be removed", () => {
    let items = add(["a.jpg"]);
    items = reduceBatch(items, { type: "start", id: "id-a.jpg" });
    expect(reduceBatch(items, { type: "remove", id: "id-a.jpg" })).toHaveLength(1);
    items = reduceBatch(items, { type: "finish", id: "id-a.jpg", result: result() });
    expect(summarize(items).savable).toBe(1);
    items = reduceBatch(items, { type: "saved", id: "id-a.jpg", patternId: "p1" });
    expect(summarize(items)).toMatchObject({ savable: 0, saved: 1 });
    expect(reduceBatch(items, { type: "retry", id: "id-a.jpg" })[0].state).toBe("done");
    expect(reduceBatch(items, { type: "tag", id: "id-a.jpg", tag: "x" })[0].tag).toBe("x");
  });
});

describe("classify / headerChecks", () => {
  it("flags low confidence, legend/grid mismatch, header disagreement, palette warning", () => {
    expect(classify(result())).toMatchObject({ state: "done", review: false });
    expect(classify(result({ confidence: 0.4 })).review).toBe(true);
    expect(classify(result({ diff: [{ code: "A1", legend: 10, grid: 12 }] })).reasons[0]).toContain("不一致");
    const c = classify(result({ header: { cols: 55, rows: 60, colors: 2, total: 150 } }));
    expect(c.review).toBe(true);
    expect(c.reasons.join()).toContain("尺寸");
    expect(classify(result({ paletteWarning: "非 MARD" })).review).toBe(true);
  });
  it("not-a-chart and empty results are not 'done'", () => {
    expect(classify(result({ isChart: false })).state).toBe("notchart");
    expect(classify(result({ method: "none", counts: {} })).state).toBe("failed");
  });
  it("headerChecks compares size, colors, total; unknown reads are null", () => {
    const checks = headerChecks(result({ header: { cols: 55, rows: 61, colors: 2, total: 149 } }));
    expect(checks.map((c) => [c.key, c.ok])).toEqual([["size", true], ["colors", true], ["total", false]]);
    expect(headerChecks(result({ header: undefined }))).toEqual([]);
    expect(headerChecks(result({ grid: null, header: { cols: 5, rows: 5, colors: null, total: null } }))[0].ok).toBeNull();
  });
  it("announce text mentions name and state", () => {
    const it0 = { ...add(["a.jpg"])[0] } as BatchItem;
    expect(announceFor({ ...it0, state: "notchart" })).toContain("不是图纸");
  });
});
