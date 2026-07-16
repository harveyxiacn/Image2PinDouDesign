// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import App from "../App";
import { DesignPreview } from "../components/DesignPreview";
import { MARD_PALETTE } from "../domain/palette";

describe("App", () => {
  it("renders the core upload, board, and export sections", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: /拼豆图纸工坊/ })).toBeInTheDocument();
    expect(screen.getByLabelText(/选择图片文件/)).toBeInTheDocument();
    expect(screen.getByLabelText(/板型/)).toHaveDisplayValue("智能尺寸（最多 52 针）");
    expect(screen.getByLabelText(/细节算法/)).toHaveDisplayValue("智能细节（推荐）");
    expect(screen.getByText(/项目总用豆/)).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "手机端快捷导航" })).toBeInTheDocument();
  });
});

describe("mobile pattern preview", () => {
  it("offers a legible zoom mode and an immediate high-resolution download", () => {
    const context = {
      fillRect: vi.fn(),
      fillText: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn()
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => context as unknown as CanvasRenderingContext2D);
    const onDownload = vi.fn();

    render(
      <DesignPreview
        design={{
          id: "mobile-preview",
          fileName: "agumon.png",
          boardWidth: 2,
          boardHeight: 2,
          matrix: [["C7", "A4"], ["H7", null]],
          colorCounts: { C7: 1, A4: 1, H7: 1 }
        }}
        palette={MARD_PALETTE}
        showLabels
        onDownload={onDownload}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "放大图纸" }));
    expect(screen.getByRole("button", { name: "100%" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "下载高清色号图" }));
    expect(onDownload).toHaveBeenCalledOnce();
    vi.restoreAllMocks();
  });

  it("supports single-cell editing, mirroring, and locally persisted build progress", () => {
    window.localStorage.clear();
    const context = {
      fillRect: vi.fn(),
      fillText: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn()
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => context as unknown as CanvasRenderingContext2D);
    const onCellChange = vi.fn();
    const onMirror = vi.fn();
    const onSaveDraft = vi.fn();

    render(
      <DesignPreview
        design={{
          id: "editable-preview",
          fileName: "agumon.png",
          boardWidth: 2,
          boardHeight: 2,
          matrix: [["C7", "A4"], ["H7", null]],
          colorCounts: { C7: 1, A4: 1, H7: 1 }
        }}
        palette={MARD_PALETTE}
        showLabels
        onCellChange={onCellChange}
        onMirror={onMirror}
        onSaveDraft={onSaveDraft}
      />
    );

    const canvas = screen.getByLabelText("agumon.png 拼豆图纸") as HTMLCanvasElement;
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: canvas.width,
      bottom: canvas.height,
      width: canvas.width,
      height: canvas.height,
      toJSON: () => ({})
    });

    fireEvent.click(screen.getByRole("button", { name: "开始编辑图纸" }));
    fireEvent.change(screen.getByLabelText("绘制色号"), { target: { value: "A4" } });
    fireEvent.click(canvas, { clientX: 42, clientY: 42 });
    expect(onCellChange).toHaveBeenCalledWith(0, 0, "A4");

    fireEvent.click(screen.getByRole("button", { name: "水平镜像" }));
    expect(onMirror).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "保存本机草稿" }));
    expect(onSaveDraft).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "已保存到本机 ✓" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "制作打卡" }));
    expect(screen.getByText("C7 剩余 1 颗")).toBeInTheDocument();
    fireEvent.click(canvas, { clientX: 42, clientY: 42 });
    expect(screen.getByText("C7 剩余 0 颗")).toBeInTheDocument();
    expect(window.localStorage.length).toBe(1);
    vi.restoreAllMocks();
  });
});

describe("local pattern drafts", () => {
  it("restores a saved draft without an upload and removes it from local storage", () => {
    window.localStorage.clear();
    window.localStorage.setItem("image2pindou:design-drafts:v1", JSON.stringify([{
      id: "draft-agumon",
      fileName: "亚古兽-本机草稿",
      boardWidth: 2,
      boardHeight: 2,
      matrix: [["A4", "H7"], ["NOT-A-CODE", null]],
      colorCounts: { A4: 999 }
    }]));
    const context = {
      fillRect: vi.fn(),
      fillText: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn()
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => context as unknown as CanvasRenderingContext2D);

    render(<App />);

    expect(screen.getByRole("button", { name: "亚古兽-本机草稿" })).toBeInTheDocument();
    expect(screen.getByText("2 x 2")).toBeInTheDocument();
    expect(screen.getAllByText("A4").length).toBeGreaterThan(0);
    expect(screen.queryByText("NOT-A-CODE")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "图纸预览与编辑" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "编辑图纸" })).toHaveAttribute("href", "#pattern-editor");
    expect(screen.getByRole("link", { name: "编辑" })).toHaveAttribute("href", "#pattern-editor");

    fireEvent.click(screen.getByRole("button", { name: "移除 亚古兽-本机草稿" }));
    expect(screen.queryByRole("button", { name: "亚古兽-本机草稿" })).not.toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem("image2pindou:design-drafts:v1") ?? "[]")).toEqual([]);
    vi.restoreAllMocks();
  });
});
