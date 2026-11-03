// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DesignPreview } from "../components/DesignPreview";
import { BOARD_PIN_OPTIONS, maxBoardsPerSide } from "../domain/boards";
import { fitDesignToInventory } from "../domain/inventoryFit";
import { MARD_221_SEEDS, MARD_PALETTE } from "../domain/palette";
import { PALETTE_KITS, getPaletteKit } from "../domain/paletteKits";
import { adviseColors, adviseSize } from "../domain/smartAdvisor";
import type { BeadDesign, PixelSource } from "../domain/types";
import { replaceDesignCells } from "../domain/workbench";

const STANDARD = new Set(MARD_221_SEEDS.map((seed) => seed.code));

function image(width: number, height: number, color: (x: number, y: number) => [number, number, number]): PixelSource {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) data.set([...color(x, y), 255], (y * width + x) * 4);
  }
  return { width, height, data };
}

describe("board pins and palette kits", () => {
  it("offers a single 104-pin board", () => {
    expect(BOARD_PIN_OPTIONS.map((option) => option.pins)).toContain(104);
    expect(maxBoardsPerSide(104)).toBe(2);
  });

  it("provides the official MARD retail kits from 24 to 264 colors plus all 291", () => {
    const sizes = [24, 48, 72, 96, 120, 144, 168, 192, 216, 221];
    let previous: readonly string[] = [];
    for (const size of sizes) {
      const kit = getPaletteKit(`mard-${size}`);
      expect(kit.codes).toHaveLength(size);
      expect(new Set(kit.codes).size).toBe(size);
      expect(kit.codes.every((code) => STANDARD.has(code))).toBe(true);
      expect(new Set(kit.codes)).toEqual(new Set([...previous, ...kit.codes]));
      expect(previous.every((code) => kit.codes.includes(code))).toBe(true);
      previous = kit.codes;
    }
    // 官方 24 色套装的固定内容（含黑白）。
    expect(getPaletteKit("mard-24").codes).toEqual(expect.arrayContaining(["H1", "H2", "H7", "A4", "B5", "C5"]));
    const kit264 = getPaletteKit("mard-264");
    expect(kit264.codes).toHaveLength(264);
    expect(kit264.codes).not.toContain("C29");
    expect(kit264.codes).toEqual(expect.arrayContaining(["P1", "R13", "Y5", "Q5", "T1"]));
    expect(PALETTE_KITS.map((kit) => kit.codes.length)).toEqual([...sizes, 264, 291]);
  });

  it("migrates the old curated kit ids to the official kit of the same size", () => {
    expect(getPaletteKit("curated-48").id).toBe("mard-48");
    expect(getPaletteKit("nope").id).toBe("mard-221");
  });
});

describe("batch cell edits", () => {
  const design: BeadDesign = {
    id: "d", fileName: "d.png", boardWidth: 3, boardHeight: 2,
    matrix: [["A4", "A4", null], ["H7", "A4", "H7"]], colorCounts: { A4: 3, H7: 2 }
  };

  it("updates many cells and counts in one step", () => {
    const next = replaceDesignCells(design, [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 1 }, { x: 9, y: 9 }], "B3");
    expect(next.matrix).toEqual([["B3", "A4", "B3"], ["B3", "A4", "H7"]]);
    expect(next.colorCounts).toEqual({ A4: 2, H7: 1, B3: 3 });
    expect(design.matrix[0][0]).toBe("A4");
  });

  it("erases and returns the same reference when nothing changes", () => {
    expect(replaceDesignCells(design, [{ x: 2, y: 0 }], null)).toBe(design);
    expect(replaceDesignCells(design, [{ x: 1, y: 1 }], null).colorCounts).toEqual({ A4: 2, H7: 2 });
  });
});

