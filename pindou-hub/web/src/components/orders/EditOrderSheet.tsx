// 修改订单（数量、增减色号、卖家、备注、预计总价），也用来手动记一张新订单。
import { useState } from "react";
import { Bead, Sheet, fmt, toast } from "../ui";
import { colorOf } from "../../lib/palette";
import { CodePicker } from "../stock/CodePicker";
import { receivedByCode, type Order } from "../../lib/orders";
import { addManualOrder, saveOrderEdit } from "./store";

export function EditOrderSheet({ order, live, onClose }: { order?: Order; live: Set<string>; onClose: () => void }) {
  const got = order ? receivedByCode(order, live) : {};
  const [rows, setRows] = useState(() => (order?.items ?? []).map((i) => ({ code: i.code, q: String(i.qty) })));
  const [seller, setSeller] = useState(order?.seller ?? "");
  const [note, setNote] = useState(order?.note ?? "");
  const [cost, setCost] = useState(order?.cost !== undefined ? String(order.cost) : "");
  const [busy, setBusy] = useState(false);
  const items = rows.map((r) => ({ code: r.code, qty: Math.round(Number(r.q)) || 0 }));
  const sum = items.reduce((a, r) => a + r.qty, 0);
  const costNum = Number(cost);
  const costVal = cost.trim() !== "" && Number.isFinite(costNum) && costNum > 0 ? costNum : null;
  // 保留原订单里的行金额（这里不改金额）
  const amountOf = (code: string) => order?.items.find((i) => i.code === code)?.amount;
  const save = async () => {
    setBusy(true);
    try {
      const withAmount = items.map((i) => ({ ...i, amount: amountOf(i.code) }));
      if (order) await saveOrderEdit(order.id, { items: withAmount, seller, note, cost: costVal });
      else if (!(await addManualOrder({ items, seller, note, cost: costVal ?? undefined }))) { toast("请至少填一个色号和数量"); return; }
      toast(order ? "订单已更新" : "已记下这张订单");
      onClose();
    } catch { toast("保存失败，请重试"); } finally { setBusy(false); }
  };
  return (
    <Sheet title={order ? "修改订单" : "记一张订单"} onClose={onClose} footer={
      <>
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn btn-iron" data-order-save disabled={busy || (!order && sum <= 0)} onClick={save}>保存 · {fmt(sum)} 颗</button>
      </>
    }>
      <div className="stack" data-order-edit-sheet>
        <div className="sk-rows">
          {rows.map((r, i) => (
            <div className="ord-edit-row" key={r.code} data-order-edit-row={r.code}>
              <span className="bead-code"><Bead code={r.code} /><span className="code">{r.code}</span><span className="meta">{colorOf(r.code)?.nameZh}{got[r.code] ? ` · 已到 ${fmt(got[r.code])}` : ""}</span></span>
              <input className="input num" type="number" inputMode="numeric" min={got[r.code] ?? 0} aria-label={`${r.code} 订购数量`} value={r.q} onChange={(e) => setRows((cur) => cur.map((x, j) => (j === i ? { ...x, q: e.target.value } : x)))} />
            </div>
          ))}
          {!rows.length ? <p className="meta">还没有色号，从下面搜索添加。</p> : null}
        </div>
        <p className="meta">数量不能低于已经到货的数量；改成 0 就从订单里去掉这个色号。</p>
        <CodePicker taken={rows.map((r) => r.code)} onPick={(code) => setRows((cur) => (cur.some((x) => x.code === code) ? cur : [...cur, { code, q: "" }]))} placeholder="添加色号，如 A1 / 红" />
        <div className="grid-2" style={{ gap: 12 }}>
          <label className="field"><span>卖家（选填）</span><input className="input" value={seller} onChange={(e) => setSeller(e.target.value)} placeholder="如：某某旗舰店" maxLength={40} /></label>
          <label className="field"><span>预计总价（元，选填）</span><input className="input num" type="number" inputMode="decimal" min={0} step="0.01" value={cost} onChange={(e) => setCost(e.target.value)} /></label>
        </div>
        <label className="field"><span>备注（选填）</span><input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="如：订单号、预计几号到" maxLength={80} /></label>
      </div>
    </Sheet>
  );
}
