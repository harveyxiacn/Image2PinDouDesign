import { describe, expect, it } from "vitest";
import {
  applyConversionMessage,
  cancelConversionTask,
  createConversionCoordinator,
  type ConversionCoordinatorState
} from "../domain/conversionCoordinator";
import type { BeadDesign } from "../domain/types";
import type { ConversionResponse } from "../worker/conversion.worker";

const IMAGES = [
  { id: "img-a", fileName: "a.png" },
  { id: "img-b", fileName: "b.png" },
  { id: "img-c", fileName: "c.png" }
];

function makeDesign(id: string): BeadDesign {
  return {
    id,
    fileName: `${id}.png`,
    boardWidth: 1,
    boardHeight: 1,
    matrix: [["A1"]],
    colorCounts: { A1: 1 }
  };
}

const progress = (id: string, percent: number, phase: "prepare" | "done" = "prepare"): ConversionResponse => ({
  type: "progress",
  generation: 1,
  id,
  percent,
  phase
});
const designMessage = (id: string): ConversionResponse => ({ generation: 1, id, design: makeDesign(id) });
const errorMessage = (id: string, error = "转换失败"): ConversionResponse => ({ generation: 1, id, error });
const cancelledMessage = (id: string): ConversionResponse => ({ type: "cancelled", generation: 1, id });

const start = (): ConversionCoordinatorState => createConversionCoordinator(1, IMAGES);

describe("createConversionCoordinator", () => {
  it("initializes per-image progress and pending count", () => {
    const state = start();
    expect(state.generation).toBe(1);
    expect(state.pending).toBe(3);
    expect(state.done).toBe(false);
    expect(state.progress).toEqual({
      "img-a": { fileName: "a.png", percent: 0, phase: "prepare" },
      "img-b": { fileName: "b.png", percent: 0, phase: "prepare" },
      "img-c": { fileName: "c.png", percent: 0, phase: "prepare" }
    });
    expect(state.results).toEqual({});
    expect(state.error).toBeNull();
    expect(state.cancelled.size).toBe(0);
  });

  it("is done immediately for an empty image list", () => {
    const state = createConversionCoordinator(1, []);
    expect(state.pending).toBe(0);
    expect(state.done).toBe(true);
  });
});

