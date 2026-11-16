// 分板打印：每块拼豆板一页的图纸，经浏览器“打印 / 存为 PDF”输出。
// 屏幕上按需渲染（滚到才画），打印前（beforeprint / 点按钮）强制把所选页面全部渲染出来。
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type HTMLAttributes, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { useData } from "../lib/db";
import { cellAt, boardSizeLabel } from "../lib/build";
import { matrixOf, type Matrix } from "../lib/matrix";
import { colorOf } from "../lib/palette";
import {
  DEFAULT_PRINT_OPTIONS, PRINT_BOARD_SIZES, axisLabels, boardLayout, displayBoardCol, displayColumns, heavyBoundaries, heavyRows,
  overviewLayout, pageCount, pageMm, planPrint, symbolMap, textColorFor,
  type PlanBoard, type PrintOptions, type PrintPlan
} from "../lib/printPlan";
import type { ColorCount } from "../lib/build";
import { Icon, fmt } from "../components/ui";
import "./PrintPattern.css";

const OPT_KEY = "pindou.print.opts";
type Stored = Pick<PrintOptions, "paper" | "orientation" | "style">;
function readStored(): Partial<Stored> {
  try { const v = JSON.parse(localStorage.getItem(OPT_KEY) ?? "{}"); return v && typeof v === "object" ? v : {}; } catch { return {}; }
}
function storeOpts(o: Stored) {
  try { localStorage.setItem(OPT_KEY, JSON.stringify(o)); } catch { /* 无痕模式：不记住也不影响使用 */ }
}

const U = 10; // SVG 里一格 = 10 个单位
const hexOf = (code: string) => colorOf(code)?.hex ?? "#d4d4d8";

/** 进入视野才渲染；force=true（打印）时立即渲染。占位保持页面尺寸，滚动条不跳。 */
function LazyPage({ force, children, ...rest }: { force: boolean; children: () => ReactNode } & Omit<HTMLAttributes<HTMLElement>, "children">) {
  const ref = useRef<HTMLElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    if (typeof IntersectionObserver === "undefined") { setSeen(true); return; }
    const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) { setSeen(true); io.disconnect(); } }, { rootMargin: "800px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  return <section ref={ref} {...rest}>{seen || force ? children() : <div className="pp-placeholder" aria-hidden="true">正在准备…</div>}</section>;
}

function Swatch({ code, style }: { code: string; style?: CSSProperties }) {
  return <i className="pp-sw" style={{ background: hexOf(code), ...style }} aria-hidden="true" />;
}

function CountList({ counts, symbols, style, withName }: { counts: ColorCount[]; symbols: Map<string, string>; style: PrintOptions["style"]; withName?: boolean }) {
  return (
    <ul className="pp-counts">
      {counts.map((c) => (
        <li key={c.code} data-legend-code={c.code}>
          <Swatch code={c.code} />
          <b className="pp-code">{c.code}</b>
          {style === "symbol" && symbols.get(c.code) ? <span className="pp-sym">{symbols.get(c.code)}</span> : null}
          {withName ? <span className="pp-name">{colorOf(c.code)?.nameZh ?? ""}</span> : null}
          <span className="pp-n num">{fmt(c.count)}</span>
        </li>
      ))}
    </ul>
  );
}

function MiniMap({ plan, current, mirror }: { plan: PrintPlan; current: number; mirror: boolean }) {
  const nonEmpty = new Set(plan.boards.map((b) => b.number));
  const size = 8;
  const cols = plan.boardCols; const rows = plan.boardRows;
  const mmW = Math.min(40, Math.max(14, cols * 9));
  return (
    <svg className="pp-mini" viewBox={`0 0 ${cols * size} ${rows * size}`} width={`${mmW}mm`} role="img" aria-label={`本板在整张图里的位置：第 ${Math.floor((current - 1) / cols) + 1} 行第 ${((current - 1) % cols) + 1} 列`}>
      {plan.allBoards.map((b) => {
        const x = displayBoardCol(b.col, cols, mirror) * size;
        const y = b.row * size;
        const on = b.index + 1 === current;
        return (
          <g key={b.index}>
            <rect x={x} y={y} width={size} height={size} fill={on ? "#111" : nonEmpty.has(b.index + 1) ? "#e5e5e5" : "#fff"} stroke="#111" strokeWidth={0.4} />
            <text x={x + size / 2} y={y + size / 2} fontSize={size * 0.42} textAnchor="middle" dominantBaseline="central" fill={on ? "#fff" : "#111"}>{b.index + 1}</text>
          </g>
        );
      })}
    </svg>
  );
}

