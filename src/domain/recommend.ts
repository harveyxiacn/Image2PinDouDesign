import type { PixelSource } from "./types";

/**
 * 一键推荐 / 风格预设的领域逻辑。
 *
 * 字段名与 SettingsPanel 的 UI 设置键保持一致，App 侧可以直接
 * `{ ...settings, ...recommendation }` 展开覆盖，不额外引入 UI 依赖。
 */

export type RecommendedSettings = {
  boardPreset: string;
  maxColors: 8 | 16 | 24 | 32 | 48 | "all";
  sampling: "auto" | "nearest" | "area";
  dither: boolean;
  ditherMode: "floyd-steinberg" | "bayer";
  smooth: 0 | 1 | 2;
  outline: boolean;
  ignoreWhiteBg: boolean;
  autoFrame: boolean;
  keepTransparent: boolean;
};

export type ImageAnalysis = {
  kind: "pixel-art" | "photo";
  width: number;
  height: number;
  aspectRatio: number;
  colorfulness: number;
  uniqueColorEstimate: number;
  transparencyRatio: number;
  edgeSharpness: number;
};

// 分析前先把图片面积平均降采样到 ≤64×64，把主线程成本控制在几千像素量级。
const ANALYSIS_MAX_DIMENSION = 64;
// 相邻像素 RGBA 距离 ≥ 该值视为一次“硬边跳变”（像素画特征）。
const EDGE_DISTANCE_THRESHOLD = 48;
// 硬边跳变占比 ≥ 该值判为像素画。
const PIXEL_ART_EDGE_RATIO = 0.3;
// 低硬边且颜色极简（≤ 2 桶）也按像素画处理：纯色/极简 Logo 保持锐利、不抖动。
const FLAT_COLOR_EDGE_RATIO = 0.05;
const FLAT_COLOR_BUCKET_LIMIT = 2;
// alpha < 128 视为透明像素。
const TRANSPARENT_ALPHA = 128;
// 透明区域占比 > 5% 时强制 keepTransparent + autoFrame。
const TRANSPARENCY_FORCE_THRESHOLD = 0.05;

/**
 * 分析图片源：内部先降采样到 ≤64×64（面积平均）再计算各指标。
 * 返回的 width/height/aspectRatio 是原图尺寸（aspectRatio = width / height）。
 */
export function analyzeSource(source: PixelSource): ImageAnalysis {
  const { width, height } = source;
  const sampled = downsampleToAnalysisSize(source);
  const metrics = computeMetrics(sampled);
  const aspectRatio = width / Math.max(1, height);

  return {
    kind: classifyKind(metrics.edgeSharpness, metrics.uniqueColorEstimate),
    width,
    height,
    aspectRatio,
    colorfulness: metrics.colorfulness,
    uniqueColorEstimate: metrics.uniqueColorEstimate,
    transparencyRatio: metrics.transparencyRatio,
    edgeSharpness: metrics.edgeSharpness
  };
}

type AnalysisMetrics = {
  colorfulness: number;
  uniqueColorEstimate: number;
  transparencyRatio: number;
  edgeSharpness: number;
};

/**
 * 基于 ≤64×64 的降采样图计算指标：
 * - colorfulness：不透明像素的平均饱和度（(max-min)/255，0..1）。
 * - uniqueColorEstimate：RGB 每通道按 32 步进分桶（最多 512 桶）后去重计数。
 * - transparencyRatio：alpha<128 的像素占比。
 * - edgeSharpness：相邻像素（右/下邻居）RGBA 距离 ≥ 阈值的跳变比例（0..1）。
 */
