// 库存变动提示：返回“色号 → 变动序号”，序号变了说明这个色号刚变过，豆盒格据此闪一下。
// 首次载入、以及筛选变化造成的“新出现的格子”都不闪，只有库存数量真的变了才闪。
import { useRef } from "react";
import type { Counts } from "../../lib/model";

export function useStockFlash(stock: Counts): Map<string, number> {
  const prev = useRef<Counts | null>(null);
  const tokens = useRef(new Map<string, number>());
  const last = prev.current;
  if (last && last !== stock) {
    for (const code of new Set([...Object.keys(stock), ...Object.keys(last)])) {
      if ((stock[code] ?? 0) !== (last[code] ?? 0)) tokens.current.set(code, (tokens.current.get(code) ?? 0) + 1);
    }
  }
  prev.current = stock;
  return tokens.current;
}
