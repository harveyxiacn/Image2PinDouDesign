// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { getHighResolutionCellSize, renderDesignToCanvas } from "../domain/rendering";
import { MARD_PALETTE } from "../domain/palette";
import type { BeadDesign } from "../domain/types";

afterEach(() => vi.restoreAllMocks());

describe("complete pattern export", () => {
  it("budgets the entire 208x208 sheet including every palette swatch", () => {
    const context = { fillRect: vi.fn(), fillText: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), drawImage: vi.fn() };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
    const design: BeadDesign = { id: "large", fileName: "large.png", boardWidth: 208, boardHeight: 208,
      matrix: Array.from({ length: 208 }, () => Array(208).fill(null)),
      colorCounts: Object.fromEntries(MARD_PALETTE.map((color) => [color.code, 1])) };
    const canvas = document.createElement("canvas");
    renderDesignToCanvas(canvas, design, MARD_PALETTE, { cellSize: getHighResolutionCellSize(design), showLabels: true, boardLineEvery: 52, sheet: true });
    expect(canvas.width * canvas.height).toBeLessThanOrEqual(24_000_000);
  });

  it("exports real counts, a legend, and four-side coordinates without covering codes with block labels", () => {
    const context = { fillRect: vi.fn(), fillText: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), drawImage: vi.fn() };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
    const design: BeadDesign = { id: "test", fileName: "角色.png", boardWidth: 57, boardHeight: 60,
      matrix: Array.from({ length: 60 }, () => Array(57).fill(null)), colorCounts: { H7: 1, A4: 1 } };
    design.matrix[0][0] = "H7"; design.matrix[59][56] = "A4";
    const canvas = document.createElement("canvas");
    renderDesignToCanvas(canvas, design, MARD_PALETTE, { cellSize: getHighResolutionCellSize(design), showLabels: true, boardLineEvery: 52, sheet: true });
    const labels = context.fillText.mock.calls.map((call) => call[0]);
    expect(labels).toContain("57 × 60 格  ·  MARD 2 色  ·  2 颗豆  ·  每板 52 针");
    expect(labels).toContain("H7 · 1 颗");
    expect(labels.filter((label) => label === "60")).toHaveLength(2);
    expect(labels).not.toContain("A1");
    expect(context.drawImage).toHaveBeenCalledOnce();
    expect(canvas.height).toBeGreaterThan(60 * 32);
    expect(canvas.width * canvas.height).toBeLessThan(24_000_000);
  });
});
