import type { BeadDesign, PaletteColor } from "./types";
import {
  compareColorCodes, computeSheetLayout, gridLineKind, gridLineStyle, isEmphasisedIndex, labelFontSize,
  lineStart, sheetPixels, shouldDrawLabels
} from "./sheetLayout";

export type RenderOptions = {
  cellSize: number;
  showLabels: boolean;
  boardLineEvery: number;
  // 绘制行列坐标尺，便于多块拼接对位。默认关闭。
  showCoordinates?: boolean;
  // 制作模式：淡化非当前色号，并在已完成格上画勾；仅用于交互预览。
  focusCode?: string | null;
  completedCells?: ReadonlySet<number>;
  // 按板制作：淡化当前板以外的格子，并给当前板描边。
  region?: { x: number; y: number; width: number; height: number } | null;
  sheet?: boolean;
  guideLineEvery?: number;
  // "none"：只画色块与色号，不画格线（长图自己按黑线规则画）。
  gridStyle?: "none";
};

const PREFERRED_EXPORT_CELL_SIZE = 32;
const MIN_EXPORT_CELL_SIZE = 20;
const MAX_EXPORT_PIXELS = 24_000_000;

const GUTTER_RATIO = 1.4;
const MIN_GUTTER = 16;

function gutterFor(options: RenderOptions): number {
  return options.showCoordinates ? Math.max(MIN_GUTTER, Math.round(options.cellSize * GUTTER_RATIO)) : 0;
}

export function renderDesignToCanvas(
  canvas: HTMLCanvasElement,
  design: BeadDesign,
  palette: PaletteColor[],
  options: RenderOptions
): void {
  if (options.sheet) {
    renderPatternSheetToCanvas(canvas, design, palette, options);
    return;
  }
  options = { ...options, boardLineEvery: safeLineEvery(options.boardLineEvery) };
  const gutter = gutterFor(options);
  const gridWidth = design.boardWidth * options.cellSize;
  const gridHeight = design.boardHeight * options.cellSize;
  canvas.width = gridWidth + gutter;
  canvas.height = gridHeight + gutter;

  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas rendering is not available");
  }

  context.fillStyle = "#f8fafc";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.textAlign = "center";
  context.textBaseline = "middle";
  const fontFor = (length: number) => `700 ${labelFontSize(options.cellSize, length)}px ui-monospace, Menlo, Consolas, monospace`;
  const labelFont = fontFor(2);
  context.font = labelFont;
  let currentFont = labelFont;

  const byCode = new Map(palette.map((color) => [color.code, color]));

  for (let y = 0; y < design.boardHeight; y += 1) {
    for (let x = 0; x < design.boardWidth; x += 1) {
      const code = design.matrix[y]?.[x] ?? null;
      const left = gutter + x * options.cellSize;
      const top = gutter + y * options.cellSize;

      if (code) {
        const color = byCode.get(code);
        context.fillStyle = color?.hex ?? "#d4d4d8";
        context.fillRect(left, top, options.cellSize, options.cellSize);

        if (options.showLabels && shouldDrawLabels(options.cellSize)) {
          const wanted = fontFor(code.length);
          if (wanted !== currentFont) { context.font = wanted; currentFont = wanted; }
          context.fillStyle = readableTextColor(color?.hex ?? "#d4d4d8");
          context.fillText(code, left + options.cellSize / 2, top + options.cellSize / 2);
        }
      } else {
        context.fillStyle = "#ffffff";
        context.fillRect(left, top, options.cellSize, options.cellSize);
        context.fillStyle = "#e2e8f0";
        context.fillRect(left + 2, top + 2, options.cellSize - 4, options.cellSize - 4);
      }

      if (options.focusCode && code !== options.focusCode) {
        context.fillStyle = "rgba(255, 255, 255, 0.82)";
        context.fillRect(left, top, options.cellSize, options.cellSize);
      }

      const region = options.region;
      if (region && (x < region.x || y < region.y || x >= region.x + region.width || y >= region.y + region.height)) {
        context.fillStyle = "rgba(241, 245, 249, 0.86)";
        context.fillRect(left, top, options.cellSize, options.cellSize);
      }

      const cellIndex = y * design.boardWidth + x;
      if (code && options.completedCells?.has(cellIndex)) {
        context.fillStyle = "rgba(255, 255, 255, 0.72)";
        context.fillRect(left, top, options.cellSize, options.cellSize);
        context.fillStyle = "#166534";
        context.font = `900 ${Math.max(10, Math.floor(options.cellSize * 0.7))}px ui-sans-serif, system-ui, sans-serif`;
        context.fillText("✓", left + options.cellSize / 2, top + options.cellSize / 2);
        context.font = currentFont;
      }
    }
  }

  if (options.gridStyle !== "none") drawGrid(context, design, options, gutter);
  if (options.region) {
    const { x, y, width, height } = options.region;
    context.lineWidth = 3;
    context.strokeStyle = "#e76f51";
    context.strokeRect(gutter + x * options.cellSize + 1.5, gutter + y * options.cellSize + 1.5,
      width * options.cellSize - 3, height * options.cellSize - 3);
  }
  if (options.showCoordinates) {
    drawCoordinates(context, design, options, gutter);
  }
}

