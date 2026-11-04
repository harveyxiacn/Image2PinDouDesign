// 由图片生成拼豆图纸：纯函数部分（可在 Node 里测试）+ Web Worker 客户端。
import { convertPixelSourceToDesign } from "@engine/conversion";
import { MARD_PALETTE } from "@engine/palette";
import { getPaletteKit, resolveAllowedCodes } from "@engine/paletteKits";
import { DEFAULT_SETTINGS, toConversionSettings } from "@engine/settings";
import type { BeadDesign, ConversionSettings, MaxColors, PixelSource } from "@engine/types";

export type BoardChoice = "smart" | "29" | "52" | "104" | "custom";

export type GenerateOptions = {
  board: BoardChoice;
  customWidth: number;
  customHeight: number;
  maxColors: MaxColors;
  kitId: string;
  /** 只用库存里有的颜色：传入库存 > 0 的色号；null 表示不限 */
  ownedCodes: string[] | null;
  dither: boolean;
  outline: boolean;
  ignoreWhiteBg: boolean;
};

export const DEFAULT_GENERATE_OPTIONS: GenerateOptions = {
  board: "smart", customWidth: 64, customHeight: 64, maxColors: 24, kitId: "mard-221",
  ownedCodes: null, dither: false, outline: false, ignoreWhiteBg: true
};

export const BOARD_CHOICES: Array<{ id: BoardChoice; label: string }> = [
  { id: "smart", label: "智能尺寸" },
  { id: "29", label: "29 针" },
  { id: "52", label: "52 针" },
  { id: "104", label: "104 针 (2×2)" },
  { id: "custom", label: "自定义" }
];

export function buildConversionSettings(options: GenerateOptions): ConversionSettings {
  const kit = getPaletteKit(options.kitId);
  const allowed = resolveAllowedCodes(kit, options.ownedCodes && options.ownedCodes.length ? options.ownedCodes : null, MARD_PALETTE);
  const ui = {
    ...DEFAULT_SETTINGS,
    boardPreset: options.board,
    customWidth: options.customWidth,
    customHeight: options.customHeight,
    maxColors: options.maxColors,
    dither: options.dither,
    outline: options.outline,
    ignoreWhiteBg: options.ignoreWhiteBg
  };
  return toConversionSettings(ui, allowed);
}

/** 纯转换：Worker 和测试共用。 */
export function runConversion(source: PixelSource, fileName: string, settings: ConversionSettings): BeadDesign {
  return convertPixelSourceToDesign(source, fileName, settings, MARD_PALETTE);
}

export type GenerateRequest = { id: number; source: PixelSource; fileName: string; settings: ConversionSettings };
export type GenerateResponse =
  | { id: number; type: "progress"; percent: number }
  | { id: number; type: "done"; design: BeadDesign }
  | { id: number; type: "error"; error: string };

export type GenerateJob = { promise: Promise<BeadDesign>; cancel: () => void };

let seq = 0;
/** 在 Worker 中转换。cancel() 直接终止 Worker（转换是同步大块计算，无法中途打断）。 */
export function startGeneration(source: PixelSource, fileName: string, settings: ConversionSettings, onProgress?: (percent: number) => void): GenerateJob {
  const worker = new Worker(new URL("./generate.worker.ts", import.meta.url), { type: "module" });
  const id = ++seq;
  let reject!: (e: Error) => void;
  const promise = new Promise<BeadDesign>((res, rej) => {
    reject = rej;
    worker.onmessage = (event: MessageEvent<GenerateResponse>) => {
      const msg = event.data;
      if (msg.id !== id) return;
      if (msg.type === "progress") onProgress?.(msg.percent);
      else if (msg.type === "done") { worker.terminate(); res(msg.design); }
      else { worker.terminate(); rej(new Error(msg.error)); }
    };
    worker.onerror = (event) => { worker.terminate(); rej(new Error(event.message || "转换失败")); };
  });
  worker.postMessage({ id, source, fileName, settings } satisfies GenerateRequest);
  return { promise, cancel: () => { worker.terminate(); reject(new DOMException("已取消", "AbortError")); } };
}

/** 保存预览 PNG 的格子尺寸：不超过约 1600 万像素。 */
export function previewCellSize(design: Pick<BeadDesign, "boardWidth" | "boardHeight">, preferred: number): number {
  const byBudget = Math.floor(Math.sqrt(16_000_000 / Math.max(1, design.boardWidth * design.boardHeight)));
  return Math.max(4, Math.min(preferred, byBudget));
}
