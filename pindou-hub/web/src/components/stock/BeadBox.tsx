import { memo } from "react";
import { Bead, fmt } from "../ui";
import { levelOf, meterRatio } from "../../lib/stockview";
import "./stock.css";

export type CellInfo = { code: string; have: number; floor: number; need: number };

const Cell = memo(function Cell({ info, onOpen }: { info: CellInfo; onOpen: (code: string) => void }) {
  const { code, have, floor, need } = info;
  const level = levelOf(have, floor);
  const short = need > Math.max(0, have);
  return (
    <button type="button" className={`sk-cell${have <= 0 ? " is-empty" : ""}`} onClick={() => onOpen(code)}
      aria-label={`${code}，库存 ${have} 颗${short ? `，计划还差 ${need - Math.max(0, have)}` : ""}`}>
      <span className="sk-cell-top"><Bead code={code} size={24} /><span className="code">{code}</span></span>
      <span className="sk-qty num">{fmt(have)}</span>
      <span className={`meter ${level === "ok" ? "ok" : level === "low" ? "low" : "short"}`} aria-hidden="true"><i style={{ width: `${meterRatio(have, floor) * 100}%` }} /></span>
      {short ? <span className="sk-mark num">缺{fmt(need - Math.max(0, have))}</span> : null}
    </button>
  );
});

/** 豆盒：按色号分格的库存网格。每格 = 豆子 + 色号 + 数量 + 相对最低库存的细条；计划缺口用红点标记。 */
export function BeadBox({ cells, onOpen }: { cells: CellInfo[]; onOpen: (code: string) => void }) {
  return <div className="sk-box" role="list">{cells.map((c) => <Cell key={c.code} info={c} onOpen={onOpen} />)}</div>;
}
