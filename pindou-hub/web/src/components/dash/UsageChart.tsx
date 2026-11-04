// 色号用量图（水平条形）：计划里用得最多的色号，需求总量 vs 库存。
// 一根条 = 需求总量（宽度按最大值归一）；里面叶绿段 = 库存已覆盖，熨斗红段 = 缺口。
// 色号身份靠左侧的豆子 + 色号文字，不靠条的颜色；缺/够有文字和图标，不只靠颜色。每行可点开色号详情；表格视图是同一份数据的文字版。
import { useMemo } from "react";
import { Bead, Icon, fmt } from "../ui";
import { colorOf } from "../../lib/palette";
import { topUsage, type Usage } from "../../lib/stockview";
import type { Counts } from "../../lib/model";
import "./UsageChart.css";

export function UsageChart({ demand, stock, onOpen, limit = 10 }: { demand: Counts; stock: Counts; onOpen: (code: string) => void; limit?: number }) {
  const usage: Usage = useMemo(() => topUsage(demand, stock, limit), [demand, stock, limit]);
  const shortRows = usage.rows.filter((r) => r.short > 0).length;
  const summary = usage.rows.length
    ? `计划里用量最多的 ${usage.rows.length} 个色号，其中 ${shortRows} 个库存不够。${usage.rows.map((r) => `${r.code} 需要 ${fmt(r.need)}，${r.short ? `缺 ${fmt(r.short)}` : "够用"}`).join("；")}。`
    : "";

  if (!usage.rows.length) {
    return <div className="empty" style={{ padding: 24 }}><h3>还没有用量数据</h3><p>把图纸标为“计划做”或“制作中”，这里会列出用得最多的色号和库存够不够。</p><a className="btn btn-sm" href="#/gallery">去图库</a></div>;
  }
  return (
    <div className="uc">
      <div className="uc-legend" aria-hidden="true">
        <span><i className="uc-sw ok" />库存已覆盖</span>
        <span><i className="uc-sw short" />缺口</span>
        <span className="meta">条长 = 计划总需求</span>
      </div>
      <p id="uc-sum" className="sr-only">{summary}</p>
      <ol className="uc-list" aria-describedby="uc-sum">
        {usage.rows.map((r) => {
          const w = (r.need / usage.max) * 100;
          const name = colorOf(r.code)?.nameZh ?? "";
          return (
            <li key={r.code}>
              <button type="button" className="uc-row pressable" onClick={() => onOpen(r.code)}
                title={`${r.code} ${name}：需要 ${fmt(r.need)}，库存 ${fmt(r.have)}`}
                aria-label={`${r.code} ${name}，需要 ${fmt(r.need)} 颗，库存 ${fmt(r.have)} 颗，${r.short ? `缺 ${fmt(r.short)}` : "够用"}。打开详情`}>
                <span className="uc-code"><Bead code={r.code} size={20} /><span className="code">{r.code}</span></span>
                <span className="uc-track" aria-hidden="true">
                  <span className="uc-bar" style={{ width: `${w}%` }}>
                    {r.covered > 0 ? <i className="ok" style={{ flex: `${r.covered} 1 0` }} /> : null}
                    {r.short > 0 ? <i className="short" style={{ flex: `${r.short} 1 0` }} /> : null}
                  </span>
                </span>
                <span className="uc-num">
                  <b className="num">需 {fmt(r.need)}</b>
                  {r.short ? <span className="uc-st short num">缺 {fmt(r.short)}</span> : <span className="uc-st ok"><Icon name="check" size={12} />够</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      {usage.rest.codes ? <p className="meta uc-rest">另有 {usage.rest.codes} 个色号 · 需 {fmt(usage.rest.need)} 颗{usage.rest.short ? ` · 缺 ${fmt(usage.rest.short)}` : ""}</p> : null}
      <details className="uc-table">
        <summary>用表格查看</summary>
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">计划用量最多的色号：需求、库存与缺口</caption>
            <thead><tr><th scope="col">色号</th><th scope="col" className="r">需要</th><th scope="col" className="r">库存</th><th scope="col" className="r">缺口</th></tr></thead>
            <tbody>{usage.rows.map((r) => <tr key={r.code}><th scope="row" className="code">{r.code}</th><td className="r">{fmt(r.need)}</td><td className="r">{fmt(r.have)}</td><td className="r">{r.short ? fmt(r.short) : "—"}</td></tr>)}</tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
