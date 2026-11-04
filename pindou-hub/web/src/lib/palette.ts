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
/** 输入框里的色号规范化：全角、小写、空格 → "A1" / "ZG3"；无效返回 null */
export function normalizeCode(input: string): string | null {
  const text = input.normalize("NFKC").toUpperCase().replace(/\s+/g, "");
  return byCode.has(text) ? text : null;
}
