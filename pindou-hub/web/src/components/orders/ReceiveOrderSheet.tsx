// 订单到货入库：默认全部到货；只收一部分就取消勾选或改小数量，剩下的继续算在途。
import { useEffect, useRef, useState } from "react";
import { Bead, Icon, Sheet, fmt } from "../ui";
import { colorOf } from "../../lib/palette";
import { allocatePrices, parseFen } from "../../lib/pricing";
import { orderTitle, receiveDefaults, type Order } from "../../lib/orders";
import { PriceNote } from "../stock/PriceNote";
import { receiveIntoOrder } from "./store";

export function ReceiveOrderSheet({ order, live, onClose }: { order: Order; live: Set<string>; onClose: () => void }) {
  const defaults = receiveDefaults(order, live);
  const [rows, setRows] = useState(() => defaults.rows.map((r) => ({ code: r.code, due: r.qty, on: true, q: String(r.qty), amt: r.amount ? String(r.amount) : "" })));
  const [total, setTotal] = useState(defaults.totalYuan ? String(defaults.totalYuan) : "");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ txns: number; beads: number; left: number } | null>(null);
  const doneBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (done) doneBtn.current?.focus(); }, [done]);

  const chosen = rows.filter((r) => r.on).map((r) => ({ code: r.code, qty: Math.round(Number(r.q)) || 0, amount: parseFen(r.amt) !== undefined ? Number(r.amt) : undefined })).filter((r) => r.qty > 0);
  const sum = chosen.reduce((a, r) => a + r.qty, 0);
  const alloc = allocatePrices(chosen.map((r) => ({ qty: r.qty, fen: parseFen(r.amount) })), parseFen(total));
  const allOn = rows.every((r) => r.on);
  const setAll = (on: boolean) => setRows((cur) => cur.map((r) => ({ ...r, on })));
  const patch = (i: number, p: Partial<(typeof rows)[number]>) => setRows((cur) => cur.map((x, j) => (j === i ? { ...x, ...p } : x)));

  if (done) {
    return (
      <Sheet title="已入库" onClose={onClose} footer={<button ref={doneBtn} className="btn btn-iron" data-order-receive-done onClick={onClose}>完成</button>}>
        <div className="shop-sum" role="status">
          <span className="shop-sum-ic"><Icon name="check" size={28} /></span>
          <h3>入库 {done.txns} 色 · {fmt(done.beads)} 颗</h3>
          <p className="meta">{done.left > 0 ? `这张订单还有 ${fmt(done.left)} 颗在路上。` : "这张订单已全部到货。"} 操作可以在底部提示里撤销。</p>
        </div>
      </Sheet>
    );
  }
  return (
    <Sheet title={`到货入库 · ${orderTitle(order)}`} onClose={onClose} footer={
      <>
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn btn-iron" data-order-receive-commit disabled={!chosen.length || busy} onClick={async () => {
          setBusy(true);
          try { const r = await receiveIntoOrder(order.id, chosen, { note, totalYuan: parseFen(total) !== undefined ? Number(total) : undefined }); if (r) setDone(r); } finally { setBusy(false); }
        }}>入库 {chosen.length} 色 · {fmt(sum)} 颗</button>
      </>
    }>
      <div className="stack">
        <div className="row">
          <p className="meta" style={{ flex: 1 }}>按实际收到的数量修改；没到的色号取消勾选，剩下的继续算在途。</p>
          <button type="button" className="btn btn-sm btn-ghost" data-order-receive-all onClick={() => setAll(!allOn)}>{allOn ? "全不选" : "全部到货"}</button>
        </div>
        <div className="sk-rows">
          {rows.map((r, i) => (
            <div className="sk-tick-row sk-row-p" key={r.code} data-order-receive-row={r.code}>
              <input type="checkbox" checked={r.on} aria-label={`${r.code} 已到货`} onChange={(e) => patch(i, { on: e.target.checked })} />
              <span className="bead-code sk-c-bead"><Bead code={r.code} /><span className="code">{r.code}</span><span className="meta">{colorOf(r.code)?.nameZh} · 还差 {fmt(r.due)}</span></span>
              <input className="input num sk-c-qty" type="number" inputMode="numeric" min={0} aria-label={`${r.code} 到货数量`} value={r.q} disabled={!r.on} onChange={(e) => patch(i, { q: e.target.value })} />
              <input className="input num sk-c-amt" type="number" inputMode="decimal" min={0} step="0.01" aria-label={`${r.code} 这一行的金额（元，选填）`} placeholder="金额 元" value={r.amt} disabled={!r.on} onChange={(e) => patch(i, { amt: e.target.value })} />
            </div>
          ))}
        </div>
        <div className="grid-2" style={{ gap: 12 }}>
          <label className="field"><span>本次订单总价（元，选填）</span><input className="input num" type="number" inputMode="decimal" min={0} step="0.01" value={total} onChange={(e) => setTotal(e.target.value)} placeholder="没填金额的行按颗数分" data-order-receive-total /></label>
          <label className="field"><span>备注（选填）</span><input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder={`默认记为“订单 ${orderTitle(order)}”`} /></label>
        </div>
        <PriceNote alloc={alloc} beads={sum} />
      </div>
    </Sheet>
  );
}