function BoardSheet({ name, pb, matrix, plan, opts, symbols }: { name: string; pb: PlanBoard; matrix: Matrix; plan: PrintPlan; opts: PrintOptions; symbols: Map<string, string> }) {
  const { board } = pb;
  const lay = boardLayout(opts.paper, opts.orientation, board.w, board.h);
  const cols = displayColumns(board.w, opts.mirror);
  const labels = axisLabels(board.w, opts.mirror);
  const hv = heavyBoundaries(board.w, opts.mirror);
  const hr = heavyRows(board.h);
  const showText = lay.cellMm >= 3.2;
  const thin: string[] = []; const heavy: string[] = [];
  for (let d = 0; d <= board.w; d += 1) (hv[d] ? heavy : thin).push(`M${d * U} 0V${board.h * U}`);
  for (let r = 0; r <= board.h; r += 1) (hr[r] ? heavy : thin).push(`M0 ${r * U}H${board.w * U}`);
  const cells: ReactNode[] = [];
  for (let y = 0; y < board.h; y += 1) {
    for (let dx = 0; dx < board.w; dx += 1) {
      const code = cellAt(matrix, board.x0 + cols[dx], board.y0 + y);
      if (!code) continue;
      const hex = hexOf(code);
      const sym = opts.style === "symbol" ? symbols.get(code) : undefined;
      const text = sym ?? code;
      const fs = sym ? U * 0.62 : Math.min(U * 0.5, (U - 1) / (Math.max(2, text.length) * 0.62));
      cells.push(
        <g key={`${dx}-${y}`}>
          {opts.style === "fill" ? <rect x={dx * U} y={y * U} width={U} height={U} fill={hex} /> : null}
          {showText ? <text x={dx * U + U / 2} y={y * U + U / 2} fontSize={fs} textAnchor="middle" dominantBaseline="central" fill={textColorFor(hex, opts.style)} fontFamily="var(--font-code), monospace" fontWeight={600}>{text}</text> : null}
        </g>
      );
    }
  }
  const pxW = (board.w + 1) * lay.cellMm;
  const pxH = (board.h + 1) * lay.cellMm;
  return (
    <>
      <header className="pp-head">
        <h2>{name}</h2>
        <p>第 <b>{pb.number}</b> 块板（{pb.label}，行-列）· 共 {plan.allBoards.length} 块 · 本板 {board.w}×{board.h} · 整图第 {board.x0 + 1}–{board.x0 + board.w} 列、第 {board.y0 + 1}–{board.y0 + board.h} 行{opts.mirror ? " · 已左右镜像" : ""}</p>
      </header>
      <div className={`pp-body${lay.side ? " is-side" : ""}`}>
        <svg className="pp-grid" width={`${pxW}mm`} height={`${pxH}mm`} viewBox={`${-U} ${-U} ${(board.w + 1) * U} ${(board.h + 1) * U}`} role="img" aria-label={`第 ${pb.number} 块板图纸`}>
          {labels.map((n, d) => (
            <text key={`c${d}`} x={d * U + U / 2} y={-U / 2} fontSize={U * 0.42} textAnchor="middle" dominantBaseline="central" fill="#111" fontWeight={(n % 5 === 0) ? 700 : 400}>{n}</text>
          ))}
          {Array.from({ length: board.h }, (_, y) => (
            <text key={`r${y}`} x={-U / 2} y={y * U + U / 2} fontSize={U * 0.42} textAnchor="middle" dominantBaseline="central" fill="#111" fontWeight={((y + 1) % 5 === 0) ? 700 : 400}>{y + 1}</text>
          ))}
          {cells}
          <path d={thin.join("")} stroke="#777" strokeWidth={0.5} fill="none" />
          <path d={heavy.join("")} stroke="#000" strokeWidth={1.6} fill="none" />
          <rect x={0} y={0} width={board.w * U} height={board.h * U} stroke="#000" strokeWidth={2} fill="none" />
        </svg>
        <aside className="pp-side">
          <div className="pp-minibox"><b>位置</b><MiniMap plan={plan} current={pb.number} mirror={opts.mirror} /></div>
          <div className="pp-countbox"><b>本板用量 · 共 {fmt(pb.total)} 颗 · {pb.counts.length} 色</b><CountList counts={pb.counts} symbols={symbols} style={opts.style} /></div>
        </aside>
      </div>
    </>
  );
}

