import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { renderDesignToCanvas } from "@engine/rendering";
import type { BeadDesign } from "@engine/types";
import { PALETTE, colorOf } from "../../lib/palette";
import { brushCells, matrixCellAtPoint, strokeCells, type BrushSize, type MatrixCell } from "../../lib/matrixEdit";
import { Icon } from "../ui";
import "./pattern.css";

const MAX_PIXELS = 16_000_000;

export type MatrixTool = "pan" | "brush" | "eraser" | "pick";

/**
 * 拼豆图交互查看器 / 编辑器：
 *  - pan：双指捏合缩放，单指 / 鼠标拖动平移（直接滚动容器）；按钮 −/+/适应宽度 作为替代。
 *  - brush / eraser：单指拖动连续改色 / 清空，抬笔时整笔一次提交；双指仍可缩放。
 *  - pick：点格子取色，不修改矩阵。
 *  - focusCode 高亮某个色号（其余变淡）；编辑时由调用方传 null，避免整图变淡。
 */
export default function MatrixView({
  matrix, width, height, focusCode, labels = true,
  tool = "pan", brushCode = null, brushSize = 1, onCellsChange, onPickCode
}: {
  matrix: Array<Array<string | null>>; width: number; height: number; focusCode?: string | null; labels?: boolean;
  tool?: MatrixTool;
  brushCode?: string | null;
  brushSize?: BrushSize;
  /** 一笔结束（抬笔 / 第二根手指按下）时提交，cells 已去重且已做直线补格。 */
  onCellsChange?: (cells: MatrixCell[], code: string | null) => void;
  onPickCode?: (code: string | null) => void;
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

  /** 重画整张图；拖动预览是直接画在位图上的，取消一笔时要靠它恢复。 */
  const draw = () => {
    const cv = canvas.current;
    const size = cellRef.current;
    if (!cv || !size) return;
    renderDesignToCanvas(cv, design, PALETTE, { cellSize: size, showLabels, boardLineEvery: 10, focusCode: focusCode ?? null });
  };

  useLayoutEffect(() => {
    if (!canvas.current || !cell) return;
    draw();
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

  // ---- 指针手势：1 指平移（滚动），2 指捏合；编辑工具下 1 指改格 ----
  const ptrs = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ d: number; cell: number } | null>(null);
  const pan = useRef<{ x: number; y: number; sl: number; st: number } | null>(null);
  const raf = useRef(0);
  const cellRef = useRef(cell);
  cellRef.current = cell;
  const stroke = useRef<{ pointerId: number; code: string | null; cells: Map<string, MatrixCell>; last: MatrixCell } | null>(null);

  const editing = tool !== "pan" && !!onCellsChange;
  const canPaint = tool === "eraser" || (tool === "brush" && !!brushCode);

  const pointCell = (clientX: number, clientY: number): MatrixCell | null => {
    const cv = canvas.current;
    if (!cv) return null;
    return matrixCellAtPoint(clientX, clientY, cv.getBoundingClientRect(), cv.width, cv.height, width, height, cellRef.current);
  };

  /** 拖动时直接画在当前位图上，避免每次 move 都触发整张图 React 重绘。 */
  const preview = (cells: MatrixCell[], code: string | null) => {
    const cv = canvas.current;
    const ctx = cv?.getContext("2d");
    if (!cv || !ctx) return;
    const size = cellRef.current;
    const gutterX = cv.width - width * size;
    const gutterY = cv.height - height * size;
    const inset = Math.max(1, Math.min(2, Math.floor(size / 4)));
    ctx.save();
    for (const { r, c } of cells) {
      const left = gutterX + c * size;
      const top = gutterY + r * size;
      if (code) {
        ctx.fillStyle = colorOf(code)?.hex ?? "#d4d4d8";
        ctx.fillRect(left, top, size, size);
      } else {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(left, top, size, size);
        ctx.fillStyle = "#e2e8f0";
        ctx.fillRect(left + inset, top + inset, size - inset * 2, size - inset * 2);
      }
      ctx.strokeStyle = "rgba(231, 111, 81, 0.9)";
      ctx.lineWidth = 1;
      ctx.strokeRect(left + 0.5, top + 0.5, Math.max(0, size - 1), Math.max(0, size - 1));
    }
    ctx.restore();
  };

  const addStrokeCells = (cells: MatrixCell[]) => {
    const st = stroke.current;
    if (!st) return;
    const added: MatrixCell[] = [];
    for (const cell of cells) {
      const key = `${cell.r},${cell.c}`;
      if (st.cells.has(key)) continue;
      if ((matrix[cell.r]?.[cell.c] ?? null) === st.code) continue;
      st.cells.set(key, cell);
      added.push(cell);
    }
    if (added.length) preview(added, st.code);
  };

  const finishStroke = (commit: boolean) => {
    const st = stroke.current;
    if (!st) return;
    stroke.current = null;
    if (commit) {
      if (st.cells.size && onCellsChange) onCellsChange([...st.cells.values()], st.code);
    } else {
      draw(); // 丢弃未提交的一笔时，把画布上的临时预览擦掉
    }
  };

  const beginStroke = (pointerId: number, at: MatrixCell) => {
    const code = tool === "eraser" ? null : brushCode ?? null;
    if (tool === "brush" && !code) return false;
    // 先不落第一格：如果第二根手指马上按下（想捏合缩放），不会误改一格。
    // 单击在 onUp 补第一格；拖动在 onMove 用直线补格。
    stroke.current = { pointerId, code, cells: new Map(), last: at };
    return true;
  };

  const onDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button, input, label")) return;
    if (editing && e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const el = wrap.current!;
    if (ptrs.current.size === 2) {
      finishStroke(true);
      const [a, b] = [...ptrs.current.values()];
      gesture.current = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, cell: cellRef.current };
      pan.current = null;
      return;
    }
    if (ptrs.current.size === 1) {
      if (editing) {
        const at = pointCell(e.clientX, e.clientY);
        if (tool === "pick") {
          if (at) onPickCode?.(matrix[at.r]?.[at.c] ?? null);
          pan.current = null;
          return;
        }
        if (at && canPaint && beginStroke(e.pointerId, at)) {
          pan.current = null;
          return;
        }
      }
      pan.current = { x: e.clientX, y: e.clientY, sl: el.scrollLeft, st: el.scrollTop };
    }
  };
  const onMove = (e: React.PointerEvent) => {
    if (!ptrs.current.has(e.pointerId)) return;
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const el = wrap.current!;
    const st = stroke.current;
    if (st && st.pointerId === e.pointerId && ptrs.current.size === 1) {
      const at = pointCell(e.clientX, e.clientY);
      if (at && (at.r !== st.last.r || at.c !== st.last.c)) {
        addStrokeCells(strokeCells(st.last, at, brushSize, width, height));
        st.last = at;
      }
      return;
    }
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
    const st = stroke.current;
    if (st?.pointerId === e.pointerId) {
      addStrokeCells(brushCells(st.last, brushSize, width, height));
      finishStroke(true);
    }
    ptrs.current.delete(e.pointerId);
    gesture.current = null;
    const rest = [...ptrs.current.values()][0];
    pan.current = rest ? { x: rest.x, y: rest.y, sl: wrap.current!.scrollLeft, st: wrap.current!.scrollTop } : null;
  };
  const onCancel = (e: React.PointerEvent) => {
    if (stroke.current?.pointerId === e.pointerId) finishStroke(false);
    ptrs.current.delete(e.pointerId);
    gesture.current = null;
    pan.current = null;
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "+" || e.key === "=") { e.preventDefault(); zoom(1.25); }
    else if (e.key === "-") { e.preventDefault(); zoom(0.8); }
  };

  const label = editing
    ? "拼豆图编辑：单指拖动使用当前工具，双指捏合缩放；方向键滚动，+ − 缩放"
    : "拼豆图，可双指捏合缩放、拖动平移；键盘方向键滚动，+ − 缩放";

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
      <div className="pt-matrix-scroll" ref={wrap} tabIndex={0} role="group" aria-label={label} data-tool={tool}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onCancel} onKeyDown={onKey}>
        <canvas ref={canvas} />
      </div>
      {focusCode ? <p className="meta" style={{ marginTop: 6 }}><Icon name="search" size={12} /> 正在高亮 {focusCode}</p> : null}
    </div>
  );
}
