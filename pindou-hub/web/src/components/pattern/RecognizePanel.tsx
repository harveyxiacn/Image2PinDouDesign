import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { analyzePattern } from "../../lib/recognize/assistant";
import type { AnalyzeResult, AssistantStep, Rect } from "../../lib/recognize/types";
import { enhanceInWorker, type EnhanceResult } from "../../lib/enhance";
import { hubInfo, aiVision } from "../../lib/sync";
import { loadPixelSource, saveImage } from "../../lib/images";
import { METHOD_LABEL, totalOf, type Counts, type PatternStatus } from "../../lib/model";
import { headerChecks, reviewReasonsFor } from "../../lib/batch";
import { checkSize } from "../../lib/recognize/sizecheck";
import { normalizeCode } from "../../lib/palette";
import { DiffNumber, Icon, fmt, navigate, prefersReducedMotion, toast } from "../ui";
import ImageDrop from "./ImageDrop";
import CaptureTips, { TipsList } from "./CaptureTips";
import AnalysisImage, { type ImageView } from "./AnalysisImage";
import EnhanceCard, { loadHdMode, saveHdMode, type EnhState, type HdMode } from "./EnhanceCard";
import AssistantTimeline from "./AssistantTimeline";
import CountsEditor, { type CheckMap, type DiffMap } from "./CountsEditor";
import SaveForm, { type SaveValues } from "./SaveForm";
import MatrixView from "./MatrixView";
import { createPattern } from "./save";
import "./pattern.css";
import "./stitch.css";

type Pixels = Awaited<ReturnType<typeof loadPixelSource>>;
type Ai = { counts: Counts; notes?: string; model: string };

function editedHeavily(base: Counts, now: Counts): boolean {
  const codes = new Set([...Object.keys(base), ...Object.keys(now)]);
  let diff = 0;
  for (const c of codes) diff += Math.abs((base[c] ?? 0) - (now[c] ?? 0));
  return diff > Math.max(5, totalOf(base) * 0.1);
}

async function toJpegBase64(file: Blob, maxEdge = 1600): Promise<string> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  return c.toDataURL("image/jpeg", 0.85).split(",")[1] ?? "";
}

/** 从批量队列“需要检查”打开时带入：已有的识别结果（不重新跑 OCR）、标签与状态默认值 */
export type RecognizeSeed = { result: AnalyzeResult; name: string; tags: string; status: PatternStatus };

