// 焦点：建议购买清单——能直接复制去下单，买回来后一键入库。
// 2026-11-06：增加净需求 / 含损耗 / 整包 / 真实报价成本，并支持从采购方案页带入每色购买量。
import { useEffect, useMemo, useRef, useState } from "react";
import { Bead, Icon, Sheet, fmt, toast, DiffNumber, prefersReducedMotion, useRoute } from "../components/ui";
import { useData, putRecords } from "../lib/db";
import { countsToCsv, demandByCode, isActive, shoppingList, stockByCode, type ShoppingRow } from "../lib/inventory";
import { colorOf } from "../lib/palette";
import { totalOf } from "../lib/model";
import { excludeForTag, shareText } from "../lib/stockview";
import { commitPurchase } from "../components/stock/actions";
import { copyText, downloadText } from "../components/stock/download";
import {
  addPacks, applyPlanToEdits, buildPurchasePlans, estimateCostForRows, formatMoney, formatPacks, optimizePacks, type PurchasePlan, type PurchasePlanItem
} from "../lib/purchase";
import "./Shopping.css";

export default function Shopping() {
  const data = useData();
  const active = useMemo(() => data.patterns.filter(isActive), [data.patterns]);
  const route = useRoute();
  const [onlyTag, setOnlyTag] = useState(route.query.get("tag") ?? "");
  const [onlyVerified, setOnlyVerified] = useState(route.query.get("verified") === "1");
  const [manual, setManual] = useState<Set<string>>(new Set());
  const [planCleared, setPlanCleared] = useState(false);
  const [applied, setApplied] = useState<PurchasePlan | null>(null);
  useEffect(() => {
    setOnlyTag(route.query.get("tag") ?? "");
    setOnlyVerified(route.query.get("verified") === "1");
    setPlanCleared(false);
  }, [route.query]);

  const scoped = useMemo(() => active.filter((p) => !onlyVerified || p.verifiedAt != null), [active, onlyVerified]);
  const tagsInPlan = useMemo(() => Array.from(new Set(scoped.flatMap((p) => p.tags))).sort(), [scoped]);
  // “只算某个标签”：不带该标签的计划图纸一律不计入；手动勾选在其基础上微调
  const excluded = useMemo(() => (onlyTag ? new Set([...excludeForTag(scoped, onlyTag), ...manual]) : manual), [scoped, onlyTag, manual]);
  const [loss, setLoss] = useState(String(Math.round(data.prefs.lossRate * 1000) / 10));
  const [pack, setPack] = useState(String(data.prefs.packSize));
  const [includeLow, setIncludeLow] = useState(true);
  const [edits, setEdits] = useState<Record<string, number>>({});
  const [receive, setReceive] = useState(false);

  const prefs = useMemo(() => ({ ...data.prefs, lossRate: Math.max(0, Number(loss) || 0) / 100, packSize: Math.max(1, Math.round(Number(pack)) || 1) }), [data.prefs, loss, pack]);
  const stock = useMemo(() => stockByCode(data.txns), [data.txns]);
  const demand = useMemo(() => demandByCode(data.patterns, (p) => isActive(p) && (!onlyVerified || !!p.verifiedAt) && !excluded.has(p.id)), [data.patterns, onlyVerified, excluded]);
  const need = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [code, n] of Object.entries(demand)) out[code] = Math.ceil(n * (1 + prefs.lossRate));
    return out;
  }, [demand, prefs.lossRate]);
  const rows = useMemo(() => shoppingList(stock, demand, prefs, includeLow), [stock, demand, prefs, includeLow]);
  const qtyOf = (code: string, buy: number) => edits[code] ?? buy;
  const items = rows.map((r) => ({ code: r.code, qty: qtyOf(r.code, r.buy) })).filter((r) => r.qty > 0);
  const total = items.reduce((a, r) => a + r.qty, 0);
  const net = totalOf(demand);
  const withLoss = totalOf(need);
  const colorCount = Object.keys(demand).filter((code) => (demand[code] ?? 0) > 0).length;
  const shortfallTotal = rows.filter((r) => r.reason === "shortfall").reduce((sum, r) => sum + qtyOf(r.code, r.buy), 0);
  const surplus = Math.max(0, shortfallTotal - withLoss);
  // 应用方案后，套装价不能按“每色单买”重算；只有用户改过数量才回退到逐色报价。
  const planItems = applied?.items.filter((item) => item.totalBeads > 0) ?? [];
  const planUnchanged = !!applied && planItems.every((item) => (edits[item.code] ?? 0) === item.totalBeads);
  const planCodes = new Set(planItems.map((item) => item.code));
  const planItemByCode = useMemo(() => new Map<string, PurchasePlanItem>((applied?.items ?? []).map((item) => [item.code, item] as const)), [applied]);
  const extraCost = planUnchanged ? estimateCostForRows(items.filter((item) => !planCodes.has(item.code))) : null;
  const cost = planUnchanged && applied && extraCost
    ? { cost: applied.totalCost + extraCost.cost, beads: applied.totalBeads + extraCost.beads, packs: addPacks(applied.packs, extraCost.packs) }
    : estimateCostForRows(items);
  // 套装方案下，逐行成本只显示“补充包”部分；套装价已经计入顶部方案成本。
  const rowCost = (code: string, qty: number) => {
    const item = planUnchanged ? planItemByCode.get(code) : undefined;
    return item ? { cost: item.singlesCost, packs: item.packs } : optimizePacks(qty, code);
  };
  const unverifiedCount = useMemo(() => active.filter((p) => (!onlyVerified || p.verifiedAt != null) && !excluded.has(p.id) && p.verifiedAt == null).length, [active, onlyVerified, excluded]);
  const verifiedCount = useMemo(() => active.filter((p) => p.verifiedAt != null).length, [active]);

  // ?plan= 从采购方案页带入：把每色购买量写进 edits；用户手动改损耗/包装/标签后清除。
  const planId = route.query.get("plan");
  const plans = useMemo(() => (planId ? buildPurchasePlans(need, demand) : []), [planId, need, demand]);
  useEffect(() => {
    if (planCleared || !planId) return;
    const plan = plans.find((p) => p.id === planId);
    if (!plan) return;
    setEdits(applyPlanToEdits(plan));
    setApplied(plan);
  }, [planId, plans, planCleared]);
  const resetEdits = () => { setEdits({}); setApplied(null); setPlanCleared(true); };

  // 买回来后：库存变了而从清单里消失的行，留 900ms 打上“已买到”再收起
  const [ghosts, setGhosts] = useState<Array<{ row: ShoppingRow; at: number }>>([]);
  const [say, setSay] = useState("");
  const seen = useRef<{ rows: ShoppingRow[]; stock: Record<string, number> }>({ rows, stock });
  useEffect(() => {
    if (receive) return; // 入库抽屉开着时冻结清单，关掉后再播“已买到”
    const before = seen.current;
    seen.current = { rows, stock };
    if (prefersReducedMotion()) return;
    const now = new Set(rows.map((r) => r.code));
    const gone = before.rows.map((r, at) => ({ row: r, at })).filter(({ row }) => !now.has(row.code) && (stock[row.code] ?? 0) > (before.stock[row.code] ?? 0));
    if (!gone.length) return;
    setGhosts(gone);
    setSay(`${gone.length} 个色号已买到，从清单里移除`);
    const t = window.setTimeout(() => setGhosts([]), 1000);
    return () => window.clearTimeout(t);
  }, [rows, stock, receive]);
  const view: Array<{ row: ShoppingRow; done: boolean }> = (receive ? seen.current.rows : rows).map((row) => ({ row, done: false }));
  for (const g of ghosts) view.splice(Math.min(g.at, view.length), 0, { row: g.row, done: true });

  const toggle = (id: string) => setManual((cur) => { const n = new Set(cur); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const pickTag = (t: string) => { setOnlyTag(t); setManual(new Set()); setEdits({}); setApplied(null); setPlanCleared(true); };
  const toggleVerified = (on: boolean) => { setOnlyVerified(on); setManual(new Set()); setEdits({}); setApplied(null); setPlanCleared(true); };
  const copy = async () => toast((await copyText(shareText(items))) ? "已复制采购文本" : "复制失败，请手动选择文字");
  const csv = () => {
    const out = rows.map((r) => {
      const qty = qtyOf(r.code, r.buy);
      return { code: r.code, name: colorOf(r.code)?.nameZh ?? "", need: r.needWithLoss, stock: r.stock, shortfall: r.shortfall, buy: qty, cost: rowCost(r.code, qty).cost.toFixed(2) };
    });
    downloadText("采购清单.csv", countsToCsv(out, [["code", "色号"], ["name", "颜色"], ["need", "需要(含损耗)"], ["stock", "库存"], ["shortfall", "缺口"], ["buy", "建议购买"], ["cost", "预计成本(元)"]]), "text/csv;charset=utf-8");
  };
  const saveDefaults = async () => {
    await putRecords("prefs", [{ ...data.prefs, lossRate: prefs.lossRate, packSize: prefs.packSize, updatedAt: Date.now() }]);
    toast("已存为默认损耗率和包装规格");
  };

  return (
    <div>
      <div className="page-head">
        <div><h1>采购清单</h1><p>按计划做 / 制作中的图纸算出缺口，再按真实报价估算成本。</p></div>
      </div>

      {applied ? (
        <div className="notice shop-plan-note" role="status">
          <span><b>已应用方案：{applied.name}</b> · 预计 {formatMoney(applied.totalCost)} · {formatPacks(applied.packs)}</span>
          <span className="spacer" />
          <button type="button" className="btn btn-sm btn-ghost" onClick={resetEdits}>清除方案</button>
        </div>
      ) : null}

      <section className="panel shop-hero pegboard" aria-label="采购汇总">
        <div className="shop-hero-main">
          <div className="label">清单合计（整包）</div>
          <div className="big"><DiffNumber value={total} /> <span className="meta">颗 · {items.length} 色</span></div>
          <div className="shop-kpis">
            <span>净需求 <b className="num">{fmt(net)}</b> 颗 · {colorCount} 色</span>
            <span>含损耗 <b className="num">{fmt(withLoss)}</b> 颗</span>
            <span>整包多出 <b className="num">{fmt(surplus)}</b> 颗{withLoss ? `（${Math.round((surplus / withLoss) * 100)}%）` : ""}</span>
            <span>{planUnchanged ? "方案成本" : "预计成本"} <b className="num">{formatMoney(cost.cost)}</b></span>
          </div>
        </div>
        <span className="spacer" />
        <div className="row shop-actions">
          <a className="btn" href={onlyVerified ? "#/purchase?verified=1" : "#/purchase"}><Icon name="sparkle" />对比采购方案</a>
          <button className="btn" disabled={!items.length} onClick={copy}><Icon name="copy" />复制采购文本</button>
          <button className="btn" disabled={!rows.length} onClick={csv}><Icon name="download" />导出 CSV</button>
          <button className="btn btn-iron" disabled={!items.length} onClick={() => setReceive(true)}><Icon name="check" />买回来了 → 入库</button>
        </div>
      </section>

      {unverifiedCount ? (
        <div className="notice" role="note">
          <span><b>{unverifiedCount} 张</b>计入的图纸尚未核对，数量与成本可能偏差。</span>
          <span className="spacer" />
          <a className="btn btn-sm" href="#/gallery?verify=unverified">去图库核对</a>
        </div>
      ) : null}

      <div className="shop-opts">
        <section className="panel panel-pad">
          <span className="label">计入哪些图纸</span>
          {tagsInPlan.length ? (
            <div className="shop-tags" role="group" aria-label="只算某个合集">
              <button type="button" className="chip shop-tag" aria-pressed={!onlyTag} onClick={() => pickTag("")}>全部</button>
              {tagsInPlan.map((t) => <button type="button" key={t} className="chip shop-tag" aria-pressed={onlyTag === t} onClick={() => pickTag(t)}>只算{t}</button>)}
            </div>
          ) : null}
          {active.length ? (
            <div className="shop-pats" style={{ marginTop: 6 }}>
              {active.map((p) => {
                const offByVerify = onlyVerified && p.verifiedAt == null;
                return (
                  <label key={p.id} className={offByVerify ? "is-off" : undefined}>
                    <input type="checkbox" checked={!offByVerify && !excluded.has(p.id)} disabled={offByVerify} onChange={() => toggle(p.id)} />
                    <span className="n">{p.name}</span>
                    {p.verifiedAt == null ? <span className="chip chip-amber pt-unverified">未核对</span> : null}
                    <span className="meta num">×{Math.max(1, p.copies || 1)} 份</span>
                  </label>
                );
              })}
            </div>
          ) : <p className="meta" style={{ marginTop: 6 }}>没有“计划做 / 制作中”的图纸。到图库把图纸标成计划做，这里就会算出缺口。</p>}
        </section>
        <section className="panel panel-pad stack">
          <div className="shop-ctl">
            <label className="field"><span>损耗率（%）</span><input className="input num" type="number" inputMode="decimal" min={0} value={loss} onChange={(e) => { setLoss(e.target.value); resetEdits(); }} /></label>
            <label className="field"><span>包装规格（颗/包）</span><input className="input num" type="number" inputMode="numeric" min={1} value={pack} onChange={(e) => { setPack(e.target.value); resetEdits(); }} /></label>
          </div>
          <label className="row" style={{ minHeight: 28 }}><input className="shop-check" type="checkbox" checked={includeLow} onChange={(e) => setIncludeLow(e.target.checked)} />包含补货提醒（库存低于最低库存的色号）</label>
          <label className="row" style={{ minHeight: 28 }}><input className="shop-check" type="checkbox" checked={onlyVerified} onChange={(e) => toggleVerified(e.target.checked)} disabled={!verifiedCount} />只算已核对（{verifiedCount} 张）</label>
          <div className="row"><button className="btn btn-sm" onClick={saveDefaults}>存为默认</button></div>
          {cost.packs.p500 > 0 && cost.packs.p500 < 10 ? <p className="meta">500 颗包只有 {cost.packs.p500} 包；需满 10 包才能备注色号。</p> : null}
        </section>
      </div>

      {view.length ? (
        <section className="panel">
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>色号</th><th className="r">需要(含损耗)</th><th className="r">库存</th><th className="r">缺口</th><th className="r">建议购买</th><th className="r">{planUnchanged && applied?.setOffer ? "补充包成本" : "预计成本"}</th><th>原因</th></tr></thead>
              <tbody>
                {view.map(({ row: r, done }) => {
                  if (done) return (
                    <tr key={r.code} className="shop-done">
                      <td><span className="bead-code"><Bead code={r.code} /><span className="code">{r.code}</span></span></td>
                      <td colSpan={6}><span className="shop-done-tag"><Icon name="check" size={16} />已买到，已入库</span></td>
                    </tr>
                  );
                  const qty = qtyOf(r.code, r.buy);
                  const item = planUnchanged ? planItemByCode.get(r.code) : undefined;
                  const est = rowCost(r.code, qty);
                  const costTitle = item ? (item.setCovered ? `套装覆盖 1200 颗；补充包 ${formatPacks(item.packs)}` : `补充包 ${formatPacks(item.packs)}`) : formatPacks(est.packs);
                  return (
                    <tr key={r.code}>
                      <td><span className="bead-code"><Bead code={r.code} /><span className="code">{r.code}</span></span></td>
                      <td className="r">{r.needWithLoss ? fmt(r.needWithLoss) : "—"}</td>
                      <td className="r">{fmt(r.stock)}</td>
                      <td className="r" style={{ color: r.shortfall ? "var(--iron-ink)" : undefined }}>{r.shortfall ? fmt(r.shortfall) : "—"}</td>
                      <td className="r"><input className="input num shop-buy" type="number" inputMode="numeric" min={0} aria-label={`${r.code} 建议购买`} value={qty} onChange={(e) => setEdits((cur) => ({ ...cur, [r.code]: Math.max(0, Math.round(Number(e.target.value)) || 0) }))} /></td>
                      <td className="r" title={costTitle}>{formatMoney(est.cost)}</td>
                      <td>{r.reason === "shortfall" ? <span className="chip chip-iron">缺货</span> : <span className="chip chip-amber">补货</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : active.length && onlyVerified && scoped.length === 0 ? (
        <div className="panel empty pegboard">
          <h3>没有已核对的图纸</h3>
          <p>先把图库里的图纸标为“已核对”，或关掉“只算已核对”。</p>
          <a className="btn" href="#/gallery?verify=unverified">去图库核对</a>
        </div>
      ) : active.length ? (
        <div className="panel empty shop-ok"><span style={{ color: "var(--leaf)" }}><Icon name="check" size={28} /></span><h3>库存够做全部计划</h3><p>{excluded.size ? "已勾选的图纸都够用。" : "没有需要补的色号，可以直接开工。"}</p></div>
      ) : (
        <div className="panel empty pegboard"><h3>还没有要做的图纸</h3><p>把图纸标为“计划做”，这里会列出要买什么。</p><a className="btn" href="#/gallery">去图库</a></div>
      )}

      <div className="sr-only" role="status" aria-live="polite">{say}</div>
      {receive ? <ReceiveSheet items={items} onClose={() => setReceive(false)} onDone={() => setEdits({})} remaining={Math.max(0, rows.length)} /> : null}
    </div>
  );
}

function ReceiveSheet({ items, onClose, onDone, remaining }: { items: Array<{ code: string; qty: number }>; onClose: () => void; onDone: () => void; remaining: number }) {
  const [rows, setRows] = useState(items.map((i) => ({ ...i, on: true, q: String(i.qty) })));
  const [total, setTotal] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Array<{ code: string; qty: number }> | null>(null);
  const chosen = rows.filter((r) => r.on).map((r) => ({ code: r.code, qty: Math.round(Number(r.q)) || 0 })).filter((r) => r.qty > 0);
  const sum = chosen.reduce((a, r) => a + r.qty, 0);
  const doneBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (result) doneBtn.current?.focus(); }, [result]);

  if (result) {
    const beads = result.reduce((a, r) => a + r.qty, 0);
    return (
      <Sheet title="已入库" onClose={onClose} footer={<button ref={doneBtn} className="btn btn-iron" onClick={onClose}>完成</button>}>
        <div className="shop-sum" role="status">
          <span className="shop-sum-ic"><Icon name="check" size={28} /></span>
          <h3>入库 {result.length} 色 · {fmt(beads)} 颗</h3>
          <p className="meta">{remaining ? `采购清单还剩 ${remaining} 个色号没买齐。` : "采购清单已清空，可以开工了。"} 操作可以在底部提示里撤销。</p>
          <div className="shop-chips" style={{ justifyContent: "center" }}>
            {result.map((r) => <span className="shop-chip" key={r.code}><Bead code={r.code} size={16} /><span className="code">{r.code}</span><span className="sk-pos">+{fmt(r.qty)}</span></span>)}
          </div>
        </div>
      </Sheet>
    );
  }
  return (
    <Sheet title="买回来了 → 入库" onClose={onClose} footer={
      <>
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn btn-iron" disabled={!chosen.length || busy} onClick={async () => { setBusy(true); try { await commitPurchase(chosen, { note, totalPrice: Number(total) || undefined }); onDone(); setResult(chosen); } finally { setBusy(false); } }}>
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
