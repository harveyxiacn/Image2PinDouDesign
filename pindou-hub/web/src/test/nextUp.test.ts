import { describe, expect, it } from "vitest";
import type { Pattern } from "../lib/model";
import { DEFAULT_PREFS } from "../lib/model";
import { canMakeTogether, nextUp } from "../lib/nextUp";

const prefs = { ...DEFAULT_PREFS, lowStock: 100, lossRate: 0, minStock: {} };
function pat(id: string, counts: Record<string, number>, over: Partial<Pattern> = {}): Pattern {
  return { id, name: id, kind: "manual", method: "manual", counts, status: "planned", copies: 1, tags: [], notes: "", createdAt: 1, updatedAt: 1, ...over };
}

describe("nextUp", () => {
  it("returns nothing without stock or candidates", () => {
    expect(nextUp([pat("a", { A1: 10 })], {}, prefs).rows).toEqual([]);
    expect(nextUp([pat("a", { A1: 10 })], { A1: 0 }, prefs).rows).toEqual([]);
    expect(nextUp([], { A1: 500 }, prefs).rows).toEqual([]);
    expect(nextUp([pat("d", { A1: 5 }, { status: "done" }), pat("x", { A1: 5 }, { deleted: true }), pat("e", {})], { A1: 500 }, prefs).rows).toEqual([]);
  });

  it("prefers makeable patterns that use surplus colours", () => {
    const stock = { A1: 1000, B1: 150, C1: 300 };
    const r = nextUp([pat("onB", { B1: 100 }), pat("onA", { A1: 100 }), pat("short", { C1: 400 })], stock, prefs);
    expect(r.rows.map((x) => x.id)).toEqual(["onA", "onB", "short"]);
    const a = r.rows[0];
    expect(a.canMake).toBe(true);
    expect(a.surplusShare).toBe(1);
    expect(a.surplusTop).toEqual([{ code: "A1", beads: 100 }]);
    expect(a.why).toBe("不缺豆 · 100% 用的是库存多的颜色（A1）");
    const b = r.rows[1];
    expect(b.pushLow).toEqual([{ code: "B1", after: 50, floor: 100 }]);
    expect(b.why).toContain("拼完 B1 会偏少");
    const s = r.rows[2];
    expect(s.canMake).toBe(false);
    expect(s.shortBeads).toBe(100);
    expect(s.why).toContain("缺 100 颗（C1）");
  });

  it("subtracts making patterns and respects per-colour floors", () => {
    const stock = { A1: 500, B1: 500 };
    const r = nextUp([pat("m", { A1: 450 }, { status: "making" }), pat("p", { A1: 40, B1: 40 })], stock, { ...prefs, minStock: { B1: 480 } });
    expect(r.available.A1).toBe(50);
    expect(r.surplus.A1).toBeUndefined();
    expect(r.surplus.B1).toBe(20);
    expect(r.rows.map((x) => x.id)).toEqual(["p"]);
    expect(r.rows[0].surplusBeads).toBe(20);
  });

  it("handles copies, loss and unknown codes", () => {
    const r = nextUp([pat("c", { A1: 100 }, { copies: 3 }), pat("u", { ZZ99: 10 })], { A1: 1000 }, { ...prefs, lossRate: 0.1 });
    const c = r.rows.find((x) => x.id === "c")!;
    expect(c.needed).toBe(330);
    expect(c.canMake).toBe(true);
    const u = r.rows.find((x) => x.id === "u")!;
    expect(u.canMake).toBe(false);
    expect(u.shortColors[0]).toMatchObject({ code: "ZZ99", gap: 11 });
  });

  it("lists planned before idea and breaks ties by createdAt then id", () => {
    const stock = { A1: 1000 };
    const r = nextUp([pat("i", { A1: 10 }, { status: "idea" }), pat("p2", { A1: 10 }, { createdAt: 5 }), pat("p1b", { A1: 10 }, { createdAt: 2 }), pat("p1a", { A1: 10 }, { createdAt: 2 })], stock, prefs);
    expect(r.rows.map((x) => [x.id, x.group, x.rank])).toEqual([["p1a", "planned", 1], ["p1b", "planned", 2], ["p2", "planned", 3], ["i", "idea", 1]]);
  });

  it("canMakeTogether checks the combined need of the top N", () => {
    const stock = { A1: 300, B1: 1000 };
    const r = nextUp([pat("x", { A1: 150 }, { createdAt: 1 }), pat("y", { A1: 150, B1: 10 }, { createdAt: 2 }), pat("z", { A1: 100 }, { createdAt: 3 })], stock, { ...prefs, lowStock: 0 });
    expect(r.rows.every((x) => x.canMake)).toBe(true);
    expect(canMakeTogether(r, 2).ok).toBe(true);
    const t = canMakeTogether(r, 3);
    expect(t.ok).toBe(false);
    expect(t.short).toEqual([{ code: "A1", need: 400, have: 300, gap: 100 }]);
    expect(canMakeTogether(r, 0).ok).toBe(true);
  });
});
