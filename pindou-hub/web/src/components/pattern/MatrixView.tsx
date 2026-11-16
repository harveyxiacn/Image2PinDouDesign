import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { renderDesignToCanvas } from "@engine/rendering";
import type { BeadDesign } from "@engine/types";
import { PALETTE, colorOf } from "../../lib/palette";
import { brushCells, matrixCellAtPoint, strokeCells, type BrushSize, type MatrixCell } from "../../lib/matrixEdit";
import { labelFontPx, LABEL_MIN_CELL, labelMinCell, labelTextColor, labelsFit, longestCodeLength } from "../../lib/matrixLabels";
import { Icon } from "../ui";
import { contentPoint, isPanGesture, pinScroll, wheelZoomCell } from "./zoomMath";
import "./pattern.css";
import "./MatrixView.css";

const MAX_PIXELS = 16_000_000;
const CODES_KEY = "pindou.matrix.showCodes";

function readStoredCodes(): boolean | null {
  try { const v = localStorage.getItem(CODES_KEY); return v === "1" ? true : v === "0" ? false : null; } catch { return null; }
}
function storeCodes(on: boolean) {
  try { localStorage.setItem(CODES_KEY, on ? "1" : "0"); } catch { /* 无痕模式等：不记住也不影响使用 */ }
}

export type MatrixTool = "pan" | "brush" | "eraser" | "pick";

/**
 * 拼豆图交互查看器 / 编辑器：
 *  - pan：双指捏合缩放，单指 / 鼠标拖动平移（直接滚动容器）；按钮 −/+/适应宽度 作为替代。
 *  - brush / eraser：单指拖动连续改色 / 清空，抬笔时整笔一次提交；双指仍可缩放。
 *  - pick：点格子取色，不修改矩阵。
 *  - focusCode 高亮某个色号（其余变淡）；编辑时由调用方传 null，避免整图变淡。
 *  - showCodes：格子里写色号（格子够大时才画，开关记在 localStorage）；不传则用上次的选择，默认开。
 *    传了就以它为准且不改写记住的选择，只有用户自己点开关才会记。
 *  - autoZoomCodes：刚打开时若开着色号但格子太小，自动放大到能看清（编辑格子时用）。
 */
