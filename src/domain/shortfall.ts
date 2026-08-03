/**
 * 库存差缺（shortfall）领域逻辑：库存的读写、迁移与差缺计算。
 * 所有纯函数不改动入参；localStorage 访问统一带 window 守卫 + try/catch。
 */

export type OwnedInventory = {
  restrictEnabled: boolean;
  // 色号 → 已有颗数，只存 >0 的项。
  owned: Record<string, number>;
};

// v1 旧格式：{ restrictEnabled?: boolean; allowedCodes?: string[] }（App 正在使用）
export const INVENTORY_STORAGE_KEY_V1 = "image2pindou:inventory:v1";
// v2 新格式：{ restrictEnabled: boolean; owned: Record<string, number> }
export const INVENTORY_STORAGE_KEY = "image2pindou:inventory:v2";

const MAX_OWNED_COUNT = 99999;

/**
 * 读取库存：优先 v2；无 v2 时从 v1 迁移（allowedCodes 每个色号记为 owned=1，
 * restrictEnabled 沿用）；都无则返回默认空库存。任何解析失败都回退到默认值。
 */
export function loadOwnedInventory(): OwnedInventory {
  if (typeof window === "undefined") {
    return { restrictEnabled: false, owned: {} };
  }
  try {
    const rawV2 = window.localStorage.getItem(INVENTORY_STORAGE_KEY);
    if (rawV2) {
      const parsed = JSON.parse(rawV2) as { restrictEnabled?: boolean; owned?: unknown };
      return {
        restrictEnabled: Boolean(parsed.restrictEnabled),
        owned: sanitizeOwned(parsed.owned)
      };
    }

    const rawV1 = window.localStorage.getItem(INVENTORY_STORAGE_KEY_V1);
    if (rawV1) {
      const parsed = JSON.parse(rawV1) as { restrictEnabled?: boolean; allowedCodes?: unknown };
      const owned: Record<string, number> = {};
      if (Array.isArray(parsed.allowedCodes)) {
        for (const code of parsed.allowedCodes) {
          if (typeof code === "string" && code.length > 0) {
            owned[code] = 1;
          }
        }
      }
      return {
        restrictEnabled: Boolean(parsed.restrictEnabled),
        owned
      };
    }

    return { restrictEnabled: false, owned: {} };
  } catch {
    return { restrictEnabled: false, owned: {} };
  }
}

/**
 * 写入库存到 v2：过滤 ≤0 的值并 clamp 到 0..99999（取整）。失败静默忽略。
 * 不触碰 v1 键，迁移只在 load 时进行。
 */
export function persistOwnedInventory(inventory: OwnedInventory): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(
      INVENTORY_STORAGE_KEY,
      JSON.stringify({
        restrictEnabled: inventory.restrictEnabled,
        owned: sanitizeOwned(inventory.owned)
      })
    );
  } catch {
    // 忽略写入失败，例如隐私模式或配额超限
  }
}

/**
 * 限制模式开启时返回 owned>0 的色号集合；未开启返回 null（不限制）。
 */
export function ownedToAllowedCodes(inventory: OwnedInventory): Set<string> | null {
  if (!inventory.restrictEnabled) {
    return null;
  }
  const codes = new Set<string>();
  for (const [code, count] of Object.entries(inventory.owned)) {
    if (count > 0) {
      codes.add(code);
    }
  }
  return codes;
}

/**
 * 差缺计算：对 needed 中每个色号 shortfall = max(0, needed - owned)，
 * 只保留 shortfall>0 的项。纯函数。
 */
export function computeShortfall(needed: Record<string, number>, owned: Record<string, number>): Record<string, number> {
  const shortfall: Record<string, number> = {};
  for (const [code, need] of Object.entries(needed)) {
    const have = owned[code] ?? 0;
    const missing = Math.max(0, need - have);
    if (missing > 0) {
      shortfall[code] = missing;
    }
  }
  return shortfall;
}

/**
 * 设置某个色号的已有颗数：clamp ≥0（取整），count≤0 时删除该键。纯函数。
 */
export function setOwnedCount(owned: Record<string, number>, code: string, count: number): Record<string, number> {
  const next = { ...owned };
  const clamped = Math.max(0, Math.floor(count));
  if (clamped <= 0) {
    delete next[code];
  } else {
    next[code] = clamped;
  }
  return next;
}

/**
 * 把 codes 中每个色号的 owned 至少设为 count（保留已有更大值）。
 * count≤0 且无已有值时保持不记录（库存只存 >0）。纯函数。
 */
export function addOwnedForCodes(
  owned: Record<string, number>,
  codes: Iterable<string>,
  count: number
): Record<string, number> {
  const next = { ...owned };
  for (const code of codes) {
    const current = typeof next[code] === "number" ? next[code] : 0;
    const target = Math.max(current, count);
    if (target > 0) {
      next[code] = target;
    } else {
      delete next[code];
    }
  }
  return next;
}

/** 过滤 ≤0 / 非法值，并把合法颗数 clamp 到 0..99999（取整）。 */
function sanitizeOwned(raw: unknown): Record<string, number> {
  const result: Record<string, number> = {};
  if (!raw || typeof raw !== "object") {
    return result;
  }
  for (const [code, value] of Object.entries(raw as Record<string, unknown>)) {
    const count = Number(value);
    if (Number.isFinite(count) && count > 0) {
      result[code] = Math.min(Math.floor(count), MAX_OWNED_COUNT);
    }
  }
  return result;
}
