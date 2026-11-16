// 采购方案：把用户 2026-11-06 确认的套装/补充包报价，按当前缺口算成 6 个方案。
// 纯前端计算（web/src/lib/purchase.ts），不依赖服务端；应用方案时把每色购买量带回采购清单。
import { useEffect, useMemo, useState } from "react";
import { Bead, Icon, fmt, toast, useRoute } from "../components/ui";
import { copyText } from "../components/stock/download";
import { putRecords, useData } from "../lib/db";
import { PRICE_1200_CHOICES, normalizePrice1200, price1200Of } from "../lib/forecast";
import { demandByCode, isActive, needAfterStock, stockByCode, withLoss as applyLoss } from "../lib/inventory";
import { subtractTransit } from "../lib/orders";
import { totalOf } from "../lib/model";
import { SellerSheet, sellerSummary, saveSellerPatch } from "../components/sellers/SellerSheet";
import { currentSeller, listSellers, selectSeller } from "../lib/sellers";
import { recordPlacedOrder, useTransit } from "../components/orders/store";
import { TransitNote } from "../components/orders/TransitNote";
import {
  PURCHASE_OFFERS, PURCHASE_PREFER_LABEL, applyPlanToEdits, buildPurchasePlans, compareSellers, formatMoney, formatPlanPacks, formatPurchaseText, groupSupplements,
  kitOffer, leftoverBreakdown, narrowedCodes, parsePrefer, recommendationReason, type PurchaseOffer, type PurchasePlan, type PurchasePrefer
} from "../lib/purchase";
import "./Purchase.css";

const PREFER_KEY = "ph.purchase.prefer";
const PREFER_ORDER: PurchasePrefer[] = ["balanced", "cheapest", "leastWaste"];
function readPrefer(): PurchasePrefer {
  try { return parsePrefer(localStorage.getItem(PREFER_KEY)); } catch { return "balanced"; }
}
const pct = (v: number) => `${(Math.round(v * 1000) / 10).toFixed(1)}%`;

function Badges({ plan }: { plan: PurchasePlan }) {
  return (
    <>
      {plan.recommended ? <span className="chip chip-leaf purchase-badge">推荐</span> : null}
      {plan.cheapest ? <span className="chip purchase-badge">最省钱</span> : null}
      {plan.leastWaste ? <span className="chip purchase-badge">最少浪费</span> : null}
    </>
  );
}

function ShipLine({ plan }: { plan: PurchasePlan }) {
  if (!plan.shipping && !plan.freeShippingGap) return null;
  return (
    <p className="meta purchase-ship" data-purchase-ship>
      {plan.shipping ? `含运费 ${formatMoney(plan.shipping)}` : ""}
      {plan.shipping && plan.freeShippingGap ? `（再买 ${formatMoney(plan.freeShippingGap)} 商品可包邮）` : ""}
    </p>
  );
}

