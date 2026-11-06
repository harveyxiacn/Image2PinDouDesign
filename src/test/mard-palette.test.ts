// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { convertPixelSourceToDesign } from "../domain/conversion";
import { MARD_221_SEEDS, MARD_EXTENDED_SEEDS, MARD_PALETTE } from "../domain/palette";
import {
  DEFAULT_KIT_ID,
  KIT_STORAGE_KEY,
  MARD_265_EXTRAS,
  MARD_RETAIL_ORDER,
  PALETTE_KITS,
  getPaletteKit,
  loadPaletteKitId,
  paletteForKit,
  resolveAllowedCodes
} from "../domain/paletteKits";
import { INVENTORY_STORAGE_KEY, loadOwnedInventory } from "../domain/shortfall";

const CHART_SERIES: Record<string, number> = { A: 26, B: 32, C: 29, D: 26, E: 24, F: 25, G: 21, H: 23, M: 15 };
const VALID = new Set(MARD_PALETTE.map((color) => color.code));

describe("MARD palette from mard_color_sheet", () => {
  it("lists exactly the 221 chart codes, in series order", () => {
    const expected = Object.entries(CHART_SERIES).flatMap(([series, count]) =>
      Array.from({ length: count }, (_, index) => `${series}${index + 1}`));
    expect(MARD_221_SEEDS.map((seed) => seed.code)).toEqual(expected);
  });

  it("uses the chart hex values", () => {
    const hex = (code: string) => MARD_PALETTE.find((color) => color.code === code)?.hex;
    expect(hex("A1")).toBe("#faf4c8");
    expect(hex("B32")).toBe("#9cab5a");
    expect(hex("C29")).toBe("#34488e");
    expect(hex("D26")).toBe("#dfc2f8");
    expect(hex("E24")).toBe("#e1bce8");
    expect(hex("F25")).toBe("#e54b4f");
    expect(hex("G21")).toBe("#b88558");
    expect(hex("H7")).toBe("#000000");
    expect(hex("H23")).toBe("#9a9d94");
    expect(hex("M15")).toBe("#757d78");
  });

  it("keeps the 70 extended codes for lookups, statistics and old drafts", () => {
    expect(MARD_EXTENDED_SEEDS).toHaveLength(70);
    expect(MARD_PALETTE).toHaveLength(291);
    expect(new Set(MARD_PALETTE.map((color) => color.code)).size).toBe(291);
  });
});

describe("palette kits", () => {
  beforeEach(() => window.localStorage.clear());

  it("defaults to the 221-color kit and remembers the choice", () => {
    expect(DEFAULT_KIT_ID).toBe("mard-221");
    expect(loadPaletteKitId()).toBe("mard-221");
    window.localStorage.setItem(KIT_STORAGE_KEY, "mard-291");
    expect(loadPaletteKitId()).toBe("mard-291");
    window.localStorage.setItem(KIT_STORAGE_KEY, "unknown-kit");
    expect(loadPaletteKitId()).toBe("mard-221");
    expect(paletteForKit(getPaletteKit("mard-221"))).toHaveLength(221);
    expect(paletteForKit(getPaletteKit("mard-291"))).toHaveLength(291);
  });

  it("matches the merchant chart compositions for retail kits", () => {
    for (const size of [24, 48, 72, 96, 120, 144, 168, 192, 216]) {
      expect(getPaletteKit(`mard-${size}`).codes).toEqual(MARD_RETAIL_ORDER.slice(0, size));
    }
    expect(getPaletteKit("mard-221").codes).toHaveLength(221);
    expect(new Set(getPaletteKit("mard-221").codes)).toEqual(new Set(MARD_RETAIL_ORDER));
    expect(getPaletteKit("mard-221").codes.slice(216)).toEqual(["C29", "D10", "B9", "C12", "D4"]);
    expect(getPaletteKit("mard-265").codes).toHaveLength(265);
    expect(getPaletteKit("mard-265").codes).toContain("C29");
    expect(new Set(getPaletteKit("mard-265").codes)).toEqual(new Set([...MARD_RETAIL_ORDER, ...MARD_265_EXTRAS]));
    expect(MARD_265_EXTRAS).toHaveLength(44);
  });

  it("resolves the retired 264 kit id to the corrected 265 kit", () => {
    window.localStorage.setItem(KIT_STORAGE_KEY, "mard-264");
    expect(loadPaletteKitId()).toBe("mard-265");
    expect(getPaletteKit("mard-264").codes).toHaveLength(265);
    expect(paletteForKit(getPaletteKit("mard-264"))).toHaveLength(265);
    expect(resolveAllowedCodes(getPaletteKit("mard-265"), ["C29"])).toEqual(["C29"]);
  });

  it("only references real palette codes", () => {
    for (const kit of PALETTE_KITS) {
      expect(kit.codes.every((code) => VALID.has(code))).toBe(true);
      expect(new Set(kit.codes).size).toBe(kit.codes.length);
    }
  });

  it("intersects the kit with the inventory and falls back to the kit", () => {
    const kit221 = getPaletteKit("mard-221");
    expect(resolveAllowedCodes(kit221, null)).toHaveLength(221);
    expect(resolveAllowedCodes(kit221, ["A4", "R1"])).toEqual(["A4"]);
    expect(resolveAllowedCodes(kit221, ["R1"])).toHaveLength(221);
    expect(resolveAllowedCodes(getPaletteKit("mard-291"), null)).toBeNull();
    expect(resolveAllowedCodes(getPaletteKit("mard-291"), ["R1"])).toEqual(["R1"]);
  });

  it("never matches colors outside the selected kit", () => {
    const extended = MARD_EXTENDED_SEEDS.map((seed) => seed.hex);
    const width = extended.length;
    const data = new Uint8ClampedArray(width * 4);
    extended.forEach((hex, index) => {
      data.set([parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16), 255], index * 4);
    });
    const settings = {
      boardWidth: width, boardHeight: 1, maxColors: "all" as const, keepTransparent: true, transparentThreshold: 10,
      dither: false, fit: "stretch" as const, sampling: "nearest" as const, autoFrame: false
    };
    const kitCodes = new Set(getPaletteKit("mard-221").codes);
    const restricted = convertPixelSourceToDesign({ width, height: 1, data }, "ext.png",
      { ...settings, allowedColorCodes: [...kitCodes] }, MARD_PALETTE);
    expect(Object.keys(restricted.colorCounts).every((code) => kitCodes.has(code))).toBe(true);
    const full = convertPixelSourceToDesign({ width, height: 1, data }, "ext.png", settings, MARD_PALETTE);
    expect(Object.keys(full.colorCounts).some((code) => !kitCodes.has(code))).toBe(true);
  });

  it("drops unknown codes from the saved inventory", () => {
    window.localStorage.setItem(INVENTORY_STORAGE_KEY, JSON.stringify({ restrictEnabled: true, owned: { A4: 20, R1: 5, XX9: 2 } }));
    expect(loadOwnedInventory(VALID)).toEqual({ restrictEnabled: true, owned: { A4: 20, R1: 5 } });
  });
});
