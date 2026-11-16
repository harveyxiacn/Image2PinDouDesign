// 色系分布：每个系列字母两行条（需求 / 库存），共用同一把尺。
import { fmt } from "../ui";
import type { FamilyRow } from "../../lib/insights";

export function FamilyBars({ rows, inventoryReady }: { rows: FamilyRow[]; inventoryReady: boolean }) {
  const max = Math.max(1, ...rows.map((r) => Math.max(r.demand, inventoryReady ? r.stock : 0)));
  const summary = "各色系需求与库存：" + rows.map((r) => `${r.family} 系需要 ${fmt(r.demand)}${inventoryReady ? `，库存 ${fmt(r.stock)}` : ""}`).join("；") + "。";
  return (
    <div>
      <div className="ins-legend" aria-hidden="true">
        <span><i className="ins-sw track" />需求（含损耗）</span>
        {inventoryReady ? <span><i className="ins-sw have" />库存</span> : null}
      </div>
      <div role="img" aria-label={summary}>
        <ul className="ins-fam" aria-hidden="true">
          {rows.map((r) => (
            <li key={r.family}>
              <span className="ins-fam-name code">{r.family}</span>
              <span className="ins-fam-bars">
                <span className="ins-fam-line"><span className="ins-track" style={{ width: `${(r.demand / max) * 100}%` }} /><span className="num ins-fam-n">需 {fmt(r.demand)}</span></span>
                {inventoryReady ? <span className="ins-fam-line"><span className="ins-track have" style={{ width: `${(r.stock / max) * 100}%` }} /><span className="num ins-fam-n">有 {fmt(r.stock)}</span></span> : null}
              </span>
            </li>
          ))}
        </ul>
      </div>
      <details className="ins-table">
        <summary>用表格查看</summary>
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">各色系的需求、库存与缺口</caption>
            <thead><tr><th scope="col">色系</th><th scope="col" className="r">用到色数</th><th scope="col" className="r">需求</th><th scope="col" className="r">库存</th><th scope="col" className="r">缺口</th></tr></thead>
            <tbody>{rows.map((r) => <tr key={r.family}><th scope="row" className="code">{r.family}</th><td className="r">{r.colors}</td><td className="r">{fmt(r.demand)}</td><td className="r">{inventoryReady ? fmt(r.stock) : "—"}</td><td className="r">{inventoryReady ? fmt(r.gap) : "—"}</td></tr>)}</tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
