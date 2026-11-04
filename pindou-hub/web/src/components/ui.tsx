// 共用界面原语：图标、豆子色块、抽屉/弹层、提示条、哈希路由。各页面只用这些 + styles.css 中的类。
import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { colorOf } from "../lib/palette";

// ---------- 图标（1.6px 线性，24 栅格） ----------
const ICONS: Record<string, string> = {
  home: "M4 11.5 12 5l8 6.5V20a1 1 0 0 1-1 1h-5v-6h-4v6H5a1 1 0 0 1-1-1z",
  gallery: "M4 5h16v14H4zM4 15l4.5-4.5 4 4L15 12l5 5M15.5 9.5a1 1 0 1 0 0-.01",
  box: "M4 7h16v12H4zM4 7l2-3h12l2 3M9.33 7v12M14.67 7v12M4 13h16",
  cart: "M3 4h2.2l2.1 10.2a1 1 0 0 0 1 .8h8.9a1 1 0 0 0 1-.76L20 8H6.1M9.5 19.5a1 1 0 1 0 0-.01M17 19.5a1 1 0 1 0 0-.01",
  history: "M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4M12 8v4l3 2",
  sync: "M20 7h-5M20 7V2M20 7l-2.3-2.3A8 8 0 0 0 4.4 9M4 17h5M4 17v5M4 17l2.3 2.3A8 8 0 0 0 19.6 15",
  plus: "M12 5v14M5 12h14",
  scan: "M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M4 12h16",
  wand: "M5 19 15 9M14 5l1-2 1 2 2 1-2 1-1 2-1-2-2-1zM19 12l.6-1.4L21 10l-1.4-.6L19 8l-.6 1.4L17 10l1.4.6z",
  upload: "M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3",
  check: "M5 12.5 10 17 19 7",
  x: "M6 6l12 12M18 6 6 18",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13",
  edit: "M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4",
  download: "M12 4v12M7 11l5 5 5-5M4 20h16",
  copy: "M8 8h11v12H8zM5 16V4h11",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4",
  chevron: "M9 6l6 6-6 6",
  back: "M15 6l-6 6 6 6",
  alert: "M12 9v4M12 17h.01M10.3 4.2 2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z",
  sparkle: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z",
  phone: "M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM11 18h2"
};

export function Icon({ name, size = 20 }: { name: keyof typeof ICONS | string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name] ?? ICONS.plus} />
    </svg>
  );
}

// ---------- 豆子 ----------
export function Bead({ code, size = 22, flat = false, title }: { code: string; size?: number; flat?: boolean; title?: string }) {
  const color = colorOf(code);
  return (
    <span
      className={`bead${flat ? " flat" : ""}`}
      style={{ ["--c" as string]: color?.hex ?? "#bbb", ["--s" as string]: `${size}px` }}
      title={title ?? (color ? `${code} ${color.nameZh}` : code)}
      aria-hidden="true"
    />
  );
}

export function BeadCode({ code, size = 22, showName = false }: { code: string; size?: number; showName?: boolean }) {
  const color = colorOf(code);
  return (
    <span className="bead-code">
      <Bead code={code} size={size} />
      <span className="code">{code}</span>
      {showName && color ? <span className="meta">{color.nameZh}</span> : null}
    </span>
  );
}

