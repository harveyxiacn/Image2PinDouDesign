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
export type SamplingMode = "auto" | "nearest" | "area";

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
  // 自动识别像素画并保持硬边；nearest 强制锐利采样，area 适合照片的面积平均。
  sampling?: SamplingMode;
  // 在缩放到板面之前裁掉透明/近白留白，让有效针数尽量用于主体细节。
  autoFrame?: boolean;
  // 像素画按原始逻辑像素输出，不为铺满板面制造重复豆位；boardWidth/Height 作为上限。
  smartSize?: boolean;
  allowedColorCodes?: string[] | null;
  adjustments?: ImageAdjustments;
  // 色块简化/降噪强度：0=关，1/2=中值滤波遍数（量化前合并碎噪点为干净色块）。
  smooth?: number;
  // 用黑色 H7 向主体外侧扩一格勾边；优先保留原边缘颜色和细肢。
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
