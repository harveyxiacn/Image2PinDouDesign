import type { PaletteColor } from "../domain/types";

type StatsTableProps = {
  title: string;
  counts: Record<string, number>;
  palette: PaletteColor[];
  action?: React.ReactNode;
  ownedCounts?: Record<string, number>;
  shortfall?: Record<string, number>;
  onOwnedChange?: (code: string, count: number) => void;
};

export function StatsTable({
  title,
  counts,
  palette,
  action,
  ownedCounts,
  shortfall,
  onOwnedChange
}: StatsTableProps) {
  const byCode = new Map(palette.map((color) => [color.code, color]));
  const showInventory = ownedCounts !== undefined && onOwnedChange !== undefined;
  const rows = Object.entries(counts)
    .sort(([leftCode, leftCount], [rightCode, rightCount]) => {
      if (rightCount !== leftCount) {
        return rightCount - leftCount;
      }
      return leftCode.localeCompare(rightCode);
    });

  return (
    <section className="panel stats-panel" aria-labelledby={`${title}-title`}>
      <div className="section-header">
        <div>
          <p className="eyebrow">Stats</p>
          <h2 id={`${title}-title`}>{title}</h2>
        </div>
        {action}
      </div>

      {rows.length === 0 ? (
        <p className="muted">暂无统计数据。</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>颜色</th>
                <th>色号</th>
                <th>HEX</th>
                <th>数量</th>
                {showInventory && (
                  <>
                    <th>已有</th>
                    <th>差缺</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map(([code, count]) => {
                const color = byCode.get(code);
                const owned = ownedCounts?.[code] ?? 0;
                const missing = shortfall
                  ? (shortfall[code] ?? 0)
                  : Math.max(0, count - owned);
                return (
                  <tr key={code}>
                    <td>
                      <span className="swatch" style={{ backgroundColor: color?.hex ?? "#ddd" }} />
                      {color?.nameZh ?? code}
                    </td>
                    <td>{code}</td>
                    <td className="mono">{color?.hex ?? "-"}</td>
                    <td>{count}</td>
                    {showInventory && (
                      <>
                        <td>
                          <input
                            className="owned-input"
                            type="number"
                            min={0}
                            step={1}
                            value={owned}
                            aria-label={`已有 ${color?.nameZh ?? code}`}
                            onChange={(event) => onOwnedChange(code, Number(event.target.value))}
                          />
                        </td>
                        <td className={missing > 0 ? "shortfall-positive" : "shortfall-zero"}>
                          {missing > 0 ? missing : "—"}
                        </td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