function computeMetrics(sampled: PixelSource): AnalysisMetrics {
  const { width, height, data } = sampled;
  const pixelCount = width * height;
  let transparentCount = 0;
  let saturationSum = 0;
  let opaqueCount = 0;
  const buckets = new Set<number>();
  let edgeCount = 0;
  let comparisonCount = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const r = data[index];
      const g = data[index + 1];
      const b = data[index + 2];
      const a = data[index + 3];

      if (a < TRANSPARENT_ALPHA) {
        transparentCount += 1;
      } else {
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        saturationSum += (max - min) / 255;
        opaqueCount += 1;
        // 每通道 32 步进 → 0..7，共最多 8^3 = 512 桶
        const bucket = (Math.min(7, r >> 5) << 6) | (Math.min(7, g >> 5) << 3) | Math.min(7, b >> 5);
        buckets.add(bucket);
      }

      if (x + 1 < width) {
        comparisonCount += 1;
        if (isHardEdge(r, g, b, a, data[index + 4], data[index + 5], data[index + 6], data[index + 7])) {
          edgeCount += 1;
        }
      }
      if (y + 1 < height) {
        const next = index + width * 4;
        comparisonCount += 1;
        if (isHardEdge(r, g, b, a, data[next], data[next + 1], data[next + 2], data[next + 3])) {
          edgeCount += 1;
        }
      }
    }
  }

  return {
    colorfulness: opaqueCount > 0 ? saturationSum / opaqueCount : 0,
    uniqueColorEstimate: buckets.size,
    transparencyRatio: pixelCount > 0 ? transparentCount / pixelCount : 0,
    edgeSharpness: comparisonCount > 0 ? edgeCount / comparisonCount : 0
  };
}

function isHardEdge(
  r1: number, g1: number, b1: number, a1: number,
  r2: number, g2: number, b2: number, a2: number
): boolean {
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  const da = a1 - a2;
  return Math.sqrt(dr * dr + dg * dg + db * db + da * da) >= EDGE_DISTANCE_THRESHOLD;
}

function classifyKind(edgeSharpness: number, uniqueColorEstimate: number): "pixel-art" | "photo" {
  // 硬边密集 = 像素画的核心特征；低硬边 + 极简颜色（纯色/Logo）也按像素画处理。
  if (edgeSharpness >= PIXEL_ART_EDGE_RATIO) {
    return "pixel-art";
  }
  if (edgeSharpness <= FLAT_COLOR_EDGE_RATIO && uniqueColorEstimate <= FLAT_COLOR_BUCKET_LIMIT) {
    return "pixel-art";
  }
  return "photo";
}

/**
 * 面积平均降采样到 ≤64×64；已经小于等于目标尺寸时直接复用原数据（只读不复制）。
 */
function downsampleToAnalysisSize(source: PixelSource): PixelSource {
  const { width, height, data } = source;
  if (width <= ANALYSIS_MAX_DIMENSION && height <= ANALYSIS_MAX_DIMENSION) {
    return source;
  }

  const scale = Math.min(1, ANALYSIS_MAX_DIMENSION / Math.max(width, height));
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));
  const target = new Uint8ClampedArray(targetWidth * targetHeight * 4);

  for (let ty = 0; ty < targetHeight; ty += 1) {
    const yStart = Math.floor((ty * height) / targetHeight);
    const yEnd = Math.max(yStart + 1, Math.floor(((ty + 1) * height) / targetHeight));
    for (let tx = 0; tx < targetWidth; tx += 1) {
      const xStart = Math.floor((tx * width) / targetWidth);
      const xEnd = Math.max(xStart + 1, Math.floor(((tx + 1) * width) / targetWidth));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = yStart; sy < yEnd; sy += 1) {
        for (let sx = xStart; sx < xEnd; sx += 1) {
          const sourceIndex = (sy * width + sx) * 4;
          r += data[sourceIndex];
          g += data[sourceIndex + 1];
          b += data[sourceIndex + 2];
          a += data[sourceIndex + 3];
        }
      }
      const area = (yEnd - yStart) * (xEnd - xStart);
      const targetIndex = (ty * targetWidth + tx) * 4;
      target[targetIndex] = r / area;
      target[targetIndex + 1] = g / area;
      target[targetIndex + 2] = b / area;
      target[targetIndex + 3] = a / area;
    }
  }

  return { width: targetWidth, height: targetHeight, data: target };
}

// 像素画 / 照片的推荐基座（后续规则只做少量覆盖）
const PIXEL_ART_BASE: RecommendedSettings = {
  boardPreset: "smart",
  maxColors: 24,
  sampling: "nearest",
  dither: false,
  ditherMode: "floyd-steinberg",
  smooth: 0,
  outline: false,
  ignoreWhiteBg: true,
  autoFrame: true,
  keepTransparent: true
};

