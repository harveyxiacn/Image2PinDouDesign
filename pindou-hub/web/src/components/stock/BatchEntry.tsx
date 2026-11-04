import { useMemo, useState } from "react";
import { Bead, Icon, Sheet, fmt, toast } from "../ui";
import { colorOf, normalizeCode } from "../../lib/palette";
import { parseBatchText, type ParsedRow } from "../../lib/stockview";
import { CodePicker } from "./CodePicker";
import { commitPurchase } from "./actions";
import "./stock.css";

/** 批量入库：逐行选色号 + 数量，或粘贴“A1 1000, B3×500”。生成同一 batchId 的入库流水。 */
export function BatchEntry({ onClose, initial = [] }: { onClose: () => void; initial?: ParsedRow[] }) {
  const [rows, setRows] = useState<Array<{ code: string; qty: string }>>(initial.map((r) => ({ code: r.code, qty: String(r.qty) })));
  const [paste, setPaste] = useState("");
  const [pasteErr, setPasteErr] = useState<string[]>([]);
  const [total, setTotal] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const parsed = useMemo(() => rows.map((r) => ({ code: r.code, qty: Math.round(Number(r.qty)) || 0 })).filter((r) => r.qty > 0), [rows]);
  const sum = parsed.reduce((a, r) => a + r.qty, 0);

  const addCode = (code: string) => setRows((cur) => (cur.some((r) => r.code === code) ? cur : [...cur, { code, qty: "" }]));
  const applyPaste = () => {
    const result = parseBatchText(paste, normalizeCode);
    setRows((cur) => {
      const map = new Map(cur.map((r) => [r.code, Number(r.qty) || 0]));
      for (const r of result.rows) map.set(r.code, (map.get(r.code) ?? 0) + r.qty);
      return [...map].map(([code, qty]) => ({ code, qty: qty ? String(qty) : "" }));
    });
    setPasteErr(result.errors);
    if (result.rows.length) setPaste("");
    else toast("没有识别到“色号 数量”");
  };
  const submit = async () => {
    setBusy(true);
    try {
      await commitPurchase(parsed, { note, totalPrice: Number(total) || undefined });
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
          <span>粘贴一串（色号 数量，逗号或换行分隔）</span>
          <textarea className="textarea" value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="A1 1000, B3×500, H7 2000" />
        </label>
        <div className="row">
          <button className="btn btn-sm" disabled={!paste.trim()} onClick={applyPaste}><Icon name="plus" />加入下面的列表</button>
          {pasteErr.length ? <span className="chip chip-iron">认不出：{pasteErr.slice(0, 6).join("、")}</span> : null}
        </div>

        <div>
          <span className="label">入库明细</span>
          <div className="sk-rows" style={{ marginTop: 8 }}>
            {rows.length ? rows.map((r, i) => (
              <div className="sk-row" key={r.code}>
                <div className="sk-row-bead"><Bead code={r.code} /><span className="code" style={{ fontWeight: 600 }}>{r.code}</span><span className="meta">{colorOf(r.code)?.nameZh}</span></div>
                <input className="input num" inputMode="numeric" type="number" min={0} placeholder="数量" aria-label={`${r.code} 数量`} value={r.qty}
                  onChange={(e) => setRows((cur) => cur.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} />
                <button className="btn btn-ghost btn-sm" aria-label={`移除 ${r.code}`} onClick={() => setRows((cur) => cur.filter((_, j) => j !== i))}><Icon name="x" /></button>
              </div>
            )) : <p className="meta">还没有色号。粘贴上面的文字，或从下面挑选。</p>}
          </div>
        </div>

        <div>
          <span className="label">添加色号</span>
          <div style={{ marginTop: 8 }}><CodePicker onPick={addCode} taken={rows.map((r) => r.code)} /></div>
        </div>

        <div className="grid-2" style={{ gap: 12 }}>
          <label className="field"><span>总价（元，选填）</span><input className="input num" type="number" inputMode="decimal" min={0} value={total} onChange={(e) => setTotal(e.target.value)} placeholder="按颗数均摊成单价" /></label>
          <label className="field"><span>备注（选填）</span><input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="如：淘宝 11.11" /></label>
        </div>
      </div>
    </Sheet>
  );
}
