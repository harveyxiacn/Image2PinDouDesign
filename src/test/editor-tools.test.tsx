// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesignPreview } from "../components/DesignPreview";
import { UpdateBanner } from "../components/UpdateBanner";
import { announceUpdate, resetUpdateState } from "../domain/appUpdate";
import { physicalSizeCm } from "../domain/boards";
import { MARD_PALETTE } from "../domain/palette";
import { buildProjectFile, inventoryToCsv, parseInventoryCsv, parseProjectFile } from "../domain/projectFile";
import type { BeadDesign } from "../domain/types";
import {
  applyCellPatch,
  boardTiles,
  cellsWithCode,
  copyRect,
  fillRectPatch,
  floodFillRegion,
  getColorBuildProgress,
  normalizeRect,
  pastePatch
} from "../domain/workbench";

const VALID = new Set(MARD_PALETTE.map((color) => color.code));

const DESIGN: BeadDesign = {
  id: "tools",
  fileName: "tools.png",
  boardWidth: 4,
  boardHeight: 3,
  matrix: [
    ["A4", "A4", "H7", null],
    ["A4", "H7", "H7", null],
    ["C7", "A4", "A4", "A4"]
  ],
  colorCounts: { A4: 6, H7: 3, C7: 1 }
};

function mockCanvas() {
  const context = {
    fillRect: vi.fn(), fillText: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
    strokeRect: vi.fn(), arc: vi.fn(), fill: vi.fn(), arcTo: vi.fn(), closePath: vi.fn()
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => context as unknown as CanvasRenderingContext2D);
}

function stubBounds(canvas: HTMLCanvasElement) {
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
    x: 0, y: 0, left: 0, top: 0, right: canvas.width, bottom: canvas.height, width: canvas.width, height: canvas.height, toJSON: () => ({})
  });
}

// 4×3 图纸：cellSize 22、坐标尺 31px，第 (x, y) 格中心约在 31 + 22x + 11。
const at = (x: number, y: number) => ({ clientX: 42 + 22 * x, clientY: 42 + 22 * y });

afterEach(() => {
  vi.restoreAllMocks();
  resetUpdateState();
});

describe("editing primitives", () => {
  it("flood fills only the connected same-color region", () => {
    const cells = floodFillRegion(DESIGN, 0, 0);
    expect(cells.map(({ x, y }) => `${x},${y}`).sort()).toEqual(["0,0", "0,1", "1,0"]);
    expect(floodFillRegion(DESIGN, 3, 0).map(({ x, y }) => `${x},${y}`).sort()).toEqual(["3,0", "3,1"]);
    expect(floodFillRegion(DESIGN, 9, 9)).toEqual([]);
  });

  it("applies a mixed patch with correct counts and keeps the original untouched", () => {
    const next = applyCellPatch(DESIGN, [{ x: 3, y: 0, code: "B3" }, { x: 0, y: 2, code: null }, { x: 0, y: 0, code: "A4" }]);
    expect(next.matrix[0][3]).toBe("B3");
    expect(next.matrix[2][0]).toBeNull();
    expect(next.colorCounts).toEqual({ A4: 6, H7: 3, B3: 1 });
    expect(DESIGN.matrix[0][3]).toBeNull();
    expect(applyCellPatch(DESIGN, [{ x: 0, y: 0, code: "A4" }])).toBe(DESIGN);
  });

  it("copies a selection and pastes it transparently elsewhere", () => {
    const rect = normalizeRect({ x: 2, y: 1 }, { x: 1, y: 0 }, DESIGN);
    expect(rect).toEqual({ x: 1, y: 0, width: 2, height: 2 });
    const block = copyRect(DESIGN, rect);
    expect(block).toEqual([["A4", "H7"], ["H7", "H7"]]);
    expect(pastePatch([["A4", null]], 2, 2)).toEqual([{ x: 2, y: 2, code: "A4" }]);
    expect(fillRectPatch({ x: 0, y: 0, width: 2, height: 1 }, null)).toHaveLength(2);
    expect(cellsWithCode(DESIGN, "H7")).toHaveLength(3);
  });

  it("splits a design into boards and measures progress per board", () => {
    const tiles = boardTiles({ boardWidth: 60, boardHeight: 30 }, 29);
    expect(tiles.map((tile) => [tile.x, tile.y, tile.width, tile.height])).toEqual([
      [0, 0, 29, 29], [29, 0, 29, 29], [58, 0, 2, 29],
      [0, 29, 29, 1], [29, 29, 29, 1], [58, 29, 2, 1]
    ]);
    const done = new Set([0, 4 + 2]);
    expect(getColorBuildProgress(DESIGN, done, "A4", { x: 0, y: 0, width: 2, height: 2 })).toEqual({ total: 3, completed: 1, remaining: 2 });
    expect(getColorBuildProgress(DESIGN, done, null)).toEqual({ total: 10, completed: 2, remaining: 8 });
  });

  it("estimates the finished size in centimeters", () => {
    expect(physicalSizeCm(52, 29, 2.6)).toEqual({ width: 13.5, height: 7.5 });
    expect(physicalSizeCm(52, 52, 5)).toEqual({ width: 26, height: 26 });
  });
});