// ---------- 动效偏好 ----------
export function prefersReducedMotion(): boolean {
  return typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// ---------- 只让变化的字动（参考 uiux-prompt-playbook › app-gesture-diff） ----------
// 新旧文本右对齐逐字符比较：不变的字符原地不动，变化的字符淡入位移（增加自下而上、减少自上而下），
// 逐字错开 18ms、260ms。读屏读完整文本；减少动态时直接换字。
export function DiffNumber({ value, format = fmt, className }: { value: number; format?: (n: number) => string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const prev = useRef<{ text: string; value: number } | null>(null);
  const text = format(value);
  useEffect(() => {
    const el = ref.current;
    const old = prev.current;
    prev.current = { text, value };
    if (!el || !old || old.text === text || prefersReducedMotion() || !el.animate) return;
    const dir = value >= old.value ? 1 : -1;
    const chars = Array.from(el.querySelectorAll<HTMLSpanElement>("[data-ch]"));
    const pad = old.text.padStart(text.length, " ").slice(-text.length);
    chars.forEach((span, i) => {
      if (pad[i] === text[i]) return;
      span.animate([{ opacity: 0, transform: `translateY(${dir * 0.45}em)` }, { opacity: 1, transform: "none" }],
        { duration: 260, delay: Math.min(i, 6) * 18, easing: "cubic-bezier(0.23, 1, 0.32, 1)", fill: "backwards" });
    });
  }, [text, value]);
  return (
    <span ref={ref} className={`diffnum num${className ? ` ${className}` : ""}`}>
      <span className="sr-only">{text}</span>
      {Array.from(text).map((ch, i) => <span key={`${text.length}-${i}`} data-ch aria-hidden="true">{ch}</span>)}
    </span>
  );
}

// ---------- 抽屉 / 对话框 ----------
// 桌面：居中对话框；手机（≤820px）：底部抽屉，按住把手/标题下拉超过 80px 或快速下甩即关闭，否则回弹。
// 关闭先播放 180ms 退场再卸载；Esc 关闭；Tab 焦点困在抽屉内；关闭后焦点回到打开它的元素。
// 输入框获得焦点时滚进可视区，避免被软键盘挡住。
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Sheet({ title, onClose, children, footer, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const drag = useRef<{ y: number; t: number; dy: number; id: number } | null>(null);

  const close = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    if (prefersReducedMotion()) { onCloseRef.current(); return; }
    setClosing(true);
    window.setTimeout(() => onCloseRef.current(), 180);
  }, []);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current;
    node?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); close(); return; }
      if (e.key !== "Tab" || !node) return;
      const items = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === node)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    const onFocusIn = (e: FocusEvent) => {
      const t = e.target as HTMLElement;
      if (!/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      // 软键盘弹出要一点时间，等可视区变化后再把输入框滚到中间
      window.setTimeout(() => t.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" }), 280);
    };
    document.addEventListener("keydown", onKey);
    node?.addEventListener("focusin", onFocusIn);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      node?.removeEventListener("focusin", onFocusIn);
      document.body.style.overflow = overflow;
      previous?.focus?.();
    };
  }, [close]);

  const isSheet = () => typeof matchMedia !== "undefined" && matchMedia("(max-width: 820px)").matches;
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isSheet() || (e.target as HTMLElement).closest("button, a, input, select, textarea")) return;
    drag.current = { y: e.clientY, t: performance.now(), dy: 0, id: e.pointerId };
    e.currentTarget.setPointerCapture(e.pointerId);
    if (ref.current) ref.current.style.transition = "none";
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId || !ref.current) return;
    d.dy = Math.max(0, e.clientY - d.y);
    ref.current.style.transform = `translateY(${d.dy}px)`;
    if (backdrop.current) backdrop.current.style.opacity = String(Math.max(0.35, 1 - d.dy / 420));
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId || !ref.current) return;
    drag.current = null;
    const velocity = d.dy / Math.max(1, performance.now() - d.t);
    const sheet = ref.current;
    sheet.style.transition = "transform 220ms cubic-bezier(0.23, 1, 0.32, 1)";
    if (d.dy > 80 || (velocity > 0.6 && d.dy > 24)) {
      closingRef.current = true;
      sheet.style.transform = "translateY(100%)";
      if (backdrop.current) backdrop.current.style.opacity = "0";
      window.setTimeout(() => onCloseRef.current(), 200);
    } else {
      sheet.style.transform = "";
      if (backdrop.current) backdrop.current.style.opacity = "";
    }
  };

  return (
    <div ref={backdrop} className={`sheet-backdrop${closing ? " is-closing" : ""}`} onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className={`sheet${closing ? " is-closing" : ""}`} role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : undefined} tabIndex={-1} ref={ref} style={wide ? { width: "min(920px, 100%)" } : undefined}>
        <div className="sheet-head" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
          <span className="sheet-grip" aria-hidden="true" />
          <h3 style={{ flex: 1 }}>{title}</h3>
          <button className="btn btn-ghost btn-sm" onClick={close} aria-label="关闭"><Icon name="x" /></button>
        </div>
        <div className="sheet-body">{children}</div>
        {footer ? <div className="sheet-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

// ---------- 骨架屏（懒加载页面占位；减少动态时不闪烁） ----------
export function PageSkeleton() {
  return (
    <div className="skel-page" aria-busy="true" aria-label="载入中">
      <div className="skel skel-title" />
      <div className="skel skel-line" style={{ width: "42%" }} />
      <div className="skel-grid">{Array.from({ length: 6 }, (_, i) => <div key={i} className="skel skel-card" />)}</div>
    </div>
  );
}

// ---------- 提示条（可带撤销） ----------
type ToastItem = { id: number; text: string; leaving?: boolean; action?: { label: string; run: () => void } };
let toasts: ToastItem[] = [];
const toastListeners = new Set<() => void>();
let toastSeq = 0;
export function toast(text: string, action?: ToastItem["action"]) {
  const id = ++toastSeq;
  // 最多同时 3 条，最旧的先让位
  toasts = [...toasts.slice(-2), { id, text, action }];
  toastListeners.forEach((l) => l());
  setTimeout(() => dismissToast(id), action ? 6000 : 3200);
}
function dismissToast(id: number) {
  if (!toasts.some((t) => t.id === id && !t.leaving)) return;
  toasts = toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t));
  toastListeners.forEach((l) => l());
  setTimeout(() => { toasts = toasts.filter((t) => t.id !== id); toastListeners.forEach((l) => l()); }, prefersReducedMotion() ? 0 : 160);
}
export function ToastHost() {
  const items = useSyncExternalStore((l) => { toastListeners.add(l); return () => toastListeners.delete(l); }, () => toasts);
  return (
    <div className="toast-host" role="status" aria-live="polite">
      {items.map((t) => (
        <div className={`toast${t.leaving ? " is-leaving" : ""}`} key={t.id}>
          <span>{t.text}</span>
          {t.action ? <button onClick={() => { t.action!.run(); dismissToast(t.id); }}>{t.action.label}</button> : null}
        </div>
      ))}
    </div>
  );
}