describe("applyConversionMessage", () => {
  it("ignores messages from a stale generation (returns the same state)", () => {
    const state = start();
    expect(applyConversionMessage(state, { type: "progress", generation: 0, id: "img-a", percent: 50, phase: "prepare" })).toBe(state);
    expect(applyConversionMessage(state, { generation: 0, id: "img-a", design: makeDesign("img-a") })).toBe(state);
    expect(applyConversionMessage(state, { generation: 0, id: "img-a", error: "old" })).toBe(state);
  });

  it("updates progress without touching the input state", () => {
    const state = start();
    const next = applyConversionMessage(state, progress("img-a", 42, "done"));

    expect(next.progress["img-a"]).toEqual({ fileName: "a.png", percent: 42, phase: "done" });
    expect(next.progress["img-b"]).toEqual({ fileName: "b.png", percent: 0, phase: "prepare" });
    expect(next.pending).toBe(3);
    expect(next.done).toBe(false);
    // 入参未被修改
    expect(state.progress["img-a"]).toEqual({ fileName: "a.png", percent: 0, phase: "prepare" });
    expect(state.progress).not.toBe(next.progress);
  });

  it("finalizes a normal design result", () => {
    const state = start();
    const next = applyConversionMessage(state, designMessage("img-a"));

    expect(next.results).toEqual({ "img-a": makeDesign("img-a") });
    expect(next.progress["img-a"]).toBeUndefined();
    expect(next.pending).toBe(2);
    expect(next.cancelled.has("img-a")).toBe(false);
    expect(state.results).toEqual({});
  });

  it("discards a design for a cancelled task but still finalizes it", () => {
    const cancelled = cancelConversionTask(start(), "img-a");
    const next = applyConversionMessage(cancelled, designMessage("img-a"));

    expect(next.results).toEqual({});
    expect(next.cancelled.has("img-a")).toBe(false);
    expect(next.progress["img-a"]).toBeUndefined();
    expect(next.pending).toBe(2);
  });

  it("records an error and finalizes the task", () => {
    const state = start();
    const next = applyConversionMessage(state, errorMessage("img-b", "内存不足"));

    expect(next.error).toBe("内存不足");
    expect(next.progress["img-b"]).toBeUndefined();
    expect(next.pending).toBe(2);
  });

  it("handles the worker-skipped cancelled terminal message", () => {
    const state = start();
    const next = applyConversionMessage(state, cancelledMessage("img-b"));

    expect(next.progress["img-b"]).toBeUndefined();
    expect(next.pending).toBe(2);
  });

  it("ignores progress messages for cancelled tasks", () => {
    const cancelled = cancelConversionTask(start(), "img-a");
    const next = applyConversionMessage(cancelled, progress("img-a", 100, "done"));

    expect(next).toBe(cancelled);
    expect(next.progress["img-a"]).toBeUndefined();
  });

  it("never decrements pending below zero on duplicate terminal messages", () => {
    let state = start();
    state = applyConversionMessage(state, designMessage("img-a"));
    state = applyConversionMessage(state, designMessage("img-a")); // 重复终结
    state = applyConversionMessage(state, cancelledMessage("img-b"));
    state = applyConversionMessage(state, cancelledMessage("img-b")); // 重复终结
    state = applyConversionMessage(state, errorMessage("img-c"));
    state = applyConversionMessage(state, errorMessage("img-c")); // 重复终结

    expect(state.pending).toBe(0);
    expect(state.done).toBe(true);

    // 已全部收尾后再来一条终结消息，pending 仍为 0
    const extra = applyConversionMessage(state, designMessage("img-a"));
    expect(extra.pending).toBe(0);
    expect(extra.done).toBe(true);
  });

  it("marks done only after every task has finalized", () => {
    let state = start();
    state = applyConversionMessage(state, designMessage("img-a"));
    state = applyConversionMessage(state, designMessage("img-b"));
    expect(state.done).toBe(false);

    state = applyConversionMessage(state, designMessage("img-c"));
    expect(state.done).toBe(true);
    expect(state.results).toEqual({
      "img-a": makeDesign("img-a"),
      "img-b": makeDesign("img-b"),
      "img-c": makeDesign("img-c")
    });
  });
});

describe("cancelConversionTask", () => {
  it("adds the id to cancelled and removes it from progress immediately", () => {
    const state = start();
    const next = cancelConversionTask(state, "img-a");

    expect(next.cancelled).toEqual(new Set(["img-a"]));
    expect(next.progress["img-a"]).toBeUndefined();
    expect(next.progress["img-b"]).toBeDefined();
    expect(next.pending).toBe(3); // 取消不终结，只登记
    expect(state.cancelled.size).toBe(0);
  });

  it("is idempotent for repeated cancels", () => {
    const state = start();
    const once = cancelConversionTask(state, "img-a");
    const twice = cancelConversionTask(once, "img-a");

    expect(twice).toBe(once);
    expect(twice.cancelled).toEqual(new Set(["img-a"]));
    expect(twice.progress["img-a"]).toBeUndefined();
  });

  it("cancelling multiple tasks keeps all of them registered", () => {
    const state = start();
    const next = cancelConversionTask(cancelConversionTask(state, "img-a"), "img-c");
    expect(next.cancelled).toEqual(new Set(["img-a", "img-c"]));
    expect(next.progress["img-a"]).toBeUndefined();
    expect(next.progress["img-c"]).toBeUndefined();
    expect(next.progress["img-b"]).toBeDefined();
  });
});
