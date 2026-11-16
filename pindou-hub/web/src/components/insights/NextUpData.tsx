// 下一张拼什么：面板和总览小卡共用的数据（同一份计算，不重复写口径）。
import { useMemo } from "react";
import { useData } from "../../lib/db";
import { stockByCode } from "../../lib/inventory";
import { nextUp, type NextUpResult } from "../../lib/nextUp";

export function useNextUp(): { result: NextUpResult; inventoryReady: boolean; hasStock: boolean } {
  const { patterns, txns, prefs } = useData();
  const stock = useMemo(() => stockByCode(txns), [txns]);
  const result = useMemo(() => nextUp(patterns, stock, prefs), [patterns, stock, prefs]);
  const inventoryReady = !!prefs.inventoryStartedAt || txns.some((t) => !t.deleted);
  const hasStock = useMemo(() => Object.values(stock).some((n) => n > 0), [stock]);
  return { result, inventoryReady, hasStock };
}
