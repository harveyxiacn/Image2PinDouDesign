// 拼装模式的棋盘：只画当前这块板（最多 58×58 格），支持双指缩放、拖动、点按切换某格完成。
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import type { Board } from "../../lib/build";
import { cellAt } from "../../lib/build";
import { labelFontPx, labelsFit, labelTextColor } from "../../lib/matrixLabels";
import type { Matrix } from "../../lib/matrix";
import { colorOf } from "../../lib/palette";

const RULER = 20;
const MAX_SCALE = 8;
type View = { scale: number; tx: number; ty: number };
type Size = { w: number; h: number };

export type BuildCanvasApi = { zoom: (by: "in" | "out" | "fit") => void };

type Props = {
  apiRef?: Ref<BuildCanvasApi>;
  matrix: Matrix;
  width: number;
  board: Board;
  code: string | null;
  flags: Uint8Array;
  /** flags 被原地修改，靠它触发重画 */
  version: number;
  rowY: number | null;
  label: string;
  onToggle: (index: number) => void;
};

function geometry(size: Size, board: Board, view: View) {
  const aw = Math.max(1, size.w - RULER);
  const ah = Math.max(1, size.h - RULER);
  const base = Math.min(aw / board.w, ah / board.h);
  const cell = base * view.scale;
  const cw = board.w * cell;
  const ch = board.h * cell;
  const ox0 = cw < aw ? (aw - cw) / 2 : 0;
  const oy0 = ch < ah ? (ah - ch) / 2 : 0;
  return { aw, ah, base, cell, cw, ch, ox0, oy0, ox: RULER + ox0 + view.tx, oy: RULER + oy0 + view.ty };
}

function clampView(size: Size, board: Board, view: View): View {
  const scale = Math.min(MAX_SCALE, Math.max(1, view.scale));
  const g = geometry(size, board, { ...view, scale });
  const tx = g.cw <= g.aw ? 0 : Math.min(0, Math.max(g.aw - g.cw, view.tx));
  const ty = g.ch <= g.ah ? 0 : Math.min(0, Math.max(g.ah - g.ch, view.ty));
  return { scale, tx, ty };
}

/** 以屏幕点 (cx,cy) 为不动点缩放。 */
function zoomAt(size: Size, board: Board, view: View, nextScale: number, cx: number, cy: number): View {
  const g = geometry(size, board, view);
  const wx = (cx - g.ox) / g.cell;
  const wy = (cy - g.oy) / g.cell;
  const scale = Math.min(MAX_SCALE, Math.max(1, nextScale));
  const g2 = geometry(size, board, { scale, tx: 0, ty: 0 });
  return clampView(size, board, { scale, tx: cx - wx * g2.cell - RULER - g2.ox0, ty: cy - wy * g2.cell - RULER - g2.oy0 });
}

