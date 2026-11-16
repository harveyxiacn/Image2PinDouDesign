// 在途订单：列出已下单还没到齐的订单，到货入库 / 改数量 / 取消 / 重新打开。
import { useEffect, useState } from "react";
import { Bead, Icon, fmt } from "../ui";
import { formatMoney } from "../../lib/purchase";
import {
  ORDER_STATUS_LABEL, STALE_DAYS, ageDays, isOpen, orderTitle, orderTotals, outstandingByCode, statusOf, type Order
} from "../../lib/orders";
import { cancelOne, reopenOne, useOrders } from "./store";
import { ReceiveOrderSheet } from "./ReceiveOrderSheet";
import { EditOrderSheet } from "./EditOrderSheet";
import "./orders.css";

function OrderCard({ order, live, now, onReceive, onEdit }: { order: Order; live: Set<string>; now: number; onReceive: () => void; onEdit: () => void }) {
  const status = statusOf(order, live);
  const open = isOpen(status);
  const t = orderTotals(order, live);
  const left = Object.entries(outstandingByCode(order, live));
  const stale = open && ageDays(order, now) >= STALE_DAYS;
  return (
    <li className="ord-card" data-order-id={order.id} data-order-status={status}>
      <div className="ord-head">
        <b className="ord-title">{orderTitle(order)}</b>
        <span className={`chip ${status === "partial" ? "chip-amber" : status === "cancelled" ? "" : status === "received" ? "" : "chip-iron"}`} data-order-chip>{ORDER_STATUS_LABEL[status]}</span>
        {stale ? <span className="chip chip-amber" data-order-stale>下单 {ageDays(order, now)} 天了</span> : null}
      </div>
      <p className="meta ord-sum">
        共 {t.colors} 色 {fmt(t.beads)} 颗
        {open ? <>，<b className="ord-left" data-order-left>还差 {fmt(t.leftBeads)} 颗</b></> : status === "received" ? "，已全部到货" : t.gotBeads ? `，已到 ${fmt(t.gotBeads)} 颗` : ""}
        {order.cost !== undefined ? ` · 预计 ${formatMoney(order.cost)}` : ""}
      </p>
      {order.note ? <p className="meta ord-note">{order.note}</p> : null}
      {open && left.length ? (
        <div className="ord-chips" aria-label="还没到的色号">
          {left.map(([code, n]) => <span className="ord-chip" key={code} data-order-left-code={code}><Bead code={code} size={16} /><span className="code">{code}</span><span className="num">{fmt(n)}</span></span>)}
        </div>
      ) : null}
      <div className="row ord-actions">
        {open ? (
          <>
            <button type="button" className="btn btn-sm btn-iron" data-order-receive onClick={onReceive} aria-label={`${orderTitle(order)} 到货入库`}><Icon name="check" size={16} />到货入库</button>
            <button type="button" className="btn btn-sm" data-order-edit onClick={onEdit} aria-label={`${orderTitle(order)} 改数量`}><Icon name="edit" size={16} />改数量</button>
            <button type="button" className="btn btn-sm btn-ghost" data-order-cancel onClick={() => { void cancelOne(order.id); }} aria-label={`${orderTitle(order)} 取消订单`}>取消订单</button>
          </>
        ) : status === "cancelled" ? (
          <button type="button" className="btn btn-sm" data-order-reopen onClick={() => { void reopenOne(order.id); }} aria-label={`${orderTitle(order)} 重新打开`}>重新打开</button>
        ) : null}
      </div>
    </li>
  );
}

export function OrdersSection() {
  const { orders, live } = useOrders();
  const [receiveId, setReceiveId] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | "new" | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { setNow(Date.now()); }, [orders]);
  const open = orders.filter((o) => isOpen(statusOf(o, live)));
  const closed = orders.filter((o) => !isOpen(statusOf(o, live)));
  const receiving = receiveId ? orders.find((o) => o.id === receiveId) : undefined;
  const editing = editId && editId !== "new" ? orders.find((o) => o.id === editId) : undefined;
  const leftBeads = open.reduce((a, o) => a + orderTotals(o, live).leftBeads, 0);

  return (
    <section className="panel panel-pad ord-section" aria-label="在途订单" data-orders-section id="orders">
      <div className="row ord-top">
        <h2 className="ord-h">在途订单</h2>
        <span className="meta" data-orders-count>{open.length ? `${open.length} 张 · 还有 ${fmt(leftBeads)} 颗在路上` : "没有在路上的订单"}</span>
        <span className="spacer" />
        <button type="button" className="btn btn-sm" data-order-add onClick={() => setEditId("new")}><Icon name="plus" size={16} />记一张订单</button>
      </div>
      {open.length ? (
        <ul className="ord-list">{open.map((o) => <OrderCard key={o.id} order={o} live={live} now={now} onReceive={() => setReceiveId(o.id)} onEdit={() => setEditId(o.id)} />)}</ul>
      ) : <p className="meta ord-empty">复制采购文本后，订单会自动记在这里；买回来按“到货入库”，可以只收一部分。</p>}
      {closed.length ? (
        <>
          <button type="button" className="btn btn-sm btn-ghost ord-toggle" data-order-closed-toggle aria-expanded={showClosed} onClick={() => setShowClosed((v) => !v)}>{showClosed ? "收起" : "看看"}已到货 / 已取消的 {closed.length} 张</button>
          {showClosed ? <ul className="ord-list ord-closed">{closed.map((o) => <OrderCard key={o.id} order={o} live={live} now={now} onReceive={() => undefined} onEdit={() => undefined} />)}</ul> : null}
        </>
      ) : null}
      {receiving ? <ReceiveOrderSheet order={receiving} live={live} onClose={() => setReceiveId(null)} /> : null}
      {editId === "new" || editing ? <EditOrderSheet order={editing} live={live} onClose={() => setEditId(null)} /> : null}
    </section>
  );
}
