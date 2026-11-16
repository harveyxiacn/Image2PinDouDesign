import { useMemo, useState } from "react";
import { Bead } from "../ui";
import { colorOf, managedCodes, normalizeKitId } from "../../lib/palette";
import { useData } from "../../lib/db";
import { stockByCode } from "../../lib/inventory";
import { outsideCount, pickerItems } from "../../lib/managed";
import { matchesQuery } from "../../lib/stockview";
import "./stock.css";

/**
 * 色号选择：搜索框 + 列表（按色号或中文名搜索），点一项即选。
 * 默认只列“我管理的色号”（所选套装 + 套装外有库存的）；搜索时仍能找到套装外的色号（标“套装外”），
 * 也可以点“显示全部色号”展开——买来的图纸里可能有套装外的颜色。
 */
export function CodePicker({ onPick, taken = [], placeholder = "搜索色号或颜色名，如 A1 / 红" }: { onPick: (code: string) => void; taken?: string[]; placeholder?: string }) {
  const data = useData();
  const [q, setQ] = useState("");
  const [showAll, setShowAll] = useState(false);
  const managed = useMemo(() => managedCodes(normalizeKitId(data.prefs.kitId), stockByCode(data.txns)), [data.prefs.kitId, data.txns]);
  const outside = useMemo(() => outsideCount(managed), [managed]);
  const list = useMemo(() => pickerItems(managed, q, showAll, (c, query) => matchesQuery(c, colorOf(c)?.nameZh, query)).slice(0, showAll || q.trim() ? 80 : 300), [managed, q, showAll]);
  return (
    <div className="sk-picker">
      <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} aria-label="搜索色号" />
      <div className="sk-picker-list" role="listbox" aria-label="色号列表">
        {list.length ? list.map(({ code, outside: out }) => (
          <button key={code} type="button" role="option" aria-selected={false} disabled={taken.includes(code)} onClick={() => { onPick(code); setQ(""); }} data-code={code} {...(out ? { "data-outside-kit": "1" } : {})}>
            <Bead code={code} size={22} /><span className="code" style={{ fontWeight: 600, width: 40 }}>{code}</span>
            <span className="meta">{colorOf(code)?.nameZh}</span>
            {out ? <span className="meta" style={{ marginLeft: "auto", opacity: 0.8 }}>套装外</span> : null}
            {taken.includes(code) ? <span className="meta" style={{ marginLeft: out ? 6 : "auto" }}>已添加</span> : null}
          </button>
        )) : <div className="empty" style={{ padding: 16 }}>没有匹配的色号{outside && !showAll ? "，可以点下面的“显示全部色号”" : ""}</div>}
      </div>
      {outside > 0 ? (
        <button type="button" className="btn btn-sm btn-ghost" style={{ minHeight: 44, alignSelf: "flex-start" }} aria-pressed={showAll} data-picker-outside-toggle onClick={() => setShowAll((v) => !v)}>
          {showAll ? "只看我的色号" : `显示全部色号（另有 ${outside} 个套装外）`}
        </button>
      ) : null}
    </div>
  );
}
