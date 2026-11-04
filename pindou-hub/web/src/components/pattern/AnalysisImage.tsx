import { useEffect, useMemo, useRef, useState } from "react";
import type { AnalyzeResult, GridDetection, GridReading, PixelSource, Rect } from "../../lib/recognize/types";
import ZoomPan, { type ZoomApi } from "./ZoomPan";
import CompareHandle from "./CompareHandle";
import CellInspector, { type CellPick } from "./CellInspector";
import "./pattern.css";

export type ImageView = "orig" | "hd" | "compare";

const f1 = (n: number) => n.toFixed(1);
/** 一组格子 → 一条 SVG path（每格一个矩形子路径），inset 为向内缩进（源像素） */
function cellsPath(grid: GridDetection, cells: Array<[number, number]>, inset = 0): string {
  const w = Math.max(0, grid.pitchX - inset * 2), h = Math.max(0, grid.pitchY - inset * 2);
  let d = "";
  for (const [r, c] of cells) d += `M${f1(grid.x0 + c * grid.pitchX + inset)} ${f1(grid.y0 + r * grid.pitchY + inset)}h${f1(w)}v${f1(h)}h${f1(-w)}z`;
  return d;
}

/** 取格子中心 50% 区域的平均色 #rrggbb（真实采样，不是色号标准色） */
function sampleCell(px: PixelSource, grid: GridDetection, r: number, c: number): string | null {
  const x1 = grid.x0 + (c + 0.25) * grid.pitchX, x2 = grid.x0 + (c + 0.75) * grid.pitchX;
  const y1 = grid.y0 + (r + 0.25) * grid.pitchY, y2 = grid.y0 + (r + 0.75) * grid.pitchY;
  const xa = Math.max(0, Math.floor(x1)), xb = Math.min(px.width, Math.max(xa + 1, Math.ceil(x2)));
  const ya = Math.max(0, Math.floor(y1)), yb = Math.min(px.height, Math.max(ya + 1, Math.ceil(y2)));
  let R = 0, G = 0, B = 0, n = 0;
  for (let y = ya; y < yb; y++) for (let x = xa; x < xb; x++) { const i = (y * px.width + x) * 4; R += px.data[i]; G += px.data[i + 1]; B += px.data[i + 2]; n++; }
  if (!n) return null;
  const h = (v: number) => Math.round(v / n).toString(16).padStart(2, "0");
  return `#${h(R)}${h(G)}${h(B)}`;
}

/**
 * 显示上传的图（可缩放平移，叠层 SVG 与图片一起缩放，线宽恒定）：
 * 网格线、点色号高亮、背景套灰、框选区域（框选开启时拖动画框而不是平移）、点格子核对、原图/高清对比。坐标均为 PixelSource 像素。
 */
