import type { PixelSource } from "./types";

// 本地（不联网）背景去除引擎：全部是作用在 PixelSource 上的纯函数，只用类型化数组，
// 可在 vitest（无 DOM）里直接跑。颜色比较使用 CIELAB（ΔE76 欧氏距离），比 RGB 距离更贴近人眼。
//
// 开销（2000×2000）：Lab 缓存 Float32Array 约 48MB，掩码/队列 Uint8Array+Int32Array 约 24MB；
// 一次完整运行约 0.5~1.2 秒（Lab 转换约 0.3s，泛洪/边缘/连通域各约 0.1s），无逐像素对象分配。
// 对话框里的实时预览会先缩到最长边 ≤ 360px，耗时在 20ms 量级。

export type MattingStrength = "conservative" | "standard" | "strong";
export type MattingPoint = { x: number; y: number };
export type MattingEdits = { keep: MattingPoint[]; remove: MattingPoint[] };
export type BackgroundKind = "plain" | "two-tone" | "gradient" | "busy" | "unknown";

export type BackgroundAnalysis = {
  kind: BackgroundKind;
  // 边缘背景参考色（Lab，按占比从大到小），每个 3 个数 L,a,b。
  centers: number[][];
  // 边缘采样里落在参考色附近的比例 0..1。
  coverage: number;
  // 边缘噪声（到最近参考色距离的 p90，ΔE）。
  noise: number;
  // 主背景色是否带明显颜色（决定是否可以放心移除封闭同色块）。
  chromatic: boolean;
  // 是否适合用本地方式处理（false = 背景太复杂，应交给 AI 模型）。
  usable: boolean;
};

export type MattingOutput = {
  source: PixelSource;
  analysis: BackgroundAnalysis;
  removedRatio: number;
  // 结果是否可信：几乎没抠掉或几乎全抠掉都视为不可信。
  reliable: boolean;
};

export const DEFAULT_STRENGTH: MattingStrength = "standard";
export const EMPTY_EDITS: MattingEdits = { keep: [], remove: [] };

export const STRENGTH_LABELS: Record<MattingStrength, string> = {
  conservative: "保守",
  standard: "标准",
  strong: "强力"
};

type StrengthProfile = {
  base: number; // 基础容差（ΔE）
  fringePasses: number; // 向内剥离抗锯齿边的轮数
  shadowDepth: number; // 允许当作阴影的最大变暗量（L 单位），0 = 不处理阴影
  removeAllHoles: boolean; // 中性背景下是否也移除厚实的封闭同色块
  holesOnNeutral: boolean; // 中性（白/灰）背景是否处理封闭同色块
  speckRatio: number; // 小于最大连通域该比例的孤岛被清掉
};

const PROFILES: Record<MattingStrength, StrengthProfile> = {
  conservative: { base: 6, fringePasses: 1, shadowDepth: 0, removeAllHoles: false, holesOnNeutral: false, speckRatio: 0.003 },
  standard: { base: 10, fringePasses: 2, shadowDepth: 22, removeAllHoles: false, holesOnNeutral: true, speckRatio: 0.01 },
  strong: { base: 16, fringePasses: 3, shadowDepth: 40, removeAllHoles: true, holesOnNeutral: true, speckRatio: 0.03 }
};

// ---------- Lab 转换 ----------

