// 拼豆仓的数据模型。所有记录都带 updatedAt / deleted，便于局域网多设备“后写者胜”合并。

export type Counts = Record<string, number>;

export type PatternStatus = "idea" | "planned" | "making" | "done";
export type PatternKind = "recognized" | "generated" | "manual";
export type CountMethod = "legend" | "grid" | "legend+grid" | "ai" | "manual" | "generate";

export type Pattern = {
  id: string;
  name: string;
  kind: PatternKind;
  method: CountMethod;
  /** 原图（上传的图纸截图或照片），images 集合中的 id（= SHA-256） */
  imageId?: string;
  /** 渲染后的拼豆图纸 PNG，生成图纸才有 */
  previewId?: string;
  width?: number;
  height?: number;
  /** 每格色号（生成或网格识别得到时保存），null 表示空格 */
  matrix?: Array<Array<string | null>>;
  counts: Counts;
  /** 识别置信度 0–1；人工确认后置 1 */
  confidence?: number;
  status: PatternStatus;
  /** 计划做几份（采购清单按份数放大） */
  copies: number;
  tags: string[];
  notes: string;
  /** 已从库存扣减（完成时），避免重复扣 */
  consumed?: boolean;
  createdAt: number;
  updatedAt: number;
  deleted?: boolean;
};

export type TxnKind = "purchase" | "consume" | "adjust" | "stocktake";

/** 库存流水：库存 = 某色号所有流水 delta 之和。流水只追加，多设备合并不会互相覆盖。 */
export type Txn = {
  id: string;
  code: string;
  delta: number;
  kind: TxnKind;
  patternId?: string;
  /** 同一次入库/消耗的批次号，用于在记录里成组显示与整批撤销 */
  batchId?: string;
  /** 单价（元/颗），仅采购可填 */
  unitPrice?: number;
  note?: string;
  device?: string;
  at: number;
  updatedAt: number;
  deleted?: boolean;
};

export type ImageMeta = {
  id: string; // SHA-256 hex
  name: string;
  mime: string;
  width: number;
  height: number;
  bytes: number;
  role: "source" | "preview";
  createdAt: number;
  updatedAt: number;
  deleted?: boolean;
};

/** 全家共享的偏好（同步）。设备本身的连接信息在 DeviceSettings，不同步。 */
export type SharedPrefs = {
  id: "shared";
  lowStock: number;
  packSize: number;
  lossRate: number;
  kitId: string;
  /** 用户自定义的每个色号最低库存，覆盖 lowStock */
  minStock: Counts;
  updatedAt: number;
  deleted?: boolean;
};

export type DeviceSettings = {
  deviceId: string;
  deviceName: string;
  hubUrl: string;
  token: string;
  cursor: number;
  lastSyncAt: number;
  autoSync: boolean;
};

export const DEFAULT_PREFS: SharedPrefs = {
  id: "shared",
  lowStock: 200,
  packSize: 1000,
  lossRate: 0.05,
  kitId: "mard-221",
  minStock: {},
  updatedAt: 0
};

export type CollectionName = "patterns" | "txns" | "images" | "prefs";
export type RecordOf<C extends CollectionName> =
  C extends "patterns" ? Pattern : C extends "txns" ? Txn : C extends "images" ? ImageMeta : SharedPrefs;

export const STATUS_LABEL: Record<PatternStatus, string> = {
  idea: "收藏",
  planned: "计划做",
  making: "制作中",
  done: "已完成"
};

export const METHOD_LABEL: Record<CountMethod, string> = {
  legend: "读取图例",
  grid: "识别网格",
  "legend+grid": "图例+网格核对",
  ai: "本地视觉模型",
  manual: "手动录入",
  generate: "由图片生成"
};

export function uid(prefix = ""): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  const rand = Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 12);
  return `${prefix}${Date.now().toString(36)}${rand}`;
}

export function totalOf(counts: Counts): number {
  let sum = 0;
  for (const value of Object.values(counts)) sum += value > 0 ? value : 0;
  return sum;
}
