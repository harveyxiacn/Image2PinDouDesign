import { useEffect, useState } from "react";
import type { PatternStatus } from "../../lib/model";
import { STATUS_LABEL } from "../../lib/model";

export type SaveValues = { name: string; tags: string[]; status: PatternStatus; copies: number };

export function parseTags(text: string): string[] {
  return Array.from(new Set(text.split(/[,，、\s]+/).map((t) => t.trim()).filter(Boolean)));
}

/** 保存前的确认表单：名称 / 标签 / 状态 / 份数。 */
export default function SaveForm({ defaultName, busy, disabled, label = "保存到图库", onSave }: {
  defaultName: string; busy?: boolean; disabled?: boolean; label?: string; onSave: (v: SaveValues) => void;
}) {
  const [name, setName] = useState(defaultName);
  const [tags, setTags] = useState("");
  const [status, setStatus] = useState<PatternStatus>("planned");
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
      <button className="btn btn-iron btn-block" type="submit" disabled={busy || disabled}>{busy ? "保存中…" : label}</button>
    </form>
  );
}