const SRGB_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i += 1) {
  const c = i / 255;
  SRGB_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function labF(t: number): number {
  return t > 0.008856451679 ? Math.cbrt(t) : 7.787037037 * t + 16 / 116;
}

function rgbToLabInto(r: number, g: number, b: number, out: Float32Array, o: number): void {
  const lr = SRGB_LINEAR[r];
  const lg = SRGB_LINEAR[g];
  const lb = SRGB_LINEAR[b];
  const fx = labF((lr * 0.4124 + lg * 0.3576 + lb * 0.1805) / 0.95047);
  const fy = labF(lr * 0.2126 + lg * 0.7152 + lb * 0.0722);
  const fz = labF((lr * 0.0193 + lg * 0.1192 + lb * 0.9505) / 1.08883);
  out[o] = 116 * fy - 16;
  out[o + 1] = 500 * (fx - fy);
  out[o + 2] = 200 * (fy - fz);
}

function computeLab(source: PixelSource): Float32Array {
  const n = source.width * source.height;
  const lab = new Float32Array(n * 3);
  const d = source.data;
  for (let i = 0, p = 0; i < n; i += 1, p += 4) {
    rgbToLabInto(d[p], d[p + 1], d[p + 2], lab, i * 3);
  }
  return lab;
}

// ---------- 背景分析 ----------

export function hasTransparentBorder(source: PixelSource): boolean {
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

const UNKNOWN: BackgroundAnalysis = { kind: "unknown", centers: [], coverage: 0, noise: 0, chromatic: false, usable: false };

export function analyzeBackground(source: PixelSource, options: { relaxed?: boolean } = {}): BackgroundAnalysis {
  const { width, height, data } = source;
  if (width < 2 || height < 2) return UNKNOWN;
  const relaxed = options.relaxed === true;
  const band = Math.max(1, Math.round(Math.min(width, height) * 0.015));

  // 边缘带采样（只取不透明像素）
  const labs: number[] = [];
  const tmp = new Float32Array(3);
  const addSample = (x: number, y: number) => {
    const p = (y * width + x) * 4;
    if (data[p + 3] < 224) return;
    rgbToLabInto(data[p], data[p + 1], data[p + 2], tmp, 0);
    labs.push(tmp[0], tmp[1], tmp[2]);
  };
  for (let y = 0; y < height; y += 1) {
    if (y < band || y >= height - band) {
      for (let x = 0; x < width; x += 1) addSample(x, y);
    } else {
      for (let x = 0; x < band; x += 1) addSample(x, y);
      for (let x = width - band; x < width; x += 1) addSample(x, y);
    }
  }
  const m = labs.length / 3;
  if (m < Math.max(8, (width + height) * 0.5)) return UNKNOWN;

  // 6 单位 Lab 网格直方图，再按近似度合并成最多 6 个参考色。
  const bins = new Map<number, { count: number; l: number; a: number; b: number }>();
  for (let i = 0; i < m; i += 1) {
    const l = labs[i * 3];
    const a = labs[i * 3 + 1];
    const b = labs[i * 3 + 2];
    const key = (Math.max(0, Math.min(31, Math.floor(l / 6))) << 12)
      | (Math.max(0, Math.min(63, Math.floor((a + 128) / 6))) << 6)
      | Math.max(0, Math.min(63, Math.floor((b + 128) / 6)));
    const bin = bins.get(key);
    if (bin) {
      bin.count += 1;
      bin.l += l;
      bin.a += a;
      bin.b += b;
    } else {
      bins.set(key, { count: 1, l, a, b });
    }
  }
  const sorted = [...bins.values()].sort((x, y) => y.count - x.count);
  const merged: { count: number; l: number; a: number; b: number }[] = [];
  for (const bin of sorted) {
    const mean = [bin.l / bin.count, bin.a / bin.count, bin.b / bin.count];
    let target = -1;
    for (let k = 0; k < merged.length; k += 1) {
      const c = merged[k];
      const dl = c.l / c.count - mean[0];
      const da = c.a / c.count - mean[1];
      const db = c.b / c.count - mean[2];
      if (dl * dl + da * da + db * db <= 100) {
        target = k;
        break;
      }
    }
    if (target >= 0) {
      const c = merged[target];
      c.count += bin.count;
      c.l += bin.l;
      c.a += bin.a;
      c.b += bin.b;
    } else if (merged.length < 8) {
      merged.push({ ...bin });
    }
  }
  merged.sort((x, y) => y.count - x.count);
  const minWeight = relaxed ? 0.03 : 0.06;
  // 次要参考色必须"像渐变的延伸"（与已接受的参考色 ΔE ≤ 30），或占边缘 30% 以上（双色背景）；
  // 否则只是贴边主体的颜色（如帽子顶到画面边缘），不能当成背景。
  const centers: number[][] = [];
  for (let index = 0; index < merged.length && centers.length < (relaxed ? 3 : 6); index += 1) {
    const c = merged[index];
    const mean = [c.l / c.count, c.a / c.count, c.b / c.count];
    if (index > 0) {
      const weight = c.count / m;
      if (weight < minWeight) continue;
      let nearestAccepted = Infinity;
      for (const accepted of centers) {
        nearestAccepted = Math.min(nearestAccepted, Math.hypot(accepted[0] - mean[0], accepted[1] - mean[1], accepted[2] - mean[2]));
      }
      if (weight < 0.3 && nearestAccepted > 30) continue;
    }
    centers.push(mean);
  }
  if (centers.length === 0) return UNKNOWN;

  const nearest = (l: number, a: number, b: number): { index: number; dist: number } => {
    let best = Infinity;
    let index = -1;
    for (let k = 0; k < centers.length; k += 1) {
      const dl = centers[k][0] - l;
      const da = centers[k][1] - a;
      const db = centers[k][2] - b;
      const d2 = dl * dl + da * da + db * db;
      if (d2 < best) {
        best = d2;
        index = k;
      }
    }
    return { index, dist: Math.sqrt(best) };
  };

  // 覆盖率与噪声
  const COVER = 14;
  let covered = 0;
  const hist = new Uint32Array(COVER * 2 + 1);
  for (let i = 0; i < m; i += 1) {
    const { dist } = nearest(labs[i * 3], labs[i * 3 + 1], labs[i * 3 + 2]);
    if (dist <= COVER) {
      covered += 1;
      hist[Math.floor(dist * 2)] += 1;
    }
  }
  const coverage = covered / m;
  let noise = 0;
  if (covered > 0) {
    let acc = 0;
    for (let k = 0; k < hist.length; k += 1) {
      acc += hist[k];
      if (acc >= covered * 0.9) {
        noise = k / 2;
        break;
      }
    }
  }

  // 空间连贯性：沿最外一圈走一遍，颜色标签来回跳变太多说明是花纹/杂乱背景（如棋盘格），不是纯色/渐变。
  let switches = 0;
  let ringCount = 0;
  let previous = -3;
  const visit = (x: number, y: number) => {
    const p = (y * width + x) * 4;
    if (data[p + 3] < 224) return;
    rgbToLabInto(data[p], data[p + 1], data[p + 2], tmp, 0);
    const { index, dist } = nearest(tmp[0], tmp[1], tmp[2]);
    const label = dist <= COVER ? index : -1;
    ringCount += 1;
    if (previous !== -3 && label !== previous) switches += 1;
    previous = label;
  };
  for (let x = 0; x < width; x += 1) visit(x, 0);
  for (let y = 1; y < height; y += 1) visit(width - 1, y);
  for (let x = width - 2; x >= 0; x -= 1) visit(x, height - 1);
  for (let y = height - 2; y >= 1; y -= 1) visit(0, y);
  const switchRatio = ringCount > 0 ? switches / ringCount : 1;

  const main = centers[0];
  const chromatic = Math.hypot(main[1], main[2]) >= 20;
  const busy = coverage < 0.6 || switchRatio > 0.2;
  let kind: BackgroundKind;
  if (busy) {
    kind = "busy";
  } else if (centers.length === 1) {
    kind = "plain";
  } else if (centers.length === 2) {
    const dl = centers[0][0] - centers[1][0];
    const da = centers[0][1] - centers[1][1];
    const db = centers[0][2] - centers[1][2];
    kind = Math.sqrt(dl * dl + da * da + db * db) > 24 ? "two-tone" : "gradient";
  } else {
    kind = "gradient";
  }
  return {
    kind,
    centers,
    coverage,
    noise,
    chromatic,
    usable: relaxed ? coverage >= 0.2 : !busy
  };
}

export function toleranceFor(analysis: BackgroundAnalysis, strength: MattingStrength): number {
  const base = PROFILES[strength].base;
  return Math.max(base, Math.min(36, base + analysis.noise * 1.6));
}

// ---------- 主流程 ----------

export type MattingOptions = {
  strength?: MattingStrength;
  edits?: MattingEdits;
  analysis?: BackgroundAnalysis;
  // 允许在背景不够干净时也强行处理（AI 模型失败后的兜底）。
  relaxed?: boolean;
};

export function matteBackground(source: PixelSource, options: MattingOptions = {}): MattingOutput {
  const strength = options.strength ?? DEFAULT_STRENGTH;
  const profile = PROFILES[strength];
  const analysis = options.analysis ?? analyzeBackground(source, { relaxed: options.relaxed });
  const { width, height } = source;
  const n = width * height;
  if (analysis.centers.length === 0 || n === 0) {
    return { source, analysis, removedRatio: 0, reliable: false };
  }

  const data = source.data;
  const lab = computeLab(source);
  const tol = toleranceFor(analysis, strength);
  const tol2 = tol * tol;
  const k = analysis.centers.length;
  const cs = new Float32Array(k * 3);
  for (let c = 0; c < k; c += 1) cs.set(analysis.centers[c], c * 3);

  const dist2 = (i: number): number => {
    const l = lab[i * 3];
    const a = lab[i * 3 + 1];
    const b = lab[i * 3 + 2];
    let best = Infinity;
    for (let c = 0; c < k; c += 1) {
      const dl = cs[c * 3] - l;
      const da = cs[c * 3 + 1] - a;
      const db = cs[c * 3 + 2] - b;
      const d = dl * dl + da * da + db * db;
      if (d < best) best = d;
    }
    return best;
  };

  const bg = new Uint8Array(n);
  const prot = new Uint8Array(n);
  const q = new Int32Array(n);
  const short = Math.min(width, height);

  // 0) 用户点选「保留」：该点周围同色连通区域受保护，不会被当成背景。
  for (const point of options.edits?.keep ?? []) {
    growRegion(lab, width, height, point, 14, Math.max(2, Math.round(short * 0.08)), q, (i) => { prot[i] = 1; });
  }

  // 1) 从四边出发，对与背景参考色相近的像素做 8 邻域泛洪。
  let head = 0;
  let tail = 0;
  const bgLike = (i: number): boolean => !prot[i] && (data[i * 4 + 3] < 16 || dist2(i) <= tol2);
  const seed = (i: number) => {
    if (!bg[i] && bgLike(i)) {
      bg[i] = 1;
      q[tail] = i;
      tail += 1;
    }
  };
  for (let x = 0; x < width; x += 1) {
    seed(x);
    seed((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    seed(y * width);
    seed(y * width + width - 1);
  }
  while (head < tail) {
    const i = q[head];
    head += 1;
    const x = i % width;
    const y = (i - x) / width;
    for (let dy = -1; dy <= 1; dy += 1) {
      const ny = y + dy;
      if (ny < 0 || ny >= height) continue;
      for (let dx = -1; dx <= 1; dx += 1) {
        const nx = x + dx;
        if (nx < 0 || nx >= width || (dx === 0 && dy === 0)) continue;
        seed(ny * width + nx);
      }
    }
  }

  // 2) 柔和投影：与背景同色相、只是更暗且平滑渐变的像素，从背景向外 4 邻域扩展。
  if (profile.shadowDepth > 0) {
    markSoftShadows(lab, data, bg, prot, width, height, cs, k, profile.shadowDepth, q);
  }

  // 3) 封闭背景洞（手臂与身体之间的缝隙等）。
  markEnclosedHoles(data, bg, prot, width, height, dist2, tol, analysis.chromatic, profile, q);

  // 4) 抗锯齿边缘/光晕：向内剥离若干圈接近背景色的边缘像素。
  const fringeTol = Math.min(tol * 1.9, tol + 14);
  stripFringe(data, bg, prot, width, height, dist2, fringeTol * fringeTol, profile.fringePasses, q);

  // 5) 用户点选「去除」：把点击处同色连通区域当作背景。
  for (const point of options.edits?.remove ?? []) {
    growRegion(lab, width, height, point, 14, Math.max(2, Math.round(short * 0.25)), q, (i) => {
      if (!prot[i]) bg[i] = 1;
    });
  }

  // 6) 清理碎点和小岛，只留主体连通域。
  removeSpecks(data, bg, prot, width, height, profile.speckRatio, q);

  const out = new Uint8ClampedArray(data);
  let removed = 0;
  for (let i = 0; i < n; i += 1) {
    if (bg[i]) {
      const p = i * 4;
      out[p] = 0;
      out[p + 1] = 0;
      out[p + 2] = 0;
      out[p + 3] = 0;
      removed += 1;
    }
  }
  const removedRatio = removed / n;
  return {
    source: { width, height, data: out },
    analysis,
    removedRatio,
    reliable: removedRatio >= 0.002 && removedRatio <= 0.97
  };
}

// 点选区域生长：从点出发，4 邻域，颜色与种子点相差 ≤ tol，且限制在半径 radius 的方框内。
function growRegion(
  lab: Float32Array,
  width: number,
  height: number,
  point: MattingPoint,
  tol: number,
  radius: number,
  queue: Int32Array,
  mark: (index: number) => void
): void {
  const sx = Math.round(point.x);
  const sy = Math.round(point.y);
  if (!(sx >= 0 && sx < width && sy >= 0 && sy < height)) return;
  const start = sy * width + sx;
  const sl = lab[start * 3];
  const sa = lab[start * 3 + 1];
  const sb = lab[start * 3 + 2];
  const tol2 = tol * tol;
  const seen = new Set<number>();
  let head = 0;
  let tail = 0;
  queue[tail] = start;
  tail += 1;
  seen.add(start);
  while (head < tail) {
    const i = queue[head];
    head += 1;
    mark(i);
    const x = i % width;
    const y = (i - x) / width;
    for (let d = 0; d < 4; d += 1) {
      const nx = x + (d === 0 ? -1 : d === 1 ? 1 : 0);
      const ny = y + (d === 2 ? -1 : d === 3 ? 1 : 0);
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      if (Math.abs(nx - sx) > radius || Math.abs(ny - sy) > radius) continue;
      const j = ny * width + nx;
      if (seen.has(j)) continue;
      const dl = lab[j * 3] - sl;
      const da = lab[j * 3 + 1] - sa;
      const db = lab[j * 3 + 2] - sb;
      if (dl * dl + da * da + db * db <= tol2) {
        seen.add(j);
        queue[tail] = j;
        tail += 1;
      }
    }
  }
}

function markSoftShadows(
  lab: Float32Array,
  data: Uint8ClampedArray,
  bg: Uint8Array,
  prot: Uint8Array,
  width: number,
  height: number,
  cs: Float32Array,
  k: number,
  depth: number,
  queue: Int32Array
): void {
  const n = width * height;
  let tail = 0;
  for (let i = 0; i < n; i += 1) {
    if (bg[i]) {
      queue[tail] = i;
      tail += 1;
    }
  }
  const initial = tail;
  let head = 0;

  // 平滑：只和"非背景"邻居比较亮度（背景边界本来就是渐变到背景）；允许最多一个突变邻居（贴着主体的那一侧）。
  const smooth = (i: number, x: number, y: number): boolean => {
    const l = lab[i * 3];
    let jumps = 0;
    if (x > 0 && !bg[i - 1] && Math.abs(lab[(i - 1) * 3] - l) > 4) jumps += 1;
    if (x < width - 1 && !bg[i + 1] && Math.abs(lab[(i + 1) * 3] - l) > 4) jumps += 1;
    if (y > 0 && !bg[i - width] && Math.abs(lab[(i - width) * 3] - l) > 4) jumps += 1;
    if (y < height - 1 && !bg[i + width] && Math.abs(lab[(i + width) * 3] - l) > 4) jumps += 1;
    return jumps <= 1;
  };
  const isShadow = (j: number, x: number, y: number): boolean => {
    if (bg[j] || prot[j] || data[j * 4 + 3] < 16) return false;
    const l = lab[j * 3];
    const a = lab[j * 3 + 1];
    const b = lab[j * 3 + 2];
    let bestChroma = Infinity;
    let bestDl = 0;
    for (let c = 0; c < k; c += 1) {
      const da = cs[c * 3 + 1] - a;
      const db = cs[c * 3 + 2] - b;
      const d = Math.sqrt(da * da + db * db);
      if (d < bestChroma) {
        bestChroma = d;
        bestDl = l - cs[c * 3];
      }
    }
    if (bestDl >= -1 || bestDl < -depth) return false;
    if (bestChroma > 5 + 0.2 * -bestDl) return false;
    return smooth(j, x, y);
  };

  while (head < tail) {
    const i = queue[head];
    head += 1;
    const x = i % width;
    const y = (i - x) / width;
    for (let d = 0; d < 4; d += 1) {
      const nx = x + (d === 0 ? -1 : d === 1 ? 1 : 0);
      const ny = y + (d === 2 ? -1 : d === 3 ? 1 : 0);
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const j = ny * width + nx;
      if (isShadow(j, nx, ny)) {
        bg[j] = 1;
        queue[tail] = j;
        tail += 1;
      }
    }
  }
  // 阴影区域超过画面 30% 多半是把深色主体吃掉了，整体撤销。
  if (tail - initial > n * 0.3) {
    for (let t = initial; t < tail; t += 1) bg[queue[t]] = 0;
  }
}

function markEnclosedHoles(
  data: Uint8ClampedArray,
  bg: Uint8Array,
  prot: Uint8Array,
  width: number,
  height: number,
  dist2: (index: number) => number,
  tol: number,
  chromatic: boolean,
  profile: StrengthProfile,
  queue: Int32Array
): void {
  if (!chromatic && !profile.holesOnNeutral) return;
  const n = width * height;
  const strict = tol * 0.6;
  const strict2 = strict * strict;
  const minSize = Math.max(3, Math.floor(n * 0.00005));
  const erodeRadius = Math.max(1, Math.min(6, Math.round(Math.min(width, height) * 0.015)));
  const visited = new Uint8Array(n);
  const match = (i: number) => !bg[i] && !prot[i] && data[i * 4 + 3] >= 16 && dist2(i) <= strict2;

  for (let start = 0; start < n; start += 1) {
    if (visited[start]) continue;
    if (!match(start)) {
      visited[start] = 1;
      continue;
    }
    let head = 0;
    let tail = 0;
    queue[tail] = start;
    tail += 1;
    visited[start] = 1;
    let minX = width;
    let maxX = 0;
    let minY = height;
    let maxY = 0;
    while (head < tail) {
      const i = queue[head];
      head += 1;
      const x = i % width;
      const y = (i - x) / width;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const j = ny * width + nx;
          if (!visited[j] && match(j)) {
            visited[j] = 1;
            queue[tail] = j;
            tail += 1;
          }
        }
      }
    }
    if (tail < minSize) continue;
    // 有色背景：主体几乎不会与背景同色，整块移除。
    // 中性（白/灰）背景：只移除"细长缝隙"，厚实的块（眼白、白衣服）保留；强力档才全部移除。
    let remove = chromatic || profile.removeAllHoles;
    if (!remove) {
      remove = !survivesErosion(queue, tail, width, minX, maxX, minY, maxY, erodeRadius);
    }
    if (remove) {
      for (let t = 0; t < tail; t += 1) bg[queue[t]] = 1;
    }
  }
}

function survivesErosion(
  pixels: Int32Array,
  count: number,
  width: number,
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  radius: number
): boolean {
  const bw = maxX - minX + 3;
  const bh = maxY - minY + 3;
  let mask = new Uint8Array(bw * bh);
  for (let t = 0; t < count; t += 1) {
    const i = pixels[t];
    const x = i % width;
    const y = (i - x) / width;
    mask[(y - minY + 1) * bw + (x - minX + 1)] = 1;
  }
  for (let pass = 0; pass < radius; pass += 1) {
    const next = new Uint8Array(bw * bh);
    let any = false;
    for (let y = 1; y < bh - 1; y += 1) {
      for (let x = 1; x < bw - 1; x += 1) {
        const p = y * bw + x;
        if (mask[p] && mask[p - 1] && mask[p + 1] && mask[p - bw] && mask[p + bw]) {
          next[p] = 1;
          any = true;
        }
      }
    }
    if (!any) return false;
    mask = next;
  }
  return true;
}

function stripFringe(
  data: Uint8ClampedArray,
  bg: Uint8Array,
  prot: Uint8Array,
  width: number,
  height: number,
  dist2: (index: number) => number,
  fringe2: number,
  passes: number,
  queue: Int32Array
): void {
  const n = width * height;
  for (let pass = 0; pass < passes; pass += 1) {
    let count = 0;
    for (let i = 0; i < n; i += 1) {
      if (bg[i] || prot[i]) continue;
      const x = i % width;
      const touches =
        (x > 0 && bg[i - 1] === 1) ||
        (x < width - 1 && bg[i + 1] === 1) ||
        (i >= width && bg[i - width] === 1) ||
        (i < n - width && bg[i + width] === 1);
      if (!touches) continue;
      if (data[i * 4 + 3] < 200 || dist2(i) <= fringe2) {
        queue[count] = i;
        count += 1;
      }
    }
    if (count === 0) break;
    for (let t = 0; t < count; t += 1) bg[queue[t]] = 1;
  }
}

function removeSpecks(
  data: Uint8ClampedArray,
  bg: Uint8Array,
  prot: Uint8Array,
  width: number,
  height: number,
  ratio: number,
  queue: Int32Array
): void {
  const n = width * height;
  const isFg = (i: number) => !bg[i] && data[i * 4 + 3] >= 16;

  const flood = (start: number, visited: Uint8Array): { size: number; protectedHit: boolean } => {
    let head = 0;
    let tail = 0;
    queue[tail] = start;
    tail += 1;
    visited[start] = 1;
    let protectedHit = false;
    while (head < tail) {
      const i = queue[head];
      head += 1;
      if (prot[i]) protectedHit = true;
      const x = i % width;
      const y = (i - x) / width;
      for (let dy = -1; dy <= 1; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const j = ny * width + nx;
          if (!visited[j] && isFg(j)) {
            visited[j] = 1;
            queue[tail] = j;
            tail += 1;
          }
        }
      }
    }
    return { size: tail, protectedHit };
  };

  let largest = 0;
  const first = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    if (!first[i] && isFg(i)) {
      const { size } = flood(i, first);
      if (size > largest) largest = size;
    }
  }
  if (largest === 0) return;
  const minimum = Math.max(2, Math.floor(largest * ratio));
  const second = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    if (!second[i] && isFg(i)) {
      const { size, protectedHit } = flood(i, second);
      if (size < minimum && !protectedHit) {
        for (let t = 0; t < size; t += 1) bg[queue[t]] = 1;
      }
    }
  }
}

