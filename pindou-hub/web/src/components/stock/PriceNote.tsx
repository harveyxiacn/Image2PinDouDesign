import type { Allocation } from "../../lib/pricing";
import { perThousandText, yuanText } from "../../lib/pricing";

/** 批量入库的金额小结：合计、每千颗均价，以及自填金额和总价对不上时的明确提示（不会拦着入库）。 */
export function PriceNote({ alloc, beads }: { alloc: Allocation; beads: number }) {
  if (alloc.status === "none") return null;
  const sum = alloc.fen.reduce((a, b) => a + b, 0);
  if (alloc.status === "over") {
    return (
      <div className="notice iron" role="alert" data-price-warning="over">
        各行填的金额合计 {yuanText(alloc.ownFen)}，比订单总价 {yuanText(alloc.totalFen)} 多了 {yuanText(alloc.gapFen)}。没填金额的行这次不会记价格；请改一下总价或行金额。
      </div>
    );
  }
  const avg = perThousandText(sum, beads);
  return (
    <div className={`notice${alloc.status === "leftover" ? "" : " leaf"}`} role="status" data-price-summary>
      金额合计 {yuanText(sum)}{avg ? `（整体${avg}）` : ""}
      {alloc.sharedFen > 0 ? `，其中 ${yuanText(alloc.sharedFen)} 按颗数分给了没填金额的行` : ""}。
      {alloc.status === "leftover" ? ` 总价比各行金额多 ${yuanText(alloc.gapFen)}，每一行都已有金额，多出的这部分不会记入。` : ""}
    </div>
  );
}