const PHOTO_BASE: RecommendedSettings = {
  boardPreset: "52",
  maxColors: 48,
  sampling: "area",
  dither: true,
  ditherMode: "floyd-steinberg",
  smooth: 1,
  outline: false,
  ignoreWhiteBg: true,
  autoFrame: true,
  keepTransparent: false
};

/**
 * 根据分析结果生成一套完整推荐参数。
 *
 * 规则：
 * - 像素画：nearest + 无抖动 + 不降噪 + smart 板型（按原始逻辑格数输出），
 *   keepTransparent/autoFrame 恒开；颜色 ≤8 桶时把 maxColors 压到 8，避免废豆。
 * - 照片：area + Floyd-Steinberg 抖动 + smooth 1 + 48 色，板型按构图细分：
 *   竖构图（aspectRatio<0.85）→ 52x104，横构图（>1.4）→ 104，其余 52。
 * - 透明区域 >5% 时强制 keepTransparent + autoFrame（照片基座默认不保留透明，
 *   有透明 PNG 时绝不能填色或留大边）。
 */
export function recommendSettings(analysis: ImageAnalysis): RecommendedSettings {
  const isPixelArt = analysis.kind === "pixel-art";
  const settings: RecommendedSettings = isPixelArt ? { ...PIXEL_ART_BASE } : { ...PHOTO_BASE };

  if (isPixelArt) {
    if (analysis.uniqueColorEstimate <= 8) {
      settings.maxColors = 8;
    }
  } else {
    settings.boardPreset = boardPresetForAspectRatio(analysis.aspectRatio);
  }

  if (analysis.transparencyRatio > TRANSPARENCY_FORCE_THRESHOLD) {
    settings.keepTransparent = true;
    settings.autoFrame = true;
  }

  return settings;
}

function boardPresetForAspectRatio(aspectRatio: number): "52x104" | "104" | "52" {
  if (aspectRatio < 0.85) {
    return "52x104";
  }
  if (aspectRatio > 1.4) {
    return "104";
  }
  return "52";
}

export type StylePresetId = "default" | "pixel-art" | "photo" | "minimal";

export type StylePreset = {
  id: StylePresetId;
  name: string;
  description: string;
  settings: RecommendedSettings;
};

// default 预设即全站默认值，与 SettingsPanel 的恢复默认值保持一致。
const DEFAULT_RECOMMENDED_SETTINGS: RecommendedSettings = {
  boardPreset: "smart",
  maxColors: 24,
  sampling: "auto",
  dither: false,
  ditherMode: "floyd-steinberg",
  smooth: 0,
  outline: false,
  ignoreWhiteBg: true,
  autoFrame: true,
  keepTransparent: true
};

export const STYLE_PRESETS: StylePreset[] = [
  {
    id: "default",
    name: "默认（智能）",
    description: "根据图片内容自动分析并推荐参数：像素画保持硬边，照片平滑过渡。",
    settings: DEFAULT_RECOMMENDED_SETTINGS
  },
  {
    id: "pixel-art",
    name: "像素画",
    description: "保持硬边与原始逻辑像素，适合像素画、图标和已有拼豆图。",
    settings: PIXEL_ART_BASE
  },
  {
    id: "photo",
    name: "照片 / 渐变",
    description: "面积平均 + 误差扩散抖动，适合照片、渐变和普通插画。",
    settings: PHOTO_BASE
  },
  {
    id: "minimal",
    name: "简约低多边",
    description: "强降噪 + 低色数，把图片简化成干净的大色块，适合简约海报与装饰画。",
    settings: {
      boardPreset: "52",
      maxColors: 8,
      sampling: "area",
      dither: false,
      ditherMode: "floyd-steinberg",
      smooth: 2,
      outline: false,
      ignoreWhiteBg: true,
      autoFrame: true,
      keepTransparent: false
    }
  }
];

/**
 * 应用风格预设：返回 { ...base, ...preset.settings }，preset 覆盖 base。
 * 纯函数，不改动入参。预设设置都是完整 RecommendedSettings，因此结果始终完整。
 */
export function applyStylePreset(presetId: StylePresetId, base: RecommendedSettings): RecommendedSettings {
  const preset = STYLE_PRESETS.find((item) => item.id === presetId);
  return { ...base, ...(preset ? preset.settings : {}) };
}