function OverviewSheet({ name, matrix, width, height, plan, opts, symbols }: { name: string; matrix: Matrix; width: number; height: number; plan: PrintPlan; opts: PrintOptions; symbols: Map<string, string> }) {
  const lay = overviewLayout(opts.paper, opts.orientation, width, height);
  const cells: ReactNode[] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const code = cellAt(matrix, x, y);
      if (!code) continue;
      const dx = opts.mirror ? width - 1 - x : x;
      const sym = opts.style === "symbol" ? symbols.get(code) : undefined;
      cells.push(<rect key={`${x}-${y}`} x={dx * U} y={y * U} width={U} height={U} fill={hexOf(code)} fillOpacity={opts.style === "fill" ? 1 : 0.5} />);
      if (sym && lay.cellMm >= 2.4) cells.push(<text key={`t${x}-${y}`} x={dx * U + U / 2} y={y * U + U / 2} fontSize={U * 0.62} textAnchor="middle" dominantBaseline="central" fill="#111">{sym}</text>);
    }
  }
  const nonEmpty = new Set(plan.boards.map((b) => b.number));
  const marks = plan.allBoards.map((b) => {
    const dx0 = opts.mirror ? width - (b.x0 + b.w) : b.x0;
    const fs = Math.min(b.w, b.h) * U * 0.34;
    const on = plan.boards.length === 0 || nonEmpty.has(b.index + 1);
    return (
      <g key={b.index}>
        <rect x={dx0 * U} y={b.y0 * U} width={b.w * U} height={b.h * U} fill="none" stroke="#000" strokeWidth={2.2} strokeDasharray={on ? undefined : "8 6"} />
        <text x={(dx0 + b.w / 2) * U} y={(b.y0 + b.h / 2) * U} fontSize={fs} textAnchor="middle" dominantBaseline="central" fill="#000" stroke="#fff" strokeWidth={fs * 0.16} paintOrder="stroke" fontWeight={700}>{b.index + 1}</text>
        {fs > 12 ? <text x={(dx0 + b.w / 2) * U} y={(b.y0 + b.h / 2) * U + fs * 0.85} fontSize={fs * 0.4} textAnchor="middle" dominantBaseline="central" fill="#000" stroke="#fff" strokeWidth={fs * 0.07} paintOrder="stroke">{b.row + 1}-{b.col + 1}</text> : null}
      </g>
    );
  });
  return (
    <>
      <header className="pp-head">
        <h2>{name}</h2>
        <p>总览 · {width}×{height} · 共 {fmt(plan.total)} 颗 · {plan.totals.length} 色 · 拆成 {plan.allBoards.length} 块板（{plan.boardRows} 行 × {plan.boardCols} 列，{boardSizeLabel(opts.boardSize)}）{opts.mirror ? " · 已左右镜像" : ""}</p>
      </header>
      <svg className="pp-over" width={`${lay.gridW}mm`} height={`${lay.gridH}mm`} viewBox={`0 0 ${width * U} ${height * U}`} role="img" aria-label="整张图纸总览与板号">
        {cells}
        {marks}
      </svg>
      <section className="pp-legend" data-print-legend aria-label="图例">
        <b>图例 · 色号 / 颜色 / 名称 / 总数</b>
        <CountList counts={plan.totals} symbols={symbols} style={opts.style} withName />
      </section>
    </>
  );
}

