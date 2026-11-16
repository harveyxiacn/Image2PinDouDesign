// 总览里的在途订单小卡片：有没到齐的订单时显示（几张、还差多少颗、最早的一张下单几天了），点进采购清单的订单区。
import { useEffect, useState } from "react";
import { Icon, fmt } from "../ui";
import { STALE_DAYS, ageDays, openOrderSummary } from "../../lib/orders";
import { useOrders } from "./store";
import "./orders.css";

export function OrdersCard() {
  const { orders, live } = useOrders();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { setNow(Date.now()); }, [orders]);
  const sum = openOrderSummary(orders, now, live);
  if (!sum.count) return null;
  const stale = sum.oldestDays >= STALE_DAYS;
  return (
    <section className="panel ord-dash" aria-label="在途订单" data-dash-orders data-dash-orders-count={sum.count}>
      <div className="ord-dash-main">
        <span className="label">在途订单</span>
        <div><b className="num">{sum.count}</b> 张 · 还差 <b className="num" data-dash-orders-left>{fmt(sum.leftBeads)}</b> 颗 · 最早的下单 <b className="num" data-dash-orders-age>{sum.oldestDays}</b> 天{stale ? <span className="chip chip-amber" style={{ marginLeft: 8 }}>久了，问问卖家</span> : null}</div>
      </div>
      <a className="btn" href="#/shopping?orders=1" data-dash-orders-link><Icon name="cart" />看订单</a>
    </section>
  );
}
