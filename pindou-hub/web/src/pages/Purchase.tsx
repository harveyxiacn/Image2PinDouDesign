// 采购方案：把用户 2026-11-06 确认的套装/补充包报价，按当前缺口算成 6 个方案。
// 纯前端计算（web/src/lib/purchase.ts），不依赖服务端；应用方案时把每色购买量带回采购清单。
import { useEffect, useMemo, useState } from "react";
import { Bead, Icon, fmt, useRoute } from "../components/ui";
import { useData } from "../lib/db";
import { demandByCode, isActive } from "../lib/inventory";
import { totalOf } from "../lib/model";
import {
  PURCHASE_OFFERS, buildPurchasePlans, formatMoney, formatPacks, type PurchaseOffer, type PurchasePlan
} from "../lib/purchase";
import "./Purchase.css";

const yuanPerK = (offer: PurchaseOffer) => ((offer.perBead * 1000)).toFixed(2);

function scopeText(offer: PurchaseOffer): string {
  if (offer.kind === "set") return "套装色号对 MARD";
  if (offer.scope === "A-M") return "仅 A–M 色系";
  if (offer.minPacks) return `满 ${offer.minPacks} 包可备注色号`;
  return "任意色号";
}

export default function Purchase() {
  const data = useData();
  const route = useRoute();
  const [onlyVerified, setOnlyVerified] = useState(route.query.get("verified") === "1");
  const [price1200, setPrice1200] = useState(1.26);
  useEffect(() => { setOnlyVerified(route.query.get("verified") === "1"); }, [route.query]);

  const active = useMemo(() => data.patterns.filter(isActive), [data.patterns]);
  const lossRate = Math.max(0, data.prefs.lossRate);
  const scoped = useMemo(() => active.filter((p) => !onlyVerified || p.verifiedAt != null), [active, onlyVerified]);
  const demand = useMemo(() => demandByCode(scoped), [scoped]);
  const need = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [code, n] of Object.entries(demand)) out[code] = Math.ceil(n * (1 + lossRate));
    return out;
  }, [demand, lossRate]);
  const plans = useMemo(() => buildPurchasePlans(need, demand, price1200), [need, demand, price1200]);

  const net = totalOf(demand);
  const withLoss = totalOf(need);
  const colors = Object.keys(demand).length;
  const unverified = active.filter((p) => p.verifiedAt == null).length;
  const verified = active.length - unverified;
  const best = plans[0];
  const singles = plans.find((p) => p.id === "plan-all-singles") ?? best;
  const set221 = plans.find((p) => p.id === "plan-set221-185") ?? best;
  const notRecommended = plans.filter((p) => p.id !== best?.id && (p.id === "plan-set265-257" || p.id === "plan-app-current" || p.id === "plan-set295-352"));
  const offers = useMemo(() => [...PURCHASE_OFFERS].sort((a, b) => a.perBead - b.perBead), []);
  const shoppingHref = (id: string) => `#/shopping?plan=${encodeURIComponent(id)}${onlyVerified ? "&verified=1" : ""}`;

  if (!active.length) {
    return (
      <div>
        <div className="page-head"><div><h1>采购方案</h1><p>按真实报价比较套装和单色补充包。</p></div></div>
        <div className="panel empty pegboard"><h3>还没有要做的图纸</h3><p>把图纸标为“计划做”，这里会按缺口算方案。</p><a className="btn" href="#/gallery">去图库</a></div>
      </div>
    );
  }

  return (
    <div>
      <div className="page-head">
        <div><h1>采购方案</h1><p>按 {scoped.length} 张计划图纸、{fmt(net)} 颗净需求，比较 6 种买法。</p></div>
        <div className="row">
          <a className="btn" href={onlyVerified ? "#/shopping?verified=1" : "#/shopping"}>返回采购清单</a>
        </div>
      </div>

      <section className="panel panel-pad purchase-top">
        <div className="purchase-kpis">
          <div><span className="label">净需求</span><b className="num">{fmt(net)}</b><span className="meta">颗 · {colors} 色</span></div>
          <div><span className="label">含 {Math.round(lossRate * 1000) / 10}% 损耗</span><b className="num">{fmt(withLoss)}</b><span className="meta">颗</span></div>
          <div><span className="label">最省方案</span><b className="num">{scoped.length && best ? formatMoney(best.totalCost) : "—"}</b><span className="meta">{scoped.length && best ? best.name : "没有计入的图纸"}</span></div>
          <div><span className="label">未核对</span><b className="num">{unverified}</b><span className="meta">张 · 共 {active.length} 张</span></div>
        </div>
        <div className="row purchase-controls">
          <label className="field"><span>1200 颗单价</span>
            <select className="select" value={price1200} onChange={(e) => setPrice1200(Number(e.target.value))}>
              <option value={1.26}>¥1.26 / 包</option>
              <option value={1.5}>¥1.50 / 包</option>
            </select>
          </label>
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

      {!scoped.length ? (
        <div className="panel empty pegboard"><h3>没有已核对的图纸</h3><p>先把图库里的图纸标为“已核对”，或关掉“只算已核对”。</p><a className="btn" href="#/gallery?verify=unverified">去图库核对</a></div>
      ) : (
        <>
          <div className="purchase-cards">
            {[best, singles].filter((p, i, arr) => p && arr.findIndex((x) => x?.id === p.id) === i).map((plan, i) => (
              <article className="panel purchase-card" key={plan.id} data-best={i === 0}>
                <span className="label">{i === 0 ? "A · 最省方案" : "B · 少囤方案"}</span>
                <h3>{plan.name}</h3>
                <div className="purchase-price">{formatMoney(plan.totalCost)}</div>
                <p className="meta">总颗数 {fmt(plan.totalBeads)} · 多出 {fmt(plan.surplus)} 颗 · 覆盖 {plan.coverage} 色{plan.missing.length ? ` · 缺 ${plan.missing.length} 色` : " · 全覆盖"}</p>
                <p className="meta">{plan.note}</p>
                <a className="btn btn-iron" href={shoppingHref(plan.id)}>应用此方案<Icon name="chevron" /></a>
              </article>
            ))}
          </div>

          <section className="panel purchase-section">
            <div className="panel-head"><h3>6 个方案对比</h3><span className="meta">按总价从低到高；总颗数包含套装里用不上的颜色。</span></div>
            <div className="table-wrap">
              <table className="table purchase-plans">
                <thead><tr><th>方案</th><th className="r">套装</th><th className="r">补充包</th><th className="r">合计</th><th className="r">总颗数</th><th className="r">多出需求</th><th>覆盖</th><th>包装数量</th><th /></tr></thead>
                <tbody>
                  {plans.map((plan) => (
                    <tr key={plan.id} data-best={plan.id === best?.id}>
                      <td><b>{plan.name}</b>{plan.id === best?.id ? <span className="chip chip-leaf purchase-best">最省</span> : null}<div className="meta">{plan.note}</div></td>
                      <td className="r">{plan.setPrice ? formatMoney(plan.setPrice) : "—"}</td>
                      <td className="r">{plan.singlesCost ? formatMoney(plan.singlesCost) : "—"}</td>
                      <td className="r"><b>{formatMoney(plan.totalCost)}</b></td>
                      <td className="r">{fmt(plan.totalBeads)}</td>
                      <td className="r">+{fmt(plan.surplus)}</td>
                      <td className="purchase-coverage">{plan.coverage} 色{plan.missing.length ? ` · 缺 ${plan.missing.length}` : " · 全覆盖"}</td>
                      <td className="purchase-packs">{formatPacks(plan.packs)}</td>
                      <td><a className="btn btn-sm" href={shoppingHref(plan.id)}>应用</a></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {set221?.missing.length ? (
            <section className="panel panel-pad purchase-section">
              <div className="panel-head"><h3>221 套装缺口（{set221.missing.length} 色）</h3><span className="meta">这一组是覆盖价值最低的最优解；实际以下单时套装色表为准。</span></div>
              <div className="purchase-missing">
                {set221.missing.map((code) => <span className="chip purchase-chip" key={code}><Bead code={code} size={16} /><span className="code">{code}</span></span>)}
              </div>
              <p className="meta">补充包合计 {formatMoney(set221.singlesCost)}，其中这 {set221.missing.length} 个缺口约 {formatMoney(set221.items.filter((i) => !i.setCovered).reduce((s, i) => s + i.singlesCost, 0))}；套装的 221 色按每色 1200 颗计入。</p>
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
            <div className="panel-head"><h3>报价表</h3><span className="meta">2026-11-06 用户确认的报价，按每千颗单价排序。</span></div>
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
    </div>
  );
}
