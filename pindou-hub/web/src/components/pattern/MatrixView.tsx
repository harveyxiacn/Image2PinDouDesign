import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { renderDesignToCanvas } from "@engine/rendering";
import type { BeadDesign } from "@engine/types";
import { PALETTE } from "../../lib/palette";
import { Icon } from "../ui";
import "./pattern.css";

const MAX_PIXELS = 16_000_000;

/**
 * 拼豆图交互查看器：
 *  - 双指捏合缩放（围绕两指中点），单指 / 鼠标拖动平移（直接滚动容器）；按钮 −/+/适应宽度 作为替代。
 *  - 键盘：容器可聚焦，方向键滚动，+ / − 缩放。
 *  - focusCode 高亮某个色号（其余变淡）。
 */
export default function MatrixView({ matrix, width, height, focusCode, labels = true }: {
  matrix: Array<Array<string | null>>; width: number; height: number; focusCode?: string | null; labels?: boolean;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [cell, setCell] = useState(0);
  const [showLabels, setShowLabels] = useState(labels);
  // 缩放后要保持不动的“锚点”：内容坐标（以格为单位）对应容器内的像素位置
  const anchor = useRef<{ cx: number; cy: number; px: number; py: number } | null>(null);

  const maxCell = Math.max(6, Math.min(48, Math.floor(Math.sqrt(MAX_PIXELS / Math.max(1, width * height)))));
  const design = useMemo<BeadDesign>(() => ({ id: "view", fileName: "", boardWidth: width, boardHeight: height, matrix, colorCounts: {} }), [matrix, width, height]);

  useEffect(() => {
    const w = wrap.current?.clientWidth ?? 360;
    setCell(Math.max(4, Math.min(maxCell, Math.min(28, Math.floor((w - 2) / Math.max(1, width))))) || 8);
  }, [width, maxCell]);

  useLayoutEffect(() => {
    if (!canvas.current || !cell) return;
    renderDesignToCanvas(canvas.current, design, PALETTE, { cellSize: cell, showLabels, boardLineEvery: 10, focusCode: focusCode ?? null });
    const a = anchor.current, el = wrap.current;
    if (a && el) { el.scrollLeft = a.cx * cell - a.px; el.scrollTop = a.cy * cell - a.py; anchor.current = null; }
  }, [design, cell, showLabels, focusCode]);

  const clampCell = (n: number) => Math.max(3, Math.min(maxCell, Math.round(n)));
  /** 以容器内 (px,py) 为中心缩放到 next */
  const zoomTo = (next: number, px?: number, py?: number) => {
    const el = wrap.current;
    setCell((c) => {
      const n = clampCell(next);
      if (n === c || !el) return n;
      const x = px ?? el.clientWidth / 2, y = py ?? el.clientHeight / 2;
      anchor.current = { cx: (el.scrollLeft + x) / c, cy: (el.scrollTop + y) / c, px: x, py: y };
      return n;
    });
  };
  const zoom = (f: number) => setCell((c) => {
    let next = Math.round(c * f);
    if (next === c) next = c + (f > 1 ? 1 : -1);
    const n = clampCell(next);
    const el = wrap.current;
    if (el && n !== c) anchor.current = { cx: (el.scrollLeft + el.clientWidth / 2) / c, cy: (el.scrollTop + el.clientHeight / 2) / c, px: el.clientWidth / 2, py: el.clientHeight / 2 };
    return n;
  });
  const fit = () => { anchor.current = null; setCell(clampCell(Math.floor(((wrap.current?.clientWidth ?? 360) - 2) / Math.max(1, width)))); };

  // ---- 指针手势：1 指平移（滚动），2 指捏合 ----
  const ptrs = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ d: number; cell: number } | null>(null);
  const pan = useRef<{ x: number; y: number; sl: number; st: number } | null>(null);
  const raf = useRef(0);
  const cellRef = useRef(cell);
  cellRef.current = cell;

  const onDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button, input, label")) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const el = wrap.current!;
    if (ptrs.current.size === 2) {
      const [a, b] = [...ptrs.current.values()];
      gesture.current = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, cell: cellRef.current };
      pan.current = null;
    } else if (ptrs.current.size === 1) pan.current = { x: e.clientX, y: e.clientY, sl: el.scrollLeft, st: el.scrollTop };
  };
  const onMove = (e: React.PointerEvent) => {
    if (!ptrs.current.has(e.pointerId)) return;
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const el = wrap.current!;
    if (ptrs.current.size >= 2 && gesture.current) {
      const [a, b] = [...ptrs.current.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const r = el.getBoundingClientRect();
      const mx = (a.x + b.x) / 2 - r.left, my = (a.y + b.y) / 2 - r.top;
      const g = gesture.current;
      cancelAnimationFrame(raf.current);
      raf.current = requestAnimationFrame(() => zoomTo(g.cell * (d / g.d), mx, my));
    } else if (pan.current) {
      el.scrollLeft = pan.current.sl - (e.clientX - pan.current.x);
      el.scrollTop = pan.current.st - (e.clientY - pan.current.y);
    }
  };
  const onUp = (e: React.PointerEvent) => {
    ptrs.current.delete(e.pointerId);
    gesture.current = null;
    const rest = [...ptrs.current.values()][0];
    pan.current = rest ? { x: rest.x, y: rest.y, sl: wrap.current!.scrollLeft, st: wrap.current!.scrollTop } : null;
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "+" || e.key === "=") { e.preventDefault(); zoom(1.25); }
    else if (e.key === "-") { e.preventDefault(); zoom(0.8); }
  };

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
      <div className="pt-matrix-scroll" ref={wrap} tabIndex={0} role="group" aria-label="拼豆图，可双指捏合缩放、拖动平移；键盘方向键滚动，+ − 缩放"
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onKeyDown={onKey}>
        <canvas ref={canvas} />
      </div>
      {focusCode ? <p className="meta" style={{ marginTop: 6 }}><Icon name="search" size={12} /> 正在高亮 {focusCode}</p> : null}
    </div>
  );
}
