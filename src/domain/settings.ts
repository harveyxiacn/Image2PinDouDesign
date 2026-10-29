import { getBoardSize, getBoardTilePins, legacyPresetLayout, sanitizeBoardCount, sanitizeBoardPins, type BoardLayout } from "./boards";
import type { ConversionSettings, FitMode, ImageAdjustments, MaxColors, SamplingMode } from "./types";

export type UiSettings = {
  boardPreset: string;
  customWidth: number;
  customHeight: number;
  maxColors: MaxColors;
  keepTransparent: boolean;
  showLabels: boolean;
  fit: FitMode;
  sampling: SamplingMode;
  autoFrame: boolean;
  dither: boolean;
  ditherMode: "floyd-steinberg" | "bayer";
  adjustments: ImageAdjustments;
  smooth: number;
  outline: boolean;
  ignoreWhiteBg: boolean;
  // 新版拼豆板选择器：单板针数 + 横纵块数（boardPreset === "boards" 时决定图纸尺寸），
  // 其他尺寸方式下 boardPins 仍决定分板粗线与打印分页。旧草稿/测试缺省时按 52 针 1×1。
  boardPins?: number;
  boardCols?: number;
  boardRows?: number;
  cleanupNoise?: boolean;
  mergeRareColors?: number;
};

export const DEFAULT_SETTINGS: UiSettings = {
  boardPreset: "smart", customWidth: 64, customHeight: 64, maxColors: 24,
  keepTransparent: true, showLabels: true, fit: "contain", sampling: "auto",
  autoFrame: true, dither: false, ditherMode: "floyd-steinberg",
  adjustments: { brightness: 0, contrast: 0, saturation: 0 }, smooth: 0,
  outline: false, ignoreWhiteBg: true,
  boardPins: 52, boardCols: 1, boardRows: 1, cleanupNoise: true, mergeRareColors: 0
};

/** 当前设置对应的拼板方式；旧版固定板型（52/104/52x104…）换算成针数与块数。 */
export function resolveBoardLayout(settings: UiSettings): BoardLayout {
  const legacy = legacyPresetLayout(settings.boardPreset);
  if (legacy) {
    return legacy;
  }
  const pins = sanitizeBoardPins(settings.boardPins);
  return {
    pins,
    cols: sanitizeBoardCount(settings.boardCols, pins),
    rows: sanitizeBoardCount(settings.boardRows, pins)
  };
}

export function resolveBoardSize(settings: UiSettings): { width: number; height: number } {
  if (settings.boardPreset === "boards") {
    const layout = resolveBoardLayout(settings);
    return { width: layout.pins * layout.cols, height: layout.pins * layout.rows };
  }
  return getBoardSize(settings.boardPreset, settings.customWidth, settings.customHeight);
}

export function resolveTilePins(settings: UiSettings): number {
  if (legacyPresetLayout(settings.boardPreset)) {
    return getBoardTilePins(settings.boardPreset);
  }
  return settings.boardPins === undefined ? getBoardTilePins(settings.boardPreset) : sanitizeBoardPins(settings.boardPins);
}

export function toConversionSettings(settings: UiSettings, allowedColorCodes: string[] | null): ConversionSettings {
  const size = resolveBoardSize(settings);
  return {
    boardWidth: size.width, boardHeight: size.height,
    boardTilePins: resolveTilePins(settings),
    maxColors: settings.maxColors, keepTransparent: settings.keepTransparent,
    transparentThreshold: 10, dither: settings.dither, ditherMode: settings.ditherMode,
    fit: settings.fit, sampling: settings.sampling, autoFrame: settings.autoFrame,
    smartSize: settings.boardPreset === "smart", allowedColorCodes,
    adjustments: settings.adjustments, smooth: settings.smooth,
    outline: settings.outline, ignoreWhiteBg: settings.ignoreWhiteBg,
    edgeAwarePixelate: true, cleanupNoise: settings.cleanupNoise ?? false,
    mergeRareColors: settings.mergeRareColors ?? 0
  };
}
