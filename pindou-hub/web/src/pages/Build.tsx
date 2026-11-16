// 拼装模式：手机放在拼板旁边，一块板一块板、一个颜色一个颜色地拼。
// 进度存在图纸记录的 build 字段里（随图纸同步），1.5 秒防抖写入，离开页面时立即写入。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { putRecords, getSnapshot, useData } from "../lib/db";
import {
  BOARD_SIZES, DEFAULT_BOARD_SIZE, boardCells, boardColors, boardProgress, boardSizeLabel, cellAt, decodeDone, describeRow, encodeDone,
  firstOpenBoard, migrateFlags, moveColor, newFlags, nextStep, overallProgress, restoreState, rowColumns, rowsWithColor, setCells, splitBoards,
  type BuildMode, type BuildState
} from "../lib/build";
import { matrixOf, type Matrix } from "../lib/matrix";
import { colorOf } from "../lib/palette";
import { Icon, Sheet, navigate, prefersReducedMotion } from "../components/ui";
import BuildCanvas, { type BuildCanvasApi } from "../components/build/BuildCanvas";
import { buildKey } from "../lib/shortcuts";
import BoardMap from "../components/build/BoardMap";
import "./Build.css";

const EMPTY: Matrix = [];
type Undo = { indices: number[]; value: boolean; board?: number; colorIndex?: number };

