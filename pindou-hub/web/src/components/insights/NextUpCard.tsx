// 总览上的“下一张拼什么”小卡：只给最推荐的一张，完整排名在数据洞察里。没有库存或没有候选时不显示。
import { Bead, fmt } from "../ui";
import { Thumb } from "../pattern/PatternCard";
import { useData } from "../../lib/db";
import { useNextUp } from "./NextUpData";
import "./NextUp.css";

export function NextUpCard() {
  const { result, hasStock } = useNextUp();
  const { patterns } = useData();
  const top = result.rows[0];
  if (!hasStock || !top) return null;
  const p = patterns.find((x) => x.id === top.id);
  return (
    <section className="panel nu-card" aria-labelledby="dash-nu-h" data-nextup-card>
      <div className="panel-head"><h3 id="dash-nu-h">下一张拼什么</h3><a className="meta" href="#/insights?focus=nextup" data-nextup-link>看全部推荐</a></div>
      <a className="nu-main nu-card-main pressable" href={`#/pattern/${top.id}`} data-nextup-card-go aria-label={`${top.name}，查看图纸`}>
        <span className="nu-thumb"><Thumb id={p?.previewId} fallbackId={p?.imageId} alt="" /></span>
        <span className="nu-body">
          <span className="nu-name">{top.name}{top.copies > 1 ? <span className="meta"> ×{top.copies}</span> : null}{top.group === "idea" ? <span className="chip nu-best">收藏</span> : null}</span>
          <span className="nu-why" data-nextup-why>{top.why}</span>
        </span>
      </a>
      {top.surplusTop.length ? (
        <ul className="nu-chips nu-card-chips" aria-label="用到的库存多的颜色">
          {top.surplusTop.map((s) => <li key={s.code} className="nu-chip"><Bead code={s.code} size={16} /><b className="code">{s.code}</b><span className="meta num">{fmt(s.beads)}</span></li>)}
        </ul>
      ) : null}
    </section>
  );
}
