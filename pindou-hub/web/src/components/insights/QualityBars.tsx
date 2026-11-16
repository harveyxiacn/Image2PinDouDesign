// 识别质量：已核对 / 未核对占比 + 可信度分布。
import { fmt } from "../ui";
import type { Quality } from "../../lib/insights";

export function QualityBars({ q }: { q: Quality }) {
  const vp = q.total ? (q.verified / q.total) * 100 : 0;
  const max = Math.max(1, ...q.buckets.map((b) => b.count));
  const summary = `共 ${q.total} 张图纸，已核对 ${q.verified} 张，未核对 ${q.unverified} 张。可信度：` + q.buckets.map((b) => `${b.label} ${b.count} 张`).join("，") + (q.noConfidence ? `，未记录 ${q.noConfidence} 张` : "") + "。";
  return (
    <div>
      <div role="img" aria-label={summary}>
        <div aria-hidden="true">
          <div className="ins-stack"><i className="ok" style={{ width: `${vp}%` }} /><i className="rest" style={{ width: `${100 - vp}%` }} /></div>
          <div className="ins-legend"><span><i className="ins-sw ok" />已核对 <b className="num">{fmt(q.verified)}</b></span><span><i className="ins-sw track" />未核对 <b className="num">{fmt(q.unverified)}</b></span></div>
          <ul className="ins-hist">
            {q.buckets.map((b) => (
              <li key={b.label}><span className="meta">可信度 {b.label}</span><span className="ins-track" style={{ width: `${(b.count / max) * 100}%` }} /><span className="num">{fmt(b.count)} 张</span></li>
            ))}
            {q.noConfidence ? <li><span className="meta">未记录可信度</span><span /><span className="num">{fmt(q.noConfidence)} 张</span></li> : null}
          </ul>
        </div>
      </div>
      <div className="ins-more">
        <a className="btn btn-sm" href="#/gallery?status=planned&verify=unverified">去核对未核对的计划图纸{q.activeUnverified ? `（${fmt(q.activeUnverified)}）` : ""}</a>
      </div>
    </div>
  );
}
