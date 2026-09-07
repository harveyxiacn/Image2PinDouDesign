// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import type { BeadDesign } from "../domain/types";
import type { ConversionRequest, ConversionResponse } from "../worker/conversion.worker";

vi.mock("../domain/image", () => ({
  imageFileToPixelSource: async () => ({ width: 10, height: 12, data: new Uint8ClampedArray(480).fill(255) }),
  pixelSourceToDataUrl: () => "data:image/png;base64,test"
}));
vi.mock("../components/PalettePanel", () => ({ PalettePanel: () => null }));
vi.mock("../components/DesignPreview", () => ({
  DesignPreview: ({ design, onCellChange }: { design?: BeadDesign; onCellChange?: (x: number, y: number, code: string) => void }) => (
    <div>
      <output data-testid="preview-cell">{design?.matrix[0][0]}</output>
      <button onClick={() => onCellChange?.(0, 0, "A4")}>测试编辑一格</button>
    </div>
  )
}));

class TestWorker {
  static current: TestWorker;
  requests: ConversionRequest[] = [];
  listeners = new Set<(event: MessageEvent<ConversionResponse>) => void>();
  constructor() { TestWorker.current = this; }
  addEventListener(_type: string, listener: (event: MessageEvent<ConversionResponse>) => void) { this.listeners.add(listener); }
  removeEventListener(_type: string, listener: (event: MessageEvent<ConversionResponse>) => void) { this.listeners.delete(listener); }
  terminate() {}
  postMessage(request: ConversionRequest) { if (!("type" in request)) this.requests.push(request); }
  complete(request: ConversionRequest) {
    const design: BeadDesign = { id: request.id, fileName: request.fileName, boardWidth: 2, boardHeight: 2,
      matrix: [["H7", null], [null, "H7"]], colorCounts: { H7: 2 }, settings: request.settings };
    for (const listener of this.listeners) listener({ data: { id: request.id, generation: request.generation, design } } as MessageEvent<ConversionResponse>);
  }
}

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal("Worker", TestWorker);
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:test"), revokeObjectURL: vi.fn() }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("independent image conversions", () => {
  it("keeps edits and settings on the first image when a second is resized or removed", async () => {
    render(<App />);
    fireEvent.change(screen.getByLabelText("选择图片文件"), { target: { files: [
      new File(["a"], "one.png", { type: "image/png" }), new File(["b"], "two.png", { type: "image/png" })
    ] } });
    await waitFor(() => expect(TestWorker.current.requests).toHaveLength(2));
    const worker = TestWorker.current;
    act(() => { worker.complete(worker.requests[0]); worker.complete(worker.requests[1]); });
    fireEvent.click(screen.getByRole("button", { name: "测试编辑一格" }));
    expect(screen.getByTestId("preview-cell")).toHaveTextContent("A4");
    fireEvent.click(screen.getByRole("button", { name: "two.png" }));
    fireEvent.change(screen.getByLabelText("板型"), { target: { value: "104" } });
    await waitFor(() => expect(worker.requests).toHaveLength(3));
    expect(worker.requests[2].fileName).toBe("two.png");
    expect(worker.requests[2].settings.boardWidth).toBe(104);
    act(() => worker.complete(worker.requests[2]));
    fireEvent.click(screen.getByRole("button", { name: "one.png" }));
    expect(screen.getByLabelText("板型")).toHaveValue("smart");
    expect(screen.getByTestId("preview-cell")).toHaveTextContent("A4");
    fireEvent.click(screen.getByRole("button", { name: "移除 two.png" }));
    expect(screen.getByTestId("preview-cell")).toHaveTextContent("A4");
    // 切换和删除不重算未变化的图，用户的手工改色不被生成结果替换。
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 180)); });
    expect(worker.requests).toHaveLength(3);
  });

  it("ignores a cancelled result even when it arrives after the cancel button", async () => {
    render(<App />);
    fireEvent.change(screen.getByLabelText("选择图片文件"), { target: { files: [new File(["a"], "one.png", { type: "image/png" })] } });
    await waitFor(() => expect(TestWorker.current.requests).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    act(() => TestWorker.current.complete(TestWorker.current.requests[0]));
    expect(screen.queryByRole("button", { name: "one.png" })).not.toBeInTheDocument();
    expect(screen.getByTestId("preview-cell")).toBeEmptyDOMElement();
  });
});
