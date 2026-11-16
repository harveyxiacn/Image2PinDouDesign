import { describe, expect, it } from "vitest";
import {
  MAX_ZOOM,
  MIN_ZOOM,
  anchoredScroll,
  clampZoom,
  firstImageIndex,
  isTypingTarget,
  pastedImageName,
  pinchMetrics,
  pinchZoom,
  resolveShortcut,
  shouldHandlePasteImage,
  singlePointerAction,
  stepZoom,
  viewportTouchAction,
  wheelZoomFactor
} from "../domain/viewGestures";

describe("zoom steps", () => {
  it("steps up from fit to 100% and through the levels", () => {
    expect(stepZoom("fit", 1)).toBe(1);
    expect(stepZoom(1, 1)).toBe(1.5);
    expect(stepZoom(2, 1)).toBe(3);
    expect(stepZoom(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
  });
  it("steps down and returns to fit below the smallest level", () => {
    expect(stepZoom(2, -1)).toBe(1.5);
    expect(stepZoom(1, -1)).toBe("fit");
    expect(stepZoom("fit", -1)).toBe("fit");
    expect(stepZoom(0.7, -1)).toBe("fit");
    expect(stepZoom(1.2, 1)).toBe(1.5);
    expect(stepZoom(1.2, -1)).toBe(1);
  });
  it("clamps continuous zoom", () => {
    expect(clampZoom(99)).toBe(MAX_ZOOM);
    expect(clampZoom(0.01)).toBe(MIN_ZOOM);
    expect(clampZoom(Number.NaN)).toBe(1);
  });
  it("wheel factor zooms in when scrolling up and out when scrolling down", () => {
    expect(wheelZoomFactor(-100)).toBeGreaterThan(1);
    expect(wheelZoomFactor(100)).toBeLessThan(1);
    expect(wheelZoomFactor(0)).toBe(1);
    expect(wheelZoomFactor(-3, 1)).toBeCloseTo(wheelZoomFactor(-48, 0));
    expect(wheelZoomFactor(-100000)).toBe(wheelZoomFactor(-240));
  });
});

describe("anchored scroll", () => {
  it("keeps the content under the anchor fixed when zooming", () => {
    // 内容点 (scroll+anchor)/oldSize 在缩放前后应落在同一视口位置
    const scroll = 120;
    const anchor = 200;
    const next = anchoredScroll({ scroll, anchor, oldSize: 1000, newSize: 2000 });
    expect((next + anchor) / 2000).toBeCloseTo((scroll + anchor) / 1000);
  });
  it("never goes negative and tolerates empty sizes", () => {
    expect(anchoredScroll({ scroll: 0, anchor: 300, oldSize: 1000, newSize: 500 })).toBe(0);
    expect(anchoredScroll({ scroll: 50, anchor: 10, oldSize: 0, newSize: 500 })).toBe(50);
  });
});

describe("pinch", () => {
  it("computes distance and center", () => {
    const m = pinchMetrics({ x: 0, y: 0 }, { x: 6, y: 8 });
    expect(m.distance).toBe(10);
    expect(m.center).toEqual({ x: 3, y: 4 });
  });
  it("scales by finger distance ratio and clamps", () => {
    expect(pinchZoom(1, 100, 200)).toBe(2);
    expect(pinchZoom(2, 100, 1000)).toBe(MAX_ZOOM);
    expect(pinchZoom(1, 100, 1)).toBe(MIN_ZOOM);
    expect(pinchZoom(1.5, 3, 100)).toBe(1.5);
  });
});

describe("pointer routing", () => {
  it("middle button pans in every mode", () => {
    expect(singlePointerAction({ button: 1, pointerType: "mouse", editing: true, zoomed: false })).toBe("pan");
  });
  it("left button edits while editing and pans while viewing", () => {
    expect(singlePointerAction({ button: 0, pointerType: "mouse", editing: true, zoomed: true })).toBe("edit");
    expect(singlePointerAction({ button: 0, pointerType: "mouse", editing: false, zoomed: false })).toBe("pan");
  });
  it("leaves one-finger touch to page scrolling when fitted", () => {
    expect(singlePointerAction({ button: 0, pointerType: "touch", editing: false, zoomed: false })).toBe("none");
    expect(singlePointerAction({ button: 0, pointerType: "touch", editing: false, zoomed: true })).toBe("pan");
    expect(singlePointerAction({ button: 2, pointerType: "mouse", editing: false, zoomed: true })).toBe("none");
  });
  it("only takes over touch-action when editing or zoomed", () => {
    expect(viewportTouchAction({ editing: false, zoomed: false })).toBe("pan-y");
    expect(viewportTouchAction({ editing: true, zoomed: false })).toBe("none");
    expect(viewportTouchAction({ editing: false, zoomed: true })).toBe("none");
  });
});

describe("typing targets", () => {
  it("detects text fields but not buttons, sliders or checkboxes", () => {
    expect(isTypingTarget({ tagName: "INPUT", type: "text" })).toBe(true);
    expect(isTypingTarget({ tagName: "INPUT", type: "number" })).toBe(true);
    expect(isTypingTarget({ tagName: "TEXTAREA" })).toBe(true);
    expect(isTypingTarget({ tagName: "SELECT" })).toBe(true);
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isTypingTarget({ tagName: "INPUT", type: "range" })).toBe(false);
    expect(isTypingTarget({ tagName: "INPUT", type: "checkbox" })).toBe(false);
    expect(isTypingTarget({ tagName: "BUTTON" })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe("single-key shortcuts", () => {
  const base = { hasDesign: true, canEdit: true, target: { tagName: "BODY" } };
  it("maps zoom and tool keys", () => {
    expect(resolveShortcut({ ...base, key: "+" })).toEqual({ type: "zoomIn" });
    expect(resolveShortcut({ ...base, key: "=" })).toEqual({ type: "zoomIn" });
    expect(resolveShortcut({ ...base, key: "-" })).toEqual({ type: "zoomOut" });
    expect(resolveShortcut({ ...base, key: "0" })).toEqual({ type: "zoomFit" });
    expect(resolveShortcut({ ...base, key: "B" })).toEqual({ type: "tool", mode: "paint" });
    expect(resolveShortcut({ ...base, key: "g" })).toEqual({ type: "tool", mode: "fill" });
    expect(resolveShortcut({ ...base, key: "c" })).toEqual({ type: "toggleCodes" });
    expect(resolveShortcut({ ...base, key: "?", shiftKey: true })).toEqual({ type: "help" });
  });
  it("does not fire while typing", () => {
    for (const key of ["b", "+", "0", "c", "?"]) {
      expect(resolveShortcut({ ...base, key, target: { tagName: "INPUT", type: "text" } })).toBeNull();
    }
    expect(resolveShortcut({ ...base, key: "e", target: { tagName: "SELECT" } })).toBeNull();
  });
  it("does not hijack browser combinations", () => {
    expect(resolveShortcut({ ...base, key: "+", ctrlKey: true })).toBeNull();
    expect(resolveShortcut({ ...base, key: "0", metaKey: true })).toBeNull();
    expect(resolveShortcut({ ...base, key: "b", altKey: true })).toBeNull();
    expect(resolveShortcut({ ...base, key: "c", ctrlKey: true })).toBeNull();
  });
  it("stays quiet with a modal open, when handled, or without a design", () => {
    expect(resolveShortcut({ ...base, key: "b", modalOpen: true })).toBeNull();
    expect(resolveShortcut({ ...base, key: "b", handled: true })).toBeNull();
    expect(resolveShortcut({ ...base, key: "b", hasDesign: false })).toBeNull();
    expect(resolveShortcut({ ...base, key: "?", hasDesign: false, shiftKey: true })).toEqual({ type: "help" });
  });
  it("only allows edit tools when editing is possible and ignores key repeat", () => {
    expect(resolveShortcut({ ...base, key: "b", canEdit: false })).toBeNull();
    expect(resolveShortcut({ ...base, key: "v", canEdit: false })).toEqual({ type: "tool", mode: "view" });
    expect(resolveShortcut({ ...base, key: "b", repeat: true })).toBeNull();
    expect(resolveShortcut({ ...base, key: "+", repeat: true })).toEqual({ type: "zoomIn" });
  });
});

describe("clipboard images", () => {
  it("finds the first image file", () => {
    expect(firstImageIndex([{ kind: "string", type: "text/plain" }, { kind: "file", type: "image/png" }])).toBe(1);
    expect(firstImageIndex([{ kind: "file", type: "application/pdf" }])).toBe(-1);
  });
  it("skips paste handling in inputs, dialogs and while disabled", () => {
    expect(shouldHandlePasteImage({ target: { tagName: "BODY" } })).toBe(true);
    expect(shouldHandlePasteImage({ target: { tagName: "TEXTAREA" } })).toBe(false);
    expect(shouldHandlePasteImage({ modalOpen: true })).toBe(false);
    expect(shouldHandlePasteImage({ disabled: true })).toBe(false);
  });
  it("renames generic screenshot names", () => {
    const now = new Date(2026, 10, 15, 9, 5, 7);
    expect(pastedImageName("image.png", "image/png", now)).toBe("粘贴图片-090507.png");
    expect(pastedImageName("", "image/webp", now)).toBe("粘贴图片-090507.webp");
    expect(pastedImageName("cat.png", "image/png", now)).toBe("cat.png");
  });
});