// ---------- 预览与说明 ----------

export function downscaleSource(source: PixelSource, maxSide: number): { source: PixelSource; scale: number } {
  const longest = Math.max(source.width, source.height);
  if (longest <= maxSide) return { source, scale: 1 };
  const scale = maxSide / longest;
  const width = Math.max(2, Math.round(source.width * scale));
  const height = Math.max(2, Math.round(source.height * scale));
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sy = Math.min(source.height - 1, Math.floor(((y + 0.5) / height) * source.height));
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(source.width - 1, Math.floor(((x + 0.5) / width) * source.width));
      const from = (sy * source.width + sx) * 4;
      data.set(source.data.subarray(from, from + 4), (y * width + x) * 4);
    }
  }
  return { source: { width, height, data }, scale: width / source.width };
}

export function scaleEdits(edits: MattingEdits, scale: number): MattingEdits {
  const map = (p: MattingPoint) => ({ x: p.x * scale, y: p.y * scale });
  return { keep: edits.keep.map(map), remove: edits.remove.map(map) };
}

// 裁剪后把点选坐标平移到裁剪图里，落在外面的点丢弃。
export function translateEdits(edits: MattingEdits, origin: { x: number; y: number }, size: { width: number; height: number }): MattingEdits {
  const map = (p: MattingPoint) => ({ x: p.x - origin.x, y: p.y - origin.y });
  const inside = (p: MattingPoint) => p.x >= 0 && p.y >= 0 && p.x < size.width && p.y < size.height;
  return { keep: edits.keep.map(map).filter(inside), remove: edits.remove.map(map).filter(inside) };
}

