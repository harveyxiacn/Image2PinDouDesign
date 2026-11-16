// 下单快照的保存：写进共享偏好（随同步走），并沿用“updatedAt 严格递增”的盖章规则。
import { putRecords } from "./db";
import type { LastOrder, SharedPrefs } from "./model";
import { nextStamp } from "./purchase";

/** 保存（或传 null 清除）最近一次下单快照。 */
export async function setLastOrder(prefs: SharedPrefs, order: LastOrder | null): Promise<void> {
  const { lastOrder: _old, ...rest } = prefs;
  await putRecords("prefs", [{ ...rest, ...(order ? { lastOrder: order } : {}), updatedAt: nextStamp(prefs.updatedAt) }]);
}
