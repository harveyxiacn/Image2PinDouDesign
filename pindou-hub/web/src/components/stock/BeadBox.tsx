import { memo, useEffect, useRef } from "react";
import { Bead, fmt, DiffNumber, prefersReducedMotion } from "../ui";
import { levelOf, meterRatio } from "../../lib/stockview";
import "./stock.css";

export type CellInfo = { code: string; have: number; floor: number; need: number };

const Cell = memo(function Cell({ info, flash, onOpen }: { info: CellInfo; flash: number; onOpen: (code: string) => void }) {
  const { code, have, floor, need } = info;
  const ref = useRef<HTMLButtonElement>(null);
  const seen = useRef({ flash, have });
  // 库存刚变过：格子描一圈色边 + 底色渐隐（增加=叶绿，减少=琥珀），600ms；减少动态时不播
  useEffect(() => {
    const before = seen.current;
    seen.current = { flash, have };
    const el = ref.current;
    if (flash === before.flash || !el || !el.animate || prefersReducedMotion()) return;
    const tone = have >= before.have ? "var(--leaf)" : "var(--amber)";
    const wash = have >= before.have ? "var(--leaf-wash)" : "var(--amber-wash)";
    el.animate([{ boxShadow: `0 0 0 2px ${tone}`, backgroundColor: wash }, { boxShadow: `0 0 0 2px transparent`, backgroundColor: "var(--paper-raised)" }], { duration: 600, easing: "ease-out" });
  }, [flash, have]);
  const level = levelOf(have, floor);
  const short = need > Math.max(0, have);
  return (
    <button ref={ref} type="button" className={`sk-cell pressable${have <= 0 ? " is-empty" : ""}`} onClick={() => onOpen(code)}
      aria-label={`${code}，库存 ${have} 颗${short ? `，计划还差 ${need - Math.max(0, have)}` : ""}`}>
      <span className="sk-cell-top"><Bead code={code} size={24} /><span className="code">{code}</span></span>
      <span className="sk-qty"><DiffNumber value={have} /></span>
      <span className={`meter ${level === "ok" ? "ok" : level === "low" ? "low" : "short"}`} aria-hidden="true"><i style={{ width: `${meterRatio(have, floor) * 100}%` }} /></span>
      {short ? <span className="sk-mark num">缺{fmt(need - Math.max(0, have))}</span> : null}
    </button>
  );
});

/** 豆盒：按色号分格的库存网格。每格 = 豆子 + 色号 + 数量 + 相对最低库存的细条；计划缺口用红点标记。 */
export function BeadBox({ cells, onOpen, flashes }: { cells: CellInfo[]; onOpen: (code: string) => void; flashes?: Map<string, number> }) {
  return <div className="sk-box" role="group" aria-label="豆盒">{cells.map((c) => <Cell key={c.code} info={c} flash={flashes?.get(c.code) ?? 0} onOpen={onOpen} />)}</div>;
}
