import { MARD_221_SEEDS, MARD_PALETTE } from "./palette";
import type { PaletteColor } from "./types";

// 色卡套装：用户手里买的是哪一套豆子，生成图纸时就只从这套里挑颜色。
// 每个套装就是一份色号清单；新增套装只需在这里追加一项，
// 清单必须来自真实的商品色号表，不要按数量臆造。
export type PaletteKit = {
  id: string;
  name: string;
  description: string;
  codes: readonly string[];
};

// MARD 零售套装：色号清单依据 MARD 264 色零售色卡整理（数据来源 pixel-beads.com 的 MARD 色号页，
// 2026-11-03 抓取）。24 → 221 色是逐级追加的：每个套装都是下面顺序的前 N 个色号。
// 264 色套装不含 C29，另加珠光 P、冻色 R、夜光 Y、温变 Q 与 T1 共 44 色。
// 不同销售渠道 / 包装版本可能有差异，界面上提示“以实际购买的色卡为准”。
export const MARD_RETAIL_ORDER: readonly string[] = [
  "B3", "C3", "D9", "E2", "G1", "A4", "B5", "C5", "D6", "E4", "G5", "A6", "B8", "C8", "D7", "F5", "G7", "A7",
  "H1", "H2", "H3", "H4", "H5", "H7", "C2", "C13", "D19", "E8", "A13", "A11", "C10", "C6", "D18", "E3", "A10",
  "G9", "C11", "C7", "D21", "D13", "F13", "G13", "B12", "D3", "D15", "E7", "F8", "G8", "A3", "B20", "D16", "D8",
  "E1", "G2", "B18", "B10", "D11", "D12", "E12", "G3", "B14", "B19", "D2", "D20", "E5", "F10", "B17", "B7",
  "C16", "D14", "E13", "F7", "E11", "E14", "F1", "A14", "M6", "M5", "E15", "F14", "F9", "F2", "G14", "M9", "E9",
  "E6", "F12", "F3", "F11", "M12", "D5", "E10", "F4", "F6", "G17", "H6", "A15", "A5", "A8", "A12", "A9", "G6",
  "A1", "B13", "B1", "B2", "B4", "B11", "H12", "C1", "B16", "B6", "C15", "B15", "C14", "D17", "D1", "C4", "C17",
  "C9", "H8", "G15", "A2", "H13", "G16", "H9", "H10", "M1", "G11", "G4", "M4", "H14", "M10", "M2", "G12", "M13",
  "M7", "H11", "M11", "M3", "G10", "M14", "M8", "M15", "H17", "H18", "H19", "E16", "F16", "F17", "D23", "E24",
  "E19", "E18", "E17", "E20", "B24", "A16", "A17", "A18", "F24", "F23", "A24", "A22", "A21", "F21", "F22",
  "A19", "A26", "A25", "A20", "A23", "G18", "H21", "B26", "B32", "B31", "B30", "B27", "B29", "C22", "C23",
  "C24", "B28", "C25", "C27", "H15", "H20", "H23", "H22", "C28", "C21", "F15", "F19", "G20", "E21", "E22",
  "D26", "F25", "F20", "G19", "F18", "G21", "E23", "D25", "D22", "D24", "C20", "B21", "B25", "H16", "B23",
  "C18", "B22", "C19", "C26", "C29", "D10", "B9", "C12", "D4"
];

const MARD_264_EXTRAS: readonly string[] = [
  "P18", "P16", "P3", "P12", "P1", "T1", "P7", "P17", "P6", "P13", "P9", "P11", "P4", "P5", "P15", "P14", "P2",
  "R12", "P23", "P22", "P21", "P20", "P19", "P8", "P10", "R11", "Y2", "Y3", "Q2", "Y4", "Y5", "Y1", "R3", "R4",
  "R5", "R8", "R9", "R2", "R1", "R10", "R6", "R7", "R13", "Q5"
];

const RETAIL_SIZES = [24, 48, 72, 96, 120, 144, 168, 192, 216] as const;

const RETAIL_KITS: PaletteKit[] = RETAIL_SIZES.map((size) => ({
  id: `mard-${size}`,
  name: `MARD ${size} 色`,
  description: `MARD ${size} 色零售套装。`,
  codes: MARD_RETAIL_ORDER.slice(0, size)
}));

export const PALETTE_KITS: PaletteKit[] = [
  ...RETAIL_KITS,
  {
    id: "mard-221",
    name: "MARD 221 色",
    description: "最常见的标准套装：A–H、M 九个系列。",
    codes: MARD_221_SEEDS.map((seed) => seed.code)
  },
  {
    id: "mard-264",
    name: "MARD 264 色",
    description: "221 色（不含 C29）加珠光、冻色、夜光、温变等 44 色。",
    codes: [...MARD_RETAIL_ORDER.filter((code) => code !== "C29"), ...MARD_264_EXTRAS]
  },
  {
    id: "mard-291",
    name: "MARD 全部 291 色",
    description: "全部已收录色号：221 色加 T1、P、Q、R、Y、ZG 扩展系列。",
    codes: MARD_PALETTE.map((color) => color.code)
  }
];

// 旧版本保存的“精选 N 色”套装 id 迁移到同色数的官方零售套装。
const LEGACY_KIT_IDS: Record<string, string> = Object.fromEntries(
  [24, 48, 72, 96, 120, 144, 168].map((size) => [`curated-${size}`, `mard-${size}`])
);

export const DEFAULT_KIT_ID = "mard-221";
export const KIT_STORAGE_KEY = "image2pindou:palette-kit:v1";

export function getPaletteKit(id: string | null | undefined): PaletteKit {
  const resolved = id ? LEGACY_KIT_IDS[id] ?? id : id;
  return PALETTE_KITS.find((kit) => kit.id === resolved) ?? PALETTE_KITS.find((kit) => kit.id === DEFAULT_KIT_ID)!;
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
