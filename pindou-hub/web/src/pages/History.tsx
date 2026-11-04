// 焦点：按天、按批次分组的流水账——一眼看清每次入库 / 消耗 / 盘点，并能整批撤销。
import "../components/stock/stock.css";
import { useMemo, useState } from "react";
import { colorOf } from "../lib/palette";
import { Bead, Icon, fmt, fmtTime, useRoute } from "../components/ui";
import { toast } from "../components/ui";
import { useData, putRecords, softDelete } from "../lib/db";
import { countsToCsv } from "../lib/inventory";
import { METHOD_LABEL, totalOf, type Txn, type TxnKind } from "../lib/model";
import { groupLedger, limitGroups, txnsToCsvRows, type LedgerGroup } from "../lib/stockview";
import { downloadText } from "../components/stock/download";
import "./History.css";

type KindFilter = "all" | "purchase" | "consume" | "adjust" | "pattern";
const KINDS: Array<[KindFilter, string]> = [["all", "全部"], ["purchase", "入库"], ["consume", "消耗"], ["adjust", "盘点/调整"], ["pattern", "新图纸"]];
const KIND_LABEL: Record<string, string> = { purchase: "入库", consume: "消耗", adjust: "调整", stocktake: "盘点", mixed: "混合" };
const PAGE = 200;

function signCls(g: Extract<LedgerGroup, { type: "txns" }>): string {
  return g.kind === "purchase" ? "pos" : g.kind === "consume" ? "neg" : "adj";
}

