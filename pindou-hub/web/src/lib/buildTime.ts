// 拼装用时：只数“真的在拼”的时间。页面在前台、且几分钟内有过操作才计时；切走、锁屏、发呆都不算。
// 纯逻辑，时钟由调用方传入（不读 Date.now），方便单测。
//
// 保存：build.timeMs = { 设备短码: 该设备累计毫秒 }。每台设备只增加自己的那一项；
// 合并时按设备取较大值（同一台设备的两份副本不会重复计，也不会丢），总用时 = 各设备之和。

/** 超过这么久没有任何操作，就当作人走开了，不再计时。 */
export const IDLE_MS = 3 * 60_000;
/** 一台设备最多保留几项，防止记录越写越大。 */
const MAX_DEVICES = 8;

export type TimeMap = Record<string, number>;

export type Tracker = {
  /** 本次页面打开以来累计的有效毫秒 */
  acc: number;
  /** 上次结算到的时刻 */
  last: number;
  /** 上次操作的时刻 */
  lastInput: number;
  visible: boolean;
};

export function createTracker(now: number, visible: boolean): Tracker {
  return { acc: 0, last: now, lastInput: now, visible };
}

/** 结算到 now：前台时，计 [last, min(now, lastInput+IDLE)] 这一段。时钟往回拨时不倒扣。 */
export function accrue(t: Tracker, now: number): Tracker {
  if (now < t.last) return { ...t, last: now, lastInput: Math.min(t.lastInput, now) };
  let acc = t.acc;
  if (t.visible) {
    const end = Math.min(now, t.lastInput + IDLE_MS);
    if (end > t.last) acc += end - t.last;
  }
  return { ...t, acc, last: now };
}

/** 有操作（点按、键盘、滑动）。 */
export function noteInput(t: Tracker, now: number): Tracker {
  const a = accrue(t, now);
  return { ...a, lastInput: Math.max(a.lastInput, now) };
}

/** 页面切到前台/后台；回到前台本身算一次操作。 */
export function setVisible(t: Tracker, visible: boolean, now: number): Tracker {
  const a = accrue(t, now);
  return visible ? { ...a, visible: true, lastInput: now } : { ...a, visible: false };
}

export function currentMs(t: Tracker, now: number): number {
  return accrue(t, now).acc;
}

/** 设备短码：取设备 id 末尾的随机部分。 */
export function deviceKey(deviceId: string | undefined): string {
  const id = (deviceId ?? "").trim();
  return id ? id.slice(-6) : "local";
}

/** 规整一份 timeMap：只留有限的正数，取整到秒，最多 MAX_DEVICES 项（留最大的）。 */
export function cleanTimeMap(v: unknown): TimeMap | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const entries: Array<[string, number]> = [];
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 1000 || !k || k.length > 24) continue;
    entries.push([k, Math.floor(raw / 1000) * 1000]);
  }
  if (!entries.length) return undefined;
  entries.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return Object.fromEntries(entries.slice(0, MAX_DEVICES).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
}

/** 按设备取较大值。满足交换律、结合律和幂等。 */
export function mergeTimeMaps(a: unknown, b: unknown): TimeMap | undefined {
  const ma = cleanTimeMap(a);
  const mb = cleanTimeMap(b);
  if (!ma || !mb) return ma ?? mb;
  const out: TimeMap = { ...ma };
  for (const [k, v] of Object.entries(mb)) out[k] = Math.max(out[k] ?? 0, v);
  return cleanTimeMap(out);
}

export function totalMs(v: unknown): number {
  const m = cleanTimeMap(v);
  return m ? Object.values(m).reduce((s, x) => s + x, 0) : 0;
}

/** 两份 timeMap 内容是否相同。 */
export function sameTimeMap(a: unknown, b: unknown): boolean {
  return JSON.stringify(cleanTimeMap(a) ?? null) === JSON.stringify(cleanTimeMap(b) ?? null);
}

/** 把本机的累计写进去（只升不降）；少于 1 秒不写。 */
export function withOwnTime(map: unknown, key: string, ownMs: number): TimeMap | undefined {
  const base = cleanTimeMap(map) ?? {};
  const mine = Math.floor(ownMs / 1000) * 1000;
  if (mine < 1000) return cleanTimeMap(base);
  return cleanTimeMap({ ...base, [key]: Math.max(base[key] ?? 0, mine) });
}

/** 界面上的“用时”文字；不到 1 分钟不显示。 */
export function timeLabel(ms: number): string {
  const min = Math.floor(ms / 60000);
  if (min < 1) return "";
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}
