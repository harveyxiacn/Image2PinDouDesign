// 焦点元素：队列清单——每一张的状态一眼可见（等待 / 识别中 / 完成 / 不是图纸 / 失败）。
import { useEffect, useMemo, useRef, useState } from "react";
import { announceFor, itemProgress, summarize, isImageFile, isHashName, type BatchItem } from "../../lib/batch";
import { METHOD_LABEL, totalOf, type PatternStatus } from "../../lib/model";
import { Icon, fmt, toast, DiffNumber } from "../ui";
import Progress from "./Progress";
import { batchStore, cancelRemaining, enqueue, retryItem, saveIdea, saveItem, useBatch } from "./batchRunner";
import "./batch.css";

const isNative = () => /capacitor/i.test(typeof navigator !== "undefined" ? navigator.userAgent : "") || !!(globalThis as { Capacitor?: unknown }).Capacitor;

type FsFile = { kind: "file"; name: string; getFile: () => Promise<File> };
type FsDir = { kind: "directory"; name: string; values: () => AsyncIterableIterator<FsFile | FsDir> };
type FolderPicker = (opts?: { mode?: "read" }) => Promise<FsDir>;

/** File System Access API 不支持时返回 null，调用方退回 <input webkitdirectory>。 */
function folderPicker(): FolderPicker | null {
  const picker = (window as unknown as { showDirectoryPicker?: FolderPicker }).showDirectoryPicker;
  return typeof picker === "function" ? picker.bind(window) : null;
}

/** 递归读取目录；保留 root/子目录/文件名，交给 folderOf 取上级目录作为标签。 */
async function filesOf(dir: FsDir, prefix: string, out: File[]): Promise<void> {
  for await (const entry of dir.values()) {
    if (entry.kind === "file") {
      const file = await entry.getFile();
      try { Object.defineProperty(file, "webkitRelativePath", { value: `${prefix}/${entry.name}` }); } catch { /* 只读实现：标签留空 */ }
      out.push(file);
    } else if (entry.name !== "node_modules" && !entry.name.startsWith(".")) {
      await filesOf(entry, `${prefix}/${entry.name}`, out);
    }
  }
}

function StatusChip({ it }: { it: BatchItem }) {
  if (it.savedId) return <span className="chip chip-leaf"><Icon name="check" size={12} />已保存</span>;
  if (it.verifiedAt) return <span className="chip chip-leaf"><Icon name="check" size={12} />已核对</span>;
  switch (it.state) {
    case "waiting": return <span className="chip">等待</span>;
    case "running": return <span className="chip chip-amber">识别中</span>;
    case "done": return it.review ? <span className="chip chip-amber"><Icon name="alert" size={12} />需要检查</span> : <span className="chip chip-leaf"><Icon name="check" size={12} />完成</span>;
    case "notchart": return <span className="chip">不是图纸</span>;
    case "duplicate": return <span className="chip chip-leaf"><Icon name="check" size={12} />已存在</span>;
    case "failed": return <span className="chip chip-iron">失败</span>;
    case "cancelled": return <span className="chip">已取消</span>;
  }
}

