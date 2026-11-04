// 合集卡片：按标签汇总图纸——几张、共多少颗、整套做完还缺几色；一键整套加入计划（可撤销）。
import { useState } from "react";
import { Icon, fmt } from "../ui";
import { planCandidates, type Collection } from "../../lib/stockview";
import { bulkSetStatus } from "../stock/patternActions";
import "./Collections.css";

function CollectionCard({ c }: { c: Collection }) {
  const [busy, setBusy] = useState(false);
  const candidates = planCandidates(c.patterns);
  const allPlanned = c.plannedCount >= c.count;
  const cls = c.missingColors === 0 ? "ok" : c.coverage > 0.7 ? "low" : "short";
  const href = `#/gallery?tag=${encodeURIComponent(c.tag)}`;
  const plan = async () => {
    setBusy(true);
    try { await bulkSetStatus(candidates.map((p) => p.id), "planned", `「${c.tag}」`); } finally { setBusy(false); }
  };
  return (
    <article className="col-card" aria-label={`合集 ${c.tag}`}>
      <div className="col-head">
        <h4><a href={href}>{c.tag}</a></h4>
        <a className="meta col-link" href={href}>看图纸<Icon name="chevron" size={14} /></a>
      </div>
      <p className="col-stats">
        <span><b className="num">{c.count}</b> 张</span>
        <span>共 <b className="num">{fmt(c.totalBeads)}</b> 颗</span>
        {c.missingColors ? <span className="col-short">缺 <b className="num">{c.missingColors}</b> 色</span> : <span className="col-ok"><Icon name="check" size={13} />色号都够</span>}
      </p>
      <div className={`meter ${cls}`} role="img" aria-label={`库存覆盖 ${Math.round(c.coverage * 100)}%`}><i style={{ width: `${Math.round(c.coverage * 100)}%` }} /></div>
      <div className="col-actions">
        {candidates.length ? (
          <button className="btn btn-sm" disabled={busy} onClick={plan}>整套加入计划 · {candidates.length} 张</button>
        ) : <span className="chip chip-leaf">{allPlanned ? "整套都在计划里" : "没有可加入的图纸"}</span>}
        {c.missingColors ? <a className="btn btn-sm btn-ghost" href={`#/shopping?tag=${encodeURIComponent(c.tag)}`}>只买这套的豆</a> : null}
      </div>
    </article>
  );
}

export function Collections({ items, max = 6 }: { items: Collection[]; max?: number }) {
  if (!items.length) {
    return (
      <div className="empty pegboard" style={{ padding: 24 }}>
        <h3>还没有合集</h3>
        <p>给图纸加标签（如 游戏王、数码暴龙、高达），这里会按合集汇总用量和缺口。</p>
        <a className="btn btn-sm" href="#/gallery">去图库加标签</a>
      </div>
    );
  }
  return (
    <>
      <div className="col-list">{items.slice(0, max).map((c) => <CollectionCard key={c.tag} c={c} />)}</div>
      {items.length > max ? <p className="meta" style={{ padding: "0 16px 12px" }}><a href="#/gallery?group=tag">另有 {items.length - max} 个合集，到图库按标签分组查看</a></p> : null}
    </>
  );
}
