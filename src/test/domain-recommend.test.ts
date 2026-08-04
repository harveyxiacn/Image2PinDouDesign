import { describe, expect, it } from "vitest";
import { analyzeSource, applyStylePreset, recommendSettings, STYLE_PRESETS } from "../domain/recommend";
import type { ImageAnalysis, RecommendedSettings } from "../domain/recommend";
import type { PixelSource } from "../domain/types";

function solidSource(width: number, height: number, rgba: [number, number, number, number]): PixelSource {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const offset = i * 4;
    data[offset] = rgba[0];
    data[offset + 1] = rgba[1];
    data[offset + 2] = rgba[2];
    data[offset + 3] = rgba[3];
  }
  return { width, height, data };
}

/** 硬边棋盘格：模拟像素画（黑/白交替，所有相邻像素都是大跳变）。 */
function checkerSource(size: number): PixelSource {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;
      const value = (x + y) % 2 === 0 ? 0 : 255;
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }
  return { width: size, height: size, data };
}

/** 高对比黑白竖线：模拟轮廓密集的线稿。 */
function highContrastLineArtSource(size: number): PixelSource {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;
      const value = x % 2 === 0 ? 0 : 255;
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }
  return { width: size, height: size, data };
}

/** 水平黑白渐变：每列灰度递增，相邻像素变化很小，模拟照片的连续渐变。 */
function gradientSource(width: number, height: number): PixelSource {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const value = Math.round((x / Math.max(1, width - 1)) * 255);
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }
  return { width, height, data };
}

