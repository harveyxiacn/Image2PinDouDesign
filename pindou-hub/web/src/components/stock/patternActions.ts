// 图纸批量操作：改状态 / 加标签 / 删除。每个动作都给出“撤销”提示，撤销写回原记录。
import { getSnapshot, putRecords, softDelete } from "../../lib/db";
import { planReopen, refundTxns, reopenedPattern } from "../../lib/inventory";
import { STATUS_LABEL, type Pattern, type PatternStatus, type Txn } from "../../lib/model";
import { withStatus, withTag } from "../../lib/stockview";
import { completedPattern, withCompletionUndone } from "../../lib/worklog";
import { releaseImages } from "../../lib/images";
import { toast } from "../ui";
import { fmt } from "../ui";

function pick(ids: string[]): Pattern[] {
  const set = new Set(ids);
  return getSnapshot().patterns.filter((p) => set.has(p.id) && !p.deleted);
}
async function restore(originals: Pattern[]): Promise<void> {
  const at = Date.now();
  await putRecords("patterns", originals.map((p) => ({ ...p, updatedAt: Math.max(at, p.updatedAt + 2) })));
}

/** 重新打开已完成的图纸时，扣掉的豆子怎么处理。 */
export type RefundChoice = "refund" | "keep";

/** 所选图纸里，有多少张“已完成且扣过库存”（改状态前要先问用户），以及能放回多少颗。 */
export function reopenSummary(ids: string[], status: PatternStatus): { patterns: number; beads: number; colors: number } {
  if (status === "done") return { patterns: 0, beads: 0, colors: 0 };
  const txns = getSnapshot().txns;
  let patterns = 0;
  let beads = 0;
  const colors = new Set<string>();
  for (const p of pick(ids)) {
    if (p.status === status) continue;
    const plan = planReopen(p, txns);
    if (!plan.ask) continue;
    patterns += 1;
    beads += plan.beads;
    for (const t of plan.originals) colors.add(t.code);
  }
  return { patterns, beads, colors: colors.size };
}

/**
 * 返回给读屏用的结果文案。
 * 已完成的图纸改回别的状态时：choice = "refund"（默认，最常见的是点错了）把当初扣的豆子用新的“调整”流水放回库存；
 * "keep" 豆子保持已扣除（做成了、还想再做一份）。两种都会清掉“已扣库存”标记，图纸才会重新出现在采购清单里。
 */
export async function bulkSetStatus(ids: string[], status: PatternStatus, what = "", choice: RefundChoice = "refund"): Promise<string> {
  const originals = pick(ids).filter((p) => p.status !== status);
  if (!originals.length) { const m = `所选图纸已经是“${STATUS_LABEL[status]}”`; toast(m); return m; }
  const snap = getSnapshot();
  const now = Date.now();
  const refunds: Txn[] = [];
  const released: Array<string | undefined> = [];
  const next = originals.map((p) => {
    // 批量标记完成：记一条今天的完工记录（可以之后在图纸详情里补照片和备注）
    if (status === "done") return completedPattern(p, { at: now }, { now });
    if (p.status !== "done") return withStatus(p, status);
    const plan = planReopen(p, snap.txns);
    if (choice === "refund") refunds.push(...refundTxns(plan.originals, p, STATUS_LABEL[status], snap.device.deviceId, now));
    // 选“放回库存”= 点错了：这次完成留下的完工记录一并撤掉（没扣过库存的，只撤刚建不久的空白记录）；“保持已扣除”不动记录
    const cleaned = choice === "refund" ? withCompletionUndone(p, now, plan.ask ? {} : { onlyBlankWithin: 30 * 60_000 }) : { pattern: p, removed: undefined };
    released.push(cleaned.removed?.photoId);
    return reopenedPattern(cleaned.pattern, status, now);
  });
  if (refunds.length) await putRecords("txns", refunds);
  await putRecords("patterns", next);
  releaseImages(released);
  const back = refunds.reduce((a, t) => a + t.delta, 0);
  const m = `${what}${originals.length} 张图纸已设为${STATUS_LABEL[status]}${back > 0 ? `，${fmt(back)} 颗豆子已放回库存` : ""}`;
  toast(m, { label: "撤销", run: () => {
    void restore(originals);
    if (refunds.length) void softDelete("txns", refunds.map((t) => t.id));
  } });
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
  if (originals.length > 3 && !window.confirm(`删除 ${originals.length} 张图纸？删除后可在提示里撤销`)) return "";
  await softDelete("patterns", originals.map((p) => p.id));
  const m = `已删除 ${originals.length} 张图纸`;
  toast(m, { label: "撤销", run: () => { void restore(originals); } });
  return m;
}