// ---------- 哈希路由：#/inventory 、#/pattern/ID 、#/add?mode=generate ----------
export type Route = { path: string; parts: string[]; query: URLSearchParams };
function readRoute(): Route {
  const raw = (typeof location === "undefined" ? "" : location.hash).replace(/^#/, "") || "/";
  const [path, search = ""] = raw.split("?");
  return { path, parts: path.split("/").filter(Boolean), query: new URLSearchParams(search) };
}
let currentRoute = readRoute();
const routeListeners = new Set<() => void>();
if (typeof window !== "undefined") {
  window.addEventListener("hashchange", () => { currentRoute = readRoute(); routeListeners.forEach((l) => l()); window.scrollTo(0, 0); });
}
export function useRoute(): Route {
  return useSyncExternalStore((l) => { routeListeners.add(l); return () => routeListeners.delete(l); }, () => currentRoute);
}
export function navigate(to: string) {
  location.hash = to.startsWith("#") ? to : `#${to}`;
}

export function fmt(n: number): string {
  return Math.round(n).toLocaleString("zh-CN");
}
export function fmtTime(ms: number): string {
  if (!ms) return "—";
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hm = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  return sameDay ? `今天 ${hm}` : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

/** 本地图片（IndexedDB blob）→ object URL */
export function useBlobUrl(id: string | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let off: (() => void) | null = null;
    if (!id) { setUrl(null); return; }
    import("../lib/db").then(async ({ blobUrl, onBlobAdded }) => {
      const first = await blobUrl(id);
      if (alive) setUrl(first);
      if (!alive) return;
      off = onBlobAdded(async (added) => { if (added === id && alive) setUrl(await blobUrl(id)); });
    });
    return () => { alive = false; off?.(); };
  }, [id]);
  return url;
}
