import { describe, expect, it } from "vitest";
import { FLAG_TAG, applyFlag, applyOk, currentId, decide, newSession, orderQueue, parseSession, pending, progress, revertDecision, serializeSession, setOrder, summarize, swipeAxis, swipeDecision, swipeProgress, undo, type QueueItem } from "./verifyQueue";
import type { Pattern } from "./model";

const it_ = (id: string, confidence: number | undefined, createdAt: number, verifiedAt?: number, deleted?: boolean): QueueItem => ({ id, confidence, createdAt, verifiedAt, deleted });
const items = [it_("a", 0.9, 1), it_("b", 0.3, 2), it_("c", 0.3, 3), it_("d", undefined, 4), it_("e", 0.1, 5, 99), it_("f", 0.5, 6, undefined, true)];

describe("orderQueue", () => {
  it("lowest confidence first, ties newest first, manual last, verified/deleted out", () => {
    expect(orderQueue(items, "confidence")).toEqual(["c", "b", "a", "d"]);
  });
  it("newest first", () => { expect(orderQueue(items, "newest")).toEqual(["d", "c", "b", "a"]); });
});

describe("decisions and undo", () => {
  it("advances, counts progress, undo returns the item", () => {
    let s = newSession();
    expect(currentId(items, s)).toBe("c");
    expect(progress(items, s)).toEqual({ done: 0, total: 4, index: 1 });
    s = decide(s, "c", "skip");
    s = decide(s, "b", "flag");
    expect(currentId(items, s)).toBe("a");
    expect(progress(items, s)).toEqual({ done: 2, total: 4, index: 3 });
    const u = undo(s);
    expect(u.id).toBe("b"); expect(u.was).toBe("flag");
    expect(currentId(items, u.session)).toBe("b");
    expect(undo(newSession()).id).toBeUndefined();
  });
  it("a verified decision drops out but stays counted; ignores double decide", () => {
    let s = decide(newSession(), "c", "ok");
    const after = items.map((i) => (i.id === "c" ? { ...i, verifiedAt: 5 } : i));
    expect(progress(after, s)).toEqual({ done: 1, total: 4, index: 2 });
    expect(decide(s, "c", "flag")).toBe(s);
    expect(summarize(after, decide(s, "b", "skip"))).toEqual({ ok: ["c"], flag: [], skip: ["b"], left: 2 });
  });
  it("switching order keeps decided ones out", () => {
    let s = decide(newSession(), "c", "skip");
    s = setOrder(s, "newest");
    expect(pending(items, s)).toEqual(["d", "b", "a"]);
  });
  it("scope limits the queue", () => { expect(pending(items, newSession("confidence", ["a", "d", "e"]))).toEqual(["a", "d"]); });
  it("ends with nothing current", () => {
    let s = newSession();
    for (const id of ["c", "b", "a", "d"]) s = decide(s, id, "ok");
    expect(currentId(items, s)).toBeUndefined();
    expect(progress(items, s).index).toBe(4);
  });
});

describe("pattern changes", () => {
  const p = { id: "x", name: "x", tags: ["猫"], updatedAt: 10, reviewNote: "旧" } as unknown as Pattern;
  it("ok verifies and clears the flag", () => {
    const n = applyOk({ ...p, tags: ["猫", FLAG_TAG] }, 50);
    expect(n.verifiedAt).toBe(50); expect(n.tags).toEqual(["猫"]); expect(n.reviewNote).toBeUndefined(); expect(n.updatedAt).toBe(50);
  });
  it("flag tags once, keeps unverified, trims reason", () => {
    const n = applyFlag(p, "  颜色\n不对 ", 5);
    expect(n.tags).toEqual(["猫", FLAG_TAG]); expect(n.reviewNote).toBe("颜色 不对"); expect(n.verifiedAt).toBeUndefined(); expect(n.updatedAt).toBe(11);
    expect(applyFlag(n, "", 99).tags).toEqual(["猫", FLAG_TAG]);
    expect(applyFlag(n, "", 99).reviewNote).toBe("颜色 不对");
  });
  it("revert restores the original, or reverses best-effort", () => {
    const done = applyOk(p, 50);
    expect(revertDecision(done, "ok", p, 60)).toEqual({ ...p, updatedAt: 60 });
    expect(revertDecision(done, "ok", undefined, 60)?.verifiedAt).toBeUndefined();
    const f = applyFlag(p, "x", 50);
    const r = revertDecision(f, "flag", undefined, 40)!;
    expect(r.tags).toEqual(["猫"]); expect(r.reviewNote).toBeUndefined(); expect(r.updatedAt).toBe(51);
    expect(revertDecision(p, "skip", undefined, 1)).toBeNull();
  });
});

describe("swipe", () => {
  it("decides by distance and direction", () => {
    expect(swipeDecision(90, 5, 400)).toBe("ok");
    expect(swipeDecision(-90, -10, 400)).toBe("flag");
    expect(swipeDecision(40, 0, 400)).toBeNull();
  });
  it("accepts a short fast flick but not a diagonal or vertical drag", () => {
    expect(swipeDecision(50, 3, 60)).toBe("ok");
    expect(swipeDecision(50, 3, 300)).toBeNull();
    expect(swipeDecision(100, 80, 200)).toBeNull();
    expect(swipeDecision(5, 120, 200)).toBeNull();
  });
  it("axis lock and progress", () => {
    expect(swipeAxis(4, 3)).toBeNull(); expect(swipeAxis(20, 5)).toBe("x"); expect(swipeAxis(5, 20)).toBe("y");
    expect(swipeProgress(36)).toBe(0.5); expect(swipeProgress(-500)).toBe(-1);
  });
});

describe("resume", () => {
  it("round-trips and rejects junk", () => {
    const s = decide(decide(newSession("newest", ["a", "b"]), "a", "ok"), "b", "flag");
    expect(parseSession(serializeSession(s))).toEqual(s);
    expect(parseSession("nope")).toBeNull(); expect(parseSession(null)).toBeNull();
    expect(parseSession('{"order":"x","decisions":{},"history":[]}')).toBeNull();
    expect(parseSession('{"order":"newest","scope":null,"decisions":{"a":"ok","b":"zzz"},"history":["a","b","q"]}')).toEqual({ order: "newest", scope: null, decisions: { a: "ok" }, history: ["a"] });
  });
  it("a resumed session continues where it left off", () => {
    const s = parseSession(serializeSession(decide(newSession(), "c", "skip")))!;
    expect(currentId(items, s)).toBe("b");
  });
});
