// 焦点元素：图纸卡片网格——缩略图 + 库存可做程度，一眼看出哪张现在就能动手。
// 另有：按标签分组、多选批量操作（长按 / 勾选 / 空格 / Shift 连选）、?tag= 深链。
import { useEffect, useMemo, useRef, useState } from "react";
import { useData } from "../lib/db";
import { stockByCode } from "../lib/inventory";
import { STATUS_LABEL, totalOf, type ImageMeta, type Pattern, type PatternStatus } from "../lib/model";
import { Icon, Sheet, fmt, fmtTime, navigate, useBlobUrl, useRoute } from "../components/ui";
import { collectionsByTag, rangeIds } from "../lib/stockview";
import { bulkAddTag, bulkDelete, bulkSetStatus, bulkSetVerified } from "../components/stock/patternActions";
import { useFlip } from "../components/stock/useFlip";
import PatternCard from "../components/pattern/PatternCard";
import "../components/pattern/pattern.css";
import "./Gallery.css";

type Sort = "updated" | "total";
type VerifyFilter = "all" | "unverified" | "verified";

function verifyFilterOf(value: string | null): VerifyFilter {
  return value === "unverified" || value === "verified" ? value : "all";
}

function ImageTile({ img, patternId }: { img: ImageMeta; patternId?: string }) {
  const url = useBlobUrl(img.id);
  return (
    <div className="panel ga-tile">
      <div className={`pt-thumb${url ? "" : " ph pegboard"}`}>{url ? <img src={url} alt={img.name} loading="lazy" /> : <span>图片同步中…</span>}</div>
      <div className="row" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
        <div><div className="pt-card-title">{img.name}</div><div className="meta">{fmtTime(img.createdAt)} · {img.width}×{img.height}</div></div>
        <div className="row">
          {patternId ? <a className="btn btn-sm" href={`#/pattern/${patternId}`}>打开图纸</a> : null}
          <a className="btn btn-sm" href={`#/add?mode=recognize&image=${img.id}`}>识别</a>
          <a className="btn btn-sm" href={`#/add?mode=generate&image=${img.id}`}>生成</a>
        </div>
      </div>
    </div>
  );
}

const LONG_PRESS_MS = 480;

type ItemProps = {
  p: Pattern; stock: Record<string, number>; inventoryReady: boolean; flipKey: string; selecting: boolean; checked: boolean;
  onToggle: (id: string, shift: boolean) => void; onLongPress: (id: string) => void;
};

function GalleryItem({ p, stock, inventoryReady, flipKey, selecting, checked, onToggle, onLongPress }: ItemProps) {
  const timer = useRef<number | undefined>(undefined);
  const start = useRef<{ x: number; y: number } | null>(null);
  const suppress = useRef(false);
  const cancel = () => { window.clearTimeout(timer.current); start.current = null; };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <div className={`ga-item${checked ? " is-selected" : ""}${selecting ? " is-selecting" : ""}`} data-flip={flipKey}
      onPointerDown={(e) => {
        if (e.pointerType === "mouse" || selecting || (e.target as HTMLElement).closest(".ga-check")) return;
        start.current = { x: e.clientX, y: e.clientY };
        timer.current = window.setTimeout(() => { suppress.current = true; start.current = null; navigator.vibrate?.(12); onLongPress(p.id); }, LONG_PRESS_MS);
      }}
      onPointerMove={(e) => { const s = start.current; if (s && Math.hypot(e.clientX - s.x, e.clientY - s.y) > 8) cancel(); }}
      onPointerUp={cancel} onPointerCancel={cancel} onPointerLeave={cancel}
      onContextMenu={(e) => { if (suppress.current || start.current) e.preventDefault(); }}
      onClickCapture={(e) => {
        if (suppress.current) { suppress.current = false; e.preventDefault(); e.stopPropagation(); return; }
        if (!selecting || (e.target as HTMLElement).closest(".ga-check")) return;
        e.preventDefault(); e.stopPropagation();
        onToggle(p.id, e.shiftKey);
      }}
      onKeyDown={(e) => {
        if (selecting && e.key === " " && (e.target as HTMLElement).closest("a.pt-card")) { e.preventDefault(); onToggle(p.id, e.shiftKey); }
      }}>
      <PatternCard pattern={p} stock={stock} inventoryReady={inventoryReady} />
      <label className="ga-check" title={checked ? "取消选择" : "选择这张"}>
        <input type="checkbox" checked={checked} onChange={() => undefined} onClick={(e) => onToggle(p.id, e.shiftKey)} />
        <span className="sr-only">选择 {p.name}</span>
      </label>
    </div>
  );
}

