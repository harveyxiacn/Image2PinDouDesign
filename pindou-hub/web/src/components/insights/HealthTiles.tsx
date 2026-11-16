// 库存健康：三个数字块 + 闲置色排行。
import { Bead, fmt } from "../ui";
import type { StockHealth } from "../../lib/insights";

export function HealthTiles({ health }: { health: StockHealth }) {
  const tiles = [
    { key: "enough", label: "充足", note: "库存够做计划", cls: "leaf", b: health.enough },
    { key: "tight", label: "吃紧", note: "库存不够计划", cls: "iron", b: health.tight },
    { key: "idle", label: "闲置", note: "没有图纸用到", cls: "amber", b: health.idle }
  ];
  return (
    <div>
      <ul className="ins-tiles">
        {tiles.map((t) => (
          <li key={t.key} className={`ins-tile ${t.cls}`}>
            <span className="label">{t.label}</span>
            <b className="num">{fmt(t.b.colors)}<small> 色</small></b>
            <span className="meta num">{fmt(t.b.beads)} 颗 · {t.note}</span>
          </li>
        ))}
      </ul>
      {health.idleList.length ? (
        <ol className="ins-idle" aria-label="闲置最多的色号">
          {health.idleList.slice(0, 8).map((r) => (
            <li key={r.code}><span className="ins-bar-code"><Bead code={r.code} size={18} /><span className="code">{r.code}</span></span><span className="meta num">闲置 {fmt(r.beads)} 颗 · 没有图纸用到</span></li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
