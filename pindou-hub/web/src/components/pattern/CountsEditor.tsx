import React, { useState } from "react";
import type { Counts } from "../../lib/model";
import { totalOf } from "../../lib/model";
import { compareCodes } from "../../lib/inventory";
import { colorOf, normalizeCode } from "../../lib/palette";
import { BeadCode, DiffNumber, Icon, fmt } from "../ui";
import "./pattern.css";

export type DiffMap = Record<string, { legend: number; grid: number }>;

/** 可编辑的色号用量表。diff 提供时标出图例与网格不一致的色号。 */
export default function CountsEditor({ counts, onChange, diff, readOnly, focusCode, onPick, stagger }: {
  counts: Counts; onChange?: (next: Counts) => void; diff?: DiffMap | null; readOnly?: boolean; focusCode?: string | null; onPick?: (code: string) => void;
  /** 结果刚出来时让行依次浮现（每行 ≤30ms，总时长封顶）；减少动态时无动画 */
  stagger?: boolean;
}) {
  const [code, setCode] = useState("");
  const [count, setCount] = useState("");
  const [error, setError] = useState("");
  const codes = Object.keys(counts).sort((a, b) => (counts[b] - counts[a]) || compareCodes(a, b));
  const set = (c: string, n: number) => onChange?.({ ...counts, [c]: Math.max(0, Math.round(n) || 0) });
  const remove = (c: string) => { const next = { ...counts }; delete next[c]; onChange?.(next); };

  const add = () => {
    const normalized = normalizeCode(code);
    if (!normalized) { setError(`“${code.trim() || "空"}”不是有效的 MARD 色号`); return; }
    const n = Math.round(Number(count));
    if (!Number.isFinite(n) || n <= 0) { setError("数量要大于 0"); return; }
    setError("");
    onChange?.({ ...counts, [normalized]: (counts[normalized] ?? 0) + n });
    setCode(""); setCount("");
  };

  return (
    <div className="pt-counts">
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>色号</th>
              {diff ? <th className="r">图例</th> : null}
              {diff ? <th className="r">网格</th> : null}
              <th className="r">数量</th>
              {!readOnly ? <th aria-label="操作" /> : null}
            </tr>
          </thead>
          <tbody>
            {codes.map((c, i) => {
              const d = diff?.[c];
              const differs = !!d && d.legend !== d.grid;
              return (
                <tr key={c} data-diff={differs} data-focus={focusCode === c} data-click={!!onPick} data-in={stagger ? "" : undefined}
                  style={stagger ? ({ "--i": Math.min(i, 12) } as React.CSSProperties) : undefined}
                  onClick={onPick ? () => onPick(c) : undefined}>
                  <td>
                    {onPick ? (
                      <button type="button" className="pt-pick" aria-pressed={focusCode === c} aria-label={`${focusCode === c ? "取消高亮" : "高亮"} ${c}`}
                        onClick={(e) => { e.stopPropagation(); onPick(c); }}><BeadCode code={c} showName /></button>
                    ) : <BeadCode code={c} showName />}
                    {!colorOf(c) ? <span className="chip chip-amber" style={{ marginLeft: 6 }}>未知色号</span> : null}
                    {differs ? <span className="chip chip-amber pt-diff-chip" title="图例读到的数量和网格数出来的不一致">≠</span> : null}
                  </td>
                  {diff ? <td className="r num">{d ? fmt(d.legend) : "—"}</td> : null}
                  {diff ? <td className="r num">{d ? fmt(d.grid) : "—"}</td> : null}
                  <td className="r">
                    {readOnly ? <span className="num">{fmt(counts[c])}</span> : (
                      <input className="input pt-num num" type="number" inputMode="numeric" min={0} value={counts[c]} aria-label={`${c} 数量`}
                        onChange={(e) => set(c, Number(e.target.value))} onClick={(e) => e.stopPropagation()} />
                    )}
                  </td>
                  {!readOnly ? (
                    <td className="r"><button className="btn btn-ghost btn-sm" aria-label={`删除 ${c}`} onClick={(e) => { e.stopPropagation(); remove(c); }}><Icon name="x" /></button></td>
                  ) : null}
                </tr>
              );
            })}
            {!codes.length ? <tr><td colSpan={5} className="meta" style={{ textAlign: "center", padding: 20 }}>还没有色号</td></tr> : null}
          </tbody>
          <tfoot>
            <tr><td className="meta">合计 {codes.length} 色</td>{diff ? <td /> : null}{diff ? <td /> : null}<td className="r"><b><DiffNumber value={totalOf(counts)} /></b></td>{!readOnly ? <td /> : null}</tr>
          </tfoot>
        </table>
      </div>
      {!readOnly ? (
        <>
          <form className="pt-add" onSubmit={(e) => { e.preventDefault(); add(); }}>
            <input className="input code" placeholder="色号，如 A12" value={code} onChange={(e) => setCode(e.target.value)} aria-label="新增色号" />
            <input className="input num" type="number" inputMode="numeric" min={1} placeholder="数量" value={count} onChange={(e) => setCount(e.target.value)} aria-label="新增数量" style={{ flex: "0 1 96px" }} />
            <button className="btn btn-sm" type="submit"><Icon name="plus" />添加</button>
          </form>
          {error ? <div className="pt-err" style={{ padding: "0 12px 10px" }} role="alert">{error}</div> : null}
        </>
      ) : null}
    </div>
  );
}
