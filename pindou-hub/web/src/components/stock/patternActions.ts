// 图纸批量操作：改状态 / 加标签 / 删除。每个动作都给出“撤销”提示，撤销写回原记录。
import { getSnapshot, putRecords, softDelete } from "../../lib/db";
import { STATUS_LABEL, type Pattern, type PatternStatus } from "../../lib/model";
import { withStatus, withTag } from "../../lib/stockview";
import { toast } from "../ui";

function pick(ids: string[]): Pattern[] {
  const set = new Set(ids);
  return getSnapshot().patterns.filter((p) => set.has(p.id) && !p.deleted);
}
async function restore(originals: Pattern[]): Promise<void> {
  const at = Date.now();
  await putRecords("patterns", originals.map((p) => ({ ...p, updatedAt: Math.max(at, p.updatedAt + 2) })));
}

/** 返回给读屏用的结果文案。 */
export async function bulkSetStatus(ids: string[], status: PatternStatus, what = ""): Promise<string> {
  const originals = pick(ids).filter((p) => p.status !== status);
  if (!originals.length) { const m = `所选图纸已经是“${STATUS_LABEL[status]}”`; toast(m); return m; }
  await putRecords("patterns", originals.map((p) => withStatus(p, status)));
  const m = `${what}${originals.length} 张图纸已设为${STATUS_LABEL[status]}`;
  toast(m, { label: "撤销", run: () => { void restore(originals); } });
  return m;
}

export async function bulkAddTag(ids: string[], tag: string): Promise<string> {
  const t = tag.trim();
  const originals = pick(ids).filter((p) => t && !p.tags.includes(t));
  if (!originals.length) { const m = "没有需要加标签的图纸"; toast(m); return m; }
  await putRecords("patterns", originals.map((p) => withTag(p, t)));
  const m = `${originals.length} 张图纸已加标签「${t}」`;
  toast(m, { label: "撤销", run: () => { void restore(originals); } });
  return m;
}

/** 人工核对：只改 verifiedAt，不动识别数量；撤销会恢复原来的核对时间。 */
export async function bulkSetVerified(ids: string[], verified = true): Promise<string> {
  const at = Date.now();
  const originals = pick(ids).filter((p) => (verified ? p.verifiedAt == null : p.verifiedAt != null));
  if (!originals.length) {
    const m = verified ? "所选图纸都已核对" : "所选图纸都还未核对";
    toast(m);
    return m;
  }
  await putRecords("patterns", originals.map((p) => ({ ...p, verifiedAt: verified ? at : undefined, updatedAt: at })));
  const m = `${originals.length} 张图纸已标记为${verified ? "已核对" : "未核对"}`;
  toast(m, { label: "撤销", run: () => { void restore(originals); } });
  return m;
}

export async function bulkDelete(ids: string[]): Promise<string> {
  const originals = pick(ids);
  if (!originals.length) return "";
  await softDelete("patterns", originals.map((p) => p.id));
  const m = `已删除 ${originals.length} 张图纸`;
  toast(m, { label: "撤销", run: () => { void restore(originals); } });
  return m;
}
