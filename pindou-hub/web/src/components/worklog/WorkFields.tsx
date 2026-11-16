// 完工记录的表单字段：日期、成品照片、评分、给谁了、用时、备注。标记完成的抽屉和详情页的“编辑记录”共用。
import { useEffect, useState } from "react";
import { saveImage } from "../../lib/images";
import { useBlobUrl } from "../ui";
import { buildDurationMs, dateInputValue, parseDateInput, type WorkInput } from "../../lib/worklog";
import type { WorkEntry } from "../../lib/model";
import "./worklog.css";

export type WorkDraft = {
  date: string;
  note: string;
  rating: number;
  tag: string;
  /** 用时（分钟，文本，空表示没记） */
  minutes: string;
  /** 已保存的照片 */
  photoId?: string;
  /** 刚选的、还没保存的照片 */
  file: File | null;
};

export function newDraft(now: number, build?: unknown): WorkDraft {
  const ms = buildDurationMs(build);
  return { date: dateInputValue(now), note: "", rating: 0, tag: "", minutes: ms ? String(Math.max(1, Math.round(ms / 60000))) : "", file: null };
}

export function draftOf(e: WorkEntry): WorkDraft {
  return { date: dateInputValue(e.at), note: e.note ?? "", rating: e.rating ?? 0, tag: e.tag ?? "", minutes: e.durationMs ? String(Math.max(1, Math.round(e.durationMs / 60000))) : "", photoId: e.photoId, file: null };
}

/** 草稿转成可保存的输入；有新照片时先存进图库。日期没改的保持原时间（编辑时不挪动当天的时刻）。 */
export async function draftToInput(d: WorkDraft, now: number, keepAt?: number): Promise<{ input: WorkInput; photoFailed: boolean }> {
  let photoId = d.photoId;
  let photoFailed = false;
  if (d.file) {
    try { photoId = (await saveImage(d.file, d.file.name || "成品照片", "source")).id; } catch { photoFailed = true; }
  }
  const at = keepAt != null && dateInputValue(keepAt) === d.date ? keepAt : parseDateInput(d.date, now) ?? keepAt ?? now;
  const min = Number(d.minutes);
  return {
    input: { at, photoId, note: d.note, rating: d.rating || undefined, tag: d.tag, durationMs: Number.isFinite(min) && min > 0 ? Math.round(min * 60000) : undefined },
    photoFailed
  };
}

export function WorkFields({ draft, onChange, now }: { draft: WorkDraft; onChange: (d: WorkDraft) => void; now: number }) {
  const set = (patch: Partial<WorkDraft>) => onChange({ ...draft, ...patch });
  const [objUrl, setObjUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!draft.file) { setObjUrl(null); return; }
    const u = URL.createObjectURL(draft.file);
    setObjUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [draft.file]);
  const savedUrl = useBlobUrl(draft.file ? undefined : draft.photoId, "thumb");
  const photo = objUrl ?? savedUrl;
  const hasPhoto = !!draft.file || !!draft.photoId;
  return (
    <div className="wk-form stack" data-work-form>
      <label className="field"><span>完成日期</span>
        <input className="input" type="date" data-work-date value={draft.date} max={dateInputValue(now)} onChange={(e) => set({ date: e.target.value })} />
      </label>
      <div className="field">
        <span>成品照片（可选）</span>
        <div className="wk-photo">
          {hasPhoto ? <div className="wk-thumb">{photo ? <img src={photo} alt="成品照片预览" /> : <span className="meta">加载中…</span>}</div> : null}
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <label className="btn btn-sm wk-pick">
              {hasPhoto ? "换一张" : "添加照片"}
              <input type="file" accept="image/*" data-work-photo className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) set({ file: f }); e.target.value = ""; }} />
            </label>
            {hasPhoto ? <button type="button" className="btn btn-sm btn-ghost" onClick={() => set({ file: null, photoId: undefined })}>去掉照片</button> : null}
          </div>
        </div>
      </div>
      <div className="field">
        <span id="wk-rating-label">喜欢程度</span>
        <div className="wk-stars" role="group" aria-labelledby="wk-rating-label" data-work-rating>
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} type="button" className="wk-star" aria-pressed={draft.rating >= n} aria-label={`${n} 星`} onClick={() => set({ rating: draft.rating === n ? 0 : n })}>{draft.rating >= n ? "★" : "☆"}</button>
          ))}
        </div>
      </div>
      <div className="wk-two">
        <label className="field"><span>给谁了 / 标签</span>
          <input className="input" data-work-tag maxLength={20} placeholder="例如：送给妈妈、自留" value={draft.tag} onChange={(e) => set({ tag: e.target.value })} />
        </label>
        <label className="field"><span>用时（分钟）</span>
          <input className="input" data-work-duration inputMode="numeric" placeholder="没记就空着" value={draft.minutes} onChange={(e) => set({ minutes: e.target.value.replace(/[^\d]/g, "").slice(0, 5) })} />
        </label>
      </div>
      <label className="field"><span>备注</span>
        <textarea className="textarea" data-work-note maxLength={500} placeholder="例如：用了哪块板、熨烫心得…" value={draft.note} onChange={(e) => set({ note: e.target.value })} />
      </label>
    </div>
  );
}
