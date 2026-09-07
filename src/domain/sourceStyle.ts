import type { PixelSource } from "./types";

// 只采样有限数量的相邻像素。大面积平涂加跳变边界适合主色/轮廓采样，
// 连续渐变和纹理照片保持面积平均；这是图像特征分类，并非角色语义识别。
export function isFlatIllustration(source: PixelSource): boolean {
  const stride = Math.max(1, Math.floor(Math.sqrt(source.width * source.height / 16000)));
  let flat = 0;
  let hard = 0;
  let total = 0;
  const pair = (a: number, b: number) => {
    if (source.data[a + 3] < 128 || source.data[b + 3] < 128) return;
    const delta = Math.max(Math.abs(source.data[a] - source.data[b]),
      Math.abs(source.data[a + 1] - source.data[b + 1]), Math.abs(source.data[a + 2] - source.data[b + 2]));
    total++;
    if (delta <= 8) flat++;
    if (delta >= 42) hard++;
  };
  for (let blockY = 0, row = 0; blockY < source.height; blockY += stride, row++) {
    for (let blockX = 0, column = 0; blockX < source.width; blockX += stride, column++) {
      const x = Math.min(source.width - 1, blockX + row % stride);
      const y = Math.min(source.height - 1, blockY + column % stride);
      const index = (y * source.width + x) * 4;
      if (x + 1 < source.width) pair(index, index + 4);
      if (y + 1 < source.height) pair(index, index + source.width * 4);
    }
  }
  return total >= 24 && flat / total > 0.78 && hard / total > 0.008;
}
