import { describe, expect, it } from "vitest";
import {
  IDLE_MS, accrue, cleanTimeMap, createTracker, currentMs, deviceKey, mergeTimeMaps, noteInput, sameTimeMap, setVisible, timeLabel, totalMs, withOwnTime
} from "../lib/buildTime";
import { mergeBuild, sameBuild, type BuildState } from "../lib/build";
import { buildDurationMs } from "../lib/worklog";

const MIN = 60_000;

describe("tracker", () => {
  it("counts while active and stops after the idle window", () => {
    let t = createTracker(0, true);
    t = noteInput(t, 1 * MIN);
    expect(currentMs(t, 2 * MIN)).toBe(2 * MIN);
    // 最后一次操作在 1 分钟，3 分钟后不再计时
    expect(currentMs(t, 30 * MIN)).toBe(1 * MIN + IDLE_MS);
  });
  it("does not count while hidden and resumes on return", () => {
    let t = createTracker(0, true);
    t = noteInput(t, MIN);
    t = setVisible(t, false, 2 * MIN);
    expect(currentMs(t, 60 * MIN)).toBe(2 * MIN);
    t = setVisible(t, true, 60 * MIN);
    expect(currentMs(t, 61 * MIN)).toBe(3 * MIN);
  });
  it("input keeps it alive across long sessions", () => {
    let t = createTracker(0, true);
    for (let i = 1; i <= 10; i += 1) t = noteInput(t, i * 2 * MIN);
    expect(currentMs(t, 20 * MIN)).toBe(20 * MIN);
  });
  it("a sleeping device does not add the sleep gap", () => {
    let t = createTracker(0, true);
    t = noteInput(t, MIN);
    t = accrue(t, 8 * 60 * MIN); // 睡了 8 小时才再次结算
    expect(t.acc).toBe(MIN + IDLE_MS);
  });
  it("a clock moved backwards never subtracts", () => {
    let t = createTracker(10 * MIN, true);
    t = noteInput(t, 11 * MIN);
    const before = currentMs(t, 11 * MIN);
    t = accrue(t, 5 * MIN);
    expect(t.acc).toBe(before);
  });
  it("started hidden counts nothing until shown", () => {
    let t = createTracker(0, false);
    expect(currentMs(t, 10 * MIN)).toBe(0);
    t = setVisible(t, true, 10 * MIN);
    expect(currentMs(t, 11 * MIN)).toBe(MIN);
  });
});

describe("time map", () => {
  it("cleans and rounds to seconds", () => {
    expect(cleanTimeMap({ a: 1500, b: 0, c: -5, d: "x", e: NaN })).toEqual({ a: 1000 });
    expect(cleanTimeMap(undefined)).toBeUndefined();
    expect(cleanTimeMap([1, 2])).toBeUndefined();
  });
  it("keeps at most 8 devices (largest)", () => {
    const m: Record<string, number> = {};
    for (let i = 0; i < 12; i += 1) m[`d${i}`] = (i + 1) * 1000;
    const out = cleanTimeMap(m)!;
    expect(Object.keys(out)).toHaveLength(8);
    expect(out.d0).toBeUndefined();
    expect(out.d11).toBe(12000);
  });
  it("merges per device by max, total sums devices", () => {
    const a = { x: 10 * MIN, y: 5 * MIN };
    const b = { x: 7 * MIN, z: 3 * MIN };
    const m = mergeTimeMaps(a, b)!;
    expect(m).toEqual({ x: 10 * MIN, y: 5 * MIN, z: 3 * MIN });
    expect(totalMs(m)).toBe(18 * MIN);
    expect(mergeTimeMaps(b, a)).toEqual(m);
    expect(mergeTimeMaps(m, m)).toEqual(m);
    expect(mergeTimeMaps(a, undefined)).toEqual(a);
  });
  it("the same device seen twice is not double-counted", () => {
    const earlier = { x: 4 * MIN };
    const later = { x: 9 * MIN };
    expect(totalMs(mergeTimeMaps(earlier, later))).toBe(9 * MIN);
  });
  it("withOwnTime only goes up", () => {
    expect(withOwnTime({ me: 5 * MIN }, "me", 3 * MIN)).toEqual({ me: 5 * MIN });
    expect(withOwnTime({ me: 5 * MIN, you: MIN }, "me", 6 * MIN + 500)).toEqual({ me: 6 * MIN, you: MIN });
    expect(withOwnTime(undefined, "me", 400)).toBeUndefined();
    expect(sameTimeMap({ a: 1000 }, { a: 1400 })).toBe(true);
  });
  it("device key and labels", () => {
    expect(deviceKey("dabc12345678xyz")).toBe("678xyz");
    expect(deviceKey("")).toBe("local");
    expect(timeLabel(30_000)).toBe("");
    expect(timeLabel(5 * MIN)).toBe("5 分钟");
    expect(timeLabel(125 * MIN)).toBe("2 小时 5 分");
  });
});

const bs = (o: Partial<BuildState> = {}): BuildState => ({ boardSize: 29, board: 0, colorIndex: 0, mode: "color", done: "w4;A1=0-1", updatedAt: 100, ...o });

describe("mergeBuild with time", () => {
  it("sums devices, max per device, commutative and idempotent", () => {
    const a = bs({ updatedAt: 100, timeMs: { A: 10 * MIN } });
    const b = bs({ updatedAt: 200, timeMs: { B: 4 * MIN, A: 6 * MIN } });
    const m = mergeBuild(a, b)!;
    expect(m.timeMs).toEqual({ A: 10 * MIN, B: 4 * MIN });
    expect(totalMs(m.timeMs)).toBe(14 * MIN);
    expect(mergeBuild(b, a)).toEqual(m);
    expect(mergeBuild(m, m)).toEqual(m);
    expect(mergeBuild(m, a)).toEqual(m);
  });
  it("a record from an old device without time keeps the other side's time", () => {
    const a = bs({ updatedAt: 100, timeMs: { A: 5 * MIN } });
    const old = bs({ updatedAt: 300, done: "w4;A1=0-3" });
    const m = mergeBuild(a, old)!;
    expect(m.timeMs).toEqual({ A: 5 * MIN });
    expect(m.done).toBe("w4;A1=0-3");
  });
  it("reset drops the time recorded before it", () => {
    const before = bs({ updatedAt: 100, timeMs: { A: 30 * MIN } });
    const after = bs({ updatedAt: 500, resetAt: 400, done: "w4", timeMs: { A: 2 * MIN } });
    const m = mergeBuild(before, after)!;
    expect(m.timeMs).toEqual({ A: 2 * MIN });
    expect(mergeBuild(after, before)).toEqual(m);
  });
  it("sameBuild notices a time change", () => {
    expect(sameBuild(bs({ timeMs: { A: 1000 } }), bs({ timeMs: { A: 1000 } }))).toBe(true);
    expect(sameBuild(bs({ timeMs: { A: 1000 } }), bs({ timeMs: { A: 61000 } }))).toBe(false);
    expect(sameBuild(bs(), bs({ timeMs: { A: 1000 } }))).toBe(false);
  });
  it("buildDurationMs reads the summed device time, then legacy fields", () => {
    expect(buildDurationMs({ timeMs: { A: 10 * MIN, B: 5 * MIN } })).toBe(15 * MIN);
    expect(buildDurationMs({ activeMs: 90_000 })).toBe(90_000);
    expect(buildDurationMs(bs())).toBeUndefined();
  });
});