export default function BatchPanel({ onReview, onGenerate }: { onReview: (item: BatchItem) => void; onGenerate: (file: File) => void }) {
  const items = useBatch();
  const sum = useMemo(() => summarize(items), [items]);
  const files = useRef<HTMLInputElement>(null);
  const folder = useRef<HTMLInputElement>(null);
  const [plan, setPlan] = useState(false);
  const [saving, setSaving] = useState(false);
  const [over, setOver] = useState(false);
  const [live, setLive] = useState("");
  const prev = useRef(new Map<string, string>());
  const status: PatternStatus = plan ? "planned" : "idea";

  // 每张识别结束时播报一句（live region）
  useEffect(() => {
    const now = new Map<string, string>();
    for (const it of items) {
      now.set(it.id, it.state);
      const before = prev.current.get(it.id);
      if (before === "running" && it.state !== "running" && it.state !== "waiting") setLive(announceFor(it));
    }
    prev.current = now;
  }, [items]);

  const take = (list: FileList | File[] | null | undefined) => {
    const all = Array.from(list ?? []);
    const imgs = all.filter(isImageFile);
    if (!imgs.length) { if (all.length) toast("没有找到图片文件"); return; }
    enqueue(imgs);
    if (imgs.length < all.length) toast(`已忽略 ${all.length - imgs.length} 个非图片文件`);
  };

  const saveAll = async (acceptAll = false) => {
    setSaving(true);
    let n = 0;
    let verified = 0;
    try {
      for (const it of batchStore.get()) {
        if (it.state === "done" && !it.savedId && (acceptAll || !it.review)) {
          if (await saveItem(it, status)) { n++; if (it.verifiedAt) verified++; }
        }
      }
      toast(n ? `${acceptAll ? `已保存 ${n} 张到图库，${n - verified} 张未核对` : `已保存 ${n} 张到图库`}${verified ? `（其中 ${verified} 张已核对）` : ""}` : "没有可保存的");
    } catch (e) { toast(e instanceof Error ? e.message : "保存失败"); }
    finally { setSaving(false); }
  };
  const saveOne = async (it: BatchItem) => {
    try { await saveItem(it, status); toast(`已保存“${it.name}”`); } catch (e) { toast(e instanceof Error ? e.message : "保存失败"); }
  };

  const empty = items.length === 0;
  const native = isNative();
  const pickFolder = async () => {
    const picker = folderPicker();
    if (!picker) { folder.current?.click(); return; }
    try {
      const root = await picker({ mode: "read" });
      const list: File[] = [];
      await filesOf(root, root.name, list);
      take(list);
    } catch (e) {
      if ((e as DOMException)?.name !== "AbortError") toast(e instanceof Error ? `读取文件夹失败：${e.message}` : "读取文件夹失败");
    }
  };
  const unsavedDone = items.filter((it) => it.state === "done" && !it.savedId).length;
  const hashItems = items.filter((it) => !it.savedId && isHashName(it.name));
  const notchartItems = items.filter((it) => it.state === "notchart" && !it.savedId);
  const renameByFolder = () => {
    let n = 0;
    for (const it of hashItems) {
      const base = it.folder || "图纸";
      batchStore.dispatch({ type: "name", id: it.id, name: `${base}-${String(++n).padStart(2, "0")}` });
    }
    toast(`已按文件夹名改名 ${hashItems.length} 张`);
  };
  const saveIdeas = async () => {
    let n = 0;
    try {
      for (const it of notchartItems) if (await saveIdea(it)) n++;
      toast(n ? `已把 ${n} 张存为收藏（不进入采购）` : "没有可保存的");
    } catch (e) { toast(e instanceof Error ? e.message : "保存失败"); }
  };

  return (
    <div className="bt-wrap stack">
      <div
        className={`pt-drop pegboard bt-drop${empty ? "" : " compact"}`} data-over={over}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); take(e.dataTransfer.files); }}
      >
        <span className="pt-drop-icon"><Icon name="upload" /></span>
        <div>
          <h3>{empty ? "一次选很多张图纸" : "继续添加"}</h3>
          {empty ? <p className="meta">逐张自动识别，识别完可一起保存到图库。{native ? "" : "推荐选整个文件夹：文件夹名会作为标签，并按内容哈希自动跳过重复图片。"}</p> : null}
        </div>
        <div className="row bt-pick">
          {!native ? <button type="button" className="btn btn-primary" onClick={() => void pickFolder()}><Icon name="gallery" />选择文件夹</button> : null}
          <button type="button" className={native ? "btn btn-primary" : "btn"} onClick={() => files.current?.click()}><Icon name="plus" />选择多张图片</button>
        </div>
        <input ref={files} type="file" accept="image/*" multiple hidden aria-label="选择多张图片" onChange={(e) => { take(e.target.files); e.target.value = ""; }} />
        {!native ? (
          <input ref={folder} type="file" hidden aria-label="选择文件夹"
            {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
            onChange={(e) => { take(e.target.files); e.target.value = ""; }} />
        ) : null}
      </div>

      {!empty ? (
        <section className="panel" aria-label="批量识别队列">
          <div className="panel-head bt-head">
            <div>
              <h3>队列 <span className="meta num">{sum.total - sum.waiting - sum.running}/{sum.total}</span></h3>
              <p className="meta bt-sum">
                {[sum.done ? `${sum.done} 张完成` : "", sum.review ? `${sum.review} 张需要检查` : "", sum.notchart ? `${sum.notchart} 张不是图纸` : "", sum.duplicate ? `${sum.duplicate} 张已存在` : "", sum.failed ? `${sum.failed} 张失败` : "", sum.cancelled ? `${sum.cancelled} 张已取消` : ""].filter(Boolean).join(" · ") || "准备开始…"}
              </p>
            </div>
            <div className="row">
              {sum.active ? <button type="button" className="btn btn-sm" onClick={cancelRemaining}>取消剩余</button> : null}
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => batchStore.dispatch({ type: "clear" })} disabled={sum.total === sum.waiting + sum.running}>清空已处理</button>
            </div>
          </div>
          <Progress value={sum.active ? sum.progress : 1} label="批量识别进度" className="bt-bar" />

          <ul className="bt-list">
            {items.map((it) => (
              <li key={it.id} className="bt-item" data-state={it.state} data-review={it.review} data-verified={!!it.verifiedAt} data-saved={!!it.savedId}>
                <div className="bt-main">
                  <div className="bt-title">
                    <input className="input bt-name bt-name-input" value={it.name} aria-label={`${it.name} 的名称`} disabled={!!it.savedId} onChange={(e) => batchStore.dispatch({ type: "name", id: it.id, name: e.target.value })} />
                    {isHashName(it.name) ? <span className="chip chip-amber" title="文件名像哈希值，建议改成可读的名称">哈希名</span> : null}
                    <StatusChip it={it} />
                  </div>
                  <div className="bt-detail meta">
                    {it.state === "running" ? <>{it.steps.length ? `${it.steps[it.steps.length - 1].label}…` : "正在载入…"}</> : null}
                    {it.state === "done" && it.result ? (
                      <>
                        <span className="chip">{METHOD_LABEL[it.result.method === "none" ? "manual" : it.result.method]}</span>{" "}
                        <b className="num">{fmt(totalOf(it.result.counts))}</b> 颗 · <span className="num">{Object.keys(it.result.counts).length}</span> 色 · 整体 <span className="num">{Math.round(it.result.confidence * 100)}%</span>
                        {it.result.colorMatch != null ? <> · 颜色 <span className="num">{Math.round(it.result.colorMatch * 100)}%</span></> : null}
                        {it.result.cellCoverage != null ? <> · 格内色号 <span className="num">{Math.round(it.result.cellCoverage * 100)}%</span></> : null}
                        {it.review ? <span className="bt-why"> · {it.reasons.join("；")}</span> : null}
                      </>
                    ) : null}
                    {it.state === "notchart" ? <>{it.error || "没有找到拼豆格子或色号图例"}</> : null}
                    {it.state === "duplicate" ? <>图库里已经有同一张图（SHA-256 相同），已跳过识别</> : null}
                    {it.state === "failed" ? <>{it.error}</> : null}
                    {it.state === "waiting" ? <>排队中</> : null}
                    {it.state === "cancelled" ? <>未识别</> : null}
                  </div>
                  {it.state === "running" ? <Progress value={itemProgress(it)} label={`${it.name} 识别进度`} className="bt-item-bar" /> : null}
                </div>
                <div className="bt-tools">
                  <label className="bt-tag">
                    <span className="sr-only">{it.name} 的标签</span>
                    <input className="input" value={it.tag} placeholder="标签" onChange={(e) => batchStore.dispatch({ type: "tag", id: it.id, tag: e.target.value })} disabled={!!it.savedId} />
                  </label>
                  {it.state === "done" && !it.savedId ? (
                    <>
                      {it.review ? <button type="button" className="btn btn-sm btn-iron" onClick={() => onReview(it)}>检查</button> : <button type="button" className="btn btn-sm" onClick={() => onReview(it)}>查看</button>}
                      {it.review ? <button type="button" className="btn btn-sm btn-ghost" onClick={() => batchStore.dispatch({ type: "verify", id: it.id })}>标为已核对</button> : null}
                      {it.review ? <button type="button" className="btn btn-sm btn-ghost" onClick={() => void saveOne(it)}>仍然保存</button> : <button type="button" className="btn btn-sm" onClick={() => void saveOne(it)}>保存</button>}
                    </>
                  ) : null}
                  {it.state === "notchart" ? (
                    <>
                      <button type="button" className="btn btn-sm btn-iron" onClick={() => onGenerate(it.file)}><Icon name="wand" />用它生成图纸</button>
                      <button type="button" className="btn btn-sm btn-ghost" onClick={() => onReview(it)}>仍按图纸识别</button>
                    </>
                  ) : null}
                  {it.state === "failed" || it.state === "cancelled" ? <button type="button" className="btn btn-sm" onClick={() => retryItem(it.id)}>重试</button> : null}
                  {it.state === "duplicate" ? <button type="button" className="btn btn-sm" onClick={() => retryItem(it.id)}>仍然识别</button> : null}
                  {!it.savedId && it.state !== "running" ? <button type="button" className="btn btn-sm btn-ghost bt-x" aria-label={`移除 ${it.name}`} onClick={() => batchStore.dispatch({ type: "remove", id: it.id })}><Icon name="x" /></button> : null}
                  {it.savedId ? <a className="btn btn-sm btn-ghost" href={`#/pattern/${it.savedId}`}>打开</a> : null}
                </div>
              </li>
            ))}
          </ul>

          <div className="bt-foot">
            <div className="seg" role="group" aria-label="保存后的状态">
              <button type="button" aria-pressed={!plan} onClick={() => setPlan(false)}>收藏</button>
              <button type="button" aria-pressed={plan} onClick={() => setPlan(true)}>计划拼</button>
            </div>
            <span className="spacer" />
            <span className="meta">{unsavedDone ? <><DiffNumber value={unsavedDone} /> 张待保存</> : "没有待保存的"}{sum.review ? `，${sum.review} 张带检查提示` : ""}</span>
            {hashItems.length ? <button type="button" className="btn btn-sm" onClick={renameByFolder}>按文件夹改名 {hashItems.length}</button> : null}
            {notchartItems.length ? <button type="button" className="btn" onClick={() => void saveIdeas()}>把 {notchartItems.length} 张不是图纸的存为收藏</button> : null}
            {sum.savable && sum.review ? <button type="button" className="btn" onClick={() => void saveAll(false)} disabled={saving}>{saving ? "保存中…" : `只保存干净项 ${sum.savable}`}</button> : null}
            <button type="button" className="btn btn-iron" onClick={() => void saveAll(true)} disabled={!unsavedDone || saving}>{saving ? "保存中…" : "接受全部并保存"}</button>
          </div>
          {sum.saved && !sum.savable ? <p className="meta bt-done"><a href="#/gallery">去图库看看 →</a></p> : null}
        </section>
      ) : null}

      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{live}</div>
    </div>
  );
}
