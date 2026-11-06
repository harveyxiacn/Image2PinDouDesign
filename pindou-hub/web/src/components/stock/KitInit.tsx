import { useMemo, useState } from "react";
import { Sheet, fmt } from "../ui";
import { useData } from "../../lib/db";
import { PALETTE_KITS, getPaletteKit, isKnownCode, normalizeKitId } from "../../lib/palette";
import { stockByCode } from "../../lib/inventory";
import { commitPurchase } from "./actions";
import "./stock.css";

/** 按套装初始化库存：每个色号入库相同数量（追加，或补齐到该数量）。 */
export function KitInit({ onClose }: { onClose: () => void }) {
  const data = useData();
  const [kitId, setKitId] = useState(() => normalizeKitId(data.prefs.kitId));
  const [qty, setQty] = useState("500");
  const [mode, setMode] = useState<"add" | "fill">("add");
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const stock = useMemo(() => stockByCode(data.txns), [data.txns]);
  const kit = getPaletteKit(kitId);
  const n = Math.max(0, Math.round(Number(qty)) || 0);
  const rows = useMemo(() => kit.codes.filter(isKnownCode).map((code) => ({ code, qty: mode === "add" ? n : Math.max(0, n - Math.max(0, stock[code] ?? 0)) })).filter((r) => r.qty > 0), [kit, n, mode, stock]);
  const existing = Object.values(stock).some((v) => v > 0);
  const sum = rows.reduce((a, r) => a + r.qty, 0);
  const blocked = existing && !ack;

  return (
    <Sheet title="按套装初始化库存" onClose={onClose} footer={
      <>
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn btn-iron" disabled={!rows.length || blocked || busy} onClick={async () => { setBusy(true); try { await commitPurchase(rows, { note: `按套装初始化：${kit.name}` }); onClose(); } finally { setBusy(false); } }}>
          入库 {rows.length} 色 · {fmt(sum)} 颗
        </button>
      </>
    }>
      <div className="stack">
        <label className="field"><span>你手里的色卡套装</span>
          <select className="select" value={kitId} onChange={(e) => setKitId(e.target.value)}>
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
        {existing ? (
          <div className="notice">
            已经有库存记录了，继续会在现有数量上再入库一次。
            <label className="row" style={{ marginTop: 6 }}><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} style={{ width: 18, height: 18, accentColor: "var(--iron)" }} />我知道，仍然入库</label>
          </div>
        ) : null}
        <p className="meta">会生成一次入库记录，可在“记录”里整批撤销。</p>
      </div>
    </Sheet>
  );
}
