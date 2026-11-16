// 补货预告面板：按紧急程度列出要补的色号，给出建议整包数量，并能复制给卖家看的清单。
import { useEffect, useRef } from "react";
import { Bead, fmt, toast, useRoute } from "../ui";
import { copyText } from "../stock/download";
import { FORMULA_NOTE, dayText, forecastCopyText, formatPackText, horizonLabel, type ForecastRow, type Horizon } from "../../lib/forecast";
import { formatMoney } from "../../lib/purchase";
import { InsightEmpty, InsightPanel } from "./Panel";
import { useForecast } from "./ForecastData";

const HORIZONS: Horizon[] = [1, 2, 3];

export function ForecastRowItem({ row }: { row: ForecastRow }) {
  const tone = row.status === "now" ? "chip-iron" : row.status === "plan" ? "chip-amber" : "";
  const facts = [
    `库存 ${fmt(row.stock)}`,
    row.committed ? `计划用 ${fmt(row.committed)}` : "",
    row.incoming ? `在途 ${fmt(row.incoming)}` : "",
    row.perMonth > 0 ? `月均用 ${fmt(Math.round(row.perMonth))}` : "",
    row.status === "soon" && row.runOutAt ? `约 ${dayText(row.runOutAt)} 用完` : ""
  ].filter(Boolean).join(" · ");
  return (
    <li className="fc-row" data-forecast-row data-code={row.code} data-status={row.status}>
      <span className="fc-code"><Bead code={row.code} size={20} /><b className="code">{row.code}</b></span>
      <span className={`chip fc-chip ${tone}`}>{row.label}</span>
      <span className="fc-facts meta">{facts}</span>
      <span className="fc-buy">{row.buyBeads > 0 ? <><b>买 {formatPackText(row.packs)}</b><span className="meta">共 {fmt(row.buyBeads)} 颗 · {formatMoney(row.cost)}</span></> : <span className="meta">暂不用买</span>}</span>
    </li>
  );
}

export function ForecastPanel() {
  const { result, horizon, setHorizon } = useForecast();
  const route = useRoute();
  const ref = useRef<HTMLDivElement>(null);
  const focus = route.query.get("focus") === "forecast";
  useEffect(() => { if (focus) ref.current?.scrollIntoView({ block: "start" }); }, [focus]);

  const { rows, totals } = result;
  const urgent = rows.filter((r) => r.status === "now" || r.status === "plan").length;
  const buyRows = rows.filter((r) => r.buyBeads > 0);
  const copy = async () => {
    const text = forecastCopyText(result);
    if (!text) { toast("暂时没有要补的豆子"); return; }
    toast((await copyText(text)) ? "已复制补货清单" : "复制失败，请手动选择文字");
  };
  const takeaway = !result.inventoryReady ? "库存未录入，没法预告。"
    : !rows.length ? "按现在的计划和用量，暂时不用补货。"
    : `${rows.length} 个色号要留意${urgent ? `，其中 ${urgent} 个按计划拼就不够` : ""}；未来 ${horizonLabel(horizon)}建议买 ${fmt(totals.beads)} 颗，约 ${formatMoney(totals.cost)}。`;

  return (
    <div ref={ref} className="ins-wide" data-forecast-panel>
      <InsightPanel id="ins-forecast" title="补货预告" takeaway={takeaway}
        aside={<div className="ins-seg" role="group" aria-label="预留多久的用量" data-forecast-horizon>{HORIZONS.map((h) => <button key={h} type="button" className="btn btn-sm" data-horizon={h} aria-pressed={horizon === h} onClick={() => setHorizon(h)}>{h} 个月</button>)}</div>}>
        {!result.inventoryReady ? (
          <InsightEmpty title="库存还没录入" text="先录入现有豆子，才能算出哪些色号会不够。" href="#/inventory" action="去录入库存" />
        ) : (
          <>
            {result.thin ? <p className="notice fc-thin" role="note" data-forecast-thin>消耗记录还少，暂时只按计划图纸预告。完成几张图纸后，这里会加上日常用量。</p> : null}
            {rows.length ? <ul className="fc-list">{rows.map((r) => <ForecastRowItem key={r.code} row={r} />)}</ul> : (
              <InsightEmpty title="暂时不用补货" text={result.thin ? "计划里的图纸都够用。" : "计划够用，按日常用量短期内也不会用完。"} />
            )}
            <div className="fc-foot">
              <div className="fc-total">
                {buyRows.length ? <><b>合计 {buyRows.length} 个色号 · {fmt(totals.beads)} 颗</b><span className="meta">约 {formatMoney(totals.cost)}（按 1200 颗装 1.26 元起算）</span></> : <span className="meta">没有需要买的</span>}
              </div>
              <button type="button" className="btn btn-primary" data-forecast-copy disabled={!buyRows.length} onClick={copy}>复制补货清单</button>
            </div>
            <p className="meta ins-note fc-how" data-forecast-how>{result.basis}。{FORMULA_NOTE} 没存过也没用过的色号不会被当成快用完。</p>
          </>
        )}
      </InsightPanel>
    </div>
  );
}
