import { useMemo, useState } from "react";
import { Bead, Sheet, fmt, fmtTime, navigate, toast, DiffNumber } from "../ui";
import { useData, putRecords } from "../../lib/db";
import { colorOf } from "../../lib/palette";
import { demandByCode, stockByCode, stocktakeTxn, isActive } from "../../lib/inventory";
import { STATUS_LABEL, uid } from "../../lib/model";
import { levelOf } from "../../lib/stockview";
import { addTxns, deviceId } from "./actions";
import "./stock.css";

const KIND: Record<string, string> = { purchase: "入库", consume: "消耗", adjust: "调整", stocktake: "盘点" };

/** 单个色号的详情抽屉：当前库存、快速增减、盘点、入库、最低库存、近期流水、用到它的图纸。 */
export function CodeSheet({ code, onClose }: { code: string; onClose: () => void }) {
  const data = useData();
  const color = colorOf(code);
  const stock = useMemo(() => stockByCode(data.txns), [data.txns]);
  const have = stock[code] ?? 0;
  const floor = data.prefs.minStock[code] ?? data.prefs.lowStock;
  const demand = useMemo(() => demandByCode(data.patterns, isActive), [data.patterns]);
  const need = demand[code] ?? 0;
  const level = levelOf(have, floor);
  const recent = useMemo(() => data.txns.filter((t) => t.code === code).slice(0, 8), [data.txns, code]);
  const using = useMemo(() => data.patterns.filter((p) => (p.counts[code] ?? 0) > 0 && p.status !== "idea"), [data.patterns, code]);

  const [actual, setActual] = useState("");
  const [buyQty, setBuyQty] = useState("");
  const [price, setPrice] = useState("");
  const [min, setMin] = useState(data.prefs.minStock[code] !== undefined ? String(data.prefs.minStock[code]) : "");

  const quick = async (delta: number) => {
    const at = Date.now();
    await addTxns([{ id: uid("t"), code, delta, kind: delta > 0 ? "purchase" : "adjust", note: delta > 0 ? "快速入库" : "快速减少", device: deviceId(), at, updatedAt: at }], `${code} ${delta > 0 ? "+" : "−"}${Math.abs(delta)}`);
  };
  const stocktake = async () => {
    const txn = stocktakeTxn(code, Number(actual), have, deviceId());
    if (!txn) { toast("数量没有变化"); return; }
    await addTxns([txn], `${code} 盘点为 ${fmt(Number(actual))}`);
    setActual("");
  };
  const buy = async () => {
    const qty = Math.round(Number(buyQty));
    if (!(qty > 0)) return;
    const at = Date.now();
    const unit = Number(price) > 0 ? Number(price) : undefined;
    await addTxns([{ id: uid("t"), code, delta: qty, kind: "purchase", unitPrice: unit, device: deviceId(), at, updatedAt: at }], `${code} 入库 ${fmt(qty)}`);
    setBuyQty(""); setPrice("");
  };
  const saveMin = async () => {
    const minStock = { ...data.prefs.minStock };
    const n = Math.round(Number(min));
    if (min.trim() === "" || !(n >= 0)) delete minStock[code]; else minStock[code] = n;
    await putRecords("prefs", [{ ...data.prefs, minStock, updatedAt: Date.now() }]);
    toast(min.trim() === "" ? `${code} 最低库存恢复默认 ${data.prefs.lowStock}` : `${code} 最低库存 ${n}`);
  };

  return (
    <Sheet title={<span className="bead-code"><Bead code={code} size={28} /><span className="code">{code}</span><span className="meta">{color?.nameZh}</span></span>} onClose={onClose}>
      <div className="sk-big">
        <div>
          <div className="label">当前库存</div>
          <div className="sk-big-num" aria-live="polite"><DiffNumber value={have} /> <span className="meta">颗</span></div>
        </div>
        <div className="stack" style={{ gap: 4, alignItems: "flex-start" }}>
          {level === "empty" ? <span className="chip chip-iron">没有了</span> : level === "low" ? <span className="chip chip-amber">偏少（低于 {fmt(floor)}）</span> : <span className="chip chip-leaf">够用</span>}
          {need > 0 ? <span className={`chip ${need > have ? "chip-iron" : ""}`}>计划需要 {fmt(need)}</span> : null}
        </div>
        <span className="spacer" />
        <span className="meta code">{color?.hex}</span>
      </div>

      <div className="sk-quick" style={{ marginTop: 14 }}>
        {[100, 500, 1000, -100].map((d) => <button key={d} className="btn" onClick={() => quick(d)}>{d > 0 ? `+${d}` : `−${-d}`}</button>)}
      </div>

      <div className="sk-sec">
        <span className="label">盘点（数一数盒里实际有多少）</span>
        <div className="sk-inline">
          <label className="field"><span className="sr-only">实际数量</span><input className="input num" type="number" inputMode="numeric" min={0} value={actual} onChange={(e) => setActual(e.target.value)} placeholder={`实际数量（现记 ${have}）`} /></label>
          <button className="btn" disabled={actual === ""} onClick={stocktake}>确认盘点</button>
        </div>
      </div>

      <div className="sk-sec">
        <span className="label">入库</span>
        <div className="sk-inline">
          <label className="field"><span>数量</span><input className="input num" type="number" inputMode="numeric" min={0} value={buyQty} onChange={(e) => setBuyQty(e.target.value)} /></label>
          <label className="field"><span>单价（元/颗，选填）</span><input className="input num" type="number" inputMode="decimal" min={0} step="0.001" value={price} onChange={(e) => setPrice(e.target.value)} /></label>
          <button className="btn btn-primary" disabled={!(Number(buyQty) > 0)} onClick={buy}>入库</button>
        </div>
      </div>

      <div className="sk-sec">
        <span className="label">最低库存（低于它就提醒补货）</span>
        <div className="sk-inline">
          <label className="field"><span className="sr-only">最低库存</span><input className="input num" type="number" inputMode="numeric" min={0} value={min} onChange={(e) => setMin(e.target.value)} placeholder={`默认 ${data.prefs.lowStock}`} /></label>
          <button className="btn" onClick={saveMin}>保存</button>
        </div>
      </div>

      <div className="sk-sec">
        <span className="label">用到它的图纸</span>
        {using.length ? (
          <div className="sk-list">
            {using.map((p) => (
              <a key={p.id} href={`#/pattern/${p.id}`} onClick={() => onClose()} style={{ color: "inherit", textDecoration: "none" }}>
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span>
                <span className="meta num">{fmt(p.counts[code] * Math.max(1, p.copies || 1))} 颗</span>
                <span className="chip">{STATUS_LABEL[p.status]}</span>
              </a>
            ))}
          </div>
        ) : <p className="meta">暂时没有计划中的图纸用到这个色号。</p>}
      </div>

      <div className="sk-sec">
        <span className="label">最近记录</span>
        {recent.length ? (
          <div className="sk-list">
            {recent.map((t) => (
              <div key={t.id}>
                <span className="chip">{KIND[t.kind]}</span>
                <span className={`num ${t.delta > 0 ? (t.kind === "purchase" ? "sk-pos" : "sk-adj") : t.kind === "consume" ? "sk-neg" : "sk-adj"}`} style={{ fontWeight: 600 }}>{t.delta > 0 ? "+" : "−"}{fmt(Math.abs(t.delta))}</span>
                <span className="meta" style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.note ?? ""}</span>
                <span className="meta">{fmtTime(t.at)}</span>
              </div>
            ))}
          </div>
        ) : <p className="meta">还没有这个色号的记录。</p>}
        <button className="btn btn-ghost btn-sm" style={{ marginTop: 8 }} onClick={() => { onClose(); navigate(`/history?code=${code}`); }}>查看全部记录</button>
      </div>
    </Sheet>
  );
}
