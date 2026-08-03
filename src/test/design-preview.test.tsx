// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DesignPreview } from "../components/DesignPreview";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { MARD_PALETTE } from "../domain/palette";

const CONTEXT = {
  fillRect: vi.fn(),
  fillText: vi.fn(),
  beginPath: vi.fn(),
  moveTo: vi.fn(),
  lineTo: vi.fn(),
  stroke: vi.fn()
};

const DESIGN = {
  id: "keyboard-preview",
  fileName: "agumon.png",
  boardWidth: 3,
  boardHeight: 2,
  matrix: [["C7", "A4", "H7"], ["H7", null, "A4"]],
  colorCounts: { C7: 1, A4: 2, H7: 2 }
};

function mockCanvas(): void {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockImplementation(() => CONTEXT as unknown as CanvasRenderingContext2D);
}

describe("DesignPreview 键盘网格", () => {
  it("把画布网格暴露为 role=grid，并带 aria-rowcount/aria-colcount", () => {
    mockCanvas();
    render(<DesignPreview design={DESIGN} palette={MARD_PALETTE} showLabels />);

    const grid = screen.getByRole("grid");
    expect(grid).toHaveAttribute("aria-rowcount", "2");
    expect(grid).toHaveAttribute("aria-colcount", "3");
    vi.restoreAllMocks();
  });

  it("方向键移动光标，Enter 用当前选中色上色，并显示光标高亮", () => {
    mockCanvas();
    const onCellChange = vi.fn();
    render(<DesignPreview design={DESIGN} palette={MARD_PALETTE} showLabels onCellChange={onCellChange} />);

    fireEvent.click(screen.getByRole("button", { name: "开始编辑图纸" }));
    fireEvent.change(screen.getByLabelText("绘制色号"), { target: { value: "A4" } });

    const grid = screen.getByRole("grid");
    fireEvent.focus(grid);
    fireEvent.keyDown(grid, { key: "ArrowRight" });
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    fireEvent.keyDown(grid, { key: "Enter" });

    expect(onCellChange).toHaveBeenCalledWith(1, 1, "A4");
    expect(document.querySelector(".grid-cursor")).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  it("空格也能上色，Delete/Backspace 擦除当前格", () => {
    mockCanvas();
    const onCellChange = vi.fn();
    render(<DesignPreview design={DESIGN} palette={MARD_PALETTE} showLabels onCellChange={onCellChange} />);

    fireEvent.click(screen.getByRole("button", { name: "开始编辑图纸" }));
    fireEvent.change(screen.getByLabelText("绘制色号"), { target: { value: "H7" } });

    const grid = screen.getByRole("grid");
    fireEvent.focus(grid);
    fireEvent.keyDown(grid, { key: " " });
    expect(onCellChange).toHaveBeenCalledWith(0, 0, "H7");

    onCellChange.mockClear();
    fireEvent.keyDown(grid, { key: "Delete" });
    expect(onCellChange).toHaveBeenCalledWith(0, 0, null);

    onCellChange.mockClear();
    fireEvent.keyDown(grid, { key: "Backspace" });
    expect(onCellChange).toHaveBeenCalledWith(0, 0, null);
    vi.restoreAllMocks();
  });

  it("查看模式下键盘不会改动格子", () => {
    mockCanvas();
    const onCellChange = vi.fn();
    render(<DesignPreview design={DESIGN} palette={MARD_PALETTE} showLabels onCellChange={onCellChange} />);

    const grid = screen.getByRole("grid");
    fireEvent.focus(grid);
    fireEvent.keyDown(grid, { key: "ArrowRight" });
    fireEvent.keyDown(grid, { key: "Enter" });
    fireEvent.keyDown(grid, { key: "Delete" });

    expect(onCellChange).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("模式按钮与编辑开关带 aria-pressed", () => {
    mockCanvas();
    render(<DesignPreview design={DESIGN} palette={MARD_PALETTE} showLabels onCellChange={vi.fn()} />);

    expect(screen.getByRole("button", { name: "开始编辑图纸" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "查看成品" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "开始编辑图纸" }));
    expect(screen.getByRole("button", { name: "完成编辑" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "逐格改色" })).toHaveAttribute("aria-pressed", "true");
    vi.restoreAllMocks();
  });
});

describe("ErrorBoundary 渲染兜底", () => {
  it("子组件抛错时显示中文可恢复提示而不是白屏", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const Boom = () => {
      throw new Error("测试渲染错误");
    };
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    );

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("出了点问题")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
    expect(screen.getByText(/测试渲染错误/)).toBeInTheDocument();
    consoleSpy.mockRestore();
  });

  it("点击重试后恢复渲染子组件", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let shouldThrow = true;
    const Flaky = () => {
      if (shouldThrow) {
        throw new Error("boom");
      }
      return <div>恢复成功</div>;
    };
    render(
      <ErrorBoundary>
        <Flaky />
      </ErrorBoundary>
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();

    shouldThrow = false;
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(screen.getByText("恢复成功")).toBeInTheDocument();
    consoleSpy.mockRestore();
  });
});
