// “我管理的色号”相关的纯函数：选色列表分组、生成时实际会用到的颜色数、设备本地的小偏好。
import { getPaletteKit, ALL_CODES, managedCodes } from "./palette";

export type PickItem = { code: string; outside: boolean };

/**
 * 选色列表：默认只列管理的色号；搜索时管理的色号在前、套装外的色号排后面并标“套装外”；
 * showAll 时把套装外的也列出来（排在管理的色号之后）。
 */
export function pickerItems(managed: string[], query: string, showAll: boolean, match: (code: string, query: string) => boolean, all: string[] = ALL_CODES): PickItem[] {
  const q = query.trim();
  const inManaged = new Set(managed);
  const head = managed.filter((c) => !q || match(c, q)).map((code) => ({ code, outside: false }));
  if (!q && !showAll) return head;
  const tail = all.filter((c) => !inManaged.has(c) && (!q || match(c, q))).map((code) => ({ code, outside: true }));
  return [...head, ...tail];
}

/** 套装外的色号数（选色列表里“显示全部色号”开关上的数字）。 */
export function outsideCount(managed: string[], all: string[] = ALL_CODES): number {
  const inManaged = new Set(managed);
  return all.filter((c) => !inManaged.has(c)).length;
}

/** 生成图纸时实际会用到多少种颜色：套装 ∩ 有货（与引擎 resolveAllowedCodes 同一规则，交集为空退回整个套装）。 */
export function effectiveColorCount(kitId: string | null | undefined, stock: Record<string, number>, onlyStock: boolean): number {
  const kit = managedCodes(kitId, {}); // 不含套装外有货色号
  if (!onlyStock) return kit.length;
  const inKit = new Set(kit);
  const owned = Object.keys(stock).filter((c) => stock[c] > 0 && inKit.has(c)).length;
  return owned > 0 ? owned : kit.length;
}

/** 套装名，供文案使用。 */
export function kitName(kitId: string | null | undefined): string { return getPaletteKit(kitId).name; }

const ONLY_STOCK_KEY = "pindou.generate.onlyStock";
/** 记住“只用库存里有的颜色”的上次选择（按设备，不同步）；读写失败时用默认值，本次仍然生效。 */
export function loadOnlyStock(storage: Pick<Storage, "getItem"> | null = safeStorage()): boolean {
  try { return storage?.getItem(ONLY_STOCK_KEY) === "1"; } catch { return false; }
}
export function saveOnlyStock(on: boolean, storage: Pick<Storage, "setItem"> | null = safeStorage()): void {
  try { storage?.setItem(ONLY_STOCK_KEY, on ? "1" : "0"); } catch { /* 隐私模式：本次有效即可 */ }
}
function safeStorage(): Storage | null { try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; } }
