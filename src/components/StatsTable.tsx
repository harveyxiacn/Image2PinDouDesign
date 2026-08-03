import type { PaletteColor } from "../domain/types";
import type { StatsSourceFilter } from "../domain/projectStats";

type StatsTableProps = {
  title: string;
  counts: Record<string, number>;
  palette: PaletteColor[];
  action?: React.ReactNode;
  ownedCounts?: Record<string, number>;
  shortfall?: Record<string, number>;
  onOwnedChange?: (code: string, count: number) => void;
  sourceFilter?: StatsSourceFilter;
  sourceCount?: number;
  onSourceFilterChange?: (filter: StatsSourceFilter) => void;
};

const sourceFilterOptions: Array<{ value: StatsSourceFilter; label: string; description: string }> = [
  { value: "all", label: "全部", description: "正式项目和本机草稿" },
  { value: "projects", label: "项目", description: "仅本次上传生成的正式项目" },
  { value: "drafts", label: "草稿", description: "仅保存在本机的草稿" }
];

export function StatsTable({
  title,
  counts,
  palette,
  action,
  ownedCounts,
  shortfall,
  onOwnedChange,
  sourceFilter,
  sourceCount,
  onSourceFilterChange
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
        <div className="stats-header-actions">
          {sourceFilter && onSourceFilterChange && (
            <div
              className="stats-source-filter"
              role="group"
              aria-label={`统计口径，当前为${sourceFilterOptions.find((option) => option.value === sourceFilter)?.description ?? "全部"}`}
            >
              {sourceFilterOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={sourceFilter === option.value}
                  title={option.description}
                  onClick={() => onSourceFilterChange(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          )}
          {action}
        </div>
      </div>

      {sourceFilter && (
        <p className="stats-scope-note" aria-live="polite">
          当前口径：{sourceFilterOptions.find((option) => option.value === sourceFilter)?.description}，共 {sourceCount ?? 0} 张图纸；差缺与导出按此口径计算。
        </p>
      )}

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
