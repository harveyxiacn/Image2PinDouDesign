// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "../App";

describe("App", () => {
  it("renders the core upload, board, and export sections", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: /拼豆图纸工坊/ })).toBeInTheDocument();
    expect(screen.getByLabelText(/选择图片文件/)).toBeInTheDocument();
    expect(screen.getByLabelText(/板型/)).toHaveDisplayValue("52 针");
    expect(screen.getByText(/项目总用豆/)).toBeInTheDocument();
  });
});
