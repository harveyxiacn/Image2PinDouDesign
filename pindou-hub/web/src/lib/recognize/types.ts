// 图纸识别（“豆探”助手）对外接口。UI 只依赖这里的类型和 assistant.ts 的 analyzePattern()。
import type { PixelSource } from "@engine/types";

export type Counts = Record<string, number>;

export type Rect = { x: number; y: number; width: number; height: number };

/** 网格检测结果（像素坐标基于传入的 PixelSource） */
export type GridDetection = {
  /** 第一条竖线 / 横线的位置（像素，可为小数） */
  x0: number;
  y0: number;
  pitchX: number;
  pitchY: number;
  cols: number;
  rows: number;
  /** 0–1，越高越像规则网格 */
  score: number;
};

export type CellColorStat = {
  code: string;
  count: number;
  /** 渲染色与色卡色的 CIEDE2000 平均色差，越小越可信 */
  deltaE: number;
  /** 图纸上实际采到的平均颜色 #rrggbb */
  sampleHex: string;
};

export type GridReading = {
  grid: GridDetection;
  matrix: Array<Array<string | null>>;
  counts: Counts;
  colors: CellColorStat[];
  emptyCells: number;
  /** 背景色（被视为空格的颜色）#rrggbb，没有则 null */
  backgroundHex: string | null;
  /** 图纸是否在每个有色格里印了色号（≥ 一半以上的颜色簇里，格内都有明显的文字墨迹） */
  inkChart?: boolean;
  /** 每格是否有文字墨迹（行优先，cols×rows），仅供格内色号 OCR 使用 */
  cellInk?: Uint8Array;
  /** 每格所属颜色簇编号（-1 = 无法取色），与 clusters 的 id 对应 */
  cellCluster?: Int32Array;
  /** 颜色簇（同色格子的集合）：用于挑选代表格做格内色号 OCR */
  clusters?: ColorCluster[];
};

export type ColorCluster = {
  id: number;
  count: number;
  rgb: { r: number; g: number; b: number };
  /** 颜色匹配得到的色号（未被格内色号覆盖前） */
  colorCode: string;
  /** 最终采用的色号（格内色号投票覆盖后）；空格簇为 null */
  code: string | null;
  /** 被判定为背景 / 空格 */
  empty: boolean;
  /** 带文字墨迹的格子数 */
  inkCells: number;
  /** 属于该簇的格子序号（row*cols+col） */
  cells: number[];
  /** 格内色号投票是否改写了颜色匹配结果 */
  overridden?: boolean;
};

export type LegendItem = { code: string; count: number; source: string };

export type LegendReading = {
  items: LegendItem[];
  counts: Counts;
  /** 图上写的总数（如“总计 2140”），读不到为 null */
  statedTotal: number | null;
  /** OCR 原文（调试/展示用，截断） */
  rawText: string;
  /** 图例色块实际渲染色（色号 → RGB），读得到时才有；用于校准格子颜色匹配 */
  colors?: Record<string, { r: number; g: number; b: number }>;
};

export type StepStatus = "ok" | "warn" | "fail" | "skip";
export type AssistantStep = { id: string; label: string; status: StepStatus; detail: string };

export type AnalyzeOptions = {
  /** 只在这块区域里找网格（用户框选），默认整图 */
  region?: Rect | null;
  /** 是否运行图例 OCR（较慢，约数秒） */
  ocr?: boolean;
  /** 与背景相同颜色的格子视为空格（不计数），默认 true */
  treatBackgroundAsEmpty?: boolean;
  /** 生成网格读数时允许的色号；默认用图例色号，没有图例则用全部 MARD 色 */
  allowedCodes?: string[] | null;
  /** 是否读取格内印的色号（默认 true；ocr:false 时一并关闭） */
  cellCodes?: boolean;
  /** 是否读取图例（默认 true；ocr:false 时一并关闭） */
  legendOcr?: boolean;
  /** 手动覆盖列数 / 行数（自动检测错时用户可改） */
  forceCols?: number | null;
  forceRows?: number | null;
  /** 同一张图的更高分辨率副本（坐标按 ocrSource.width / src.width 缩放），图例 OCR 用它更清楚 */
  ocrSource?: PixelSource;
  onProgress?: (step: AssistantStep) => void;
  signal?: AbortSignal;
};

export type AnalyzeResult = {
  steps: AssistantStep[];
  legend: LegendReading | null;
  grid: GridReading | null;
  /** 助手建议采用的最终用量 */
  counts: Counts;
  method: "legend" | "grid" | "legend+grid" | "none";
  /** 0–1 */
  confidence: number;
  /** 是否成功读到了格内色号并用来校正颜色匹配 */
  cellCodesRead?: boolean;
  /** 格内色号读取概况：读出的颜色数 / 颜色总数 / 校正数 */
  cellCodeStats?: { read: number; clusters: number; overrides: number };
  /** 图例与网格逐色比对（两者都有时） */
  diff: Array<{ code: string; legend: number; grid: number }>;
  source: { width: number; height: number };
};

export type { PixelSource };