export function renderDesignToDataUrl(design: BeadDesign, palette: PaletteColor[], options: RenderOptions): string {
  const canvas = document.createElement("canvas");
  renderDesignToCanvas(canvas, design, palette, options);
  return canvas.toDataURL("image/png");
}

export function renderDesignToBlob(
  design: BeadDesign,
  palette: PaletteColor[],
  options: RenderOptions
): Promise<Blob> {
  const canvas = document.createElement("canvas");
  renderDesignToCanvas(canvas, design, palette, options);

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("无法生成 PNG 文件，请缩小图纸后重试。"));
      }
    }, "image/png");
  });
}

// 手机浏览器对超大 Canvas 的内存较敏感：小图优先使用 32px/格保证色号清楚，
// 大图则按总像素预算自适应，但不低于 20px/格。
export function getHighResolutionCellSize(design: Pick<BeadDesign, "boardWidth" | "boardHeight"> & Partial<Pick<BeadDesign, "colorCounts">>): number {
  // 标题、四边坐标和完整用色清单（含合计行）一起计入预算；没有计数时按 512 色保守估算。
  const colorCount = design.colorCounts ? Object.values(design.colorCounts).filter((count) => count > 0).length : 512;
  for (let cell = PREFERRED_EXPORT_CELL_SIZE; cell >= MIN_EXPORT_CELL_SIZE; cell--) {
    if (sheetPixels({ boardWidth: design.boardWidth, boardHeight: design.boardHeight, cell, colorCount }) <= MAX_EXPORT_PIXELS) return cell;
  }
  return MIN_EXPORT_CELL_SIZE;
}

function drawGrid(
  context: CanvasRenderingContext2D,
  design: BeadDesign,
  options: RenderOptions,
  gutter: number
): void {
  const gridWidth = design.boardWidth * options.cellSize;
  const gridHeight = design.boardHeight * options.cellSize;

  context.lineWidth = 1;
  context.strokeStyle = "rgba(15, 23, 42, 0.18)";

  for (let x = 0; x <= design.boardWidth; x += 1) {
    const position = gutter + x * options.cellSize + 0.5;
    context.beginPath();
    context.moveTo(position, gutter);
    context.lineTo(position, gutter + gridHeight);
    context.stroke();
  }

  for (let y = 0; y <= design.boardHeight; y += 1) {
    const position = gutter + y * options.cellSize + 0.5;
    context.beginPath();
    context.moveTo(gutter, position);
    context.lineTo(gutter + gridWidth, position);
    context.stroke();
  }

  context.lineWidth = 2;
  if (options.guideLineEvery && options.guideLineEvery > 0) {
    context.strokeStyle = "rgba(61, 90, 128, 0.36)";
    for (let x = options.guideLineEvery; x < design.boardWidth; x += options.guideLineEvery) {
      const position = gutter + x * options.cellSize + 0.5;
      context.beginPath(); context.moveTo(position, gutter); context.lineTo(position, gutter + gridHeight); context.stroke();
    }
    for (let y = options.guideLineEvery; y < design.boardHeight; y += options.guideLineEvery) {
      const position = gutter + y * options.cellSize + 0.5;
      context.beginPath(); context.moveTo(gutter, position); context.lineTo(gutter + gridWidth, position); context.stroke();
    }
  }
  context.strokeStyle = "rgba(15, 23, 42, 0.58)";
  for (let x = options.boardLineEvery; x < design.boardWidth; x += options.boardLineEvery) {
    const position = gutter + x * options.cellSize + 0.5;
    context.beginPath();
    context.moveTo(position, gutter);
    context.lineTo(position, gutter + gridHeight);
    context.stroke();
  }
  for (let y = options.boardLineEvery; y < design.boardHeight; y += options.boardLineEvery) {
    const position = gutter + y * options.cellSize + 0.5;
    context.beginPath();
    context.moveTo(gutter, position);
    context.lineTo(gutter + gridWidth, position);
    context.stroke();
  }
}

