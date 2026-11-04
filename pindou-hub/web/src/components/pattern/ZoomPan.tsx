import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { prefersReducedMotion } from "../ui";
import { clampView, doubleTapTarget, limits, pxPerImagePx, toFraction, viewportRect, zoomAt, type View } from "./zoomMath";
import "./pattern.css";

export type ZoomApi = {
  /** 内容比例坐标（0–1）若在可视区外或靠近边缘，则平移到视野里 */
  ensureVisible: (fx: number, fy: number) => void;
  /** 当前视野中心对应的内容比例坐标 */
  viewCenter: () => { fx: number; fy: number };
  fit: () => void;
};

/**
 * 通用缩放平移容器（图片 + 叠层一起缩放）。
 * 交互约定：
 *  - 按钮：− / + / 适应 / 1:1（实际像素）；读数 = 相对图片实际像素的百分比（没给 natW 时为相对适应宽度）。
 *  - 滚轮：Ctrl / ⌘ + 滚轮缩放（触控板双指捏合同样走这里）；不带修饰键的滚轮保持页面滚动，不劫持。
 *  - 触屏：双指捏合以两指中点为中心；单指拖动平移；双击 / 双击屏幕（≤320ms、≤30px）在该点放大到 4×，已放大则回到适应。
 *  - 点按 vs 拖动：位移 ≤ 6px（触屏 ≤ 10px）算点按，触发 onTap；超过算拖动平移。
 *  - 键盘（容器聚焦后）：+ / − 缩放，0 / Esc 适应，1 实际像素，方向键平移（onKey 可先接管，如格子光标）。
 *  - 放大超过 2 个屏幕像素/图像像素后，图片用 image-rendering: pixelated，颜色不被插值；减少动态偏好下无缩放过渡。
 *  - touch-action：适应状态 pan-y（页面可正常上下滑），放大后才 none；框选模式（panDisabled）也 none。
 */
