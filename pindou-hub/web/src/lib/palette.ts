// MARD 色卡查询（复用上级项目的色卡数据与套装定义）。
import { MARD_PALETTE } from "@engine/palette";
import { PALETTE_KITS, getPaletteKit } from "@engine/paletteKits";
import type { PaletteColor } from "@engine/types";
import { compareCodes } from "./inventory";

const byCode = new Map<string, PaletteColor>(MARD_PALETTE.map((c) => [c.code, c]));

export const PALETTE = MARD_PALETTE;
export const ALL_CODES: string[] = MARD_PALETTE.map((c) => c.code).sort(compareCodes);
export { PALETTE_KITS, getPaletteKit };

export function colorOf(code: string): PaletteColor | undefined {
  return byCode.get(code);
}
export function isKnownCode(code: string): boolean {
  return byCode.has(code);
}
export function kitCodes(kitId: string): string[] {
  return [...getPaletteKit(kitId).codes];
}
/** 旧版保存的套装 id（如已修正的 mard-264）统一解析成当前 id，避免下拉框没有对应选项。 */
export function normalizeKitId(kitId: string | null | undefined): string {
  return getPaletteKit(kitId).id;
}
/** 输入框里的色号规范化：全角、小写、空格 → "A1" / "ZG3"；无效返回 null */
export function normalizeCode(input: string): string | null {
  const text = input.normalize("NFKC").toUpperCase().replace(/\s+/g, "");
  return byCode.has(text) ? text : null;
}

/**
 * “我管理的色号”：所选套装里的色号，加上套装外但库存里有货的色号。
 * 选色、换色、按库存生成都以它为准；套装里暂时用完的颜色仍算在内（用完了是去补货，而不是换成别的颜色）。
 */
export function managedCodes(kitId: string | null | undefined, stock: Record<string, number> = {}): string[] {
  const set = new Set<string>(getPaletteKit(kitId).codes.filter((code) => byCode.has(code)));
  for (const [code, qty] of Object.entries(stock)) if (qty > 0 && byCode.has(code)) set.add(code);
  return [...set].sort(compareCodes);
}
