// 进出趋势：每月入库 / 消耗成对柱（SVG），柱上不放字，数值在下方表格与 aria 摘要里；柱顶放简写数字。
import { fmt } from "../ui";
import type { MonthRow } from "../../lib/insights";

const W = 360, H = 170, PAD_L = 4, PAD_B = 22, PAD_T = 16;

function short(n: number): string {
  return n >= 10000 ? `${(n / 10000).toFixed(n >= 100000 ? 0 : 1)}万` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function TrendChart({ months, hasPrice }: { months: MonthRow[]; hasPrice: boolean }) {
  const max = Math.max(1, ...months.flatMap((m) => [m.purchased, m.consumed]));
  const slot = (W - PAD_L) / months.length;
  const bw = Math.min(14, slot / 2 - 2);
  const plotH = H - PAD_B - PAD_T;
  const y = (v: number) => H - PAD_B - (v / max) * plotH;
  const dense = months.length > 8;
  const summary = "每月入库与消耗：" + months.filter((m) => m.purchased || m.consumed).map((m) => `${m.year} 年 ${m.month} 月入库 ${fmt(m.purchased)}、消耗 ${fmt(m.consumed)}`).join("；") + "。";
  return (
    <div>
      <div className="ins-legend" aria-hidden="true"><span><i className="ins-sw in" />入库</span><span><i className="ins-sw out" />消耗</span></div>
      <svg className="ins-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={summary}>
        <line x1={0} x2={W} y1={H - PAD_B} y2={H - PAD_B} className="ins-axis" />
        {months.map((m, i) => {
          const cx = PAD_L + slot * i + slot / 2;
          return (
            <g key={m.key}>
              <rect x={cx - bw - 1} y={y(m.purchased)} width={bw} height={Math.max(0, H - PAD_B - y(m.purchased))} className="ins-rect in" rx={2} />
              <rect x={cx + 1} y={y(m.consumed)} width={bw} height={Math.max(0, H - PAD_B - y(m.consumed))} className="ins-rect out" rx={2} />
              {!dense && m.purchased > 0 ? <text x={cx - bw / 2 - 1} y={y(m.purchased) - 3} textAnchor="middle" className="ins-svg-n">{short(m.purchased)}</text> : null}
              {!dense && m.consumed > 0 ? <text x={cx + bw / 2 + 1} y={y(m.consumed) - 3} textAnchor="middle" className="ins-svg-n">{short(m.consumed)}</text> : null}
              <text x={cx} y={H - 6} textAnchor="middle" className="ins-svg-l">{dense && m.month !== 1 && i !== 0 ? m.month : `${String(m.year).slice(2)}/${m.month}`}</text>
            </g>
          );
        })}
      </svg>
      <details className="ins-table">
        <summary>用表格查看</summary>
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">每月入库、消耗、花费与完成图纸数</caption>
            <thead><tr><th scope="col">月份</th><th scope="col" className="r">入库</th><th scope="col" className="r">消耗</th>{hasPrice ? <th scope="col" className="r">花费</th> : null}<th scope="col" className="r">完成图纸</th></tr></thead>
            <tbody>{[...months].reverse().map((m) => <tr key={m.key}><th scope="row">{m.key}</th><td className="r">{fmt(m.purchased)}</td><td className="r">{fmt(m.consumed)}</td>{hasPrice ? <td className="r">{m.spent ? `¥${m.spent.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}` : "—"}</td> : null}<td className="r">{m.completed}</td></tr>)}</tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
