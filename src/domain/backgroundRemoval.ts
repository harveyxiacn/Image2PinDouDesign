import { blobToPixelSource, pixelSourceToBlob } from "./image";
import type { PixelSource, Rgb } from "./types";

export type RemovalProgress = { stage: string; ratio: number };

// 智能去背景先识别纯色/近纯色边缘。此类素材用边缘连通色键比通用分割模型更准确，
// 也不会把白色爪尖、眼睛等误抠掉；复杂背景再按需下载 AI 模型。
export async function removeBackgroundFromSource(
  source: PixelSource,
  onProgress?: (progress: RemovalProgress) => void
): Promise<PixelSource> {
  onProgress?.({ stage: "analyze", ratio: 0 });
  if (hasTransparentBorder(source)) {
    onProgress?.({ stage: "already-transparent", ratio: 1 });
    return source;
  }
  const solidBackgroundResult = removeUniformBorderBackground(source);
  if (solidBackgroundResult) {
    onProgress?.({ stage: "solid-background", ratio: 1 });
    return solidBackgroundResult;
  }

  try {
    const { removeBackground } = await import("@imgly/background-removal");
    const input = await pixelSourceToBlob(source);
    const output = await removeBackground(input, {
      model: "isnet_fp16",
      output: { format: "image/png" },
      progress: (stage, current, total) => {
        onProgress?.({ stage, ratio: total > 0 ? current / total : 0 });
      }
    });
    return tightenAiMatte(await blobToPixelSource(output));
  } catch (caught) {
    if (reloadOnceForStaleModule(caught)) {
      // 页面即将重载；保持当前任务 pending，避免卸载前短暂显示误导性的错误。
      return new Promise<PixelSource>(() => undefined);
    }
    const detail = caught instanceof Error ? `（${caught.message}）` : "";
    throw new Error(`AI 模型加载或抠图失败，请检查网络后重试${detail}`);
  }
}

type BorderEstimate = { color: Rgb; tolerance: number };

export function isDynamicImportFailure(caught: unknown): boolean {
  const message = caught instanceof Error ? caught.message : String(caught);
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(message);
}

function reloadOnceForStaleModule(caught: unknown): boolean {
  if (!isDynamicImportFailure(caught) || typeof window === "undefined") {
    return false;
  }

  const currentBundle = document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.src
    ?? window.location.pathname;
  const storageKey = "image2pindou:stale-module-reload";
  try {
    if (window.sessionStorage.getItem(storageKey) === currentBundle) {
      return false;
    }
    window.sessionStorage.setItem(storageKey, currentBundle);
    window.location.reload();
    return true;
  } catch {
    return false;
  }
}

function hasTransparentBorder(source: PixelSource): boolean {
  const { width, height, data } = source;
  let transparent = 0;
  let sampled = 0;
  const sample = (x: number, y: number) => {
    sampled += 1;
    if (data[(y * width + x) * 4 + 3] < 16) transparent += 1;
  };
  for (let x = 0; x < width; x += 1) {
    sample(x, 0);
    if (height > 1) sample(x, height - 1);
  }
  for (let y = 1; y < height - 1; y += 1) {
    sample(0, y);
    if (width > 1) sample(width - 1, y);
  }
  return sampled > 0 && transparent / sampled >= 0.2;
}

// 从四边估计占主导的背景色，再只移除与画布边缘连通的相近颜色。
// 返回 null 表示边缘颜色不够稳定，应交给 AI 模型处理。
export function removeUniformBorderBackground(source: PixelSource): PixelSource | null {
  const estimate = estimateUniformBorder(source);
  if (!estimate) {
    return null;
  }

  const { width, height } = source;
  const pixelCount = width * height;
  const background = new Uint8Array(pixelCount);
  const queued = new Uint8Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  let head = 0;
  let tail = 0;

  const enqueue = (index: number) => {
    if (!queued[index]) {
      queued[index] = 1;
      queue[tail] = index;
      tail += 1;
    }
  };

  for (let x = 0; x < width; x += 1) {
    enqueue(x);
    enqueue((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    enqueue(y * width);
    enqueue(y * width + width - 1);
  }

  while (head < tail) {
    const index = queue[head];
    head += 1;
    const dataIndex = index * 4;
    if (source.data[dataIndex + 3] < 16 || colorDistance(source.data, dataIndex, estimate.color) <= estimate.tolerance) {
      background[index] = 1;
      const x = index % width;
      const y = (index - x) / width;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
            enqueue(ny * width + nx);
          }
        }
      }
    }
  }

  // JPEG 抗锯齿会在主体外缘留下 1~3px 的背景混色。限制为三轮向内剥离，
  // 可以清掉色边，又不会像无限 flood-fill 那样吞掉与背景相近的主体区域。
  const fringeTolerance = Math.min(180, Math.max(150, estimate.tolerance + 72));
  for (let pass = 0; pass < 3; pass += 1) {
    const fringe: number[] = [];
    for (let index = 0; index < pixelCount; index += 1) {
      if (background[index]) continue;
      const x = index % width;
      const y = (index - x) / width;
      const touchesBackground =
        (x > 0 && background[index - 1]) ||
        (x < width - 1 && background[index + 1]) ||
        (y > 0 && background[index - width]) ||
        (y < height - 1 && background[index + width]);
      if (touchesBackground && colorDistance(source.data, index * 4, estimate.color) <= fringeTolerance) {
        fringe.push(index);
      }
    }
    if (fringe.length === 0) break;
    for (const index of fringe) background[index] = 1;
  }

  const data = new Uint8ClampedArray(source.data);
  for (let index = 0; index < pixelCount; index += 1) {
    if (background[index]) {
      const dataIndex = index * 4;
      data[dataIndex] = 0;
      data[dataIndex + 1] = 0;
      data[dataIndex + 2] = 0;
      data[dataIndex + 3] = 0;
    }
  }

  removeSmallForegroundComponents(data, width, height);
  return { width, height, data };
}

