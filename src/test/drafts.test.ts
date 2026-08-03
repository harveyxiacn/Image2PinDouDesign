// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  DRAFTS_STORAGE_KEY,
  MAX_LOCAL_DRAFTS,
  deserializeDraft,
  loadDesignDrafts,
  persistDesignDrafts,
  serializeDraft
} from "../domain/drafts";
import type { BeadDesign, ConversionSettings } from "../domain/types";

const VALID_CODES = new Set(["A1", "B1", "C2", "H7"]);

const SETTINGS: ConversionSettings = {
  boardWidth: 2,
  boardHeight: 2,
  maxColors: 8,
  keepTransparent: true,
  transparentThreshold: 10,
  dither: false
};

// serializeDraft 的返回类型是 unknown，测试里需要展开为对象时才做一次收窄。
function serialized(design: BeadDesign): Record<string, unknown> {
  return serializeDraft(design) as Record<string, unknown>;
}

function makeDesign(overrides: Partial<BeadDesign> = {}): BeadDesign {
  return {
    id: "draft-abc123",
    fileName: "亚古兽-本机草稿",
    boardWidth: 2,
    boardHeight: 2,
    matrix: [
      ["A1", "B1"],
      ["C2", null]
    ],
    colorCounts: { A1: 1, B1: 1, C2: 1 },
    settings: SETTINGS,
    ...overrides
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("deserializeDraft", () => {
  it("round-trips serialize -> deserialize for a valid draft", () => {
    const design = makeDesign();
    const restored = deserializeDraft(serialized(design), 0, VALID_CODES);

    expect(restored).not.toBeNull();
    expect(restored).toEqual(design);
    expect(restored?.id).toBe("draft-abc123");
    expect(restored?.fileName).toBe("亚古兽-本机草稿");
    expect(restored?.boardWidth).toBe(2);
    expect(restored?.boardHeight).toBe(2);
    expect(restored?.matrix).toEqual([["A1", "B1"], ["C2", null]]);
    expect(restored?.colorCounts).toEqual({ A1: 1, B1: 1, C2: 1 });
  });

  it("filters out color codes outside the whitelist and recomputes counts", () => {
    const restored = deserializeDraft({
      ...serialized(makeDesign()),
      matrix: [
        ["A1", "NOT-A-CODE"],
        ["B1", "Z9"]
      ]
    }, 0, VALID_CODES);

    expect(restored?.matrix).toEqual([["A1", null], ["B1", null]]);
    expect(restored?.colorCounts).toEqual({ A1: 1, B1: 1 });
  });

  it("rejects invalid or non-integer dimensions", () => {
    expect(deserializeDraft({ ...serialized(makeDesign()), boardWidth: 0 }, 0, VALID_CODES)).toBeNull();
    expect(deserializeDraft({ ...serialized(makeDesign()), boardHeight: 209 }, 0, VALID_CODES)).toBeNull();
    expect(deserializeDraft({ ...serialized(makeDesign()), boardWidth: -1 }, 0, VALID_CODES)).toBeNull();
    expect(deserializeDraft({ ...serialized(makeDesign()), boardHeight: 1.5 }, 0, VALID_CODES)).toBeNull();
    expect(deserializeDraft({ ...serialized(makeDesign()), boardWidth: "abc" }, 0, VALID_CODES)).toBeNull();
    expect(deserializeDraft(null, 0, VALID_CODES)).toBeNull();
    expect(deserializeDraft("not-an-object", 0, VALID_CODES)).toBeNull();
  });

  it("restores non draft-prefixed ids and missing file names", () => {
    const restored = deserializeDraft({
      ...serialized(makeDesign()),
      id: "generated-xyz",
      fileName: undefined
    }, 2, VALID_CODES);

    expect(restored?.id).toMatch(/^draft-restored-2-\d+$/);
    expect(restored?.fileName).toBe("本机草稿 3");
  });

  it("keeps existing draft-prefixed ids and file names", () => {
    const restored = deserializeDraft(serialized(makeDesign()), 0, VALID_CODES);
    expect(restored?.id).toBe("draft-abc123");
    expect(restored?.fileName).toBe("亚古兽-本机草稿");
  });

  it("passes settings through untouched", () => {
    const settings = { ...SETTINGS, maxColors: 24 as const };
    const restored = deserializeDraft({ ...serialized(makeDesign()), settings }, 0, VALID_CODES);
    expect(restored?.settings).toBe(settings);
  });

  it("tolerates ragged matrices shorter than boardWidth/boardHeight", () => {
    const restored = deserializeDraft({
      ...serialized(makeDesign()),
      matrix: [["A1"]]
    }, 0, VALID_CODES);
    expect(restored?.matrix).toEqual([["A1", null], [null, null]]);
  });
});

describe("loadDesignDrafts / persistDesignDrafts", () => {
  it("persists and reloads drafts through localStorage", () => {
    const drafts = Array.from({ length: 8 }, (_, i) =>
      makeDesign({ id: `draft-${i}`, fileName: `草稿 ${i + 1}` }));

    persistDesignDrafts(drafts);

    const stored = JSON.parse(window.localStorage.getItem(DRAFTS_STORAGE_KEY) ?? "[]") as unknown[];
    expect(stored).toHaveLength(MAX_LOCAL_DRAFTS);

    const restored = loadDesignDrafts(VALID_CODES);
    expect(restored).toHaveLength(MAX_LOCAL_DRAFTS);
    expect(restored[0]).toEqual(drafts[0]);
    expect(restored[MAX_LOCAL_DRAFTS - 1]).toEqual(drafts[MAX_LOCAL_DRAFTS - 1]);
    expect(restored.some((draft) => draft.id === "draft-7")).toBe(false);
  });

  it("returns an empty list for corrupt or non-array storage", () => {
    window.localStorage.setItem(DRAFTS_STORAGE_KEY, "{not json");
    expect(loadDesignDrafts(VALID_CODES)).toEqual([]);

    window.localStorage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify({ not: "an array" }));
    expect(loadDesignDrafts(VALID_CODES)).toEqual([]);
  });

  it("skips invalid entries during load", () => {
    persistDesignDrafts([makeDesign()]);
    window.localStorage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify([
      { ...serialized(makeDesign()), boardWidth: 999 },
      serialized(makeDesign({ id: "draft-valid", fileName: "有效草稿" })),
      null
    ]));

    const restored = loadDesignDrafts(VALID_CODES);
    expect(restored).toHaveLength(1);
    expect(restored[0].id).toBe("draft-valid");
    expect(restored[0].fileName).toBe("有效草稿");
  });
});