export default function Gallery() {
  const route = useRoute();
  const data = useData();
  const tab = route.query.get("tab") === "images" ? "images" : "patterns";
  const [status, setStatus] = useState<PatternStatus | "all">(() => {
    const s = route.query.get("status");
    return s === "idea" || s === "planned" || s === "making" || s === "done" ? s : "all";
  });
  const [verify, setVerify] = useState<VerifyFilter>(() => verifyFilterOf(route.query.get("verify")));
  const [tag, setTag] = useState(route.query.get("tag") ?? "");
  const [view, setView] = useState<"grid" | "tag">(route.query.get("group") === "tag" ? "tag" : "grid");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<Sort>("updated");
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [tagSheet, setTagSheet] = useState(false);
  const [say, setSay] = useState("");
  const anchor = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const stock = useMemo(() => stockByCode(data.txns), [data.txns]);
  const inventoryReady = !!data.prefs.inventoryStartedAt || data.txns.some((t) => !t.deleted);

  // 外部深链（总览的合集卡片）变化时同步筛选
  const qs = route.query.toString();
  useEffect(() => {
    setTag(route.query.get("tag") ?? "");
    setVerify(verifyFilterOf(route.query.get("verify")));
    setView(route.query.get("group") === "tag" ? "tag" : "grid");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qs]);
  const remember = (nextTag: string, nextView: "grid" | "tag") => {
    const sp = new URLSearchParams();
    if (nextTag) sp.set("tag", nextTag);
    if (nextView === "tag") sp.set("group", "tag");
    try { history.replaceState(null, "", `#/gallery${sp.toString() ? `?${sp}` : ""}`); } catch { /* 沙箱 */ }
  };
  const changeTag = (t: string) => { setTag(t); remember(t, view); };
  const changeView = (v: "grid" | "tag") => { setView(v); remember(tag, v); };

  const tags = useMemo(() => Array.from(new Set(data.patterns.filter((p) => !p.deleted).flatMap((p) => p.tags))).sort(), [data.patterns]);
  const unverifiedCount = useMemo(() => data.patterns.filter((p) => !p.deleted && p.verifiedAt == null).length, [data.patterns]);
  const patterns = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return data.patterns
      .filter((p) => (status === "all" || p.status === status) && (!tag || p.tags.includes(tag)) && (!needle || p.name.toLowerCase().includes(needle) || p.tags.some((t) => t.toLowerCase().includes(needle))))
      .filter((p) => verify === "all" || (verify === "unverified" ? p.verifiedAt == null : p.verifiedAt != null))
      .sort((a, b) => (sort === "total" ? totalOf(b.counts) - totalOf(a.counts) : b.updatedAt - a.updatedAt));
  }, [data.patterns, status, tag, q, sort, verify]);
  const sections = useMemo(() => {
    if (view !== "tag") return [];
    const byId = new Map(patterns.map((p, i) => [p.id, i]));
    return collectionsByTag(patterns, stock, true)
      .filter((c) => !tag || c.tag === tag)
      .map((c) => ({ ...c, patterns: [...c.patterns].sort((a, b) => (byId.get(a.id) ?? 0) - (byId.get(b.id) ?? 0)) }));
  }, [view, patterns, stock, tag]);
  const order = useMemo(() => patterns.map((p) => p.id), [patterns]);
  const images = useMemo(() => data.images.filter((i) => i.role === "source"), [data.images]);
  const patternByImage = useMemo(() => new Map(data.patterns.filter((p) => p.imageId).map((p) => [p.imageId!, p.id])), [data.patterns]);

  // 已选里去掉不存在 / 不可见的
  const visible = useMemo(() => new Set(order), [order]);
  const chosen = useMemo(() => [...selected].filter((id) => visible.has(id)), [selected, visible]);
  const selecting = selectMode || chosen.length > 0;
  useFlip(listRef, `${view}|${sections.map((c) => `${c.tag}:${c.patterns.length}`).join(",")}|${order.join(",")}`);

  const exitSelect = () => { setSelectMode(false); setSelected(new Set()); anchor.current = null; };
  useEffect(() => {
    if (!selecting || tagSheet) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { exitSelect(); setSay("已退出多选"); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selecting, tagSheet]);

  const toggle = (id: string, shift: boolean) => {
    const next = new Set(selected);
    const from = anchor.current;
    if (shift && from && from !== id) for (const x of rangeIds(order, from, id)) next.add(x);
    else if (next.has(id)) next.delete(id); else next.add(id);
    anchor.current = id;
    setSelected(next);
    setSay(`已选 ${next.size} 张`);
  };
  const longPress = (id: string) => { setSelectMode(true); setSelected((cur) => new Set(cur).add(id)); anchor.current = id; setSay("已进入多选，已选 1 张"); };
  const selectAll = (ids: string[]) => { setSelected(new Set(ids)); setSay(`已选 ${ids.length} 张`); };

  const run = async (job: () => Promise<string>) => { const m = await job(); setSay(m); exitSelect(); };

  const itemProps = (p: Pattern, flipKey: string): ItemProps => ({ p, stock, inventoryReady, flipKey, selecting, checked: selected.has(p.id), onToggle: toggle, onLongPress: longPress });

  return (
    <div>
      <div className="page-head">
        <div><h1>图库</h1><p>{data.patterns.length} 张图纸 · {unverifiedCount} 张未核对 · {images.length} 张图片</p></div>
        <div className="row">
          <div className="seg" role="group" aria-label="图库分类">
            <button aria-pressed={tab === "patterns"} onClick={() => navigate("/gallery")}>图纸</button>
            <button aria-pressed={tab === "images"} onClick={() => navigate("/gallery?tab=images")}>图片</button>
          </div>
          <a className="btn btn-iron" href="#/add"><Icon name="plus" />添加</a>
        </div>
      </div>
      <div className="sr-only" role="status" aria-live="polite">{say}</div>

      {!inventoryReady && data.patterns.length ? (
        <div className="notice" role="note">
          <span><b>库存还没录入</b>，卡片显示「库存未录入」，不是缺货。</span>
          <span className="spacer" />
          <a className="btn btn-sm" href="#/inventory">去录入现有豆子</a>
        </div>
      ) : null}

      {tab === "patterns" ? (
        data.patterns.length === 0 ? (
          <div className="empty pegboard ga-empty">
            <h3>图库还是空的</h3>
            <p>上传一张拼豆图纸，豆探会读出每个色号的用量；或者用照片生成一张。</p>
            <div className="row" style={{ justifyContent: "center" }}>
              <a className="btn btn-iron" href="#/add?mode=recognize"><Icon name="scan" />识别图纸</a>
              <a className="btn" href="#/add?mode=generate"><Icon name="wand" />生成图纸</a>
            </div>
          </div>
        ) : (
          <>
            <div className="ga-filters">
              <input className="input" type="search" placeholder="搜索名称或标签" value={q} onChange={(e) => setQ(e.target.value)} aria-label="搜索" />
              <select className="select" value={status} onChange={(e) => setStatus(e.target.value as PatternStatus | "all")} aria-label="状态">
                <option value="all">全部状态</option>
                {(Object.keys(STATUS_LABEL) as PatternStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
              </select>
              <select className="select" value={verify} onChange={(e) => setVerify(e.target.value as VerifyFilter)} aria-label="核对状态">
                <option value="all">全部核对状态</option>
                <option value="unverified">未核对 {unverifiedCount}</option>
                <option value="verified">已核对</option>
              </select>
              {tags.length ? (
                <select className="select" value={tag} onChange={(e) => changeTag(e.target.value)} aria-label="标签">
                  <option value="">全部标签</option>
                  {tags.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              ) : null}
              <select className="select" value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="排序">
                <option value="updated">最近更新</option>
                <option value="total">用豆最多</option>
              </select>
              <div className="seg" role="group" aria-label="显示方式">
                <button aria-pressed={view === "grid"} onClick={() => changeView("grid")}>全部</button>
                <button aria-pressed={view === "tag"} onClick={() => changeView("tag")}>按标签分组</button>
              </div>
              <button className="btn" aria-pressed={selecting} onClick={() => (selecting ? exitSelect() : setSelectMode(true))}><Icon name="check" />{selecting ? "完成选择" : "选择"}</button>
            </div>
            {selecting ? <p className="meta ga-hint">点卡片或勾选框选择；空格切换、Shift+点击连选、Esc 退出。触屏长按卡片也能进入多选。</p> : null}
            {patterns.length ? (
              <div ref={listRef} className={selecting ? "ga-selecting" : undefined}>
                {view === "tag" ? sections.map((c) => (
                  <section key={c.tag || "__none"} className="ga-sec" aria-labelledby={`ga-h-${c.tag || "none"}`}>
                    <div className="ga-sec-head">
                      <h2 id={`ga-h-${c.tag || "none"}`}>{c.tag || "未分组"}</h2>
                      <span className="meta">{c.count} 张 · 共 {fmt(c.totalBeads)} 颗{!inventoryReady ? " · 库存未录入" : c.missingColors ? ` · 缺 ${c.missingColors} 色` : ""}</span>
                      <span className="spacer" />
                      {selecting ? <button className="btn btn-sm btn-ghost" onClick={() => selectAll([...new Set([...chosen, ...c.patterns.map((p) => p.id)])])}>选择本组</button> : null}
                    </div>
                    <div className="ga-grid">{c.patterns.map((p) => <GalleryItem key={p.id} {...itemProps(p, `${c.tag}:${p.id}`)} />)}</div>
                  </section>
                )) : <div className="ga-grid">{patterns.map((p) => <GalleryItem key={p.id} {...itemProps(p, p.id)} />)}</div>}
              </div>
            ) : <div className="empty"><h3>没有符合条件的图纸</h3><button className="btn btn-sm" onClick={() => { setQ(""); setStatus("all"); setVerify("all"); changeTag(""); }}>清除筛选</button></div>}
          </>
        )
      ) : images.length ? (
        <div className="ga-grid">{images.map((img) => <ImageTile key={img.id} img={img} patternId={patternByImage.get(img.id)} />)}</div>
      ) : (
        <div className="empty pegboard ga-empty"><h3>还没有保存过图片</h3><p>保存图纸时会同时保留原图，之后可以在这里重新识别或生成。</p></div>
      )}

      {selecting && tab === "patterns" ? (
        <div className="ga-bulk" role="region" aria-label="批量操作">
          <span className="ga-bulk-n"><b className="num">{chosen.length}</b> 张已选</span>
          <button className="btn btn-sm" onClick={() => selectAll(chosen.length === order.length ? [] : order)}>{chosen.length === order.length ? "全不选" : "全选"}</button>
          <span className="spacer" />
          <button className="btn btn-sm btn-ghost" onClick={() => { exitSelect(); setSay("已退出多选"); }} aria-label="退出多选"><Icon name="x" /></button>
          <div className="ga-bulk-acts">
          <button className="btn btn-sm" disabled={!chosen.length} onClick={() => void run(() => bulkSetVerified(chosen))}>标记已核对</button>
          <button className="btn btn-sm" disabled={!chosen.length} onClick={() => void run(() => bulkSetStatus(chosen, "planned"))}>设为计划拼</button>
          <button className="btn btn-sm" disabled={!chosen.length} onClick={() => void run(() => bulkSetStatus(chosen, "idea"))}>设为收藏</button>
          <button className="btn btn-sm" disabled={!chosen.length} onClick={() => setTagSheet(true)}>加标签</button>
          <button className="btn btn-sm ga-del" disabled={!chosen.length} onClick={() => void run(() => bulkDelete(chosen))}><Icon name="trash" />删除</button>
          </div>
        </div>
      ) : null}
      {tagSheet ? <TagSheet tags={tags} count={chosen.length} onClose={() => setTagSheet(false)} onApply={(t) => { setTagSheet(false); void run(() => bulkAddTag(chosen, t)); }} /> : null}
    </div>
  );
}

function TagSheet({ tags, count, onClose, onApply }: { tags: string[]; count: number; onClose: () => void; onApply: (tag: string) => void }) {
  const [text, setText] = useState("");
  return (
    <Sheet title={`给 ${count} 张图纸加标签`} onClose={onClose} footer={
      <><button className="btn" onClick={onClose}>取消</button><button className="btn btn-iron" disabled={!text.trim()} onClick={() => onApply(text)}>加上「{text.trim() || "…"}」</button></>
    }>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); if (text.trim()) onApply(text); }}>
        <label className="field"><span>标签名（如 游戏王、高达）</span><input className="input" autoFocus value={text} onChange={(e) => setText(e.target.value)} maxLength={20} /></label>
        {tags.length ? (
          <div><span className="label">已有标签</span>
            <div className="row" style={{ marginTop: 8 }}>{tags.map((t) => <button type="button" key={t} className="chip ga-tagpick" aria-pressed={text === t} onClick={() => setText(t)}>{t}</button>)}</div>
          </div>
        ) : null}
      </form>
    </Sheet>
  );
}