export default function Build({ id }: { id: string }) {
  const data = useData();
  const pattern = data.patterns.find((p) => p.id === id && !p.deleted);
  const matrix = useMemo(() => (pattern ? matrixOf(pattern) : undefined), [pattern?.matrix, pattern?.matrixRle]); // eslint-disable-line react-hooks/exhaustive-deps
  const m = matrix ?? EMPTY;
  const width = pattern?.width || m[0]?.length || 0;
  const height = pattern?.height || m.length || 0;
  const usable = !!pattern && !!matrix && width > 0 && height > 0;

  const [ready, setReady] = useState(false);
  const [boardSize, setBoardSizeState] = useState<number>(DEFAULT_BOARD_SIZE);
  const [board, setBoard] = useState(0);
  const [colorIndex, setColorIndex] = useState(0);
  const [mode, setMode] = useState<BuildMode>("color");
  const [rowPos, setRowPos] = useState(0);
  const [version, setVersion] = useState(0);
  const [mapOpen, setMapOpen] = useState(false);
  const [cele, setCele] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [note, setNote] = useState("");
  const flagsRef = useRef<Uint8Array>(new Uint8Array(0));
  const undoRef = useRef<Undo[]>([]);
  const lastMatrix = useRef<{ matrix: Matrix; width: number; height: number } | null>(null);

  // ---- 读取已保存的进度（只在第一次拿到图纸时）；之后图纸被改动则迁移完成标记 ----
  useEffect(() => {
    if (!usable || !pattern || !matrix) return;
    if (!ready) {
      const saved = pattern.build;
      const size = saved && (BOARD_SIZES as readonly number[]).includes(saved.boardSize) ? saved.boardSize : DEFAULT_BOARD_SIZE;
      const boards = splitBoards(width, height, size);
      const flags = decodeDone(saved?.done, matrix, width, height);
      const rs = restoreState(saved, boards, size);
      flagsRef.current = flags;
      lastMatrix.current = { matrix, width, height };
      setBoardSizeState(size);
      setBoard(saved ? rs.board : firstOpenBoard(matrix, flags, width, boards));
      setColorIndex(rs.colorIndex);
      setMode(rs.mode);
      setReady(true);
      return;
    }
    const last = lastMatrix.current;
    if (last && (last.matrix !== matrix || last.width !== width || last.height !== height)) {
      flagsRef.current = migrateFlags(last.matrix, flagsRef.current, last.width, last.height, matrix, width, height);
      lastMatrix.current = { matrix, width, height };
      undoRef.current = [];
      setVersion((v) => v + 1);
      markDirty();
    }
  }); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- 派生数据 ----
  const boards = useMemo(() => splitBoards(width, height, boardSize), [width, height, boardSize]);
  const boardIdx = Math.min(board, Math.max(0, boards.length - 1));
  const curBoard = boards[boardIdx];
  const colors = useMemo(() => (curBoard ? boardColors(m, curBoard) : []), [m, curBoard]);
  const counts = useMemo(() => boards.map((b) => boardColors(m, b).length), [m, boards]);
  const ci = Math.min(colorIndex, Math.max(0, colors.length - 1));
  const cur = colors[ci];
  const flags = flagsRef.current;
  const overall = useMemo(() => (ready ? overallProgress(m, flagsRef.current, width, height) : { total: 0, done: 0, percent: 0 }), [m, width, height, version, ready]);
  const boardProg = useMemo(() => (ready && curBoard ? boardProgress(m, flagsRef.current, width, curBoard) : { total: 0, done: 0, percent: 0 }), [m, width, curBoard, version, ready]);
  const colorProg = useMemo(() => (ready && curBoard && cur ? boardProgress(m, flagsRef.current, width, curBoard, cur.code) : { total: 0, done: 0, percent: 0 }), [m, width, curBoard, cur?.code, version, ready]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = useMemo(() => (curBoard && cur ? rowsWithColor(m, curBoard, cur.code) : []), [m, curBoard, cur?.code]); // eslint-disable-line react-hooks/exhaustive-deps
  const rowIdx = Math.min(rowPos, Math.max(0, rows.length - 1));
  const rowY = mode === "row" && rows.length ? rows[rowIdx] : null;
  const rowXs = rowY !== null && curBoard && cur ? rowColumns(m, curBoard, cur.code, rowY) : [];
  const rowDone = rowY !== null ? rowXs.filter((x) => flags[rowY * width + x] === 1).length : 0;
  const finished = ready && overall.total > 0 && overall.done >= overall.total;
  const announce = cur && curBoard ? `${cur.code}，第 ${boardIdx + 1} 板，${cur.count} 颗${note ? `。${note}` : ""}` : note;

  // ---- 持久化 ----
  const live = useRef({ boardSize, board: boardIdx, colorIndex: ci, mode, matrix: m, width, height, ready });
  live.current = { boardSize, board: boardIdx, colorIndex: ci, mode, matrix: m, width, height, ready };
  const dirty = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const flush = useCallback(() => {
    window.clearTimeout(timer.current);
    if (!dirty.current) return;
    dirty.current = false;
    const l = live.current;
    if (!l.ready) return;
    const p = getSnapshot().patterns.find((x) => x.id === id);
    if (!p || p.deleted) return;
    const next: BuildState = { boardSize: l.boardSize, board: l.board, colorIndex: l.colorIndex, mode: l.mode, done: encodeDone(l.matrix, flagsRef.current, l.width, l.height), updatedAt: Date.now() };
    const old = p.build;
    if (!old && next.done === `w${l.width}`) return; // 还没拼过任何格子：不要因为打开页面就改图纸
    if (old && old.boardSize === next.boardSize && old.board === next.board && old.colorIndex === next.colorIndex && old.mode === next.mode && old.done === next.done) return;
    void putRecords("patterns", [{ ...p, build: next, updatedAt: Math.max(Date.now(), p.updatedAt + 1) }]);
  }, [id]);
  const flushRef = useRef(flush);
  flushRef.current = flush;
  function markDirty() {
    dirty.current = true;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => flushRef.current(), 1500);
  }
  useEffect(() => { if (ready) markDirty(); }, [boardSize, boardIdx, ci, mode, ready]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onHide = () => { if (document.visibilityState === "hidden") flushRef.current(); };
    const onPageHide = () => flushRef.current();
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onPageHide);
      flushRef.current();
    };
  }, []);

  // ---- 屏幕常亮 ----
  useEffect(() => {
    let lock: WakeLockSentinel | null = null;
    let dead = false;
    const acquire = async () => {
      try {
        if (document.visibilityState !== "visible") return;
        const l = await navigator.wakeLock?.request("screen");
        if (!l) return;
        if (dead) { void l.release().catch(() => undefined); return; }
        lock = l;
      } catch { /* 浏览器不支持或被拒绝：不影响使用 */ }
    };
    const onVis = () => { if (document.visibilityState === "visible") void acquire(); };
    void acquire();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      dead = true;
      document.removeEventListener("visibilitychange", onVis);
      try { void lock?.release().catch(() => undefined); } catch { /* 忽略 */ }
    };
  }, []);

  useEffect(() => { if (!cele) return; const t = window.setTimeout(() => setCele(null), 1500); return () => window.clearTimeout(t); }, [cele]);
  useEffect(() => { if (!note) return; const t = window.setTimeout(() => setNote(""), 2500); return () => window.clearTimeout(t); }, [note]);

  // ---- 操作 ----
  const goto = (b: number, c: number) => { setBoard(b); setColorIndex(c); setRowPos(0); };
  const record = (changed: number[], value: boolean, withPos: boolean) => {
    if (!changed.length) return;
    undoRef.current.push({ indices: changed, value, ...(withPos ? { board: boardIdx, colorIndex: ci } : {}) });
    if (undoRef.current.length > 200) undoRef.current.shift();
    setVersion((v) => v + 1);
    markDirty();
  };
  const celebrate = (text: string) => { if (!prefersReducedMotion()) setCele(text); setNote(text); };

  const finishColor = () => {
    if (!cur || !curBoard) return;
    const changed = setCells(flagsRef.current, boardCells(m, width, curBoard, cur.code), true);
    record(changed, true, true);
    const step = nextStep(m, flagsRef.current, width, boards, boardIdx, ci);
    if (step.kind === "color") goto(step.board, step.colorIndex);
    else if (step.kind === "board") { goto(step.board, step.colorIndex); celebrate(`第 ${boardIdx + 1} 板完成`); }
    else { setRowPos(0); celebrate("全部完成"); }
  };
  const goStep = (dir: 1 | -1) => {
    const to = moveColor(counts, boardIdx, ci, dir);
    if (to) goto(to.board, to.colorIndex);
  };
  const toggleCell = (index: number) => {
    if (!cur) return;
    const x = index % width;
    const y = Math.floor(index / width);
    if (cellAt(m, x, y) !== cur.code) { setNote(`只能点当前颜色 ${cur.code}`); return; }
    const was = flagsRef.current[index] === 1;
    record(setCells(flagsRef.current, [index], !was), !was, false);
  };
  const finishRow = () => {
    if (rowY === null) return;
    const idxs = rowXs.map((x) => rowY * width + x);
    const allDone = idxs.every((i) => flagsRef.current[i] === 1);
    record(setCells(flagsRef.current, idxs, !allDone), !allDone, false);
    if (!allDone && rowIdx < rows.length - 1) setRowPos(rowIdx + 1);
  };
  const undo = () => {
    const u = undoRef.current.pop();
    if (!u) return;
    setCells(flagsRef.current, u.indices, !u.value);
    if (u.board !== undefined) goto(u.board, u.colorIndex ?? 0);
    setDismissed(false);
    setVersion((v) => v + 1);
    markDirty();
  };
  const changeSize = (size: number) => {
    if (size === boardSize) return;
    const next = splitBoards(width, height, size);
    const x0 = curBoard?.x0 ?? 0;
    const y0 = curBoard?.y0 ?? 0;
    const hit = next.find((b) => x0 >= b.x0 && x0 < b.x0 + b.w && y0 >= b.y0 && y0 < b.y0 + b.h);
    undoRef.current = undoRef.current.map((u) => ({ indices: u.indices, value: u.value }));
    setBoardSizeState(size);
    goto(hit?.index ?? 0, 0);
  };
  const toggleMode = () => { setMode((v) => (v === "row" ? "color" : "row")); setRowPos(0); };
  const stepRow = (d: number) => setRowPos(Math.min(Math.max(0, rowIdx + d), Math.max(0, rows.length - 1)));
  const leave = () => { flush(); navigate(`/pattern/${id}`); };
  const complete = () => { flush(); navigate(`/pattern/${id}?done=1`); };

  // ---- 键盘：←/→ 换色，Enter / 空格 这色拼完，Z 撤销，[ ] 换板，B 拼板，R 按行，↑/↓ 换行，+ − 0 缩放（判断逻辑见 lib/shortcuts.ts） ----
  const canvasApi = useRef<BuildCanvasApi | null>(null);
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => undefined);
  keyRef.current = (e) => {
    if (mapOpen || document.querySelector('[role="dialog"][aria-modal="true"]')) return;
    const a = buildKey(e, e.target as HTMLElement | null, mode === "row");
    if (!a) return;
    e.preventDefault();
    if (a.type === "color") goStep(a.dir);
    else if (a.type === "finish") { if (cur) finishColor(); else goStep(1); }
    else if (a.type === "undo") undo();
    else if (a.type === "board") { const to = Math.min(boards.length - 1, Math.max(0, boardIdx + a.dir)); if (to !== boardIdx) goto(to, 0); }
    else if (a.type === "openMap") setMapOpen(true);
    else if (a.type === "toggleRow") toggleMode();
    else if (a.type === "row") stepRow(a.dir);
    else if (a.type === "zoom") canvasApi.current?.zoom(a.by);
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  // ---------- 渲染（以下才允许提前 return，所有 hook 都在上面） ----------
  if (!pattern) {
    return (
      <div className="empty pegboard bd-empty">
        <h1>找不到这张图纸</h1>
        <p>它可能已被删除，或还没从其他设备同步过来。</p>
        <a className="btn" href="#/gallery"><Icon name="back" />回到图库</a>
      </div>
    );
  }
  if (!usable) {
    return (
      <div className="empty pegboard bd-empty">
        <h1>这张图纸没有保存每格的颜色</h1>
        <p>拼装模式需要每格色号。请先在图纸详情里补全，或重新生成图纸。</p>
        <a className="btn" href={`#/pattern/${id}`}><Icon name="back" />回到图纸</a>
      </div>
    );
  }
  if (!ready || !curBoard) return <div className="bd-empty"><h1 className="bd-sr">拼装模式</h1><p className="meta">载入中…</p></div>;
  if (overall.total === 0) {
    return (
      <div className="empty pegboard bd-empty">
        <h1>没有可拼的豆子</h1>
        <p>这张图纸的格子都是空的。</p>
        <a className="btn" href={`#/pattern/${id}`}><Icon name="back" />回到图纸</a>
      </div>
    );
  }

  const hex = cur ? colorOf(cur.code)?.hex ?? "#d4d4d8" : "transparent";
  const colorDone = !!cur && colorProg.total > 0 && colorProg.done >= colorProg.total;
  const R = 17;
  const C = 2 * Math.PI * R;
  const canvasLabel = cur ? `第 ${boardIdx + 1} 板的拼豆图，当前颜色 ${cur.code}，${cur.count} 颗，已拼 ${colorProg.done} 颗` : `第 ${boardIdx + 1} 板没有豆子`;

  return (
    <div className="bd" data-build-root data-build-board={boardIdx + 1} data-build-boards={boards.length} data-build-color={cur?.code ?? ""} data-build-mode={mode} data-build-progress={overall.percent}>
      <h1 className="bd-sr">拼装模式：{pattern.name}</h1>
      <header className="bd-top">
        <button type="button" className="btn btn-ghost bd-icon" onClick={leave} aria-label="返回图纸详情"><Icon name="back" /></button>
        <button type="button" className="btn bd-board" onClick={() => setMapOpen(true)} aria-haspopup="dialog" aria-label={`选择拼板，当前第 ${boardIdx + 1} 板，共 ${boards.length} 板`} title="选择拼板（B；[ ] 切换上/下一块）" aria-keyshortcuts="B" data-build-board-open>
          板 <b className="num">{boardIdx + 1}/{boards.length}</b>
        </button>
        <div className="bd-chip" data-build-chip>
          <span className="bd-swatch" style={{ background: hex }} aria-hidden="true" />
          <span className="bd-chip-text">
            <b>{cur ? `${cur.code} · 本板 ${cur.count} 颗` : "本板没有豆子"}</b>
            <small>{cur ? `${colorOf(cur.code)?.nameZh ?? ""} 已拼 ${colorProg.done}/${colorProg.total}` : ""}</small>
          </span>
        </div>
        <button type="button" className="btn btn-ghost bd-icon bd-keys" onClick={() => window.dispatchEvent(new Event("pindou:shortcuts"))} aria-label="键盘快捷键" title="键盘快捷键（?）" data-shortcut-open>?</button>
        <div className="bd-ring" role="progressbar" aria-label="整体进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={overall.percent} data-build-progress-ring>
          <svg viewBox="0 0 44 44" width="44" height="44" aria-hidden="true">
            <circle cx="22" cy="22" r={R} fill="none" stroke="var(--rule)" strokeWidth="4" />
            <circle cx="22" cy="22" r={R} fill="none" stroke="var(--leaf)" strokeWidth="4" strokeLinecap="round" strokeDasharray={C} strokeDashoffset={C * (1 - overall.percent / 100)} transform="rotate(-90 22 22)" />
          </svg>
          <span className="num">{overall.percent}%</span>
        </div>
      </header>

      <div className="bd-tools">
        <button type="button" className="btn btn-sm" aria-pressed={mode === "row"} onClick={toggleMode} data-build-mode-toggle title="按行拼（R）" aria-keyshortcuts="R">按行</button>
        <span className="meta bd-sub" aria-hidden="true">本板 {boardProg.done}/{boardProg.total}</span>
        <button type="button" className="btn btn-sm" onClick={undo} disabled={!undoRef.current.length} aria-label="撤销上一步" title="撤销上一步（Z）" aria-keyshortcuts="Z Control+Z" data-build-undo>撤销</button>
      </div>

      {mode === "row" && rowY !== null ? (
        <div className="bd-row" data-build-row={rowY + 1}>
          <button type="button" className="btn btn-sm" onClick={() => stepRow(-1)} disabled={rowIdx <= 0}>上一行</button>
          <div className="bd-row-info">
            <b>{describeRow(rowY, rowXs)}</b>
            <small>本行 {rowXs.length} 颗，已拼 {rowDone}</small>
          </div>
          <button type="button" className="btn btn-sm" onClick={finishRow}>{rowDone === rowXs.length ? "取消本行" : "本行拼完"}</button>
          <button type="button" className="btn btn-sm" onClick={() => stepRow(1)} disabled={rowIdx >= rows.length - 1}>下一行</button>
        </div>
      ) : null}

      <BuildCanvas apiRef={canvasApi} matrix={m} width={width} board={curBoard} code={cur?.code ?? null} flags={flags} version={version} rowY={rowY} label={canvasLabel} onToggle={toggleCell} />

      {cele ? <div className="bd-cele" role="presentation" data-build-cele>{cele} ✓</div> : null}

      <div className="bd-bottom">
        <button type="button" className="btn bd-prev" onClick={() => goStep(-1)} disabled={!moveColor(counts, boardIdx, ci, -1)} title="上一色（←）" aria-keyshortcuts="ArrowLeft" data-build-prev>上一色</button>
        {cur ? (
          <button type="button" className="btn btn-iron bd-done" onClick={finishColor} title="这色拼完（Enter / 空格）" aria-keyshortcuts="Enter Space" data-build-finish>{colorDone ? "这色已拼完，下一色" : "这色拼完"} ✓</button>
        ) : (
          <button type="button" className="btn btn-iron bd-done" onClick={() => goStep(1)}>本板是空的，下一板</button>
        )}
      </div>

      <div className="bd-sr" aria-live="polite" role="status" data-build-announce>{announce}</div>

      {finished && !dismissed ? (
        <div className="bd-finish-wrap">
          <div className="bd-finish panel panel-pad" role="dialog" aria-label="全部拼完" data-build-finished>
            <h2>全部拼完了</h2>
            <p>共 {overall.total} 颗。去标记完成，并按需要从库存里扣除用掉的豆子。</p>
            <div className="bd-finish-actions">
              <button type="button" className="btn btn-iron" onClick={complete} data-build-complete>去标记完成</button>
              <button type="button" className="btn" onClick={() => setDismissed(true)}>再看看</button>
              <button type="button" className="btn btn-ghost" onClick={undo} disabled={!undoRef.current.length}>撤销上一步</button>
            </div>
          </div>
        </div>
      ) : null}

      {mapOpen ? (
        <Sheet title="选择拼板" onClose={() => setMapOpen(false)}>
          <div className="stack">
            <div className="seg" role="group" aria-label="每块板的大小">
              {BOARD_SIZES.map((s) => <button key={s} type="button" aria-pressed={boardSize === s} data-build-size={s} onClick={() => changeSize(s)}>{boardSizeLabel(s)}</button>)}
            </div>
            <BoardMap matrix={m} width={width} height={height} boards={boards} flags={flags} current={boardIdx} onPick={(i) => { goto(i, 0); setMapOpen(false); }} />
            {boardSize > 0 && boards.length === 1 ? <p className="meta">这张图比一块板还小，只有 1 块板。</p> : null}
          </div>
        </Sheet>
      ) : null}
    </div>
  );
}
