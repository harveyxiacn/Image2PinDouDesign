// 图纸详情页里的“完工记录”：列出每次完成，可补记、编辑、删除（删除可撤销）。
import { useState } from "react";
import { putRecords } from "../../lib/db";
import { releaseImages } from "../../lib/images";
import type { Pattern } from "../../lib/model";
import { dateInputValue, durationLabel, withWorkAdded, withWorkPatch, withWorkRemoved, worksOf } from "../../lib/worklog";
import { Icon, Sheet, toast, useBlobUrl } from "../ui";
import { WorkFields, draftOf, draftToInput, newDraft, type WorkDraft } from "./WorkFields";
import "./worklog.css";

function Thumb({ id }: { id?: string }) {
  const url = useBlobUrl(id, "thumb");
  return url ? <img className="wk-entry-img" src={url} alt="成品照片" /> : null;
}

export function WorkPanel({ pattern }: { pattern: Pattern }) {
  const entries = worksOf(pattern);
  const [editing, setEditing] = useState<{ id: string | null; draft: WorkDraft; at?: number } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!entries.length && pattern.status !== "done") return null;

  const stamp = (p: Pattern) => Math.max(Date.now(), p.updatedAt + 1);
  const undoTo = (before: Pattern, drop: Array<string | undefined> = []) => async () => {
    await putRecords("patterns", [{ ...before, updatedAt: Math.max(Date.now(), stamp(before)) + 2 }]);
    releaseImages(drop, 0); // 撤销后这次新存的照片没人用了
  };

  const save = async () => {
    if (!editing || busy) return;
    setBusy(true);
    try {
      const now = Date.now();
      const { input, photoFailed } = await draftToInput(editing.draft, now, editing.at);
      const before = pattern;
      const next = editing.id
        ? withWorkPatch(pattern, editing.id, { at: input.at, photoId: input.photoId, note: input.note ?? "", rating: input.rating, tag: input.tag ?? "", durationMs: input.durationMs }, now)
        : withWorkAdded(pattern, input, { now });
      // 清空的字段要真的清掉（sanitizeEntry 会丢掉空串、undefined）
      await putRecords("patterns", [next]);
      setEditing(null);
      const oldPhoto = editing.id ? entries.find((e) => e.id === editing.id)?.photoId : undefined;
      if (oldPhoto && oldPhoto !== input.photoId) releaseImages([oldPhoto]); // 换掉或去掉的旧照片
      toast(photoFailed ? "已保存，但照片没存上" : editing.id ? "完工记录已更新" : "已记下这次完成", { label: "撤销", run: undoTo(before, [input.photoId !== oldPhoto ? input.photoId : undefined]) });
    } finally { setBusy(false); }
  };
  const remove = async (id: string) => {
    const before = pattern;
    await putRecords("patterns", [withWorkRemoved(pattern, id)]);
    releaseImages([entries.find((e) => e.id === id)?.photoId]);
    toast("已删除这条完工记录", { label: "撤销", run: undoTo(before) });
  };

  return (
    <div className="panel panel-pad stack" data-works-panel>
      <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
        <span className="label">完工记录{entries.length ? ` · ${entries.length} 次` : ""}</span>
        <button className="btn btn-sm" data-work-add onClick={() => setEditing({ id: null, draft: newDraft(Date.now(), pattern.build) })}><Icon name="plus" size={16} />{entries.length ? "再记一次完成" : "补记完成"}</button>
      </div>
      {!entries.length ? <p className="meta">这张图纸标了完成，但没有记下完成日期。补一条后，作品集和数据洞察会用真实日期。</p> : null}
      <ul className="wk-entries">
        {entries.map((e) => (
          <li key={e.id} className="wk-entry" data-work-entry>
            <Thumb id={e.photoId} />
            <div className="wk-entry-body">
              <b>{dateInputValue(e.at).replace(/-/g, ".")}</b>
              <span className="meta">
                {e.copies && e.copies > 1 ? `${e.copies} 份` : "1 份"}
                {e.rating ? ` · ${"★".repeat(e.rating)}` : ""}
                {e.tag ? ` · ${e.tag}` : ""}
                {e.durationMs ? ` · 用时 ${durationLabel(e.durationMs)}` : ""}
              </span>
              {e.note ? <span className="wk-note">{e.note}</span> : null}
              <div className="row" style={{ gap: 4 }}>
                <button className="btn btn-sm btn-ghost" data-work-edit onClick={() => setEditing({ id: e.id, draft: draftOf(e), at: e.at })} aria-label={`编辑 ${dateInputValue(e.at)} 的完工记录`}><Icon name="edit" size={16} />编辑</button>
                <button className="btn btn-sm btn-ghost" data-work-delete onClick={() => void remove(e.id)} aria-label={`删除 ${dateInputValue(e.at)} 的完工记录`}><Icon name="trash" size={16} />删除</button>
              </div>
            </div>
          </li>
        ))}
      </ul>
      {editing ? (
        <Sheet title={editing.id ? "编辑完工记录" : "记下这次完成"} onClose={() => setEditing(null)}
          footer={<><button className="btn" onClick={() => setEditing(null)}>取消</button><button className="btn btn-primary" data-work-save disabled={busy} onClick={() => void save()}>保存</button></>}>
          <WorkFields draft={editing.draft} now={Date.now()} onChange={(draft) => setEditing({ ...editing, draft })} />
        </Sheet>
      ) : null}
    </div>
  );
}
