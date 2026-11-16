// 焦点元素：拼豆图纸本身（可缩放的图）与它旁边的用量/库存缺口表。
import { useEffect, useMemo, useState } from "react";
import { putRecords, softDelete, useData } from "../lib/db";
import { consumeTxns, countsToCsv, stockByCode, compareCodes, planReopen, readiness, refundTxns, reopenedPattern } from "../lib/inventory";
import { METHOD_LABEL, STATUS_LABEL, totalOf, type Counts, type Pattern, type PatternStatus } from "../lib/model";
import { colorOf } from "../lib/palette";
import { Icon, Sheet, fmt, fmtTime, navigate, toast, useBlobUrl, useRoute, DiffNumber } from "../components/ui";
import MatrixView from "../components/pattern/MatrixView";
import MatrixEditor from "../components/pattern/MatrixEditor";
import { editedPatternPatch } from "../lib/patternEdit";
import ZoomImage from "../components/pattern/ZoomImage";
import DetailTable from "../components/pattern/DetailTable";
import CountsEditor from "../components/pattern/CountsEditor";
import { cleanCounts } from "../components/pattern/save";
import { matrixOf } from "../lib/matrix";
import { parseTags } from "../components/pattern/SaveForm";
import { WorkFields, draftToInput, newDraft, type WorkDraft } from "../components/worklog/WorkFields";
import { WorkPanel } from "../components/worklog/WorkPanel";
import { StockRecolorCard } from "../components/pattern/StockRecolor";
import { completedPattern, withCompletionUndone } from "../lib/worklog";
import { releaseImages } from "../lib/images";
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
  const inventoryReady = !!data.prefs.inventoryStartedAt || data.txns.some((t) => !t.deleted);
  const previewUrl = useBlobUrl(pattern?.previewId);
  const sourceUrl = useBlobUrl(pattern?.imageId);
  const [view, setView] = useState<View | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [editing, setEditing] = useState<Counts | null>(null);
  const [confirm, setConfirm] = useState(false);
  // 已完成的图纸要改回别的状态：先问扣掉的豆子怎么处理
  const [reopen, setReopen] = useState<PatternStatus | null>(null);
  const [tagText, setTagText] = useState("");
  const [editingCells, setEditingCells] = useState(false);
  const [editDirty, setEditDirty] = useState(false);
  const [liveCounts, setLiveCounts] = useState<Counts | null>(null);
  const [savingCells, setSavingCells] = useState(false);
  // 标记完成时顺手记下的完工信息（日期、照片、评分、标签、用时、备注）
  const [draft, setDraft] = useState<WorkDraft>(() => newDraft(Date.now()));
  const [completing, setCompleting] = useState(false);
  useEffect(() => { if (confirm) setDraft(newDraft(Date.now(), pattern?.build)); }, [confirm]); // eslint-disable-line react-hooks/exhaustive-deps
  const askDone = useRoute().query.get("done") === "1";
  // 从拼装模式完成后跳回来：自动打开“标记完成”（只开一次）
  useEffect(() => { if (askDone && pattern && pattern.status !== "done") setConfirm(true); }, [askDone, !!pattern]); // eslint-disable-line react-hooks/exhaustive-deps

  // 有未保存的格子修改时，点任何站内链接（导航栏等）都先确认；关闭标签页由 useLeaveGuard 负责
  useEffect(() => {
    if (!editDirty) return;
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement | null)?.closest?.("a[href^='#/']");
      if (a && !window.confirm("格子的修改还没保存，确定离开吗？")) { e.preventDefault(); e.stopPropagation(); }
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [editDirty]);

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
  const matrix = matrixOf(pattern);
  const hasMatrix = !!matrix && !!pattern.width && !!pattern.height;
  const available: View[] = [...(hasMatrix ? ["matrix" as const] : []), ...(pattern.previewId ? ["preview" as const] : []), ...(pattern.imageId ? ["source" as const] : [])];
  const current: View | null = view && available.includes(view) ? view : available[0] ?? null;
  const used = Object.keys(pattern.counts).filter((c) => pattern.counts[c] > 0).length;

  const startBuild = () => {
    if (pattern.status === "idea" || pattern.status === "planned") void save({ status: "making" });
    navigate(`/build/${pattern.id}`);
  };
  const closeCellEditor = () => { setEditingCells(false); setEditDirty(false); setLiveCounts(null); };
  const saveCells = async (edited: NonNullable<typeof matrix>, counts: Counts, original: NonNullable<typeof matrix>) => {
    const patch = editedPatternPatch(pattern, original, edited, counts);
    if (!patch) { closeCellEditor(); return; }
    const before = pattern;
    setSavingCells(true);
    try {
      await save(patch);
      closeCellEditor();
      toast("格子修改已保存", { label: "撤销", run: () => void putRecords("patterns", [{ ...before, updatedAt: Date.now() + 1 }]) });
    } catch (e) { toast(e instanceof Error ? `保存失败：${e.message}` : "保存失败"); }
    finally { setSavingCells(false); }
  };

  const rename = async () => {
    const name = (renaming ?? "").trim();
    setRenaming(null);
    if (name && name !== pattern.name) await save({ name });
  };

  const reopenPlan = planReopen(pattern, data.txns);
  const setStatus = (s: PatternStatus) => {
    if (s === pattern.status) return;
    if (s === "done") { setConfirm(true); return; }
    if (pattern.status === "done" && reopenPlan.ask) { setReopen(s); return; }
    // 没扣过库存的完成（或扣的记录已找不到）：直接改状态；若带着“已扣库存”标记则一并清掉
    if (pattern.status !== "done") { void putRecords("patterns", [{ ...pattern, status: s, updatedAt: Math.max(Date.now(), pattern.updatedAt + 1) }]); return; }
    // 刚刚才标记完成、记录还是空白的，多半是点错了：把那条空记录一起撤掉（可撤销）；有照片/备注的真实记录不动
    const before = pattern;
    const at = Date.now();
    const { pattern: cleaned, removed } = withCompletionUndone(pattern, at, { onlyBlankWithin: 30 * 60_000 });
    void putRecords("patterns", [reopenedPattern(cleaned, s, at)]);
    if (removed) toast(`已改回${STATUS_LABEL[s]}，刚才那条空白的完工记录也撤掉了`, { label: "撤销", run: () => void putRecords("patterns", [{ ...before, updatedAt: Date.now() + 2 }]) });
  };

  /** 重新打开已完成的图纸。refund = 把当初扣的豆子用新的“调整”流水放回库存；否则库存保持不变。 */
  const reopenTo = async (s: PatternStatus, refund: boolean) => {
    setReopen(null);
    const before = pattern;
    const at = Date.now();
    const refunds = refund ? refundTxns(reopenPlan.originals, pattern, STATUS_LABEL[s], data.device.deviceId, at) : [];
    if (refunds.length) await putRecords("txns", refunds);
    // 选“放回库存”= 当初点错了：这次完成留下的完工记录一并撤掉；选“保持已扣除”= 做成了，记录留着
    const { pattern: cleaned, removed } = refund ? withCompletionUndone(pattern, at) : { pattern, removed: undefined };
    await putRecords("patterns", [reopenedPattern(cleaned, s, at)]);
    releaseImages([removed?.photoId]);
    const back = refunds.reduce((a, t) => a + t.delta, 0);
    const tail = removed ? "，这次的完工记录也撤掉了" : "";
    toast(back > 0 ? `已改回${STATUS_LABEL[s]}，${fmt(back)} 颗豆子放回了库存${tail}` : `已改回${STATUS_LABEL[s]}，库存保持已扣除${tail}`, {
      label: "撤销",
      run: async () => {
        if (refunds.length) await softDelete("txns", refunds.map((t) => t.id));
        await putRecords("patterns", [{ ...before, updatedAt: Date.now() + 2 }]);
      }
    });
  };

  const complete = async (deduct: boolean) => {
    if (completing) return;
    setCompleting(true);
    const before = pattern;
    let input: Awaited<ReturnType<typeof draftToInput>>;
    try { input = await draftToInput(draft, Date.now()); } finally { setCompleting(false); }
    setConfirm(false);
    if (input.photoFailed) toast("照片没存上，已不带照片记录完成");
    const finish = (base: Pattern) => putRecords("patterns", [completedPattern(base, input.input)]);
    if (deduct && !pattern.consumed) {
      const txns = consumeTxns(pattern, data.device.deviceId);
      await putRecords("txns", txns);
      await finish({ ...pattern, consumed: true });
      toast(`已完成，扣除 ${fmt(total * copies)} 颗`, {
        label: "撤销",
        run: async () => {
          await softDelete("txns", txns.map((t) => t.id));
          await putRecords("patterns", [{ ...before, updatedAt: Date.now() }]);
          releaseImages([input.input.photoId], 0); // 撤销后这次新存的成品照片没人用了
        }
      });
    } else {
      await finish(pattern);
      toast("已标记完成", { label: "撤销", run: async () => { await putRecords("patterns", [{ ...before, updatedAt: Date.now() }]); releaseImages([input.input.photoId], 0); } });
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

  const short = confirm && !pattern.consumed ? readiness(pattern, stock).missing : [];

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
          {pattern.confidence != null ? <span className={`chip ${pattern.confidence >= 0.8 ? "chip-leaf" : pattern.confidence >= 0.5 ? "chip-amber" : "chip-iron"}`} title="综合颜色、图例差异、图上标注与网格容量；有疑点时最高 69%">整体可信度 {Math.round(pattern.confidence * 100)}%</span> : null}
          {pattern.colorMatch != null ? <span className="chip" title="只看格子颜色与色卡的吻合度">颜色匹配 {Math.round(pattern.colorMatch * 100)}%</span> : null}
          {pattern.verifiedAt == null ? (
            <button className="btn btn-sm" onClick={() => void save({ verifiedAt: Date.now() }).then(() => toast("已标为核对过"))}>标为已核对</button>
          ) : <span className="chip chip-leaf"><Icon name="check" size={12} />已核对</span>}
          {pattern.consumed ? <span className="chip chip-leaf">已扣库存</span> : null}
        </div>
      </header>

      {pattern.reviewReasons?.length ? (
        <div className="notice" role="note" style={{ marginBottom: 12 }}>
          <span><b>保存时的自动检查：</b>{pattern.reviewReasons.join("；")}。{pattern.verifiedAt == null ? "对照原图确认后，点上方「标为已核对」。" : ""}</span>
        </div>
      ) : null}

      <div className="pd-grid">
        <section className="panel panel-pad pd-image stack">
          {(available.length > 1 && !editingCells) || (current === "matrix" && matrix && !editingCells) ? (
            <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
              {available.length > 1 ? (
                <div className="seg" role="group" aria-label="图片视图">
                  {available.map((v) => <button key={v} aria-pressed={current === v} onClick={() => setView(v)}>{v === "matrix" ? "拼豆图" : v === "preview" ? "预览图" : "原图"}</button>)}
                </div>
              ) : <span />}
              {current === "matrix" && matrix ? <button className="btn btn-sm" onClick={() => { setFocus(null); setEditingCells(true); }}><Icon name="edit" />编辑格子</button> : null}
            </div>
          ) : null}
          {current === "matrix" && matrix && editingCells ? (
            <MatrixEditor matrix={matrix} counts={pattern.counts} width={pattern.width!} height={pattern.height!}
              onSave={saveCells} onCancel={closeCellEditor} onCountsChange={setLiveCounts} onDirtyChange={setEditDirty} saving={savingCells} />
          ) : current === "matrix" && matrix ? (
            <MatrixView matrix={matrix} width={pattern.width!} height={pattern.height!} focusCode={focus} />
          ) : current === "preview" ? (
            previewUrl ? <ZoomImage src={previewUrl} alt="预览图" /> : <div className="empty pegboard">图片同步中…</div>
          ) : current === "source" ? (
            sourceUrl ? <ZoomImage src={sourceUrl} alt="原图" /> : <div className="empty pegboard">图片同步中…</div>
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
            {editing ? <CountsEditor counts={editing} onChange={setEditing} /> : <DetailTable counts={editingCells && liveCounts ? liveCounts : pattern.counts} copies={copies} stock={stock} inventoryReady={inventoryReady} focusCode={focus} onPick={(c) => setFocus((f) => (f === c ? null : c))} />}
          </div>

          <StockRecolorCard pattern={pattern} />

          <div className="panel panel-pad stack">
            <div className="pd-actions">
              {hasMatrix && pattern.status !== "done" ? <button className="btn btn-primary" onClick={startBuild}>{pattern.build ? "继续拼" : "开始拼"}</button> : null}
              {pattern.status !== "done" ? <button className="btn btn-iron" onClick={() => setConfirm(true)} disabled={!total}><Icon name="check" />标记完成</button> : null}
              {hasMatrix ? <a className="btn" href={`#/print/${pattern.id}`} data-print-link>打印分板图纸</a> : null}
              <button className="btn" onClick={exportCsv} disabled={!total}><Icon name="download" />导出 CSV</button>
              <button className="btn" onClick={copyUsage} disabled={!total}><Icon name="copy" />复制用量</button>
              <button className="btn btn-ghost" onClick={remove}><Icon name="trash" />删除</button>
            </div>
          </div>

          <WorkPanel pattern={pattern} />

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
            <button className="btn" disabled={completing} onClick={() => void complete(false)}>只标记完成</button>
            {!pattern.consumed ? <button className="btn btn-iron" disabled={completing} onClick={() => void complete(true)}>扣除库存并完成</button> : null}
          </>}>
          {pattern.consumed ? <p>这张图纸已经扣过库存，只会更新状态。</p> : <p>将从库存扣除 <b className="num">{fmt(total * copies)}</b> 颗（<b className="num">{used}</b> 色{copies > 1 ? `，${copies} 份` : ""}）。库存不足的色号会变成负数，之后可在“豆盒库存”里盘点修正。</p>}
          {!pattern.consumed && inventoryReady && short.length ? (
            <div data-short-list>
              <p className="meta" style={{ marginTop: 8 }}>其中 <b className="num">{short.length}</b> 个色号库存不够，扣完会变成负数：</p>
              <p style={{ marginTop: 4 }}>{short.slice(0, 8).map((m) => <span className="chip chip-amber" key={m.code} style={{ marginRight: 6, marginBottom: 4 }}>{m.code} 差 {fmt(m.need - m.have)}</span>)}{short.length > 8 ? <span className="meta">等 {short.length} 个</span> : null}</p>
            </div>
          ) : null}
          <h4 className="wk-sheet-h">完工记录（都可以不填，之后也能补）</h4>
          <WorkFields draft={draft} now={Date.now()} onChange={setDraft} />
        </Sheet>
      ) : null}
      {reopen ? (
        <Sheet title="重新打开这张图纸" onClose={() => setReopen(null)}
          footer={<>
            <button className="btn" data-reopen-keep onClick={() => void reopenTo(reopen, false)}>保持已扣除</button>
            <button className="btn btn-primary" data-reopen-refund onClick={() => void reopenTo(reopen, true)}>把豆子放回库存</button>
          </>}>
          <div data-reopen-ask>
            <p>这张图纸标记完成时，从库存扣掉了 <b className="num">{fmt(reopenPlan.beads)}</b> 颗（<b className="num">{reopenPlan.colors}</b> 色）。要改成“{STATUS_LABEL[reopen]}”，这些豆子怎么处理？</p>
            <p className="meta"><b>放回库存</b>：当初是点错了、其实没拼，豆子会作为一条新的“调整”记录加回来（记录里能看到）。<br /><b>保持已扣除</b>：这张已经拼好了，你想再拼一份，库存不变。</p>
            <p className="meta">两种选择都会让图纸重新出现在采购清单里；之后可以在提示里撤销。</p>
          </div>
        </Sheet>
      ) : null}
    </div>
  );
}
