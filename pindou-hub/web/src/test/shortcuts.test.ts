import { describe, expect, it } from "vitest";
import { buildKey, cycleCode, editorKey, globalKey, groupsForRoute, isTypingTarget, plainKey, SHORTCUT_GROUPS } from "../lib/shortcuts";

const body = { tagName: "BODY" };
const input = { tagName: "INPUT", type: "search" };

describe("isTypingTarget", () => {
  it("text-like inputs, textarea, select, contenteditable", () => {
    expect(isTypingTarget(input)).toBe(true);
    expect(isTypingTarget({ tagName: "INPUT" })).toBe(true);
    expect(isTypingTarget({ tagName: "TEXTAREA" })).toBe(true);
    expect(isTypingTarget({ tagName: "SELECT" })).toBe(true);
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
  });
  it("checkbox, button, body are not typing", () => {
    expect(isTypingTarget({ tagName: "INPUT", type: "checkbox" })).toBe(false);
    expect(isTypingTarget({ tagName: "BUTTON" })).toBe(false);
    expect(isTypingTarget(body)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe("plainKey", () => {
  it("rejects modifiers, composing and typing", () => {
    expect(plainKey({ key: "a", ctrlKey: true }, body)).toBeNull();
    expect(plainKey({ key: "a", metaKey: true }, body)).toBeNull();
    expect(plainKey({ key: "a", altKey: true }, body)).toBeNull();
    expect(plainKey({ key: "a", isComposing: true }, body)).toBeNull();
    expect(plainKey({ key: "a" }, input)).toBeNull();
    expect(plainKey({ key: "A", shiftKey: true }, body)).toBe("a");
  });
});

describe("globalKey", () => {
  it("/ focuses search, ? opens help", () => {
    expect(globalKey({ key: "/" }, body, false).action).toEqual({ type: "focusSearch" });
    expect(globalKey({ key: "?", shiftKey: true }, body, false).action).toEqual({ type: "help" });
  });
  it("does nothing while typing or with Ctrl", () => {
    expect(globalKey({ key: "/" }, input, false).action).toBeNull();
    expect(globalKey({ key: "/", ctrlKey: true }, body, false).action).toBeNull();
    expect(globalKey({ key: "?" }, { tagName: "TEXTAREA" }, false).action).toBeNull();
  });
  it("g then letter navigates; g alone only arms", () => {
    const a = globalKey({ key: "g" }, body, false);
    expect(a).toEqual({ action: null, pendingG: true });
    expect(globalKey({ key: "i" }, body, true).action).toEqual({ type: "goto", href: "#/inventory" });
    expect(globalKey({ key: "g" }, body, true).action).toEqual({ type: "goto", href: "#/gallery" });
    expect(globalKey({ key: "," }, body, true).action).toEqual({ type: "goto", href: "#/settings" });
  });
  it("invalid second key disarms; Ctrl+G is not armed; g on a button does not arm", () => {
    expect(globalKey({ key: "x" }, body, true)).toEqual({ action: null, pendingG: false });
    expect(globalKey({ key: "g", ctrlKey: true }, body, false).pendingG).toBe(false);
    expect(globalKey({ key: "g" }, { tagName: "BUTTON" }, false).pendingG).toBe(false);
  });
  it("a failed second key can still be a new command", () => {
    expect(globalKey({ key: "/" }, body, true).action).toEqual({ type: "focusSearch" });
  });
  it("auto-repeat is ignored", () => {
    expect(globalKey({ key: "/", repeat: true }, body, false).action).toBeNull();
  });
});

describe("editorKey", () => {
  it("tools, sizes, colours", () => {
    expect(editorKey({ key: "e" }, body)).toEqual({ type: "tool", tool: "eraser" });
    expect(editorKey({ key: "B" , shiftKey: true }, body)).toEqual({ type: "tool", tool: "brush" });
    expect(editorKey({ key: "i" }, body)).toEqual({ type: "tool", tool: "pick" });
    expect(editorKey({ key: "h" }, body)).toEqual({ type: "tool", tool: "pan" });
    expect(editorKey({ key: "2" }, body)).toEqual({ type: "size", size: 2 });
    expect(editorKey({ key: "[" }, body)).toEqual({ type: "color", dir: -1 });
    expect(editorKey({ key: "]" }, body)).toEqual({ type: "color", dir: 1 });
  });
  it("undo / redo with Ctrl or Cmd", () => {
    expect(editorKey({ key: "z", ctrlKey: true }, body)).toEqual({ type: "undo" });
    expect(editorKey({ key: "z", metaKey: true }, body)).toEqual({ type: "undo" });
    expect(editorKey({ key: "Z", ctrlKey: true, shiftKey: true }, body)).toEqual({ type: "redo" });
    expect(editorKey({ key: "y", ctrlKey: true }, body)).toEqual({ type: "redo" });
  });
  it("other browser combos and typing are left alone", () => {
    expect(editorKey({ key: "e", ctrlKey: true }, body)).toBeNull();
    expect(editorKey({ key: "b", metaKey: true }, body)).toBeNull();
    expect(editorKey({ key: "e", altKey: true }, body)).toBeNull();
    expect(editorKey({ key: "z", ctrlKey: true }, input)).toBeNull();
    expect(editorKey({ key: "e" }, { tagName: "SELECT" })).toBeNull();
    expect(editorKey({ key: "e", isComposing: true }, body)).toBeNull();
    expect(editorKey({ key: "e", repeat: true }, body)).toBeNull();
  });
});

describe("cycleCode", () => {
  it("wraps both ways and handles unknown / empty", () => {
    const l = ["A1", "B2", "C3"];
    expect(cycleCode(l, "A1", 1)).toBe("B2");
    expect(cycleCode(l, "C3", 1)).toBe("A1");
    expect(cycleCode(l, "A1", -1)).toBe("C3");
    expect(cycleCode(l, null, 1)).toBe("A1");
    expect(cycleCode(l, "Z9", -1)).toBe("C3");
    expect(cycleCode([], "A1", 1)).toBeNull();
  });
});

describe("buildKey", () => {
  it("arrows change colour even when a button has focus", () => {
    expect(buildKey({ key: "ArrowRight" }, { tagName: "BUTTON" }, false)).toEqual({ type: "color", dir: 1 });
    expect(buildKey({ key: "ArrowLeft" }, body, false)).toEqual({ type: "color", dir: -1 });
  });
  it("Enter / Space finish the colour, but leave a focused button to click itself", () => {
    expect(buildKey({ key: "Enter" }, body, false)).toEqual({ type: "finish" });
    expect(buildKey({ key: " " }, body, false)).toEqual({ type: "finish" });
    expect(buildKey({ key: "Enter" }, { tagName: "BUTTON" }, false)).toBeNull();
    expect(buildKey({ key: " " }, { tagName: "A" }, false)).toBeNull();
    expect(buildKey({ key: "Enter", repeat: true }, body, false)).toBeNull();
  });
  it("undo, boards, map, row", () => {
    expect(buildKey({ key: "z" }, body, false)).toEqual({ type: "undo" });
    expect(buildKey({ key: "z", ctrlKey: true }, body, false)).toEqual({ type: "undo" });
    expect(buildKey({ key: "[" }, body, false)).toEqual({ type: "board", dir: -1 });
    expect(buildKey({ key: "]" }, body, false)).toEqual({ type: "board", dir: 1 });
    expect(buildKey({ key: "b" }, body, false)).toEqual({ type: "openMap" });
    expect(buildKey({ key: "r" }, body, false)).toEqual({ type: "toggleRow" });
    expect(buildKey({ key: "ArrowUp" }, body, false)).toBeNull();
    expect(buildKey({ key: "ArrowUp" }, body, true)).toEqual({ type: "row", dir: -1 });
    expect(buildKey({ key: "ArrowDown" }, body, true)).toEqual({ type: "row", dir: 1 });
  });
  it("zoom keys", () => {
    expect(buildKey({ key: "+", shiftKey: true }, body, false)).toEqual({ type: "zoom", by: "in" });
    expect(buildKey({ key: "-" }, body, false)).toEqual({ type: "zoom", by: "out" });
    expect(buildKey({ key: "0" }, body, false)).toEqual({ type: "zoom", by: "fit" });
  });
  it("ignores browser combos and typing", () => {
    expect(buildKey({ key: "r", ctrlKey: true }, body, false)).toBeNull();
    expect(buildKey({ key: "r", metaKey: true }, body, false)).toBeNull();
    expect(buildKey({ key: "ArrowLeft" }, input, false)).toBeNull();
    expect(buildKey({ key: "Enter" }, { tagName: "SELECT" }, false)).toBeNull();
  });
});

describe("help table", () => {
  it("has every group once with rows; route puts the relevant group first", () => {
    expect(new Set(SHORTCUT_GROUPS.map((g) => g.id)).size).toBe(SHORTCUT_GROUPS.length);
    expect(SHORTCUT_GROUPS.every((g) => g.rows.length > 0 && g.rows.every((r) => r.keys.length && r.desc))).toBe(true);
    expect(groupsForRoute("build")[0].id).toBe("build");
    expect(groupsForRoute("pattern")[0].id).toBe("editor");
    expect(groupsForRoute("inventory")[0].id).toBe("global");
    expect(groupsForRoute("build")).toHaveLength(SHORTCUT_GROUPS.length);
  });
});
