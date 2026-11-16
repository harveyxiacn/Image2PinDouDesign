// 作品集：做完的作品，新的在前；可按年份 / 月份 / 标签筛选，点开回到图纸。
import { useMemo, useState } from "react";
import { useData } from "../lib/db";
import { collectWorks, durationLabel, filterOptions, filterWorks, groupByMonth, workTotals, type WorkItem } from "../lib/worklog";
import { Icon, fmt, useBlobUrl } from "../components/ui";
import "./Works.css";

function Cover({ item }: { item: WorkItem }) {
  const photo = useBlobUrl(item.photoId, "thumb");
  const fallback = useBlobUrl(item.photoId ? undefined : item.fallbackId, "thumb");
  const url = photo ?? fallback;
  return (
    <div className={`wk-cover${item.photoId && photo ? " photo" : ""}`}>
      {url ? <img src={url} alt="" loading="lazy" /> : <span className="meta">{item.photoId || item.fallbackId ? "图片同步中…" : "没有图片"}</span>}
    </div>
  );
}

function dateLabel(item: WorkItem): string {
  const d = new Date(item.at);
  return `${item.estimated ? "约 " : ""}${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
}

export default function Works() {
  const { patterns, txns } = useData();
  const [year, setYear] = useState<number | undefined>();
  const [month, setMonth] = useState<number | undefined>();
  const [tag, setTag] = useState<string | undefined>();
  const all = useMemo(() => collectWorks(patterns, txns), [patterns, txns]);
  const totals = useMemo(() => workTotals(all, Date.now()), [all]);
  const options = useMemo(() => filterOptions(all, year), [all, year]);
  const shown = useMemo(() => filterWorks(all, { year, month: year != null ? month : undefined, tag }), [all, year, month, tag]);
  const groups = useMemo(() => groupByMonth(shown), [shown]);
  const filtered = year != null || tag != null;

  return (
    <div className="wk" data-works-page>
      <div className="page-head">
        <div><h1>作品集</h1><p>做完的作品都在这里。在图纸详情里标记完成时，可以顺手加照片和备注。</p></div>
      </div>

      <section className="wk-totals" aria-label="汇总" data-works-totals>
        <div className="panel panel-pad"><span className="meta">作品</span><b className="num" data-works-total-pieces>{fmt(totals.pieces)}</b><span className="meta">件</span></div>
        <div className="panel panel-pad"><span className="meta">用掉豆子</span><b className="num" data-works-total-beads>{fmt(totals.beads)}</b><span className="meta">颗</span></div>
        <div className="panel panel-pad"><span className="meta">今年</span><b className="num" data-works-total-year>{fmt(totals.thisYear)}</b><span className="meta">件{totals.thisYear ? ` · ${fmt(totals.thisYearBeads)} 颗` : ""}</span></div>
      </section>

      {!all.length ? (
        <section className="panel empty pegboard" data-works-empty>
          <h3>还没有作品</h3>
          <p>把图纸标为“已完成”，它就会出现在这里。</p>
          <a className="btn" href="#/gallery"><Icon name="gallery" />去图库</a>
        </section>
      ) : (
        <>
          <div className="wk-filters" role="group" aria-label="筛选作品">
            <label className="field"><span>年份</span>
              <select className="select" data-works-filter-year value={year ?? ""} onChange={(e) => { setYear(e.target.value ? Number(e.target.value) : undefined); setMonth(undefined); }}>
                <option value="">全部年份</option>
                {options.years.map((y) => <option key={y} value={y}>{y} 年</option>)}
              </select>
            </label>
            <label className="field"><span>月份</span>
              <select className="select" data-works-filter-month value={year != null ? month ?? "" : ""} disabled={year == null} onChange={(e) => setMonth(e.target.value ? Number(e.target.value) : undefined)}>
                <option value="">{year == null ? "先选年份" : "全年"}</option>
                {options.months.slice().sort((a, b) => a - b).map((m) => <option key={m} value={m}>{m} 月</option>)}
              </select>
            </label>
            <label className="field"><span>标签</span>
              <select className="select" data-works-filter-tag value={tag ?? ""} onChange={(e) => setTag(e.target.value || undefined)}>
                <option value="">全部标签</option>
                {options.tags.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
            {filtered ? <button className="btn btn-sm btn-ghost wk-clear" data-works-clear onClick={() => { setYear(undefined); setMonth(undefined); setTag(undefined); }}>清除筛选</button> : null}
          </div>
          {filtered ? <p className="meta" role="status">筛出 {fmt(shown.length)} 件，共 {fmt(shown.reduce((s, i) => s + i.beads, 0))} 颗</p> : null}

          {!shown.length ? <section className="panel empty"><h3>没有符合的作品</h3><p>换个年份或标签看看。</p></section> : groups.map((g) => (
            <section key={g.key} className="wk-group" aria-label={`${g.year} 年 ${g.month} 月`} data-works-group={g.key}>
              <h2 className="wk-month">{g.year} 年 {g.month} 月 <span className="meta">{g.items.length} 件 · {fmt(g.beads)} 颗</span></h2>
              <ul className="wk-grid">
                {g.items.map((it) => (
                  <li key={it.key}>
                    <a className="wk-card" href={`#/pattern/${it.patternId}`} data-work-card data-pattern-id={it.patternId}>
                      <Cover item={it} />
                      <span className="wk-name">{it.name}</span>
                      <span className="meta" title={it.estimated ? "没有记完成日期，按扣库存的时间估的" : undefined}>{dateLabel(it)}</span>
                      <span className="meta">{it.width && it.height ? `${it.width}×${it.height} · ` : ""}{fmt(it.beads)} 颗{it.copies > 1 ? ` · ${it.copies} 份` : ""}</span>
                      {it.rating || it.tag || it.durationMs ? (
                        <span className="meta wk-extra">{it.rating ? <span className="wk-rating" aria-label={`${it.rating} 星`}>{"★".repeat(it.rating)}</span> : null}{it.tag ? ` ${it.tag}` : ""}{it.durationMs ? ` · ${durationLabel(it.durationMs)}` : ""}</span>
                      ) : null}
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </>
      )}
    </div>
  );
}
