// 按库存换色：图纸详情里的小卡片 + 预览弹层，图库里的“全部按库存换色”弹层。
import { useMemo, useState } from "react";
import { getSnapshot, putRecords, useData } from "../../lib/db";
import { stockByCode } from "../../lib/inventory";
import { totalOf, type Pattern } from "../../lib/model";
import { matrixOf } from "../../lib/matrix";
import {
  BLOCK_TEXT, RECOLOR_MODE_LABEL, allowedCodes, hasBuildProgress, outsideColors, planBatch, planRecolor, recolorBlock, restoreRecolor,
  type RecolorMode, type RecolorPlan
} from "../../lib/recolor";
import { BeadCode, Sheet, fmt, toast } from "../ui";
import { buildRecolored, saveRecolored } from "./stockRecolorApply";
import "./StockRecolor.css";

const MODES: RecolorMode[] = ["managed", "instock"];

function useAllowed(mode: RecolorMode) {
  const data = useData();
  const stock = useMemo(() => stockByCode(data.txns), [data.txns]);
  return useMemo(() => allowedCodes(mode, data.prefs.kitId, stock), [mode, data.prefs.kitId, stock]);
}

function ModeSwitch({ mode, onChange }: { mode: RecolorMode; onChange: (m: RecolorMode) => void }) {
  return (
    <div className="seg" role="group" aria-label="换成哪些颜色" data-recolor-mode>
      {MODES.map((m) => <button type="button" key={m} aria-pressed={mode === m} data-recolor-mode-btn={m} onClick={() => onChange(m)}>{RECOLOR_MODE_LABEL[m]}</button>)}
    </div>
  );
}

function labelClass(label: string): string {
  return label === "差别明显" ? "chip-amber" : label === "相近" ? "" : "chip-leaf";
}

function PlanTable({ plan }: { plan: RecolorPlan }) {
  return (
    <div className="sr-rows" data-recolor-rows>
      {plan.rows.map((r) => (
        <div className="sr-row" key={r.from} data-recolor-row={r.from}>
          <span className="sr-pair">
            <BeadCode code={r.from} />
            <span className="sr-arrow" aria-label="换成">→</span>
            <BeadCode code={r.to} />
          </span>
          <span className="sr-meta"><span className="num">{fmt(r.count)}</span> 颗</span>
          <span className={`chip ${labelClass(r.label)}`} title={`色差 ${r.deltaE.toFixed(1)}`}>{r.label}</span>
        </div>
      ))}
      {plan.unknown.length ? <p className="meta">色卡里没有的色号不会动：{plan.unknown.map((u) => `${u.code}（${fmt(u.count)} 颗）`).join("、")}</p> : null}
    </div>
  );
}

/** 图纸详情：有范围外的颜色（或已换过色）才显示。 */
export function StockRecolorCard({ pattern }: { pattern: Pattern }) {
  const data = useData();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<RecolorMode>("managed");
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const managed = useAllowed("managed");
  const allowed = useAllowed(mode);
  const outside = useMemo(() => outsideColors(pattern.counts, managed), [pattern.counts, managed]);
  const plan = useMemo(() => planRecolor({ counts: pattern.counts, matrix: matrixOf(pattern) }, allowed), [pattern, allowed]);
  void data;
  const rec = pattern.stockRecolor;
  const block = recolorBlock(pattern);
  const progress = hasBuildProgress(pattern);
  if (!outside.length && !rec) return null;
  const outsideBeads = outside.reduce((a, o) => a + o.count, 0);

  const apply = async () => {
    if (busy || !plan.rows.length) return;
    setBusy(true);
    try {
      const before = pattern;
      const { next, stale } = await buildRecolored(pattern, plan, mode);
      await saveRecolored([next]);
      setOpen(false);
      setAck(false);
      toast(`已换色：${plan.changedColors} 种颜色、${fmt(plan.changedBeads)} 颗${stale ? "（预览图没能重画，还是旧颜色）" : ""}`, {
        label: "撤销", run: () => void putRecords("patterns", [{ ...before, updatedAt: Math.max(Date.now(), next.updatedAt + 1) }])
      });
    } catch (e) { toast(e instanceof Error ? `换色失败：${e.message}` : "换色失败"); } finally { setBusy(false); }
  };
  const restore = async () => {
    const patch = restoreRecolor(pattern, Date.now());
    if (!patch) return;
    const before = pattern;
    await putRecords("patterns", [{ ...pattern, ...patch } as Pattern]);
    toast("已恢复原来的颜色", { label: "撤销", run: () => void putRecords("patterns", [{ ...before, updatedAt: Date.now() + 2 }]) });
  };

  return (
    <div className="panel panel-pad stack sr-card" data-recolor-card role="region" aria-label="按库存换色">
      {outside.length ? (
        <p>这张图纸有 <b className="num">{outside.length}</b> 种颜色不在你的套装/库存里（共 <b className="num">{fmt(outsideBeads)}</b> 颗）：{outside.slice(0, 6).map((o) => o.code).join("、")}{outside.length > 6 ? " 等" : ""}</p>
      ) : <p>这张图纸已经按你的库存换过色了。</p>}
      {block ? <p className="meta" data-recolor-blocked>{BLOCK_TEXT[block]}。</p> : null}
      {rec ? <p className="meta">换过 {rec.map.length} 种颜色，可以恢复成原来的样子。</p> : null}
      <div className="row">
        {outside.length && !block ? <button className="btn btn-primary" data-recolor-open onClick={() => { setAck(false); setOpen(true); }}>按库存换色…</button> : null}
        {rec ? <button className="btn" data-recolor-restore onClick={() => void restore()}>恢复原色</button> : null}
      </div>
      {open ? (
        <Sheet title="按库存换色" onClose={() => setOpen(false)}
          footer={<>
            <button className="btn" onClick={() => setOpen(false)}>取消</button>
            <button className="btn btn-primary" data-recolor-confirm disabled={busy || !plan.rows.length || (progress && !ack)} onClick={() => void apply()}>确认换色</button>
          </>}>
          <div className="stack" data-recolor-sheet>
            <ModeSwitch mode={mode} onChange={setMode} />
            {plan.reason && !plan.rows.length ? <p className="notice" role="note">{plan.reason}。</p> : (
              <>
                <p className="meta">共 <b className="num">{fmt(plan.beads)}</b> 颗，换 <b className="num">{plan.changedColors}</b> 种颜色（<b className="num">{fmt(plan.changedBeads)}</b> 颗），总颗数不变{plan.noticeable ? `；其中 ${plan.noticeable} 种差别明显，建议看一眼` : ""}。</p>
                <PlanTable plan={plan} />
              </>
            )}
            {progress ? (
              <label className="sr-ack notice" role="note">
                <input type="checkbox" data-recolor-ack checked={ack} onChange={(e) => setAck(e.target.checked)} />
                <span>这张图纸已经拼了一部分。已拼的格子仍记作“已拼”，但按新颜色算；实际已经放上去的豆子颜色不会变。确认要继续。</span>
              </label>
            ) : null}
            <p className="meta">换色后可以随时在这张图纸里点“恢复原色”。库存和采购清单会按新颜色计算。</p>
          </div>
        </Sheet>
      ) : null}
    </div>
  );
}

