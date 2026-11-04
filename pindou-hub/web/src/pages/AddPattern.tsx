// 焦点元素：图片投放区——选图后立刻变成“图 + 豆探助手时间线 + 可编辑结果”。
import { useEffect, useState } from "react";
import { getBlob, useData } from "../lib/db";
import { navigate, useRoute } from "../components/ui";
import RecognizePanel from "../components/pattern/RecognizePanel";
import GeneratePanel from "../components/pattern/GeneratePanel";
import ManualPanel from "../components/pattern/ManualPanel";
import "./AddPattern.css";

type Mode = "recognize" | "generate" | "manual";
const MODES: Array<{ id: Mode; label: string; hint: string }> = [
  { id: "recognize", label: "识别图纸", hint: "上传现成的拼豆图纸，读出每个色号要多少颗" },
  { id: "generate", label: "生成图纸", hint: "上传照片或插画，转换成拼豆图纸" },
  { id: "manual", label: "手动录入", hint: "直接输入或粘贴色号和数量" }
];

export default function AddPattern() {
  const route = useRoute();
  const data = useData();
  const raw = route.query.get("mode");
  const mode: Mode = raw === "generate" || raw === "manual" ? raw : "recognize";
  const imageId = route.query.get("image");
  const [file, setFile] = useState<File | null>(null);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    if (!imageId) return;
    let alive = true;
    getBlob(imageId).then((blob) => {
      if (!alive) return;
      if (!blob) { setLoadError("这张图片还在同步中，稍后再试"); return; }
      const meta = data.images.find((i) => i.id === imageId);
      setLoadError("");
      setFile(new File([blob], meta?.name || "图片", { type: blob.type || meta?.mime || "image/png" }));
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageId]);

  const go = (m: Mode) => navigate(`/add?mode=${m}`);
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
      {mode === "recognize" ? <RecognizePanel file={file} onFile={setFile} onClear={clear} /> : null}
      {mode === "generate" ? <GeneratePanel file={file} onFile={setFile} onClear={clear} /> : null}
      {mode === "manual" ? <ManualPanel /> : null}
    </div>
  );
}
