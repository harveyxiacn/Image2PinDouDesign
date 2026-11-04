import { useEffect, useMemo, useRef, useState } from "react";
import { renderDesignToBlob, getHighResolutionCellSize } from "@engine/rendering";
import { pixelSourceToCanvas } from "@engine/image";
import { PALETTE_KITS } from "@engine/paletteKits";
import type { BeadDesign, MaxColors, PixelSource } from "@engine/types";
import { useData } from "../../lib/db";
import { stockByCode } from "../../lib/inventory";
import { loadPixelSource, saveImage } from "../../lib/images";
import { BOARD_CHOICES, buildConversionSettings, DEFAULT_GENERATE_OPTIONS, previewCellSize, startGeneration, type BoardChoice, type GenerateJob } from "../../lib/generate";
import { PALETTE } from "../../lib/palette";
import { fmt, navigate, toast } from "../ui";
import ImageDrop from "./ImageDrop";
import MatrixView from "./MatrixView";
import ZoomImage from "./ZoomImage";
import CountsEditor from "./CountsEditor";
import SaveForm, { type SaveValues } from "./SaveForm";
import { createPattern } from "./save";
import "./pattern.css";

const MAX_COLORS: Array<{ v: MaxColors; label: string }> = [
  { v: 8, label: "8 色" }, { v: 16, label: "16 色" }, { v: 24, label: "24 色" }, { v: 32, label: "32 色" }, { v: 48, label: "48 色" }, { v: "all", label: "不限" }
];

function PixelatedView({ source }: { source: PixelSource }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = pixelSourceToCanvas(source);
    const t = ref.current!;
    t.width = c.width; t.height = c.height;
    t.getContext("2d")!.drawImage(c, 0, 0);
  }, [source]);
  return <canvas ref={ref} className="gp-pix" />;
}