describe("design and inventory files", () => {
  it("round-trips designs and gives imported designs fresh ids", () => {
    const text = buildProjectFile([DESIGN]);
    const { designs, skipped } = parseProjectFile(text, VALID);
    expect(skipped).toBe(0);
    expect(designs[0].matrix).toEqual(DESIGN.matrix);
    expect(designs[0].colorCounts).toEqual(DESIGN.colorCounts);
    expect(designs[0].id).toMatch(/^draft-import-/);
  });

  it("rejects files that are not design files", () => {
    expect(() => parseProjectFile("{nope", VALID)).toThrow("无法解析");
    expect(() => parseProjectFile(JSON.stringify({ format: "other", designs: [] }), VALID)).toThrow("不是本站导出");
    expect(() => parseProjectFile(JSON.stringify({ format: "image2pindou-designs", version: 99, designs: [] }), VALID)).toThrow("更新的版本");
    const broken = parseProjectFile(JSON.stringify({ format: "image2pindou-designs", version: 1, designs: [{ boardWidth: 0 }] }), VALID);
    expect(broken).toEqual({ designs: [], skipped: 1 });
  });

  it("round-trips the inventory CSV and accepts hand-made sheets", () => {
    const csv = inventoryToCsv({ A4: 120, H7: 30, ZZ1: 3 }, MARD_PALETTE);
    expect(csv.startsWith("﻿色号,颜色,HEX,颗数")).toBe(true);
    expect(parseInventoryCsv(csv, VALID)).toEqual({ owned: { A4: 120, H7: 30 }, unknown: [] });
    const handmade = "code,count\r\na4，200\n\"H2\",\"黑白\",15\nXX9,4\n\n";
    expect(parseInventoryCsv(handmade, VALID)).toEqual({ owned: { A4: 200, H2: 15 }, unknown: ["XX9"] });
  });
});

describe("new version prompt", () => {
  it("appears only after an update is announced and applies it on click", async () => {
    const apply = vi.fn();
    render(<UpdateBanner />);
    expect(screen.queryByText(/新版本/)).not.toBeInTheDocument();
    act(() => announceUpdate(apply));
    fireEvent.click(screen.getByRole("button", { name: "刷新到新版本" }));
    await act(async () => {});
    expect(apply).toHaveBeenCalledTimes(1);
  });
});

