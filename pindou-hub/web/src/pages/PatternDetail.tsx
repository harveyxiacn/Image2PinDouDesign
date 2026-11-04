// 焦点元素：拼豆图纸本身（可缩放的图）与它旁边的用量/库存缺口表。
import { useMemo, useState } from "react";
import { putRecords, softDelete, useData } from "../lib/db";
import { consumeTxns, countsToCsv, stockByCode, compareCodes } from "../lib/inventory";
import { METHOD_LABEL, STATUS_LABEL, totalOf, type Counts, type Pattern, type PatternStatus } from "../lib/model";
import { colorOf } from "../lib/palette";
import { Icon, Sheet, fmt, fmtTime, navigate, toast, useBlobUrl, DiffNumber } from "../components/ui";
import MatrixView from "../components/pattern/MatrixView";
import ZoomPan from "../components/pattern/ZoomPan";
import DetailTable from "../components/pattern/DetailTable";
import CountsEditor from "../components/pattern/CountsEditor";
import { cleanCounts } from "../components/pattern/save";
import { parseTags } from "../components/pattern/SaveForm";
import "../components/pattern/pattern.css";
import "./PatternDetail.css";

const STEPS: PatternStatus[] = ["idea", "planned", "making", "done"];
type View = "matrix" | "preview" | "source";

function download(name: string, blob: Blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* 局域网 http 页面没有剪贴板权限，走兜底 */ }
  const ta = document.createElement("textarea");
  ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.select();
  const ok = document.execCommand("copy");
  ta.remove();
  return ok;
}

