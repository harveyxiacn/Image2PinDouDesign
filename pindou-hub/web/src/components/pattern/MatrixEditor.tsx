// 拼豆图编辑器：工具条 + MatrixView + 整色替换 + 撤销 / 重做。
// 图库详情页使用；识别页（RecognizePanel）以后可以直接换成它（见交付说明）。
import { useEffect, useMemo, useRef, useState } from "react";
import { countMatrixColors, countsEqual, matrixDiffCount, paintCells, replaceCode, type BrushSize, type MatrixCell } from "../../lib/matrixEdit";
import { commitEdit, initEdit, redoEdit, undoEdit, type EditState } from "../../lib/editHistory";
import { compareCodes } from "../../lib/inventory";
import type { Matrix } from "../../lib/matrix";
import type { Counts } from "../../lib/model";
import { ALL_CODES, colorOf } from "../../lib/palette";
import { fmt, toast } from "../ui";
import MatrixView, { type MatrixTool } from "./MatrixView";
import { cycleCode, editorKey } from "../../lib/shortcuts";
import { useLeaveGuard } from "./useLeaveGuard";
import "./MatrixEditor.css";

export type MatrixEditorProps = {
  matrix: Matrix;
  counts: Counts;
  width: number;
  height: number;
  /** 点“保存”：把编辑后的矩阵与用量交给调用方写库。返回后编辑器由调用方关闭。 */
  onSave: (matrix: Matrix, counts: Counts, original: Matrix) => void | Promise<void>;
  /** 点“取消”（有改动时已确认过）。 */
  onCancel: () => void;
  /** 用量实时变化，供旁边的用量表显示。 */
  onCountsChange?: (counts: Counts) => void;
  /** 未保存状态变化，供调用方拦截离开。 */
  onDirtyChange?: (dirty: boolean) => void;
  saving?: boolean;
};

const Swatch = ({ code }: { code: string | null }) => (
  <span className="me-swatch" aria-hidden="true" style={{ background: (code && colorOf(code)?.hex) || "transparent" }} />
);