export default function MatrixView({
  matrix, width, height, focusCode, labels = true, showCodes, autoZoomCodes = false,
  tool = "pan", brushCode = null, brushSize = 1, onCellsChange, onPickCode
}: {
  matrix: Array<Array<string | null>>; width: number; height: number; focusCode?: string | null; labels?: boolean;
  /** 色号初始开关；不传时读取上次记住的选择，再回退到 labels。 */
  showCodes?: boolean;
  autoZoomCodes?: boolean;
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
  const [showLabels, setShowLabels] = useState(() => showCodes ?? readStoredCodes() ?? labels);
  // 缩放后要保持不动的“锚点”：内容坐标（以格为单位）对应容器内的像素位置
  const anchor = useRef<{ cx: number; cy: number; px: number; py: number } | null>(null);

  const maxCell = Math.max(6, Math.min(48, Math.floor(Math.sqrt(MAX_PIXELS / Math.max(1, width * height)))));
  const design = useMemo<BeadDesign>(() => ({ id: "view", fileName: "", boardWidth: width, boardHeight: height, matrix, colorCounts: {} }), [matrix, width, height]);

  // 图里最长的色号决定“放大到能看清”要放多大；是否画色号只看基础尺寸（2 字），这样边画边出现新的 3 字色号时不会整图色号突然消失

  const codeLen = useMemo(() => longestCodeLength(matrix), [matrix]);
  const codesReachable = LABEL_MIN_CELL <= maxCell;
  const codesMinCell = Math.min(labelMinCell(codeLen), maxCell);

  useEffect(() => {
    const w = wrap.current?.clientWidth ?? 360;
    const fitCell = Math.max(4, Math.min(maxCell, Math.min(28, Math.floor((w - 2) / Math.max(1, width))))) || 8;
    // 编辑时要看清每格的色号：开着色号而适应宽度放不下，就直接放大到刚好能看清（用户随时可点“适应宽度”）
    const zoomIn = autoZoomCodes && showLabels && codesReachable && fitCell < codesMinCell;
    // 放大后图比窗口大：把图的正中放到窗口正中，而不是停在左上角的空白处
    if (zoomIn) { const el = wrap.current; anchor.current = { cx: width / 2, cy: height / 2, px: (el?.clientWidth ?? w) / 2, py: (el?.clientHeight ?? w) / 2 }; }
    setCell(zoomIn ? codesMinCell : fitCell);
  }, [width, maxCell]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 重画整张图；拖动预览是直接画在位图上的，取消一笔时要靠它恢复。 */
  const draw = () => {
    const cv = canvas.current;
    const size = cellRef.current;
    if (!cv || !size) return;
    // 色号由下面自己画：字号随格子与字数缩放，深浅底自动黑白字，非高亮色号变淡
    renderDesignToCanvas(cv, design, PALETTE, { cellSize: size, showLabels: false, boardLineEvery: 10, focusCode: focusCode ?? null });
    if (showLabels && labelsFit(size)) drawCodes(cv, size);
  };

  /** 在 (left, top) 的格子里写色号；字号随格子与字数缩放，深浅底自动黑白字。 */
  const drawCode = (ctx: CanvasRenderingContext2D, code: string, left: number, top: number, size: number, setFont = true) => {
    if (setFont) ctx.font = `700 ${labelFontPx(size, code.length)}px ui-monospace, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = labelTextColor(colorOf(code)?.hex);
    ctx.fillText(code, left + size / 2, top + size / 2 + 0.5);
  };

  const drawCodes = (cv: HTMLCanvasElement, size: number) => {
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const gutterX = cv.width - width * size, gutterY = cv.height - height * size;
    ctx.save();
    let fontLen = 0;
    for (let r = 0; r < height; r += 1) {
      const row = matrix[r];
      if (!row) continue;
      for (let c = 0; c < width; c += 1) {
        const code = row[c];
        if (!code) continue;
        ctx.globalAlpha = focusCode && code !== focusCode ? 0.28 : 1;
        drawCode(ctx, code, gutterX + c * size, gutterY + r * size, size, code.length !== fontLen);
        fontLen = code.length;
      }
    }
    ctx.restore();
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
  const gesture = useRef<{ d: number; cell: number; pin: { cx: number; cy: number } } | null>(null);
  const spaceHeld = useRef(false);
  const [panning, setPanning] = useState(false);
  const maxCellRef = useRef(maxCell);
  maxCellRef.current = maxCell;
  const zoomToRef = useRef(zoomTo);
  zoomToRef.current = zoomTo;
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
        if (showLabels && labelsFit(size)) drawCode(ctx, code, left, top, size); // 拖动中就能看到新色号
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

  /** 双指缩放 + 平移：让两指中点下的内容点始终跟着中点走 */
  const pinZoom = (next: number, pin: { cx: number; cy: number }, mx: number, my: number) => {
    const el = wrap.current;
    if (!el) return;
    const n = clampCell(next);
    if (n === cellRef.current) {
      const p = pinScroll(pin, n, mx, my);
      el.scrollLeft = p.left; el.scrollTop = p.top;
      return;
    }
    anchor.current = { cx: pin.cx, cy: pin.cy, px: mx, py: my };
    setCell(n);
  };

  const onDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button, input, label")) return;
    const panBtn = isPanGesture(e.button, spaceHeld.current);
    if (editing && e.button !== 0 && e.button !== 1) return;
    if (e.button === 1) e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const el = wrap.current!;
    if (ptrs.current.size === 2) {
      finishStroke(true);
      const [a, b] = [...ptrs.current.values()];
      const r0 = el.getBoundingClientRect();
      const m0 = { x: (a.x + b.x) / 2 - r0.left, y: (a.y + b.y) / 2 - r0.top };
      gesture.current = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, cell: cellRef.current, pin: contentPoint(el.scrollLeft, el.scrollTop, m0.x, m0.y, cellRef.current) };
      pan.current = null;
      return;
    }
    if (ptrs.current.size === 1) {
      if (editing && !panBtn) {
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
      raf.current = requestAnimationFrame(() => pinZoom(g.cell * (d / g.d), g.pin, mx, my));
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
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === " " && e.target === e.currentTarget) { e.preventDefault(); spaceHeld.current = true; setPanning(true); }
    else if (e.key === "+" || e.key === "=") { e.preventDefault(); zoom(1.25); }
    else if (e.key === "-") { e.preventDefault(); zoom(0.8); }
    else if (e.key === "0") { e.preventDefault(); fit(); }
  };
  const onKeyUp = (e: React.KeyboardEvent) => { if (e.key === " ") { spaceHeld.current = false; setPanning(false); } };
  // Ctrl / ⌘ + 滚轮（触控板捏合同样走这里）：以鼠标位置为中心缩放。普通滚轮保持滚动。需要非被动监听才能阻止页面缩放。
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomToRef.current(wheelZoomCell(cellRef.current, e.deltaY, e.deltaMode, 3, maxCellRef.current), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);
  useEffect(() => {
    const clear = () => { spaceHeld.current = false; setPanning(false); };
    window.addEventListener("blur", clear);
    return () => window.removeEventListener("blur", clear);
  }, []);

  const label = editing
    ? "拼豆图编辑：单指拖动使用当前工具，双指捏合缩放并拖动；方向键滚动，+ − 缩放，0 适应宽度；按住空格或鼠标中键拖动平移；Ctrl 加滚轮缩放"
    : "拼豆图，可双指捏合缩放、拖动平移；键盘方向键滚动，+ − 缩放";

  return (
    <div className="pt-matrix" data-codes={showLabels && labelsFit(cell) ? "on" : "off"}>
      <div className="pt-matrix-tools">
        <button className="btn btn-sm" onClick={() => zoom(0.8)} aria-label="缩小" title="缩小（−）">−</button>
        <button className="btn btn-sm" onClick={() => zoom(1.25)} aria-label="放大" title="放大（+）">+</button>
        <button className="btn btn-sm btn-ghost" onClick={fit} title="适应宽度（0）">适应宽度</button>
        <label className="pt-check pt-codes-toggle" data-codes-toggle>
          <input type="checkbox" checked={showLabels} onChange={(e) => { setShowLabels(e.target.checked); storeCodes(e.target.checked); }} />显示色号
        </label>
        <span className="meta num">{width}×{height}</span>
      </div>
      <div className="pt-matrix-scroll" ref={wrap} tabIndex={0} role="group" aria-label={label} data-tool={tool} data-panning={panning ? "true" : undefined}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onCancel} onKeyDown={onKey} onKeyUp={onKeyUp} onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}>
        <canvas ref={canvas} />
      </div>
      {showLabels && cell > 0 && !labelsFit(cell) ? (
        <p className="meta" data-codes-hint style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
          {codesReachable ? (
            <>
              <button type="button" className="btn btn-sm" style={{ minHeight: 44 }} data-codes-zoom onClick={() => zoomTo(codesMinCell)}>放大到能看清色号</button>
              <span>格子太小，色号没画出来（现在 {cell}px，需要 ≥ {codesMinCell}px）</span>
            </>
          ) : <span>这张图太大，格子放不到能写下色号的尺寸；可以只看局部或关掉“显示色号”。</span>}
        </p>
      ) : null}
      {focusCode ? <p className="meta" style={{ marginTop: 6 }}><Icon name="search" size={12} /> 正在高亮 {focusCode}</p> : null}
    </div>
  );
}
