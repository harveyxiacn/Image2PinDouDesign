// 焦点：建议购买清单——能直接复制去下单，买回来后一键入库。
import { useMemo, useState } from "react";
import { Bead, Icon, Sheet, fmt, toast, DiffNumber } from "../components/ui";
import { useData, putRecords } from "../lib/db";
import { countsToCsv, demandByCode, isActive, shoppingList, stockByCode } from "../lib/inventory";
import { colorOf } from "../lib/palette";
import { shareText } from "../lib/stockview";
import { commitPurchase } from "../components/stock/actions";
import { copyText, downloadText } from "../components/stock/download";
import "./Shopping.css";

export default function Shopping() {
  const data = useData();
  const active = useMemo(() => data.patterns.filter(isActive), [data.patterns]);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [loss, setLoss] = useState(String(Math.round(data.prefs.lossRate * 1000) / 10));
  const [pack, setPack] = useState(String(data.prefs.packSize));
  const [includeLow, setIncludeLow] = useState(true);
  const [edits, setEdits] = useState<Record<string, number>>({});
  const [receive, setReceive] = useState(false);

  const prefs = useMemo(() => ({ ...data.prefs, lossRate: Math.max(0, Number(loss) || 0) / 100, packSize: Math.max(1, Math.round(Number(pack)) || 1) }), [data.prefs, loss, pack]);
  const stock = useMemo(() => stockByCode(data.txns), [data.txns]);
  const rows = useMemo(() => shoppingList(stock, demandByCode(data.patterns, (p) => isActive(p) && !excluded.has(p.id)), prefs, includeLow), [stock, data.patterns, excluded, prefs, includeLow]);
  const qtyOf = (code: string, buy: number) => edits[code] ?? buy;
  const items = rows.map((r) => ({ code: r.code, qty: qtyOf(r.code, r.buy) })).filter((r) => r.qty > 0);
  const total = items.reduce((a, r) => a + r.qty, 0);

  const toggle = (id: string) => setExcluded((cur) => { const n = new Set(cur); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const copy = async () => toast((await copyText(shareText(items))) ? "已复制采购文本" : "复制失败，请手动选择文字");
  const csv = () => {
    const out = rows.map((r) => ({ code: r.code, name: colorOf(r.code)?.nameZh ?? "", need: r.needWithLoss, stock: r.stock, shortfall: r.shortfall, buy: qtyOf(r.code, r.buy) }));
    downloadText("采购清单.csv", countsToCsv(out, [["code", "色号"], ["name", "颜色"], ["need", "需要(含损耗)"], ["stock", "库存"], ["shortfall", "缺口"], ["buy", "建议购买"]]), "text/csv;charset=utf-8");
  };
  const saveDefaults = async () => {
    await putRecords("prefs", [{ ...data.prefs, lossRate: prefs.lossRate, packSize: prefs.packSize, updatedAt: Date.now() }]);
    toast("已存为默认损耗率和包装规格");
  };

  return (
    <div>
      <div className="page-head">
        <div><h1>采购清单</h1><p>按计划做 / 制作中的图纸算出缺口，向上取整到整包。</p></div>
      </div>

      <section className="panel shop-hero pegboard" aria-label="采购汇总">
        <div>
          <div className="label">建议购买</div>
          <div className="big"><DiffNumber value={total} /> <span className="meta">颗 · {items.length} 色</span></div>
        </div>
        <span className="spacer" />
        <div className="row">
          <button className="btn" disabled={!items.length} onClick={copy}><Icon name="copy" />复制采购文本</button>
          <button className="btn" disabled={!rows.length} onClick={csv}><Icon name="download" />导出 CSV</button>
          <button className="btn btn-iron" disabled={!items.length} onClick={() => setReceive(true)}><Icon name="check" />买回来了 → 入库</button>
        </div>
      </section>

      <div className="shop-opts">
        <section className="panel panel-pad">
          <span className="label">计入哪些图纸</span>
          {active.length ? (
            <div className="shop-pats" style={{ marginTop: 6 }}>
              {active.map((p) => (
                <label key={p.id}><input type="checkbox" checked={!excluded.has(p.id)} onChange={() => toggle(p.id)} /><span className="n">{p.name}</span><span className="meta num">×{Math.max(1, p.copies || 1)} 份</span></label>
              ))}
            </div>
          ) : <p className="meta" style={{ marginTop: 6 }}>没有“计划做 / 制作中”的图纸。到图库把图纸标成计划做，这里就会算出缺口。</p>}
        </section>
        <section className="panel panel-pad stack">
          <div className="shop-ctl">
            <label className="field"><span>损耗率（%）</span><input className="input num" type="number" inputMode="decimal" min={0} value={loss} onChange={(e) => { setLoss(e.target.value); setEdits({}); }} /></label>
            <label className="field"><span>包装规格（颗/包）</span><input className="input num" type="number" inputMode="numeric" min={1} value={pack} onChange={(e) => { setPack(e.target.value); setEdits({}); }} /></label>
          </div>
          <label className="row" style={{ minHeight: 28 }}><input className="shop-check" type="checkbox" checked={includeLow} onChange={(e) => setIncludeLow(e.target.checked)} />包含补货提醒（库存低于最低库存的色号）</label>
          <div className="row"><button className="btn btn-sm" onClick={saveDefaults}>存为默认</button></div>
        </section>
      </div>

      {rows.length ? (
        <section className="panel">
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>色号</th><th className="r">需要(含损耗)</th><th className="r">库存</th><th className="r">缺口</th><th className="r">建议购买</th><th>原因</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.code}>
                    <td><span className="bead-code"><Bead code={r.code} /><span className="code">{r.code}</span></span></td>
                    <td className="r">{r.needWithLoss ? fmt(r.needWithLoss) : "—"}</td>
                    <td className="r">{fmt(r.stock)}</td>
                    <td className="r" style={{ color: r.shortfall ? "var(--iron-ink)" : undefined }}>{r.shortfall ? fmt(r.shortfall) : "—"}</td>
                    <td className="r"><input className="input num shop-buy" type="number" inputMode="numeric" min={0} aria-label={`${r.code} 建议购买`} value={qtyOf(r.code, r.buy)} onChange={(e) => setEdits((cur) => ({ ...cur, [r.code]: Math.max(0, Math.round(Number(e.target.value)) || 0) }))} /></td>
                    <td>{r.reason === "shortfall" ? <span className="chip chip-iron">缺货</span> : <span className="chip chip-amber">补货</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : active.length ? (
        <div className="panel empty shop-ok"><span style={{ color: "var(--leaf)" }}><Icon name="check" size={28} /></span><h3>库存够做全部计划</h3><p>{excluded.size ? "已勾选的图纸都够用。" : "没有需要补的色号，可以直接开工。"}</p></div>
      ) : (
        <div className="panel empty pegboard"><h3>还没有要做的图纸</h3><p>把图纸标为“计划做”，这里会列出要买什么。</p><a className="btn" href="#/gallery">去图库</a></div>
      )}

      {receive ? <ReceiveSheet items={items} onClose={() => setReceive(false)} onDone={() => setEdits({})} /> : null}
    </div>
  );
}

function ReceiveSheet({ items, onClose, onDone }: { items: Array<{ code: string; qty: number }>; onClose: () => void; onDone: () => void }) {
  const [rows, setRows] = useState(items.map((i) => ({ ...i, on: true, q: String(i.qty) })));
  const [total, setTotal] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const chosen = rows.filter((r) => r.on).map((r) => ({ code: r.code, qty: Math.round(Number(r.q)) || 0 })).filter((r) => r.qty > 0);
  const sum = chosen.reduce((a, r) => a + r.qty, 0);
  return (
    <Sheet title="买回来了 → 入库" onClose={onClose} footer={
      <>
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn btn-iron" disabled={!chosen.length || busy} onClick={async () => { setBusy(true); try { await commitPurchase(chosen, { note, totalPrice: Number(total) || undefined }); onDone(); onClose(); } finally { setBusy(false); } }}>
          入库 {chosen.length} 色 · {fmt(sum)} 颗
        </button>
      </>
    }>
      <div className="stack">
        <p className="meta">按实际收到的数量修改；没到货的色号取消勾选。</p>
        <div className="sk-rows">
          {rows.map((r, i) => (
            <div className="sk-tick-row" key={r.code}>
              <input type="checkbox" checked={r.on} aria-label={`${r.code} 已到货`} onChange={(e) => setRows((cur) => cur.map((x, j) => (j === i ? { ...x, on: e.target.checked } : x)))} />
              <span className="bead-code"><Bead code={r.code} /><span className="code">{r.code}</span><span className="meta">{colorOf(r.code)?.nameZh}</span></span>
              <input className="input num" type="number" inputMode="numeric" min={0} aria-label={`${r.code} 数量`} value={r.q} disabled={!r.on} onChange={(e) => setRows((cur) => cur.map((x, j) => (j === i ? { ...x, q: e.target.value } : x)))} />
            </div>
          ))}
        </div>
        <div className="grid-2" style={{ gap: 12 }}>
          <label className="field"><span>总价（元，选填）</span><input className="input num" type="number" inputMode="decimal" min={0} value={total} onChange={(e) => setTotal(e.target.value)} /></label>
          <label className="field"><span>备注（选填）</span><input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="如：淘宝订单" /></label>
        </div>
      </div>
    </Sheet>
  );
}
