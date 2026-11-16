// “已在路上 N 颗，已从清单里扣掉”的提示条 + 开关。采购清单和采购方案页共用，用同一个开关。
import { fmt } from "../ui";

export function TransitNote({ transitTotal, covered, subtract, onToggle }: { transitTotal: number; covered: number; subtract: boolean; onToggle: (on: boolean) => void }) {
  if (!(transitTotal > 0)) return null;
  return (
    <div className="notice ord-transit" role="status" data-transit-note data-transit-subtracted={subtract}>
      <span>{covered > 0
        ? <><b data-transit-covered>已在路上 {fmt(covered)} 颗</b>{subtract ? "，已从下面的清单里扣掉，不会重复买。" : "，但下面的清单没有扣掉它们。"}</>
        : <>在途订单共 {fmt(transitTotal)} 颗，和现在的缺口对不上，清单没有变化。</>}</span>
      <span className="spacer" />
      <label><input type="checkbox" data-transit-toggle checked={subtract} onChange={(e) => onToggle(e.target.checked)} />扣掉在途订单</label>
    </div>
  );
}
