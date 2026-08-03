import { describe, expect, it } from "vitest";
import { preparePalette } from "../domain/conversion";
import { countsToCsv, csvCell, tileDesignForBoards } from "../domain/exporters";
import type { BeadDesign } from "../domain/types";

describe("csvCell", () => {
  it("leaves plain values untouched", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell("A1")).toBe("A1");
  });

  it("quotes values containing commas (RFC4180 style)", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell("红色,标准")).toBe('"红色,标准"');
  });

  it("doubles embedded double quotes", () => {
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
  });

  it("quotes values containing newlines", () => {
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
    expect(csvCell("line1\r\nline2")).toBe('"line1\r\nline2"');
  });
});

describe("countsToCsv", () => {
  it("escapes color names containing commas, quotes, and newlines", () => {
    const palette = preparePalette([
      { code: "A1", nameZh: "红,色", hex: "#ff0000" },
      { code: "B1", nameZh: '引号"色', hex: "#00ff00" },
      { code: "C1", nameZh: "换行\n色", hex: "#0000ff" }
    ]);

    const csv = countsToCsv({ A1: 1, B1: 2, C1: 3 }, palette);
    expect(csv).toBe([
      "色号,颜色名称,HEX,数量",
      'C1,"换行\n色",#0000ff,3',
      'B1,"引号""色",#00ff00,2',
      'A1,"红,色",#ff0000,1'
    ].join("\n"));
  });
});

function makeDesign(boardWidth: number, boardHeight: number): BeadDesign {
  const matrix = Array.from({ length: boardHeight }, () =>
    Array.from({ length: boardWidth }, () => "A1" as const));
  return {
    id: "tile",
    fileName: "tile.png",
    boardWidth,
    boardHeight,
    matrix,
    colorCounts: { A1: boardWidth * boardHeight }
  };
}

describe("tileDesignForBoards", () => {
  it("tiles a 104x52 design by 52-pin boards into 2 pages", () => {
    const pages = tileDesignForBoards(makeDesign(104, 52), 52, 52);

    expect(pages).toHaveLength(2);
    expect(pages[0]).toMatchObject({ pageIndex: 1, totalPages: 2, xStart: 1, xEnd: 52, yStart: 1, yEnd: 52 });
    expect(pages[1]).toMatchObject({ pageIndex: 2, totalPages: 2, xStart: 53, xEnd: 104, yStart: 1, yEnd: 52 });
    expect(pages[0].design.boardWidth).toBe(52);
    expect(pages[1].design.boardWidth).toBe(52);
    expect(pages[0].design.matrix[0]).toHaveLength(52);
  });

  it("tiles a 100x80 design by 50-pin boards with a partial bottom row", () => {
    const pages = tileDesignForBoards(makeDesign(100, 80), 50, 50);

    expect(pages).toHaveLength(4); // 2 列 x 2 行
    expect(pages[0]).toMatchObject({ pageIndex: 1, xStart: 1, xEnd: 50, yStart: 1, yEnd: 50 });
    expect(pages[1]).toMatchObject({ pageIndex: 2, xStart: 51, xEnd: 100, yStart: 1, yEnd: 50 });
    expect(pages[2]).toMatchObject({ pageIndex: 3, xStart: 1, xEnd: 50, yStart: 51, yEnd: 80 });
    expect(pages[3]).toMatchObject({ pageIndex: 4, xStart: 51, xEnd: 100, yStart: 51, yEnd: 80 });
    expect(pages[2].design.boardHeight).toBe(30); // 边缘板不满一板，按实际边界截断
    expect(pages[3].design.boardHeight).toBe(30);
  });

  it("tiles a 60x29 design by 29-pin boards into 3 columns", () => {
    const pages = tileDesignForBoards(makeDesign(60, 29), 29, 29);

    expect(pages).toHaveLength(3); // ceil(60/29)=3 列
    expect(pages[0]).toMatchObject({ pageIndex: 1, xStart: 1, xEnd: 29, yStart: 1, yEnd: 29 });
    expect(pages[1]).toMatchObject({ pageIndex: 2, xStart: 30, xEnd: 58, yStart: 1, yEnd: 29 });
    expect(pages[2]).toMatchObject({ pageIndex: 3, xStart: 59, xEnd: 60, yStart: 1, yEnd: 29 });
    expect(pages[2].design.boardWidth).toBe(2);
    expect(pages[2].design.matrix).toHaveLength(29);
  });

  it("keeps every page inside the design bounds", () => {
    const design = makeDesign(103, 81);
    const pages = tileDesignForBoards(design, 29, 29);

    expect(pages).toHaveLength(12); // 4 列 x 3 行
    for (const page of pages) {
      expect(page.design.matrix).toHaveLength(page.design.boardHeight);
      for (const row of page.design.matrix) {
        expect(row).toHaveLength(page.design.boardWidth);
      }
      expect(page.xEnd).toBeLessThanOrEqual(design.boardWidth);
      expect(page.yEnd).toBeLessThanOrEqual(design.boardHeight);
      expect(page.xStart).toBeGreaterThanOrEqual(1);
      expect(page.yStart).toBeGreaterThanOrEqual(1);
      expect(page.design.colorCounts).toEqual({ A1: page.design.boardWidth * page.design.boardHeight });
    }
  });
});
