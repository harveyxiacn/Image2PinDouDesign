// 最缺的颜色：需求（轨道）对库存（填充），行尾给出缺口数字。
import { Bead, Icon, fmt } from "../ui";
import { colorOf } from "../../lib/palette";
import type { DemandRow } from "../../lib/insights";

export function DemandBars({ rows, inventoryReady }: { rows: DemandRow[]; inventoryReady: boolean }) {
  const max = Math.max(1, ...rows.map((r) => r.need));
  const summary = `需求最大的 ${rows.length} 个色号：` + rows.map((r) => `${r.code} 需要 ${fmt(r.need)}${inventoryReady ? `，库存 ${fmt(r.stock)}，${r.gap ? `缺 ${fmt(r.gap)}` : "够用"}` : ""}`).join("；") + "。";
  return (
    <div>
      <div className="ins-legend" aria-hidden="true">
        <span><i className="ins-sw track" />需求（含损耗）</span>
        {inventoryReady ? <span><i className="ins-sw have" />库存</span> : null}
      </div>
      <div role="img" aria-label={summary}>
        <ol className="ins-bars" aria-hidden="true">
          {rows.map((r) => (
            <li key={r.code} className="ins-bar-row">
              <span className="ins-bar-code"><Bead code={r.code} size={18} /><span className="code">{r.code}</span></span>
              <span className="ins-track" style={{ width: `${(r.need / max) * 100}%` }}>
                {inventoryReady ? <i className={r.gap ? "short" : "ok"} style={{ width: `${Math.min(100, (r.stock / Math.max(1, r.need)) * 100)}%` }} /> : null}
              </span>
              <span className="ins-bar-end num">{!inventoryReady ? `需 ${fmt(r.need)}` : r.gap ? <b className="short">缺 {fmt(r.gap)}</b> : <b className="ok">够</b>}</span>
            </li>
          ))}
        </ol>
      </div>
      <details className="ins-table">
        <summary>用表格查看</summary>
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">需求最大的色号：需求、库存与缺口</caption>
            <thead><tr><th scope="col">色号</th><th scope="col" className="r">图纸数</th><th scope="col" className="r">需求</th><th scope="col" className="r">库存</th><th scope="col" className="r">缺口</th></tr></thead>
            <tbody>{rows.map((r) => <tr key={r.code}><th scope="row" className="code" title={colorOf(r.code)?.nameZh}>{r.code}</th><td className="r">{r.patterns}</td><td className="r">{fmt(r.need)}</td><td className="r">{inventoryReady ? fmt(r.stock) : "—"}</td><td className="r">{inventoryReady ? fmt(r.gap) : "—"}</td></tr>)}</tbody>
          </table>
        </div>
      </details>
      <div className="ins-more"><a className="btn btn-sm" href="#/purchase"><Icon name="sparkle" size={16} />去采购方案</a></div>
    </div>
  );
}
