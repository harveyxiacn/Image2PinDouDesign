import { describe, expect, it } from "vitest";
import { contentPoint, isPanGesture, pinScroll, wheelZoomCell } from "../components/pattern/zoomMath";

describe("wheelZoomCell", () => {
  it("zooms in on negative delta and out on positive", () => {
    expect(wheelZoomCell(20, -100, 0, 3, 48)).toBeGreaterThan(20);
    expect(wheelZoomCell(20, 100, 0, 3, 48)).toBeLessThan(20);
  });
  it("tiny trackpad deltas still move by one pixel", () => {
    expect(wheelZoomCell(20, -1, 0, 3, 48)).toBe(21);
    expect(wheelZoomCell(20, 1, 0, 3, 48)).toBe(19);
  });
  it("zero delta changes nothing; result is clamped", () => {
    expect(wheelZoomCell(20, 0, 0, 3, 48)).toBe(20);
    expect(wheelZoomCell(47, -2000, 0, 3, 48)).toBe(48);
    expect(wheelZoomCell(4, 2000, 0, 3, 48)).toBe(3);
    expect(wheelZoomCell(48, -1, 0, 3, 48)).toBe(48);
  });
  it("line-mode wheels zoom more per tick", () => {
    expect(wheelZoomCell(20, -3, 1, 3, 48)).toBeGreaterThan(wheelZoomCell(20, -3, 0, 3, 48) - 1);
  });
});

describe("isPanGesture", () => {
  it("middle button, or space + left", () => {
    expect(isPanGesture(1, false)).toBe(true);
    expect(isPanGesture(0, true)).toBe(true);
    expect(isPanGesture(0, false)).toBe(false);
    expect(isPanGesture(2, true)).toBe(false);
  });
});

describe("pinScroll / contentPoint", () => {
  it("keeps the content point under the finger midpoint while zooming", () => {
    const pin = contentPoint(100, 50, 200, 150, 10); // 内容点 (30, 20) 格
    expect(pin).toEqual({ cx: 30, cy: 20 });
    expect(pinScroll(pin, 10, 200, 150)).toEqual({ left: 100, top: 50 });
    // 放大到 20：同一内容点仍在 (200,150)
    expect(pinScroll(pin, 20, 200, 150)).toEqual({ left: 400, top: 250 });
  });
  it("moving both fingers pans the content with them", () => {
    const pin = { cx: 30, cy: 20 };
    // 中点向右下移动 40/30 像素 → 滚动位置减小同样多（内容跟手）
    expect(pinScroll(pin, 10, 240, 180)).toEqual({ left: 60, top: 20 });
  });
  it("never scrolls negative", () => {
    expect(pinScroll({ cx: 1, cy: 1 }, 10, 500, 500)).toEqual({ left: 0, top: 0 });
  });
});
