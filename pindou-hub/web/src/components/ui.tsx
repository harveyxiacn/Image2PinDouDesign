// 共用界面原语：图标、豆子色块、抽屉/弹层、提示条、哈希路由。各页面只用这些 + styles.css 中的类。
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
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

// ---------- 抽屉 / 对话框 ----------
export function Sheet({ title, onClose, children, footer, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = overflow; previous?.focus?.(); };
  }, [onClose]);
  return (
    <div className="sheet-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet" role="dialog" aria-modal="true" tabIndex={-1} ref={ref} style={wide ? { width: "min(920px, 100%)" } : undefined}>
        <div className="sheet-head">
          <h3 style={{ flex: 1 }}>{title}</h3>
          <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="关闭"><Icon name="x" /></button>
        </div>
        <div className="sheet-body">{children}</div>
        {footer ? <div className="sheet-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

// ---------- 提示条（可带撤销） ----------
type ToastItem = { id: number; text: string; action?: { label: string; run: () => void } };
let toasts: ToastItem[] = [];
const toastListeners = new Set<() => void>();
let toastSeq = 0;
export function toast(text: string, action?: ToastItem["action"]) {
  const id = ++toastSeq;
  toasts = [...toasts, { id, text, action }];
  toastListeners.forEach((l) => l());
  setTimeout(() => { toasts = toasts.filter((t) => t.id !== id); toastListeners.forEach((l) => l()); }, action ? 6000 : 3200);
}
export function ToastHost() {
  const items = useSyncExternalStore((l) => { toastListeners.add(l); return () => toastListeners.delete(l); }, () => toasts);
  return (
    <div className="toast-host" role="status" aria-live="polite">
      {items.map((t) => (
        <div className="toast" key={t.id}>
          <span>{t.text}</span>
          {t.action ? <button onClick={() => { t.action!.run(); toasts = toasts.filter((x) => x.id !== t.id); toastListeners.forEach((l) => l()); }}>{t.action.label}</button> : null}
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
