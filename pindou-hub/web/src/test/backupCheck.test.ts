import { describe, expect, it } from "vitest";
import { checkBackup } from "../lib/backupCheck";

const pat = { id: "p1", name: "图纸", counts: { A1: 3 }, tags: [] };
const rec = (over: object) => ({ collection: "patterns", id: "p1", data: pat, updatedAt: 10, ...over });
const run = (records: unknown[]) => checkBackup(JSON.stringify({ app: "pindou-hub", records }));

describe("checkBackup", () => {
  it("rejects non-JSON and non-backup files", () => {
    expect(checkBackup("{oops").ok).toBe(false);
    expect(checkBackup('{"hello":1}').ok).toBe(false);
  });
  it("accepts good records, including a bare array and tombstones", () => {
    const r = checkBackup(JSON.stringify([rec({}), rec({ id: "p2", deleted: true, data: {} })]));
    expect(r.ok && r.records.length).toBe(2);
    expect(r.ok && r.message).toBe("");
  });
  it("skips malformed records and says why", () => {
    const r = run([
      rec({}),
      rec({ id: "../x" }),
      rec({ id: "p3", updatedAt: "late" }),
      rec({ id: "p4", data: { id: "p4", name: "x", counts: { A1: "many" } } }),
      { collection: "txns", id: "t1", data: { code: "A1", delta: "5", kind: "purchase", at: 1 }, updatedAt: 2 },
      { collection: "txns", id: "t2", data: { code: "A1", delta: 5, kind: "bogus", at: 1 }, updatedAt: 2 },
      { collection: "images", id: "short", data: {}, updatedAt: 3 },
      { collection: "prefs", id: "other", data: {}, updatedAt: 3 },
      null
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.records.map((x) => x.id)).toEqual(["p1"]);
      expect(r.rejected.length).toBe(8);
      expect(r.message).toContain("8");
    }
  });
  it("counts unknown collections separately instead of importing them", () => {
    const r = run([rec({}), { collection: "evil", id: "x", data: {}, updatedAt: 1 }]);
    expect(r.ok && r.skippedUnknown).toBe(1);
    expect(r.ok && r.records.length).toBe(1);
  });
  it("rejects a record whose inner id disagrees", () => {
    const r = run([rec({ data: { ...pat, id: "other" } })]);
    expect(r.ok && r.records.length).toBe(0);
  });
});
