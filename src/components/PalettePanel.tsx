import { useMemo, useState } from "react";
import { addOwnedForCodes, setOwnedCount } from "../domain/shortfall";
import type { PaletteColor } from "../domain/types";
import { IconChevronDown, IconSearch } from "./icons";

type PalettePanelProps = {
  palette: PaletteColor[];
  restrictEnabled: boolean;
  ownedCounts: Record<string, number>;
  currentDesignCodes?: Set<string>;
  onChange: (next: { restrictEnabled: boolean; ownedCounts: Record<string, number> }) => void;
};

export function PalettePanel({
  palette,
  restrictEnabled,
  ownedCounts,
  currentDesignCodes,
  onChange
}: PalettePanelProps) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(true);

  const visible = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) {
      return palette;
    }
    return palette.filter((color) =>
      color.code.toLowerCase().includes(trimmed) ||
      color.nameZh.toLowerCase().includes(trimmed) ||
      color.hex.toLowerCase().includes(trimmed)
    );
  }, [palette, query]);

  const isOwned = (code: string): boolean => (ownedCounts[code] ?? 0) > 0;
  const registeredCount = Object.values(ownedCounts).filter((count) => count > 0).length;

  /** 每个色号至少登记为 1 颗（全选）。 */
  const allOwnedOne = (): Record<string, number> => {
    const next: Record<string, number> = {};
    for (const color of palette) {
      next[color.code] = 1;
    }
    return next;
  };

  const toggleColor = (code: string) => {
    if (!restrictEnabled) {
      return;
    }
    onChange({
      restrictEnabled,
      ownedCounts: setOwnedCount(ownedCounts, code, isOwned(code) ? 0 : 1)
    });
  };

  const selectAll = () => {
    onChange({ restrictEnabled: true, ownedCounts: allOwnedOne() });
  };

  const clearAll = () => {
    onChange({ restrictEnabled: true, ownedCounts: {} });
  };

  const invert = () => {
    const next = { ...ownedCounts };
    for (const color of palette) {
      if ((next[color.code] ?? 0) > 0) {
        delete next[color.code];
      } else {
        next[color.code] = 1;
      }
    }
    onChange({ restrictEnabled: true, ownedCounts: next });
  };

  const keepCurrentDesign = () => {
    if (!currentDesignCodes || currentDesignCodes.size === 0) {
      return;
    }
    const next: Record<string, number> = {};
    for (const code of currentDesignCodes) {
      next[code] = 1;
    }
    onChange({ restrictEnabled: true, ownedCounts: next });
  };

  /** 把当前图纸用到的色号并入库存：保留已有更大值、不删其它色。 */
  const registerCurrentDesign = () => {
    if (!currentDesignCodes || currentDesignCodes.size === 0) {
      return;
    }
    onChange({
      restrictEnabled,
      ownedCounts: addOwnedForCodes(ownedCounts, currentDesignCodes, 1)
    });
  };

  const selectedCount = restrictEnabled ? registeredCount : palette.length;
  const hasCurrent = Boolean(currentDesignCodes && currentDesignCodes.size > 0);
  const usedCount = currentDesignCodes?.size ?? 0;
  const usedPercent = palette.length > 0 ? Math.round((usedCount / palette.length) * 100) : 0;

  return (
    <section className="panel palette-panel" aria-labelledby="palette-title">
      <div className="palette-head">
        <div className="palette-heading">
          <p className="eyebrow">Palette</p>
          <h2 id="palette-title">MARD 色卡</h2>
        </div>
        <button
          type="button"
          className="palette-toggle"
          aria-expanded={expanded}
          aria-controls="palette-body"
          onClick={() => setExpanded((current) => !current)}
        >
          <IconChevronDown className={`palette-chevron ${expanded ? "is-open" : ""}`} />
          <span className="sr-only">{expanded ? "收起色卡" : "展开色卡"}</span>
        </button>
      </div>

      <div
        className="palette-progress"
        role="progressbar"
        aria-label="本次使用的颜色数"
        aria-valuemin={0}
        aria-valuemax={palette.length}
        aria-valuenow={usedCount}
      >
        <div className="palette-progress-track">
          <span style={{ width: `${usedPercent}%` }} />
        </div>
        <small>
          {hasCurrent
            ? `本次使用 ${usedCount} / ${palette.length} 色`
            : "生成图纸后将显示本次用到的颜色"}
        </small>
      </div>

      {expanded && (
        <div id="palette-body">
          <label className="toggle">
            <input
              type="checkbox"
              checked={restrictEnabled}
              onChange={(event) => {
                const enabled = event.target.checked;
                const nextCounts = enabled && registeredCount === 0 ? allOwnedOne() : ownedCounts;
                onChange({ restrictEnabled: enabled, ownedCounts: nextCounts });
              }}
            />
            <span>只用我手头有的色生成图纸（库存模式）</span>
          </label>

          <div className="palette-toolbar">
            <div className="palette-actions">
              <button
                type="button"
                className="button small"
                disabled={!restrictEnabled}
                onClick={selectAll}
              >
                全选
              </button>
              <button
                type="button"
                className="button small"
                disabled={!restrictEnabled}
                onClick={clearAll}
              >
                清空
              </button>
              <button
                type="button"
                className="button small"
                disabled={!restrictEnabled}
                onClick={invert}
              >
                反选
              </button>
              <button
                type="button"
                className="button small"
                disabled={!restrictEnabled || !hasCurrent}
                onClick={keepCurrentDesign}
                title="将当前图纸用到的色作为库存"
              >
                仅保留当前用色
              </button>
              <button
                type="button"
                className="button small"
                disabled={!hasCurrent}
                onClick={registerCurrentDesign}
                title="把当前图纸用到的色号记入手头库存（保留已有更大数量、不删其它色）"
              >
                项目用色记为库存
              </button>
            </div>
            <div className="palette-search-wrap">
              <IconSearch className="palette-search-icon" />
              <input
                className="palette-search"
                type="search"
                placeholder="搜索色号 / 颜色名 / HEX"
                aria-label="搜索色号 / 颜色名 / HEX"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
          </div>

          <p className="muted">
            填入手头已有的豆色与颗数，图纸只会从这些色里挑。
          </p>

          {restrictEnabled && (
            <p className="palette-inventory-count">
              库存模式已登记 <strong>{selectedCount}</strong> 色。
            </p>
          )}

          <div className="palette-grid" role="listbox" aria-label="MARD 色卡颜色" aria-multiselectable={restrictEnabled}>
            {visible.map((color) => {
              const selected = !restrictEnabled || isOwned(color.code);
              const usedInCurrent = currentDesignCodes?.has(color.code) ?? false;
              return (
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  aria-disabled={!restrictEnabled}
                  className={`palette-chip ${selected ? "selected" : "muted-chip"} ${usedInCurrent ? "in-use" : ""}`}
                  key={color.code}
                  title={`${color.code} · ${color.nameZh} · ${color.hex}${usedInCurrent ? " · 当前图纸已用" : ""}`}
                  onClick={() => toggleColor(color.code)}
                  disabled={!restrictEnabled}
                >
                  <span style={{ backgroundColor: color.hex }} />
                  <small>{color.code}</small>
                  <em>{color.nameZh}</em>
                </button>
              );
            })}
            {visible.length === 0 && (
              <p className="muted">没有匹配的颜色。</p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
