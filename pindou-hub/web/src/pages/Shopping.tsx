// 焦点：建议购买清单——能直接复制去下单，买回来后一键入库。
// 2026-11-06：增加净需求 / 含损耗 / 整包 / 真实报价成本，并支持从采购方案页带入每色购买量。
import { useEffect, useMemo, useRef, useState } from "react";
import { Bead, Icon, Sheet, fmt, toast, DiffNumber, prefersReducedMotion, useRoute } from "../components/ui";
import { useData, putRecords } from "../lib/db";
import { countsToCsv, demandByCode, isActive, needAfterStock, shoppingList, stockByCode, withLoss as applyLoss, type ShoppingRow } from "../lib/inventory";
import { colorOf } from "../lib/palette";
import { totalOf } from "../lib/model";
import { OrdersSection } from "../components/orders/OrdersSection";
import { cancelOne, recordPlacedOrder, useOrders } from "../components/orders/store";
import { isOpen, statusOf, subtractTransit, sumCounts, transitByCode } from "../lib/orders";
import { excludeForTag, shareText } from "../lib/stockview";
import { commitPurchase } from "../components/stock/actions";
import { normalizePrice1200, price1200Of } from "../lib/forecast";
import { PriceNote } from "../components/stock/PriceNote";
import { allocatePrices, parseFen } from "../lib/pricing";
import { copyText, downloadText } from "../components/stock/download";
import {
  addPacks, applyPlanToEdits, buildPurchasePlans, estimateCostForRows, formatMoney, formatPacks, optimizePacks,
  type PurchasePlan, type PurchasePlanItem
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
  const [packSizes, setPackSizes] = useState<Record<string, number>>(() => ({ ...(data.prefs.packSizes ?? {}) }));
  const [mode, setMode] = useState<"pack" | "net">("pack");
  const [patQuery, setPatQuery] = useState("");
  const [showAllPats, setShowAllPats] = useState(false);
  const [includeLow, setIncludeLow] = useState(true);
  const [edits, setEdits] = useState<Record<string, number>>({});
  const [receive, setReceive] = useState(false);
  const [openRows, setOpenRows] = useState<Set<string>>(new Set());
  const [kept, setKept] = useState(0);
  const prefsRef = useRef(data.prefs);
  prefsRef.current = data.prefs;
  // 在途订单：从缺口里扣掉“已在路上”的，避免重复买；开关只影响这台设备的显示
  const { orders, live } = useOrders();
  const transit = useMemo(() => transitByCode(orders, live), [orders, live]);
  const transitTotal = sumCounts(transit);
  const [subtract, setSubtract] = useState(() => { try { return localStorage.getItem("ph.shop.subtractTransit") !== "0"; } catch { return true; } });
  const pickSubtract = (on: boolean) => { setSubtract(on); try { localStorage.setItem("ph.shop.subtractTransit", on ? "1" : "0"); } catch { /* 本次仍然生效 */ } };
  useEffect(() => {
    if (!kept) return;
    const t = window.setTimeout(() => setKept(0), 8000);
    return () => window.clearTimeout(t);
  }, [kept]);

  const prefs = useMemo(() => ({ ...data.prefs, lossRate: Math.max(0, Number(loss) || 0) / 100, packSize: Math.max(1, Math.round(Number(pack)) || 1) }), [data.prefs, loss, pack]);
  // 1200 颗装单价：链接上的 p1200 优先（旧链接继续有效）；没有就用偏好里记住的单价，
  // 这样采购页、采购清单、补货预告三处的金额一致
  const p1200Param = route.query.get("p1200");
  const p1200 = p1200Param != null ? normalizePrice1200(p1200Param) : price1200Of(data.prefs);
  const inventoryReady = !!data.prefs.inventoryStartedAt || data.txns.some((t) => !t.deleted);
  const stock = useMemo(() => stockByCode(data.txns), [data.txns]);
  const demand = useMemo(() => demandByCode(data.patterns, (p) => isActive(p) && (!onlyVerified || !!p.verifiedAt) && !excluded.has(p.id)), [data.patterns, onlyVerified, excluded]);
  const need = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [code, n] of Object.entries(demand)) out[code] = applyLoss(n, prefs.lossRate);
    return out;
  }, [demand, prefs.lossRate]);
  const packOf = (code: string) => Math.max(1, Math.round(packSizes[code] ?? prefs.packSize));
  // 把在途数量当作“已经到手”的库存来算缺口；表格里“库存”仍显示真实库存
  const stockPlus = useMemo(() => {
    if (!subtract || !transitTotal) return stock;
    const out = { ...stock };
    for (const [code, n] of Object.entries(transit)) out[code] = Math.max(0, out[code] ?? 0) + n;
    return out;
  }, [stock, transit, transitTotal, subtract]);
  const buildRows = (stockMap: Record<string, number>) => shoppingList(stockMap, demand, prefs, includeLow).map((row) => {
    const real = { ...row, stock: stock[row.code] ?? 0 };
    if (mode === "net") return row.shortfall > 0 ? { ...real, buy: row.shortfall } : real;
    const size = Math.max(1, Math.round(packSizes[row.code] ?? prefs.packSize));
    return row.shortfall > 0 ? { ...real, buy: Math.ceil(row.shortfall / size) * size } : real;
  });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const rows = useMemo(() => buildRows(stockPlus), [stockPlus, stock, demand, prefs, includeLow, mode, packSizes]);
  // 在途订单实际抵掉了多少缺口（按“不扣在途”的清单算，开关开不开数字都一样）
  const transitCovered = useMemo(() => {
    if (!transitTotal) return 0;
    const gap: Record<string, number> = {};
    for (const r of shoppingList(stock, demand, prefs, includeLow)) if (r.shortfall > 0) gap[r.code] = r.shortfall;
    return subtractTransit(gap, transit).coveredTotal;
  }, [transitTotal, transit, stock, demand, prefs, includeLow]);
  const qtyOf = (code: string, buy: number) => edits[code] ?? buy;
  const items = rows.map((r) => ({ code: r.code, qty: qtyOf(r.code, r.buy) })).filter((r) => r.qty > 0);
  const total = items.reduce((a, r) => a + r.qty, 0);
  const net = totalOf(demand);
  const withLoss = totalOf(need);
  const colorCount = Object.keys(demand).filter((code) => (demand[code] ?? 0) > 0).length;
  const shortfallTotal = rows.filter((r) => r.reason === "shortfall").reduce((sum, r) => sum + qtyOf(r.code, r.buy), 0);
  // 整包多出 = 每个缺货行实际买的 − 真正的缺口（已扣库存）
  const surplus = rows.filter((r) => r.reason === "shortfall").reduce((sum, r) => sum + Math.max(0, qtyOf(r.code, r.buy) - r.shortfall), 0);
  // 应用方案后，套装价不能按“每色单买”重算；只有用户改过数量才回退到逐色报价。
  const planItems = applied?.items.filter((item) => item.totalBeads > 0) ?? [];
  const planUnchanged = !!applied && planItems.every((item) => (edits[item.code] ?? 0) === item.totalBeads);
  const planCodes = new Set(planItems.map((item) => item.code));
  const planItemByCode = useMemo(() => new Map<string, PurchasePlanItem>((applied?.items ?? []).map((item) => [item.code, item] as const)), [applied]);
  const extraCost = planUnchanged ? estimateCostForRows(items.filter((item) => !planCodes.has(item.code)), p1200) : null;
  const cost = planUnchanged && applied && extraCost
    ? { cost: applied.totalCost + extraCost.cost, beads: applied.totalBeads + extraCost.beads, packs: addPacks(applied.packs, extraCost.packs) }
    : estimateCostForRows(items, p1200);
  // 套装方案下，逐行成本只显示“补充包”部分；套装价已经计入顶部方案成本。
  const showPackCol = mode === "pack" && !planUnchanged;
  const rowCost = (code: string, qty: number) => {
    const item = planUnchanged ? planItemByCode.get(code) : undefined;
    return item ? { cost: item.singlesCost, packs: item.packs } : optimizePacks(qty, code, p1200);
  };
  const unverifiedCount = useMemo(() => active.filter((p) => (!onlyVerified || p.verifiedAt != null) && !excluded.has(p.id) && p.verifiedAt == null).length, [active, onlyVerified, excluded]);
  const verifiedCount = useMemo(() => active.filter((p) => p.verifiedAt != null).length, [active]);
  const patMatches = useMemo(() => {
    const q = patQuery.trim().toLowerCase();
    return q ? active.filter((p) => p.name.toLowerCase().includes(q) || p.tags.some((t) => t.toLowerCase().includes(q))) : active;
  }, [active, patQuery]);
  const visiblePats = showAllPats || patMatches.length <= 12 ? patMatches : patMatches.slice(0, 12);
  // 分系列买 vs 一次买齐：同一色号在两个系列都出现时，分开买会各取整一次
  const splitHint = useMemo(() => {
    if (applied || tagsInPlan.length < 2 || Object.keys(stock).length) return null;
    const base = scoped.filter((p) => !manual.has(p.id));
    const costFor = (d: Record<string, number>) => estimateCostForRows(Object.entries(d).map(([code, n]) => ({ code, qty: applyLoss(n, prefs.lossRate) })), p1200).cost;
    // 按“主标签”分组，保证每张图纸只算一次（多标签的图纸不会被重复计入）
    const groups = new Map<string, typeof base>();
    for (const p of base) {
      const key = p.tags[0] || "未分组";
      groups.set(key, [...(groups.get(key) ?? []), p]);
    }
    const separate = [...groups.values()].reduce((sum, ps) => sum + costFor(demandByCode(ps)), 0);
    const together = costFor(demand);
    return separate > together + 0.01 ? { separate, together, extra: separate - together } : null;
  }, [applied, tagsInPlan, scoped, manual, prefs, stock, demand, p1200]);

  // ?plan= 从采购方案页带入：把每色购买量写进 edits；用户手动改损耗/包装/标签后清除。
  const planId = route.query.get("plan");
  const planNeed = useMemo(() => needAfterStock(demand, inventoryReady || (subtract && transitTotal > 0) ? stockPlus : {}, prefs.lossRate), [demand, stockPlus, inventoryReady, subtract, transitTotal, prefs.lossRate]);
  const plans = useMemo(() => (planId ? buildPurchasePlans(planNeed, demand, p1200) : []), [planId, planNeed, demand, p1200]);
  // 每个 planId 只应用一次：之后 plans 因勾选图纸等重算，不能覆盖用户手动改过的数量
  const appliedPlanId = useRef<string | null>(null);
  useEffect(() => {
    if (planCleared) { appliedPlanId.current = null; return; }
    if (!planId || !data.ready || appliedPlanId.current === planId) return;
    const plan = plans.find((p) => p.id === planId);
    if (!plan) return;
    appliedPlanId.current = planId;
    setEdits(applyPlanToEdits(plan));
    setApplied(plan);
    setMode("pack");
  }, [planId, plans, planCleared, data.ready]);
  const resetEdits = () => { setEdits({}); setApplied(null); setPlanCleared(true); };
  // 改损耗率/默认包装只会重算“没手动改过”的行；手动填的数量是绝对值，可以原样保留。
  // 已应用的采购方案是按旧损耗算的整体，不再成立，仍然清除。
  const keepManualEdits = () => {
    if (applied) { resetEdits(); return; }
    setKept(Object.keys(edits).length);
  };

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
  const copy = async () => {
    const ok = await copyText(shareText(items));
    if (!ok) { toast("复制失败，请手动选择文字"); return; }
    // 同时记为一张在途订单：到货后按订单入库，清单也会扣掉已在路上的
    try {
      const id = await recordPlacedOrder({ items, planId: applied?.id, cost: cost.cost });
      toast("已复制采购文本，并记为在途订单", id ? { label: "撤销", run: () => { void cancelOne(id, true); } } : undefined);
    } catch { toast("已复制采购文本，但没记成在途订单"); }
  };
  const toggleRow = (code: string) => setOpenRows((cur) => { const n = new Set(cur); if (n.has(code)) n.delete(code); else n.add(code); return n; });
  const csv = () => {
    const out = rows.map((r) => {
      const qty = qtyOf(r.code, r.buy);
      return { code: r.code, name: colorOf(r.code)?.nameZh ?? "", need: r.needWithLoss, stock: r.stock, shortfall: r.shortfall, buy: qty, cost: rowCost(r.code, qty).cost.toFixed(2) };
    });
    downloadText("采购清单.csv", countsToCsv(out, [["code", "色号"], ["name", "颜色"], ["need", "需要(含损耗)"], ["stock", "库存"], ["shortfall", "缺口"], ["buy", "建议购买"], ["cost", "预计成本(元)"]]), "text/csv;charset=utf-8");
  };
  const saveDefaults = async () => {
    await putRecords("prefs", [{ ...data.prefs, lossRate: prefs.lossRate, packSize: prefs.packSize, packSizes, updatedAt: Date.now() }]);
    toast("已存为默认损耗率、包装规格和逐色包装");
  };

  return (
    <div>
      <div className="page-head">
        <div><h1>采购清单</h1><p>按计划拼 / 制作中的图纸算出缺口，再按真实报价估算成本。</p></div>
      </div>

      {!inventoryReady ? (
        <div className="notice" role="note">
          <span><b>库存还没录入</b>：下面按净需求列出，“缺”不代表真的缺货。</span>
          <span className="spacer" />
          <a className="btn btn-sm" href="#/inventory">去录入现有豆子</a>
        </div>
      ) : null}

      {applied ? (
        <div className="notice shop-plan-note" role="status">
          <span><b>已应用方案：{applied.name}</b> · 预计 {formatMoney(applied.totalCost)} · {formatPacks(applied.packs)}</span>
          <span className="spacer" />
          <button type="button" className="btn btn-sm btn-ghost" onClick={resetEdits}>清除方案</button>
        </div>
      ) : null}

      <section className="panel shop-hero pegboard" aria-label="采购汇总">
        <div className="shop-hero-main">
          <div className="label">清单合计（{mode === "net" ? "净需求" : "整包"}）</div>
          <div className="big"><DiffNumber value={total} /> <span className="meta">颗 · {items.length} 色</span></div>
          <div className="shop-kpis">
            <span>净需求 <b className="num">{fmt(net)}</b> 颗 · {colorCount} 色</span>
            <span>含损耗 <b className="num">{fmt(withLoss)}</b> 颗</span>
            <span>整包多出 <b className="num">{fmt(surplus)}</b> 颗{shortfallTotal ? `（${Math.round((surplus / shortfallTotal) * 100)}%）` : ""}</span>
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

      {transitTotal > 0 ? (
        <div className="notice ord-transit" role="status" data-transit-note data-transit-subtracted={subtract}>
          <span>{transitCovered > 0
            ? <><b data-transit-covered>已在路上 {fmt(transitCovered)} 颗</b>{subtract ? "，已从下面的清单里扣掉，不会重复买。" : "，但下面的清单没有扣掉它们。"}</>
            : <>在途订单共 {fmt(transitTotal)} 颗，和现在的缺口对不上，清单没有变化。</>}</span>
          <span className="spacer" />
          <label><input type="checkbox" data-transit-toggle checked={subtract} onChange={(e) => pickSubtract(e.target.checked)} />扣掉在途订单</label>
        </div>
      ) : null}

      <OrdersSection />

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
          {splitHint ? <p className="meta shop-split">分系列各买各的约 <b>{formatMoney(splitHint.separate)}</b>；一次买齐约 <b>{formatMoney(splitHint.together)}</b>，省 {formatMoney(splitHint.extra)}（同一色号只取整一次）。</p> : null}
          {active.length ? (
            <>
              <div className="row shop-pat-tools" style={{ marginTop: 6 }}>
                <input className="input" type="search" placeholder={`搜索 ${active.length} 张图纸`} value={patQuery} onChange={(e) => setPatQuery(e.target.value)} aria-label="搜索图纸" />
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setManual(new Set())}>全选</button>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setManual(new Set(active.map((p) => p.id)))}>全不选</button>
              </div>
              <div className="shop-pats">
                {visiblePats.map((p) => {
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
              {patMatches.length > 12 ? <button type="button" className="btn btn-sm btn-ghost" onClick={() => setShowAllPats((v) => !v)}>{showAllPats ? "收起" : `展开全部 ${patMatches.length} 张`}</button> : null}
              {!patMatches.length ? <p className="meta">没有匹配的图纸。</p> : null}
            </>
          ) : <p className="meta" style={{ marginTop: 6 }}>没有“计划拼 / 制作中”的图纸。到图库把图纸标成计划拼，这里就会算出缺口。</p>}
        </section>
        <section className="panel panel-pad stack">
          <div className="seg" role="group" aria-label="买法">
            <button type="button" aria-pressed={mode === "pack"} onClick={() => { setMode("pack"); setEdits({}); setApplied(null); setPlanCleared(true); }}>按整包买</button>
            <button type="button" aria-pressed={mode === "net"} onClick={() => { setMode("net"); setEdits({}); setApplied(null); setPlanCleared(true); }}>按净需求买</button>
          </div>
          <div className="shop-ctl">
            <label className="field"><span>损耗率（%）</span><input className="input num" type="number" inputMode="decimal" min={0} value={loss} onChange={(e) => { setLoss(e.target.value); keepManualEdits(); }} /></label>
            <label className="field"><span>默认包装规格（颗/包）</span><input className="input num" type="number" inputMode="numeric" min={1} value={pack} onChange={(e) => { setPack(e.target.value); keepManualEdits(); }} disabled={mode === "net"} /></label>
          </div>
          {kept > 0 && !applied ? <p className="meta shop-kept" role="status">已保留你手动改过的 {kept} 个数量</p> : null}
          <p className="meta">{mode === "pack" ? "按整包向上取整，多出的整包会显示在顶部。" : "按实际缺口买，不按整包取整；成本仍按下单时的整包报价估算。"}</p>
          <label className="row" style={{ minHeight: 28 }}><input className="shop-check" type="checkbox" checked={includeLow} onChange={(e) => setIncludeLow(e.target.checked)} />包含补货提醒（库存低于最低库存的色号）</label>
          <label className="row" style={{ minHeight: 28 }}><input className="shop-check" type="checkbox" checked={onlyVerified} onChange={(e) => toggleVerified(e.target.checked)} disabled={!verifiedCount} />只算已核对（{verifiedCount} 张）</label>
          <div className="row"><button className="btn btn-sm" onClick={saveDefaults}>存为默认</button></div>
          {cost.packs.p500 > 0 && cost.packs.p500 < 10 ? <p className="meta">500 颗包只有 {cost.packs.p500} 包；需满 10 包才能备注色号。</p> : null}
        </section>
      </div>

      {view.length ? (
        <section className="panel">
          <div className="table-wrap shop-wrap">
            <table className="table shop-table">
              <thead><tr><th>色号</th><th className="r">需要(含损耗)</th><th className="r">库存</th><th className="r">缺口</th><th className="r">建议购买</th>{showPackCol ? <th className="r">包装(颗/包)</th> : null}<th className="r">{planUnchanged && applied?.setOffer ? "补充包成本" : "预计成本"}</th><th>原因</th></tr></thead>
              <tbody>
                {view.map(({ row: r, done }) => {
                  if (done) return (
                    <tr key={r.code} className="shop-done">
                      <td><span className="bead-code"><Bead code={r.code} /><span className="code">{r.code}</span></span></td>
                      <td colSpan={showPackCol ? 7 : 6}><span className="shop-done-tag"><Icon name="check" size={16} />已买到，已入库</span></td>
                    </tr>
                  );
                  const qty = qtyOf(r.code, r.buy);
                  const item = planUnchanged ? planItemByCode.get(r.code) : undefined;
                  const est = rowCost(r.code, qty);
                  const costTitle = item ? (item.setCovered ? `套装覆盖 1200 颗；补充包 ${formatPacks(item.packs)}` : `补充包 ${formatPacks(item.packs)}`) : formatPacks(est.packs);
                  const open = openRows.has(r.code);
                  return (
                    <tr key={r.code} className="shop-row" data-open={open}>
                      <td className="shop-c-code"><span className="bead-code"><Bead code={r.code} /><span className="code">{r.code}</span></span><button type="button" className="btn btn-sm btn-ghost shop-more" aria-expanded={open} aria-label={`${r.code} 库存和包装规格`} onClick={() => toggleRow(r.code)}>{open ? "收起" : "更多"}</button></td>
                      <td className="r shop-c-need" data-label="需要(含损耗)">{r.needWithLoss ? fmt(r.needWithLoss) : "—"}</td>
                      <td className="r shop-c-stock" data-label="库存">{fmt(r.stock)}{subtract && transit[r.code] ? <span className="shop-transit-tag" data-transit-row={r.code}><br />+在途 {fmt(transit[r.code])}</span> : null}</td>
                      <td className="r shop-c-short" data-zero={!r.shortfall} style={{ color: r.shortfall ? "var(--iron-ink)" : undefined }}>{r.shortfall ? fmt(r.shortfall) : "—"}</td>
                      <td className="r shop-c-buy"><input className="input num shop-buy" type="number" inputMode="numeric" min={0} aria-label={`${r.code} 建议购买`} value={qty} onChange={(e) => setEdits((cur) => ({ ...cur, [r.code]: Math.max(0, Math.round(Number(e.target.value)) || 0) }))} /></td>
                      {showPackCol ? <td className="r shop-c-pack" data-label="包装规格"><input className="input num shop-pack" type="number" inputMode="numeric" min={1} aria-label={`${r.code} 包装规格`} value={packOf(r.code)} onChange={(e) => { const n = Math.max(1, Math.round(Number(e.target.value)) || 1); setPackSizes((cur) => ({ ...cur, [r.code]: n })); setEdits({}); }} /></td> : null}
                      <td className="r shop-c-cost" title={costTitle}>{formatMoney(est.cost)}</td>
                      <td className="shop-c-why" data-label="原因">{r.reason === "shortfall" ? <span className="chip chip-iron">{inventoryReady ? "缺货" : "未入库"}</span> : <span className="chip chip-amber">补货</span>}</td>
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
        <div className="panel empty shop-ok"><span style={{ color: "var(--leaf)" }}><Icon name="check" size={28} /></span><h3>{subtract && transitCovered > 0 ? "库存加在途订单够做全部计划" : "库存够做全部计划"}</h3><p>{subtract && transitCovered > 0 ? `已在路上 ${fmt(transitCovered)} 颗，到货入库后就能开工。` : excluded.size ? "已勾选的图纸都够用。" : "没有需要补的色号，可以直接开工。"}</p></div>
      ) : (
        <div className="panel empty pegboard"><h3>还没有要做的图纸</h3><p>把图纸标为“计划拼”，这里会列出要买什么。</p><a className="btn" href="#/gallery">去图库</a></div>
      )}

      <div className="sr-only" role="status" aria-live="polite">{say}</div>
      {receive ? <ReceiveSheet items={items} openOrders={orders.filter((o) => isOpen(statusOf(o, live))).length} onClose={() => setReceive(false)} remaining={Math.max(0, rows.length)} onDone={() => setEdits({})} /> : null}
    </div>
  );
}

const receiveRows = (list: Array<{ code: string; qty: number }>) => list.map((i) => ({ ...i, on: true, q: String(i.qty), amt: "" }));

function ReceiveSheet({ items, openOrders, onClose, onDone, remaining }: { items: Array<{ code: string; qty: number }>; openOrders: number; onClose: () => void; onDone: () => void; remaining: number }) {
  // 按当前清单入库；已下单的货请到“在途订单”里按订单入库，数量会对上订单
  const [rows, setRows] = useState(() => receiveRows(items));
  const [total, setTotal] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Array<{ code: string; qty: number }> | null>(null);
  const chosen = rows.filter((r) => r.on).map((r) => ({ code: r.code, qty: Math.round(Number(r.q)) || 0, amount: parseFen(r.amt) !== undefined ? Number(r.amt) : undefined })).filter((r) => r.qty > 0);
  const sum = chosen.reduce((a, r) => a + r.qty, 0);
  const alloc = allocatePrices(chosen.map((r) => ({ qty: r.qty, fen: parseFen(r.amount) })), parseFen(total));
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
        <button className="btn btn-iron" disabled={!chosen.length || busy} onClick={async () => { setBusy(true); try { await commitPurchase(chosen, { note, totalPrice: parseFen(total) !== undefined ? Number(total) : undefined }); onDone(); setResult(chosen); } finally { setBusy(false); } }}>
          入库 {chosen.length} 色 · {fmt(sum)} 颗
        </button>
      </>
    }>
      <div className="stack">
        {openOrders ? <div className="notice" role="note" data-receive-orders-hint>有 {openOrders} 张在途订单。如果这批货是按订单买的，请关掉这里，在“在途订单”里点“到货入库”，数量会直接对上订单。</div> : null}
        <p className="meta">按实际收到的数量修改；没到货的色号取消勾选。</p>
        <div className="sk-rows">
          {rows.map((r, i) => (
            <div className="sk-tick-row sk-row-p" key={r.code} data-receive-row={r.code}>
              <input type="checkbox" checked={r.on} aria-label={`${r.code} 已到货`} onChange={(e) => setRows((cur) => cur.map((x, j) => (j === i ? { ...x, on: e.target.checked } : x)))} />
              <span className="bead-code sk-c-bead"><Bead code={r.code} /><span className="code">{r.code}</span><span className="meta">{colorOf(r.code)?.nameZh}</span></span>
              <input className="input num sk-c-qty" type="number" inputMode="numeric" min={0} aria-label={`${r.code} 数量`} value={r.q} disabled={!r.on} onChange={(e) => setRows((cur) => cur.map((x, j) => (j === i ? { ...x, q: e.target.value } : x)))} />
              <input className="input num sk-c-amt" type="number" inputMode="decimal" min={0} step="0.01" aria-label={`${r.code} 这一行的金额（元，选填）`} placeholder="金额 元" data-row-amount value={r.amt} disabled={!r.on} onChange={(e) => setRows((cur) => cur.map((x, j) => (j === i ? { ...x, amt: e.target.value } : x)))} />
            </div>
          ))}
        </div>
        <div className="grid-2" style={{ gap: 12 }}>
          <label className="field"><span>订单总价（元，选填）</span><input className="input num" type="number" inputMode="decimal" min={0} step="0.01" value={total} onChange={(e) => setTotal(e.target.value)} placeholder="没填金额的行按颗数分" data-receive-total /></label>
          <label className="field"><span>备注（选填）</span><input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="如：淘宝订单" /></label>
        </div>
        <PriceNote alloc={alloc} beads={sum} />
      </div>
    </Sheet>
  );
}
