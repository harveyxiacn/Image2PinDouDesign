import type { Pattern } from "../../lib/model";
import { STATUS_LABEL, totalOf } from "../../lib/model";
import { readiness } from "../../lib/inventory";
import type { Counts } from "../../lib/model";
import { fmt, useBlobUrl } from "../ui";
import "./pattern.css";

export function Thumb({ id, fallbackId, alt }: { id?: string; fallbackId?: string; alt: string }) {
  const first = useBlobUrl(id, "thumb");
  const second = useBlobUrl(id ? undefined : fallbackId, "thumb");
  const url = first ?? second;
  return (
    <div className={`pt-thumb${url ? "" : " ph pegboard"}`}>
      {url ? <img src={url} alt={alt} loading="lazy" /> : <span>{id || fallbackId ? "图片同步中…" : "暂无图片"}</span>}
    </div>
  );
}

const STATUS_CHIP: Record<Pattern["status"], string> = { idea: "chip", planned: "chip chip-amber", making: "chip chip-iron", done: "chip chip-leaf" };

export function ReadinessMeter({ pattern, stock, inventoryReady = true }: { pattern: Pattern; stock: Counts; inventoryReady?: boolean }) {
  const r = readiness(pattern, stock);
  if (!totalOf(pattern.counts)) return <span className="meta">还没有用量</span>;
  if (!inventoryReady) {
    return (
      <div style={{ display: "grid", gap: 4 }}>
        <div className="meter" role="img" aria-label="库存未录入"><i style={{ width: 0 }} /></div>
        <span className="meta">库存未录入 · 需 {Object.keys(pattern.counts).filter((c) => pattern.counts[c] > 0).length} 色</span>
      </div>
    );
  }
  const cls = r.missing.length === 0 ? "ok" : r.coverage > 0.7 ? "low" : "short";
  return (
    <div style={{ display: "grid", gap: 4 }}>
      <div className={`meter ${cls}`} role="img" aria-label={`库存覆盖 ${Math.round(r.coverage * 100)}%`}><i style={{ width: `${Math.round(Math.min(1, r.coverage) * 100)}%` }} /></div>
      <span className="meta">{r.missing.length === 0 ? `可做 ${Math.max(r.makeable, 1)} 份` : `缺 ${r.missing.length} 色`}</span>
    </div>
  );
}

export default function PatternCard({ pattern, stock, inventoryReady = true }: { pattern: Pattern; stock: Counts; inventoryReady?: boolean }) {
  const colors = Object.values(pattern.counts).filter((n) => n > 0).length;
  return (
    <a className="panel pt-card pressable" href={`#/pattern/${pattern.id}`}>
      <Thumb id={pattern.previewId} fallbackId={pattern.imageId} alt={pattern.name} />
      <div className="pt-card-body">
        <div className="row" style={{ flexWrap: "nowrap" }}>
          <span className="pt-card-title" style={{ flex: 1, minWidth: 0 }}>{pattern.name}</span>
          <span className={STATUS_CHIP[pattern.status]}>{STATUS_LABEL[pattern.status]}</span>
        </div>
        <div className="pt-card-stats">
          <span><span className="num">{fmt(totalOf(pattern.counts))}</span> <span className="meta">颗</span></span>
          <span><span className="num">{colors}</span> <span className="meta">色</span></span>
          {pattern.copies > 1 ? <span className="meta">×{pattern.copies} 份</span> : null}
          {pattern.verifiedAt == null ? <span className="chip chip-amber pt-unverified">未核对</span> : null}
        </div>
        <ReadinessMeter pattern={pattern} stock={stock} inventoryReady={inventoryReady} />
      </div>
    </a>
  );
}