function SupplementDetail({ plan, price1200, href, onCopy }: { plan: PurchasePlan; price1200: number; href: string; onCopy: (plan: PurchasePlan) => void }) {
  const groups = groupSupplements(plan, price1200);
  const copy = () => onCopy(plan);
  return (
    <details className="panel purchase-detail" data-rec={plan.recommended}>
      <summary>
        <span className="purchase-detail-name"><b>{plan.name}</b><Badges plan={plan} /></span>
        <span className="meta num">{formatMoney(plan.totalCost)}{plan.shipping ? "（含运费）" : ""} · 浪费 {pct(plan.wastePct)}</span>
      </summary>
      <div className="purchase-detail-body">
        {plan.setOffer ? <p className="meta">套装：{plan.setOffer.name}，{formatMoney(plan.setPrice)}；套装里用不上的颜色 {fmt(plan.unusedSetBeads)} 颗。</p> : null}
        {groups.length ? groups.map((group) => (
          <div className="purchase-group" key={group.size}>
            <div className="purchase-group-head"><b>{group.beadsPerPack} 颗装</b><span className="meta num">共 {group.packs} 包 · 小计 {formatMoney(group.cost)}</span></div>
            <div className="table-wrap">
              <table className="table purchase-sup">
                <thead><tr><th>色号</th><th className="r">包数</th><th className="r">买到</th><th className="r">需要</th><th className="r">剩余</th><th className="r">小计</th></tr></thead>
                <tbody>
                  {group.rows.map((row) => (
                    <tr key={row.code}>
                      <td><span className="purchase-code"><Bead code={row.code} size={16} /><span className="code">{row.code}</span></span></td>
                      <td className="r">×{row.packs}</td>
                      <td className="r">{fmt(row.beads)}</td>
                      <td className="r">{row.continued ? "同上" : fmt(row.need)}</td>
                      <td className="r">{row.continued ? "同上" : fmt(row.surplus)}</td>
                      <td className="r">{formatMoney(row.cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )) : <p className="meta">这个方案不需要单色补充包。</p>}
        {groups.filter((g) => g.minPacks).map((g) => <p className="meta purchase-hint" key={g.size}>{g.beadsPerPack} 颗装满 {g.minPacks} 包才能备注色号；本方案共 {g.packs} 包{g.packs >= (g.minPacks ?? 0) ? "，可以指定色号" : ""}。</p>)}
        <ShipLine plan={plan} />
        <div className="row purchase-detail-actions">
          <button type="button" className="btn btn-sm" onClick={copy}>复制采购清单</button>
          <a className="btn btn-sm" href={href}>应用此方案</a>
        </div>
      </div>
    </details>
  );
}

const yuanPerK = (offer: PurchaseOffer) => ((offer.perBead * 1000)).toFixed(2);

function scopeText(offer: PurchaseOffer): string {
  if (offer.kind === "set" && !offer.confirmed) return "套装每色 1200 颗";
  if (offer.kind === "set") return "套装色号对 MARD";
  if (offer.scope === "A-M") return "仅 A–M 色系";
  if (offer.minPacks) return `满 ${offer.minPacks} 包可备注色号`;
  return "任意色号";
}

export default function Purchase() {
  const data = useData();
  const route = useRoute();
  const [onlyVerified, setOnlyVerified] = useState(route.query.get("verified") === "1");
  // 1200 颗装单价是一个全家同步的偏好（prefs.price1200）：采购、采购清单、补货预告都读它
  const price1200 = price1200Of(data.prefs);
  const [sellerOpen, setSellerOpen] = useState(() => route.query.get("sellers") === "1");
  // 当前卖家：内置默认卖家沿用 price1200；自定义卖家用自己的价格
  const seller = useMemo(() => currentSeller(data.prefs), [data.prefs]);
  const sellers = useMemo(() => listSellers(data.prefs), [data.prefs]);
  const setPrice1200 = (v: number) => {
    const next = normalizePrice1200(v);
    if (next === price1200) return;
    void putRecords("prefs", [{ ...data.prefs, price1200: next, updatedAt: Math.max(Date.now(), data.prefs.updatedAt + 1) }])
      .catch(() => toast("单价没保存成功，请重试"));
  };
  const [prefer, setPrefer] = useState<PurchasePrefer>(readPrefer);
  const pickPrefer = (v: PurchasePrefer) => {
    setPrefer(v);
    try { localStorage.setItem(PREFER_KEY, v); } catch { /* 隐私模式等：只在本次生效 */ }
  };
  useEffect(() => { setOnlyVerified(route.query.get("verified") === "1"); }, [route.query]);

  const active = useMemo(() => data.patterns.filter(isActive), [data.patterns]);
  const lossRate = Math.max(0, data.prefs.lossRate);
  const scoped = useMemo(() => active.filter((p) => !onlyVerified || p.verifiedAt != null), [active, onlyVerified]);
  const demand = useMemo(() => demandByCode(scoped), [scoped]);
  const need = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [code, n] of Object.entries(demand)) out[code] = applyLoss(n, lossRate);
    return out;
  }, [demand, lossRate]);
  // 方案按“含损耗、已扣库存”的缺口计算（库存还没录入时不扣，与采购清单一致）
  const inventoryReady = !!data.prefs.inventoryStartedAt || data.txns.some((t) => !t.deleted);
  const stock = useMemo(() => stockByCode(data.txns), [data.txns]);
  // 在途订单当作“已经到手”的库存来扣，和采购清单一致；开关与采购清单共用
  const { transit, transitTotal, subtract, pickSubtract } = useTransit();
  const stockPlus = useMemo(() => {
    if (!subtract || !transitTotal) return stock;
    const out = { ...stock };
    for (const [code, n] of Object.entries(transit)) out[code] = Math.max(0, out[code] ?? 0) + n;
    return out;
  }, [stock, transit, transitTotal, subtract]);
  const planNeed = useMemo(() => needAfterStock(demand, inventoryReady || (subtract && transitTotal > 0) ? stockPlus : {}, lossRate), [demand, stockPlus, inventoryReady, subtract, transitTotal, lossRate]);
  // 在途订单实际抵掉了多少缺口（不管开关开不开，数字一样）
  const transitCovered = useMemo(() => (transitTotal ? subtractTransit(needAfterStock(demand, inventoryReady ? stock : {}, lossRate), transit).coveredTotal : 0), [transitTotal, transit, demand, inventoryReady, stock, lossRate]);
  const plans = useMemo(() => buildPurchasePlans(planNeed, demand, price1200, prefer, seller), [planNeed, demand, price1200, prefer, seller]);
  const quotes = useMemo(() => (sellers.length > 1 ? compareSellers(planNeed, demand, sellers, price1200, prefer) : []), [planNeed, demand, sellers, price1200, prefer]);

  const net = totalOf(demand);
  const withLoss = totalOf(need);
  const colors = Object.keys(demand).length;
  const unverified = active.filter((p) => p.verifiedAt == null).length;
  const verified = active.length - unverified;
  const best = plans.find((p) => p.cheapest) ?? plans[0];
  const recommended = plans.find((p) => p.recommended) ?? best;
  const leastWaste = plans.find((p) => p.leastWaste) ?? best;
  const reason = recommendationReason(plans, prefer);
  const narrowed = useMemo(() => narrowedCodes(planNeed, seller), [planNeed, seller]);
  const leftover = recommended ? leftoverBreakdown(recommended) : null;
  // 复制采购清单的同时保存下单快照：入库时可以按“当时下的单”核对
  const copyPlan = async (plan: PurchasePlan) => {
    const ok = await copyText(formatPurchaseText(plan, price1200, seller.name));
    toast(ok ? "已复制采购清单" : "复制失败，请手动选择文字");
    if (!ok) return;
    const items = Object.entries(applyPlanToEdits(plan)).map(([code, qty]) => ({ code, qty }));
    try { await recordPlacedOrder({ items, planId: plan.id, cost: plan.totalCost, seller: seller.builtin ? undefined : seller.name }); } catch { toast("订单没登记成功，到货时请在采购清单里手动记一张"); }
  };
  const featured = [recommended, best, leastWaste].filter((p, i, arr) => p && arr.findIndex((x) => x?.id === p.id) === i);
  const set221 = plans.find((p) => p.id === "plan-set221-185") ?? (seller.builtin ? best : plans.find((p) => p.setOffer));
  const notRecommended = plans.filter((p) => p.id !== best?.id && (p.id === "plan-set265-257" || p.id === "plan-app-current" || p.id === "plan-set295-352"));
  const offers = useMemo<PurchaseOffer[]>(() => {
    if (seller.builtin) return [...PURCHASE_OFFERS].sort((a, b) => a.perBead - b.perBead);
    const packs: PurchaseOffer[] = seller.packs.map((p) => ({
      id: p.id, kind: "single", name: `单色补充包 ${p.beads} 颗`, price: p.price, currency: "CNY", beads: p.beads, scope: p.scope === "A-M" ? "A-M" : "any",
      minPacks: p.minPacks, perBead: p.price / p.beads, confirmed: false, note: `${formatMoney(p.price)} / 包${p.minPacks ? `；整单满 ${p.minPacks} 包可备注色号` : ""}。`
    }));
    return [...packs, ...seller.kits.map(kitOffer)].sort((a, b) => a.perBead - b.perBead);
  }, [seller]);
  const shoppingHref = (id: string) => `#/shopping?plan=${encodeURIComponent(id)}${onlyVerified ? "&verified=1" : ""}${seller.builtin && price1200 !== 1.26 ? `&p1200=${price1200}` : ""}`;

  if (!active.length) {
    return (
      <div>
        <div className="page-head"><div><h1>采购方案</h1><p>按真实报价比较套装和单色补充包。</p></div></div>
        <div className="panel empty pegboard"><h3>还没有要做的图纸</h3><p>把图纸标为“计划拼”，这里会按缺口算方案。</p><a className="btn" href="#/gallery">去图库</a></div>
      </div>
    );
  }

  return (
    <div>
      <div className="page-head">
        <div><h1>采购方案</h1><p>按 {scoped.length} 张计划图纸、{fmt(net)} 颗净需求，按「{seller.name}」的报价比较 {plans.length} 种买法。</p></div>
        <div className="row">
          <a className="btn" href={onlyVerified ? "#/shopping?verified=1" : "#/shopping"}>返回采购清单</a>
        </div>
      </div>

      <section className="panel panel-pad purchase-top">
        <div className="purchase-kpis">
          <div><span className="label">净需求</span><b className="num">{fmt(net)}</b><span className="meta">颗 · {colors} 色</span></div>
          <div><span className="label">含 {Math.round(lossRate * 1000) / 10}% 损耗</span><b className="num">{fmt(withLoss)}</b><span className="meta">颗</span></div>
          <div><span className="label">最省钱方案</span><b className="num">{scoped.length && best ? formatMoney(best.totalCost) : "—"}</b><span className="meta">{scoped.length && best ? best.name : "没有计入的图纸"}</span></div>
          <div><span className="label">未核对</span><b className="num">{unverified}</b><span className="meta">张 · 共 {active.length} 张</span></div>
        </div>
        <div className="seller-bar" data-purchase-seller>
          <label className="field"><span>卖家</span>
            <select className="select" value={seller.id} onChange={(e) => void saveSellerPatch((p) => selectSeller(p, e.target.value))} data-purchase-seller-select>
              {sellers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <button type="button" className="btn" onClick={() => setSellerOpen(true)} data-purchase-seller-manage>管理卖家</button>
        </div>
        <p className="meta" data-purchase-seller-sum>{sellerSummary(seller)}</p>
        <div className="row purchase-controls">
          {seller.builtin ? (
            <label className="field"><span>1200 颗单价</span>
              <select className="select" value={price1200} onChange={(e) => setPrice1200(Number(e.target.value))}>
                {PRICE_1200_CHOICES.map((c) => <option key={c} value={c}>¥{c.toFixed(2)} / 包</option>)}
              </select>
            </label>
          ) : null}
          <div className="field"><span id="purchase-prefer-label">推荐依据</span>
            <div className="seg" role="group" aria-labelledby="purchase-prefer-label">
              {PREFER_ORDER.map((v) => <button type="button" key={v} aria-pressed={prefer === v} onClick={() => pickPrefer(v)}>{PURCHASE_PREFER_LABEL[v]}</button>)}
            </div>
          </div>
          <label className="row purchase-check"><input type="checkbox" checked={onlyVerified} disabled={!verified} onChange={(e) => setOnlyVerified(e.target.checked)} />只算已核对（{verified} 张）</label>
        </div>
      </section>

      {unverified ? (
        <div className="notice" role="note">
          <span><b>{unverified} 张</b>计划图纸尚未核对，下面的金额可能偏差。</span>
          <span className="spacer" />
          <a className="btn btn-sm" href="#/gallery?verify=unverified">去图库核对</a>
        </div>
      ) : null}

      <TransitNote transitTotal={transitTotal} covered={transitCovered} subtract={subtract} onToggle={pickSubtract} />

      {narrowed.length ? (
        <div className="notice" role="note" data-purchase-narrowed>
          <span><b>{narrowed.slice(0, 4).join("、")}{narrowed.length > 4 ? " 等" : ""}</b> 需要的颗数很大，包规格又多，为了不卡住，算法只看了一部分组合：这些色号的买法不保证是最省的。</span>
        </div>
      ) : null}

      {!scoped.length ? (
        <div className="panel empty pegboard"><h3>没有已核对的图纸</h3><p>先把图库里的图纸标为“已核对”，或关掉“只算已核对”。</p><a className="btn" href="#/gallery?verify=unverified">去图库核对</a></div>
      ) : (
        <>
          {recommended ? (
            <section className="panel purchase-reco" aria-label="推荐组合">
              <div className="purchase-reco-head">
                <span className="chip chip-leaf purchase-badge">推荐组合</span>
                <Badges plan={{ ...recommended, recommended: false }} />
              </div>
              <h2>{recommended.setOffer ? recommended.setOffer.name : "全部用单色补充包"}{recommended.setOffer && recommended.singlesCost > 0 ? " + 补充包" : ""}</h2>
              <div className="purchase-reco-nums">
                <div><span className="label">总价{recommended.shipping ? "（含运费）" : ""}</span><b className="num purchase-price">{formatMoney(recommended.totalCost)}</b>{recommended.shipping ? <span className="meta">商品 {formatMoney(recommended.goodsCost ?? 0)} + 运费 {formatMoney(recommended.shipping)}</span> : null}</div>
                <div><span className="label">浪费</span><b className="num">{pct(recommended.wastePct)}</b><span className="meta">{fmt(recommended.wasteBeads)} 颗用不上</span></div>
                <div><span className="label">一共买到</span><b className="num">{fmt(recommended.totalBeads)}</b><span className="meta">颗 · 补充包 {formatPlanPacks(recommended)}</span></div>
              </div>
              <p className="purchase-why"><b>为什么推荐：</b>{reason}</p>
              <ShipLine plan={recommended} />
              {leftover ? (
                <ul className="purchase-left" aria-label="剩余豆子的来源">
                  {leftover.unusedBeads > 0 ? <li>套装里用不上的颜色 <b className="num">{fmt(leftover.unusedColors)}</b> 色 / <b className="num">{fmt(leftover.unusedBeads)}</b> 颗</li> : null}
                  <li>整包凑整多出 <b className="num">{fmt(leftover.roundingBeads)}</b> 颗</li>
                </ul>
              ) : null}
              <div className="row purchase-reco-actions">
                <a className="btn btn-iron" href={shoppingHref(recommended.id)}>应用推荐方案<Icon name="chevron" /></a>
                <button type="button" className="btn" onClick={() => copyPlan(recommended)}>复制采购清单</button>
              </div>
            </section>
          ) : null}

          {featured.filter((p) => p && p.id !== recommended?.id).length ? (
            <div className="purchase-cards">
              {featured.filter((p) => p && p.id !== recommended?.id).map((plan) => (
                <article className="panel purchase-card" key={plan.id}>
                  <span className="purchase-card-tags"><Badges plan={plan} /></span>
                  <h3>{plan.name}</h3>
                  <div className="purchase-price">{formatMoney(plan.totalCost)}</div>
                  <p className="meta">总颗数 {fmt(plan.totalBeads)} · 浪费 {pct(plan.wastePct)}（{fmt(plan.wasteBeads)} 颗）{plan.missing.length ? ` · 缺 ${plan.missing.length} 色` : ""}</p>
                  <a className="btn" href={shoppingHref(plan.id)}>应用此方案<Icon name="chevron" /></a>
                </article>
              ))}
            </div>
          ) : null}

          {quotes.length > 1 ? (
            <section className="panel panel-pad seller-compare" aria-label="卖家对比" data-seller-compare>
              <div className="panel-head"><h3>各卖家的最低总价</h3><span className="meta">同一份采购清单，每个卖家最省钱的方案，含运费。</span></div>
              <ol>
                {quotes.map((q, i) => {
                  const diff = q.total - (plans.find((p) => p.cheapest)?.totalCost ?? q.total);
                  return (
                    <li key={q.seller.id} data-seller-quote={q.seller.id} data-current={q.seller.id === seller.id}>
                      <span><b>{q.seller.name}</b>{i === 0 && !q.unfulfilled.length ? <span className="chip chip-leaf purchase-badge">最便宜</span> : null}{q.seller.id === seller.id ? <span className="chip purchase-badge">当前</span> : null}</span>
                      <span className="seller-compare-sum"><b className="num">{formatMoney(q.total)}</b></span>
                      <span className="meta">
                        {q.unfulfilled.length ? `买不齐：${q.unfulfilled.slice(0, 6).join("、")}${q.unfulfilled.length > 6 ? " 等" : ""}（没有可用的包）` : q.best.name}
                        {q.best.shipping ? ` · 含运费 ${formatMoney(q.best.shipping)}` : ""}
                        {q.narrowed?.length ? <span data-seller-narrowed={q.seller.id}> · 需求很大，搜索被缩小过，不保证最省</span> : null}
                      </span>
                      <span className="meta seller-compare-sum">
                        {q.seller.id === seller.id ? "" : q.unfulfilled.length ? "" : diff === 0 ? "与当前相同" : diff < 0 ? `比当前省 ${formatMoney(-diff)}` : `比当前贵 ${formatMoney(diff)}`}
                        {q.seller.id !== seller.id ? <> <button type="button" className="btn btn-ghost" onClick={() => void saveSellerPatch((p) => selectSeller(p, q.seller.id))} aria-label={`改用${q.seller.name}`}>改用</button></> : null}
                      </span>
                    </li>
                  );
                })}
              </ol>
            </section>
          ) : null}

          <section className="panel purchase-section">
            <div className="panel-head"><h3>{plans.length} 个方案对比</h3><span className="meta">按总价从低到高；浪费 = 需要的色号买多的 + 套装里用不上的颜色。</span></div>
            <div className="table-wrap">
              <table className="table purchase-plans">
                <thead><tr><th>方案</th><th className="r">套装</th><th className="r">补充包</th><th className="r">合计</th><th className="r">总颗数</th><th className="r">浪费</th><th>覆盖</th><th>包装数量</th><th /></tr></thead>
                <tbody>
                  {plans.map((plan) => (
                    <tr key={plan.id} data-best={plan.recommended}>
                      <td><b>{plan.name}</b><Badges plan={plan} /><div className="meta">{plan.note}</div></td>
                      <td className="r">{plan.setPrice ? formatMoney(plan.setPrice) : "—"}</td>
                      <td className="r">{plan.singlesCost ? formatMoney(plan.singlesCost) : "—"}</td>
                      <td className="r"><b>{formatMoney(plan.totalCost)}</b></td>
                      <td className="r">{fmt(plan.totalBeads)}</td>
                      <td className="r">{pct(plan.wastePct)}<div className="meta">{fmt(plan.wasteBeads)} 颗</div></td>
                      <td className="purchase-coverage">{plan.coverage} 色{plan.missing.length ? ` · 缺 ${plan.missing.length}` : " · 全覆盖"}</td>
                      <td className="purchase-packs">{formatPlanPacks(plan)}</td>
                      <td><a className="btn btn-sm" href={shoppingHref(plan.id)}>应用</a></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="purchase-section" aria-label="补充包明细">
            <div className="panel-head"><h3>补充包明细：每个色号买什么规格</h3><span className="meta">展开看色号 × 规格 × 包数；带“最少包数”的规格（如 500 颗装满 10 包才能指定色号），不足时会自动改买别的规格或补满。</span></div>
            {plans.map((plan) => <SupplementDetail key={plan.id} plan={plan} price1200={price1200} href={shoppingHref(plan.id)} onCopy={copyPlan} />)}
          </section>

          {set221?.missing.length ? (
            <section className="panel panel-pad purchase-section">
              <div className="panel-head"><h3>{set221.setColors ?? 221} 套装缺口（{set221.missing.length} 色）</h3><span className="meta">这一组是覆盖价值最低的最优解；实际以下单时套装色表为准。</span></div>
              <div className="purchase-missing">
                {set221.missing.map((code) => <span className="chip purchase-chip" key={code}><Bead code={code} size={16} /><span className="code">{code}</span></span>)}
              </div>
              <p className="meta">补充包合计 {formatMoney(set221.singlesCost)}，其中这 {set221.missing.length} 个缺口约 {formatMoney(set221.items.filter((i) => !i.setCovered).reduce((s, i) => s + i.singlesCost, 0))}；套装的 {set221.setColors ?? 221} 色按每色 1200 颗计入。</p>
            </section>
          ) : null}

          {notRecommended.length ? (
            <section className="panel panel-pad purchase-section">
              <h3>不建议为这一批买</h3>
              <ul className="purchase-avoid">
                {notRecommended.map((plan) => (
                  <li key={plan.id}><b>{plan.name}</b>：{formatMoney(plan.totalCost)}，比最省方案贵 <b>{formatMoney(plan.totalCost - (best?.totalCost ?? 0))}</b>，总颗数多 {fmt(plan.totalBeads - (best?.totalBeads ?? 0))} 颗。</li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className="panel purchase-section">
            <div className="panel-head"><h3>报价表</h3><span className="meta">{seller.builtin ? "2026-11-06 用户确认的报价，按每千颗单价排序。" : `「${seller.name}」的报价，按每千颗单价排序。`}</span></div>
            {!seller.builtin && (seller.note || seller.shipping > 0) ? <p className="meta">{seller.note ? `${seller.note}　` : ""}{seller.shipping > 0 ? `运费 ${formatMoney(seller.shipping)}${seller.freeShipping ? `，满 ${formatMoney(seller.freeShipping)} 包邮` : ""}。` : "包邮。"}</p> : null}
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>报价</th><th className="r">价格</th><th className="r">元/千颗</th><th>限制/备注</th></tr></thead>
                <tbody>
                  {offers.map((offer) => (
                    <tr key={offer.id}>
                      <td><b>{offer.name}</b>{offer.confirmed ? <span className="chip chip-leaf purchase-best">已确认</span> : null}</td>
                      <td className="r">{formatMoney(offer.price)}</td>
                      <td className="r">{yuanPerK(offer)}</td>
                      <td>{scopeText(offer)}<div className="meta">{offer.note}</div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
      {sellerOpen ? <SellerSheet onClose={() => setSellerOpen(false)} /> : null}
    </div>
  );
}
