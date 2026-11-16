import { useMemo, useState } from "react";
import { Bead, Icon, Sheet, fmt, toast } from "../ui";
import { colorOf, normalizeCode } from "../../lib/palette";
import { parseBatchText, type ParsedRow } from "../../lib/stockview";
import { CodePicker } from "./CodePicker";
import { allocatePrices, parseFen } from "../../lib/pricing";
import { PriceNote } from "./PriceNote";
import { commitPurchase } from "./actions";
import "./stock.css";

/** 批量入库：逐行选色号 + 数量，或粘贴“A1 1000, B3×500”。生成同一 batchId 的入库流水。 */
export function BatchEntry({ onClose, initial = [] }: { onClose: () => void; initial?: ParsedRow[] }) {
  const [rows, setRows] = useState<Array<{ code: string; qty: string; amt: string }>>(initial.map((r) => ({ code: r.code, qty: String(r.qty), amt: r.amount ? String(r.amount) : "" })));
  const [paste, setPaste] = useState("");
  const [pasteErr, setPasteErr] = useState<string[]>([]);
  const [total, setTotal] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const parsed = useMemo(() => rows.map((r) => ({ code: r.code, qty: Math.round(Number(r.qty)) || 0, amount: parseFen(r.amt) !== undefined ? Number(r.amt) : undefined })).filter((r) => r.qty > 0), [rows]);
  const sum = parsed.reduce((a, r) => a + r.qty, 0);
  const alloc = useMemo(() => allocatePrices(parsed.map((r) => ({ qty: r.qty, fen: parseFen(r.amount) })), parseFen(total)), [parsed, total]);
  const shown = (code: string) => { const i = parsed.findIndex((r) => r.code === code); return i >= 0 && alloc.fen[i] > 0 ? (alloc.fen[i] / 100).toFixed(2) : ""; };

  const addCode = (code: string) => setRows((cur) => (cur.some((r) => r.code === code) ? cur : [...cur, { code, qty: "", amt: "" }]));
  const applyPaste = () => {
    const result = parseBatchText(paste, normalizeCode);
    setRows((cur) => {
      const map = new Map(cur.map((r) => [r.code, { qty: Number(r.qty) || 0, amt: Number(r.amt) || 0 }]));
      for (const r of result.rows) {
        const old = map.get(r.code) ?? { qty: 0, amt: 0 };
        map.set(r.code, { qty: old.qty + r.qty, amt: Math.round((old.amt + (r.amount ?? 0)) * 100) / 100 });
      }
      return [...map].map(([code, v]) => ({ code, qty: v.qty ? String(v.qty) : "", amt: v.amt ? String(v.amt) : "" }));
    });
    setPasteErr(result.errors);
    if (result.rows.length) setPaste("");
    else toast("没有识别到“色号 数量”");
  };
  const submit = async () => {
    setBusy(true);
    try {
      await commitPurchase(parsed, { note, totalPrice: parseFen(total) !== undefined ? Number(total) : undefined });
      onClose();
    } finally { setBusy(false); }
  };

  return (
    <Sheet title="批量入库" onClose={onClose} footer={
      <>
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn btn-iron" disabled={!parsed.length || busy} onClick={submit}>入库 {parsed.length} 色 · {fmt(sum)} 颗</button>
      </>
    }>
      <div className="stack">
        <label className="field">
          <span>粘贴一串（色号 数量，逗号或换行分隔；数量后可写 ¥金额）</span>
          <textarea className="textarea" value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="A1 1000, B3×500, H7 2000 ¥1.5" />
        </label>
        <div className="row">
          <button className="btn btn-sm" disabled={!paste.trim()} onClick={applyPaste}><Icon name="plus" />加入下面的列表</button>
          {pasteErr.length ? <span className="chip chip-iron">认不出：{pasteErr.slice(0, 6).join("、")}</span> : null}
        </div>

        <div>
          <span className="label">入库明细</span>
          <div className="sk-rows" style={{ marginTop: 8 }}>
            {rows.length ? rows.map((r, i) => (
              <div className="sk-row sk-row-p" key={r.code} data-batch-row={r.code}>
                <div className="sk-row-bead sk-c-bead"><Bead code={r.code} /><span className="code" style={{ fontWeight: 600 }}>{r.code}</span><span className="meta">{colorOf(r.code)?.nameZh}</span></div>
                <input className="input num sk-c-qty" inputMode="numeric" type="number" min={0} placeholder="数量" aria-label={`${r.code} 数量`} value={r.qty}
                  onChange={(e) => setRows((cur) => cur.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} />
                <input className="input num sk-c-amt" inputMode="decimal" type="number" min={0} step="0.01" placeholder={r.amt === "" && shown(r.code) ? `分摊 ${shown(r.code)}` : "金额 元"} aria-label={`${r.code} 这一行的金额（元，选填）`} data-row-amount value={r.amt}
                  onChange={(e) => setRows((cur) => cur.map((x, j) => (j === i ? { ...x, amt: e.target.value } : x)))} />
                <button className="btn btn-ghost btn-sm sk-c-x" aria-label={`移除 ${r.code}`} onClick={() => setRows((cur) => cur.filter((_, j) => j !== i))}><Icon name="x" /></button>
              </div>
            )) : <p className="meta">还没有色号。粘贴上面的文字，或从下面挑选。</p>}
          </div>
        </div>

        <div>
          <span className="label">添加色号</span>
          <div style={{ marginTop: 8 }}><CodePicker onPick={addCode} taken={rows.map((r) => r.code)} /></div>
        </div>

        <div className="grid-2" style={{ gap: 12 }}>
          <label className="field"><span>订单总价（元，选填）</span><input className="input num" type="number" inputMode="decimal" min={0} step="0.01" value={total} onChange={(e) => setTotal(e.target.value)} placeholder="没填金额的行按颗数分" data-batch-total /></label>
          <label className="field"><span>备注（选填）</span><input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="如：淘宝 11.11" /></label>
        </div>
        <p className="meta">混着买不同规格时，在每行填它自己的金额；再填订单总价，则扣掉各行金额后的余额按颗数分给没填金额的行。</p>
        <PriceNote alloc={alloc} beads={sum} />
      </div>
    </Sheet>
  );
}
