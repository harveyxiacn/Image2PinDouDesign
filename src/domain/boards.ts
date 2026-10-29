import type { BoardPreset } from "./types";

export const BOARD_PRESETS: BoardPreset[] = [
  {
    id: "smart",
    name: "智能尺寸（最多 156 针）",
    width: 156,
    height: 156,
    description: "像素画还原原始格数；普通图片按比例生成，支持超过一块板的精细图。"
  },
  {
    id: "29",
    name: "29 针",
    width: 29,
    height: 29,
    description: "真实方形板（29x29 针），适合小图、头像。"
  },
  {
    id: "50",
    name: "50 针",
    width: 50,
    height: 50,
    description: "真实方形板（50x50 针），常见主力板型。"
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
    id: "boards",
    name: "拼豆板拼接",
    width: 52,
    height: 52,
    description: "选择单块板针数，再按横向 × 纵向块数拼接。"
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

  return Math.max(1, Math.min(208, Math.round(value)));
}

/**
 * 该板型预设对应的单块物理拼豆板针数（打印分页与辅助线用）。
 * 104 / 156 / 52x104 等拼接预设的物理单板仍是 52 针。
 */
export function getBoardTilePins(presetId: string): number {
  switch (presetId) {
    case "29":
      return 29;
    case "50":
      return 50;
    default:
      return 52;
  }
}

export type BoardPinOption = {
  pins: number;
  label: string;
  hint: string;
};

// 常见方形拼豆板的单板针数；其他规格可在界面里手动输入。
export const BOARD_PIN_OPTIONS: BoardPinOption[] = [
  { pins: 29, label: "29 针", hint: "小方板" },
  { pins: 50, label: "50 针", hint: "中方板" },
  { pins: 52, label: "52 针", hint: "常用大板" }
];

export const MIN_BOARD_PINS = 10;
export const MAX_BOARD_PINS = 104;
const MAX_DESIGN_PINS = 208;

export type BoardLayout = {
  pins: number;
  cols: number;
  rows: number;
};

export function sanitizeBoardPins(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return 52;
  }
  return Math.max(MIN_BOARD_PINS, Math.min(MAX_BOARD_PINS, Math.round(value)));
}

/** 单边最多能拼几块板：整张图纸单边不超过 208 针。 */
export function maxBoardsPerSide(pins: number): number {
  return Math.max(1, Math.floor(MAX_DESIGN_PINS / sanitizeBoardPins(pins)));
}

export function sanitizeBoardCount(value: number | undefined, pins: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return 1;
  }
  return Math.max(1, Math.min(maxBoardsPerSide(pins), Math.round(value)));
}

/** 旧版固定板型对应的单板针数与拼接块数，供新版“拼豆板”选择器回显。 */
export function legacyPresetLayout(presetId: string): BoardLayout | null {
  switch (presetId) {
    case "29":
      return { pins: 29, cols: 1, rows: 1 };
    case "50":
      return { pins: 50, cols: 1, rows: 1 };
    case "52":
      return { pins: 52, cols: 1, rows: 1 };
    case "104":
      return { pins: 52, cols: 2, rows: 2 };
    case "52x104":
      return { pins: 52, cols: 1, rows: 2 };
    case "156":
      return { pins: 52, cols: 3, rows: 3 };
    default:
      return null;
  }
}

/**
 * 按图片宽高比排板：长边放 longSideBoards 块，短边按比例取整（至少 1 块），
 * 让“完整显示”时留白最少。aspectRatio = 宽 / 高。
 */
export function suggestBoardLayout(aspectRatio: number, pins: number, longSideBoards: number): BoardLayout {
  const safePins = sanitizeBoardPins(pins);
  const longSide = sanitizeBoardCount(longSideBoards, safePins);
  const ratio = Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : 1;
  const shortSide = sanitizeBoardCount(Math.round(longSide / Math.max(ratio, 1 / ratio)), safePins);
  return ratio >= 1
    ? { pins: safePins, cols: longSide, rows: shortSide }
    : { pins: safePins, cols: shortSide, rows: longSide };
}

/** 任意图纸尺寸需要几块单板（向上取整），用于显示“约需 N × M 块”。 */
export function boardsNeeded(width: number, height: number, pins: number): { cols: number; rows: number } {
  const safePins = sanitizeBoardPins(pins);
  return {
    cols: Math.max(1, Math.ceil(width / safePins)),
    rows: Math.max(1, Math.ceil(height / safePins))
  };
}
