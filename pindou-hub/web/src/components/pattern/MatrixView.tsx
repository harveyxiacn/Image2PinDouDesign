import { useEffect, useMemo, useRef, useState } from "react";
import { renderDesignToCanvas } from "@engine/rendering";
import type { BeadDesign } from "@engine/types";
import { PALETTE } from "../../lib/palette";
import { Icon } from "../ui";
import "./pattern.css";

const MAX_PIXELS = 16_000_000;

/** 拼豆图交互查看器：缩放（按钮）+ 容器滚动即平移（触屏拖动），focusCode 高亮某个色号。 */
export default function MatrixView({ matrix, width, height, focusCode, labels = true }: {
  matrix: Array<Array<string | null>>; width: number; height: number; focusCode?: string | null; labels?: boolean;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [cell, setCell] = useState(0);
  const [showLabels, setShowLabels] = useState(labels);

  const maxCell = Math.max(6, Math.min(48, Math.floor(Math.sqrt(MAX_PIXELS / Math.max(1, width * height)))));
  const design = useMemo<BeadDesign>(() => ({ id: "view", fileName: "", boardWidth: width, boardHeight: height, matrix, colorCounts: {} }), [matrix, width, height]);

  // 初始缩放：撑满容器宽度
  useEffect(() => {
    const w = wrap.current?.clientWidth ?? 360;
    setCell(Math.max(4, Math.min(maxCell, Math.min(28, Math.floor((w - 2) / Math.max(1, width))))) || 8);
  }, [width, maxCell]);

  useEffect(() => {
    if (!canvas.current || !cell) return;
    renderDesignToCanvas(canvas.current, design, PALETTE, { cellSize: cell, showLabels, boardLineEvery: 10, focusCode: focusCode ?? null });
  }, [design, cell, showLabels, focusCode]);

  const zoom = (f: number) => setCell((c) => {
    let next = Math.round(c * f);
    if (next === c) next = c + (f > 1 ? 1 : -1);
    return Math.max(3, Math.min(maxCell, next));
  });
  const fit = () => setCell(Math.max(3, Math.min(maxCell, Math.floor(((wrap.current?.clientWidth ?? 360) - 2) / Math.max(1, width)))));

  return (
    <div className="pt-matrix">
      <div className="pt-matrix-tools">
        <button className="btn btn-sm" onClick={() => zoom(0.8)} aria-label="缩小">−</button>
        <button className="btn btn-sm" onClick={() => zoom(1.25)} aria-label="放大">+</button>
        <button className="btn btn-sm btn-ghost" onClick={fit}>适应宽度</button>
        <label className="pt-check" style={{ minHeight: 0, marginLeft: "auto" }}>
          <input type="checkbox" checked={showLabels} onChange={(e) => setShowLabels(e.target.checked)} />色号
        </label>
        <span className="meta num">{width}×{height}</span>
      </div>
      <div className="pt-matrix-scroll" ref={wrap}>
        <canvas ref={canvas} />
      </div>
      {focusCode ? <p className="meta" style={{ marginTop: 6 }}><Icon name="search" size={12} /> 正在高亮 {focusCode}</p> : null}
    </div>
  );
}
