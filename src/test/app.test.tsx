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
});
