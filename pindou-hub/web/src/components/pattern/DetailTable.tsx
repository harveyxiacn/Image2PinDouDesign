import type { Counts } from "../../lib/model";
import { totalOf } from "../../lib/model";
import { compareCodes } from "../../lib/inventory";
import { BeadCode, fmt } from "../ui";
import "./pattern.css";

/** 详情页用量表：每份 / ×份数 / 库存 / 缺口。缺口用熨斗红。点击一行高亮该色。 */
export default function DetailTable({ counts, copies, stock, focusCode, onPick }: {
  counts: Counts; copies: number; stock: Counts; focusCode: string | null; onPick: (code: string) => void;
}) {
  const codes = Object.keys(counts).filter((c) => counts[c] > 0).sort((a, b) => counts[b] - counts[a] || compareCodes(a, b));
  const multi = copies > 1;
  let shortColors = 0;
  const rows = codes.map((c) => {
    const need = counts[c] * copies;
    const have = Math.max(0, stock[c] ?? 0);
    const gap = Math.max(0, need - have);
    if (gap) shortColors++;
    return { c, need, have, gap };
  });
  return (
    <div className="pt-counts">
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>色号</th><th className="r">每份</th>{multi ? <th className="r">×{copies}</th> : null}<th className="r">库存</th><th className="r">缺口</th></tr></thead>
          <tbody>
            {rows.map(({ c, need, have, gap }) => (
              <tr key={c} data-click="true" data-focus={focusCode === c} onClick={() => onPick(c)}>
                <td><BeadCode code={c} showName /></td>
                <td className="r num">{fmt(counts[c])}</td>
                {multi ? <td className="r num">{fmt(need)}</td> : null}
                <td className="r num">{fmt(have)}</td>
                <td className="r num" style={gap ? { color: "var(--iron-ink)", fontWeight: 600 } : { color: "var(--ink-4)" }}>{gap ? `缺 ${fmt(gap)}` : "够"}</td>
              </tr>
            ))}
            {!rows.length ? <tr><td colSpan={5} className="meta" style={{ textAlign: "center", padding: 20 }}>还没有用量，点“编辑用量”添加</td></tr> : null}
          </tbody>
          <tfoot><tr><td className="meta">{rows.length} 色{shortColors ? `，缺 ${shortColors} 色` : ""}</td><td className="r num"><b>{fmt(totalOf(counts))}</b></td>{multi ? <td className="r num"><b>{fmt(totalOf(counts) * copies)}</b></td> : null}<td /><td /></tr></tfoot>
        </table>
      </div>
    </div>
  );
}