export default function PrintPattern({ id }: { id: string }) {
  const data = useData();
  const pattern = data.patterns.find((p) => p.id === id && !p.deleted);
  const matrix = useMemo(() => (pattern ? matrixOf(pattern) : undefined), [pattern]);
  const width = pattern?.width ?? matrix?.[0]?.length ?? 0;
  const height = pattern?.height ?? matrix?.length ?? 0;
  const [opts, setOpts] = useState<PrintOptions>(() => ({ ...DEFAULT_PRINT_OPTIONS, ...readStored() }));
  const [boardSizeTouched, setTouched] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [zoom, setZoom] = useState(1);
  const stageRef = useRef<HTMLDivElement>(null);
  const set = (patch: Partial<PrintOptions>) => setOpts((o) => { const n = { ...o, ...patch }; storeOpts({ paper: n.paper, orientation: n.orientation, style: n.style }); return n; });

  // 默认板大小：沿用拼装模式里选过的
  const buildSize = pattern?.build?.boardSize;
  useEffect(() => { if (!boardSizeTouched && buildSize !== undefined) setOpts((o) => ({ ...o, boardSize: buildSize })); }, [buildSize, boardSizeTouched]);

  const plan = useMemo<PrintPlan | null>(() => {
    if (!pattern || !matrix || !width || !height) return null;
    return planPrint(matrix, width, height, opts.boardSize, opts.scope === "range" ? opts.rangeText : undefined);
  }, [pattern, matrix, width, height, opts.boardSize, opts.scope, opts.rangeText]);
  const symbols = useMemo(() => symbolMap(plan?.totals ?? []), [plan]);

  // 打印前把所有选中的页面画出来（beforeprint 同步刷新），打印后恢复按需渲染
  useEffect(() => {
    const before = () => flushSync(() => setPrinting(true));
    const after = () => setPrinting(false);
    window.addEventListener("beforeprint", before);
    window.addEventListener("afterprint", after);
    return () => { window.removeEventListener("beforeprint", before); window.removeEventListener("afterprint", after); };
  }, []);

  // 打印时隐藏导航栏等外壳（样式只在本页打开期间生效）
  useEffect(() => {
    document.documentElement.classList.add("pp-mode");
    return () => document.documentElement.classList.remove("pp-mode");
  }, []);

  // 屏幕上把纸张缩到容器宽度（打印时不缩放）
  const page = pageMm(opts.paper, opts.orientation);
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const fit = () => setZoom(Math.min(1, Math.max(0.2, (el.clientWidth - 2) / (page.w * 3.7795))));
    fit();
    if (typeof ResizeObserver === "undefined") { window.addEventListener("resize", fit); return () => window.removeEventListener("resize", fit); }
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [page.w, !!plan]);

  const doPrint = () => {
    flushSync(() => setPrinting(true));
    window.print();
  };

  if (!pattern) {
    return (
      <div className="empty pegboard pp-empty" data-print-root>
        <h3>找不到这张图纸</h3>
        <p>它可能已被删除，或还没从其他设备同步过来。</p>
        <a className="btn" href="#/gallery"><Icon name="back" />回到图库</a>
      </div>
    );
  }
  if (!plan || !matrix) {
    return (
      <div className="empty pegboard pp-empty" data-print-root>
        <h3>这张图纸没有逐格数据</h3>
        <p>分板打印需要每一格的色号，只有生成、识别出网格或手动编辑过格子的图纸才能打印。</p>
        <a className="btn" href={`#/pattern/${pattern.id}`}><Icon name="back" />回到图纸</a>
      </div>
    );
  }

  const pages = pageCount(plan, opts.overview);
  const small = plan.boards.length ? boardLayout(opts.paper, opts.orientation, Math.min(opts.boardSize || Infinity, width), Math.min(opts.boardSize || Infinity, height)).cellMm < 3.2 : false;
  const paperName = opts.paper === "a4" ? "A4" : "letter";
  return (
    <div className="pp" data-print-root data-pattern={pattern.id} data-printing={printing ? "true" : undefined}>
      <style>{`@page { size: ${paperName} ${opts.orientation}; margin: 0; }`}</style>
      <div className="pp-screen">
        <div className="page-head">
          <div>
            <h1>打印分板图纸</h1>
            <p>{pattern.name} · {width}×{height} · {fmt(plan.total)} 颗 · 在打印窗口选“另存为 PDF”即可存成文件</p>
          </div>
          <div className="row">
            <a className="btn" href={`#/pattern/${pattern.id}`}><Icon name="back" />返回图纸</a>
            <button type="button" className="btn btn-primary" data-print-go onClick={doPrint} disabled={pages === 0}><Icon name="download" />打印 / 存为 PDF</button>
          </div>
        </div>

        <div className="panel panel-pad pp-opts" data-print-options>
          <label className="field"><span>拼豆板大小</span>
            <select className="select" value={opts.boardSize} onChange={(e) => { setTouched(true); set({ boardSize: Number(e.target.value) }); }} aria-label="拼豆板大小">
              {[...new Set<number>([...PRINT_BOARD_SIZES, opts.boardSize])].map((s) => <option key={s} value={s}>{boardSizeLabel(s)}</option>)}
            </select>
          </label>
          <label className="field"><span>打印哪些板</span>
            <select className="select" value={opts.scope} onChange={(e) => set({ scope: e.target.value as PrintOptions["scope"] })} aria-label="打印范围">
              <option value="all">每一块板</option>
              <option value="range">只打印选定的板</option>
            </select>
          </label>
          {opts.scope === "range" ? (
            <label className="field"><span>板号（如 1-3, 5）</span>
              <input className="input" inputMode="text" value={opts.rangeText} placeholder={`1-${plan.allBoards.length}`} onChange={(e) => set({ rangeText: e.target.value })} aria-label="板号范围" />
            </label>
          ) : null}
          <label className="field"><span>格子样式</span>
            <select className="select" value={opts.style} onChange={(e) => set({ style: e.target.value as PrintOptions["style"] })} aria-label="格子样式">
              <option value="fill">彩色底 + 色号</option>
              <option value="code">只印色号（省墨）</option>
              <option value="symbol">符号（黑白也好认）</option>
            </select>
          </label>
          <label className="field"><span>纸张</span>
            <select className="select" value={opts.paper} onChange={(e) => set({ paper: e.target.value as PrintOptions["paper"] })} aria-label="纸张大小">
              <option value="a4">A4</option>
              <option value="letter">Letter</option>
            </select>
          </label>
          <label className="field"><span>方向</span>
            <select className="select" value={opts.orientation} onChange={(e) => set({ orientation: e.target.value as PrintOptions["orientation"] })} aria-label="纸张方向">
              <option value="portrait">纵向</option>
              <option value="landscape">横向</option>
            </select>
          </label>
          <label className="pp-check"><input type="checkbox" checked={opts.overview} onChange={(e) => set({ overview: e.target.checked })} />包含总览页（含图例）</label>
          <label className="pp-check"><input type="checkbox" checked={opts.mirror} onChange={(e) => set({ mirror: e.target.checked })} />左右镜像（熨烫面）</label>
        </div>
        <p className="meta pp-summary" role="status" data-print-summary>
          共 {pages} 页{opts.overview ? "（含总览）" : ""}，{plan.boards.length} 块板
          {plan.skippedEmpty.length ? `；空板 ${plan.skippedEmpty.join("、")} 号不打印` : ""}
          {plan.rangeError ? `；${plan.rangeError}` : ""}
          {small ? "；格子偏小，建议换小一点的板" : ""}
        </p>
      </div>

      <div className="pp-stage" ref={stageRef}>
        <div className="pp-pages" style={{ ["--pw" as string]: `${page.w}mm`, ["--ph" as string]: `${page.h}mm`, ["--pz" as string]: zoom }}>
          {opts.overview ? (
            <LazyPage force={printing} className="pp-page" data-print-page="overview">
              {() => <OverviewSheet name={pattern.name} matrix={matrix} width={width} height={height} plan={plan} opts={opts} symbols={symbols} />}
            </LazyPage>
          ) : null}
          {plan.boards.map((pb) => (
            <LazyPage key={pb.number} force={printing} className="pp-page" data-print-page="board" data-board={pb.number}>
              {() => <BoardSheet name={pattern.name} pb={pb} matrix={matrix} plan={plan} opts={opts} symbols={symbols} />}
            </LazyPage>
          ))}
        </div>
        {pages === 0 ? <p className="meta pp-none">没有可打印的页面：检查板号范围，或这个范围里的板都是空的。</p> : null}
      </div>
    </div>
  );
}
