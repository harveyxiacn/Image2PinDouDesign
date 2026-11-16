// 总览上的补货预告小卡：只列最紧急的几个色号，完整清单在数据洞察里。
import { Bead, fmt } from "../ui";
import { formatMoney } from "../../lib/purchase";
import { formatPackText } from "../../lib/forecast";
import { useForecast } from "./ForecastData";

export function ForecastCard({ limit = 4 }: { limit?: number }) {
  const { result, horizon } = useForecast();
  if (!result.inventoryReady) return null;
  const top = result.rows.slice(0, limit);
  return (
    <section className="panel fc-card" aria-labelledby="dash-fc-h" data-forecast-card>
      <div className="panel-head"><h3 id="dash-fc-h">补货预告</h3><a className="meta" href="#/insights?focus=forecast" data-forecast-link>看完整预告</a></div>
      {top.length ? (
        <>
          <ul className="fc-mini">
            {top.map((r) => (
              <li key={r.code} data-forecast-card-row data-code={r.code} data-status={r.status}>
                <span className="fc-code"><Bead code={r.code} size={20} /><b className="code">{r.code}</b></span>
                <span className="meta">{r.label}</span>
                <span className="fc-mini-buy">{r.buyBeads > 0 ? `买 ${formatPackText(r.packs)}` : "—"}</span>
              </li>
            ))}
          </ul>
          <p className="meta fc-mini-foot">共 {result.rows.length} 个色号要留意，未来 {horizon} 个月建议买 {fmt(result.totals.beads)} 颗，约 {formatMoney(result.totals.cost)}。{result.thin ? "消耗记录还少，暂时只按计划图纸预告。" : ""}</p>
        </>
      ) : <div className="empty fc-mini-empty">暂时不用补货。</div>}
    </section>
  );
}
