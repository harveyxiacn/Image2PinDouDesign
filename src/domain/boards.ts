import type { BoardPreset } from "./types";

export const BOARD_PRESETS: BoardPreset[] = [
  {
    id: "smart",
    name: "智能尺寸（最多 52 针）",
    width: 52,
    height: 52,
    description: "像素画自动恢复原始逻辑格数，照片则使用 52 针。"
  },
  {
    id: "52",
    name: "52 针",
    width: 52,
    height: 52,
    description: "单块常用方形板，适合头像、小图标。"
  },
  {
    id: "104",
    name: "104 针",
    width: 104,
    height: 104,
    description: "2x2 块 52 针拼接，适合细节更多的大图。"
  },
  {
    id: "52x104",
    name: "52 x 104",
    width: 52,
    height: 104,
    description: "竖版长图或半身像。"
  },
  {
    id: "156",
    name: "156 针",
    width: 156,
    height: 156,
    description: "3x3 块拼接，适合追求精细度的大图。"
  },
  {
    id: "custom",
    name: "自定义",
    width: 64,
    height: 64,
    description: "手动指定宽高。"
  }
];

export function getBoardSize(presetId: string, customWidth: number, customHeight: number): { width: number; height: number } {
  if (presetId === "custom") {
    return {
      width: sanitizeBoardDimension(customWidth),
      height: sanitizeBoardDimension(customHeight)
    };
  }

  const preset = BOARD_PRESETS.find((item) => item.id === presetId) ?? BOARD_PRESETS[0];
  return {
    width: preset.width,
    height: preset.height
  };
}

export function sanitizeBoardDimension(value: number): number {
  if (!Number.isFinite(value)) {
    return 52;
  }

  return Math.max(8, Math.min(208, Math.round(value)));
}
