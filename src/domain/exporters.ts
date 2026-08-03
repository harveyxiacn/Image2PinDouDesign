import { countMatrixColors } from "./conversion";
import { renderDesignToDataUrl } from "./rendering";
import type { BeadDesign, PaletteColor } from "./types";

export function countsToCsv(counts: Record<string, number>, palette: PaletteColor[]): string {
  const byCode = new Map(palette.map((color) => [color.code, color]));
  const rows = Object.entries(counts)
    .sort(([leftCode, leftCount], [rightCode, rightCount]) => {
      if (rightCount !== leftCount) {
        return rightCount - leftCount;
      }
      return leftCode.localeCompare(rightCode);
    })
    .map(([code, count]) => {
      const color = byCode.get(code);
      return [
        csvCell(code),
        csvCell(color?.nameZh ?? code),
        csvCell(color?.hex ?? ""),
        String(count)
      ].join(",");
    });

  return ["色号,颜色名称,HEX,数量", ...rows].join("\n");
}

export function downloadTextFile(fileName: string, text: string, mimeType = "text/csv;charset=utf-8"): void {
  const blob = new Blob([`\uFEFF${text}`], { type: mimeType });
  const url = URL.createObjectURL(blob);
  triggerDownload(fileName, url);
  URL.revokeObjectURL(url);
}

export function downloadDataUrl(fileName: string, dataUrl: string): void {
  triggerDownload(fileName, dataUrl);
}

export function downloadBlob(fileName: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  triggerDownload(fileName, url);
  // Safari 需要下载动作开始后再释放 Object URL，立即释放可能得到空文件。
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function triggerDownload(fileName: string, url: string): void {
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
}

function csvCell(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replaceAll("\"", "\"\"")}"`;
  }
  return value;
}

// 分板页：导出按物理板尺寸切成的一页（一板一页）。
export type BoardPage = {
  design: BeadDesign;
  // 第几板（1 起）
  pageIndex: number;
  // 共几板
  totalPages: number;
  // 本板在整图里的全局坐标范围（1 起、含端点）
  xStart: number;
  xEnd: number;
  yStart: number;
  yEnd: number;
};

// 把整幅图纸按所选板型切成多页，每页对应一块物理板。
// 边缘板可能不满一板，按实际边界截断；boardWidth/boardHeight 缺省或非法时回退 52。
export function tileDesignForBoards(
  design: BeadDesign,
  boardWidth?: number,
  boardHeight?: number
): BoardPage[] {
  const tileWidth = sanitizeTileDimension(boardWidth, 52);
  const tileHeight = sanitizeTileDimension(boardHeight, 52);
  const totalWidth = Math.max(1, design.boardWidth);
  const totalHeight = Math.max(1, design.boardHeight);
  const cols = Math.max(1, Math.ceil(totalWidth / tileWidth));
  const rows = Math.max(1, Math.ceil(totalHeight / tileHeight));
  const totalPages = cols * rows;
  const pages: BoardPage[] = [];

  let pageIndex = 0;
  for (let row = 0; row < rows; row += 1) {
    const yStart = row * tileHeight;
    const yEnd = Math.min(totalHeight, yStart + tileHeight);
    for (let col = 0; col < cols; col += 1) {
      const xStart = col * tileWidth;
      const xEnd = Math.min(totalWidth, xStart + tileWidth);
      const chunk: Array<Array<string | null>> = [];
      for (let y = yStart; y < yEnd; y += 1) {
        const rowCells: Array<string | null> = [];
        for (let x = xStart; x < xEnd; x += 1) {
          rowCells.push(design.matrix[y]?.[x] ?? null);
        }
        chunk.push(rowCells);
      }

      pageIndex += 1;
      pages.push({
        design: {
          id: `${design.id}-p${pageIndex}`,
          fileName: design.fileName,
          boardWidth: xEnd - xStart,
          boardHeight: yEnd - yStart,
          matrix: chunk,
          colorCounts: countMatrixColors(chunk),
          settings: design.settings
        },
        pageIndex,
        totalPages,
        xStart: xStart + 1,
        xEnd,
        yStart: yStart + 1,
        yEnd
      });
    }
  }

  return pages;
}

// 打印/PDF 导出的分页参数：传入 boardWidth/boardHeight 后按板分页，缺省保持单页。
export type PrintableSheetOptions = {
  boardWidth?: number;
  boardHeight?: number;
  // 分块分隔线间隔（每块 52 针时传 52），缺省取板宽。
  boardLineEvery?: number;
};

