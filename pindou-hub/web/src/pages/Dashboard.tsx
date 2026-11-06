// 焦点：“这周能拼什么 / 还要买多少”——进行中的图纸的备豆进度 + 一个大数字（要买的总颗数）和「去采购」。
import { useMemo, useState } from "react";
import { Bead, Icon, fmt, fmtTime, navigate, DiffNumber } from "../components/ui";
import { useData } from "../lib/db";
import { useSyncState } from "../lib/sync";
import { demandByCode, isActive, readiness, shoppingList, stockByCode } from "../lib/inventory";
import { levelOf, groupLedger, collectionsByTag } from "../lib/stockview";
import { METHOD_LABEL, totalOf } from "../lib/model";
import { BatchEntry } from "../components/stock/BatchEntry";
import { CodeSheet } from "../components/stock/CodeSheet";
import { KitInit } from "../components/stock/KitInit";
import { UsageChart } from "../components/dash/UsageChart";
import { Collections } from "../components/dash/Collections";
import "../components/stock/stock.css";
import "./Dashboard.css";

const KIND_LABEL: Record<string, string> = { purchase: "入库", consume: "消耗", adjust: "调整", stocktake: "盘点", mixed: "混合" };

export default function Dashboard() {
  const data = useData();
  const sync = useSyncState();
  const [batch, setBatch] = useState(false);
  const [kitInit, setKitInit] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [invSkipped, setInvSkipped] = useState(false);

  const inventoryReady = !!data.prefs.inventoryStartedAt || data.txns.some((t) => !t.deleted);
  const stock = useMemo(() => stockByCode(data.txns), [data.txns]);
  const active = useMemo(() => data.patterns.filter(isActive), [data.patterns]);
  const buy = useMemo(() => shoppingList(stock, demandByCode(data.patterns, isActive), data.prefs, true), [stock, data.patterns, data.prefs]);
  const demand = useMemo(() => demandByCode(data.patterns, isActive), [data.patterns]);
  const collections = useMemo(() => collectionsByTag(data.patterns, stock), [data.patterns, stock]);
  const buyTotal = buy.reduce((a, r) => a + r.buy, 0);
  const demandTotal = Object.values(demand).reduce((a, n) => a + Math.max(0, n), 0);
  const shortCount = buy.filter((r) => r.reason === "shortfall").length;
  const low = useMemo(() => Object.keys(stock).map((code) => ({ code, have: stock[code], floor: data.prefs.minStock[code] ?? data.prefs.lowStock }))
    .filter((c) => c.have > 0 && levelOf(c.have, c.floor) === "low").sort((a, b) => a.have / (a.floor || 1) - b.have / (b.floor || 1)), [stock, data.prefs]);
  const totalBeads = Object.values(stock).reduce((a, v) => a + Math.max(0, v), 0);
  const inStock = Object.values(stock).filter((v) => v > 0).length;
  const recent = useMemo(() => groupLedger(data.txns, data.patterns).flatMap((d) => d.groups).slice(0, 6), [data.txns, data.patterns]);

  const sheets = (
    <>
      {batch ? <BatchEntry onClose={() => setBatch(false)} /> : null}
      {kitInit ? <KitInit onClose={() => setKitInit(false)} /> : null}
      {open ? <CodeSheet code={open} onClose={() => setOpen(null)} /> : null}
    </>
  );

  if (!data.patterns.length && !data.txns.length) {
    return (
      <div>
        <div className="page-head"><div><h1>总览</h1></div></div>
        <section className="panel pegboard dash-welcome">
          <h2>欢迎来到拼豆仓</h2>
          <p className="meta">记下手上有哪些豆子、要做哪些图纸，它会告诉你还差什么、该买多少。</p>
          <div className="dash-steps">
            <div className="dash-step"><span className="n">1</span><h4>录入现有库存</h4><p className="meta">按套装一次初始化，或逐个色号入库。</p>
              <div className="row"><button className="btn btn-sm" onClick={() => setKitInit(true)}>按套装初始化库存</button><button className="btn btn-sm btn-ghost" onClick={() => setBatch(true)}>批量入库</button></div></div>
            <div className="dash-step"><span className="n">2</span><h4>添加图纸</h4><p className="meta">拍下或上传图纸识别用量，也能用照片生成。</p>
              <div className="row"><a className="btn btn-sm" href="#/add?mode=recognize">识别图纸</a><a className="btn btn-sm btn-ghost" href="#/add?mode=generate">生成图纸</a></div></div>
            <div className="dash-step"><span className="n">3</span><h4>看采购清单</h4><p className="meta">把图纸标为“计划拼”，缺哪些色一目了然。</p>
              <div className="row"><a className="btn btn-sm" href="#/shopping">采购清单</a></div></div>
          </div>
          <a className="btn btn-iron" href="#/add">添加第一张图纸</a>
        </section>
        {sheets}
      </div>
    );
  }

  return (
    <div>
      <div className="page-head">
        <div><h1>总览</h1><p>这周能拼什么，还要买多少。</p></div>
        <div className="dash-quick">
          <a className="btn" href="#/add?mode=recognize"><Icon name="scan" />识别图纸</a>
          <a className="btn" href="#/add?mode=generate"><Icon name="wand" />生成图纸</a>
          <button className="btn" onClick={() => setBatch(true)}><Icon name="plus" />入库</button>
        </div>
      </div>

      {!inventoryReady && !invSkipped ? (
        <div className="notice dash-onboard" role="note">
          <span><b>先录入现有库存？</b>没录入时，图纸只显示「需要哪些色」，不会把 0 当成缺货。</span>
          <span className="spacer" />
          <button className="btn btn-sm btn-primary" onClick={() => setKitInit(true)}>按套装录入</button>
          <button className="btn btn-sm" onClick={() => setBatch(true)}>批量入库</button>
          <button className="btn btn-sm btn-ghost" onClick={() => setInvSkipped(true)}>跳过，先看需求</button>
        </div>
      ) : null}

      <section className="panel dash-hero" aria-label="本周计划">
        <div className="dash-hero-list">
          {active.length ? active.slice(0, 6).map((p) => {
            const r = readiness(p, stock);
            const copies = Math.max(1, p.copies || 1);
            const ready = r.makeable >= copies;
            return (
              <div className="dash-pat" key={p.id}>
                <div className="stack" style={{ gap: 2, minWidth: 0 }}>
                  <a className="name" href={`#/pattern/${p.id}`}>{p.name}</a>
                  <span className="meta">{copies > 1 ? `计划 ${copies} 份 · ` : ""}{!inventoryReady ? `需要 ${Object.keys(p.counts).filter((c) => p.counts[c] > 0).length} 色` : ready ? "豆子够做" : `库存能做 ${r.makeable} 份`}</span>
                </div>
                <div className="stack" style={{ gap: 4 }}>
                  <div className="row" style={{ justifyContent: "space-between", gap: 4 }}><span className="meta">{inventoryReady ? "备豆" : "库存"}</span><span className="meta num">{inventoryReady ? `${Math.round(r.coverage * 100)}%` : "未录入"}</span></div>
                  <div className={`meter ${!inventoryReady ? "" : ready ? "ok" : r.coverage > 0.6 ? "low" : "short"}`}><i style={{ width: inventoryReady ? `${Math.min(100, r.coverage * 100)}%` : "0%" }} /></div>
                </div>
                {!inventoryReady ? (
                  <div className="dash-pat-miss">
                    <span className="meta">需要</span>
                    {Object.entries(p.counts).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([code, n]) => <button key={code} className="btn btn-ghost btn-sm" style={{ padding: "0 4px" }} title={`${code} 需要 ${fmt(n * copies)}`} onClick={() => setOpen(code)}><Bead code={code} size={18} /><span className="code">{code}</span></button>)}
                  </div>
                ) : r.missing.length ? (
                  <div className="dash-pat-miss">
                    <span className="meta">还差</span>
                    {r.missing.slice(0, 8).map((m) => <button key={m.code} className="btn btn-ghost btn-sm" style={{ padding: "0 4px" }} title={`${m.code} 缺 ${fmt(m.need - m.have)}`} onClick={() => setOpen(m.code)}><Bead code={m.code} size={18} /><span className="code">{m.code}</span></button>)}
                    {r.missing.length > 8 ? <span className="meta">等 {r.missing.length} 色</span> : null}
                  </div>
                ) : null}
              </div>
            );
          }) : (
            <div className="empty"><h3>没有计划拼的图纸</h3><p>把图纸标为“计划拼”或“制作中”，这里会显示备豆进度。</p><a className="btn" href="#/gallery">去图库</a></div>
          )}
          {active.length > 6 ? <div style={{ padding: "8px 16px" }}><a className="meta" href="#/gallery?status=planned">还有 {active.length - 6} 张计划拼的图纸</a></div> : null}
        </div>
        <div className="dash-hero-buy pegboard">
          <span className="label">{inventoryReady ? "还要买" : "计划需要"}</span>
          {!inventoryReady ? (
            <>
              <div className="big"><DiffNumber value={demandTotal} /><span className="meta"> 颗</span></div>
              <div className="meta">库存未录入，先按净需求看；录入库存后这里会扣掉已有豆子。</div>
              <a className="btn" href="#/shopping">看采购清单</a>
            </>
          ) : buyTotal > 0 ? (
            <>
              <div className="big"><DiffNumber value={buyTotal} /><span className="meta"> 颗</span></div>
              <div className="meta">{buy.length} 个色号{shortCount ? `，其中 ${shortCount} 色缺货` : "，都是补货提醒"}</div>
              <button className="btn btn-iron" onClick={() => navigate("/shopping")}><Icon name="cart" />去采购</button>
            </>
          ) : (
            <>
              <div className="big" style={{ color: "var(--leaf)" }}>0</div>
              <div className="meta">{active.length ? "库存够做全部计划" : "暂时不用买"}</div>
              <a className="btn" href="#/shopping">看采购清单</a>
            </>
          )}
        </div>
      </section>

      <div className="dash-strip" aria-label="库存概况">
        <div><span className="label">豆子总数</span><b>{inventoryReady ? <DiffNumber value={totalBeads} /> : "—"}</b></div>
        <div><span className="label">有货色号</span><b>{inventoryReady ? inStock : "—"}</b></div>
        <div><span className="label">快用完</span><b style={{ color: low.length ? "var(--amber)" : undefined }}>{low.length}</b></div>
      </div>

      <div className="dash-two">
        <section className="panel" aria-labelledby="dash-col-h">
          <div className="panel-head"><h3 id="dash-col-h">合集</h3><a className="meta" href="#/gallery?group=tag">按标签看图库</a></div>
          <Collections items={collections} />
        </section>
        <section className="panel" aria-labelledby="dash-use-h">
          <div className="panel-head"><h3 id="dash-use-h">色号用量</h3><span className="meta">计划需求 vs 库存 · 前 10 色</span></div>
          <UsageChart demand={demand} stock={stock} onOpen={setOpen} inventoryReady={inventoryReady} />
        </section>
      </div>

      <div className="grid-2" style={{ alignItems: "start", marginTop: 16 }}>
        <section className="panel">
          <div className="panel-head"><h3>快用完了</h3><a className="meta" href="#/inventory">豆盒库存</a></div>
          {low.length ? (
            <div className="dash-low">
              {low.slice(0, 16).map((c) => <button key={c.code} onClick={() => setOpen(c.code)} aria-label={`${c.code} 剩 ${c.have} 颗`}><Bead code={c.code} size={22} /><span className="code" style={{ fontWeight: 600 }}>{c.code}</span><span className="q">{fmt(c.have)}</span></button>)}
            </div>
          ) : <div className="empty" style={{ padding: 24 }}>{inStock ? "没有偏少的色号。" : "还没有库存记录。"}</div>}
        </section>
        <section className="panel">
          <div className="panel-head"><h3>最近动态</h3><a className="meta" href="#/history">全部记录</a></div>
          {recent.length ? recent.map((g) => g.type === "pattern" ? (
            <div className="dash-act" key={g.key}><span className="chip">新图纸</span><a className="t" href={`#/pattern/${g.pattern.id}`} style={{ color: "inherit" }}>{g.pattern.name}</a><span className="meta">{METHOD_LABEL[g.pattern.method]} · {fmt(totalOf(g.pattern.counts))} 颗</span><span className="meta">{fmtTime(g.at)}</span></div>
          ) : (
            <div className="dash-act" key={g.key}><span className={`chip ${g.kind === "purchase" ? "chip-leaf" : g.kind === "consume" ? "chip-iron" : "chip-amber"}`}>{KIND_LABEL[g.kind]}</span><span className="t">{g.note || `${g.codes} 个色号`}</span><span className="num" style={{ fontWeight: 600 }}>{g.delta > 0 ? "+" : g.delta < 0 ? "−" : "±"}{fmt(Math.abs(g.delta))}</span><span className="meta">{fmtTime(g.at)}</span></div>
          )) : <div className="empty" style={{ padding: 24 }}>还没有动态。</div>}
        </section>
      </div>

      <div className="dash-sync">
        <span className={`sync-dot ${sync.phase}`} />
        <span>{sync.phase === "unpaired" ? "数据只在这台设备上" : `${sync.hubName || "Hub"}：${sync.message || (sync.phase === "idle" ? "已同步" : sync.phase)}`}{sync.lastSyncAt ? ` · 上次同步 ${fmtTime(sync.lastSyncAt)}` : ""}</span>
        <a href="#/settings">{sync.phase === "unpaired" ? "连接电脑 Hub" : "同步设置"}</a>
      </div>
      {sheets}
    </div>
  );
}
