// 焦点：豆盒（compartment box）网格——一眼看出每个色号还剩多少、计划里哪里缺。
import { useMemo, useState } from "react";
import { Icon, fmt, DiffNumber } from "../components/ui";
import { useData } from "../lib/db";
import { demandByCode, isActive, stockByCode, compareCodes } from "../lib/inventory";
import { ALL_CODES, PALETTE_KITS, colorOf, getPaletteKit } from "../lib/palette";
import { levelOf, matchesQuery, seriesOf } from "../lib/stockview";
import { BeadBox, type CellInfo } from "../components/stock/BeadBox";
import { CodeSheet } from "../components/stock/CodeSheet";
import { BatchEntry } from "../components/stock/BatchEntry";
import { KitInit } from "../components/stock/KitInit";
import "./Inventory.css";

type Filter = "recorded" | "instock" | "low" | "need" | "kit";
const FILTERS: Array<[Filter, string]> = [["recorded", "全部有记录"], ["instock", "有库存"], ["low", "偏少"], ["need", "计划需要"], ["kit", "全部色卡"]];

export default function Inventory() {
  const data = useData();
  const [filter, setFilter] = useState<Filter>("recorded");
  const [series, setSeries] = useState("");
  const [query, setQuery] = useState("");
  const [kitId, setKitId] = useState(data.prefs.kitId);
  const [open, setOpen] = useState<string | null>(null);
  const [batch, setBatch] = useState(false);
  const [kitInit, setKitInit] = useState(false);

  const stock = useMemo(() => stockByCode(data.txns), [data.txns]);
  const demand = useMemo(() => demandByCode(data.patterns, isActive), [data.patterns]);
  const { minStock, lowStock } = data.prefs;

  const cells: CellInfo[] = useMemo(() => {
    let codes: string[];
    if (filter === "kit") codes = [...new Set([...getPaletteKit(kitId).codes, ...Object.keys(stock).filter((c) => stock[c] > 0)])];
    else if (filter === "need") codes = Object.keys(demand);
    else codes = Object.keys(stock);
    const known = codes.filter((c) => colorOf(c));
    return known.sort(compareCodes).map((code) => ({ code, have: stock[code] ?? 0, floor: minStock[code] ?? lowStock, need: demand[code] ?? 0 }))
      .filter((c) => filter === "instock" ? c.have > 0 : filter === "low" ? levelOf(c.have, c.floor) !== "ok" : true);
  }, [filter, kitId, stock, demand, minStock, lowStock]);

  const seriesList = useMemo(() => [...new Set(cells.map((c) => seriesOf(c.code)))].sort((a, b) => compareCodes(a + "1", b + "1")), [cells]);
  const shown = cells.filter((c) => (!series || seriesOf(c.code) === series) && matchesQuery(c.code, colorOf(c.code)?.nameZh, query));
  const totalBeads = Object.values(stock).reduce((a, v) => a + Math.max(0, v), 0);
  const inStock = Object.values(stock).filter((v) => v > 0).length;
  const lowCount = Object.keys(stock).filter((c) => stock[c] > 0 && levelOf(stock[c], minStock[c] ?? lowStock) === "low").length;
  const hasAny = Object.keys(stock).length > 0;

  return (
    <div>
      <div className="page-head">
        <div><h1>豆盒库存</h1><p>点一格看详情、盘点或入库。红点表示计划里还不够用。</p></div>
        <div className="row">
          <button className="btn" onClick={() => setKitInit(true)}><Icon name="box" />按套装初始化</button>
          <button className="btn btn-iron" onClick={() => setBatch(true)}><Icon name="plus" />批量入库</button>
        </div>
      </div>

      <div className="inv-bar">
        <div className="inv-summary"><span><b><DiffNumber value={totalBeads} /></b> 颗</span><span><b className="num">{inStock}</b> 色有货</span><span><b className="num">{lowCount}</b> 色偏少</span></div>
        <div className="row">
          <div className="inv-scroll"><div className="seg" role="group" aria-label="筛选">
            {FILTERS.map(([id, label]) => <button key={id} aria-pressed={filter === id} onClick={() => { setFilter(id); setSeries(""); }}>{label}</button>)}
          </div></div>
          {filter === "kit" ? (
            <select className="select" aria-label="色卡套装" value={kitId} onChange={(e) => setKitId(e.target.value)}>
              {PALETTE_KITS.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
            </select>
          ) : null}
        </div>
        <div className="row">
          <input className="input inv-search" type="search" placeholder="搜索色号或颜色名" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="搜索" />
          <div className="inv-scroll"><div className="seg" role="group" aria-label="系列">
            <button aria-pressed={series === ""} onClick={() => setSeries("")}>全部</button>
            {seriesList.map((s) => <button key={s} aria-pressed={series === s} onClick={() => setSeries(s)}>{s}</button>)}
          </div></div>
        </div>
      </div>

      {shown.length ? <BeadBox cells={shown} onOpen={setOpen} /> : (
        <div className="panel empty pegboard">
          {!hasAny && filter !== "kit" ? (
            <>
              <h3>豆盒还是空的</h3>
              <p>先把手上的豆子记进来：按套装一次初始化，或者逐个色号入库。</p>
              <div className="row" style={{ justifyContent: "center" }}>
                <button className="btn btn-iron" onClick={() => setKitInit(true)}>按套装初始化</button>
                <button className="btn" onClick={() => setBatch(true)}>批量入库</button>
              </div>
            </>
          ) : (
            <><h3>没有符合条件的色号</h3><p>{filter === "low" ? "没有偏少的色号，库存状态不错。" : filter === "need" ? "计划里的图纸暂时不需要豆子。" : "换个筛选或搜索词试试。"}</p></>
          )}
        </div>
      )}

      {open ? <CodeSheet code={open} onClose={() => setOpen(null)} /> : null}
      {batch ? <BatchEntry onClose={() => setBatch(false)} /> : null}
      {kitInit ? <KitInit onClose={() => setKitInit(false)} /> : null}
    </div>
  );
}
