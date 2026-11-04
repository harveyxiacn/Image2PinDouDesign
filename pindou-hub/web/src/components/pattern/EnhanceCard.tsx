import type { EnhanceMethod, EnhanceResult, QualityLevel } from "../../lib/enhance";
import { Icon } from "../ui";
import type { ImageView } from "./AnalysisImage";
import "./pattern.css";

export type HdMode = "auto" | "off";
export type EnhState = "off" | "running" | "done" | "error";

const LEVEL: Record<QualityLevel, { label: string; cls: string }> = {
  good: { label: "清晰", cls: "chip-leaf" },
  low: { label: "偏糊", cls: "chip-amber" },
  "very-low": { label: "很糊", cls: "chip-iron" }
};
const METHOD: Record<EnhanceMethod, string> = { "chart-rebuild": "按网格重建", "sharp-upscale": "锐化放大", none: "未处理" };

const KEY = "pindou.hdMode";
export function loadHdMode(): HdMode {
  try { return localStorage.getItem(KEY) === "off" ? "off" : "auto"; } catch { return "auto"; }
}
export function saveHdMode(m: HdMode) {
  try { localStorage.setItem(KEY, m); } catch { /* 隐私模式 / 被禁用：本次有效即可 */ }
}

/** 高清化概况卡：清晰度等级 + 原因 + 做了什么；自动 / 关 开关；原图 / 高清 / 对比 视图；下载高清图。 */
export default function EnhanceCard({ mode, onMode, state, result, applied, view, onView, onDownload, disabled }: {
  mode: HdMode; onMode: (m: HdMode) => void; state: EnhState; result: EnhanceResult | null; applied: boolean;
  view: ImageView; onView: (v: ImageView) => void; onDownload: () => void; disabled?: boolean;
}) {
  const q = result?.quality;
  const lv = q ? LEVEL[q.level] : null;
  return (
    <div className="pt-enh" data-testid="enhance-card" data-state={state} data-applied={applied}>
      <div className="pt-enh-head">
        <Icon name="wand" size={16} /><b>高清化</b>
        <div className="seg" role="group" aria-label="高清化">
          <button type="button" aria-pressed={mode === "auto"} onClick={() => onMode("auto")} disabled={disabled}>自动</button>
          <button type="button" aria-pressed={mode === "off"} onClick={() => onMode("off")} disabled={disabled}>关</button>
        </div>
        {mode === "auto" && state === "done" && lv ? <span className={`chip ${lv.cls}`}>{lv.label}</span> : null}
        <span className="meta" role="status">
          {mode === "off" ? "已关闭，直接用原图识别" : state === "running" ? "正在评估图片清晰度…" : state === "error" ? "高清化失败，已改用原图" : state === "done" && result ? (applied ? <>已高清化 ×{Math.round(result.scale * 10) / 10} · {METHOD[result.method]}</> : "图片已足够清晰") : ""}
        </span>
      </div>
      {mode === "auto" && state === "done" && q && q.reasons.length ? <ul aria-label="清晰度原因">{q.reasons.map((r) => <li key={r}>{r}</li>)}</ul> : null}
      {mode === "auto" && applied && result ? <p className="meta">{result.detail}</p> : null}
      {applied ? (
        <div className="row">
          <div className="seg" role="group" aria-label="图片显示">
            <button type="button" aria-pressed={view === "orig"} onClick={() => onView("orig")}>原图</button>
            <button type="button" aria-pressed={view === "hd"} onClick={() => onView("hd")}>高清</button>
            <button type="button" aria-pressed={view === "compare"} onClick={() => onView("compare")}>对比</button>
          </div>
          <span className="spacer" />
          <button type="button" className="btn btn-sm" onClick={onDownload}><Icon name="download" size={16} />下载高清图</button>
        </div>
      ) : null}
    </div>
  );
}
