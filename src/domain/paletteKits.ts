import { ciede2000 } from "./color";
import { MARD_221_SEEDS, MARD_PALETTE } from "./palette";
import type { PaletteColor } from "./types";

// 色卡套装：用户手里买的是哪一套豆子，生成图纸时就只从这套里挑颜色。
// 每个套装就是一份色号清单；新增套装（如 24/48/72… 色）只需在这里追加一项，
// 清单必须来自真实的商品色号表，不要按数量臆造。
export type PaletteKit = {
  id: string;
  name: string;
  description: string;
  codes: readonly string[];
};

// 按色数精选：从标准 221 色里先放入黑、白，再反复挑“离已选颜色最远”的色号（CIEDE2000），
// 让任意色数都尽量均匀覆盖色相与明度。结果是嵌套的（24 ⊂ 48 ⊂ … ⊂ 168）。
// 注意：这是为“只想用 N 种颜色”准备的通用方案，不是某个官方 N 色套装的色号清单。
const CURATED_SIZES = [24, 48, 72, 96, 120, 144, 168] as const;
const CURATED_SEED_CODES = ["H2", "H7"];

export function curatedColorOrder(palette = MARD_PALETTE.filter((color) => MARD_221_SEEDS.some((seed) => seed.code === color.code))): string[] {
  const remaining = palette.slice();
  const chosen: typeof palette = [];
  const minDistance = new Map<string, number>();
  const take = (index: number) => {
    const [color] = remaining.splice(index, 1);
    chosen.push(color);
    for (const candidate of remaining) {
      const distance = ciede2000(color.lab, candidate.lab);
      minDistance.set(candidate.code, Math.min(minDistance.get(candidate.code) ?? Infinity, distance));
    }
  };
  for (const code of CURATED_SEED_CODES) {
    const index = remaining.findIndex((color) => color.code === code);
    if (index >= 0) take(index);
  }
  while (remaining.length > 0) {
    let best = 0;
    for (let index = 1; index < remaining.length; index += 1) {
      const distance = minDistance.get(remaining[index].code) ?? Infinity;
      const bestDistance = minDistance.get(remaining[best].code) ?? Infinity;
      // 色差相同取色卡顺序靠前者，保证结果稳定。
      if (distance > bestDistance + 1e-9) best = index;
    }
    take(best);
  }
  return chosen.map((color) => color.code);
}

const CURATED_ORDER = curatedColorOrder();

const CURATED_KITS: PaletteKit[] = CURATED_SIZES.map((size) => ({
  id: `curated-${size}`,
  name: `精选 ${size} 色`,
  description: `从标准 221 色中按色差均匀挑出 ${size} 色（自动精选，不是官方套装清单）。`,
  codes: CURATED_ORDER.slice(0, size)
}));

export const PALETTE_KITS: PaletteKit[] = [
  ...CURATED_KITS,
  {
    id: "mard-221",
    name: "MARD 221 色",
    description: "最常见的标准套装：A–H、M 九个系列。",
    codes: MARD_221_SEEDS.map((seed) => seed.code)
  },
  {
    id: "mard-291",
    name: "MARD 291 色",
    description: "221 色加 T1、P、Q、R、Y、ZG 扩展系列。",
    codes: MARD_PALETTE.map((color) => color.code)
  }
];

export const DEFAULT_KIT_ID = "mard-221";
export const KIT_STORAGE_KEY = "image2pindou:palette-kit:v1";

export function getPaletteKit(id: string | null | undefined): PaletteKit {
  return PALETTE_KITS.find((kit) => kit.id === id) ?? PALETTE_KITS.find((kit) => kit.id === DEFAULT_KIT_ID)!;
}

/** 套装内的颜色，保持色卡顺序。 */
export function paletteForKit(kit: PaletteKit, palette: PaletteColor[] = MARD_PALETTE): PaletteColor[] {
  const codes = new Set(kit.codes);
  return palette.filter((color) => codes.has(color.code));
}

/**
 * 生成图纸可用的色号：套装 ∩ 库存（库存模式开启时）。
 * 交集为空时退回整个套装，避免库存只登记了套装外色号时意外使用全部 291 色。
 * 套装覆盖全部色卡且不限库存时返回 null（即不限制）。
 */
export function resolveAllowedCodes(
  kit: PaletteKit,
  ownedCodes: Iterable<string> | null,
  palette: PaletteColor[] = MARD_PALETTE
): string[] | null {
  const kitCodes = new Set(kit.codes);
  if (ownedCodes) {
    const owned = [...ownedCodes].filter((code) => kitCodes.has(code));
    if (owned.length > 0) return owned.sort();
  }
  return kitCodes.size >= palette.length && palette.every((color) => kitCodes.has(color.code))
    ? null
    : [...kitCodes].sort();
}

export function loadPaletteKitId(): string {
  if (typeof window === "undefined") return DEFAULT_KIT_ID;
  try {
    return getPaletteKit(window.localStorage.getItem(KIT_STORAGE_KEY)).id;
  } catch {
    return DEFAULT_KIT_ID;
  }
}

export function persistPaletteKitId(id: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KIT_STORAGE_KEY, id);
  } catch {
    // 隐私模式下仅本次会话生效。
  }
}
