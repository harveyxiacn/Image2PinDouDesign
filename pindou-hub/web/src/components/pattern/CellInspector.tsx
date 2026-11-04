import type { AnalyzeResult } from "../../lib/recognize/types";
import { colorOf } from "../../lib/palette";
import { BeadCode, Icon, fmt } from "../ui";

export type CellPick = { r: number; c: number };
type Check = NonNullable<AnalyzeResult["checks"]>[number];

const STATUS: Record<Check["status"], { label: string; cls: string }> = {
  ok: { label: "与图例一致", cls: "chip-leaf" },
  short: { label: "比图例少", cls: "chip-amber" },
  over: { label: "比图例多", cls: "chip-amber" },
  "no-legend": { label: "图例里没有", cls: "" }
};

/** 点中 / 光标所在格子的核对信息：行列、取色（真实采样）、识别色号、全图用量与图例核对。放在缩放区下方，不遮挡图片。 */
export default function CellInspector({ pick, code, sampleHex, total, check, size, onMove, onClose }: {
  pick: CellPick; code: string | null; sampleHex: string | null; total: number; check?: Check;
  size: { rows: number; cols: number }; onMove: (dr: number, dc: number) => void; onClose: () => void;
}) {
  const pal = code ? colorOf(code) : undefined;
  const st = check ? STATUS[check.status] : null;
  return (
    <div className="pt-inspector" role="region" aria-label="格子核对" aria-live="polite" data-testid="cell-inspector">
      <div className="pt-insp-main">
        <span className="pt-insp-pos num">行 {pick.r + 1} · 列 {pick.c + 1}</span>
        <div className="pt-insp-sw" title="图上取到的颜色 / 识别色号的标准色">
          <span className="pt-insp-chip" style={{ background: sampleHex ?? "transparent" }} aria-hidden="true" />
          <span className="code">{sampleHex ?? "—"}</span>
          <span className="meta">图上取色</span>
        </div>
        {code ? (
          <div className="pt-insp-sw">
            <BeadCode code={code} showName />
            <span className="code">{pal?.hex ?? ""}</span>
            <span className="meta">色号标准色</span>
          </div>
        ) : <div className="pt-insp-sw"><b>空格 / 背景</b><span className="meta">这一格没有计入豆子</span></div>}
        {code ? (
          <div className="pt-insp-sw">
            <b className="num">{fmt(total)} 颗</b>
            <span className="meta">全图 {code} 数量</span>
            {check && check.legend !== null ? <span className="meta">图例 {fmt(check.legend)}</span> : null}
            {st ? <span className={`chip ${st.cls}`}>{st.label}</span> : null}
          </div>
        ) : null}
      </div>
      <div className="pt-insp-nav" role="group" aria-label="移动到相邻格子">
        <button type="button" className="btn btn-sm" aria-label="上一行" disabled={pick.r <= 0} onClick={() => onMove(-1, 0)}>↑</button>
        <button type="button" className="btn btn-sm" aria-label="下一行" disabled={pick.r >= size.rows - 1} onClick={() => onMove(1, 0)}>↓</button>
        <button type="button" className="btn btn-sm" aria-label="左一列" disabled={pick.c <= 0} onClick={() => onMove(0, -1)}>←</button>
        <button type="button" className="btn btn-sm" aria-label="右一列" disabled={pick.c >= size.cols - 1} onClick={() => onMove(0, 1)}>→</button>
        <button type="button" className="btn btn-sm btn-ghost" aria-label="关闭格子核对" onClick={onClose}><Icon name="x" size={16} /></button>
      </div>
    </div>
  );
}