export default function MatrixEditor({ matrix: matrixProp, counts: countsProp, width, height, onSave, onCancel, onCountsChange, onDirtyChange, saving }: MatrixEditorProps) {
  // 打开编辑时的版本：之后调用方重新解码 / 同步也不影响这次编辑的基准
  const [{ matrix, counts }] = useState(() => ({ matrix: matrixProp, counts: countsProp }));
  const [st, setSt] = useState<EditState>(() => initEdit({ matrix, counts }));
  const [tool, setTool] = useState<MatrixTool>("eraser");
  const [size, setSize] = useState<BrushSize>(1);
  const [brush, setBrush] = useState<string | null>(null);
  const [source, setSource] = useState<string | null>(null);

  const changed = useMemo(() => matrixDiffCount(matrix, st.matrix), [matrix, st.matrix]);
  const dirty = changed > 0 || !countsEqual(counts, st.counts);
  useLeaveGuard(dirty);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => { onCountsChange?.(st.counts); }, [st.counts, onCountsChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  // 现在图上用到的色号（按色号排序），放在选色列表前面
  const used = useMemo(() => Object.keys(countMatrixColors(st.matrix)).sort(compareCodes), [st.matrix]);
  const rest = useMemo(() => ALL_CODES.filter((c) => !used.includes(c)), [used]);

  const apply = (next: { matrix: Matrix; counts: Counts }) => setSt((s) => commitEdit(s, next));
  const paint = (cells: MatrixCell[], code: string | null) => apply(paintCells(st.matrix, st.counts, cells, code, width, height));
  const pick = (code: string | null) => {
    if (!code) return;
    setBrush(code); setSource(code);
  };
  const replaceAll = (to: string | null) => {
    if (!source) return;
    const out = replaceCode(st.matrix, st.counts, source, to, width, height);
    if (!out.changes.length) { toast("没有需要修改的格子"); return; }
    apply(out);
    toast(`已${to ? `把 ${source} 换成 ${to}` : `删除 ${source}`}（${fmt(out.changes.length)} 格），可撤销`);
    setSource(to);
  };
  const recalc = () => {
    const next = countMatrixColors(st.matrix);
    if (countsEqual(st.counts, next)) { toast("用量已经和格子一致"); return; }
    apply({ matrix: st.matrix, counts: next });
    toast("已按格子重算用量，可撤销");
  };
  const cancel = () => {
    if (dirty && !window.confirm("放弃这次对格子的修改？")) return;
    onCancel();
  };

  // ---- 键盘（桌面）：E 橡皮 / B 画笔 / I 取色 / H 移动，1-3 笔刷大小，[ ] 换色，Ctrl+Z / Ctrl+Shift+Z 撤销重做 ----
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => undefined);
  keyRef.current = (e) => {
    if (document.querySelector('[role="dialog"][aria-modal="true"]')) return; // 弹层在最上面时不抢键
    const a = editorKey(e, e.target as HTMLElement | null);
    if (!a) return;
    e.preventDefault();
    if (a.type === "undo") setSt(undoEdit);
    else if (a.type === "redo") setSt(redoEdit);
    else if (a.type === "tool") setTool(a.tool);
    else if (a.type === "size") setSize(a.size);
    else if (a.type === "color") {
      const next = cycleCode(used, brush, a.dir);
      if (next) { setBrush(next); setSource(next); if (tool !== "brush") setTool("brush"); }
    }
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const KEYS: Record<MatrixTool, string> = { eraser: "E", brush: "B", pick: "I", pan: "H" };
  const toolBtn = (t: MatrixTool, label: string) => (
    <button type="button" aria-pressed={tool === t} onClick={() => setTool(t)} title={`${label}（${KEYS[t]}）`} aria-keyshortcuts={KEYS[t]}>{label}</button>
  );

  return (
    <div className="me">
      <div className="me-bar" role="toolbar" aria-label="格子编辑工具">
        <div className="seg" role="group" aria-label="工具">
          {toolBtn("eraser", "橡皮")}
          {toolBtn("brush", "画笔")}
          {toolBtn("pick", "取色")}
          {toolBtn("pan", "移动")}
        </div>
        <div className="seg" role="group" aria-label="笔刷大小">
          {([1, 2, 3] as const).map((n) => <button key={n} type="button" aria-pressed={size === n} onClick={() => setSize(n)} title={`笔刷 ${n}×${n}（${n}）`} aria-keyshortcuts={String(n)}>{n}×{n}</button>)}
        </div>
        <div className="me-actions">
          <button type="button" className="btn btn-sm" onClick={() => setSt(undoEdit)} disabled={!st.past.length} title="撤销（Ctrl+Z）" aria-keyshortcuts="Control+Z">撤销</button>
          <button type="button" className="btn btn-sm" onClick={() => setSt(redoEdit)} disabled={!st.future.length} title="重做（Ctrl+Shift+Z）" aria-keyshortcuts="Control+Shift+Z Control+Y">重做</button>
        </div>
      </div>

      <div className="me-color">
        <label className="field me-pick"><span>画笔颜色</span>
          <span className="me-select"><Swatch code={brush} />
            <select className="select" value={brush ?? ""} onChange={(e) => setBrush(e.target.value || null)}>
              {!brush ? <option value="">先选一个色号</option> : null}
              <optgroup label="图上用到的">{used.map((c) => <option key={c} value={c}>{c} · {colorOf(c)?.nameZh ?? "未知"}</option>)}</optgroup>
              <optgroup label="全部色号">{rest.map((c) => <option key={c} value={c}>{c} · {colorOf(c)?.nameZh ?? "未知"}</option>)}</optgroup>
            </select>
          </span>
        </label>
        <div className="me-chips" role="group" aria-label="图上用到的色号，点一下设为画笔色">
          {used.map((c) => (
            <button key={c} type="button" className="me-chip" aria-pressed={brush === c} onClick={() => { setBrush(c); if (tool !== "brush") setTool("brush"); }} title={colorOf(c)?.nameZh}>
              <Swatch code={c} />{c}
            </button>
          ))}
        </div>
      </div>

      <MatrixView matrix={st.matrix} width={width} height={height} focusCode={null}
        tool={tool} brushCode={brush} brushSize={size} onCellsChange={paint} onPickCode={pick} />

      <p className="meta" aria-live="polite">
        {tool === "eraser" ? "橡皮：点一格或按住拖动，去掉识别多出来的假豆子。"
          : tool === "brush" ? (brush ? `画笔：点或拖动，把格子改成 ${brush}。` : "画笔：先在上面选一个色号。")
          : tool === "pick" ? "取色：点图上的豆子，设为“原色”和画笔色。"
          : "移动：单指拖动平移，双指缩放。"}
        {" "}橡皮 / 画笔下双指缩放并拖动；电脑上按 ? 看快捷键。
      </p>

      <div className="me-whole">
        <div className="row">
          <span className="meta">整色替换</span>
          <label className="me-src">
            <Swatch code={source} />
            <select className="select" value={source ?? ""} onChange={(e) => setSource(e.target.value || null)} aria-label="原色（要被替换的颜色）">
              <option value="">选原色</option>
              {used.map((c) => <option key={c} value={c}>{c} · {fmt(st.counts[c] ?? 0)} 颗</option>)}
            </select>
          </label>
          <span className="meta" aria-hidden="true">→</span>
          <span className="chip"><Swatch code={brush} />{brush ?? "未选画笔色"}</span>
          <button type="button" className="btn btn-sm" onClick={() => replaceAll(brush)} disabled={!source || !brush || source === brush}>全部替换</button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => replaceAll(null)} disabled={!source}>删除该色</button>
        </div>
        <button type="button" className="btn btn-sm btn-ghost" onClick={recalc}>按格子重算用量</button>
      </div>

      <div className="me-foot">
        <span className="meta" role="status">{dirty ? `已改 ${fmt(changed)} 格；保存后会清除“已核对”。` : "还没有修改。"}</span>
        <div className="row">
          <button type="button" className="btn" onClick={cancel} disabled={saving}>取消</button>
          <button type="button" className="btn btn-primary" onClick={() => void onSave(st.matrix, st.counts, matrix)} disabled={!dirty || saving}>保存修改</button>
        </div>
      </div>
    </div>
  );
}