describe("editor tools in the preview", () => {
  it("fills a connected region with the paint bucket in one step", () => {
    mockCanvas();
    const onCellsChange = vi.fn();
    render(<DesignPreview design={DESIGN} palette={MARD_PALETTE} showLabels onCellChange={vi.fn()} onCellsChange={onCellsChange} />);
    const canvas = screen.getByLabelText("tools.png 拼豆图纸") as HTMLCanvasElement;
    stubBounds(canvas);
    fireEvent.click(screen.getByRole("button", { name: "油漆桶" }));
    fireEvent.change(screen.getByLabelText("绘制色号"), { target: { value: "B3" } });
    fireEvent.click(canvas, at(0, 0));
    expect(onCellsChange).toHaveBeenCalledTimes(1);
    expect(onCellsChange.mock.calls[0][0]).toHaveLength(3);
    expect(onCellsChange.mock.calls[0][1]).toBe("B3");
  });

  it("replaces one color everywhere", () => {
    mockCanvas();
    const onCellsChange = vi.fn();
    render(<DesignPreview design={DESIGN} palette={MARD_PALETTE} showLabels onCellChange={vi.fn()} onCellsChange={onCellsChange} />);
    fireEvent.click(screen.getByRole("button", { name: "画笔" }));
    fireEvent.change(screen.getByLabelText("绘制色号"), { target: { value: "B3" } });
    fireEvent.change(screen.getByLabelText("要替换的色号"), { target: { value: "H7" } });
    fireEvent.click(screen.getByRole("button", { name: "全部换成 B3" }));
    expect(onCellsChange).toHaveBeenCalledWith([{ x: 2, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 1 }], "B3");
  });

  it("mirrors brush strokes when symmetry is on", () => {
    mockCanvas();
    const onCellsChange = vi.fn();
    render(<DesignPreview design={DESIGN} palette={MARD_PALETTE} showLabels onCellChange={vi.fn()} onCellsChange={onCellsChange} />);
    const canvas = screen.getByLabelText("tools.png 拼豆图纸") as HTMLCanvasElement;
    stubBounds(canvas);
    fireEvent.click(screen.getByRole("button", { name: "擦除" }));
    fireEvent.click(screen.getByLabelText("左右对称"));
    fireEvent.pointerDown(canvas, { ...at(0, 2), button: 0, pointerId: 1 });
    fireEvent.pointerUp(canvas, { ...at(0, 2), pointerId: 1 });
    expect(onCellsChange).toHaveBeenCalledWith([{ x: 0, y: 2 }, { x: 3, y: 2 }], null);
  });

  it("selects, copies and pastes a block as one patch", () => {
    mockCanvas();
    const onPatch = vi.fn();
    render(<DesignPreview design={DESIGN} palette={MARD_PALETTE} showLabels onCellChange={vi.fn()} onCellsChange={vi.fn()} onPatch={onPatch} />);
    const canvas = screen.getByLabelText("tools.png 拼豆图纸") as HTMLCanvasElement;
    stubBounds(canvas);
    fireEvent.click(screen.getByRole("button", { name: "框选" }));
    fireEvent.pointerDown(canvas, { ...at(1, 0), button: 0, pointerId: 1 });
    fireEvent.pointerMove(canvas, { ...at(2, 1), pointerId: 1 });
    fireEvent.pointerUp(canvas, { ...at(2, 1), pointerId: 1 });
    // 浏览器在抬笔后紧跟一次 click，框选时应被忽略。
    fireEvent.click(canvas, at(2, 1));
    expect(screen.getByText(/已选 2 × 2 格/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "复制" }));
    fireEvent.click(screen.getByRole("button", { name: "粘贴" }));
    fireEvent.click(canvas, at(2, 1));
    expect(onPatch).toHaveBeenCalledWith([
      { x: 2, y: 1, code: "A4" }, { x: 3, y: 1, code: "H7" },
      { x: 2, y: 2, code: "H7" }, { x: 3, y: 2, code: "H7" }
    ]);
  });

  it("navigates boards in build mode and marks cells by dragging", () => {
    mockCanvas();
    const wide: BeadDesign = {
      id: "wide", fileName: "wide.png", boardWidth: 4, boardHeight: 1,
      matrix: [["A4", "A4", "A4", "H7"]], colorCounts: { A4: 3, H7: 1 },
      settings: { boardWidth: 4, boardHeight: 1, maxColors: "all", keepTransparent: true, transparentThreshold: 10, dither: false, boardTilePins: 2 }
    };
    render(<DesignPreview design={wide} palette={MARD_PALETTE} showLabels onCellChange={vi.fn()} />);
    const canvas = screen.getByLabelText("wide.png 拼豆图纸") as HTMLCanvasElement;
    stubBounds(canvas);
    fireEvent.click(screen.getByRole("button", { name: "制作打卡" }));
    const boardSelect = screen.getByLabelText("当前制作的板");
    expect(boardSelect.querySelectorAll("option")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "下一块" }));
    expect(screen.getByText("A4 本板剩余 2 颗")).toBeInTheDocument();
    fireEvent.pointerDown(canvas, { ...at(0, 0), button: 0, pointerId: 1 });
    fireEvent.pointerMove(canvas, { ...at(1, 0), pointerId: 1 });
    fireEvent.pointerUp(canvas, { ...at(1, 0), pointerId: 1 });
    expect(screen.getByText("A4 本板剩余 0 颗")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "下一块" }));
    expect(screen.getByText("A4 本板剩余 1 颗")).toBeInTheDocument();
  });

  it("offers a bead look preview", () => {
    mockCanvas();
    render(<DesignPreview design={DESIGN} palette={MARD_PALETTE} showLabels />);
    fireEvent.click(screen.getByRole("button", { name: "成品效果" }));
    expect(screen.getByRole("img", { name: /成品效果预览（熨烫后）/ })).toBeInTheDocument();
    expect(screen.getByText(/约 1 × 0.8 cm/)).toBeInTheDocument();
  });
});
