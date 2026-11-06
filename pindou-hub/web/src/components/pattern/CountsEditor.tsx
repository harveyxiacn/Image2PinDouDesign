import React, { useState } from "react";
import type { Counts } from "../../lib/model";
import { totalOf } from "../../lib/model";
import { compareCodes } from "../../lib/inventory";
import { colorOf, normalizeCode } from "../../lib/palette";
import { BeadCode, DiffNumber, Icon, fmt } from "../ui";
import "./pattern.css";

/** 与下方图例用量的逐色核对结果（assistant 的 checks） */
export type CheckMap = Record<string, { status: "ok" | "short" | "over" | "no-legend"; delta: number; legend?: number | null; read?: number; source?: "legend" | "grid" | "cell" | "both" | "total-fit" }>;
export type DiffMap = Record<string, { legend: number; grid: number }>;

/** 可编辑的色号用量表。diff 提供时标出图例与网格不一致的色号。 */
export default function CountsEditor({ counts, onChange, diff, checks, readOnly, focusCode, onPick, stagger }: {
  counts: Counts; onChange?: (next: Counts) => void; diff?: DiffMap | null; checks?: CheckMap | null; readOnly?: boolean; focusCode?: string | null; onPick?: (code: string) => void;
  /** 结果刚出来时让行依次浮现（每行 ≤30ms，总时长封顶）；减少动态时无动画 */
  stagger?: boolean;
}) {
  const [code, setCode] = useState("");
  const [count, setCount] = useState("");
  const [error, setError] = useState("");
  const hasChecks = !!checks && Object.keys(checks).length > 0;
  const columns = 1 + (diff ? 2 : 0) + (hasChecks ? 1 : 0) + 1 + (readOnly ? 0 : 1);
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
              {hasChecks ? <th>采用</th> : null}
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
                    {checks?.[c] ? <CheckChip check={checks[c]} /> : null}
                    {differs ? <span className="chip chip-amber pt-diff-chip" title="图例读到的数量和网格数出来的不一致">≠</span> : null}
                  </td>
                  {diff ? <td className="r num">{d ? fmt(d.legend) : "—"}</td> : null}
                  {diff ? <td className="r num">{d ? fmt(d.grid) : "—"}</td> : null}
                  {hasChecks ? <td><SourceChip source={checks?.[c]?.source} check={checks?.[c]} diff={d} /></td> : null}
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
            {!codes.length ? <tr><td colSpan={columns} className="meta" style={{ textAlign: "center", padding: 20 }}>还没有色号</td></tr> : null}
          </tbody>
          <tfoot>
            <tr><td className="meta">合计 {codes.length} 色</td>{diff ? <td /> : null}{diff ? <td /> : null}{hasChecks ? <td /> : null}<td className="r"><b><DiffNumber value={totalOf(counts)} /></b></td>{!readOnly ? <td /> : null}</tr>
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

const SOURCE_LABEL: Record<NonNullable<CheckMap[string]["source"]>, string> = {
  legend: "图例", grid: "网格", cell: "格内色号", both: "两者一致", "total-fit": "按总数核对"
};

function SourceChip({ source, check, diff }: { source?: CheckMap[string]["source"]; check?: CheckMap[string]; diff?: DiffMap[string] }) {
  if (!source) return <span className="meta">—</span>;
  // “both”只表示两列在容差内吻合，不一定逐颗相等；最终数量取了哪一列就照实说。
  if (source === "both" && check && check.legend != null && check.read != null && check.read !== check.legend) {
    const label = diff && check.read === diff.grid ? "采用网格" : check.read === check.legend ? "采用图例" : "两者接近";
    const where = diff ? `图例 ${fmt(diff.legend)}、网格 ${fmt(diff.grid)}` : `图例 ${fmt(check.legend)}`;
    return <span className="chip" title={`${where}，相差 ${fmt(check.delta)} 颗（在允许误差内），最终数量${label.replace("采用", "取")}`}>{label}</span>;
  }
  return <span className={`chip ${source === "cell" ? "chip-leaf" : ""}`} title="这一行最终采用的数量来自哪一列">{SOURCE_LABEL[source]}</span>;
}

function CheckChip({ check }: { check: CheckMap[string] }) {
  const n = fmt(check.delta);
  if (check.status === "ok") {
    // 3% 容差内的小差异不算“完全一致”，避免同一行出现“✓ 一致”又标“≠”。
    if (check.legend != null && check.read != null && check.read !== check.legend) {
      return <span className="chip pt-check-chip" title={`图例 ${fmt(check.legend)}，当前用量 ${fmt(check.read)}，相差 ${n} 颗（在允许误差内）`}>≈ 接近</span>;
    }
    return <span className="chip chip-leaf pt-check-chip" title="与下方图例的用量完全一致">✓ 一致</span>;
  }
  if (check.status === "short") return <span className="chip chip-amber pt-check-chip" title={`比下方图例少 ${n} 颗`}>少 {n}</span>;
  if (check.status === "over") return <span className="chip chip-amber pt-check-chip" title={`比下方图例多 ${n} 颗`}>多 {n}</span>;
  return <span className="chip pt-check-chip" title="下方图例里没有这个色号">无图例</span>;
}
