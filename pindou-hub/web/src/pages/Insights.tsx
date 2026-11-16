// 数据洞察：每个面板先给一句结论，再给图表作证据。已在总览里展示的内容（合集、用量前 10）这里不重复，只链接过去。
import { useMemo, useState } from "react";
import { fmt } from "../components/ui";
import { useData } from "../lib/db";
import { stockByCode, isActive } from "../lib/inventory";
import { demandRanking, familyBreakdown, monthlyActivity, readiness, recognitionQuality, stockHealth } from "../lib/insights";
import { InsightEmpty, InsightPanel } from "../components/insights/Panel";
import { ForecastPanel } from "../components/insights/ForecastPanel";
import { NextUpPanel } from "../components/insights/NextUpPanel";
import { ReadyList } from "../components/insights/ReadyList";
import { DemandBars } from "../components/insights/DemandBars";
import { FamilyBars } from "../components/insights/FamilyBars";
import { HealthTiles } from "../components/insights/HealthTiles";
import { TrendChart } from "../components/insights/TrendChart";
import { QualityBars } from "../components/insights/QualityBars";
import "./Insights.css";

export default function Insights() {
  const data = useData();
  const { patterns, txns, prefs } = data;
  const [range, setRange] = useState<6 | 12>(6);
  const inventoryReady = !!prefs.inventoryStartedAt || txns.some((t) => !t.deleted);
  const loss = prefs.lossRate;
  const stock = useMemo(() => stockByCode(txns), [txns]);
  const active = useMemo(() => patterns.filter(isActive), [patterns]);
  const ready = useMemo(() => readiness(patterns, stock, loss), [patterns, stock, loss]);
  const ranking = useMemo(() => demandRanking(patterns, stock, { lossRate: loss }), [patterns, stock, loss]);
  const top = ranking.slice(0, 15);
  const families = useMemo(() => familyBreakdown(patterns, stock, loss), [patterns, stock, loss]);
  const demandNeed = useMemo(() => Object.fromEntries(ranking.map((r) => [r.code, r.demand])), [ranking]);
  const health = useMemo(() => stockHealth(stock, demandNeed, prefs), [stock, demandNeed, prefs]);
  const activity = useMemo(() => monthlyActivity(txns, { months: range, patterns }), [txns, range, patterns]);
  const quality = useMemo(() => recognitionQuality(patterns), [patterns]);

  const readyCount = ready.filter((r) => r.complete).length;
  const nearCount = ready.filter((r) => !r.complete && r.missingColors <= 2).length;
  const gapTotal = top.reduce((s, r) => s + r.gap, 0);
  const worst = top[0];
  const topFam = [...families].sort((a, b) => b.gap - a.gap)[0];

  if (!patterns.length && !txns.length) {
    return (
      <div className="ins">
        <div className="page-head"><div><h1>数据洞察</h1><p>从图纸和库存里读出该做什么、该买什么。</p></div></div>
        <section className="panel"><InsightEmpty title="还没有数据可分析" text="添加几张图纸、录入库存后，这里会告诉你现在能拼什么、最缺什么颜色。" href="#/add" action="添加图纸" /></section>
      </div>
    );
  }

  const noInv = <InsightEmpty title="库存还没录入" text="没录入库存时，把 0 当成缺货没有意义。先录入现有豆子，这里就能判断哪些图纸已经能拼。" href="#/inventory" action="去录入库存" />;
  const noPlan = <InsightEmpty title="没有计划拼的图纸" text="把图纸标为“计划拼”或“制作中”，这里会按需求分析。" href="#/gallery" action="去图库" />;

  return (
    <div className="ins">
      <div className="page-head">
        <div><h1>数据洞察</h1><p>{active.length} 张计划中的图纸 · 损耗按 {Math.round(loss * 100)}% 计 · <a href="#/">基础总览在这里</a></p></div>
      </div>

      <div className="ins-grid">
        <div className="ins-wide">
          <InsightPanel id="ins-ready" title="现在能拼什么"
            takeaway={!active.length ? "没有计划拼的图纸。" : !inventoryReady ? "库存未录入，暂时判断不了哪张能拼。" : ready.length === 0 ? "计划里的图纸还没有用量数据。" : readyCount ? `${readyCount} 张图的豆子已经备齐${nearCount ? `，另有 ${nearCount} 张只差 1–2 个色` : ""}。` : nearCount ? `暂时没有备齐的图，但有 ${nearCount} 张只差 1–2 个色。` : `最接近的是「${ready[0].name}」，已备 ${Math.round(ready[0].coverage * 100)}%。`}>
            {!active.length ? noPlan : !inventoryReady ? noInv : <ReadyList rows={ready} stock={stock} />}
          </InsightPanel>
        </div>

        <NextUpPanel />

        <ForecastPanel />

        <InsightPanel id="ins-short" title="最缺的颜色"
          takeaway={!top.length ? "计划里还没有用量。" : !inventoryReady ? `计划里用得最多的是 ${top[0].code}，需要 ${fmt(top[0].need)} 颗（库存未录入）。` : worst.gap ? `最缺的是 ${worst.code}，还差 ${fmt(worst.gap)} 颗；前 ${top.length} 色合计缺 ${fmt(gapTotal)} 颗。` : "前 15 个色号库存都够用。"}>
          {top.length ? <DemandBars rows={top} inventoryReady={inventoryReady} /> : noPlan}
        </InsightPanel>

        <InsightPanel id="ins-fam" title="色系分布"
          takeaway={!families.some((f) => f.demand) ? "计划里还没有用量。" : !inventoryReady ? "按色号首字母分组，库存录入后能看出哪个色系最缺。" : topFam && topFam.gap ? `${topFam.family} 系最缺，共差 ${fmt(topFam.gap)} 颗。` : "各色系库存都够计划用。"}>
          {families.some((f) => f.demand || f.stock) ? <FamilyBars rows={families} inventoryReady={inventoryReady} /> : noPlan}
        </InsightPanel>

        <InsightPanel id="ins-health" title="库存健康"
          takeaway={!inventoryReady ? "库存未录入。" : `${fmt(health.idle.colors)} 个色号共 ${fmt(health.idle.beads)} 颗闲置，${fmt(health.tight.colors)} 个色号库存吃紧。`}>
          {inventoryReady ? <HealthTiles health={health} /> : noInv}
        </InsightPanel>

        <InsightPanel id="ins-trend" title="进出趋势"
          takeaway={!activity.hasTxns ? "还没有出入库记录。" : `最近 ${range} 个月入库 ${fmt(activity.months.reduce((s, m) => s + m.purchased, 0))} 颗，消耗 ${fmt(activity.months.reduce((s, m) => s + m.consumed, 0))} 颗${activity.hasPrice ? `，花费 ¥${activity.totalSpent.toLocaleString("zh-CN", { maximumFractionDigits: 0 })}` : ""}。`}
          aside={<div className="ins-seg" role="group" aria-label="时间范围">{([6, 12] as const).map((n) => <button key={n} type="button" className="btn btn-sm" aria-pressed={range === n} onClick={() => setRange(n)}>{n} 个月</button>)}</div>}>
          {activity.hasTxns ? <><TrendChart months={activity.months} hasPrice={activity.hasPrice} /><p className="meta" data-trend-caption style={{ marginTop: 8 }}>{activity.estimatedCompleted ? `“完成图纸”按你标记完成时记下的日期统计；其中 ${activity.estimatedCompleted} 张是旧记录，没有完成日期，暂按扣库存的日期估算。在图纸详情里补一条完工记录就会变准。` : "“完成图纸”按你标记完成时记下的完成日期统计。"} <a href="#/works">看作品集</a></p></> : <InsightEmpty title="还没有出入库记录" text="入库、完成图纸后，这里会按月显示进出。" href="#/history" action="看记录" />}
        </InsightPanel>

        <InsightPanel id="ins-quality" title="识别质量"
          takeaway={!quality.total ? "还没有图纸。" : quality.unverified ? `${fmt(quality.unverified)} 张图纸还没人工核对${quality.activeUnverified ? `，其中 ${fmt(quality.activeUnverified)} 张已在计划里` : ""}。` : "所有图纸都已核对。"}>
          {quality.total ? <QualityBars q={quality} /> : <InsightEmpty title="还没有图纸" text="添加图纸后可查看核对进度。" href="#/add" action="添加图纸" />}
        </InsightPanel>
      </div>
    </div>
  );
}
