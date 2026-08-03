// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CropDialog } from "../components/CropDialog";
import type { PixelSource } from "../domain/types";

function source(width: number, height: number): PixelSource {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    data.set([128, 128, 128, 255], index * 4);
  }
  return { width, height, data };
}

describe("CropDialog focus control", () => {
  it("supports pointer and keyboard focal-point adjustment and submits it", () => {
    const onSubmit = vi.fn();
    render(
      <CropDialog
        previewUrl="data:image/png;base64,AA=="
        source={source(200, 100)}
        title="测试图片"
        fitMode="cover"
        targetAspect={1}
        busy={false}
        progress={null}
        onCancel={vi.fn()}
        onSubmit={onSubmit}
      />
    );

    expect(screen.getByRole("button", { name: "设置焦点" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(/已使用自动焦点/)).toBeInTheDocument();
    const frame = screen.getByRole("group", { name: /图片焦点区域/ });
    vi.spyOn(frame, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 200, bottom: 100,
      width: 200, height: 100, toJSON: () => ({})
    });

    fireEvent.pointerDown(frame, { clientX: 50, clientY: 25 });
    fireEvent.keyDown(frame, { key: "ArrowRight" });
    expect(screen.getByText(/已设置手动焦点/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "添加为新图纸" }));
    expect(onSubmit).toHaveBeenCalledOnce();
    const [, removeBg, focus] = onSubmit.mock.calls[0];
    expect(removeBg).toBe(true);
    expect(focus.x).toBeGreaterThan(50);
    expect(focus.y).toBeCloseTo(24.75, 1);
  });
});
