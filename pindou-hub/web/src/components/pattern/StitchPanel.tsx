// 焦点元素：拼接结果预览（可缩放，带接缝标记）。进来之前是缩略图排序，之后是「用拼好的图识别」。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { loadPixelSource } from "../../lib/images";
import { startStitch, pixelsToPng, type StitchJob } from "../../lib/stitch/client";
import type { StitchResult } from "../../lib/stitch";
import { Icon, fmt, toast } from "../ui";
import Progress from "./Progress";
import ZoomPan from "./ZoomPan";
import "./stitch.css";

type Item = { id: number; file: File; url: string };
type Done = { result: StitchResult; blob: Blob; url: string };
let nextId = 1;
const mk = (file: File): Item => ({ id: nextId++, file, url: URL.createObjectURL(file) });

export default function StitchPanel({ files, onUse, onCancel }: { files: File[]; onUse: (file: File) => void; onCancel: () => void }) {
  const [items, setItems] = useState<Item[]>(() => files.map(mk));
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ percent: 0, label: "" });
  const [done, setDone] = useState<Done | null>(null);
  const [error, setError] = useState("");
  const [seams, setSeams] = useState(true);
  const job = useRef<StitchJob | null>(null);
  const urls = useRef<string[]>([]);
  const adder = useRef<HTMLInputElement>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  urls.current = [...items.map((i) => i.url), ...(done ? [done.url] : [])];

  useEffect(() => () => { job.current?.cancel(); urls.current.forEach((u) => URL.revokeObjectURL(u)); }, []);

  const invalidate = () => { setDone((d) => { if (d) URL.revokeObjectURL(d.url); return null; }); setError(""); };
  const edit = (fn: (list: Item[]) => Item[]) => { invalidate(); setItems(fn); };
  const move = (i: number, d: number) => edit((l) => { const n = [...l]; const j = i + d; if (j < 0 || j >= n.length) return l; [n[i], n[j]] = [n[j], n[i]]; return n; });
  const remove = (i: number) => edit((l) => { URL.revokeObjectURL(l[i].url); return l.filter((_, k) => k !== i); });
  const add = (list: FileList | null) => {
    const imgs = Array.from(list ?? []).filter((f) => f.type.startsWith("image/"));
    if (imgs.length) edit((l) => [...l, ...imgs.map(mk)]);
  };

  const run = useCallback(async () => {
    const list = itemsRef.current;
    if (list.length < 2) return;
    setRunning(true); setError(""); setProgress({ percent: 1, label: "读取图片" });
    try {
      const px = [];
      for (let i = 0; i < list.length; i += 1) {
        px.push(await loadPixelSource(list[i].file, 4096));
        setProgress({ percent: 1 + ((i + 1) / list.length) * 5, label: `读取图片 ${i + 1}/${list.length}` });
      }
      const j = startStitch(px, (percent, label) => setProgress({ percent: 6 + percent * 0.9, label }));
      job.current = j;
      const result = await j.promise;
      setProgress({ percent: 97, label: "生成预览" });
      const blob = await pixelsToPng(result.image);
      setDone({ result, blob, url: URL.createObjectURL(blob) });
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) setError(e instanceof Error ? e.message : "拼接失败");
    } finally { job.current = null; setRunning(false); }
  }, []);

  // 带着 2 张以上进来时自动开始拼
  const started = useRef(false);
  useEffect(() => { if (!started.current && items.length >= 2) { started.current = true; void run(); } }, [items.length, run]);

  const cancelRun = () => { job.current?.cancel(); };
  const r = done?.result;
  const conf = r ? Math.round(r.confidence * 100) : 0;
  const usable = !!r && r.included.filter(Boolean).length >= 1 && (r.included.filter(Boolean).length >= 2 || items.length === 1);
  const overlaps = useMemo(() => {
    if (!r) return [];
    const out: Array<{ x: number; y: number; w: number; h: number }> = [];
    const rs = r.rects.map((q) => q);
    for (let a = 0; a < rs.length; a += 1) for (let b = a + 1; b < rs.length; b += 1) {
      const p = rs[a], q = rs[b];
      if (!p || !q) continue;
      const x0 = Math.max(p.x, q.x), y0 = Math.max(p.y, q.y), x1 = Math.min(p.x + p.width, q.x + q.width), y1 = Math.min(p.y + p.height, q.y + q.height);
      if (x1 > x0 && y1 > y0) out.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    }
    return out;
  }, [r]);

  const use = () => {
    if (!done) return;
    onUse(new File([done.blob], `拼接图-${items.length}张.png`, { type: "image/png" }));
    toast("已用拼好的图开始识别");
  };

  return (
    <div className="ap-grid st-grid" data-testid="stitch-panel">
      <section className="stack">
        <div className="panel panel-pad stack">
          <div className="row"><Icon name="scan" size={18} /><h3>多张截图拼接</h3><span className="spacer" /><button type="button" className="btn btn-sm btn-ghost" onClick={onCancel}>返回</button></div>
          <p className="meta">同一张图纸分段截的图，按什么顺序都行，会自动找重叠部分拼起来。</p>
          <ol className="st-thumbs" aria-label="待拼接的截图">
            {items.map((it, i) => {
              const out = r && !r.included[i];
              return (
                <li key={it.id} className="st-thumb" data-out={!!out}>
                  <img src={it.url} alt={`第 ${i + 1} 张截图`} draggable={false} />
                  <span className="st-num">{i + 1}</span>
                  {out ? <span className="chip chip-iron st-out">没接上</span> : null}
                  <div className="st-thumb-actions">
                    <button type="button" className="st-ib pressable" aria-label={`第 ${i + 1} 张前移`} disabled={running || i === 0} onClick={() => move(i, -1)}><Icon name="back" size={16} /></button>
                    <button type="button" className="st-ib pressable" aria-label={`第 ${i + 1} 张后移`} disabled={running || i === items.length - 1} onClick={() => move(i, 1)}><span className="st-flip"><Icon name="back" size={16} /></span></button>
                    <button type="button" className="st-ib pressable" aria-label={`移除第 ${i + 1} 张`} disabled={running} onClick={() => remove(i)}><Icon name="x" size={16} /></button>
                  </div>
                </li>
              );
            })}
            <li className="st-thumb st-add">
              <button type="button" className="pressable" disabled={running} onClick={() => adder.current?.click()}><Icon name="plus" size={20} /><span>继续添加</span></button>
            </li>
          </ol>
          <input ref={adder} type="file" accept="image/*" multiple hidden onChange={(e) => { add(e.target.files); e.target.value = ""; }} />
          {running ? (
            <div className="stack" role="status" aria-live="polite">
              <Progress value={progress.percent / 100} label="拼接进度" />
              <div className="row"><span className="meta">{progress.label}… {Math.round(progress.percent)}%</span><span className="spacer" /><button type="button" className="btn btn-sm" onClick={cancelRun}>取消</button></div>
            </div>
          ) : (
            <div className="row">
              <button type="button" className="btn btn-primary" onClick={() => void run()} disabled={items.length < 2}>{done ? "重新拼接" : "开始拼接"}</button>
              {items.length < 2 ? <span className="meta">至少需要 2 张</span> : null}
            </div>
          )}
          {error ? <div className="notice iron" role="alert">{error}</div> : null}
        </div>
      </section>

      <section className="stack">
        {done && r ? (
          <div className="panel" data-testid="stitch-result">
            <div className="panel-head">
              <h3>拼接结果</h3>
              <div className="row">
                <span className="chip">{fmt(r.image.width)}×{fmt(r.image.height)}</span>
                <span className={`chip ${conf >= 85 ? "chip-leaf" : conf >= 60 ? "chip-amber" : "chip-iron"}`}>可信度 {conf}%</span>
              </div>
            </div>
            <div className="panel-pad stack">
              {r.warnings.length ? <ul className="st-warn" aria-label="拼接提示">{r.warnings.map((w) => <li key={w} className="notice">{w}</li>)}</ul> : null}
              <ZoomPan label="拼好的长图预览" natW={r.image.width} thumb={done.url} hint="拖动平移 · 双指或 + / − 缩放 · 虚线是每张截图的范围，浅色块是重叠部分">
                <div className="pt-stage">
                  <img src={done.url} alt="拼好的图" draggable={false} />
                  {seams ? (
                    <svg className="pt-over st-seams" viewBox={`0 0 ${r.image.width} ${r.image.height}`} preserveAspectRatio="none" aria-hidden="true">
                      {overlaps.map((o, k) => <rect key={`o${k}`} className="st-ov" x={o.x} y={o.y} width={o.w} height={o.h} />)}
                      {r.rects.map((q, k) => q ? (
                        <g key={k}>
                          <rect className="st-rect" x={q.x} y={q.y} width={q.width} height={q.height} />
                          <text className="st-label" x={q.x + r.image.width * 0.012} y={q.y + Math.max(r.image.width, r.image.height) * 0.03} fontSize={Math.max(r.image.width, r.image.height) * 0.026}>{k + 1}</text>
                        </g>
                      ) : null)}
                    </svg>
                  ) : null}
                </div>
              </ZoomPan>
              <label className="pt-check"><input type="checkbox" checked={seams} onChange={(e) => setSeams(e.target.checked)} />显示接缝（每张截图的范围和重叠部分）</label>
              <p className="meta">接缝处自动取离截图边缘更远的那一张，不做模糊混合。请放大看看接缝处的格子有没有错位。</p>
              <div className="row">
                <button type="button" className="btn btn-iron" onClick={use} disabled={!usable}><Icon name="check" size={16} />用拼好的图识别</button>
                <span className="spacer" />
                <button type="button" className="btn btn-sm btn-ghost" onClick={invalidate}>收起结果</button>
              </div>
            </div>
          </div>
        ) : running ? (
          <div className="panel empty pegboard"><h3>正在拼接…</h3><p>在这台设备上完成，图片不会上传</p></div>
        ) : (
          <div className="panel empty pegboard"><h3>拼好的图会显示在这里</h3><p>检查缩略图顺序和数量，再点「开始拼接」</p></div>
        )}
      </section>
    </div>
  );
}