/** 放大的低边缘密度像素画：缩略图分类容易当成照片，但原图存在稳定周期。 */
function enlargedBlockArtSource(): PixelSource {
  const logicalWidth = 24;
  const logicalHeight = 32;
  const scale = 9;
  const width = logicalWidth * scale;
  const height = logicalHeight * scale;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const logicalX = Math.floor(x / scale);
      const logicalY = Math.floor(y / scale);
      const light = (Math.floor(logicalX / 2) + Math.floor(logicalY / 2)) % 2 === 0;
      data.set(light ? [245, 170, 35, 255] : [10, 15, 22, 255], (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

const pixelArtAnalysis: ImageAnalysis = {
  kind: "pixel-art",
  width: 32,
  height: 32,
  aspectRatio: 1,
  colorfulness: 0.3,
  uniqueColorEstimate: 10,
  transparencyRatio: 0,
  edgeSharpness: 0.95,
  strongOutlineRatio: 0
};

const photoAnalysis: ImageAnalysis = {
  kind: "photo",
  width: 100,
  height: 100,
  aspectRatio: 1,
  colorfulness: 0.5,
  uniqueColorEstimate: 200,
  transparencyRatio: 0,
  edgeSharpness: 0.05,
  strongOutlineRatio: 0
};

describe("analyzeSource", () => {
  it("detects a hard-edged pixel-art source", () => {
    const analysis = analyzeSource(checkerSource(8));
    expect(analysis.kind).toBe("pixel-art");
    expect(analysis.width).toBe(8);
    expect(analysis.height).toBe(8);
    expect(analysis.aspectRatio).toBe(1);
    // 8×8 棋盘格：右/下 112 组相邻像素全部跳变
    expect(analysis.edgeSharpness).toBeGreaterThan(0.9);
    // 只有黑、白两种颜色
    expect(analysis.uniqueColorEstimate).toBe(2);
    expect(analysis.transparencyRatio).toBe(0);
    expect(analysis.colorfulness).toBeLessThan(0.01);
  });

  it("detects a smooth gradient photo source", () => {
    const analysis = analyzeSource(gradientSource(32, 32));
    expect(analysis.kind).toBe("photo");
    expect(analysis.edgeSharpness).toBeLessThan(0.05);
    expect(analysis.uniqueColorEstimate).toBeGreaterThanOrEqual(8);
    expect(analysis.transparencyRatio).toBe(0);
    expect(analysis.colorfulness).toBeLessThan(0.01);
  });

  it("uses the conversion detector for enlarged low-edge-density pixel art", () => {
    const analysis = analyzeSource(enlargedBlockArtSource());
    expect(analysis.kind).toBe("pixel-art");
    expect(recommendSettings(analysis)).toMatchObject({
      boardPreset: "smart",
      sampling: "nearest",
      dither: false,
      smooth: 0
    });
  });

  it("treats a flat solid color as pixel-art (sharp, no dither)", () => {
    const analysis = analyzeSource(solidSource(8, 8, [200, 40, 40, 255]));
    expect(analysis.kind).toBe("pixel-art");
    expect(analysis.uniqueColorEstimate).toBe(1);
    expect(analysis.edgeSharpness).toBe(0);
  });

  it("reports the transparency ratio of partially transparent pixels", () => {
    const source = solidSource(8, 8, [255, 255, 255, 255]);
    // 右下 4×4 变为全透明
    for (let y = 4; y < 8; y += 1) {
      for (let x = 4; x < 8; x += 1) {
        const offset = (y * 8 + x) * 4;
        source.data[offset + 3] = 0;
      }
    }
    const analysis = analyzeSource(source);
    expect(analysis.transparencyRatio).toBeCloseTo(16 / 64, 5);
  });

  it("downsamples large sources before analysis but keeps original dimensions", () => {
    const analysis = analyzeSource(solidSource(300, 200, [10, 200, 90, 255]));
    expect(analysis.width).toBe(300);
    expect(analysis.height).toBe(200);
    expect(analysis.aspectRatio).toBeCloseTo(1.5, 5);
    expect(analysis.uniqueColorEstimate).toBe(1);
    expect(analysis.transparencyRatio).toBe(0);
  });

  it("measures transparency after downsampling large sources", () => {
    const source = solidSource(200, 100, [255, 255, 255, 255]);
    // 右半（x>=100）全透明
    for (let y = 0; y < 100; y += 1) {
      for (let x = 100; x < 200; x += 1) {
        source.data[(y * 200 + x) * 4 + 3] = 0;
      }
    }
    const analysis = analyzeSource(source);
    expect(analysis.width).toBe(200);
    expect(analysis.height).toBe(100);
    expect(analysis.transparencyRatio).toBeGreaterThan(0.4);
    expect(analysis.transparencyRatio).toBeLessThan(0.6);
  });
});

describe("recommendSettings", () => {
  it("recommends nearest/no-dither/smart board for pixel art", () => {
    const rec = recommendSettings(pixelArtAnalysis);
    expect(rec).toEqual({
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
    });
  });

  it("recommends area/dither/smooth for photos", () => {
    const rec = recommendSettings(photoAnalysis);
    expect(rec).toMatchObject({
      boardPreset: "52",
      maxColors: 48,
      sampling: "area",
      dither: true,
      ditherMode: "floyd-steinberg",
      smooth: 1,
      outline: false,
      ignoreWhiteBg: true,
      keepTransparent: true,
      autoFrame: true
    });
  });

  it("chooses portrait/landscape/square boards by photo aspect ratio", () => {
    expect(recommendSettings({ ...photoAnalysis, aspectRatio: 0.5 }).boardPreset).toBe("52x104");
    expect(recommendSettings({ ...photoAnalysis, aspectRatio: 2 }).boardPreset).toBe("104");
    expect(recommendSettings({ ...photoAnalysis, aspectRatio: 1 }).boardPreset).toBe("52");
  });

  it("keeps the smart board preset for pixel art regardless of aspect", () => {
    expect(recommendSettings({ ...pixelArtAnalysis, aspectRatio: 0.5 }).boardPreset).toBe("smart");
    expect(recommendSettings({ ...pixelArtAnalysis, aspectRatio: 2 }).boardPreset).toBe("smart");
  });

  it("forces keepTransparent and autoFrame when transparency ratio is high", () => {
    const rec = recommendSettings({ ...photoAnalysis, transparencyRatio: 0.2 });
    expect(rec.keepTransparent).toBe(true);
    expect(rec.autoFrame).toBe(true);
    // 推荐永远不静默关闭透明空格；不透明照片开启此项也不会改变结果。
    expect(recommendSettings({ ...photoAnalysis, transparencyRatio: 0.01 }).keepTransparent).toBe(true);
  });

  it("shrinks the color budget for very simple pixel art", () => {
    expect(recommendSettings({ ...pixelArtAnalysis, uniqueColorEstimate: 5 }).maxColors).toBe(8);
    expect(recommendSettings({ ...pixelArtAnalysis, uniqueColorEstimate: 20 }).maxColors).toBe(24);
  });

  it("recommends outline for high-contrast line art", () => {
    const analysis = analyzeSource(highContrastLineArtSource(8));
    expect(analysis.kind).toBe("pixel-art");
    expect(analysis.strongOutlineRatio).toBeGreaterThan(0.4);
    expect(recommendSettings(analysis).outline).toBe(true);
  });

  it("does not recommend outline for a smooth photo gradient", () => {
    const analysis = analyzeSource(gradientSource(32, 32));
    expect(analysis.kind).toBe("photo");
    expect(analysis.strongOutlineRatio).toBe(0);
    expect(recommendSettings(analysis).outline).toBe(false);
  });
});

describe("STYLE_PRESETS", () => {
  it("exposes the four presets with required names", () => {
    expect(STYLE_PRESETS.map((preset) => preset.id)).toEqual(["default", "pixel-art", "photo", "minimal"]);
    expect(STYLE_PRESETS.map((preset) => preset.name)).toEqual([
      "默认（智能）",
      "像素画",
      "照片 / 渐变",
      "简约低多边"
    ]);
    for (const preset of STYLE_PRESETS) {
      expect(preset.description.length).toBeGreaterThan(0);
      expect(typeof preset.settings.boardPreset).toBe("string");
    }
  });

  it("default preset equals the app default settings", () => {
    const defaults: RecommendedSettings = {
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
    expect(STYLE_PRESETS[0].settings).toEqual(defaults);
  });

  it("minimal preset is low-color and heavily smoothed", () => {
    expect(STYLE_PRESETS[3].settings.maxColors).toBe(8);
    expect(STYLE_PRESETS[3].settings.smooth).toBe(2);
    expect(STYLE_PRESETS[3].settings.dither).toBe(false);
  });
});

describe("applyStylePreset", () => {
  it("lets the preset override a different base without mutating it", () => {
    const base = STYLE_PRESETS[2].settings; // photo
    const applied = applyStylePreset("minimal", base);
    expect(applied).toEqual(STYLE_PRESETS[3].settings);
    expect(applied).not.toBe(base);
    // base 未被改动
    expect(base).toEqual(STYLE_PRESETS[2].settings);
  });

  it("default preset restores every field back to defaults", () => {
    const custom: RecommendedSettings = {
      ...STYLE_PRESETS[0].settings,
      sampling: "nearest",
      maxColors: 48,
      smooth: 2,
      keepTransparent: false,
      boardPreset: "104"
    };
    expect(applyStylePreset("default", custom)).toEqual(STYLE_PRESETS[0].settings);
  });

  it("returns a fresh object on each call", () => {
    const base = STYLE_PRESETS[1].settings;
    expect(applyStylePreset("photo", base)).not.toBe(applyStylePreset("photo", base));
  });
});