export default function ZoomPan({ children, label, natW, thumb, panDisabled, onTap, onDoubleTap, onKey, renderOverlay, apiRef, tools, hint }: {
  children: ReactNode; label: string;
  /** 图片自然宽度（像素），用于计算最大放大倍数和 1:1 */
  natW?: number;
  /** 缩略图（小地图底图）；放大后显示当前位置 */
  thumb?: string | null;
  /** 框选模式：单指拖动不平移（留给子元素画框），仍可双指缩放、按钮、滚轮 */
  panDisabled?: boolean;
  onTap?: (e: { clientX: number; clientY: number }) => void;
  /** 双击（第二下）发生时调用：第一下已触发过 onTap，调用方可撤销它的效果 */
  onDoubleTap?: () => void;
  /** 键盘先交给调用方；返回 true 表示已处理 */
  onKey?: (e: React.KeyboardEvent) => boolean;
  /** 不随缩放变换的叠层（如对比滑块的分隔线），v 为当前视图，box 为容器像素尺寸 */
  renderOverlay?: (v: View, box: { w: number; h: number }) => ReactNode;
  apiRef?: Ref<ZoomApi>;
  /** 工具栏右侧附加内容 */
  tools?: ReactNode;
  hint?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const vref = useRef<View>({ s: 1, x: 0, y: 0 });
  const [v, setV] = useState<View>(vref.current);
  const [smooth, setSmooth] = useState(false);
  const size = useRef({ w: 0, h: 0 });
  const [boxSize, setBoxSize] = useState({ w: 0, h: 0 });
  const nat = useRef(natW); nat.current = natW;
  const pan = useRef(!!panDisabled); pan.current = !!panDisabled;
  const ptrs = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ d: number; v: View; mx: number; my: number } | null>(null);
  const drag = useRef<{ x: number; y: number; v: View } | null>(null);
  const tap = useRef<{ x: number; y: number; moved: boolean; touch: boolean } | null>(null);
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null);

  const lim = () => limits(size.current.w, nat.current);
  const commit = useCallback((n: View, animate = false) => {
    const c = clampView(n, size.current.w, size.current.h, limits(size.current.w, nat.current));
    vref.current = c;
    setV(c);
    setSmooth(animate && !prefersReducedMotion());
  }, []);
  const rel = (e: { clientX: number; clientY: number }) => { const r = box.current!.getBoundingClientRect(); return { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 }; };
  const zoomTo = (ns: number, cx: number, cy: number, animate: boolean) => commit(zoomAt(vref.current, ns, cx, cy, size.current.w, size.current.h, lim()), animate);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      size.current = { w: r.width, h: r.height };
      setBoxSize({ w: r.width, h: r.height });
      commit(vref.current);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [commit]);
  // 自然宽度变化（换图 / 高清图加载后），上限随之变化
  useEffect(() => { commit(vref.current); }, [natW, commit]);

  const fit = () => commit({ s: 1, x: 0, y: 0 }, true);
  const actual = () => zoomTo(lim().actual, 0, 0, true);
  const step = (f: number) => zoomTo(vref.current.s * f, 0, 0, true);

  useImperativeHandle(apiRef, () => ({
    fit,
    viewCenter: () => toFraction(vref.current, 0, 0, size.current.w, size.current.h),
    ensureVisible: (fx, fy) => {
      const { w, h } = size.current, cur = vref.current;
      const px = (fx - 0.5) * w * cur.s + cur.x, py = (fy - 0.5) * h * cur.s + cur.y;
      if (Math.abs(px) < w * 0.4 && Math.abs(py) < h * 0.4) return;
      commit({ ...cur, x: cur.x - px, y: cur.y - py }, true);
    }
  }));

  const THR_TOUCH = 10, THR_MOUSE = 6;
  const down = (e: React.PointerEvent) => {
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    setSmooth(false);
    if (ptrs.current.size === 1) tap.current = { x: e.clientX, y: e.clientY, moved: false, touch: e.pointerType !== "mouse" };
    else if (tap.current) tap.current.moved = true;
    if (ptrs.current.size === 2) {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      const [a, b] = [...ptrs.current.values()];
      const m = rel({ clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 });
      pinch.current = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, v: vref.current, mx: m.x, my: m.y };
      drag.current = null;
    } else if (ptrs.current.size === 1 && !pan.current) {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      drag.current = { x: e.clientX, y: e.clientY, v: vref.current };
    }
  };
  const move = (e: React.PointerEvent) => {
    if (!ptrs.current.has(e.pointerId)) return;
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const t = tap.current;
    if (t && !t.moved && Math.hypot(e.clientX - t.x, e.clientY - t.y) > (t.touch ? THR_TOUCH : THR_MOUSE)) t.moved = true;
    if (ptrs.current.size >= 2 && pinch.current) {
      const [a, b] = [...ptrs.current.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const m = rel({ clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 });
      const p = pinch.current;
      const z = zoomAt(p.v, p.v.s * (d / p.d), p.mx, p.my, size.current.w, size.current.h, lim());
      commit({ ...z, x: z.x + (m.x - p.mx), y: z.y + (m.y - p.my) });
    } else if (drag.current && t?.moved && vref.current.s > 1) {
      const dr = drag.current;
      commit({ ...dr.v, x: dr.v.x + e.clientX - dr.x, y: dr.v.y + e.clientY - dr.y });
    }
  };
  const up = (e: React.PointerEvent) => {
    const wasOne = ptrs.current.size === 1;
    ptrs.current.delete(e.pointerId);
    pinch.current = null;
    const rest = [...ptrs.current.values()][0];
    drag.current = rest ? { x: rest.x, y: rest.y, v: vref.current } : null;
    const t = tap.current;
    if (!wasOne || !t) return;
    tap.current = null;
    if (e.type === "pointercancel" || t.moved || pan.current) return;
    const now = performance.now(), lt = lastTap.current;
    if (lt && now - lt.t < 320 && Math.hypot(e.clientX - lt.x, e.clientY - lt.y) < 30) {
      lastTap.current = null;
      onDoubleTap?.();
      const m = rel(e);
      zoomTo(doubleTapTarget(vref.current, 4), m.x, m.y, true);
      return;
    }
    lastTap.current = { t: now, x: e.clientX, y: e.clientY };
    onTap?.({ clientX: e.clientX, clientY: e.clientY });
  };
  // React 的 onWheel 是被动监听，无法 preventDefault；Ctrl/⌘+滚轮缩放要用原生非被动监听。普通滚轮不拦截（页面照常滚动）。
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const m = rel(e);
      zoomTo(vref.current.s * Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0022)), m.x, m.y, false);
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const key = (e: React.KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (onKey?.(e)) { e.preventDefault(); return; }
    const k = e.key;
    if (k === "+" || k === "=") { e.preventDefault(); step(1.25); }
    else if (k === "-" || k === "_") { e.preventDefault(); step(0.8); }
    else if (k === "0" || k === "Escape") { if (vref.current.s !== 1 || vref.current.x || vref.current.y) { e.preventDefault(); fit(); } }
    else if (k === "1") { e.preventDefault(); actual(); }
    else if (vref.current.s > 1 && k.startsWith("Arrow")) {
      e.preventDefault();
      const cur = vref.current, dx = size.current.w * 0.15, dy = size.current.h * 0.15;
      commit({ ...cur, x: cur.x + (k === "ArrowLeft" ? dx : k === "ArrowRight" ? -dx : 0), y: cur.y + (k === "ArrowUp" ? dy : k === "ArrowDown" ? -dy : 0) }, true);
    }
  };

  const L = limits(boxSize.w, natW);
  const pct = Math.round((natW && boxSize.w ? (v.s * boxSize.w) / natW : v.s) * 100);
  const pixel = pxPerImagePx(v.s, boxSize.w, natW) > 2;
  const zoomed = v.s > 1.02;
  const vp = viewportRect(v, boxSize.w, boxSize.h);
  const atActual = natW ? Math.abs(v.s - L.actual) < 0.01 : false;
  return (
    <div className="pt-zoom">
      <div className="pt-matrix-tools" role="toolbar" aria-label={`${label}缩放`}>
        <button type="button" className="btn btn-sm" onClick={() => step(0.8)} disabled={v.s <= L.min + 0.001} aria-label="缩小" title="缩小（−）">−</button>
        <button type="button" className="btn btn-sm" onClick={() => step(1.25)} disabled={v.s >= L.max - 0.001} aria-label="放大" title="放大（+）">+</button>
        <button type="button" className="btn btn-sm" onClick={fit} disabled={v.s === 1 && !v.x && !v.y} title="适应窗口（0 / Esc）">适应</button>
        <button type="button" className="btn btn-sm" onClick={actual} disabled={atActual} aria-label="实际像素 1:1" title="实际像素（1）">1:1</button>
        <span className="meta num pt-zoom-pct" data-testid="zoom-pct" aria-label={`缩放 ${pct}%`} title="相对图片实际像素">{pct}%</span>
        {tools}
      </div>
      <div ref={box} className="pt-zoom-box" tabIndex={0} role="group" aria-label={`${label}，可缩放平移。按钮或键盘：+ − 缩放，0 适应，1 实际像素，方向键平移；Ctrl 加滚轮缩放，双击放大；手机可双指捏合`}
        data-zoomed={zoomed} data-pixel={pixel} data-lock={!!panDisabled} data-smooth={smooth} data-scale={v.s.toFixed(3)}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onKeyDown={key}>
        <div className="pt-zoom-inner" style={{ transform: `translate(${v.x}px, ${v.y}px) scale(${v.s})` }}>{children}</div>
        {renderOverlay ? <div className="pt-zoom-ov">{renderOverlay(v, boxSize)}</div> : null}
        {zoomed && boxSize.w > 0 ? (
          <div className="pt-minimap" aria-hidden="true" style={{ aspectRatio: `${boxSize.w} / ${boxSize.h}`, backgroundImage: thumb ? `url("${thumb}")` : undefined }}>
            <i style={{ left: `${vp.l * 100}%`, top: `${vp.t * 100}%`, width: `${vp.w * 100}%`, height: `${vp.h * 100}%` }} />
          </div>
        ) : null}
      </div>
      <p className="meta pt-zoom-hint">{hint ?? "Ctrl + 滚轮缩放 · 双击放大 · 拖动平移"}</p>
    </div>
  );
}