describe("inventory fit", () => {
  const nearestTo = (code: string) => {
    const base = MARD_PALETTE.find((color) => color.code === code)!;
    return MARD_PALETTE.filter((color) => color.code !== code)
      .sort((a, b) => ((a.lab.l - base.lab.l) ** 2 + (a.lab.a - base.lab.a) ** 2 + (a.lab.b - base.lab.b) ** 2)
        - ((b.lab.l - base.lab.l) ** 2 + (b.lab.a - base.lab.a) ** 2 + (b.lab.b - base.lab.b) ** 2))[0].code;
  };
  const design: BeadDesign = {
    id: "fit", fileName: "fit.png", boardWidth: 5, boardHeight: 2,
    matrix: [["A4", "A4", "A4", "A4", "A4"], ["A4", "A4", "A4", "A4", "A4"]], colorCounts: { A4: 10 }
  };

  it("replaces the shortage with a close owned color", () => {
    const close = nearestTo("A4");
    const result = fitDesignToInventory(design, { A4: 6, [close]: 20 }, MARD_PALETTE, 100);
    expect(result.substitutions).toEqual([expect.objectContaining({ from: "A4", to: close, count: 4 })]);
    expect(result.design.colorCounts).toEqual({ A4: 6, [close]: 4 });
    expect(result.remaining).toEqual({});
  });

  it("does not swap in visibly different colors", () => {
    const result = fitDesignToInventory(design, { A4: 6, H7: 50 }, MARD_PALETTE);
    expect(result.substitutions).toEqual([]);
    expect(result.design).toBe(design);
    expect(result.remaining).toEqual({ A4: 4 });
  });
});

describe("smart advisor", () => {
  const palette = MARD_PALETTE.filter((color) => STANDARD.has(color.code));

  it("reads the color composition and recommends few colors for a flat two-color image", () => {
    const advice = adviseColors(image(60, 40, (x) => (x < 30 ? [250, 237, 86] : [0, 0, 0])), palette)!;
    expect(advice.composition.slice(0, 2).map((entry) => entry.code).sort()).toEqual(["A4", "H7"]);
    expect(advice.composition[0].share).toBeCloseTo(0.5, 1);
    expect(advice.recommended).toBe(8);
  });

  it("recommends a small board for flat shapes and a larger one for fine detail", () => {
    const flat = adviseSize(image(400, 400, (x, y) => (x < 200 && y < 200 ? [220, 40, 40] : [40, 90, 220])), 52)!;
    const detailed = adviseSize(image(400, 400, (x, y) => {
      const v = ((x >> 1) + (y >> 1)) % 2 === 0 ? 30 : 230;
      return [v, (x * 7) % 255, (y * 5) % 255];
    }), 52)!;
    expect(flat.longEdge).toBeLessThanOrEqual(40);
    expect(detailed.longEdge).toBeGreaterThan(flat.longEdge);
    expect(flat.boards).toEqual({ cols: 1, rows: 1, pins: 52 });
  });
});

describe("brush strokes", () => {
  it("drags across cells as one batch edit", () => {
    const context = { fillRect: vi.fn(), fillText: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn() };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => context as unknown as CanvasRenderingContext2D);
    const onCellsChange = vi.fn();
    const onCellChange = vi.fn();
    render(
      <DesignPreview
        design={{ id: "brush", fileName: "b.png", boardWidth: 2, boardHeight: 2, matrix: [["C7", "A4"], ["H7", null]], colorCounts: { C7: 1, A4: 1, H7: 1 } }}
        palette={MARD_PALETTE}
        showLabels
        onCellChange={onCellChange}
        onCellsChange={onCellsChange}
      />
    );
    const canvas = screen.getByLabelText("b.png 拼豆图纸") as HTMLCanvasElement;
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: canvas.width, bottom: canvas.height, width: canvas.width, height: canvas.height, toJSON: () => ({})
    });
    fireEvent.click(screen.getByRole("button", { name: "开始编辑图纸" }));
    fireEvent.change(screen.getByLabelText("绘制色号"), { target: { value: "B3" } });
    fireEvent.pointerDown(canvas, { clientX: 42, clientY: 42, button: 0, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 64, clientY: 42, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 64, clientY: 64, pointerId: 1 });
    fireEvent.pointerUp(canvas, { clientX: 64, clientY: 64, pointerId: 1 });
    fireEvent.click(canvas, { clientX: 64, clientY: 64 });
    expect(onCellsChange).toHaveBeenCalledTimes(1);
    expect(onCellsChange.mock.calls[0][0]).toEqual([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }]);
    expect(onCellsChange.mock.calls[0][1]).toBe("B3");
    expect(onCellChange).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
