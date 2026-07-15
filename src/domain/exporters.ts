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

// 可打印图纸：开一个独立窗口，内含带坐标/分块编号的高清网格图 + 色号图例表，
// 用户通过浏览器「打印 → 另存为 PDF」即可。无需引入 PDF 依赖，且图例文字可选中、缩放清晰。
export function openPrintableSheet(design: BeadDesign, palette: PaletteColor[]): boolean {
  const win = window.open("", "_blank");
  if (!win) {
    return false;
  }

  const chart = renderDesignToDataUrl(design, palette, {
    cellSize: 18,
    showLabels: true,
    boardLineEvery: 52,
    showCoordinates: true
  });

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

  const title = `${escapeHtml(stripExtension(design.fileName))} · ${design.boardWidth}×${design.boardHeight} 拼豆图纸`;
  win.document.write(`<!doctype html><html lang="zh"><head><meta charset="utf-8" />
<title>${title}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: ui-sans-serif, system-ui, "Microsoft YaHei", sans-serif; color: #0f172a; margin: 24px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .meta { color: #64748b; font-size: 12px; margin-bottom: 16px; }
  .chart { width: 100%; max-width: 760px; image-rendering: pixelated; border: 1px solid #e2e8f0; }
  table { border-collapse: collapse; width: 100%; margin-top: 18px; font-size: 12px; }
  th, td { border: 1px solid #e2e8f0; padding: 5px 8px; text-align: left; }
  th { background: #f1f5f9; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .mono { font-family: ui-monospace, monospace; }
  .sw { display: inline-block; width: 12px; height: 12px; border-radius: 3px; margin-right: 6px; vertical-align: -1px; border: 1px solid rgba(0,0,0,.12); }
  @media print { body { margin: 0; } .chart { border: none; } }
</style></head>
<body>
  <h1>${title}</h1>
  <div class="meta">MARD 色卡 · 共 ${total} 颗豆 · ${Object.keys(design.colorCounts).length} 种颜色</div>
  <img class="chart" src="${chart}" alt="拼豆图纸" />
  <table>
    <thead><tr><th>颜色</th><th>色号</th><th>HEX</th><th class="num">数量</th></tr></thead>
    <tbody>${legendRows}</tbody>
  </table>
  <script>window.addEventListener("load", function () { setTimeout(function () { window.print(); }, 150); });<\/script>
</body></html>`);
  win.document.close();
  return true;
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
