// 图纸识别（“豆探”助手）对外接口。UI 只依赖这里的类型和 assistant.ts 的 analyzePattern()。
import type { PixelSource } from "@engine/types";
import type { EnhanceResult, EnhanceSummary } from "../enhance";

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
  /** 细线看不见、靠“每 5 格一条粗线”结构确认的低清网格（本身就是规整网格的证据） */
  faint?: boolean;
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
  /** 内部颜色足够纯（平涂）的格子占比：真图纸 ≥ 0.8，插画 / 照片很低 */
  flatFrac?: number;
  /** 图纸是否在每个有色格里印了色号（≥ 一半以上的颜色簇里，格内都有明显的文字墨迹） */
  inkChart?: boolean;
  /** 每格是否有文字墨迹（行优先，cols×rows），仅供格内色号 OCR 使用 */
  cellInk?: Uint8Array;
  /** 每格所属颜色簇编号（-1 = 无法取色），与 clusters 的 id 对应 */
  cellCluster?: Int32Array;
  /** 智能去背景：与网格边缘 4 邻接相连的背景格（cols×rows，1 = 已去掉）；被轮廓围住的浅色区域不算 */
  backgroundMask?: Uint8Array;
  /** 带色号的图纸上，边缘背景格里也印着字的比例（画像素把 H2 印在背景格里时接近 1） */
  backgroundInkFrac?: number;
  /** 被去掉的背景格个数 */
  backgroundCells?: number;
  /** 核对后判定背景其实是豆子（如整片 H2）时：已把背景格并入该色号（此时 backgroundMask 全 0） */
  backgroundAssigned?: { code: string; cells: number };
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

export type LegendItem = { code: string; count: number; source: string; /** 数量的备选读法（OCR 多次识别结果不一致时，按票数降序） */ alts?: number[]; /** 数量被几遍识别一致读到（≥ 2 且没有备选 = 很可信） */ votes?: number };

export type LegendReading = {
  items: LegendItem[];
  counts: Counts;
  /** 图上写的总数（如“总计 2140”），读不到为 null */
  statedTotal: number | null;
  /** OCR 原文（调试/展示用，截断） */
  rawText: string;
  /** 图例色块实际渲染色（色号 → RGB），读得到时才有；用于校准格子颜色匹配 */
  colors?: Record<string, { r: number; g: number; b: number }>;
  /** 图例里所有色块（含没读出数量的）：色号 + 色块实际渲染色，构成闭集色板；count 为 null 表示数量没读到 */
  palette?: Array<{ code: string; rgb: { r: number; g: number; b: number }; count: number | null; /** 色号是按颜色最近邻猜的（文字没读出） */ guessed?: boolean }>;
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
  /** 是否读取抬头（尺寸 / 色数 / 总数，默认 true；ocr:false 时一并关闭） */
  headerOcr?: boolean;
  /** 是否读取图例（默认 true；ocr:false 时一并关闭） */
  legendOcr?: boolean;
  /** 手动覆盖列数 / 行数（自动检测错时用户可改） */
  forceCols?: number | null;
  forceRows?: number | null;
  /** 同一张图的更高分辨率副本（坐标按 ocrSource.width / src.width 缩放），图例 OCR 用它更清楚 */
  ocrSource?: PixelSource;
  /** 高清化：auto（默认，图太糊 / 太小时自动放大后再读颜色和文字）、off、force */
  enhance?: "auto" | "off" | "force";
  /** 界面已经算好的高清化结果（坐标按 image.width / src.width 缩放），传了就不再重复计算 */
  enhanced?: EnhanceResult | null;
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
  cellCodeStats?: { read: number; clusters: number; overrides: number; /** 簇平均字形读出的簇数 */ glyph?: number; /** 按颜色并入已读簇的碎簇数 */ merged?: number; /** 格内读出的色号（去重） */ names?: string[] };
  /** 与下方图例用量逐色核对：legend 为 null = 图上没有该色数量 */
  checks?: Array<{
    code: string; legend: number | null; read: number; status: "ok" | "short" | "over" | "no-legend";
    /** 最终采用的数量来自哪里：图例 / 网格（含格内色号）/ 两者一致 / 按总数挑选 */
    source?: "legend" | "grid" | "both" | "total-fit";
    /** 0–1：多个来源一致、且合计与抬头总数吻合时高 */
    confidence?: number;
    /** 来源互相矛盾、无法确定的色号（界面可提示核对） */
    uncertain?: boolean;
  }>;
  /** 图例与网格逐色比对（两者都有时） */
  diff: Array<{ code: string; legend: number; grid: number }>;
  source: { width: number; height: number };
  /** 这张图像不像拼豆图纸（普通插画/照片）时为 false，界面会建议改用“生成图纸” */
  isChart?: boolean;
  /** isChart 为 false 时的简短原因（中文） */
  notChartReason?: string;
  /** 图上标注的信息（如“尺寸:55x61 · 9 色 · 1806 颗”），读不到的字段为 null */
  header?: { cols: number | null; rows: number | null; colors: number | null; total: number | null };
  /** 色号体系可能不是 MARD（图例色块颜色与 MARD 色卡大面积不符）时的提示 */
  paletteWarning?: string;
  /** 识别前是否做了高清化、怎么做的 */
  enhance?: EnhanceSummary;
};

export type { PixelSource };
