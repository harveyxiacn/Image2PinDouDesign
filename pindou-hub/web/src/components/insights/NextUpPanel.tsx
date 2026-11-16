// 下一张拼什么：在计划拼（其次收藏）的图纸里，按库存多的颜色推荐。只带用户去图纸详情，不改状态。
import { useEffect, useMemo, useRef, useState } from "react";
import { Bead, fmt, useRoute } from "../ui";
import { useData } from "../../lib/db";
import { NEXT_UP_RULE, canMakeTogether, type NextUpRow } from "../../lib/nextUp";
import { Thumb } from "../pattern/PatternCard";
import { InsightEmpty, InsightPanel } from "./Panel";
import { useNextUp } from "./NextUpData";
import "./NextUp.css";

const SHOW = 5;

export function NextUpChips({ row }: { row: NextUpRow }) {
  return (
    <ul className="nu-chips" aria-label="用到的库存多的颜色">
      {row.surplusTop.map((s) => (
        <li key={s.code} className="nu-chip" data-surplus-code={s.code}><Bead code={s.code} size={16} /><b className="code">{s.code}</b><span className="meta num">{fmt(s.beads)}</span></li>
      ))}
      {row.pushLow.slice(0, 3).map((l) => (
        <li key={l.code} className="nu-chip nu-chip-low" data-low-code={l.code}><Bead code={l.code} size={16} /><b className="code">{l.code}</b><span className="meta">拼完偏少</span></li>
      ))}
    </ul>
  );
}

function NextUpItem({ row, previewId, imageId, first }: { row: NextUpRow; previewId?: string; imageId?: string; first: boolean }) {
  const href = `#/pattern/${row.id}`;
  return (
    <li className="nu-item" data-nextup-row data-id={row.id} data-group={row.group} data-rank={row.rank} data-can-make={row.canMake ? "true" : "false"}>
      <a className="nu-main pressable" href={href} aria-label={`${row.name}，查看图纸`}>
        <span className="nu-thumb"><Thumb id={previewId} fallbackId={imageId} alt="" /></span>
        <span className="nu-body">
          <span className="nu-name">{row.name}{row.copies > 1 ? <span className="meta"> ×{row.copies}</span> : null}{first ? <span className="chip chip-leaf nu-best">最推荐</span> : null}</span>
          <span className="nu-why" data-nextup-why>{row.why}</span>
        </span>
      </a>
      {row.surplusTop.length || row.pushLow.length ? <NextUpChips row={row} /> : null}
      <a className={`btn nu-go${first ? " btn-primary" : ""}`} href={href} data-nextup-go aria-label={`就拼这张：${row.name}`}>就拼这张</a>
    </li>
  );
}

export function NextUpPanel() {
  const { result, inventoryReady, hasStock } = useNextUp();
  const { patterns } = useData();
  const route = useRoute();
  const ref = useRef<HTMLDivElement>(null);
  const [all, setAll] = useState(false);
  const focus = route.query.get("focus") === "nextup";
  useEffect(() => { if (focus) ref.current?.scrollIntoView({ block: "start" }); }, [focus]);
  const byId = useMemo(() => new Map(patterns.map((p) => [p.id, p])), [patterns]);

  const planned = result.rows.filter((r) => r.group === "planned");
  const ideas = result.rows.filter((r) => r.group === "idea");
  const together = planned.length >= 2 ? canMakeTogether(result, Math.min(3, planned.length)) : null;
  const best = planned[0] ?? ideas[0];
  const takeaway = !inventoryReady || !hasStock ? "库存里还没有豆子，推荐不了。"
    : !best ? "没有可推荐的图纸。"
    : `${planned.length ? "" : "计划里没有图纸，从收藏里挑：先拼"}「${best.name}」。${best.why}。`;
  const shownPlanned = all ? planned : planned.slice(0, SHOW);
  const shownIdeas = all ? ideas : ideas.slice(0, 3);
  const more = planned.length > SHOW || ideas.length > 3;
  const item = (r: NextUpRow) => { const p = byId.get(r.id); return <NextUpItem key={r.id} row={r} previewId={p?.previewId} imageId={p?.imageId} first={r === best} />; };

  return (
    <div ref={ref} className="ins-wide" data-nextup-panel>
      <InsightPanel id="ins-nextup" title="下一张拼什么" takeaway={takeaway}>
        {!inventoryReady || !hasStock ? (
          <InsightEmpty title="库存还没录入" text="先录入现有豆子，才能看出哪些颜色库存多、下一张该拼哪张。" href="#/inventory" action="去录入库存" />
        ) : !result.rows.length ? (
          <InsightEmpty title="没有计划拼的图纸" text="把图纸标为“计划拼”，这里会按库存多的颜色推荐先拼哪张。" href="#/gallery" action="去图库" />
        ) : (
          <>
            {planned.length ? <ol className="nu-list" data-nextup-list="planned">{shownPlanned.map(item)}</ol> : null}
            {together ? <p className="meta nu-together" data-nextup-together data-ok={together.ok ? "true" : "false"}>{together.ok ? `前 ${together.count} 张的豆子够一起拼。` : `前 ${together.count} 张一起拼会缺 ${together.short.slice(0, 3).map((s) => s.code).join("、")}${together.short.length > 3 ? " 等" : ""}，建议一张一张来。`}</p> : null}
            {ideas.length ? (
              <>
                <h3 className="nu-sub">收藏里也合适的</h3>
                <ol className="nu-list" data-nextup-list="idea">{shownIdeas.map(item)}</ol>
              </>
            ) : null}
            {more ? <div className="ins-more"><button type="button" className="btn btn-sm btn-ghost" aria-expanded={all} onClick={() => setAll(!all)}>{all ? "收起" : "显示更多"}</button></div> : null}
            <p className="meta ins-note" data-nextup-how>{NEXT_UP_RULE}“库存多”指库存减去制作中图纸占用、再减去该色最低库存后还有富余；用量已含份数与损耗。这里只是建议，不会改图纸状态。</p>
          </>
        )}
      </InsightPanel>
    </div>
  );
}
