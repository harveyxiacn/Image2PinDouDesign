import type { InventoryFitResult } from "../domain/inventoryFit";
import type { PaletteColor } from "../domain/types";

type InventoryFitCardProps = {
  fit: InventoryFitResult;
  palette: PaletteColor[];
  shortageTotal: number;
  onApply: () => void;
};

const swatch = (palette: Map<string, PaletteColor>, code: string) => (
  <span className="swatch" style={{ backgroundColor: palette.get(code)?.hex ?? "#ddd" }} />
);

/** 按库存调整：先预览“用手上相近色替换缺口”的方案，确认后一次应用（可撤销）。 */
export function InventoryFitCard({ fit, palette, shortageTotal, onApply }: InventoryFitCardProps) {
  const byCode = new Map(palette.map((color) => [color.code, color]));
  const swapped = fit.substitutions.reduce((sum, item) => sum + item.count, 0);
  const remaining = Object.entries(fit.remaining).sort((a, b) => b[1] - a[1]);
  const remainingTotal = remaining.reduce((sum, [, count]) => sum + count, 0);

  return (
    <section className="inventory-fit" aria-labelledby="inventory-fit-title">
      <div className="inventory-fit-head">
        <strong id="inventory-fit-title">按库存调整这张图纸</strong>
        <small>按你登记的库存，这张图纸还缺 {shortageTotal} 颗。</small>
      </div>
      {fit.substitutions.length > 0 ? (
        <>
          <ul className="inventory-fit-list">
            {fit.substitutions.map((item) => (
              <li key={`${item.from}-${item.to}`}>
                {swatch(byCode, item.from)}<span>{item.from}</span>
                <span aria-hidden="true">→</span>
                {swatch(byCode, item.to)}<span>{item.to}</span>
                <b>{item.count} 颗</b>
                <small>色差 {item.deltaE}</small>
              </li>
            ))}
          </ul>
          <button type="button" className="button small primary" onClick={onApply}>
            用相近色替换 {swapped} 颗
          </button>
        </>
      ) : (
        <p className="muted">手上没有足够接近的颜色可以替代（色差需 ≤ 8，避免影响成品效果）。</p>
      )}
      {remainingTotal > 0 && (
        <p className="inventory-fit-remaining">
          {fit.substitutions.length > 0 ? "替换后" : ""}仍需购买：{remaining.slice(0, 6).map(([code, count]) => `${code} × ${count}`).join("、")}
          {remaining.length > 6 ? ` 等 ${remaining.length} 色` : ""}
        </p>
      )}
    </section>
  );
}