function css(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export default function BuildCanvas({ apiRef, matrix, width, board, code, flags, version, rowY, label, onToggle }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<Size>({ w: 0, h: 0 });
  const [view, setView] = useState<View>({ scale: 1, tx: 0, ty: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const boardRef = useRef(board);
  boardRef.current = board;
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ moved: boolean; t: number; startView: View; dist: number; sx: number; sy: number } | null>(null);

  // 换板时回到整块板
  useEffect(() => { setView({ scale: 1, tx: 0, ty: 0 }); }, [board.index, board.x0, board.y0, board.w, board.h]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const read = () => { const r = el.getBoundingClientRect(); setSize({ w: Math.floor(r.width), h: Math.floor(r.height) }); };
    read();
    if (typeof ResizeObserver === "undefined") { window.addEventListener("resize", read); return () => window.removeEventListener("resize", read); }
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 键盘缩放：以棋盘区中心为不动点
  useImperativeHandle(apiRef, () => ({
    zoom: (by) => {
      const sz = sizeRef.current;
      const v = viewRef.current;
      if (by === "fit") { setView({ scale: 1, tx: 0, ty: 0 }); return; }
      setView(zoomAt(sz, boardRef.current, v, v.scale * (by === "in" ? 1.4 : 1 / 1.4), RULER + (sz.w - RULER) / 2, RULER + (sz.h - RULER) / 2));
    }
  }), []);

  // 滚轮缩放（桌面）；需要非被动监听才能阻止页面滚动
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const v = viewRef.current;
      setView(zoomAt(sizeRef.current, boardRef.current, v, v.scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX - r.left, e.clientY - r.top));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.w < 10 || size.h < 10) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    if (canvas.width !== Math.round(size.w * dpr) || canvas.height !== Math.round(size.h * dpr)) {
      canvas.width = Math.round(size.w * dpr);
      canvas.height = Math.round(size.h * dpr);
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const paper = css("--paper-sunk", "#ebe5d7");
    const raised = css("--paper-raised", "#fbf9f3");
    const ink = css("--ink", "#1f1c18");
    const ink3 = css("--ink-3", "#6e665a");
    const rule = css("--rule-strong", "rgba(70,52,28,.26)");
    const iron = css("--iron", "#c63f25");
    ctx.clearRect(0, 0, size.w, size.h);
    ctx.fillStyle = paper;
    ctx.fillRect(0, 0, size.w, size.h);
    const g = geometry(size, board, view);
    const { cell, ox, oy } = g;

    ctx.save();
    ctx.beginPath();
    ctx.rect(RULER, RULER, g.aw, g.ah);
    ctx.clip();
    // 板面
    ctx.fillStyle = raised;
    ctx.fillRect(ox, oy, g.cw, g.ch);
    const showLabels = labelsFit(cell);
    const x1 = Math.min(board.x0 + board.w, Math.ceil((size.w - ox) / cell) + board.x0);
    const y1 = Math.min(board.y0 + board.h, Math.ceil((size.h - oy) / cell) + board.y0);
    const x00 = Math.max(board.x0, Math.floor((RULER - ox) / cell) + board.x0);
    const y00 = Math.max(board.y0, Math.floor((RULER - oy) / cell) + board.y0);
    if (rowY !== null && rowY >= board.y0 && rowY < board.y0 + board.h) {
      ctx.fillStyle = css("--iron-wash", "rgba(214,69,42,.12)");
      ctx.fillRect(ox, oy + (rowY - board.y0) * cell, g.cw, cell);
    }
    for (let y = y00; y < y1; y += 1) {
      for (let x = x00; x < x1; x += 1) {
        const c = cellAt(matrix, x, y);
        const px = ox + (x - board.x0) * cell;
        const py = oy + (y - board.y0) * cell;
        const cx = px + cell / 2;
        const cy = py + cell / 2;
        if (!c) {
          ctx.fillStyle = rule;
          ctx.beginPath(); ctx.arc(cx, cy, Math.max(1, cell * 0.06), 0, Math.PI * 2); ctx.fill();
          continue;
        }
        const hex = colorOf(c)?.hex ?? "#d4d4d8";
        const isDone = flags[y * width + x] === 1;
        const r = cell * 0.44;
        if (code !== null && c === code) {
          const offRow = rowY !== null && y !== rowY;
          ctx.globalAlpha = isDone ? 0.35 : offRow ? 0.4 : 1;
          ctx.fillStyle = hex;
          ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
          ctx.lineWidth = Math.max(1, cell * 0.05);
          ctx.strokeStyle = ink3;
          ctx.stroke();
          ctx.globalAlpha = offRow && !isDone ? 0.5 : 1;
          if (isDone) {
            ctx.strokeStyle = ink;
            ctx.lineWidth = Math.max(1.5, cell * 0.09);
            ctx.lineCap = "round"; ctx.lineJoin = "round";
            ctx.beginPath();
            ctx.moveTo(cx - r * 0.45, cy + r * 0.02); ctx.lineTo(cx - r * 0.1, cy + r * 0.38); ctx.lineTo(cx + r * 0.5, cy - r * 0.32);
            ctx.stroke();
          } else if (showLabels) {
            ctx.fillStyle = labelTextColor(colorOf(c)?.hex);
            ctx.font = `600 ${labelFontPx(cell, c.length)}px ui-monospace, Consolas, monospace`;
            ctx.textAlign = "center"; ctx.textBaseline = "middle";
            ctx.fillText(c, cx, cy + 0.5);
          }
          ctx.globalAlpha = 1;
        } else if (isDone) {
          ctx.globalAlpha = 0.3;
          ctx.fillStyle = hex;
          ctx.beginPath(); ctx.arc(cx, cy, r * 0.85, 0, Math.PI * 2); ctx.fill();
          ctx.globalAlpha = 1;
        } else {
          ctx.globalAlpha = 0.5;
          ctx.strokeStyle = hex;
          ctx.lineWidth = Math.max(1, cell * 0.06);
          ctx.beginPath(); ctx.arc(cx, cy, r * 0.8, 0, Math.PI * 2); ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }
    }
    // 每 5 格一条参考线（整张图的坐标）
    ctx.strokeStyle = rule;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = board.x0 + 1; x < board.x0 + board.w; x += 1) if (x % 5 === 0) { const px = Math.round(ox + (x - board.x0) * cell) + 0.5; ctx.moveTo(px, oy); ctx.lineTo(px, oy + g.ch); }
    for (let y = board.y0 + 1; y < board.y0 + board.h; y += 1) if (y % 5 === 0) { const py = Math.round(oy + (y - board.y0) * cell) + 0.5; ctx.moveTo(ox, py); ctx.lineTo(ox + g.cw, py); }
    ctx.stroke();
    ctx.strokeStyle = ink3;
    ctx.strokeRect(ox + 0.5, oy + 0.5, g.cw, g.ch);
    ctx.restore();

    // 标尺：数字是整张图的行列号（从 1 起），每 5 个标一次
    ctx.fillStyle = raised;
    ctx.fillRect(0, 0, size.w, RULER);
    ctx.fillRect(0, 0, RULER, size.h);
    ctx.fillStyle = ink3;
    ctx.font = "600 10px ui-monospace, Consolas, monospace";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    const every = cell < 9 ? 10 : 5;
    ctx.save();
    ctx.beginPath(); ctx.rect(RULER, 0, g.aw, RULER); ctx.clip();
    for (let x = board.x0; x < board.x0 + board.w; x += 1) {
      if ((x + 1) % every === 0 || x === board.x0) ctx.fillText(String(x + 1), ox + (x - board.x0 + 0.5) * cell, RULER / 2);
    }
    ctx.restore();
    ctx.save();
    ctx.beginPath(); ctx.rect(0, RULER, RULER, g.ah); ctx.clip();
    for (let y = board.y0; y < board.y0 + board.h; y += 1) {
      const active = rowY === y;
      if ((y + 1) % every === 0 || y === board.y0 || active) {
        ctx.fillStyle = active ? iron : ink3;
        ctx.fillText(String(y + 1), RULER / 2, oy + (y - board.y0 + 0.5) * cell);
      }
    }
    ctx.restore();
    ctx.strokeStyle = rule;
    ctx.beginPath(); ctx.moveTo(0, RULER + 0.5); ctx.lineTo(size.w, RULER + 0.5); ctx.moveTo(RULER + 0.5, 0); ctx.lineTo(RULER + 0.5, size.h); ctx.stroke();
  }, [matrix, width, board, code, flags, version, rowY, size, view]);

  const hit = useCallback((px: number, py: number) => {
    const g = geometry(sizeRef.current, boardRef.current, viewRef.current);
    if (px < RULER || py < RULER) return;
    const b = boardRef.current;
    const x = Math.floor((px - g.ox) / g.cell) + b.x0;
    const y = Math.floor((py - g.oy) / g.cell) + b.y0;
    if (x < b.x0 || y < b.y0 || x >= b.x0 + b.w || y >= b.y0 + b.h) return;
    onToggle(y * width + x);
  }, [onToggle, width]);

  const local = (e: React.PointerEvent) => {
    const r = wrapRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const dist = () => { const p = [...pointers.current.values()]; return p.length < 2 ? 0 : Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y); };

  const onPointerDown = (e: React.PointerEvent) => {
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* 合成事件没有捕获 */ }
    gesture.current = { moved: pointers.current.size > 1, t: performance.now(), startView: viewRef.current, dist: dist(), sx: p.x, sy: p.y };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const prev = pointers.current.get(e.pointerId);
    const g = gesture.current;
    if (!prev || !g) return;
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    const n = pointers.current.size;
    if (n >= 2) {
      g.moved = true;
      const pts = [...pointers.current.values()];
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if (g.dist > 0) {
        const cx = (pts[0].x + pts[1].x) / 2;
        const cy = (pts[0].y + pts[1].y) / 2;
        setView(zoomAt(sizeRef.current, boardRef.current, viewRef.current, viewRef.current.scale * (d / g.dist), cx, cy));
      }
      g.dist = d;
      return;
    }
    if (!g.moved && Math.hypot(p.x - g.sx, p.y - g.sy) < 8) return;
    g.moved = true;
    const v = viewRef.current;
    setView(clampView(sizeRef.current, boardRef.current, { scale: v.scale, tx: v.tx + (p.x - prev.x), ty: v.ty + (p.y - prev.y) }));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const g = gesture.current;
    const had = pointers.current.delete(e.pointerId);
    if (!had || !g) return;
    if (pointers.current.size === 0) {
      if (e.type === "pointerup" && !g.moved && performance.now() - g.t < 600) hit(g.sx, g.sy);
      gesture.current = null;
    } else {
      g.moved = true;
      g.dist = dist();
    }
  };

  const zoomed = view.scale > 1.01;
  return (
    <div className="bc-wrap" ref={wrapRef} data-build-canvas data-build-scale={view.scale.toFixed(2)}>
      <canvas ref={canvasRef} role="img" aria-label={label} style={{ width: size.w, height: size.h }}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onContextMenu={(e) => e.preventDefault()} />
      {zoomed ? <button type="button" className="btn btn-sm bc-fit" onClick={() => setView({ scale: 1, tx: 0, ty: 0 })}>适合屏幕</button> : null}
    </div>
  );
}