export default function RecognizePanel({ file, onFile, onClear, onGenerate, seed, onSaved, clearLabel = "换一张", onMulti }: {
  file: File | null; onFile: (f: File) => void; onClear: () => void;
  /** “用它生成图纸”：由页面切换到生成模式并保留这张图 */
  onGenerate?: () => void; seed?: RecognizeSeed | null; onSaved?: (patternId: string) => void; clearLabel?: string;
  /** 一次选了多张图（或点「多张截图拼接」）：交给页面决定是拼接还是批量；mode=stitch 表示用户已明确要拼接 */
  onMulti?: (files: File[], mode: "ask" | "stitch") => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [pixels, setPixels] = useState<Pixels | null>(null);
  const [region, setRegion] = useState<Rect | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [ocr, setOcr] = useState(true);
  const [bgEmpty, setBgEmpty] = useState(true);
  const [cellCodes, setCellCodes] = useState(true);
  const [cols, setCols] = useState("");
  const [rows, setRows] = useState("");
  const [steps, setSteps] = useState<AssistantStep[]>([]);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<AnalyzeResult | null>(null);
  const [counts, setCounts] = useState<Counts>({});
  const [error, setError] = useState("");
  const [aiOn, setAiOn] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [ai, setAi] = useState<Ai | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedOk, setSavedOk] = useState(false);
  const [focus, setFocus] = useState<string | null>(null);
  const [view, setView] = useState<"orig" | "restored">("orig");
  const [forceChart, setForceChart] = useState(false);
  const [showBg, setShowBg] = useState(true);
  const [hdMode, setHdModeState] = useState<HdMode>(loadHdMode);
  const [enh, setEnh] = useState<EnhanceResult | null>(null);
  const [enhState, setEnhState] = useState<EnhState>(loadHdMode() === "off" ? "off" : "running");
  const [hdView, setHdView] = useState<ImageView>("hd");
  const [hdBlob, setHdBlob] = useState<Blob | null>(null);
  const [hdUrl, setHdUrl] = useState<string | null>(null);
  const [useHdSource, setUseHdSource] = useState(false);
  const [tipsOpen, setTipsOpen] = useState(false);
  const [sizeDismissed, setSizeDismissed] = useState<AnalyzeResult | null>(null);
  const [ranForced, setRanForced] = useState(false);
  const colsInput = useRef<HTMLInputElement>(null);
  const stitchInput = useRef<HTMLInputElement>(null);
  const enhRef = useRef<EnhanceResult | null>(null);
  const modeRef = useRef<HdMode>(hdMode);
  modeRef.current = hdMode;
  const enhTok = useRef(0);
  const enhCancel = useRef<(() => void) | null>(null);
  const seedRef = useRef(seed);
  seedRef.current = seed;
  const abort = useRef<AbortController | null>(null);
  const pixelsRef = useRef<Pixels | null>(null);
  // 图例字很小：OCR 用更高分辨率的副本（≤5000 长边，手机内存也够），网格识别仍用 2400 版本。
  const fullRef = useRef<Pixels | null>(null);

  useEffect(() => { hubInfo().then((i) => setAiOn(!!i?.ai?.available)); }, []);

  const run = useCallback(async (opts: { region: Rect | null; ocr: boolean; cellCodes: boolean; bgEmpty: boolean; cols: string; rows: string }) => {
    const px = pixelsRef.current;
    if (!px) return;
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    setRunning(true); setError(""); setSteps([]); setResult(null); setAi(null); setFocus(null); setForceChart(false);
    try {
      const forceCols = Number(opts.cols) > 0 ? Math.round(Number(opts.cols)) : null;
      const forceRows = Number(opts.rows) > 0 ? Math.round(Number(opts.rows)) : null;
      setRanForced(forceCols != null || forceRows != null);
      const res = await analyzePattern(px, {
        region: opts.region, ocr: opts.ocr || opts.cellCodes, legendOcr: opts.ocr, cellCodes: opts.cellCodes, treatBackgroundAsEmpty: opts.bgEmpty, forceCols, forceRows, signal: ctl.signal,
        enhance: modeRef.current === "off" ? "off" : "auto", enhanced: modeRef.current === "off" ? null : enhRef.current,
        ocrSource: fullRef.current && fullRef.current.width > px.width ? fullRef.current : undefined,
        onProgress: (step) => setSteps((prev) => { const i = prev.findIndex((s) => s.id === step.id); return i < 0 ? [...prev, step] : prev.map((s, k) => (k === i ? step : s)); })
      });
      if (ctl.signal.aborted) return;
      setSteps(res.steps); setResult(res); setCounts({ ...res.counts });
    } catch (e) {
      if (!ctl.signal.aborted) setError(e instanceof Error ? e.message : "识别失败");
    } finally {
      if (abort.current === ctl) setRunning(false);
    }
  }, []);

  /** 评估并（必要时）高清化；返回 false 表示已过期（又换了图 / 切了开关） */
  const prepare = useCallback(async (px: Pixels, tok: number): Promise<boolean> => {
    enhCancel.current?.();
    enhRef.current = null; setEnh(null);
    if (modeRef.current === "off") { setEnhState("off"); return true; }
    setEnhState("running");
    const job = enhanceInWorker(px, { scale: "auto" });
    enhCancel.current = job.cancel;
    try {
      const r = await job.promise;
      if (enhTok.current !== tok) return false;
      enhRef.current = r; setEnh(r); setEnhState("done");
      if (r.method !== "none" && r.scale > 1) setHdView("hd");
    } catch {
      if (enhTok.current !== tok) return false;
      setEnhState("error");
    }
    return true;
  }, []);

  const setHdMode = (m: HdMode) => {
    if (m === hdMode) return;
    setHdModeState(m); modeRef.current = m; saveHdMode(m);
    const px = pixelsRef.current;
    if (!px || seedRef.current) return;
    const tok = ++enhTok.current;
    void prepare(px, tok).then((ok) => { if (ok) void run({ region, ocr, cellCodes, bgEmpty, cols, rows }); });
  };

  // 选图后：显示、解码、自动识别一次
  useEffect(() => {
    abort.current?.abort();
    setResult(null); setSteps([]); setRegion(null); setSelecting(false); setCols(""); setRows(""); setError(""); setPixels(null); pixelsRef.current = null; fullRef.current = null; setAi(null); setFocus(null); setView("orig"); setForceChart(false); setSavedOk(false); enhCancel.current?.(); enhRef.current = null; setEnh(null); setHdBlob(null); setUseHdSource(false); setHdView("hd"); const tok = ++enhTok.current; setEnhState(modeRef.current === "off" ? "off" : "running");
    if (!file) { setUrl(null); return; }
    const u = URL.createObjectURL(file);
    setUrl(u);
    let alive = true;
    loadPixelSource(file, 2400).then(async (px) => {
      if (!alive) return;
      const full = await loadPixelSource(file, 5000).catch(() => null);
      if (!alive) return;
      fullRef.current = full;
      pixelsRef.current = px; setPixels(px);
      const sd = seedRef.current;
      if (sd) { setSteps(sd.result.steps); setResult(sd.result); setCounts({ ...sd.result.counts }); setForceChart(true); }
      else {
        const ok = await prepare(px, tok);
        if (ok && alive) void run({ region: null, ocr, cellCodes, bgEmpty, cols: "", rows: "" });
      }
    }).catch(() => alive && setError("这张图片无法解码，请换一张"));
    return () => { alive = false; enhCancel.current?.(); URL.revokeObjectURL(u); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  const hdApplied = !!enh && enh.method !== "none" && enh.scale > 1 && hdMode === "auto";
  useEffect(() => {
    setHdBlob(null);
    if (!hdApplied || !enh) return;
    let alive = true;
    const { width, height, data } = enh.image;
    const c = document.createElement("canvas");
    c.width = width; c.height = height;
    c.getContext("2d")!.putImageData(new ImageData(data as unknown as ImageData["data"], width, height), 0, 0);
    c.toBlob((b) => { if (alive && b) setHdBlob(b); }, "image/png");
    return () => { alive = false; };
  }, [enh, hdApplied]);
  useEffect(() => {
    if (!hdBlob) { setHdUrl(null); return; }
    const u = URL.createObjectURL(hdBlob);
    setHdUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [hdBlob]);
  const downloadHd = () => {
    if (!hdBlob) { toast("高清图还在生成，请稍等"); return; }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(hdBlob);
    a.download = `${(file?.name || "图纸").replace(/\.[^.]+$/, "")}-高清.png`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  };

  const rerun = () => void run({ region, ocr, cellCodes, bgEmpty, cols, rows });
  const rerunWithSize = (sz: { cols: number; rows: number }) => {
    setCols(String(sz.cols)); setRows(String(sz.rows));
    void run({ region, ocr, cellCodes, bgEmpty, cols: String(sz.cols), rows: String(sz.rows) });
  };

  const diff = useMemo<DiffMap | null>(() => {
    if (!result || !result.diff.length) return null;
    return Object.fromEntries(result.diff.map((d) => [d.code, { legend: d.legend, grid: d.grid }]));
  }, [result]);
  const codeChecks = useMemo<CheckMap | null>(() => {
    if (!result?.checks?.length || !result.checks.some((c) => c.legend !== null)) return null;
    return Object.fromEntries(result.checks.map((c) => [c.code, { status: c.status, delta: Math.abs((c.legend ?? 0) - c.read) }]));
  }, [result]);
  const mismatches = diff ? Object.values(diff).filter((d) => d.legend !== d.grid).length : 0;

  const askAi = async () => {
    if (!file) return;
    setAiBusy(true);
    try {
      const out = await aiVision(await toJpegBase64(file), result?.legend?.rawText ?? "");
      const c: Counts = {};
      for (const [k, v] of Object.entries(out.result?.counts ?? {})) { const code = normalizeCode(k); if (code && v > 0) c[code] = Math.round(v); }
      if (!Object.keys(c).length) toast("本地视觉模型没有给出可用的色号");
      else setAi({ counts: c, notes: out.result?.notes, model: out.model });
    } catch (e) { toast(e instanceof Error ? `复核失败：${e.message}` : "复核失败"); }
    finally { setAiBusy(false); }
  };

  const save = async (values: SaveValues) => {
    if (!file) return;
    setSaving(true);
    try {
      const useHd = useHdSource && hdBlob;
      const meta = useHd ? await saveImage(hdBlob, `${(file.name || values.name).replace(/\.[^.]+$/, "")}-高清.png`, "source") : await saveImage(file, file.name || values.name, "source");
      const heavy = !result || result.method === "none" || editedHeavily(result.counts, counts);
      const grid = !heavy ? result?.grid : null;
      const method = heavy ? "manual" : result!.method === "none" ? "manual" : result!.method;
      const reasons = heavy || !result ? [] : reviewReasonsFor(result);
      const p = await createPattern(values, {
        kind: "recognized", method, counts, imageId: meta.id,
        width: grid?.grid.cols, height: grid?.grid.rows, matrix: grid?.matrix, confidence: heavy ? 1 : result?.confidence,
        reviewReasons: reasons.length ? reasons : undefined
      });
      toast("已保存到图库");
      setSaving(false); setSavedOk(true);
      await new Promise((r) => setTimeout(r, prefersReducedMotion() ? 0 : 700));
      if (onSaved) onSaved(p.id); else navigate(`/pattern/${p.id}`);
    } catch (e) { toast(e instanceof Error ? e.message : "保存失败"); setSaving(false); }
  };

  if (!file) {
    return (
      <div className="stack">
        <ImageDrop onFile={onFile} onFiles={onMulti ? (fs) => onMulti(fs, "ask") : undefined} title="上传拼豆图纸截图或照片" hint="支持拖入、粘贴、从相册或相机选择。有色号图例的图纸最准。" />
        {onMulti ? (
          <div className="st-entry">
            <button type="button" className="btn" onClick={() => stitchInput.current?.click()}><Icon name="scan" size={16} />多张截图拼接</button>
            <span className="meta">图纸很长、分了几段截的图？选中它们，自动拼成一张。</span>
            <input ref={stitchInput} type="file" accept="image/*" multiple hidden data-testid="stitch-input" onChange={(e) => { const fs = Array.from(e.target.files ?? []).filter((f) => f.type.startsWith("image/")); e.target.value = ""; if (fs.length) onMulti(fs, "stitch"); }} />
          </div>
        ) : null}
        <CaptureTips />
      </div>
    );
  }

  const conf = result ? Math.round(result.confidence * 100) : 0;
  const notChart = !!result && result.isChart === false && !forceChart;
  const matrix = result?.grid?.matrix && result.grid.matrix.length ? result.grid.matrix : null;
  const pick = (code: string) => setFocus((f) => (f === code ? null : code));
  const checks = result ? headerChecks(result) : [];
  const bgCount = result?.grid?.backgroundCells ?? 0;
  // 尺寸存疑提示：识别中、用户已手动指定尺寸、或点过“尺寸没错”时不显示（换新结果自动恢复）
  const sizeAsk = result && !notChart && !running && !ranForced && sizeDismissed !== result ? checkSize(result) : null;
  return (
    <div className="ap-grid">
      <section className="stack">
        <div className="panel panel-pad stack">
          {matrix && !notChart ? (
            <div className="seg" role="group" aria-label="图片视图" style={{ alignSelf: "flex-start" }}>
              <button type="button" aria-pressed={view === "orig"} onClick={() => setView("orig")}>原图</button>
              <button type="button" aria-pressed={view === "restored"} onClick={() => setView("restored")}>复原预览</button>
            </div>
          ) : null}
          {view === "restored" && matrix && result?.grid && !notChart ? (
            <>
              <MatrixView matrix={matrix} width={result.grid.grid.cols} height={result.grid.grid.rows} focusCode={focus} />
              <p className="meta">按识别结果重新画出的拼豆图。对照原图看，哪里颜色不对就是识别错的地方。</p>
            </>
          ) : url && pixels ? <AnalysisImage url={url} srcW={pixels.width} srcH={pixels.height} region={region} onRegion={setRegion} selecting={selecting} grid={notChart ? null : result?.grid?.grid ?? null} matrix={notChart ? null : matrix} focusCode={focus} bgMask={notChart ? null : result?.grid?.backgroundMask ?? null} showBg={showBg}
            pixels={pixels} reading={notChart ? null : result?.grid ?? null} checks={result?.checks} enhancedUrl={hdApplied ? hdUrl : null} view={hdView} /> : url ? <img src={url} alt="上传的图纸" /> : null}
          {!seed ? <EnhanceCard mode={hdMode} onMode={setHdMode} state={enhState} result={enh} applied={hdApplied && !!hdUrl} view={hdView} onView={setHdView} onDownload={downloadHd} disabled={running} /> : null}
          {bgCount > 0 && !notChart && view === "orig" ? (
            <label className="pt-check"><input type="checkbox" checked={showBg} onChange={(e) => setShowBg(e.target.checked)} />显示去掉的背景（{fmt(bgCount)} 格，已套灰）</label>
          ) : null}
          {focus && !notChart ? <div className="row"><span className="chip chip-iron">高亮 {focus}</span><button type="button" className="btn btn-sm btn-ghost" onClick={() => setFocus(null)}>取消高亮</button></div> : null}
          <div className="row">
            <button className={`btn btn-sm${selecting ? " btn-primary" : ""}`} onClick={() => setSelecting((s) => !s)} aria-pressed={selecting}>{selecting ? "拖动框选中…" : "框选图纸区域"}</button>
            {region ? <button className="btn btn-sm btn-ghost" onClick={() => setRegion(null)}>清除框选</button> : null}
            <span className="spacer" />
            <button className="btn btn-sm btn-ghost" onClick={onClear}>{clearLabel}</button>
          </div>
          <label className="pt-check"><input type="checkbox" checked={ocr} onChange={(e) => setOcr(e.target.checked)} />读取图例（OCR，需要几秒）</label>
          <label className="pt-check"><input type="checkbox" checked={cellCodes} onChange={(e) => setCellCodes(e.target.checked)} />读取格内色号（图纸每格印了色号时更准，白色豆也不会漏）</label>
          <label className="pt-check"><input type="checkbox" checked={bgEmpty} onChange={(e) => setBgEmpty(e.target.checked)} />背景格不计数</label>
          <div className="row">
            <label className="field" style={{ width: 84 }}><span>列数</span><input ref={colsInput} className="input num" inputMode="numeric" placeholder="自动" value={cols} onChange={(e) => setCols(e.target.value)} /></label>
            <label className="field" style={{ width: 84 }}><span>行数</span><input className="input num" inputMode="numeric" placeholder="自动" value={rows} onChange={(e) => setRows(e.target.value)} /></label>
            <button className="btn btn-primary" style={{ alignSelf: "flex-end" }} onClick={rerun} disabled={running || !pixels}>{running ? "识别中…" : "重新识别"}</button>
          </div>
        </div>
        <div className="panel panel-pad">
          <div className="row" style={{ marginBottom: 6 }}><Icon name="sparkle" /><b>豆探</b><span className="meta">图纸助手</span></div>
          <AssistantTimeline steps={steps} running={running} />
          {error ? <div className="notice iron" role="alert">{error}</div> : null}
        </div>
      </section>

      <section className="stack">
        {notChart ? (
          <div className="panel panel-pad pt-notchart" role="status">
            <span className="pt-notchart-ic"><Icon name="gallery" size={22} /></span>
            <div className="stack" style={{ gap: 6 }}>
              <h3>这看起来是原图，不是图纸</h3>
              <p className="meta">{result?.notChartReason || "没有找到规则的拼豆格子，也没有色号图例。"}</p>
              <p className="meta">想把它做成拼豆？可以直接转换成图纸。</p>
            </div>
            <div className="row">
              {onGenerate ? <button type="button" className="btn btn-iron" onClick={onGenerate}><Icon name="wand" />用它生成图纸</button> : null}
              <button type="button" className="btn" onClick={() => setForceChart(true)}>仍然按图纸识别</button>
            </div>
          </div>
        ) : result ? (
          <div className="panel">
            <div className="panel-head">
              <h3>识别结果</h3>
              <div className="row">
                <span className="chip">{result.method === "none" ? "未识别到用量" : METHOD_LABEL[result.method]}</span>
                {result.cellCodesRead && result.cellCodeStats ? <span className="chip chip-leaf" title={`格内色号校正了 ${result.cellCodeStats.overrides} 个颜色匹配`}>格内色号 {result.cellCodeStats.read}/{result.cellCodeStats.clusters} 色</span> : null}
                <span className={`chip ${conf >= 80 ? "chip-leaf" : conf >= 50 ? "chip-amber" : "chip-iron"}`}>可信度 {conf}%</span>
              </div>
            </div>
            {result.method === "none" ? <div className="notice iron" style={{ margin: 12 }}>没有读到图例，也没能确定网格。可以框选图纸区域、手动填列数和行数后重新识别，或直接在下表手动添加。</div> : null}
            {sizeAsk ? (
              <div className="notice st-hint" role="status" data-testid="size-check" style={{ margin: 12 }}>
                <span><b>请确认尺寸：</b>{sizeAsk.reason}。</span>
                <span className="row">
                  {sizeAsk.suggested ? <button type="button" className="btn btn-sm btn-primary" onClick={() => rerunWithSize(sizeAsk.suggested!)}>按 {sizeAsk.suggested.cols}×{sizeAsk.suggested.rows} 重新识别</button> : null}
                  <button type="button" className="btn btn-sm" onClick={() => colsInput.current?.focus()}>手动修改</button>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSizeDismissed(result)}>尺寸没错</button>
                </span>
              </div>
            ) : null}
            {result.paletteWarning ? <div className="notice" role="note" style={{ margin: 12 }}><b>色号体系提示：</b>{result.paletteWarning}</div> : null}
            {checks.length ? (
              <div className="pt-header" aria-label="图上标注核对">
                <span className="label">图上标注</span>
                <b className="num">{checks.map((c) => c.stated).join(" · ")}</b>
                <span className="pt-header-chips">
                  {checks.map((c) => (
                    <span key={c.key} className={`chip ${c.ok === true ? "chip-leaf" : c.ok === false ? "chip-amber" : ""}`}>
                      {c.label} {c.ok === true ? "一致" : c.ok === false ? `不符，读到 ${c.read}` : "未读到"}
                    </span>
                  ))}
                </span>
              </div>
            ) : null}
            {mismatches ? <div className="notice" style={{ margin: 12 }}>有 {mismatches} 个色号的图例数量和网格数出来的不一致（高亮行）。请对照原图核对。</div> : null}
            {result.legend?.statedTotal != null ? <p className="meta" style={{ padding: "8px 12px 0" }}>图上标注的总数 {fmt(result.legend.statedTotal)}，当前合计 <DiffNumber value={totalOf(counts)} /></p> : null}
            {matrix ? <p className="meta" style={{ padding: "8px 12px 0" }}>点一个色号，图上只亮出它的格子。</p> : null}
            <CountsEditor counts={counts} onChange={setCounts} diff={diff} checks={codeChecks} stagger focusCode={focus} onPick={matrix ? pick : undefined} />
          </div>
        ) : running ? <div className="panel empty pegboard"><h3>豆探正在分析…</h3><p>步骤会实时显示在左侧</p></div> : null}

        {aiOn && result && !notChart ? (
          <div className="panel panel-pad stack">
            <div className="row"><b>本地视觉模型</b><span className="spacer" /><button className="btn btn-sm" onClick={askAi} disabled={aiBusy}>{aiBusy ? "复核中…（可能要几十秒）" : "让本地视觉模型复核"}</button></div>
            {ai ? (
              <>
                <p className="meta">{ai.model} 给出 {Object.keys(ai.counts).length} 色，共 {fmt(totalOf(ai.counts))} 颗。{ai.notes ?? ""}</p>
                <div className="row"><button className="btn btn-sm" onClick={() => { setCounts(ai.counts); toast("已采用视觉模型的结果"); }}>采用它的结果</button><button className="btn btn-sm btn-ghost" onClick={() => setAi(null)}>忽略</button></div>
              </>
            ) : null}
          </div>
        ) : null}

        {result && !notChart && (result.enhance?.level === "low" || result.enhance?.level === "very-low") ? (
          <div className="notice st-hint" role="note" data-testid="low-quality-hint">
            <span><b>这张图偏{result.enhance.level === "very-low" ? "很" : ""}糊。</b>如果读出来的数量对不上，换一张更清楚的原图会更准。</span>
            <button type="button" className="btn btn-sm" aria-expanded={tipsOpen} onClick={() => setTipsOpen((o) => !o)}>{tipsOpen ? "收起小贴士" : "怎样拿到更清楚的图"}</button>
            {tipsOpen ? <TipsList /> : null}
          </div>
        ) : null}

        {result && !notChart ? (
          <div className="panel panel-pad">
            {hdBlob ? <label className="pt-check" style={{ marginBottom: 8 }}><input type="checkbox" checked={useHdSource} onChange={(e) => setUseHdSource(e.target.checked)} />用高清版作为原图（图库里保存放大后的图）</label> : null}
            <SaveForm defaultName={seed?.name || (file.name || "").replace(/\.[^.]+$/, "") || "新图纸"} defaultTags={seed?.tags} defaultStatus={seed?.status} busy={saving} success={savedOk} disabled={!Object.keys(counts).length} onSave={save} />
          </div>
        ) : null}
      </section>
    </div>
  );
}
