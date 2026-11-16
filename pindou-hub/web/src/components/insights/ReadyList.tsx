// 现在能拼什么：每张计划图纸对照完整库存的备豆进度。
import { useMemo, useState } from "react";
import { Bead, Icon, fmt } from "../ui";
import { substitutes, type ReadyRow } from "../../lib/insights";
import type { Counts } from "../../lib/model";

const SHOW = 10;

export function ReadyList({ rows, stock }: { rows: ReadyRow[]; stock: Counts }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, SHOW);
  return (
    <div>
      <ol className="ins-ready">
        {shown.map((r) => <ReadyItem key={r.id} row={r} stock={stock} />)}
      </ol>
      {rows.length > SHOW ? (
        <div className="ins-more"><button type="button" className="btn btn-sm btn-ghost" aria-expanded={all} onClick={() => setAll(!all)}>{all ? "收起" : `显示全部 ${rows.length} 张`}</button></div>
      ) : null}
      <p className="meta ins-note">各图单独对照当前库存计算，不叠加占用；用量已含损耗与份数。</p>
    </div>
  );
}

function ReadyItem({ row: r, stock }: { row: ReadyRow; stock: Counts }) {
  const pct = Math.round(r.coverage * 100);
  const near = r.missing.length > 0 && r.missing.length <= 5;
  const subs = useMemo(() => (near ? r.missing.map((m) => ({ m, s: substitutes(m.code, stock, { need: m.gap, limit: 1 })[0] })) : []), [near, r, stock]);
  return (
    <li className="ins-ready-item">
      <a className="ins-ready-link pressable" href={`#/pattern/${r.id}`} aria-label={`${r.name}，${r.complete ? "豆子已齐" : `备豆 ${pct}%，只差 ${r.missingColors} 色 ${fmt(r.missingBeads)} 颗`}`}>
        <span className="ins-ready-name">{r.name}{r.copies > 1 ? <span className="meta"> ×{r.copies}</span> : null}</span>
        {r.complete ? <span className="chip chip-leaf"><Icon name="check" size={12} />已齐</span> : <span className="ins-ready-state num">只差 {r.missingColors} 色 · {fmt(r.missingBeads)} 颗</span>}
        <span className={`meter ${r.complete ? "ok" : r.coverage > 0.8 ? "low" : "short"}`} aria-hidden="true"><i style={{ width: `${Math.min(100, r.coverage * 100)}%` }} /></span>
        <span className="ins-pct num" aria-hidden="true">{pct}%</span>
      </a>
      {near ? (
        <ul className="ins-miss">
          {subs.map(({ m, s }) => (
            <li key={m.code}>
              <Bead code={m.code} size={18} /><span className="code">{m.code}</span><span className="meta num">缺 {fmt(m.gap)}</span>
              {s ? <span className="ins-sub">可用 <Bead code={s.code} size={14} /><b className="code">{s.code}</b> 代替（{s.label}）</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}