export default function PatternDetail({ id }: { id: string }) {
  const data = useData();
  const pattern = data.patterns.find((p) => p.id === id);
  const stock = useMemo(() => stockByCode(data.txns), [data.txns]);
  const previewUrl = useBlobUrl(pattern?.previewId);
  const sourceUrl = useBlobUrl(pattern?.imageId);
  const [view, setView] = useState<View | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [editing, setEditing] = useState<Counts | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [tagText, setTagText] = useState("");

  if (!pattern) {
    return (
      <div className="empty pegboard pd-notfound">
        <h3>找不到这张图纸</h3>
        <p>它可能已被删除，或还没从其他设备同步过来。</p>
        <a className="btn" href="#/gallery"><Icon name="back" />回到图库</a>
      </div>
    );
  }

  const save = (patch: Partial<Pattern>) => putRecords("patterns", [{ ...pattern, ...patch, updatedAt: Math.max(Date.now(), pattern.updatedAt + 1) }]);
  const copies = Math.max(1, pattern.copies || 1);
  const total = totalOf(pattern.counts);
  const hasMatrix = !!pattern.matrix && !!pattern.width && !!pattern.height;
  const available: View[] = [...(hasMatrix ? ["matrix" as const] : []), ...(pattern.previewId ? ["preview" as const] : []), ...(pattern.imageId ? ["source" as const] : [])];
  const current: View | null = view && available.includes(view) ? view : available[0] ?? null;
  const used = Object.keys(pattern.counts).filter((c) => pattern.counts[c] > 0).length;

  const rename = async () => {
    const name = (renaming ?? "").trim();
    setRenaming(null);
    if (name && name !== pattern.name) await save({ name });
  };

  const setStatus = (s: PatternStatus) => {
    if (s === pattern.status) return;
    if (s === "done") { setConfirm(true); return; }
    void save({ status: s });
  };

  const complete = async (deduct: boolean) => {
    setConfirm(false);
    const before = pattern;
    if (deduct && !pattern.consumed) {
      const txns = consumeTxns(pattern, data.device.deviceId);
      await putRecords("txns", txns);
      await save({ consumed: true, status: "done" });
      toast(`已完成，扣除 ${fmt(total * copies)} 颗`, {
        label: "撤销",
        run: async () => {
          await softDelete("txns", txns.map((t) => t.id));
          await putRecords("patterns", [{ ...before, updatedAt: Date.now() }]);
        }
      });
    } else {
      await save({ status: "done" });
      toast("已标记完成", { label: "撤销", run: () => void putRecords("patterns", [{ ...before, updatedAt: Date.now() }]) });
    }
  };

  const remove = async () => {
    if (!window.confirm(`删除“${pattern.name}”？`)) return;
    const before = pattern;
    await softDelete("patterns", [pattern.id]);
    navigate("/gallery");
    toast("已删除图纸", { label: "撤销", run: () => void putRecords("patterns", [{ ...before, deleted: false, updatedAt: Date.now() + 1 }]) });
  };

  const rowsFor = () => Object.keys(pattern.counts).filter((c) => pattern.counts[c] > 0).sort((a, b) => pattern.counts[b] - pattern.counts[a] || compareCodes(a, b));
  const exportCsv = () => {
    const rows = rowsFor().map((c) => ({ code: c, name: colorOf(c)?.nameZh ?? "", each: pattern.counts[c], total: pattern.counts[c] * copies, stock: Math.max(0, stock[c] ?? 0), gap: Math.max(0, pattern.counts[c] * copies - Math.max(0, stock[c] ?? 0)) }));
    const csv = countsToCsv(rows, [["code", "色号"], ["name", "颜色"], ["each", "每份"], ["total", `×${copies} 份`], ["stock", "库存"], ["gap", "缺口"]]);
    download(`${pattern.name}-用量.csv`, new Blob([csv], { type: "text/csv;charset=utf-8" }));
  };
  const copyUsage = async () => {
    const text = `${pattern.name}${copies > 1 ? `（×${copies} 份）` : ""}\n` + rowsFor().map((c) => `${c} ${pattern.counts[c] * copies}`).join("\n") + `\n共 ${fmt(total * copies)} 颗，${used} 色`;
    toast((await copyText(text)) ? "用量已复制" : "复制失败，请手动选择");
  };

  const addTags = () => {
    const add = parseTags(tagText);
    setTagText("");
    if (add.length) void save({ tags: Array.from(new Set([...pattern.tags, ...add])) });
  };

  return (
    <div>
      <a className="btn btn-ghost btn-sm" href="#/gallery" style={{ marginBottom: 8 }}><Icon name="back" />图库</a>
      <header className="pd-head">
        <div className="pd-title">
          {renaming !== null ? (
            <input className="input" autoFocus value={renaming} onChange={(e) => setRenaming(e.target.value)} onBlur={rename}
              onKeyDown={(e) => { if (e.key === "Enter") void rename(); if (e.key === "Escape") setRenaming(null); }} aria-label="图纸名称" />
          ) : (
            <>
              <h1>{pattern.name}</h1>
              <button className="btn btn-ghost btn-sm" onClick={() => setRenaming(pattern.name)} aria-label="重命名"><Icon name="edit" /></button>
            </>
          )}
        </div>
        <div className="pd-controls">
          <div className="seg" role="group" aria-label="状态">
            {STEPS.map((s) => <button key={s} aria-pressed={pattern.status === s} onClick={() => setStatus(s)}>{STATUS_LABEL[s]}</button>)}
          </div>
          <div className="pd-stepper" role="group" aria-label="份数">
            <span className="meta">份数</span>
            <button className="btn btn-sm" onClick={() => void save({ copies: Math.max(1, copies - 1) })} disabled={copies <= 1} aria-label="减少一份">−</button>
            <b style={{ minWidth: 24, textAlign: "center" }} aria-live="polite"><DiffNumber value={copies} format={String} /></b>
            <button className="btn btn-sm" onClick={() => void save({ copies: Math.min(99, copies + 1) })} aria-label="增加一份">+</button>
          </div>
          <span className="meta">{METHOD_LABEL[pattern.method]} · {fmt(total)} 颗 · {used} 色{pattern.width ? ` · ${pattern.width}×${pattern.height}` : ""} · 更新 {fmtTime(pattern.updatedAt)}</span>
          {pattern.consumed ? <span className="chip chip-leaf">已扣库存</span> : null}
        </div>
      </header>

      <div className="pd-grid">
        <section className="panel panel-pad pd-image stack">
          {available.length > 1 ? (
            <div className="seg" role="group" aria-label="图片视图" style={{ alignSelf: "flex-start" }}>
              {available.map((v) => <button key={v} aria-pressed={current === v} onClick={() => setView(v)}>{v === "matrix" ? "拼豆图" : v === "preview" ? "预览图" : "原图"}</button>)}
            </div>
          ) : null}
          {current === "matrix" && pattern.matrix ? (
            <MatrixView matrix={pattern.matrix} width={pattern.width!} height={pattern.height!} focusCode={focus} />
          ) : current === "preview" ? (
            previewUrl ? <ZoomPan label="预览图"><img src={previewUrl} alt="预览图" /></ZoomPan> : <div className="empty pegboard">图片同步中…</div>
          ) : current === "source" ? (
            sourceUrl ? <ZoomPan label="原图"><img src={sourceUrl} alt="原图" /></ZoomPan> : <div className="empty pegboard">图片同步中…</div>
          ) : <div className="empty pegboard"><h3>没有图片</h3><p>这张图纸是手动录入的</p></div>}
          {focus ? (
            <div className="row">
              <span className="chip chip-iron">高亮 {focus}</span>
              <button className="btn btn-sm btn-ghost" onClick={() => setFocus(null)}>取消高亮</button>
              {current !== "matrix" && hasMatrix ? <button className="btn btn-sm" onClick={() => setView("matrix")}>在拼豆图上查看</button> : null}
            </div>
          ) : null}
          {focus && !hasMatrix ? <p className="meta">这张图纸没有保存每格的颜色，无法在图上高亮。</p> : null}
        </section>

        <section className="stack">
          <div className="panel">
            <div className="panel-head">
              <h3>用量与库存</h3>
              {editing ? (
                <div className="row">
                  <button className="btn btn-sm btn-ghost" onClick={() => setEditing(null)}>取消</button>
                  <button className="btn btn-sm btn-primary" onClick={async () => { await save({ counts: cleanCounts(editing), confidence: 1 }); setEditing(null); toast("用量已更新"); }}>保存</button>
                </div>
              ) : <button className="btn btn-sm" onClick={() => setEditing({ ...pattern.counts })}><Icon name="edit" />编辑用量</button>}
            </div>
            {editing ? <CountsEditor counts={editing} onChange={setEditing} /> : <DetailTable counts={pattern.counts} copies={copies} stock={stock} focusCode={focus} onPick={(c) => setFocus((f) => (f === c ? null : c))} />}
          </div>

          <div className="panel panel-pad stack">
            <div className="pd-actions">
              {pattern.status !== "done" ? <button className="btn btn-iron" onClick={() => setConfirm(true)} disabled={!total}><Icon name="check" />标记完成</button> : null}
              <button className="btn" onClick={exportCsv} disabled={!total}><Icon name="download" />导出 CSV</button>
              <button className="btn" onClick={copyUsage} disabled={!total}><Icon name="copy" />复制用量</button>
              <button className="btn btn-ghost" onClick={remove}><Icon name="trash" />删除</button>
            </div>
          </div>

          <div className="panel panel-pad stack">
            <span className="label">标签</span>
            <div className="pd-tags">
              {pattern.tags.map((t) => (
                <span className="chip" key={t}>{t}<button aria-label={`移除标签 ${t}`} onClick={() => void save({ tags: pattern.tags.filter((x) => x !== t) })}><Icon name="x" size={12} /></button></span>
              ))}
              <form onSubmit={(e) => { e.preventDefault(); addTags(); }} style={{ display: "flex", gap: 6 }}>
                <input className="input" style={{ width: 140, height: 28 }} placeholder="添加标签" value={tagText} onChange={(e) => setTagText(e.target.value)} aria-label="添加标签" />
              </form>
            </div>
            <label className="field"><span>备注</span>
              <textarea className="textarea" key={pattern.updatedAt} defaultValue={pattern.notes} placeholder="例如：用哪块板、烫多久…" onBlur={(e) => { if (e.target.value !== pattern.notes) void save({ notes: e.target.value }); }} />
            </label>
          </div>
        </section>
      </div>

      {confirm ? (
        <Sheet title="标记完成" onClose={() => setConfirm(false)}
          footer={<>
            <button className="btn" onClick={() => void complete(false)}>只标记完成</button>
            {!pattern.consumed ? <button className="btn btn-iron" onClick={() => void complete(true)}>扣除库存并完成</button> : null}
          </>}>
          {pattern.consumed ? <p>这张图纸已经扣过库存，只会更新状态。</p> : <p>将从库存扣除 <b className="num">{fmt(total * copies)}</b> 颗（<b className="num">{used}</b> 色{copies > 1 ? `，${copies} 份` : ""}）。库存不足的色号会变成负数，之后可在“豆盒库存”里盘点修正。</p>}
        </Sheet>
      ) : null}
    </div>
  );
}