export default function AnalysisImage({ url, srcW, srcH, region, onRegion, selecting, grid, matrix, focusCode, bgMask, showBg, pixels, reading, checks, enhancedUrl, view = "orig" }: {
  url: string; srcW: number; srcH: number; region: Rect | null; onRegion: (r: Rect | null) => void; selecting: boolean; grid: GridDetection | null;
  /** 识别出的每格色号；与 focusCode 一起使用：该色的格子上色描边，其余变暗 */
  matrix?: Array<Array<string | null>> | null; focusCode?: string | null;
  /** 智能去背景的结果（cols×rows，1 = 已去掉的背景格）；showBg 为真时用中性半透明色盖住这些格子 */
  bgMask?: Uint8Array | null; showBg?: boolean;
  /** 识别用的像素（取格子真实颜色）、网格读数与图例核对：提供后可点格子核对 */
  pixels?: PixelSource | null; reading?: GridReading | null; checks?: AnalyzeResult["checks"];
  /** 高清图（objectURL）与显示方式：orig 原图 / hd 高清 / compare 左原图右高清 */
  enhancedUrl?: string | null; view?: ImageView;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const api = useRef<ZoomApi>(null);
  const [drag, setDrag] = useState<{ x: number; y: number; x2: number; y2: number } | null>(null);
  const [sel, setSel] = useState<CellPick | null>(null);
  const [pos, setPos] = useState(0.5);
  const [nat, setNat] = useState<{ o: number; e: number }>({ o: 0, e: 0 });
  const hasHd = !!enhancedUrl;
  const mode: ImageView = hasHd ? view : "orig";

  useEffect(() => { setSel(null); }, [grid, url]);
  useEffect(() => { setNat({ o: 0, e: 0 }); }, [url, enhancedUrl]);

  const toSrc = (e: { clientX: number; clientY: number }) => {
    const r = stage.current!.getBoundingClientRect();
    return { x: Math.max(0, Math.min(srcW, ((e.clientX - r.left) / r.width) * srcW)), y: Math.max(0, Math.min(srcH, ((e.clientY - r.top) / r.height) * srcH)) };
  };
  const rectOf = (d: { x: number; y: number; x2: number; y2: number }): Rect => ({
    x: Math.round(Math.min(d.x, d.x2)), y: Math.round(Math.min(d.y, d.y2)), width: Math.round(Math.abs(d.x2 - d.x)), height: Math.round(Math.abs(d.y2 - d.y))
  });

  const inspectable = !!grid && !!matrix && !selecting;
  const cellAt = (x: number, y: number): CellPick | null => {
    if (!grid) return null;
    const c = Math.floor((x - grid.x0) / grid.pitchX), r = Math.floor((y - grid.y0) / grid.pitchY);
    return r >= 0 && r < grid.rows && c >= 0 && c < grid.cols ? { r, c } : null;
  };
  const showCell = (p: CellPick) => {
    setSel(p);
    if (grid) api.current?.ensureVisible((grid.x0 + (p.c + 0.5) * grid.pitchX) / srcW, (grid.y0 + (p.r + 0.5) * grid.pitchY) / srcH);
  };
  const prevSel = useRef<CellPick | null>(null);
  const onTap = (e: { clientX: number; clientY: number }) => {
    if (!inspectable) return;
    prevSel.current = sel;
    const s = toSrc(e), p = cellAt(s.x, s.y);
    setSel((cur) => (p && cur && cur.r === p.r && cur.c === p.c ? null : p));
  };
  const move = (dr: number, dc: number) => {
    if (!grid || !sel) return;
    showCell({ r: Math.max(0, Math.min(grid.rows - 1, sel.r + dr)), c: Math.max(0, Math.min(grid.cols - 1, sel.c + dc)) });
  };
  const onKey = (e: React.KeyboardEvent): boolean => {
    if (!inspectable || !grid) return false;
    if (sel) {
      if (e.key === "Escape") { setSel(null); return true; }
      if (e.shiftKey) return false;
      if (e.key === "ArrowUp") { move(-1, 0); return true; }
      if (e.key === "ArrowDown") { move(1, 0); return true; }
      if (e.key === "ArrowLeft") { move(0, -1); return true; }
      if (e.key === "ArrowRight") { move(0, 1); return true; }
      return false;
    }
    if (e.key === "Enter" || e.key === " ") {
      const ctr = api.current?.viewCenter();
      const p = ctr ? cellAt(ctr.fx * srcW, ctr.fy * srcH) : null;
      showCell(p ?? { r: Math.floor(grid.rows / 2), c: Math.floor(grid.cols / 2) });
      return true;
    }
    return false;
  };

  const paths = useMemo(() => {
    if (!grid) return null;
    const focusing = !!focusCode && !!matrix;
    const dim: Array<[number, number]> = [], hit: Array<[number, number]> = [], bg: Array<[number, number]> = [];
    for (let r = 0; r < grid.rows; r++) for (let c = 0; c < grid.cols; c++) {
      if (focusing) (matrix![r]?.[c] === focusCode ? hit : dim).push([r, c]);
      else if (bgMask && showBg && bgMask.length === grid.cols * grid.rows && bgMask[r * grid.cols + c]) bg.push([r, c]);
    }
    let lines = "";
    for (let i = 0; i <= grid.cols; i++) { const x = grid.x0 + i * grid.pitchX; lines += `M${f1(x)} ${f1(grid.y0)}V${f1(grid.y0 + grid.rows * grid.pitchY)}`; }
    for (let j = 0; j <= grid.rows; j++) { const y = grid.y0 + j * grid.pitchY; lines += `M${f1(grid.x0)} ${f1(y)}H${f1(grid.x0 + grid.cols * grid.pitchX)}`; }
    return { focusing, dim: cellsPath(grid, dim), hit: cellsPath(grid, hit), hitEdge: cellsPath(grid, hit, Math.min(grid.pitchX, grid.pitchY) * 0.05), bg: cellsPath(grid, bg), lines };
  }, [grid, matrix, focusCode, bgMask, showBg]);

  const shown = drag ? rectOf(drag) : region;
  const natW = mode === "orig" ? nat.o : mode === "hd" ? nat.e || nat.o : Math.max(nat.o, nat.e);
  const baseUrl = mode === "orig" ? url : enhancedUrl!;
  const cell = sel && grid && matrix ? { code: matrix[sel.r]?.[sel.c] ?? null, sample: pixels ? sampleCell(pixels, grid, sel.r, sel.c) : null } : null;
  const hint = selecting ? "框选中：拖动画出图纸区域（缩放仍可用）" : inspectable ? "点格子核对色号 · Enter 选中视野中心格 · 方向键换格 · Shift+方向键平移 · Ctrl+滚轮缩放" : undefined;

  return (
    <>
      <ZoomPan
        label={mode === "compare" ? "原图与高清对比预览" : mode === "hd" ? "高清预览" : "上传的图纸预览"}
        natW={natW || undefined} thumb={baseUrl} panDisabled={selecting} onTap={onTap} onDoubleTap={() => setSel(prevSel.current)} onKey={onKey} apiRef={api} hint={hint}
        renderOverlay={mode === "compare" ? (v, box) => <CompareHandle pos={pos} onPos={setPos} v={v} box={box} /> : undefined}
      >
        <div
          ref={stage}
          className="pt-stage"
          data-select={selecting}
          onPointerDown={selecting ? (e) => { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); const p = toSrc(e); setDrag({ x: p.x, y: p.y, x2: p.x, y2: p.y }); } : undefined}
          onPointerMove={selecting && drag ? (e) => { const p = toSrc(e); setDrag({ ...drag, x2: p.x, y2: p.y }); } : undefined}
          onPointerUp={selecting && drag ? () => { const r = rectOf(drag); setDrag(null); onRegion(r.width > srcW * 0.05 && r.height > srcH * 0.05 ? r : null); } : undefined}
          onPointerCancel={() => setDrag(null)}
        >
          <img src={baseUrl} alt={mode === "orig" ? "上传的图纸" : "高清化后的图纸"} draggable={false} onLoad={(e) => { const w = e.currentTarget.naturalWidth; setNat((n) => (mode === "orig" ? { ...n, o: w } : { ...n, e: w })); }} />
          {mode === "compare" ? (
            <img className="pt-cmp-top" src={url} alt="" aria-hidden="true" draggable={false} style={{ clipPath: `inset(0 ${(1 - pos) * 100}% 0 0)` }} onLoad={(e) => { const w = e.currentTarget.naturalWidth; setNat((n) => ({ ...n, o: w })); }} />
          ) : null}
          <svg className="pt-over" viewBox={`0 0 ${srcW} ${srcH}`} preserveAspectRatio="none" aria-hidden="true">
            {paths?.focusing ? (
              <>
                <path d={paths.dim} className="pt-ov-dim" />
                <path d={paths.hit} className="pt-ov-hit" />
                <path d={paths.hitEdge} className="pt-ov-edge" />
              </>
            ) : paths ? (
              <>
                {paths.bg ? <path d={paths.bg} className="pt-ov-bg" /> : null}
                <path d={paths.lines} className="pt-ov-lines" />
              </>
            ) : null}
            {sel && grid ? (
              <>
                <rect className="pt-ov-sel-o" x={grid.x0 + sel.c * grid.pitchX} y={grid.y0 + sel.r * grid.pitchY} width={grid.pitchX} height={grid.pitchY} />
                <rect className="pt-ov-sel" x={grid.x0 + sel.c * grid.pitchX} y={grid.y0 + sel.r * grid.pitchY} width={grid.pitchX} height={grid.pitchY} />
              </>
            ) : null}
            {shown ? <rect className="pt-ov-region" x={shown.x} y={shown.y} width={shown.width} height={shown.height} /> : null}
          </svg>
        </div>
      </ZoomPan>
      {sel && grid && cell ? (
        <CellInspector
          pick={sel} code={cell.code} sampleHex={cell.sample} size={{ rows: grid.rows, cols: grid.cols }}
          total={cell.code ? reading?.counts[cell.code] ?? 0 : 0} check={cell.code ? checks?.find((c) => c.code === cell.code) : undefined}
          onMove={move} onClose={() => setSel(null)}
        />
      ) : null}
    </>
  );
}
