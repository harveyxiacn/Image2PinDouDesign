import { describe, expect, it } from "vitest";
import { MARD_221_SEEDS, MARD_PALETTE } from "../domain/palette";
import { adviseColors, adviseSize } from "../domain/smartAdvisor";
import type { PixelSource } from "../domain/types";

// 智能推荐的固定对照集：用程序合成的四类典型图片（线稿、平涂插画、像素画、照片式渐变），
// 锁定推荐结果的合理区间与相对顺序。以后调整推荐算法时，这组测试能立刻发现退化。

const STANDARD = new Set(MARD_221_SEEDS.map((seed) => seed.code));
const PALETTE = MARD_PALETTE.filter((color) => STANDARD.has(color.code));

type Rgb = [number, number, number];

function image(width: number, height: number, color: (x: number, y: number) => Rgb): PixelSource {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) data.set([...color(x, y), 255], (y * width + x) * 4);
  }
  return { width, height, data };
}

// 线稿：白底上一组带抗锯齿的同心圆细线（约 2.5px 宽），接近扫描 / 绘图软件导出的线稿。
const lineArt = image(360, 360, (x, y) => {
  const r = Math.hypot(x - 180.3, y - 179.7);
  const distance = Math.abs(((r + 11) % 22) - 11);
  const ink = Math.max(0, Math.min(1, 1.6 - distance));
  const v = Math.round(255 - ink * 235);
  return [v, v, v];
});

// 平涂插画：六个大色块。
const FLAT: Rgb[] = [[230, 57, 70], [241, 250, 238], [168, 218, 220], [69, 123, 157], [29, 53, 87], [244, 162, 97]];
const flatIllustration = image(360, 300, (x, y) => FLAT[(Math.floor(x / 120) + Math.floor(y / 150) * 3) % FLAT.length]);

// 像素画：32×24 的逻辑像素放大 8 倍，硬边。
const pixelArt = image(256, 192, (x, y) => {
  const px = Math.floor(x / 8);
  const py = Math.floor(y / 8);
  return (px * 7 + py * 3) % 5 === 0 ? [40, 40, 40] : (px + py) % 3 === 0 ? [250, 200, 60] : [90, 160, 230];
});

// 照片式：色相与明度连续变化，再叠加细小纹理。
const photo = image(400, 300, (x, y) => {
  const hue = (x / 400) * Math.PI * 2;
  const light = 0.35 + 0.55 * (y / 300);
  const grain = ((x * 13 + y * 7) % 9) - 4;
  return [
    Math.round(128 + 110 * Math.cos(hue) * light + grain),
    Math.round(128 + 110 * Math.cos(hue - 2.09) * light + grain),
    Math.round(128 + 110 * Math.cos(hue + 2.09) * light + grain)
  ];
});

describe("advisor benchmark", () => {
  it("keeps line art and flat illustrations to few colors", () => {
    expect(adviseColors(lineArt, PALETTE)!.recommended).toBeLessThanOrEqual(16);
    expect(adviseColors(flatIllustration, PALETTE)!.recommended).toBeLessThanOrEqual(16);
  });

  it("asks for many more colors for a photo-like gradient", () => {
    const photoColors = adviseColors(photo, PALETTE)!;
    const flatColors = adviseColors(flatIllustration, PALETTE)!;
    expect(photoColors.recommended).toBeGreaterThanOrEqual(24);
    expect(Number(photoColors.recommended)).toBeGreaterThan(Number(flatColors.recommended));
    expect(photoColors.colorsFor95).toBeGreaterThan(flatColors.colorsFor95);
  });

  it("restores pixel art at its native grid", () => {
    const size = adviseSize(pixelArt, 52)!;
    expect([size.width, size.height]).toEqual([32, 24]);
  });

  it("needs a larger board for fine line art than for big flat shapes", () => {
    const flat = adviseSize(flatIllustration, 52)!;
    const lines = adviseSize(lineArt, 52)!;
    expect(flat.longEdge).toBeLessThanOrEqual(52);
    expect(lines.longEdge).toBeGreaterThan(flat.longEdge);
    // 推荐理由必须是给用户看的人话，不出现 NaN / 0.0 之类的数值残留。
    for (const advice of [flat, lines, adviseSize(photo, 52)!]) {
      expect(advice.reason).not.toMatch(/NaN|undefined|0\.0/);
    }
  });
});
