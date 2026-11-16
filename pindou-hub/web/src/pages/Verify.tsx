// 快速核对：一张一屏，对照原图确认识别结果，一个动作决定“没问题 / 有问题 / 跳过”。队列逻辑见 lib/verifyQueue.ts。
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { getSnapshot, putRecords, useData } from "../lib/db";
import { METHOD_LABEL, totalOf, type Pattern } from "../lib/model";
import { matrixOf } from "../lib/matrix";
import { colorOf } from "../lib/palette";
import { Bead, Icon, fmt, navigate, useBlobUrl } from "../components/ui";
import MatrixView from "../components/pattern/MatrixView";
import ZoomImage from "../components/pattern/ZoomImage";
import {
  FLAG_TAG, REASON_MAX, applyFlag, applyOk, currentId, decide, newSession, progress, revertDecision, setOrder, summarize,
  swipeAxis, swipeDecision, swipeProgress, totalChecks, undo, type Decision, type QueueOrder, type Session
} from "../lib/verifyQueue";
import { loadSession, saveSession } from "../lib/verifySession";
import "../components/pattern/pattern.css";
import "./Verify.css";

const NARROW = "(max-width: 820px)";
function useNarrow(): boolean {
  return useSyncExternalStore(
    (l) => { const m = window.matchMedia(NARROW); m.addEventListener("change", l); return () => m.removeEventListener("change", l); },
    () => window.matchMedia(NARROW).matches,
    () => false
  );
}

const confClass = (c: number) => (c >= 0.8 ? "chip-leaf" : c >= 0.5 ? "chip-amber" : "chip-iron");
const DECISION_TEXT: Record<Decision, string> = { ok: "已标为没问题", flag: "已标为有问题", skip: "已跳过" };

