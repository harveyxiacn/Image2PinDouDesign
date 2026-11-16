import { blobToPixelSource, pixelSourceToBlob } from "./image";
import {
  analyzeBackground,
  DEFAULT_STRENGTH,
  describeBackground,
  EMPTY_EDITS,
  hasTransparentBorder,
  localMethodLine,
  matteBackground,
  type MattingEdits,
  type MattingStrength
} from "./matting";
import type { PixelSource } from "./types";

export type RemovalProgress = { stage: string; ratio: number };

export type BackgroundMethod = "auto" | "local" | "model";
export type RemovalOptions = {
  strength?: MattingStrength;
  edits?: MattingEdits;
  // auto：按背景复杂度自动选；local：只用本地方式（不下载模型）；model：强制 AI 模型。
  method?: BackgroundMethod;
  onProgress?: (progress: RemovalProgress) => void;
};
export type RemovalResult = {
  source: PixelSource;
  // none：无需处理或没能识别；local：本地方式；model：AI 模型；local-fallback：模型不可用后改用本地方式。
  used: "none" | "local" | "model" | "local-fallback";
  // 给用户看的一句话：用了什么方式、为什么。
  message: string;
};

// 智能去背景：先看四边背景像不像纯色/渐变/双色。像 → 本地快速方式（无需联网、更准，
// 也不会误抠白色爪尖、眼睛）；背景杂乱（照片）→ 才加载 AI 模型。模型加载失败（离线、被拦截）
// 时不再报错，而是退回本地方式并说明原因。不新增任何网络请求，模型仍按原方式按需加载。
export async function removeBackgroundSmart(source: PixelSource, options: RemovalOptions = {}): Promise<RemovalResult> {
  const { onProgress } = options;
  const strength = options.strength ?? DEFAULT_STRENGTH;
  const edits = options.edits ?? EMPTY_EDITS;
  const method = options.method ?? "auto";
  onProgress?.({ stage: "analyze", ratio: 0 });
  if (hasTransparentBorder(source)) {
    onProgress?.({ stage: "already-transparent", ratio: 1 });
    return { source, used: "none", message: "图片已经有透明背景，无需再去背景。" };
  }

  const analysis = analyzeBackground(source);
  if (method !== "model" && analysis.usable) {
    const local = matteBackground(source, { strength, edits, analysis });
    if (local.reliable || method === "local") {
      onProgress?.({ stage: "solid-background", ratio: 1 });
      return {
        source: local.source,
        used: "local",
        message: local.reliable
          ? localMethodLine(analysis)
          : `${describeBackground(analysis)}，但几乎没有可去除的部分或会去掉整张图，已保持原样。`
      };
    }
  }

  if (method === "local") {
    // 背景杂乱但用户要求只用本地方式：宽松模式尽力处理。
    return localBestEffort(source, strength, edits, onProgress, "已按你的要求只用本地方式；背景较杂，可能留有残余，可用「点选去除」修正。");
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
    const matte = tightenAiMatte(await blobToPixelSource(output));
    return {
      source: matte,
      used: "model",
      message: `${describeBackground(analysis)}，本地方式不够准，已用 AI 模型抠图。`
    };
  } catch (caught) {
    if (reloadOnceForStaleModule(caught)) {
      // 页面即将重载；保持当前任务 pending，避免卸载前短暂显示误导性的错误。
      return new Promise<RemovalResult>(() => undefined);
    }
    return localBestEffort(
      source,
      strength,
      edits,
      onProgress,
      "AI 模型没能加载（可能离线或被拦截），已改用本地快速方式；复杂背景可能留有残余，可用「点选去除」修正。"
    );
  }
}

function localBestEffort(
  source: PixelSource,
  strength: MattingStrength,
  edits: MattingEdits,
  onProgress: RemovalOptions["onProgress"],
  message: string
): RemovalResult {
  const relaxed = matteBackground(source, { strength, edits, relaxed: true });
  onProgress?.({ stage: "solid-background", ratio: 1 });
  if (!relaxed.reliable) {
    return { source, used: "none", message: `${message} 但没能可靠地识别出背景，已保持原图。` };
  }
  return { source: relaxed.source, used: "local-fallback", message };
}

// 兼容旧调用：只关心结果图。
export async function removeBackgroundFromSource(
  source: PixelSource,
  onProgress?: (progress: RemovalProgress) => void,
  options: Omit<RemovalOptions, "onProgress"> = {}
): Promise<PixelSource> {
  return (await removeBackgroundSmart(source, { ...options, onProgress })).source;
}

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

// 返回 null 表示边缘颜色不够稳定，应交给 AI 模型处理。
export function removeUniformBorderBackground(
  source: PixelSource,
  strength: MattingStrength = DEFAULT_STRENGTH,
  edits: MattingEdits = EMPTY_EDITS
): PixelSource | null {
  const analysis = analyzeBackground(source);
  if (!analysis.usable) return null;
  return matteBackground(source, { strength, edits, analysis }).source;
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
  return { ...source, data: dropSmallIslands(data, source.width, source.height) };
}

// AI 抠图结果里的零星小块（相对最大主体 < 1%）清掉。
function dropSmallIslands(data: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
  const n = width * height;
  const visited = new Uint8Array(n);
  const queue = new Int32Array(n);
  const sizes: { start: number; size: number }[] = [];
  let largest = 0;
  for (let start = 0; start < n; start += 1) {
    if (visited[start] || data[start * 4 + 3] < 16) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    visited[start] = 1;
    while (head < tail) {
      const i = queue[head++];
      const x = i % width;
      const y = (i - x) / width;
      for (let dy = -1; dy <= 1; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const j = ny * width + nx;
          if (!visited[j] && data[j * 4 + 3] >= 16) {
            visited[j] = 1;
            queue[tail++] = j;
          }
        }
      }
    }
    sizes.push({ start, size: tail });
    if (tail > largest) largest = tail;
  }
  const minimum = Math.max(2, Math.floor(largest * 0.01));
  const small = new Set(sizes.filter((entry) => entry.size < minimum).map((entry) => entry.start));
  if (small.size === 0) return data;
  const seen = new Uint8Array(n);
  for (const { start } of sizes) {
    if (!small.has(start)) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    seen[start] = 1;
    while (head < tail) {
      const i = queue[head++];
      data.fill(0, i * 4, i * 4 + 4);
      const x = i % width;
      const y = (i - x) / width;
      for (let dy = -1; dy <= 1; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const j = ny * width + nx;
          if (!seen[j] && data[j * 4 + 3] >= 16) {
            seen[j] = 1;
            queue[tail++] = j;
          }
        }
      }
    }
  }
  return data;
}
