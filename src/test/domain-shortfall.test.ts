// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  INVENTORY_STORAGE_KEY,
  INVENTORY_STORAGE_KEY_V1,
  addOwnedForCodes,
  computeShortfall,
  loadOwnedInventory,
  ownedToAllowedCodes,
  persistOwnedInventory,
  setOwnedCount
} from "../domain/shortfall";
import type { OwnedInventory } from "../domain/shortfall";

describe("computeShortfall", () => {
  it("computes max(0, needed - owned) and keeps only positive entries", () => {
    expect(computeShortfall({ A: 5, B: 3, C: 2 }, { A: 2, B: 10 })).toEqual({ A: 3, C: 2 });
  });

  it("returns the full need when nothing is owned", () => {
    expect(computeShortfall({ A: 5, B: 7 }, {})).toEqual({ A: 5, B: 7 });
  });

  it("drops zero-need and fully-covered codes", () => {
    expect(computeShortfall({ A: 5, B: 0, C: 3 }, { A: 5, C: 3 })).toEqual({});
    expect(computeShortfall({ A: 5 }, { A: 9 })).toEqual({});
  });

  it("is pure and ignores owned codes not in needed", () => {
    const needed = { A: 2 };
    const owned = { A: 1, B: 100 };
    const result = computeShortfall(needed, owned);
    expect(result).toEqual({ A: 1 });
    expect(needed).toEqual({ A: 2 });
    expect(owned).toEqual({ A: 1, B: 100 });
  });
});

describe("ownedToAllowedCodes", () => {
  it("returns null when restriction is disabled", () => {
    expect(ownedToAllowedCodes({ restrictEnabled: false, owned: { A: 3 } })).toBeNull();
  });

  it("returns only codes with positive counts when restriction is enabled", () => {
    const inventory: OwnedInventory = { restrictEnabled: true, owned: { A: 3, B: 0, C: -1, D: 2 } };
    expect(ownedToAllowedCodes(inventory)).toEqual(new Set(["A", "D"]));
  });

  it("returns an empty set when nothing is owned", () => {
    expect(ownedToAllowedCodes({ restrictEnabled: true, owned: {} })).toEqual(new Set());
  });
});

describe("setOwnedCount", () => {
  it("sets a positive count without mutating the input", () => {
    const owned = { A: 1 };
    const next = setOwnedCount(owned, "B", 3);
    expect(next).toEqual({ A: 1, B: 3 });
    expect(owned).toEqual({ A: 1 });
  });

  it("removes the key when count is zero or negative", () => {
    expect(setOwnedCount({ A: 1, B: 2 }, "A", 0)).toEqual({ B: 2 });
    expect(setOwnedCount({ A: 5 }, "A", -2)).toEqual({});
    expect(setOwnedCount({ A: 5 }, "B", -2)).toEqual({ A: 5 });
  });

  it("clamps fractional counts to whole beads", () => {
    expect(setOwnedCount({}, "A", 3.7)).toEqual({ A: 3 });
  });
});

describe("addOwnedForCodes", () => {
  it("sets a minimum count for each code, keeping larger existing values", () => {
    const owned = { A: 5 };
    const next = addOwnedForCodes(owned, ["A", "B", "C"], 3);
    expect(next).toEqual({ A: 5, B: 3, C: 3 });
    expect(owned).toEqual({ A: 5 });
  });

  it("accepts any iterable and does not add entries for non-positive counts", () => {
    expect(addOwnedForCodes({}, new Set(["X", "Y"]), 4)).toEqual({ X: 4, Y: 4 });
    expect(addOwnedForCodes({}, ["X"], 0)).toEqual({});
    expect(addOwnedForCodes({ A: 2 }, ["A"], 0)).toEqual({ A: 2 });
  });
});

describe("localStorage inventory (v1 → v2)", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("returns defaults when nothing is stored", () => {
    expect(loadOwnedInventory()).toEqual({ restrictEnabled: false, owned: {} });
  });

  it("migrates v1 allowedCodes into v2 owned counts of 1", () => {
    window.localStorage.setItem(
      INVENTORY_STORAGE_KEY_V1,
      JSON.stringify({ restrictEnabled: true, allowedCodes: ["A1", "B2", "C3", "A1"] })
    );
    expect(loadOwnedInventory()).toEqual({ restrictEnabled: true, owned: { A1: 1, B2: 1, C3: 1 } });
  });

  it("carries restrictEnabled over from v1 even when disabled", () => {
    window.localStorage.setItem(
      INVENTORY_STORAGE_KEY_V1,
      JSON.stringify({ restrictEnabled: false, allowedCodes: ["A1"] })
    );
    expect(loadOwnedInventory()).toEqual({ restrictEnabled: false, owned: { A1: 1 } });
  });

  it("prefers v2 over v1 when both exist", () => {
    window.localStorage.setItem(
      INVENTORY_STORAGE_KEY_V1,
      JSON.stringify({ restrictEnabled: true, allowedCodes: ["A1"] })
    );
    window.localStorage.setItem(
      INVENTORY_STORAGE_KEY,
      JSON.stringify({ restrictEnabled: false, owned: { D4: 12 } })
    );
    expect(loadOwnedInventory()).toEqual({ restrictEnabled: false, owned: { D4: 12 } });
  });

  it("sanitizes v2 owned entries on load", () => {
    window.localStorage.setItem(
      INVENTORY_STORAGE_KEY,
      JSON.stringify({ restrictEnabled: true, owned: { A: 5, B: 0, C: -2, D: 999999 } })
    );
    expect(loadOwnedInventory()).toEqual({ restrictEnabled: true, owned: { A: 5, D: 99999 } });
  });

  it("falls back to defaults on corrupt JSON", () => {
    window.localStorage.setItem(INVENTORY_STORAGE_KEY, "{oops");
    expect(loadOwnedInventory()).toEqual({ restrictEnabled: false, owned: {} });
    window.localStorage.removeItem(INVENTORY_STORAGE_KEY);
    window.localStorage.setItem(INVENTORY_STORAGE_KEY_V1, "not-json");
    expect(loadOwnedInventory()).toEqual({ restrictEnabled: false, owned: {} });
  });

  it("persists v2 with clamped positive counts and leaves v1 untouched", () => {
    window.localStorage.setItem(
      INVENTORY_STORAGE_KEY_V1,
      JSON.stringify({ restrictEnabled: true, allowedCodes: ["A1"] })
    );
    persistOwnedInventory({ restrictEnabled: true, owned: { A1: 3, B2: 0, C3: -5, D4: 150000 } });

    const raw = window.localStorage.getItem(INVENTORY_STORAGE_KEY);
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw as string)).toEqual({ restrictEnabled: true, owned: { A1: 3, D4: 99999 } });
    // v1 保持不变，迁移不反向污染
    expect(JSON.parse(window.localStorage.getItem(INVENTORY_STORAGE_KEY_V1) as string)).toEqual({
      restrictEnabled: true,
      allowedCodes: ["A1"]
    });
    // 往返一致
    expect(loadOwnedInventory()).toEqual({ restrictEnabled: true, owned: { A1: 3, D4: 99999 } });
  });

  it("round-trips a persisted inventory", () => {
    persistOwnedInventory({ restrictEnabled: true, owned: { R1: 42, K1: 7 } });
    expect(loadOwnedInventory()).toEqual({ restrictEnabled: true, owned: { R1: 42, K1: 7 } });
  });
});

