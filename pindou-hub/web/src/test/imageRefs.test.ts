import { describe, expect, it } from "vitest";
import { referencedImageIds, unusedImageIds } from "../lib/imageRefs";
import { entryCreatedAt, isBlankEntry, lastCompletionEntry, withCompletionUndone } from "../lib/worklog";
import type { Pattern } from "../lib/model";

const img = (id: string, role: "source" | "preview" = "source", deleted = false) => ({ id, role, deleted });
const pat = (o: Partial<Pattern>): Pattern => ({ id: "p", name: "n", kind: "manual", method: "manual", counts: { A1: 4 }, status: "done", copies: 1, tags: [], notes: "", createdAt: 1, updatedAt: 10, ...o });

describe("image references", () => {
  it("collects source, preview and work photos, including deleted patterns", () => {
    const refs = referencedImageIds([pat({ imageId: "a", previewId: "b", works: [{ id: "w1", at: 5, photoId: "c" }] }), pat({ id: "q", deleted: true, imageId: "d" })]);
    expect([...refs].sort()).toEqual(["a", "b", "c", "d"]);
  });
  it("only returns unreferenced source images that exist", () => {
    const patterns = [pat({ imageId: "a", works: [{ id: "w1", at: 5, photoId: "shared" }] }), pat({ id: "q", works: [{ id: "w2", at: 6, photoId: "shared" }] })];
    const images = [img("a"), img("shared"), img("gone"), img("prev", "preview"), img("dead", "source", true)];
    expect(unusedImageIds(["shared", "a", "gone", "prev", "dead", "missing", undefined], patterns, images)).toEqual(["gone"]);
  });
  it("a photo shared by two entries stays while one still uses it", () => {
    const only = [pat({ works: [{ id: "w2", at: 6, photoId: "x" }] })];
    expect(unusedImageIds(["x"], only, [img("x")])).toEqual([]);
    expect(unusedImageIds(["x"], [pat({ works: [] })], [img("x")])).toEqual(["x"]);
  });
});

describe("undoing the completion entry", () => {
  const T = 1_780_000_000_000;
  const id = (t: number, tail = "abcdefghijkl") => `w${t.toString(36)}${tail}`;
  it("reads creation time from createdAt, then the id, then at", () => {
    expect(entryCreatedAt({ id: "x", at: 5, createdAt: 9 })).toBe(9);
    expect(entryCreatedAt({ id: id(T), at: 5 })).toBe(T);
    expect(entryCreatedAt({ id: "legacy", at: 5 })).toBe(5);
  });
  it("picks the latest-created entry even when it is back-dated", () => {
    const p = pat({ works: [{ id: id(T), at: T }, { id: id(T + 5000, "zzzzzzzzzzzz"), at: T - 86_400_000 }] });
    expect(lastCompletionEntry(p)?.at).toBe(T - 86_400_000);
  });
  it("removes only the latest entry and clears works when it was the only one", () => {
    const p = pat({ works: [{ id: id(T), at: T, createdAt: T }, { id: "old", at: 100, createdAt: 100 }] });
    const r = withCompletionUndone(p, T + 1000);
    expect(r.removed?.id).toBe(id(T));
    expect(r.pattern.works?.map((e) => e.id)).toEqual(["old"]);
    expect(withCompletionUndone(r.pattern, T + 2000).pattern.works).toBeUndefined();
    expect(withCompletionUndone(pat({}), T).removed).toBeUndefined();
  });
  it("blank-and-recent guard keeps real records", () => {
    const blank = pat({ works: [{ id: "w1", at: T, createdAt: T }] });
    expect(withCompletionUndone(blank, T + 60_000, { onlyBlankWithin: 30 * 60_000 }).removed).toBeDefined();
    expect(withCompletionUndone(blank, T + 31 * 60_000, { onlyBlankWithin: 30 * 60_000 }).removed).toBeUndefined();
    const filled = pat({ works: [{ id: "w1", at: T, createdAt: T, note: "给妈妈" }] });
    expect(isBlankEntry(filled.works![0])).toBe(false);
    expect(withCompletionUndone(filled, T + 1000, { onlyBlankWithin: 30 * 60_000 }).removed).toBeUndefined();
  });
});
