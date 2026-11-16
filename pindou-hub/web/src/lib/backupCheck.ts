// 备份导入的严格校验：逐条检查，坏记录不导入，并说明原因。纯函数。
export type CheckedRecord = { collection: "patterns" | "txns" | "images" | "prefs"; id: string; data: Record<string, unknown>; updatedAt: number; deleted: boolean };
export type BackupCheck =
  | { ok: false; message: string }
  | { ok: true; records: CheckedRecord[]; skippedUnknown: number; rejected: Array<{ index: number; reason: string }>; message: string };

const COLLECTIONS = ["patterns", "txns", "images", "prefs"] as const;
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isCounts = (v: unknown) => isObj(v) && Object.values(v).every((n) => isNum(n));

/** 返回问题描述；没有问题返回空串。 */
function problem(collection: string, id: string, data: Record<string, unknown>): string {
  if (data.id !== undefined && data.id !== id) return "记录内部 id 与外层不一致";
  if (collection === "patterns") {
    if (typeof data.name !== "string") return "图纸缺少名称";
    if (!isCounts(data.counts)) return "图纸的色号用量格式不对";
    if (data.tags !== undefined && !(Array.isArray(data.tags) && data.tags.every((t) => typeof t === "string"))) return "图纸标签格式不对";
  } else if (collection === "txns") {
    if (typeof data.code !== "string" || !data.code) return "流水缺少色号";
    if (!isNum(data.delta)) return "流水数量不是数字";
    if (!["purchase", "consume", "adjust", "stocktake"].includes(String(data.kind))) return "流水类型不认识";
    if (!isNum(data.at)) return "流水缺少时间";
  } else if (collection === "images") {
    if (!/^[a-f0-9]{64}$/.test(id)) return "图片记录的 id 不是 SHA-256";
  } else if (collection === "prefs") {
    if (id !== "shared") return "偏好记录的 id 必须是 shared";
    for (const key of ["lowStock", "packSize", "lossRate"]) if (data[key] !== undefined && !isNum(data[key])) return `偏好 ${key} 不是数字`;
    for (const key of ["minStock", "packSizes"]) if (data[key] !== undefined && !isCounts(data[key])) return `偏好 ${key} 格式不对`;
  }
  return "";
}

export function checkBackup(text: string): BackupCheck {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { ok: false, message: "文件不是有效的 JSON，没有导入任何内容" }; }
  const list = Array.isArray(raw) ? raw : isObj(raw) && Array.isArray(raw.records) ? raw.records : null;
  if (!list) return { ok: false, message: "这不是拼豆仓的备份文件，没有导入任何内容" };
  const records: CheckedRecord[] = [];
  const rejected: Array<{ index: number; reason: string }> = [];
  let skippedUnknown = 0;
  list.forEach((r: unknown, index: number) => {
    if (!isObj(r)) { rejected.push({ index, reason: "不是记录" }); return; }
    const { collection, id, data, updatedAt } = r;
    if (typeof collection !== "string" || !(COLLECTIONS as readonly string[]).includes(collection)) { skippedUnknown += 1; return; }
    if (typeof id !== "string" || !ID_RE.test(id)) { rejected.push({ index, reason: "id 不合法" }); return; }
    if (!isNum(updatedAt) || updatedAt <= 0) { rejected.push({ index, reason: "更新时间不合法" }); return; }
    if (!isObj(data)) { rejected.push({ index, reason: "缺少记录内容" }); return; }
    if (r.deleted !== undefined && typeof r.deleted !== "boolean") { rejected.push({ index, reason: "删除标记不合法" }); return; }
    const deleted = r.deleted === true;
    const why = deleted ? "" : problem(collection, id, data);
    if (why) { rejected.push({ index, reason: why }); return; }
    records.push({ collection: collection as CheckedRecord["collection"], id, data, updatedAt: Math.trunc(updatedAt), deleted });
  });
  const message = rejected.length
    ? `发现 ${rejected.length} 条有问题的记录，已跳过（例如第 ${rejected[0].index + 1} 条：${rejected[0].reason}），其余 ${records.length} 条正常。`
    : "";
  return { ok: true, records, skippedUnknown, rejected, message };
}
