// 同步里不依赖浏览器、不依赖时钟的纯逻辑：游标恢复判断、时钟偏差校正、分批计划、下载校验。
// 全部以参数传入“现在几点”，便于测试。

/** 只有偏差超过这个值才校正，避免网络抖动造成的小误差来回改时间戳。 */
export const SKEW_MIN_MS = 2000;
/** 写入方用的是“本机现在”的判断窗口：落在这个窗口里才当作本机时钟值去校正。 */
export const SKEW_NEAR_NOW_MS = 30_000;
/** 往返超过这个时间的样本不可信，不用来估计偏差。 */
export const SKEW_MAX_RTT_MS = 5000;

export type CursorDecision = { action: "keep" | "reset"; reason: "" | "epoch" | "ahead" };

/**
 * 本机游标是否已经和 Hub 对不上（Hub 数据库被恢复 / 被换掉）。
 * - Hub 换了数据库标识（epoch）：重置；
 * - 本机游标比 Hub 当前最大序号还大：重置；
 * - 老 Hub 不返回这两个字段：保持原样（不改变旧行为）。
 * 本机还没记过 epoch（刚升级）时只记下它，不重置。
 */
export function decideCursor(input: { localCursor: number; localEpoch: string; hubEpoch?: unknown; hubMaxSeq?: unknown }): CursorDecision {
  const hubEpoch = typeof input.hubEpoch === "string" ? input.hubEpoch : "";
  const hubMax = typeof input.hubMaxSeq === "number" && Number.isFinite(input.hubMaxSeq) ? input.hubMaxSeq : null;
  if (hubEpoch && input.localEpoch && hubEpoch !== input.localEpoch) return { action: "reset", reason: "epoch" };
  if (hubMax !== null && input.localCursor > hubMax) return { action: "reset", reason: "ahead" };
  return { action: "keep", reason: "" };
}

/** Hub 时间 - 本机时间。用请求前后本机时间的中点近似 Hub 回复的那一刻；往返太久则放弃（返回 null）。 */
export function estimateSkew(sentAt: number, receivedAt: number, serverTime: unknown): number | null {
  if (typeof serverTime !== "number" || !Number.isFinite(serverTime)) return null;
  const rtt = receivedAt - sentAt;
  if (rtt < 0 || rtt > SKEW_MAX_RTT_MS) return null;
  return Math.round(serverTime - (sentAt + receivedAt) / 2);
}

/**
 * 给一条要写入的记录定 updatedAt：
 * 1. 写入方给的是“本机现在”附近的值，且本机钟与 Hub 相差明显：换算成 Hub 时间，这样钟慢的设备也能赢、钟快的设备不会永远赢；
 * 2. 无论如何不小于 已有版本 + 1（保证严格递增，不会被旧版本盖掉）。
 * 写入方已经按 max(now, 旧值+1) 算过的值（≤ 旧值+2）不再二次校正，避免偏差越滚越大。
 */
export function bumpStamp(wanted: number, existing: number | undefined, skew: number, localNow: number): number {
  let value = Math.trunc(wanted);
  const alreadyAhead = existing !== undefined && value <= existing + 2;
  if (!alreadyAhead && Math.abs(skew) >= SKEW_MIN_MS && Math.abs(value - localNow) <= SKEW_NEAR_NOW_MS) value += Math.round(skew);
  if (existing !== undefined && value <= existing) value = existing + 1;
  return Math.max(1, value);
}

export type Sized<T> = { item: T; bytes: number };

/** 估算一条变更序列化后的字节数（UTF-8 近似：中文按 3 字节算）。 */
export function approxBytes(value: unknown): number {
  const text = JSON.stringify(value) ?? "";
  let n = 0;
  for (let i = 0; i < text.length; i++) n += text.charCodeAt(i) < 0x80 ? 1 : 3;
  return n;
}

/** 把发件箱切成不超过 maxBytes / maxCount 的若干批；单条超大的记录独占一批。顺序保持不变。 */
export function planChunks<T>(items: T[], opts: { maxBytes?: number; maxCount?: number; size?: (item: T) => number } = {}): T[][] {
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
  const maxCount = opts.maxCount ?? 400;
  const size = opts.size ?? ((item: T) => approxBytes(item));
  const chunks: T[][] = [];
  let current: T[] = [];
  let bytes = 0;
  for (const item of items) {
    const n = size(item);
    if (current.length && (current.length >= maxCount || bytes + n > maxBytes)) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(item);
    bytes += n;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

/** 下载下来的内容哈希是否等于 blob id（id 本身就是 SHA-256 小写十六进制）。 */
export function hashMatches(id: string, digestHex: string): boolean {
  return /^[a-f0-9]{64}$/.test(id) && digestHex.toLowerCase() === id;
}
