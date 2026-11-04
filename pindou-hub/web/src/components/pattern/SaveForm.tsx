import { useEffect, useState } from "react";
import type { PatternStatus } from "../../lib/model";
import { STATUS_LABEL } from "../../lib/model";

export type SaveValues = { name: string; tags: string[]; status: PatternStatus; copies: number };

export function parseTags(text: string): string[] {
  return Array.from(new Set(text.split(/[,，、\s]+/).map((t) => t.trim()).filter(Boolean)));
}

/** 保存前的确认表单：名称 / 标签 / 状态 / 份数。 */
export default function SaveForm({ defaultName, defaultTags = "", defaultStatus = "planned", busy, success, disabled, label = "保存到图库", onSave }: {
  defaultName: string; defaultTags?: string; defaultStatus?: PatternStatus; busy?: boolean; success?: boolean; disabled?: boolean; label?: string; onSave: (v: SaveValues) => void;
}) {
  const [name, setName] = useState(defaultName);
  const [tags, setTags] = useState(defaultTags);
  const [status, setStatus] = useState<PatternStatus>(defaultStatus);
  const [copies, setCopies] = useState(1);
  useEffect(() => { setName(defaultName); }, [defaultName]);
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); onSave({ name: name.trim() || defaultName || "未命名图纸", tags: parseTags(tags), status, copies: Math.max(1, copies) }); }}>
      <label className="field"><span>名称</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="给图纸起个名字" /></label>
      <label className="field"><span>标签（用逗号或空格分隔）</span><input className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="例如 动物, 挂件" /></label>
      <div className="field">
        <span>状态</span>
        <div className="seg" role="group" aria-label="状态">
          {(["idea", "planned"] as PatternStatus[]).map((s) => (
            <button type="button" key={s} aria-pressed={status === s} onClick={() => setStatus(s)}>{s === "idea" ? `${STATUS_LABEL.idea}（想法）` : `${STATUS_LABEL.planned}`}</button>
          ))}
        </div>
        <span className="meta">“计划做”会计入采购清单</span>
      </div>
      <label className="field"><span>份数</span><input className="input num" type="number" min={1} max={99} value={copies} onChange={(e) => setCopies(Number(e.target.value) || 1)} style={{ maxWidth: 120 }} /></label>
      <button className="btn btn-iron btn-block pt-save" type="submit" data-success={success ? "true" : undefined} disabled={busy || success || disabled}>
        {success ? <><svg className="pt-tick" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5 10 17 19 7" /></svg>已保存</> : busy ? "保存中…" : label}
      </button>
      <span className="sr-only" role="status">{success ? "已保存到图库" : ""}</span>
    </form>
  );
}
