import { describe, expect, it } from "vitest";
import { clampView, doubleTapTarget, limits, pxPerImagePx, toFraction, viewportRect, zoomAt } from "../components/pattern/zoomMath";

describe("zoomMath", () => {
  it("max scale lets one image pixel reach 24 screen px, capped", () => {
    const l = limits(700, 2400);
    expect(l.max).toBeCloseTo(82.2857, 3);
    expect(limits(700, 700).max).toBe(24);
    expect(limits(700, 5000).max).toBe(96);
    expect(limits(700).max).toBe(8);
    expect(limits(700, 2100).actual).toBe(3);
    expect(limits(700, 350).min).toBe(0.5);
  });
  it("zoomAt keeps the point under the cursor fixed", () => {
    const lim = limits(600, 3000);
    const a = zoomAt({ s: 1, x: 0, y: 0 }, 4, 100, 50, 600, 400, lim);
    expect(a.s).toBe(4);
    expect(toFraction(a, 100, 50, 600, 400).fx).toBeCloseTo(toFraction({ s: 1, x: 0, y: 0 }, 100, 50, 600, 400).fx, 5);
  });
  it("clamps pan so edges stay reachable but never leave the box", () => {
    const lim = limits(600, 3000);
    const c = clampView({ s: 2, x: 9999, y: -9999 }, 600, 400, lim);
    expect(c).toEqual({ s: 2, x: 300, y: -200 });
    expect(clampView({ s: 1, x: 50, y: 50 }, 600, 400, lim)).toEqual({ s: 1, x: 0, y: 0 });
  });
  it("double tap toggles between fit and 4x", () => {
    expect(doubleTapTarget({ s: 1, x: 0, y: 0 }, 4)).toBe(4);
    expect(doubleTapTarget({ s: 4, x: 0, y: 0 }, 4)).toBe(1);
  });
  it("pixel density and viewport rect", () => {
    expect(pxPerImagePx(3, 600, 1200)).toBe(1.5);
    expect(viewportRect({ s: 1, x: 0, y: 0 }, 600, 400)).toEqual({ l: 0, t: 0, w: 1, h: 1 });
    const r = viewportRect({ s: 2, x: 300, y: 200 }, 600, 400); // 内容右移到最大 → 看到左上角
    expect(r).toEqual({ l: 0, t: 0, w: 0.5, h: 0.5 });
  });
});
