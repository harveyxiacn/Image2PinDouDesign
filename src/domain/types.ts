export type Rgb = {
  r: number;
  g: number;
  b: number;
};

export type Rgba = Rgb & {
  a: number;
};

export type Lab = {
  l: number;
  a: number;
  b: number;
};

export type PaletteSeed = {
  code: string;
  nameZh: string;
  hex: string;
  nameEn?: string;
};

export type PaletteColor = PaletteSeed & {
  id: string;
  brand: string;
  rgb: Rgb;
  lab: Lab;
  isAvailable: boolean;
  sortOrder: number;
};

export type BoardPreset = {
  id: string;
  name: string;
  width: number;
  height: number;
  description: string;
};

export type MaxColors = 1 | 8 | 16 | 24 | 32 | 48 | "all";

export type FitMode = "contain" | "cover" | "stretch";

// 量化前的图像微调，取值区间 [-100, 100]，0 表示不变。
export type ImageAdjustments = {
  brightness: number;
  contrast: number;
  saturation: number;
};

export const NEUTRAL_ADJUSTMENTS: ImageAdjustments = {
  brightness: 0,
  contrast: 0,
  saturation: 0
};

export type ConversionSettings = {
  boardWidth: number;
  boardHeight: number;
  maxColors: MaxColors;
  keepTransparent: boolean;
  transparentThreshold: number;
  dither: boolean;
  fit?: FitMode;
  allowedColorCodes?: string[] | null;
  adjustments?: ImageAdjustments;
  // 色块简化/降噪强度：0=关，1/2=中值滤波遍数（量化前合并碎噪点为干净色块）。
  smooth?: number;
  // 用黑色 H7 给主体边缘勾边（与透明相邻的格子换成 H7），便于摆边框。
  outline?: boolean;
  // 忽略白色背景：与边缘相连的近白色格清成空格，不计入用豆、不标色号（主体内部白保留）。
  ignoreWhiteBg?: boolean;
};

export type PixelSource = {
  width: number;
  height: number;
  data: Uint8ClampedArray;
};

export type SampledCell = Rgba | null;

export type SampledGrid = {
  width: number;
  height: number;
  cells: SampledCell[];
};

export type BeadMatrix = Array<Array<string | null>>;

export type BeadDesign = {
  id: string;
  fileName: string;
  boardWidth: number;
  boardHeight: number;
  matrix: BeadMatrix;
  colorCounts: Record<string, number>;
  settings?: ConversionSettings;
  previewUrl?: string;
};
