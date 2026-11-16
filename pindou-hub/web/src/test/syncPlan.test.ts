import { describe, expect, it } from "vitest";
import { SKEW_MIN_MS, approxBytes, bumpStamp, decideCursor, estimateSkew, hashMatches, planChunks } from "../lib/syncPlan";

describe("decideCursor", () => {
  it("keeps the cursor for an old hub that reports nothing", () => {
    expect(decideCursor({ localCursor: 500, localEpoch: "", hubEpoch: undefined, hubMaxSeq: undefined }).action).toBe("keep");
  });
  it("keeps it when epoch matches and cursor is within the hub", () => {
    expect(decideCursor({ localCursor: 10, localEpoch: "a", hubEpoch: "a", hubMaxSeq: 10 }).action).toBe("keep");
  });
  it("adopts the epoch silently right after upgrading", () => {
    expect(decideCursor({ localCursor: 10, localEpoch: "", hubEpoch: "a", hubMaxSeq: 40 }).action).toBe("keep");
  });
  it("resets when the hub database identity changed", () => {
    expect(decideCursor({ localCursor: 10, localEpoch: "a", hubEpoch: "b", hubMaxSeq: 40 })).toEqual({ action: "reset", reason: "epoch" });
  });
  it("resets when the cursor is ahead of anything the hub has", () => {
    expect(decideCursor({ localCursor: 99, localEpoch: "a", hubEpoch: "a", hubMaxSeq: 20 })).toEqual({ action: "reset", reason: "ahead" });
    expect(decideCursor({ localCursor: 99, localEpoch: "", hubEpoch: "a", hubMaxSeq: 0 }).reason).toBe("ahead");
  });
  it("never resets a fresh client", () => {
    expect(decideCursor({ localCursor: 0, localEpoch: "", hubEpoch: "a", hubMaxSeq: 0 }).action).toBe("keep");
  });
});

describe("clock skew", () => {
  it("estimates hub minus local from the round trip midpoint", () => {
    expect(estimateSkew(1000, 1200, 61100)).toBe(60000);
    expect(estimateSkew(1000, 1200, 1100)).toBe(0);
  });
  it("ignores slow or malformed samples", () => {
    expect(estimateSkew(0, 9000, 5000)).toBeNull();
    expect(estimateSkew(5, 1, 5)).toBeNull();
    expect(estimateSkew(0, 10, undefined)).toBeNull();
  });
  const now = 1_000_000;
  it("always ends strictly above the existing version", () => {
    expect(bumpStamp(now, now + 500, 0, now)).toBe(now + 501);
    expect(bumpStamp(5, 5, 0, now)).toBe(6);
    expect(bumpStamp(now, undefined, 0, now)).toBe(now);
  });
  it("moves a slow local clock onto hub time so its edit can win", () => {
    const hubExisting = now + 60_000; // another device edited a minute "in the future" of this clock
    expect(bumpStamp(now, hubExisting, 60_000, now)).toBeGreaterThan(hubExisting);
    expect(bumpStamp(now, now - 10, 60_000, now)).toBe(now + 60_000);
  });
  it("pulls a fast local clock back to hub time", () => {
    expect(bumpStamp(now, now - 90_000, -60_000, now)).toBe(now - 60_000);
  });
  it("ignores small skew and does not shift twice", () => {
    expect(bumpStamp(now, undefined, SKEW_MIN_MS - 1, now)).toBe(now);
    const first = bumpStamp(now, 10, 60_000, now);
    // a writer that already did max(now, existing + 1) on top of a shifted value is left alone
    expect(bumpStamp(first + 1, first, 60_000, now)).toBe(first + 1);
  });
  it("does not shift values that are not near the local clock (e.g. old backup records)", () => {
    expect(bumpStamp(12345, undefined, 60_000, now)).toBe(12345);
  });
});

describe("planChunks", () => {
  const item = (n: number) => ({ id: n });
  it("returns nothing for an empty outbox", () => {
    expect(planChunks([])).toEqual([]);
  });
  it("respects count and byte limits and keeps order", () => {
    const items = Array.from({ length: 10 }, (_, i) => item(i));
    const byCount = planChunks(items, { maxCount: 4, size: () => 1 });
    expect(byCount.map((c) => c.length)).toEqual([4, 4, 2]);
    expect(byCount.flat()).toEqual(items);
    const byBytes = planChunks(items, { maxBytes: 25, size: () => 10 });
    expect(byBytes.map((c) => c.length)).toEqual([2, 2, 2, 2, 2]);
  });
  it("puts an oversized record in a batch of its own", () => {
    const sizes = [5, 100, 5, 5];
    const chunks = planChunks(sizes, { maxBytes: 20, size: (n) => n });
    expect(chunks).toEqual([[5], [100], [5, 5]]);
  });
  it("estimates multi-byte text larger than its length", () => {
    expect(approxBytes({ a: "中" })).toBeGreaterThan(JSON.stringify({ a: "中" }).length);
  });
});

describe("hashMatches", () => {
  const id = "a".repeat(64);
  it("accepts only an identical digest", () => {
    expect(hashMatches(id, id)).toBe(true);
    expect(hashMatches(id, id.toUpperCase())).toBe(true);
    expect(hashMatches(id, "b".repeat(64))).toBe(false);
  });
  it("rejects a malformed id", () => {
    expect(hashMatches("xyz", "xyz")).toBe(false);
  });
});
