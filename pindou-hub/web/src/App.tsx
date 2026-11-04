import { lazy, Suspense, useEffect, useRef } from "react";
import { Icon, PageSkeleton, ToastHost, useRoute } from "./components/ui";
import { useData } from "./lib/db";
import { useSyncState } from "./lib/sync";
import { isActive } from "./lib/inventory";

const Dashboard = lazy(() => import("./pages/Dashboard"));
const AddPattern = lazy(() => import("./pages/AddPattern"));
const Gallery = lazy(() => import("./pages/Gallery"));
const PatternDetail = lazy(() => import("./pages/PatternDetail"));
const Inventory = lazy(() => import("./pages/Inventory"));
const Shopping = lazy(() => import("./pages/Shopping"));
const History = lazy(() => import("./pages/History"));
const Settings = lazy(() => import("./pages/Settings"));

type NavItem = { href: string; label: string; icon: string; match: (p: string) => boolean };
const NAV: NavItem[] = [
  { href: "#/", label: "总览", icon: "home", match: (p) => p === "/" || p === "" },
  { href: "#/gallery", label: "图库", icon: "gallery", match: (p) => p.startsWith("/gallery") || p.startsWith("/pattern") },
  { href: "#/inventory", label: "豆盒库存", icon: "box", match: (p) => p.startsWith("/inventory") },
  { href: "#/shopping", label: "采购清单", icon: "cart", match: (p) => p.startsWith("/shopping") },
  { href: "#/history", label: "记录", icon: "history", match: (p) => p.startsWith("/history") },
  { href: "#/settings", label: "同步与设置", icon: "sync", match: (p) => p.startsWith("/settings") }
];

function Page() {
  const route = useRoute();
  const [head, id] = route.parts;
  switch (head) {
    case undefined: return <Dashboard />;
    case "add": return <AddPattern />;
    case "gallery": return <Gallery />;
    case "pattern": return <PatternDetail id={id ?? ""} />;
    case "inventory": return <Inventory />;
    case "shopping": return <Shopping />;
    case "history": return <History />;
    case "settings": return <Settings />;
    default: return <Dashboard />;
  }
}

const TITLES: Record<string, string> = {
  "": "总览", add: "添加图纸", gallery: "图库", pattern: "图纸详情", inventory: "豆盒库存",
  shopping: "采购清单", history: "记录", settings: "同步与设置"
};

/** 路由切换：更新标签页标题，并把焦点移到新页面的 h1（键盘/读屏用户知道已到新页面）。首次载入不抢焦点。 */
function useRouteFocus(path: string, head: string | undefined) {
  const first = useRef(true);
  useEffect(() => {
    document.title = `${TITLES[head ?? ""] ?? "拼豆仓"} · 拼豆仓`;
    if (first.current) { first.current = false; return; }
    let tries = 0;
    const focusHeading = () => {
      const h1 = document.querySelector<HTMLElement>("#main h1");
      if (h1) { h1.tabIndex = -1; h1.focus({ preventScroll: true }); return; }
      if (tries++ < 20) window.setTimeout(focusHeading, 50); // 懒加载页面还没渲染完
    };
    focusHeading();
  }, [path, head]);
}

function SyncBadge() {
  const sync = useSyncState();
  const label = sync.phase === "unpaired" ? "仅本机" : sync.phase === "syncing" ? "同步中" : sync.phase === "error" ? "同步失败" : sync.phase === "offline" ? "离线" : "已同步";
  return (
    <a className="nav-link" href="#/settings" title={sync.message} style={{ height: "auto", minHeight: 40, padding: "6px 10px" }}>
      <span className={`sync-dot ${sync.phase}`} />
      <span style={{ display: "flex", flexDirection: "column", minWidth: 0, lineHeight: 1.25 }}>
        <span style={{ whiteSpace: "nowrap" }}>{label}</span>
        {sync.hubName ? <span className="meta" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sync.hubName}</span> : null}
      </span>
    </a>
  );
}

export default function App() {
  const route = useRoute();
  const data = useData();
  const planned = data.patterns.filter(isActive).length;
  const path = route.path;
  useRouteFocus(path, route.parts[0]);
  return (
    <div className="shell">
      <a className="skip-link" href="#main" onClick={(e) => { e.preventDefault(); document.getElementById("main")?.focus(); }}>跳到主要内容</a>
      <nav className="rail" aria-label="主导航">
        <div className="brand">
          <svg width="28" height="28" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="14" fill="var(--ink)" /><circle cx="32" cy="32" r="20" fill="var(--iron)" /><circle cx="32" cy="32" r="8" fill="var(--ink)" /></svg>
          <div>拼豆仓<small>图纸 · 豆盒 · 采购</small></div>
        </div>
        <a className="btn btn-iron rail-add" href="#/add"><Icon name="plus" />添加图纸</a>
        {NAV.map((item) => (
          <a key={item.href} className="nav-link" href={item.href} aria-current={item.match(path) ? "page" : undefined}>
            <Icon name={item.icon} />
            <span>{item.label}</span>
            {item.href === "#/gallery" && planned ? <span className="count num">{planned} 计划</span> : null}
          </a>
        ))}
        <div className="rail-foot"><SyncBadge /></div>
      </nav>

      <main className="main" id="main" tabIndex={-1} style={{ outline: "none" }}>
        {data.ready ? (
          <Suspense fallback={<PageSkeleton />}>
            <div className="page-enter" key={route.parts[0] ?? "home"}><Page /></div>
          </Suspense>
        ) : <PageSkeleton />}
      </main>

      <nav className="tabbar" aria-label="主导航">
        <a href="#/" aria-current={NAV[0].match(path) ? "page" : undefined}><Icon name="home" />总览</a>
        <a href="#/gallery" aria-current={NAV[1].match(path) ? "page" : undefined}><Icon name="gallery" />图库</a>
        <a href="#/add" className="tab-add" aria-label="添加图纸"><span className="plus"><Icon name="plus" /></span></a>
        <a href="#/inventory" aria-current={NAV[2].match(path) ? "page" : undefined}><Icon name="box" />库存</a>
        <a href="#/shopping" aria-current={NAV[3].match(path) ? "page" : undefined}><Icon name="cart" />采购</a>
      </nav>
      <ToastHost />
    </div>
  );
}
