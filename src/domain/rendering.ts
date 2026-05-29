import type { BeadDesign, PaletteColor } from "./types";

export type RenderOptions = {
  cellSize: number;
  showLabels: boolean;
  boardLineEvery: number;
  // 绘制行列坐标尺与分块编号，便于多块拼接对位。默认关闭。
  showCoordinates?: boolean;
};

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
  context.font = `${Math.max(7, Math.floor(options.cellSize * 0.36))}px ui-monospace, monospace`;

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

        if (options.showLabels && options.cellSize >= 13) {
          context.fillStyle = readableTextColor(color?.hex ?? "#d4d4d8");
          context.fillText(code, left + options.cellSize / 2, top + options.cellSize / 2);
        }
      } else {
        context.fillStyle = "#ffffff";
        context.fillRect(left, top, options.cellSize, options.cellSize);
        context.fillStyle = "#e2e8f0";
        context.fillRect(left + 2, top + 2, options.cellSize - 4, options.cellSize - 4);
      }
    }
  }

  drawGrid(context, design, options, gutter);
  if (options.showCoordinates) {
    drawCoordinates(context, design, options, gutter);
  }
}

export function renderDesignToDataUrl(design: BeadDesign, palette: PaletteColor[], options: RenderOptions): string {
  const canvas = document.createElement("canvas");
  renderDesignToCanvas(canvas, design, palette, options);
  return canvas.toDataURL("image/png");
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

// 坐标尺：每 5 格标一个序号（含末格），并在每个 boardLineEvery 分块的左上角标块号，便于多块拼接。
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

  const blocksX = Math.ceil(design.boardWidth / options.boardLineEvery);
  const blocksY = Math.ceil(design.boardHeight / options.boardLineEvery);
  if (blocksX * blocksY <= 1) {
    return;
  }

  context.fillStyle = "rgba(37, 99, 235, 0.85)";
  context.font = `700 ${Math.max(10, Math.floor(options.cellSize * 0.9))}px ui-sans-serif, system-ui, sans-serif`;
  context.textAlign = "left";
  context.textBaseline = "top";
  for (let by = 0; by < blocksY; by += 1) {
    for (let bx = 0; bx < blocksX; bx += 1) {
      const left = gutter + bx * options.boardLineEvery * options.cellSize + 3;
      const top = gutter + by * options.boardLineEvery * options.cellSize + 3;
      context.fillText(`${String.fromCharCode(65 + by)}${bx + 1}`, left, top);
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