function estimateUniformBorder(source: PixelSource): BorderEstimate | null {
  const { width, height, data } = source;
  if (width < 2 || height < 2) {
    return null;
  }

  const band = Math.max(1, Math.round(Math.min(width, height) * 0.015));
  const samples: Rgb[] = [];
  const histogram = new Map<number, number>();

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (x >= band && x < width - band && y >= band && y < height - band) continue;
      const index = (y * width + x) * 4;
      if (data[index + 3] < 224) continue;
      const sample = { r: data[index], g: data[index + 1], b: data[index + 2] };
      samples.push(sample);
      const bucket = (sample.r >> 4) << 8 | (sample.g >> 4) << 4 | (sample.b >> 4);
      histogram.set(bucket, (histogram.get(bucket) ?? 0) + 1);
    }
  }

  if (samples.length < Math.max(8, (width + height) * 0.5)) {
    return null;
  }

  let dominantBucket = -1;
  let dominantCount = 0;
  for (const [bucket, count] of histogram) {
    if (count > dominantCount) {
      dominantBucket = bucket;
      dominantCount = count;
    }
  }

  const bucketSamples = samples.filter((sample) => {
    const bucket = (sample.r >> 4) << 8 | (sample.g >> 4) << 4 | (sample.b >> 4);
    return bucket === dominantBucket;
  });
  if (bucketSamples.length === 0) {
    return null;
  }

  const color = bucketSamples.reduce<Rgb>((sum, sample) => ({
    r: sum.r + sample.r,
    g: sum.g + sample.g,
    b: sum.b + sample.b
  }), { r: 0, g: 0, b: 0 });
  color.r /= bucketSamples.length;
  color.g /= bucketSamples.length;
  color.b /= bucketSamples.length;

  const distances = samples.map((sample) => rgbDistance(sample, color)).sort((a, b) => a - b);
  const closeCount = distances.findIndex((distance) => distance > 36);
  const stableCount = closeCount < 0 ? distances.length : closeCount;
  if (stableCount / samples.length < 0.58) {
    return null;
  }

  const stableDistances = distances.slice(0, stableCount);
  const p95 = stableDistances[Math.min(stableDistances.length - 1, Math.floor(stableDistances.length * 0.95))] ?? 0;
  return {
    color,
    // 扩大到抗锯齿混色带，但仍远小于正常主体色与背景色的距离。
    tolerance: clamp(p95 * 2 + 54, 64, 112)
  };
}

function colorDistance(data: Uint8ClampedArray, index: number, target: Rgb): number {
  return rgbDistance({ r: data[index], g: data[index + 1], b: data[index + 2] }, target);
}

function rgbDistance(left: Rgb, right: Rgb): number {
  return Math.hypot(left.r - right.r, left.g - right.g, left.b - right.b);
}

function tightenAiMatte(source: PixelSource): PixelSource {
  const data = new Uint8ClampedArray(source.data);
  for (let index = 3; index < data.length; index += 4) {
    const alpha = data[index];
    data[index] = alpha <= 32 ? 0 : Math.round(((alpha - 32) / 223) * 255);
    if (data[index] === 0) {
      data[index - 3] = 0;
      data[index - 2] = 0;
      data[index - 1] = 0;
    }
  }
  removeSmallForegroundComponents(data, source.width, source.height);
  return { ...source, data };
}

function removeSmallForegroundComponents(data: Uint8ClampedArray, width: number, height: number): void {
  const pixelCount = width * height;
  const visited = new Uint8Array(pixelCount);
  const components: number[][] = [];
  let largest = 0;

  for (let start = 0; start < pixelCount; start += 1) {
    if (visited[start] || data[start * 4 + 3] < 16) continue;
    const component: number[] = [];
    const stack = [start];
    visited[start] = 1;
    while (stack.length > 0) {
      const index = stack.pop()!;
      component.push(index);
      const x = index % width;
      const y = (index - x) / width;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const neighbor = ny * width + nx;
          if (!visited[neighbor] && data[neighbor * 4 + 3] >= 16) {
            visited[neighbor] = 1;
            stack.push(neighbor);
          }
        }
      }
    }
    components.push(component);
    largest = Math.max(largest, component.length);
  }

  const minimumSize = Math.max(2, Math.floor(largest * 0.01));
  for (const component of components) {
    if (component.length >= minimumSize) continue;
    for (const index of component) {
      const dataIndex = index * 4;
      data[dataIndex] = 0;
      data[dataIndex + 1] = 0;
      data[dataIndex + 2] = 0;
      data[dataIndex + 3] = 0;
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
