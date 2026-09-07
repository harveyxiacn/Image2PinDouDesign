import { getBoardSize, getBoardTilePins } from "./boards";
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
};

export const DEFAULT_SETTINGS: UiSettings = {
  boardPreset: "smart", customWidth: 64, customHeight: 64, maxColors: 24,
  keepTransparent: true, showLabels: true, fit: "contain", sampling: "auto",
  autoFrame: true, dither: false, ditherMode: "floyd-steinberg",
  adjustments: { brightness: 0, contrast: 0, saturation: 0 }, smooth: 0,
  outline: false, ignoreWhiteBg: true
};

export function toConversionSettings(settings: UiSettings, allowedColorCodes: string[] | null): ConversionSettings {
  const size = getBoardSize(settings.boardPreset, settings.customWidth, settings.customHeight);
  return {
    boardWidth: size.width, boardHeight: size.height,
    boardTilePins: getBoardTilePins(settings.boardPreset),
    maxColors: settings.maxColors, keepTransparent: settings.keepTransparent,
    transparentThreshold: 10, dither: settings.dither, ditherMode: settings.ditherMode,
    fit: settings.fit, sampling: settings.sampling, autoFrame: settings.autoFrame,
    smartSize: settings.boardPreset === "smart", allowedColorCodes,
    adjustments: settings.adjustments, smooth: settings.smooth,
    outline: settings.outline, ignoreWhiteBg: settings.ignoreWhiteBg
  };
}
