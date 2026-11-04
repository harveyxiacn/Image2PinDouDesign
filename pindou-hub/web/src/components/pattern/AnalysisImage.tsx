import { useEffect, useRef, useState } from "react";
import type { GridDetection, Rect } from "../../lib/recognize/types";
import "./pattern.css";

/** 显示上传的图：可拖动框选区域（指针事件，触屏可用），并把检测到的网格线叠在图上。坐标均为 PixelSource 像素。 */
export default function AnalysisImage({ url, srcW, srcH, region, onRegion, selecting, grid, matrix, focusCode }: {
  url: string; srcW: number; srcH: number; region: Rect | null; onRegion: (r: Rect | null) => void; selecting: boolean; grid: GridDetection | null;
  /** 识别出的每格色号；与 focusCode 一起使用：该色的格子上色描边，其余变暗 */
  matrix?: Array<Array<string | null>> | null; focusCode?: string | null;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const over = useRef<HTMLCanvasElement>(null);
  const [drag, setDrag] = useState<{ x: number; y: number; x2: number; y2: number } | null>(null);

  const toSrc = (e: React.PointerEvent) => {
    const r = stage.current!.getBoundingClientRect();
    return { x: Math.max(0, Math.min(srcW, ((e.clientX - r.left) / r.width) * srcW)), y: Math.max(0, Math.min(srcH, ((e.clientY - r.top) / r.height) * srcH)) };
  };
  const rectOf = (d: { x: number; y: number; x2: number; y2: number }): Rect => ({
    x: Math.round(Math.min(d.x, d.x2)), y: Math.round(Math.min(d.y, d.y2)), width: Math.round(Math.abs(d.x2 - d.x)), height: Math.round(Math.abs(d.y2 - d.y))
  });

  useEffect(() => {
    const c = over.current;
    if (!c) return;
    c.width = srcW; c.height = srcH;
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, srcW, srcH);
    if (!grid) return;
    const focusing = !!focusCode && !!matrix;
    if (focusing) {
      const tint = getComputedStyle(document.documentElement).getPropertyValue("--iron").trim() || "#d6452a";
      const line = Math.max(2, srcW / 600);
      ctx.fillStyle = "rgba(255, 255, 255, 0.62)";
      for (let r = 0; r < grid.rows; r++) for (let c = 0; c < grid.cols; c++) {
        const code = matrix![r]?.[c];
        if (code !== focusCode) ctx.fillRect(grid.x0 + c * grid.pitchX, grid.y0 + r * grid.pitchY, grid.pitchX, grid.pitchY);
      }
      ctx.strokeStyle = tint; ctx.lineWidth = line;
      ctx.globalAlpha = 0.28; ctx.fillStyle = tint;
      for (let r = 0; r < grid.rows; r++) for (let c = 0; c < grid.cols; c++) {
        if (matrix![r]?.[c] !== focusCode) continue;
        ctx.fillRect(grid.x0 + c * grid.pitchX, grid.y0 + r * grid.pitchY, grid.pitchX, grid.pitchY);
      }
      ctx.globalAlpha = 1;
      for (let r = 0; r < grid.rows; r++) for (let c = 0; c < grid.cols; c++) {
        if (matrix![r]?.[c] !== focusCode) continue;
        ctx.strokeRect(grid.x0 + c * grid.pitchX + line / 2, grid.y0 + r * grid.pitchY + line / 2, grid.pitchX - line, grid.pitchY - line);
      }
      return;
    }
    ctx.strokeStyle = "rgba(214, 69, 42, 0.8)";
    ctx.lineWidth = Math.max(1, srcW / 900);
    ctx.beginPath();
    for (let i = 0; i <= grid.cols; i++) { const x = grid.x0 + i * grid.pitchX; ctx.moveTo(x, grid.y0); ctx.lineTo(x, grid.y0 + grid.rows * grid.pitchY); }
    for (let j = 0; j <= grid.rows; j++) { const y = grid.y0 + j * grid.pitchY; ctx.moveTo(grid.x0, y); ctx.lineTo(grid.x0 + grid.cols * grid.pitchX, y); }
    ctx.stroke();
  }, [grid, srcW, srcH, matrix, focusCode]);

  const shown = drag ? rectOf(drag) : region;
  return (
    <div
      ref={stage}
      className="pt-stage"
      data-select={selecting}
      onPointerDown={selecting ? (e) => { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); const p = toSrc(e); setDrag({ x: p.x, y: p.y, x2: p.x, y2: p.y }); } : undefined}
      onPointerMove={selecting && drag ? (e) => { const p = toSrc(e); setDrag({ ...drag, x2: p.x, y2: p.y }); } : undefined}
      onPointerUp={selecting && drag ? () => { const r = rectOf(drag); setDrag(null); onRegion(r.width > srcW * 0.05 && r.height > srcH * 0.05 ? r : null); } : undefined}
      onPointerCancel={() => setDrag(null)}
    >
      <img src={url} alt="上传的图纸" draggable={false} />
      <canvas ref={over} className="pt-over" />
      {shown ? <div className="pt-region" style={{ left: `${(shown.x / srcW) * 100}%`, top: `${(shown.y / srcH) * 100}%`, width: `${(shown.width / srcW) * 100}%`, height: `${(shown.height / srcH) * 100}%` }} /> : null}
    </div>
  );
}