export default function History() {
  const data = useData();
  const route = useRoute();
  const [kind, setKind] = useState<KindFilter>("all");
  const [code, setCode] = useState(route.query.get("code") ?? "");
  const [limit, setLimit] = useState(PAGE);
  // 刚撤销的流水：留在原位显示“已撤销 · 恢复”，不让下面的内容上跳
  const [revealed, setRevealed] = useState<Map<string, Txn>>(new Map());
  const [say, setSay] = useState("");

  const days = useMemo(() => {
    const kinds: Array<TxnKind | "pattern"> | undefined = kind === "all" ? undefined : kind === "adjust" ? ["adjust", "stocktake"] : [kind];
    // 界面快照里没有已删除的流水，刚撤销的在这里补回来，只用来占位
    const withGhosts = revealed.size ? [...data.txns, ...[...revealed.values()].map((t) => ({ ...t, deleted: true }))] : data.txns;
    return groupLedger(withGhosts, data.patterns, { kinds, code, reveal: new Set(revealed.keys()) });
  }, [data.txns, data.patterns, kind, code, revealed]);
  const view = useMemo(() => limitGroups(days, limit), [days, limit]);

  const undo = (g: Extract<LedgerGroup, { type: "txns" }>) => {
    const label = g.note || KIND_LABEL[g.kind];
    if (!window.confirm(`撤销这一组记录？\n${label}（${g.txns.length} 条）\n库存会回到记录之前的数量。`)) return;
    const originals = g.txns;
    setRevealed((cur) => new Map([...cur, ...originals.map((t) => [t.id, t] as const)]));
    void softDelete("txns", originals.map((t) => t.id));
    setSay(`已撤销 ${originals.length} 条记录，可在原位置恢复`);
    toast(`已撤销 ${originals.length} 条记录`, { label: "恢复", run: () => restore(originals) });
  };
  const restore = (originals: Txn[]) => {
    const at = Date.now();
    void putRecords("txns", originals.map((t) => ({ ...t, deleted: undefined, updatedAt: at + 1 }))).then(() => {
      setRevealed((cur) => { const n = new Map(cur); originals.forEach((t) => n.delete(t.id)); return n; });
      setSay(`已恢复 ${originals.length} 条记录`);
    });
  };
  const exportCsv = () => downloadText("拼豆库存流水.csv", countsToCsv(txnsToCsvRows(data.txns), [["time", "时间"], ["code", "色号"], ["delta", "数量"], ["kind", "类型"], ["unitPrice", "单价"], ["note", "备注"], ["batch", "批次"]]), "text/csv;charset=utf-8");

  return (
    <div>
      <div className="page-head">
        <div><h1>记录</h1><p>每一次入库、消耗和盘点都在这里，库存就是这些记录的总和。</p></div>
        <button className="btn" disabled={!data.txns.length} onClick={exportCsv}><Icon name="download" />导出流水 CSV</button>
      </div>

      <div className="row" style={{ marginBottom: 8 }}>
        <div style={{ overflowX: "auto", maxWidth: "100%" }}><div className="seg" role="group" aria-label="类型">
          {KINDS.map(([id, label]) => <button key={id} style={{ whiteSpace: "nowrap" }} aria-pressed={kind === id} onClick={() => { setKind(id); setLimit(PAGE); }}>{label}</button>)}
        </div></div>
        <input className="input" style={{ width: 140 }} type="search" placeholder="按色号筛选" aria-label="按色号筛选" value={code} onChange={(e) => { setCode(e.target.value); setLimit(PAGE); }} />
      </div>

      <div className="sr-only" role="status" aria-live="polite">{say}</div>
      {!view.total ? (
        <div className="panel empty pegboard">
          <h3>{data.txns.length || data.patterns.length ? "没有符合条件的记录" : "还没有记录"}</h3>
          <p>{data.txns.length || data.patterns.length ? "换个类型或色号试试。" : "入库、完成图纸、盘点之后，这里会按天排好。"}</p>
        </div>
      ) : (
        <div>
          {view.days.map((day) => (
            <section key={day.day}>
              <h2 className="hist-day">{day.label}<span>{day.groups.length} 组</span></h2>
              <div className="panel">
                {day.groups.map((g) => g.type === "pattern" ? (
                  <div className="hist-group" key={g.key}>
                    <span className="hist-bar pattern" />
                    <div className="hist-main">
                      <div className="hist-top"><span className="chip">新图纸</span><a href={`#/pattern/${g.pattern.id}`} style={{ fontWeight: 600, color: "inherit" }}>{g.pattern.name}</a><span className="spacer" /><span className="meta">{fmtTime(g.at)}</span></div>
                      <div className="meta">{METHOD_LABEL[g.pattern.method]} · {Object.keys(g.pattern.counts).length} 色 · {fmt(totalOf(g.pattern.counts))} 颗</div>
                    </div>
                  </div>
                ) : <TxnGroup key={g.key} g={g} onUndo={() => undo(g)} onRestore={() => restore(g.txns)} />)}
              </div>
            </section>
          ))}
          {view.shown < view.total ? (
            <div className="row" style={{ justifyContent: "center", marginTop: 16 }}>
              <button className="btn" onClick={() => setLimit((l) => l + PAGE)}>显示更多（还有 {view.total - view.shown} 组）</button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function TxnGroup({ g, onUndo, onRestore }: { g: Extract<LedgerGroup, { type: "txns" }>; onUndo: () => void; onRestore: () => void }) {
  const [open, setOpen] = useState(false);
  if (g.undone) {
    return (
      <div className="hist-group hist-undone">
        <span className="hist-bar" />
        <div className="hist-main hist-undone-row">
          <span className="meta">已撤销：{g.note || KIND_LABEL[g.kind]} · {g.txns.length} 条 · 库存已回退</span>
          <button className="btn btn-sm" onClick={onRestore}>恢复</button>
        </div>
      </div>
    );
  }
  const preview = g.txns.slice(0, 6);
  const price = g.txns.reduce((a, t) => a + (t.unitPrice ? t.unitPrice * t.delta : 0), 0);
  const panelId = `hist-d-${g.key}`;
  return (
    <div className="hist-group">
      <span className={`hist-bar ${g.kind}`} />
      <div className="hist-main">
        <div className="hist-top">
          <span className={`chip ${g.kind === "purchase" ? "chip-leaf" : g.kind === "consume" ? "chip-iron" : "chip-amber"}`}>{KIND_LABEL[g.kind]}</span>
          <span className={`hist-delta ${signCls(g)}`}>{g.delta > 0 ? "+" : g.delta < 0 ? "−" : "±"}{fmt(Math.abs(g.delta))} 颗</span>
          <span className="meta">{g.codes} 色{price > 0 ? ` · ¥${price.toFixed(2)}` : ""}</span>
          <span className="spacer" /><span className="meta">{fmtTime(g.at)}</span>
          <button className="btn btn-ghost btn-sm" onClick={onUndo} aria-label="撤销这一组"><Icon name="trash" />撤销</button>
        </div>
        {g.note ? <div className="hist-note">{g.note}</div> : null}
        {g.txns.length > 1 || g.txns.some((t) => t.unitPrice) ? (
          <button className="hist-expand" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(!open)}>
            <span className="hist-chips" aria-hidden={open}>
              {preview.map((t) => <span className="hist-chip" key={t.id}><Bead code={t.code} size={16} /><span className="code">{t.code}</span><span className={t.delta > 0 ? "sk-pos" : "sk-neg"}>{t.delta > 0 ? "+" : "−"}{fmt(Math.abs(t.delta))}</span></span>)}
            </span>
            <span className="hist-more"><span className="hist-caret" aria-hidden="true"><Icon name="chevron" size={14} /></span>{open ? "收起明细" : g.txns.length > preview.length ? `展开全部 ${g.txns.length} 条` : "展开明细"}</span>
          </button>
        ) : (
          <div className="hist-chips">{preview.map((t) => <span className="hist-chip" key={t.id}><Bead code={t.code} size={16} /><span className="code">{t.code}</span><span className={t.delta > 0 ? "sk-pos" : "sk-neg"}>{t.delta > 0 ? "+" : "−"}{fmt(Math.abs(t.delta))}</span></span>)}</div>
        )}
        {open ? (
          <ul id={panelId} className="hist-detail">
            {g.txns.map((t) => (
              <li key={t.id}>
                <Bead code={t.code} size={18} /><span className="code hist-dc">{t.code}</span><span className="meta hist-dn">{colorOf(t.code)?.nameZh}</span>
                {t.unitPrice ? <span className="meta num">¥{(t.unitPrice * t.delta).toFixed(2)}</span> : null}
                <span className={`num hist-dq ${t.delta > 0 ? "sk-pos" : "sk-neg"}`}>{t.delta > 0 ? "+" : "−"}{fmt(Math.abs(t.delta))}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