// 可打印图纸：开一个独立窗口，内含带坐标/分块编号的高清网格图 + 色号图例表，
// 用户通过浏览器「打印 → 另存为 PDF」即可。无需引入 PDF 依赖，且图例文字可选中、缩放清晰。
// 传入板型尺寸时按"每页一板"分页，页眉标注第几板/共几板与全局坐标范围；不传则保持单页整图。
export function openPrintableSheet(
  design: BeadDesign,
  palette: PaletteColor[],
  options: PrintableSheetOptions = {}
): boolean {
  const win = window.open("", "_blank");
  if (!win) {
    return false;
  }

  const pages = options.boardWidth || options.boardHeight
    ? tileDesignForBoards(design, options.boardWidth, options.boardHeight)
    : null;

  const title = `${escapeHtml(stripExtension(design.fileName))} · ${design.boardWidth}×${design.boardHeight} 拼豆图纸`;
  const byCode = new Map(palette.map((color) => [color.code, color]));
  const total = Object.values(design.colorCounts).reduce((sum, count) => sum + count, 0);
  const legendRows = Object.entries(design.colorCounts)
    .sort(([leftCode, leftCount], [rightCode, rightCount]) =>
      rightCount !== leftCount ? rightCount - leftCount : leftCode.localeCompare(rightCode))
    .map(([code, count]) => {
      const color = byCode.get(code);
      return `<tr>
        <td><span class="sw" style="background:${escapeHtml(color?.hex ?? "#ddd")}"></span>${escapeHtml(color?.nameZh ?? code)}</td>
        <td>${escapeHtml(code)}</td>
        <td class="mono">${escapeHtml(color?.hex ?? "-")}</td>
        <td class="num">${count}</td>
      </tr>`;
    })
    .join("");

  const chartMarkup = pages
    ? pages.map((page) => {
      const chart = renderDesignToDataUrl(page.design, palette, {
        cellSize: 18,
        showLabels: true,
        boardLineEvery: options.boardLineEvery ?? sanitizeTileDimension(options.boardWidth, 52),
        showCoordinates: true
      });
      return `<div class="page">
  <h2>第 ${page.pageIndex} / ${page.totalPages} 板 · 坐标 X ${page.xStart}–${page.xEnd} Y ${page.yStart}–${page.yEnd}</h2>
  <img class="chart" src="${chart}" alt="第 ${page.pageIndex} 板图纸" />
</div>`;
    }).join("")
    : (() => {
      const chart = renderDesignToDataUrl(design, palette, {
        cellSize: 18,
        showLabels: true,
        boardLineEvery: 52,
        showCoordinates: true
      });
      return `<div class="page">
  <img class="chart" src="${chart}" alt="拼豆图纸" />
</div>`;
    })();

  win.document.write(`<!doctype html><html lang="zh"><head><meta charset="utf-8" />
<title>${title}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: ui-sans-serif, system-ui, "Microsoft YaHei", sans-serif; color: #0f172a; margin: 24px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  h2 { font-size: 14px; margin: 18px 0 8px; }
  .meta { color: #64748b; font-size: 12px; margin-bottom: 16px; }
  .chart { width: 100%; max-width: 760px; image-rendering: pixelated; border: 1px solid #e2e8f0; }
  table { border-collapse: collapse; width: 100%; margin-top: 18px; font-size: 12px; }
  th, td { border: 1px solid #e2e8f0; padding: 5px 8px; text-align: left; }
  th { background: #f1f5f9; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .mono { font-family: ui-monospace, monospace; }
  .sw { display: inline-block; width: 12px; height: 12px; border-radius: 3px; margin-right: 6px; vertical-align: -1px; border: 1px solid rgba(0,0,0,.12); }
  .page { page-break-after: always; break-after: page; }
  .page:last-child { page-break-after: auto; break-after: auto; }
  @media print { body { margin: 0; } .chart { border: none; } }
</style></head>
<body>
  <h1>${title}</h1>
  <div class="meta">MARD 色卡 · 共 ${total} 颗豆 · ${Object.keys(design.colorCounts).length} 种颜色${pages ? ` · ${pages.length} 板` : ""}</div>
  ${chartMarkup}
  <table>
    <thead><tr><th>颜色</th><th>色号</th><th>HEX</th><th class="num">数量</th></tr></thead>
    <tbody>${legendRows}</tbody>
  </table>
  <script>window.addEventListener("load", function () { setTimeout(function () { window.print(); }, 150); });<\/script>
</body></html>`);
  win.document.close();
  return true;
}

function sanitizeTileDimension(value: number | undefined, fallback: number): number {
  if (!value || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

function stripExtension(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}
