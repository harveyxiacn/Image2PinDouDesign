import { useEffect, useRef, useState, type ReactNode } from "react";
import "./pattern.css";

type V = { s: number; x: number; y: number };
const MIN = 1, MAX = 8;

/**
 * 通用缩放平移容器（图片用）：双指捏合缩放（以两指中点为中心）、单指/鼠标拖动平移、Ctrl+滚轮缩放；
 * 按钮 −/+/还原 始终可用，方向键平移、+/- 缩放，作为手势的替代。使用指针事件，touch-action:none 避免页面抢手势。
 */
export default function ZoomPan({ children, label }: { children: ReactNode; label: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [v, setV] = useState<V>({ s: 1, x: 0, y: 0 });
  const ptrs = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ d: number; v: V; mx: number; my: number } | null>(null);
  const drag = useRef<{ x: number; y: number; v: V } | null>(null);

  const clamp = (n: V): V => {
    const r = box.current?.getBoundingClientRect();
    const s = Math.max(MIN, Math.min(MAX, n.s));
    if (!r) return { ...n, s };
    const maxX = (r.width * (s - 1)) / 2 + 40, maxY = (r.height * (s - 1)) / 2 + 40;
    return { s, x: Math.max(-maxX, Math.min(maxX, n.x)), y: Math.max(-maxY, Math.min(maxY, n.y)) };
  };
  /** 围绕容器内某点（相对容器中心）缩放 */
  const zoomAt = (from: V, ns: number, cx: number, cy: number): V => {
    const s = Math.max(MIN, Math.min(MAX, ns));
    const k = s / from.s;
    return clamp({ s, x: cx - (cx - from.x) * k, y: cy - (cy - from.y) * k });
  };
  const rel = (e: { clientX: number; clientY: number }) => { const r = box.current!.getBoundingClientRect(); return { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 }; };

  const down = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.current.size === 2) {
      const [a, b] = [...ptrs.current.values()];
      const m = rel({ clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 });
      pinch.current = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, v, mx: m.x, my: m.y };
      drag.current = null;
    } else if (ptrs.current.size === 1) drag.current = { x: e.clientX, y: e.clientY, v };
  };
  const move = (e: React.PointerEvent) => {
    if (!ptrs.current.has(e.pointerId)) return;
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.current.size >= 2 && pinch.current) {
      const [a, b] = [...ptrs.current.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const m = rel({ clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 });
      const z = zoomAt(pinch.current.v, pinch.current.v.s * (d / pinch.current.d), pinch.current.mx, pinch.current.my);
      setV(clamp({ ...z, x: z.x + (m.x - pinch.current.mx), y: z.y + (m.y - pinch.current.my) }));
    } else if (drag.current && v.s > 1) {
      setV(clamp({ ...drag.current.v, x: drag.current.v.x + e.clientX - drag.current.x, y: drag.current.v.y + e.clientY - drag.current.y }));
    }
  };
  const up = (e: React.PointerEvent) => {
    ptrs.current.delete(e.pointerId);
    pinch.current = null;
    const rest = [...ptrs.current.values()][0];
    drag.current = rest ? { x: rest.x, y: rest.y, v } : null;
  };
  // React 的 onWheel 是被动监听，无法 preventDefault；Ctrl+滚轮缩放要用原生非被动监听
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const m = rel(e);
      setV((cur) => zoomAt(cur, cur.s * (e.deltaY < 0 ? 1.15 : 1 / 1.15), m.x, m.y));
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const step = (f: number) => setV((cur) => zoomAt(cur, cur.s * f, 0, 0));
  const key = (e: React.KeyboardEvent) => {
    const pan = 40;
    if (e.key === "+" || e.key === "=") { e.preventDefault(); step(1.25); }
    else if (e.key === "-") { e.preventDefault(); step(0.8); }
    else if (e.key === "0") { e.preventDefault(); setV({ s: 1, x: 0, y: 0 }); }
    else if (v.s > 1 && e.key.startsWith("Arrow")) {
      e.preventDefault();
      setV((cur) => clamp({ ...cur, x: cur.x + (e.key === "ArrowLeft" ? pan : e.key === "ArrowRight" ? -pan : 0), y: cur.y + (e.key === "ArrowUp" ? pan : e.key === "ArrowDown" ? -pan : 0) }));
    }
  };

  return (
    <div className="pt-zoom">
      <div className="pt-matrix-tools">
        <button type="button" className="btn btn-sm" onClick={() => step(0.8)} disabled={v.s <= MIN} aria-label="缩小">−</button>
        <button type="button" className="btn btn-sm" onClick={() => step(1.25)} disabled={v.s >= MAX} aria-label="放大">+</button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setV({ s: 1, x: 0, y: 0 })} disabled={v.s === 1 && !v.x && !v.y}>还原</button>
        <span className="meta num" style={{ marginLeft: "auto" }}>{Math.round(v.s * 100)}%</span>
      </div>
      <div ref={box} className="pt-zoom-box" tabIndex={0} role="group" aria-label={`${label}，可双指捏合缩放、拖动平移；键盘 + − 0 与方向键`} data-zoomed={v.s > 1}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onKeyDown={key}>
        <div className="pt-zoom-inner" style={{ transform: `translate(${v.x}px, ${v.y}px) scale(${v.s})` }}>{children}</div>
      </div>
    </div>
  );
}
