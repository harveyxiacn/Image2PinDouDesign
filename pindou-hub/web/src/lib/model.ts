// 拼豆仓的数据模型。所有记录都带 updatedAt / deleted，便于局域网多设备“后写者胜”合并。

import type { BuildState } from "./build";
import type { Order } from "./orders";
import type { Seller } from "./sellers";

export type Counts = Record<string, number>;

export type PatternStatus = "idea" | "planned" | "making" | "done";
export type PatternKind = "recognized" | "generated" | "manual";
export type CountMethod = "legend" | "grid" | "legend+grid" | "cell" | "ai" | "manual" | "generate";

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
  /** 每格色号（生成或网格识别得到时保存），null 表示空格。新记录改用 matrixRle 压缩存储。 */
  matrix?: Array<Array<string | null>>;
  /** 矩阵压缩（色号字典 + 游程编码），见 lib/matrix.ts；老记录仍可能有 matrix */
  matrixRle?: string;
  counts: Counts;
  /** 整体可信度 0–1；大幅手工修改后置 1（不等于“已核对”） */
  confidence?: number;
  /** 颜色匹配度 0–1：只反映格子颜色与色卡的吻合程度 */
  colorMatch?: number;
  /** 人工点过“已核对”的时间；空表示未核对。 */
  verifiedAt?: number;
  /** 识别时图例 / 图上标注的总颗数（保存时记下，快速核对用它和实际用量比；旧图纸没有）。 */
  statedTotal?: number;
  /** 保存时记录自动检查给出的疑点，便于之后回看。 */
  reviewReasons?: string[];
  /** 快速核对里标“有问题”时留的简短原因（同时给图纸加“待复查”标签）；标为没问题时清除。 */
  reviewNote?: string;
  status: PatternStatus;
  /** 计划拼几份（采购清单按份数放大） */
  copies: number;
  tags: string[];
  notes: string;
  /** 已从库存扣减（完成时），避免重复扣 */
  consumed?: boolean;
  /** 拼装模式的进度（随图纸同步），见 lib/build.ts */
  build?: BuildState;
  /** 完工记录：每完成一次一条（复制、重新打开后再完成都各记一条）；旧设备会忽略这个字段，见 lib/worklog.ts */
  works?: WorkEntry[];
  createdAt: number;
  updatedAt: number;
  deleted?: boolean;
};

/** 一次完工。at = 完成时间（毫秒）；photoId 是 images 集合里的成品照片（和图纸原图同一套存储与同步）。 */
export type WorkEntry = {
  id: string;
  at: number;
  /** 这条记录建立的时间（毫秒）；用来找出“这次完成”留下的那条。旧记录没有，从 id 里读。 */
  createdAt?: number;
  /** 完成时的份数，用来算颗数；旧记录没有则按图纸当前份数 */
  copies?: number;
  photoId?: string;
  note?: string;
  /** 1–5 星 */
  rating?: number;
  /** “给谁了”之类的自由标签 */
  tag?: string;
  /** 拼了多久（毫秒），拼装模式记录了才有 */
  durationMs?: number;
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
  /** 退回类流水（kind=adjust）指向被它冲回的那条扣库存流水 id；旧版本会忽略这个字段 */
  refundOf?: string;
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
  /** 512px WebP 缩略图的 blob id（= 缩略图 SHA-256）；空串表示小图无需缩略图；老记录没有，按需生成 */
  thumbId?: string;
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
  /** 1200 颗装的单价（元/包），采购、采购清单和补货预告共用；只有 1.26 / 1.5 两档，空表示 1.26 */
  price1200?: number;
  kitId: string;
  /** 用户自定义的每个色号最低库存，覆盖 lowStock */
  minStock: Counts;
  /** 用户自定义的每个色号包装规格（颗/包），覆盖 packSize */
  packSizes: Counts;
  /** 用户点过“录入现有库存”或“跳过”的时间；用来区分“未录入库存”和“库存真的为 0” */
  inventoryStartedAt?: number;
  /** 最近一次“复制采购清单/文本”时保存的下单快照；入库时可按它核对，随偏好同步 */
  lastOrder?: LastOrder;
  /** 在途订单列表（多张、可部分到货），见 lib/orders.ts；旧版 lastOrder 读取时折进这里。每张订单自带 updatedAt，合并按订单取新。 */
  orders?: Order[];
  /** 自定义卖家资料（内置默认卖家不存这里）；整条偏好后写者胜，见 lib/sellers.ts */
  sellers?: Seller[];
  /** 当前选中的卖家 id；空 = 内置默认卖家 */
  sellerId?: string;
  /** 隐藏内置默认卖家（至少还有一个自定义卖家时才生效） */
  sellerDefaultHidden?: boolean;
  /** 已删除卖家的墓碑（删除时间），按卖家合并时用，见 lib/prefsMerge.ts；过期清理 */
  sellersDeleted?: Array<{ id: string; at: number }>;
  updatedAt: number;
  deleted?: boolean;
};

/** 下单快照：复制采购文本那一刻，每个色号买了多少。 */
export type LastOrder = {
  at: number;
  items: Array<{ code: string; qty: number }>;
  planId?: string;
  cost?: number;
  /** 已按这份快照入过库的时间；有值就不再提示 */
  receivedAt?: number;
};

export type DeviceSettings = {
  deviceId: string;
  deviceName: string;
  hubUrl: string;
  token: string;
  cursor: number;
  lastSyncAt: number;
  autoSync: boolean;
  /** 与 Hub 对账用的标记（见 syncPlan.SyncMark）：Hub 最后一次确认“你已拿到序号 ≤ seq 的变更”时发的口令。老版本忽略。 */
  syncMark?: { seq: number; token: string };
};

export const DEFAULT_PREFS: SharedPrefs = {
  id: "shared",
  lowStock: 200,
  packSize: 1000,
  lossRate: 0.05,
  kitId: "mard-221",
  minStock: {},
  packSizes: {},
  updatedAt: 0
};

export type CollectionName = "patterns" | "txns" | "images" | "prefs";
export type RecordOf<C extends CollectionName> =
  C extends "patterns" ? Pattern : C extends "txns" ? Txn : C extends "images" ? ImageMeta : SharedPrefs;

export const STATUS_LABEL: Record<PatternStatus, string> = {
  idea: "收藏",
  planned: "计划拼",
  making: "制作中",
  done: "已完成"
};

export const METHOD_LABEL: Record<CountMethod, string> = {
  legend: "读取图例",
  grid: "识别网格",
  "legend+grid": "图例+网格核对",
  cell: "格内色号",
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
