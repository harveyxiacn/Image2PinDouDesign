import { useMemo, useState } from "react";
import { Bead } from "../ui";
import { ALL_CODES, colorOf } from "../../lib/palette";
import { matchesQuery } from "../../lib/stockview";
import "./stock.css";

/** 色号选择：搜索框 + 列表（按色号或中文名搜索），点一项即选。 */
export function CodePicker({ onPick, taken = [], placeholder = "搜索色号或颜色名，如 A1 / 红" }: { onPick: (code: string) => void; taken?: string[]; placeholder?: string }) {
  const [q, setQ] = useState("");
  const list = useMemo(() => ALL_CODES.filter((c) => matchesQuery(c, colorOf(c)?.nameZh, q)).slice(0, 60), [q]);
  return (
    <div className="sk-picker">
      <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} aria-label="搜索色号" />
      <div className="sk-picker-list" role="listbox" aria-label="色号列表">
        {list.length ? list.map((code) => (
          <button key={code} type="button" role="option" aria-selected={false} disabled={taken.includes(code)} onClick={() => { onPick(code); setQ(""); }}>
            <Bead code={code} size={22} /><span className="code" style={{ fontWeight: 600, width: 40 }}>{code}</span>
            <span className="meta">{colorOf(code)?.nameZh}</span>
            {taken.includes(code) ? <span className="meta" style={{ marginLeft: "auto" }}>已添加</span> : null}
          </button>
        )) : <div className="empty" style={{ padding: 16 }}>没有匹配的色号</div>}
      </div>
    </div>
  );
}
