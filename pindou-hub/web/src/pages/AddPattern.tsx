// 焦点元素：图片投放区——选图后立刻变成“图 + 豆探助手时间线 + 可编辑结果”。
import { useEffect, useState } from "react";
import { getBlob, useData } from "../lib/db";
import { fetchBlobFromHub } from "../lib/sync";
import { navigate, useRoute } from "../components/ui";
import RecognizePanel, { type RecognizeSeed } from "../components/pattern/RecognizePanel";
import BatchPanel from "../components/pattern/BatchPanel";
import { batchStore, enqueue } from "../components/pattern/batchRunner";
import StitchPanel from "../components/pattern/StitchPanel";
import MultiChoice from "../components/pattern/MultiChoice";
import type { BatchItem } from "../lib/batch";
import GeneratePanel from "../components/pattern/GeneratePanel";
import ManualPanel from "../components/pattern/ManualPanel";
import "./AddPattern.css";

type Mode = "recognize" | "generate" | "manual" | "batch";
const MODES: Array<{ id: Mode; label: string; hint: string }> = [
  { id: "recognize", label: "识别图纸", hint: "上传现成的拼豆图纸，读出每个色号要多少颗" },
  { id: "generate", label: "生成图纸", hint: "上传照片或插画，转换成拼豆图纸" },
  { id: "manual", label: "手动录入", hint: "直接输入或粘贴色号和数量" },
  { id: "batch", label: "批量导入", hint: "一次选很多张图纸或整个文件夹，逐张识别后一起保存" }
];

export default function AddPattern() {
  const route = useRoute();
  const data = useData();
  const raw = route.query.get("mode");
  const mode: Mode = raw === "generate" || raw === "manual" || raw === "batch" ? raw : "recognize";
  const imageId = route.query.get("image");
  const [file, setFile] = useState<File | null>(null);
  const [loadError, setLoadError] = useState("");
  /** 多张图：asking = 先问是拼接还是批量；stitching = 拼接面板 */
  const [multi, setMulti] = useState<{ files: File[]; step: "asking" | "stitching" } | null>(null);
  /** 批量队列里“检查 / 查看 / 仍按图纸识别”打开的那一张：用单张识别视图审阅，保存后回到队列 */
  const [review, setReview] = useState<{ id: string; file: File; seed: RecognizeSeed } | null>(null);

  useEffect(() => {
    if (!imageId) return;
    let alive = true;
    (async () => {
      const blob = (await getBlob(imageId)) ?? (await fetchBlobFromHub(imageId));
      if (!alive) return;
      if (!blob) { setLoadError("这张图片还在同步中，稍后再试"); return; }
      const meta = data.images.find((i) => i.id === imageId);
      setLoadError("");
      setFile(new File([blob], meta?.name || "图片", { type: blob.type || meta?.mime || "image/png" }));
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageId]);

  // 切换方式（含浏览器前进 / 后退）时丢掉多图选择 / 拼接面板
  useEffect(() => { setMulti(null); }, [mode]);

  const go = (m: Mode) => { setReview(null); setMulti(null); navigate(`/add?mode=${m}`); };
  const toGenerate = (f: File) => { setFile(f); setReview(null); navigate("/add?mode=generate"); };
  const openReview = (it: BatchItem) => {
    // notchart / 无结果的条目没有可用 seed：直接按单张重新识别
    const seed: RecognizeSeed | null = it.result && it.state === "done"
      ? { result: it.result, name: it.name, tags: it.tag, status: "idea", verifiedAt: it.verifiedAt } : null;
    setReview({ id: it.id, file: it.file, seed: seed ?? (null as unknown as RecognizeSeed) });
  };
  const clear = () => { setFile(null); if (imageId) navigate(`/add?mode=${mode}`); };
  const current = MODES.find((m) => m.id === mode)!;

  return (
    <div className="ap-page">
      <div className="page-head">
        <div>
          <h1>添加图纸</h1>
          <p>{current.hint}</p>
        </div>
        <div className="seg" role="group" aria-label="添加方式">
          {MODES.map((m) => <button key={m.id} aria-pressed={mode === m.id} onClick={() => go(m.id)}>{m.label}</button>)}
        </div>
      </div>
      {loadError ? <div className="notice" role="alert" style={{ marginBottom: 12 }}>{loadError}</div> : null}
      {mode === "recognize" && multi?.step === "stitching" ? (
        <StitchPanel files={multi.files} onCancel={() => setMulti(null)} onUse={(f) => { setMulti(null); setFile(f); }} />
      ) : null}
      {mode === "recognize" && multi?.step === "asking" ? (
        <MultiChoice count={multi.files.length} onStitch={() => setMulti({ files: multi.files, step: "stitching" })}
          onBatch={() => { enqueue(multi.files); setMulti(null); navigate("/add?mode=batch"); }} onCancel={() => setMulti(null)} />
      ) : null}
      {mode === "recognize" && !multi ? (
        <RecognizePanel file={file} onFile={setFile} onClear={clear} onGenerate={file ? () => toGenerate(file) : undefined}
          onMulti={(files, how) => setMulti({ files, step: how === "stitch" ? "stitching" : "asking" })} />
      ) : null}
      {mode === "batch" ? (
        <>
          <div hidden={!!review}><BatchPanel onReview={openReview} onGenerate={toGenerate} /></div>
          {review ? (
            <RecognizePanel key={review.id} file={review.file} onFile={() => {}} onClear={() => setReview(null)} clearLabel="返回批量列表"
              seed={review.seed} onGenerate={() => toGenerate(review.file)}
              onVerified={(edit) => {
                if (edit) batchStore.dispatch({ type: "edited", id: review.id, result: edit.result, reasons: edit.reasons });
                batchStore.dispatch({ type: "verify", id: review.id });
                setReview(null);
              }}
              onSaved={(pid) => { batchStore.dispatch({ type: "saved", id: review.id, patternId: pid }); setReview(null); }} />
          ) : null}
        </>
      ) : null}
      {mode === "generate" ? <GeneratePanel file={file} onFile={setFile} onClear={clear} /> : null}
      {mode === "manual" ? <ManualPanel /> : null}
    </div>
  );
}
