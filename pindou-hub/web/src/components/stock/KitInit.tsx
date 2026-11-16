import { useMemo, useState } from "react";
import { Sheet, fmt } from "../ui";
import { useData } from "../../lib/db";
import { PALETTE_KITS, getPaletteKit, isKnownCode, normalizeKitId } from "../../lib/palette";
import { stockByCode } from "../../lib/inventory";
import { PURCHASE_OFFERS } from "../../lib/purchase";
import { parseFen, perThousandText, yuanText } from "../../lib/pricing";
import { commitPurchase } from "./actions";
import "./stock.css";

/** 按套装初始化库存：每个色号入库相同数量（追加，或补齐到该数量）。 */
export function KitInit({ onClose }: { onClose: () => void }) {
  const data = useData();
  const [kitId, setKitId] = useState(() => normalizeKitId(data.prefs.kitId));
  const [qty, setQty] = useState("500");
  const [mode, setMode] = useState<"add" | "fill">("add");
  // 总价：null = 还没改过，显示按色数匹配的套装报价作为建议；用户改了（包括清空）就以用户为准
  const [priceEdit, setPriceEdit] = useState<string | null>(null);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const stock = useMemo(() => stockByCode(data.txns), [data.txns]);
  const kit = getPaletteKit(kitId);
  const n = Math.max(0, Math.round(Number(qty)) || 0);
  const rows = useMemo(() => kit.codes.filter(isKnownCode).map((code) => ({ code, qty: mode === "add" ? n : Math.max(0, n - Math.max(0, stock[code] ?? 0)) })).filter((r) => r.qty > 0), [kit, n, mode, stock]);
  const existing = Object.values(stock).some((v) => v > 0);
  const sum = rows.reduce((a, r) => a + r.qty, 0);
  const blocked = existing && !ack;
  const offers = useMemo(() => PURCHASE_OFFERS.filter((o) => o.kind === "set" && o.colors === kit.codes.length), [kit]);
  const priceText = priceEdit ?? (offers[0] ? String(offers[0].price) : "");
  const priceFen = parseFen(priceText);

  return (
    <Sheet title="按套装初始化库存" onClose={onClose} footer={
      <>
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn btn-iron" disabled={!rows.length || blocked || busy} onClick={async () => { setBusy(true); try { await commitPurchase(rows, { note: `按套装初始化：${kit.name}`, totalPrice: priceFen !== undefined ? priceFen / 100 : undefined }); onClose(); } finally { setBusy(false); } }}>
          入库 {rows.length} 色 · {fmt(sum)} 颗
        </button>
      </>
    }>
      <div className="stack">
        <label className="field"><span>你手里的色卡套装</span>
          <select className="select" value={kitId} onChange={(e) => { setKitId(e.target.value); setPriceEdit(null); }}>
            {PALETTE_KITS.map((k) => <option key={k.id} value={k.id}>{k.name}（{k.codes.length} 色）</option>)}
          </select>
        </label>
        <p className="meta">{kit.description} 以实际购买的色卡为准。</p>
        <div className="grid-2" style={{ gap: 12 }}>
          <label className="field"><span>每个色号约有（颗）</span><input className="input num" type="number" inputMode="numeric" min={0} value={qty} onChange={(e) => setQty(e.target.value)} /></label>
          <div className="field"><span>方式</span>
            <div className="seg" role="group" aria-label="方式">
              <button aria-pressed={mode === "add"} onClick={() => setMode("add")}>追加</button>
              <button aria-pressed={mode === "fill"} onClick={() => setMode("fill")}>补齐到该数量</button>
            </div>
          </div>
        </div>
        <div className="stack" style={{ gap: 6 }}>
          <label className="field"><span>这套一共花了多少钱（元，选填）</span>
            <input className="input num" type="number" inputMode="decimal" min={0} step="0.01" value={priceText} onChange={(e) => setPriceEdit(e.target.value)} placeholder="不填就不记花费" data-kit-price />
          </label>
          {offers.length ? (
            <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
              <span className="meta">参考报价（每色 1200 颗）：</span>
              {offers.map((o) => <button key={o.id} type="button" className="btn btn-sm" aria-pressed={priceFen === parseFen(o.price)} onClick={() => setPriceEdit(String(o.price))}>¥{o.price}</button>)}
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPriceEdit("")}>不记价格</button>
            </div>
          ) : null}
          {priceFen !== undefined && sum > 0 ? <p className="meta" role="status">记 {yuanText(priceFen)}，{perThousandText(priceFen, sum)}，会计入“记录”和统计里的花费。{n !== 1200 && offers.length ? " 参考报价是每色 1200 颗的价格，数量不同请按实际花的钱修改。" : ""}</p> : null}
        </div>
        {existing ? (
          <div className="notice">
            {mode === "fill" ? "已经有库存记录了，补齐只会补上差额，已有数量不变；仍需确认。" : "已经有库存记录了，继续会在现有数量上再入库一次。"}
            <label className="row" style={{ marginTop: 6 }}><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} style={{ width: 18, height: 18, accentColor: "var(--iron)" }} />我知道，仍然入库</label>
          </div>
        ) : null}
        <p className="meta">会生成一次入库记录，可在“记录”里整批撤销。</p>
      </div>
    </Sheet>
  );
}
