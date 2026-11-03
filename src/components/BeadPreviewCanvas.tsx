import { useEffect, useRef } from "react";
import type { BeadDesign, PaletteColor } from "../domain/types";

type BeadPreviewCanvasProps = {
  design: Pick<BeadDesign, "boardWidth" | "boardHeight" | "matrix" | "fileName">;
  palette: PaletteColor[];
  // fused：熨烫后豆子略微压扁相连；loose：未熨烫的圆豆，中心有孔。
  look: "loose" | "fused";
  className?: string;
};

const CELL = 14;

/** 成品效果预览：把每格画成一颗豆子，帮助判断实物观感（屏幕颜色仅供参考）。 */
export function BeadPreviewCanvas({ design, palette, look, className }: BeadPreviewCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = design.boardWidth * CELL;
    canvas.height = design.boardHeight * CELL;
    const context = canvas.getContext("2d");
    if (!context) return;
    const byCode = new Map(palette.map((color) => [color.code, color.hex]));
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    const radius = look === "fused" ? CELL * 0.56 : CELL * 0.44;
    const hole = look === "fused" ? CELL * 0.12 : CELL * 0.17;
    for (let y = 0; y < design.boardHeight; y += 1) {
      for (let x = 0; x < design.boardWidth; x += 1) {
        const code = design.matrix[y]?.[x];
        if (!code) continue;
        const cx = x * CELL + CELL / 2;
        const cy = y * CELL + CELL / 2;
        context.fillStyle = byCode.get(code) ?? "#d4d4d8";
        if (look === "fused") {
          // 熨烫后相邻豆子挤压成圆角方块。
          roundRect(context, cx - radius, cy - radius, radius * 2, radius * 2, CELL * 0.22);
        } else {
          context.beginPath();
          context.arc(cx, cy, radius, 0, Math.PI * 2);
          context.fill();
        }
        context.fillStyle = "rgba(255, 255, 255, 0.92)";
        context.beginPath();
        context.arc(cx, cy, hole, 0, Math.PI * 2);
        context.fill();
        // 一点高光，让豆子有塑料光泽。
        context.fillStyle = "rgba(255, 255, 255, 0.22)";
        context.beginPath();
        context.arc(cx - radius * 0.35, cy - radius * 0.4, radius * 0.28, 0, Math.PI * 2);
        context.fill();
      }
    }
  }, [design, look, palette]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      role="img"
      aria-label={`${design.fileName} 成品效果预览（${look === "fused" ? "熨烫后" : "未熨烫"}）`}
    />
  );
}

function roundRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, r: number) {
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
  context.fill();
}
