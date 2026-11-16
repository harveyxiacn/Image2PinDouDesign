// 补货预告的数据钩子：总览卡片和洞察面板共用，周期选择按设备记在 localStorage。
import { useCallback, useMemo, useState } from "react";
import { useData } from "../../lib/db";
import { liveBatchesFor, readOrders } from "../../lib/orders";
import { forecastNeeds, type ForecastResult, type Horizon } from "../../lib/forecast";

const KEY = "ph.forecast.horizon";

function readHorizon(): Horizon {
  try {
    const v = Number(localStorage.getItem(KEY));
    return v === 1 || v === 3 ? v : 2;
  } catch { return 2; }
}

export function useForecast(): { result: ForecastResult; horizon: Horizon; setHorizon: (h: Horizon) => void } {
  const { patterns, txns, prefs } = useData();
  const [horizon, setH] = useState<Horizon>(readHorizon);
  const setHorizon = useCallback((h: Horizon) => {
    setH(h);
    try { localStorage.setItem(KEY, String(h)); } catch { /* 无痕模式等：本次仍然生效 */ }
  }, []);
  const result = useMemo(() => {
    const orders = readOrders(prefs);
    return forecastNeeds({ patterns, txns, prefs, horizon, orders, liveBatches: liveBatchesFor(orders, txns) });
  }, [patterns, txns, prefs, horizon]);
  return { result, horizon, setHorizon };
}