// 预览坐标尺：每 5 格标一个序号（含末格），不在格内叠加块号。
function drawCoordinates(
  context: CanvasRenderingContext2D,
  design: BeadDesign,
  options: RenderOptions,
  gutter: number
): void {
  const tickEvery = 5;
  context.fillStyle = "#475569";
  context.font = `${Math.max(8, Math.floor(gutter * 0.5))}px ui-monospace, monospace`;
  context.textAlign = "center";
  context.textBaseline = "middle";

  const shouldTick = (index: number, total: number) =>
    index === 1 || index === total || index % tickEvery === 0;

  for (let x = 1; x <= design.boardWidth; x += 1) {
    if (!shouldTick(x, design.boardWidth)) {
      continue;
    }
    const center = gutter + (x - 1) * options.cellSize + options.cellSize / 2;
    context.fillText(String(x), center, gutter / 2);
  }

  for (let y = 1; y <= design.boardHeight; y += 1) {
    if (!shouldTick(y, design.boardHeight)) {
      continue;
    }
    const center = gutter + (y - 1) * options.cellSize + options.cellSize / 2;
    context.fillText(String(y), gutter / 2, center);
  }

}

function safeLineEvery(value: number): number {
  return Number.isFinite(value) && value >= 1 ? Math.round(value) : 52;
}