/** 图库：全部图纸一起换。点“全部按库存换色”打开；没有受影响的图纸时按钮不可用。 */
export function StockRecolorAllSheet({ onClose, onDone }: { onClose: () => void; onDone: (message: string) => void }) {
  const data = useData();
  const [mode, setMode] = useState<RecolorMode>("managed");
  const [busy, setBusy] = useState(false);
  const allowed = useAllowed(mode);
  const summary = useMemo(() => planBatch(data.patterns, allowed), [data.patterns, allowed]);
  const skipped = summary.skippedDone + summary.skippedConsumed + summary.skippedProgress;
  const n = summary.patterns.length;

  const apply = async () => {
    if (busy || !n) return;
    setBusy(true);
    try {
      const byId = new Map(getSnapshot().patterns.map((p) => [p.id, p]));
      const originals: Pattern[] = [];
      const nexts: Pattern[] = [];
      let stale = 0;
      for (const item of summary.patterns) {
        const p = byId.get(item.id);
        if (!p) continue;
        const r = await buildRecolored(p, item.plan, mode);
        originals.push(p); nexts.push(r.next); if (r.stale) stale += 1;
      }
      await saveRecolored(nexts);
      const m = `已给 ${nexts.length} 张图纸换色（${summary.colors} 种颜色、${fmt(summary.beads)} 颗）${stale ? `，${stale} 张的预览图没能重画` : ""}`;
      toast(m, { label: "撤销", run: () => void putRecords("patterns", originals.map((p) => ({ ...p, updatedAt: Date.now() + 2 }))) });
      onDone(m);
    } catch (e) { toast(e instanceof Error ? `换色失败：${e.message}` : "换色失败"); } finally { setBusy(false); }
  };

  return (
    <Sheet title="全部按库存换色" onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn btn-primary" data-recolor-all-confirm disabled={busy || !n} onClick={() => void apply()}>确认给 {n} 张换色</button>
      </>}>
      <div className="stack" data-recolor-all-sheet>
        <ModeSwitch mode={mode} onChange={setMode} />
        {n ? (
          <p>会改 <b className="num">{n}</b> 张图纸，共 <b className="num">{summary.colors}</b> 种颜色、<b className="num">{fmt(summary.beads)}</b> 颗；其中 <b className="num" data-recolor-noticeable>{summary.noticeable}</b> 处“差别明显”（图纸里的某个颜色换后和原来看着不太一样）。</p>
        ) : <p className="notice" role="note">{allowed.length ? "没有需要换色的图纸：能换的图纸用的颜色都在你的范围内。" : "没有可换成的颜色：套装和库存里都没有可用的色号。"}</p>}
        {skipped ? (
          <p className="meta" data-recolor-skipped>
            另有 {skipped} 张不会动：{[
              summary.skippedDone ? `${summary.skippedDone} 张已完成` : "",
              summary.skippedConsumed ? `${summary.skippedConsumed} 张已扣库存` : "",
              summary.skippedProgress ? `${summary.skippedProgress} 张拼装进行中（可以进图纸里单独换）` : ""
            ].filter(Boolean).join("、")}。
          </p>
        ) : null}
        <p className="meta">每张图纸都能在详情页点“恢复原色”。已有预览图的图纸会用新颜色重画。总颗数 {fmt(data.patterns.filter((p) => !p.deleted).reduce((a, p) => a + totalOf(p.counts), 0))} 不变。</p>
      </div>
    </Sheet>
  );
}

/** 图库菜单里显示用：受影响的张数（不含会跳过的）。 */
export function useRecolorCount(): number {
  const data = useData();
  const stock = useMemo(() => stockByCode(data.txns), [data.txns]);
  const allowed = useMemo(() => allowedCodes("managed", data.prefs.kitId, stock), [data.prefs.kitId, stock]);
  return useMemo(() => planBatch(data.patterns, allowed).patterns.length, [data.patterns, allowed]);
}