export default function GeneratePanel({ file, onFile, onClear }: { file: File | null; onFile: (f: File) => void; onClear: () => void }) {
  const data = useData();
  const stock = useMemo(() => stockByCode(data.txns), [data.txns]);
  const ownedAll = useMemo(() => Object.keys(stock).filter((c) => stock[c] > 0), [stock]);

  const [board, setBoard] = useState<BoardChoice>(DEFAULT_GENERATE_OPTIONS.board);
  const [cw, setCw] = useState(64);
  const [ch, setCh] = useState(64);
  const [maxColors, setMaxColors] = useState<MaxColors>(24);
  const [kitId, setKitId] = useState(data.prefs.kitId || DEFAULT_GENERATE_OPTIONS.kitId);
  const [onlyStock, setOnlyStock] = useState(false);
  const [dither, setDither] = useState(false);
  const [outline, setOutline] = useState(false);
  const [ignoreWhite, setIgnoreWhite] = useState(true);

  const [url, setUrl] = useState<string | null>(null);
  const [source, setSource] = useState<PixelSource | null>(null);
  const [running, setRunning] = useState(false);
  const [percent, setPercent] = useState(0);
  const [design, setDesign] = useState<BeadDesign | null>(null);
  const [error, setError] = useState("");
  const [focus, setFocus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const job = useRef<GenerateJob | null>(null);

  useEffect(() => {
    job.current?.cancel();
    setDesign(null); setError(""); setSource(null); setFocus(null); setRunning(false);
    if (!file) { setUrl(null); return; }
    const u = URL.createObjectURL(file);
    setUrl(u);
    let alive = true;
    loadPixelSource(file, 2400).then((px) => alive && setSource(px)).catch(() => alive && setError("这张图片无法解码，请换一张"));
    return () => { alive = false; URL.revokeObjectURL(u); };
  }, [file]);
  useEffect(() => () => job.current?.cancel(), []);

  const generate = async () => {
    if (!source || !file) return;
    const settings = buildConversionSettings({
      board, customWidth: cw, customHeight: ch, maxColors, kitId, ownedCodes: onlyStock ? ownedAll : null, dither, outline, ignoreWhiteBg: ignoreWhite
    });
    setRunning(true); setError(""); setPercent(0); setDesign(null);
    const j = startGeneration(source, file.name, settings, setPercent);
    job.current = j;
    try {
      setDesign(await j.promise);
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) setError(e instanceof Error ? e.message : "转换失败");
    } finally {
      if (job.current === j) setRunning(false);
    }
  };
  const cancel = () => { job.current?.cancel(); setRunning(false); };

  const renderBlob = (d: BeadDesign) => {
    const cell = previewCellSize(d, getHighResolutionCellSize(d));
    return renderDesignToBlob(d, PALETTE, { cellSize: cell, showLabels: cell >= 13, boardLineEvery: 10 });
  };
  const download = async () => {
    if (!design) return;
    try {
      const blob = await renderBlob(design);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${(file?.name ?? "pattern").replace(/\.[^.]+$/, "")}-${design.boardWidth}x${design.boardHeight}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    } catch (e) { toast(e instanceof Error ? e.message : "导出失败"); }
  };
  const save = async (values: SaveValues) => {
    if (!design || !file) return;
    setSaving(true);
    try {
      const src = await saveImage(file, file.name, "source");
      const prev = await saveImage(await renderBlob(design), `${values.name}-图纸.png`, "preview");
      const p = await createPattern(values, {
        kind: "generated", method: "generate", counts: design.colorCounts, imageId: src.id, previewId: prev.id,
        width: design.boardWidth, height: design.boardHeight, matrix: design.matrix, confidence: 1
      });
      toast("已保存到图库");
      navigate(`/pattern/${p.id}`);
    } catch (e) { toast(e instanceof Error ? e.message : "保存失败"); setSaving(false); }
  };

  if (!file) return <ImageDrop onFile={onFile} title="上传照片或插画，生成拼豆图纸" hint="头像、宠物、卡通图案效果最好；背景越干净越好。" />;

  return (
    <div className="gp-wrap">
      <div className="ap-grid">
        <section className="panel panel-pad stack">
          {url ? <img src={url} alt="原图" style={{ borderRadius: "var(--r-ctl)", maxHeight: 260, width: "100%", objectFit: "contain", background: "var(--paper-sunk)" }} /> : null}
          <div className="row"><span className="meta">{file.name}</span><span className="spacer" /><button className="btn btn-sm btn-ghost" onClick={onClear}>换一张</button></div>
        </section>
        <section className="panel panel-pad stack">
          <div className="grid-2" style={{ gap: 12 }}>
            <label className="field"><span>拼板尺寸</span>
              <select className="select" value={board} onChange={(e) => setBoard(e.target.value as BoardChoice)}>{BOARD_CHOICES.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}</select>
            </label>
            <label className="field"><span>最多颜色数</span>
              <select className="select" value={String(maxColors)} onChange={(e) => setMaxColors(e.target.value === "all" ? "all" : (Number(e.target.value) as MaxColors))}>{MAX_COLORS.map((m) => <option key={String(m.v)} value={String(m.v)}>{m.label}</option>)}</select>
            </label>
          </div>
          {board === "custom" ? (
            <div className="row">
              <label className="field" style={{ width: 96 }}><span>宽（格）</span><input className="input num" type="number" min={4} max={208} value={cw} onChange={(e) => setCw(Number(e.target.value) || 4)} /></label>
              <span aria-hidden="true">×</span>
              <label className="field" style={{ width: 96 }}><span>高（格）</span><input className="input num" type="number" min={4} max={208} value={ch} onChange={(e) => setCh(Number(e.target.value) || 4)} /></label>
            </div>
          ) : null}
          <label className="field"><span>色卡套装</span>
            <select className="select" value={kitId} onChange={(e) => setKitId(e.target.value)}>{PALETTE_KITS.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}</select>
          </label>
          <label className="pt-check"><input type="checkbox" checked={onlyStock} onChange={(e) => setOnlyStock(e.target.checked)} />只用库存里有的颜色{onlyStock ? <span className="meta">（{ownedAll.length} 色有货）</span> : null}</label>
          <label className="pt-check"><input type="checkbox" checked={ignoreWhite} onChange={(e) => setIgnoreWhite(e.target.checked)} />忽略白底</label>
          <label className="pt-check"><input type="checkbox" checked={outline} onChange={(e) => setOutline(e.target.checked)} />黑色勾边</label>
          <label className="pt-check"><input type="checkbox" checked={dither} onChange={(e) => setDither(e.target.checked)} />抖动（照片渐变更细腻）</label>
          <div className="row">
            {running ? (
              <>
                <div className="meter" style={{ flex: 1, minWidth: 80 }} role="progressbar" aria-valuenow={percent}><i style={{ width: `${Math.max(8, percent)}%` }} /></div>
                <button className="btn" onClick={cancel}>取消</button>
              </>
            ) : <button className="btn btn-iron" onClick={generate} disabled={!source}>{design ? "重新生成" : "生成图纸"}</button>}
          </div>
          {error ? <div className="notice iron" role="alert">{error}</div> : null}
        </section>
      </div>

      {design ? (
        <>
          <div className="panel panel-pad">
            <div className="row" style={{ marginBottom: 10 }}>
              <h3>{design.boardWidth} × {design.boardHeight} 格</h3>
              <span className="chip">{Object.keys(design.colorCounts).length} 色</span>
              <span className="chip">{fmt(Object.values(design.colorCounts).reduce((a, b) => a + b, 0))} 颗</span>
              <span className="spacer" />
              <button className="btn btn-sm" onClick={download}>下载图纸 PNG</button>
            </div>
            <div className="gp-views">
              <figure><figcaption className="label">原图</figcaption>{url ? <ZoomImage src={url} alt="原图" /> : null}</figure>
              {design.pixelated ? <figure><figcaption className="label">像素化</figcaption><PixelatedView source={design.pixelated} /></figure> : null}
              <figure className="gp-chart"><figcaption className="label">拼豆图纸</figcaption><MatrixView matrix={design.matrix} width={design.boardWidth} height={design.boardHeight} focusCode={focus} /></figure>
            </div>
          </div>
          <div className="ap-grid">
            <div className="panel">
              <div className="panel-head"><h3>用量</h3><span className="meta">点击色号高亮</span></div>
              <CountsEditor counts={design.colorCounts} readOnly focusCode={focus} onPick={(c) => setFocus((f) => (f === c ? null : c))} />
            </div>
            <div className="panel panel-pad"><SaveForm defaultName={file.name.replace(/\.[^.]+$/, "") || "生成图纸"} busy={saving} onSave={save} /></div>
          </div>
        </>
      ) : null}
    </div>
  );
}