export default function Verify() {
  const data = useData();
  const narrow = useNarrow();
  const [session, setSession] = useState<Session>(() => loadSession() ?? newSession());
  const [reason, setReason] = useState("");
  const [pane, setPane] = useState<"source" | "result">("source");
  const [focus, setFocus] = useState<string | null>(null);
  const [say, setSay] = useState("");
  const [dx, setDx] = useState(0);
  const originals = useRef(new Map<string, Pattern>());
  const busy = useRef(false);
  const swipe = useRef<{ x: number; y: number; t: number; axis: "x" | "y" | null; id: number } | null>(null);

  const alive = useMemo(() => data.patterns.filter((p) => !p.deleted), [data.patterns]);
  const curId = currentId(alive, session);
  const pattern = curId ? alive.find((p) => p.id === curId) : undefined;
  const prog = progress(alive, session);
  const sum = summarize(alive, session);
  const matrix = useMemo(() => (pattern ? matrixOf(pattern) : undefined), [pattern]);
  const sourceUrl = useBlobUrl(pattern?.imageId, "original");
  const previewUrl = useBlobUrl(pattern?.previewId, "original");

  useEffect(() => { setReason(""); setFocus(null); setDx(0); }, [curId]);

  const persist = (s: Session) => { setSession(s); saveSession(s); };

  const commit = async (d: Decision) => {
    if (!pattern || busy.current) return;
    busy.current = true;
    try {
      if (d !== "skip") {
        const live = getSnapshot().patterns.find((p) => p.id === pattern.id) ?? pattern;
        originals.current.set(pattern.id, live);
        const now = Date.now();
        await putRecords("patterns", [d === "ok" ? applyOk(live, now) : applyFlag(live, reason, now)]);
      }
      persist(decide(session, pattern.id, d));
      setSay(`${pattern.name}：${DECISION_TEXT[d]}`);
    } finally { busy.current = false; }
  };

  const doUndo = async () => {
    if (busy.current) return;
    const u = undo(session);
    if (!u.id || !u.was) return;
    busy.current = true;
    try {
      const live = getSnapshot().patterns.find((p) => p.id === u.id);
      if (live) {
        const back = revertDecision(live, u.was, originals.current.get(u.id), Date.now());
        if (back) await putRecords("patterns", [back]);
      }
      originals.current.delete(u.id);
      persist(u.session);
      setSay(`已撤销：${live?.name ?? ""}`);
    } finally { busy.current = false; }
  };

  // 键盘：永远拿最新的处理函数；在输入框 / 弹层里、或带修饰键时不响应
  const act = useRef({ commit, doUndo });
  act.current = { commit, doUndo };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const inZoom = !!t?.closest(".pt-zoom-box, [role=\"slider\"]");
      const onControl = !!t?.closest("button, a");
      const k = e.key;
      if (k === "ArrowRight" && !inZoom) { e.preventDefault(); void act.current.commit("ok"); }
      else if (k === "Enter" && !onControl) { e.preventDefault(); void act.current.commit("ok"); }
      else if (k === "ArrowLeft" && !inZoom) { e.preventDefault(); void act.current.commit("flag"); }
      else if (k === "s" || k === "S") { e.preventDefault(); void act.current.commit("skip"); }
      else if (k === "z" || k === "Z") { e.preventDefault(); void act.current.doUndo(); }
      else if (k === "Escape" && !inZoom) { e.preventDefault(); navigate("/gallery"); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // 横滑只在“信息区 + 决定条”里生效；看图区自己用单指拖动 / 双指缩放，互不干扰
  const onDown = (e: React.PointerEvent) => {
    if (e.pointerType === "mouse" || !pattern || (e.target as HTMLElement).closest("button, a, input, textarea, select")) return;
    swipe.current = { x: e.clientX, y: e.clientY, t: e.timeStamp, axis: null, id: e.pointerId };
  };
  const onMove = (e: React.PointerEvent) => {
    const s = swipe.current;
    if (!s || s.id !== e.pointerId) return;
    const mx = e.clientX - s.x, my = e.clientY - s.y;
    if (!s.axis) {
      s.axis = swipeAxis(mx, my);
      if (s.axis === "y") { swipe.current = null; return; }
      if (s.axis === "x") try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* 已释放 */ }
    }
    if (s.axis === "x") setDx(mx);
  };
  const onUp = (e: React.PointerEvent) => {
    const s = swipe.current;
    swipe.current = null;
    if (!s || s.axis !== "x") { setDx(0); return; }
    const d = swipeDecision(e.clientX - s.x, e.clientY - s.y, e.timeStamp - s.t);
    setDx(0);
    if (d) void commit(d);
  };
  const onCancel = () => { swipe.current = null; setDx(0); };

  const sp = swipeProgress(dx);
  const orderSeg = (
    <div className="seg" role="group" aria-label="核对顺序">
      <button aria-pressed={session.order === "confidence"} data-verify-order="confidence" onClick={() => persist(setOrder(session, "confidence" as QueueOrder))}>可信度低的先</button>
      <button aria-pressed={session.order === "newest"} data-verify-order="newest" onClick={() => persist(setOrder(session, "newest" as QueueOrder))}>最新的先</button>
    </div>
  );
  const undoBtn = (
    <button className="btn vf-undo" disabled={!session.history.length} onClick={() => void doUndo()} data-verify-undo aria-keyshortcuts="Z" aria-label="撤销上一个决定">
      <Icon name="back" />撤销<span className="vf-key">Z</span>
    </button>
  );

  // ---- 没有可核对的 / 全部做完 ----
  if (!pattern) {
    const hadAny = session.history.length > 0;
    return (
      <div className="vf" data-verify-page data-verify-end={hadAny ? "done" : "empty"}>
        <div className="page-head"><div><h1>快速核对</h1><p>{hadAny ? "这一轮核对完了" : "没有需要核对的图纸"}</p></div><div className="row">{hadAny ? undoBtn : null}<a className="btn" href="#/gallery">回图库</a></div></div>
        <div className="sr-only" role="status" aria-live="polite">{say}</div>
        {hadAny ? (
          <section className="panel panel-pad stack vf-end">
            <div className="vf-sum">
              <div className="vf-sum-cell ok"><b className="num" data-verify-count="ok">{sum.ok.length}</b><span>没问题，已核对</span></div>
              <div className="vf-sum-cell flag"><b className="num" data-verify-count="flag">{sum.flag.length}</b><span>有问题，已标「{FLAG_TAG}」</span></div>
              <div className="vf-sum-cell skip"><b className="num" data-verify-count="skip">{sum.skip.length}</b><span>跳过</span></div>
            </div>
            {sum.flag.length ? (
              <div>
                <h3>有问题的图纸</h3>
                <ul className="vf-flagged">
                  {sum.flag.map((id) => {
                    const p = data.patterns.find((x) => x.id === id);
                    return p ? (
                      <li key={id}>
                        <a className="vf-flag-link" href={`#/pattern/${id}`} data-verify-flagged-link>
                          <span className="vf-flag-name">{p.name}</span>
                          {p.reviewNote ? <span className="meta">{p.reviewNote}</span> : null}
                          <Icon name="chevron" size={16} />
                        </a>
                      </li>
                    ) : null;
                  })}
                </ul>
                <p className="meta">打开后可以直接改格子；改完点「标为已核对」。图库里按标签「{FLAG_TAG}」也能找到它们。</p>
              </div>
            ) : null}
            <div className="row">
              {sum.skip.length ? <button className="btn btn-iron" data-verify-redo onClick={() => { persist(newSession(session.order, sum.skip)); }}>再看一遍跳过的 {sum.skip.length} 张</button> : null}
              <a className="btn" href="#/gallery">回图库</a>
            </div>
          </section>
        ) : (
          <div className="empty pegboard"><h3>图纸都核对过了</h3><p>新导入的图纸会出现在这里。</p><a className="btn btn-iron" href="#/gallery">回图库</a></div>
        )}
      </div>
    );
  }

  // ---- 一张图纸 ----
  const total = totalOf(pattern.counts);
  const entries = Object.entries(pattern.counts).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const gridTotal = matrix ? matrix.reduce((a, row) => a + row.reduce((b, c) => b + (c ? 1 : 0), 0), 0) : null;
  const gridDiff = gridTotal != null && gridTotal !== total;
  const stated = totalChecks(total, gridTotal, pattern.statedTotal).stated;
  const showSource = !narrow || pane === "source";
  const showResult = !narrow || pane === "result";

  const sourceView = sourceUrl ? <ZoomImage key={`s${pattern.id}`} src={sourceUrl} alt="原图" /> : <div className="empty pegboard vf-empty">{pattern.imageId ? "原图同步中…" : "这张图纸没有原图"}</div>;
  const resultView = matrix && pattern.width && pattern.height
    ? <MatrixView key={`m${pattern.id}`} matrix={matrix} width={pattern.width} height={pattern.height} focusCode={focus} />
    : previewUrl ? <ZoomImage key={`p${pattern.id}`} src={previewUrl} alt="识别结果预览" /> : <div className="empty pegboard vf-empty">没有可显示的识别结果</div>;

  return (
    <div className="vf" data-verify-page data-verify-id={pattern.id}>
      <div className="page-head">
        <div>
          <h1>快速核对</h1>
          <p data-verify-progress aria-live="polite">第 <b className="num">{prog.index}</b> / {prog.total} 张 · 已处理 {prog.done}</p>
        </div>
        <div className="row">{orderSeg}<a className="btn" href="#/gallery" aria-keyshortcuts="Escape" data-verify-leave>离开</a></div>
      </div>
      <div className="sr-only" role="status" aria-live="polite">{say}</div>
      <div className="pt-progress vf-bar" role="progressbar" aria-label="核对进度" aria-valuemin={0} aria-valuemax={prog.total} aria-valuenow={prog.done}><i style={{ transform: `scaleX(${prog.total ? prog.done / prog.total : 0})` }} /></div>

      <div className="vf-title row">
        <h2 className="vf-name">{pattern.name}</h2>
        <a className="btn btn-sm" href={`#/pattern/${pattern.id}`} data-verify-open title="打开详情页修改格子；改完按浏览器的返回键，会回到这里的同一张">打开详情页编辑</a>
      </div>

      {narrow ? (
        <div className="seg vf-pane-seg" role="group" aria-label="看哪一边">
          <button aria-pressed={pane === "source"} data-verify-pane="source" onClick={() => setPane("source")}>原图</button>
          <button aria-pressed={pane === "result"} data-verify-pane="result" onClick={() => setPane("result")}>识别结果</button>
        </div>
      ) : null}
      <div className="vf-views" data-verify-views>
        {showSource ? <section className="panel vf-view" aria-label="原图">{!narrow ? <h3 className="vf-view-h">原图</h3> : null}{sourceView}</section> : null}
        {showResult ? <section className="panel vf-view" aria-label="识别结果">{!narrow ? <h3 className="vf-view-h">识别结果</h3> : null}{resultView}</section> : null}
      </div>

      <div className="vf-swipe" data-verify-swipe data-dir={sp > 0.05 ? "ok" : sp < -0.05 ? "flag" : undefined}
        style={{ ["--vf-p" as string]: Math.abs(sp), transform: dx ? `translateX(${dx * 0.4}px)` : undefined }}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onCancel}>
        <span className="vf-swipe-tag ok" aria-hidden="true" style={{ opacity: Math.max(0, sp) }}><Icon name="check" />没问题</span>
        <span className="vf-swipe-tag flag" aria-hidden="true" style={{ opacity: Math.max(0, -sp) }}>有问题<Icon name="x" /></span>
        <section className="panel panel-pad stack vf-facts" aria-label="要核对的信息">
          <div className="vf-facts-row">
            <span><b className="num">{pattern.width && pattern.height ? `${pattern.width}×${pattern.height}` : "—"}</b> <span className="meta">格</span></span>
            <span><b className="num">{fmt(total)}</b> <span className="meta">颗</span></span>
            <span><b className="num">{entries.length}</b> <span className="meta">色</span></span>
            <span className="meta">{METHOD_LABEL[pattern.method]}</span>
          </div>
          <div className="row">
            {pattern.confidence != null ? <span className={`chip ${confClass(pattern.confidence)}`} data-verify-confidence>整体可信度 {Math.round(pattern.confidence * 100)}%</span> : <span className="chip">没有可信度</span>}
            {pattern.colorMatch != null ? <span className="chip">颜色匹配 {Math.round(pattern.colorMatch * 100)}%</span> : null}
            {gridTotal != null ? <span className={`chip ${gridDiff ? "chip-amber" : "chip-leaf"}`} data-verify-gridtotal>格子 {fmt(gridTotal)} 颗{gridDiff ? ` ≠ 用量 ${fmt(total)} 颗` : " = 用量"}</span> : null}
            {stated ? <span className={`chip ${stated.same ? "chip-leaf" : "chip-amber"}`} data-verify-statedtotal>图上标注 {fmt(stated.value)} 颗{stated.same ? " = 用量" : ` ≠ 用量 ${fmt(total)} 颗`}</span> : null}
            {pattern.tags.includes(FLAG_TAG) ? <span className="chip chip-iron">之前标过{FLAG_TAG}</span> : null}
          </div>
          {pattern.reviewReasons?.length ? (
            <ul className="vf-reasons" data-verify-reasons>{pattern.reviewReasons.map((r) => <li key={r}>{r}</li>)}</ul>
          ) : null}
          {pattern.reviewNote ? <p className="meta">上次的备注：{pattern.reviewNote}</p> : null}
          <div className="vf-counts" role="group" aria-label="各色用量，点一下在识别结果上高亮">
            {entries.map(([code, n]) => (
              <button key={code} type="button" className="vf-count" aria-pressed={focus === code} title={colorOf(code)?.nameZh} onClick={() => { setFocus(focus === code ? null : code); setPane("result"); }}>
                <Bead code={code} size={16} /><span className="code">{code}</span><span className="num">{fmt(n)}</span>
              </button>
            ))}
          </div>
          <label className="field vf-reason"><span>有问题的话，简单写原因（可不写）</span>
            <input className="input" data-verify-reason value={reason} maxLength={REASON_MAX} placeholder="如：左下角颜色读错" onChange={(e) => setReason(e.target.value)} />
          </label>
          <p className="meta vf-hint"><span className="vf-hint-touch">在这块区域向右滑 = 没问题，向左滑 = 有问题。</span><span className="vf-hint-kb">键盘：→ 或 Enter 没问题，← 有问题，S 跳过，Z 撤销，Esc 离开。</span></p>
        </section>
      </div>

      <div className="vf-actions" role="group" aria-label="决定">
        <button className="btn vf-btn flag" onClick={() => void commit("flag")} data-verify-flag aria-keyshortcuts="ArrowLeft"><Icon name="x" />有问题<span className="vf-key">←</span></button>
        <button className="btn vf-btn skip" onClick={() => void commit("skip")} data-verify-skip aria-keyshortcuts="s">跳过<span className="vf-key">S</span></button>
        <button className="btn vf-btn ok" onClick={() => void commit("ok")} data-verify-ok aria-keyshortcuts="ArrowRight Enter"><Icon name="check" />没问题<span className="vf-key">→</span></button>
        {undoBtn}
      </div>
    </div>
  );
}
