// 入库价格：全部以“分”（整数）计算，避免浮点误差；纯函数，页面和测试共用。
// 数据模型里仍然存 unitPrice（元/颗），这里只负责把“花了多少钱”换算成它。

/** 元 → 分（四舍五入到分）。 */
export function toFen(yuan: number): number {
  return Math.round(yuan * 100 + (yuan >= 0 ? 1e-9 : -1e-9));
}

/** 输入框文本 → 分；空、非数字、≤0 都当作“没填”（undefined）。 */
export function parseFen(text: string | number | undefined | null): number | undefined {
  if (text === undefined || text === null || String(text).trim() === "") return undefined;
  const n = Number(text);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const fen = toFen(n);
  return fen > 0 ? fen : undefined;
}

export function yuanText(fen: number): string {
  const sign = fen < 0 ? "−" : "";
  const a = Math.abs(fen);
  return `${sign}¥${Math.floor(a / 100)}.${String(a % 100).padStart(2, "0")}`;
}

/** 花了 fen 分买 qty 颗 → 元/颗（不做舍入，保证 单价 × 数量 回到原金额）。 */
export function unitFromFen(fen: number, qty: number): number | undefined {
  return fen > 0 && qty > 0 ? fen / 100 / qty : undefined;
}

/** 每千颗多少元的说明文字，例如 “约 ¥1.05/千颗”。 */
export function perThousandText(fen: number, qty: number): string | undefined {
  if (!(fen > 0 && qty > 0)) return undefined;
  const yuanPerThousand = (fen / qty) * 10; // 分/颗 × 1000 颗 ÷ 100 = 元/千颗
  return `约 ¥${(Math.round(yuanPerThousand * 100) / 100).toFixed(2)}/千颗`;
}

export type PriceRow = { qty: number; /** 这一行自己的金额（分）；没填则 undefined */ fen?: number };

export type Allocation = {
  /** 每行最终金额（分）；0 = 这一行没有价格 */
  fen: number[];
  /** 各行自填金额之和 */
  ownFen: number;
  /** 订单总价（分），没填为 0 */
  totalFen: number;
  /** 总价 − 自填之和（可为负）；没填总价时为 0 */
  remainderFen: number;
  /** 被均摊到“没自填金额的行”的钱 */
  sharedFen: number;
  /**
   * none     没有任何价格
   * ok       金额分配完整
   * over     自填金额超过了总价：没自填的行不记价格，提示用户
   * leftover 总价大于自填之和，但每一行都自填了，多出来的钱没有地方可分，不记入（提示用户）
   */
  status: "none" | "ok" | "over" | "leftover";
  /** over 时超出的分数 / leftover 时没分到的分数（均为正数） */
  gapFen: number;
};

/**
 * 逐行金额 + 可选订单总价的分配规则：
 * 1. 自填金额的行原样保留；
 * 2. 填了总价时，余额 = 总价 − 自填之和，按颗数比例分给“没自填金额”的行（最大余数法，分摊后加起来恰好等于余额）；
 * 3. 余额为负（over）：没自填的行不记价格，界面给出明确提示，不会偷偷改任何一行；
 * 4. 每行都有自填金额而总价更大（leftover）：多出的钱不记入，界面提示。
 * 数量 ≤ 0 的行被忽略（金额 0）。
 */
export function allocatePrices(rows: PriceRow[], totalFen?: number): Allocation {
  const total = totalFen && totalFen > 0 ? totalFen : 0;
  const fen = rows.map((r) => (r.qty > 0 && r.fen && r.fen > 0 ? r.fen : 0));
  const ownFen = fen.reduce((a, b) => a + b, 0);
  const free = rows.map((r, i) => (r.qty > 0 && fen[i] === 0 ? i : -1)).filter((i) => i >= 0);
  const freeQty = free.reduce((a, i) => a + rows[i].qty, 0);
  const remainderFen = total ? total - ownFen : 0;
  let sharedFen = 0;
  let status: Allocation["status"] = ownFen > 0 || total > 0 ? "ok" : "none";
  let gapFen = 0;
  if (total && remainderFen < 0) {
    status = "over";
    gapFen = -remainderFen;
  } else if (total && remainderFen > 0) {
    if (free.length) {
      sharedFen = remainderFen;
      const parts = free.map((i) => {
        const exact = remainderFen * rows[i].qty;
        return { i, base: Math.floor(exact / freeQty), rest: exact % freeQty };
      });
      let left = remainderFen - parts.reduce((a, p) => a + p.base, 0);
      for (const p of [...parts].sort((a, b) => b.rest - a.rest || a.i - b.i)) {
        if (left <= 0) break;
        p.base += 1;
        left -= 1;
      }
      for (const p of parts) fen[p.i] = p.base;
    } else {
      status = "leftover";
      gapFen = remainderFen;
    }
  }
  return { fen, ownFen, totalFen: total, remainderFen, sharedFen, status, gapFen };
}