export type MattingPreview = { source: PixelSource; analysis: BackgroundAnalysis; output: MattingOutput | null; scale: number };

// 对话框实时预览：缩小后跑同一套算法。busy 背景（需要 AI 模型）不在预览里跑。
export function buildMattingPreview(
  source: PixelSource,
  strength: MattingStrength,
  edits: MattingEdits,
  maxSide = 360
): MattingPreview {
  const { source: small, scale } = downscaleSource(source, maxSide);
  const analysis = analyzeBackground(small);
  if (!analysis.usable) return { source: small, analysis, output: null, scale };
  const output = matteBackground(small, { strength, edits: scaleEdits(edits, scale), analysis });
  return { source: small, analysis, output: output.reliable ? output : null, scale };
}

export function describeBackground(analysis: BackgroundAnalysis): string {
  switch (analysis.kind) {
    case "plain":
      return analysis.chromatic ? "背景是纯色（有颜色）" : "背景接近纯白/纯灰";
    case "two-tone":
      return "背景由两种颜色组成";
    case "gradient":
      return "背景有渐变或轻微阴影";
    case "busy":
      return "背景比较杂（照片、花纹或多种颜色）";
    default:
      return "没能识别出背景";
  }
}

export function localMethodLine(analysis: BackgroundAnalysis): string {
  return `${describeBackground(analysis)}，已用本地快速方式去除，无需下载模型。`;
}