export function renderPatternSheetToCanvas(canvas: HTMLCanvasElement, design: BeadDesign,
  palette: PaletteColor[], options: RenderOptions): void {
  const cell = options.cellSize;
  const used = palette.filter((color) => (design.colorCounts[color.code] ?? 0) > 0)
    .sort((a, b) => compareColorCodes(a.code, b.code));
  const maxCount = used.reduce((max, color) => Math.max(max, design.colorCounts[color.code] ?? 0), 0);
  const layout = computeSheetLayout({
    boardWidth: design.boardWidth, boardHeight: design.boardHeight, cell,
    colorCount: used.length, maxCountDigits: Math.max(3, String(maxCount).length)
  });
  const { margin, ruler, gridLeft: left, gridTop: top, gridWidth, gridHeight, width, header } = layout;
  canvas.width = width;
  canvas.height = layout.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas rendering is not available");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#172033";
  context.textAlign = "left";
  context.textBaseline = "middle";
  context.font = `700 ${layout.titleFont}px sans-serif`;
  context.fillText(design.fileName.replace(/\.[^.]+$/, ""), margin, header * 0.32, width - margin * 2);
  const total = Object.values(design.colorCounts).reduce((sum, count) => sum + count, 0);
  context.font = `${layout.subtitleFont}px sans-serif`;
  const pins = safeLineEvery(options.boardLineEvery);
  context.fillText(`${design.boardWidth} × ${design.boardHeight} 格  ·  ${used.length} 种颜色  ·  共 ${total} 颗豆  ·  每板 ${pins} 针`,
    margin, header * 0.74, width - margin * 2);
  const chart = document.createElement("canvas");
  renderDesignToCanvas(chart, design, palette, {
    ...options, sheet: false, showCoordinates: false, showLabels: true,
    guideLineEvery: undefined, focusCode: undefined, completedCells: undefined, gridStyle: "none"
  });
  context.drawImage(chart, left, top);
  // 四边逐格坐标；每 5 格加粗强调。块号不覆盖格内色号。
  context.fillStyle = "#edf3f8";
  context.fillRect(left, top - ruler, gridWidth, ruler);
  context.fillRect(left, top + gridHeight, gridWidth, ruler);
  context.fillRect(left - ruler, top, ruler, gridHeight);
  context.fillRect(left + gridWidth, top, ruler, gridHeight);
  drawSheetGrid(context, design, cell, left, top, pins);
  context.fillStyle = "#1f3a56";
  context.textAlign = "center";
  context.textBaseline = "middle";
  const numberFont = (index: number) => `${isEmphasisedIndex(index) ? "700 " : ""}${layout.rulerFont}px monospace`;
  for (let x = 1; x <= design.boardWidth; x++) {
    const center = left + (x - 0.5) * cell;
    context.font = numberFont(x);
    context.fillText(String(x), center, top - ruler / 2);
    context.fillText(String(x), center, top + gridHeight + ruler / 2);
  }
  for (let y = 1; y <= design.boardHeight; y++) {
    const center = top + (y - 0.5) * cell;
    context.font = numberFont(y);
    context.fillText(String(y), left - ruler / 2, center);
    context.fillText(String(y), left + gridWidth + ruler / 2, center);
  }
  // 图例：色块 + 色号 × 颗数，按色号排序，按列数折行，最后一行合计。
  const legend = layout.legend;
  context.textAlign = "left";
  context.fillStyle = "#172033";
  context.font = `700 ${legend.titleFont}px sans-serif`;
  context.fillText("用色清单（按色号排序，空格不计豆）", margin, legend.top + legend.titleFont, width - margin * 2);
  used.forEach((color, index) => {
    const x = margin + (index % legend.columns) * legend.entryWidth;
    const y = legend.entriesTop + Math.floor(index / legend.columns) * legend.entryHeight;
    const swatchTop = Math.round(y + (legend.entryHeight - legend.swatch) / 2);
    context.fillStyle = color.hex;
    context.fillRect(x, swatchTop, legend.swatch, legend.swatch);
    context.fillStyle = "#172033";
    context.fillRect(x, swatchTop, legend.swatch, 1);
    context.fillRect(x, swatchTop + legend.swatch - 1, legend.swatch, 1);
    context.fillRect(x, swatchTop, 1, legend.swatch);
    context.fillRect(x + legend.swatch - 1, swatchTop, 1, legend.swatch);
    context.fillStyle = "#172033";
    context.font = `700 ${legend.font}px ui-monospace, Menlo, Consolas, monospace`;
    context.fillText(`${color.code} × ${design.colorCounts[color.code]}`, x + legend.swatch + legend.font * 0.6,
      y + legend.entryHeight / 2, legend.entryWidth - legend.swatch - legend.font * 1.2);
  });
  context.fillStyle = "#172033";
  context.font = `700 ${Math.round(legend.font * 1.1)}px sans-serif`;
  context.fillText(`合计：${used.length} 种颜色，${total} 颗豆`, margin, legend.totalTop + legend.font, width - margin * 2);
}

// 长图网格：细浅格线 → 每 5 格黑线 → 每 10 格粗黑线 → 分板边界与外框最粗；全部整像素对齐。
function drawSheetGrid(context: CanvasRenderingContext2D, design: BeadDesign, cell: number,
  left: number, top: number, boardEvery: number): void {
  const gridWidth = design.boardWidth * cell;
  const gridHeight = design.boardHeight * cell;
  const kinds = ["thin", "five", "ten", "board", "frame"] as const;
  for (const kind of kinds) {
    const style = gridLineStyle(kind, cell);
    context.fillStyle = style.color;
    for (let x = 0; x <= design.boardWidth; x++) {
      if (gridLineKind(x, design.boardWidth, boardEvery) !== kind) continue;
      const start = lineStart(left + x * cell, style.width);
      context.fillRect(start, lineStart(top, style.width), style.width, gridHeight + style.width);
    }
    for (let y = 0; y <= design.boardHeight; y++) {
      if (gridLineKind(y, design.boardHeight, boardEvery) !== kind) continue;
      const start = lineStart(top + y * cell, style.width);
      context.fillRect(lineStart(left, style.width), start, gridWidth + style.width, style.width);
    }
  }
}

function readableTextColor(hex: string): string {
  const normalized = hex.replace("#", "");
  const r = Number.parseInt(normalized.slice(0, 2), 16);
  const g = Number.parseInt(normalized.slice(2, 4), 16);
  const b = Number.parseInt(normalized.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.56 ? "#111827" : "#ffffff";
}
