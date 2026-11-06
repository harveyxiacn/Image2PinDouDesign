import { describe, expect, it } from "vitest";
import { kitCodes, normalizeKitId } from "../lib/palette";
import { PURCHASE_OFFERS } from "../lib/purchase";
import { MARD_265_EXTRAS, MARD_RETAIL_ORDER } from "@engine/paletteKits";

describe("merchant palette kits", () => {
  it("normalizes the retired 264 kit id and exposes the corrected 265 codes", () => {
    expect(normalizeKitId("mard-264")).toBe("mard-265");
    expect(normalizeKitId("mard-265")).toBe("mard-265");
    expect(normalizeKitId("unknown")).toBe("mard-221");
    const codes = kitCodes("mard-265");
    expect(codes).toHaveLength(265);
    expect(codes).toContain("C29");
    expect(new Set(codes)).toEqual(new Set([...MARD_RETAIL_ORDER, ...MARD_265_EXTRAS]));
  });

  it("keeps the 265 purchase offer aligned with the kit size", () => {
    expect(PURCHASE_OFFERS.find((offer) => offer.id === "set-265-257")?.colors).toBe(kitCodes("mard-265").length);
  });
});
