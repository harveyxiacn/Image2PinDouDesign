import { useMemo, useState } from "react";
import type { PaletteColor } from "../domain/types";
import { IconChevronDown, IconSearch } from "./icons";

type PalettePanelProps = {
  palette: PaletteColor[];
  restrictEnabled: boolean;
  allowedCodes: Set<string>;
  currentDesignCodes?: Set<string>;
  onChange: (next: { restrictEnabled: boolean; allowedCodes: Set<string> }) => void;
};

export function PalettePanel({
  palette,
  restrictEnabled,
  allowedCodes,
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

  const toggleColor = (code: string) => {
    if (!restrictEnabled) {
      return;
    }
    const next = new Set(allowedCodes);
    if (next.has(code)) {
      next.delete(code);
    } else {
      next.add(code);
    }
    onChange({ restrictEnabled, allowedCodes: next });
  };

  const setAll = (codes: Iterable<string>) => {
    onChange({ restrictEnabled: true, allowedCodes: new Set(codes) });
  };

  const invert = () => {
    const next = new Set<string>();
    for (const color of palette) {
      if (!allowedCodes.has(color.code)) {
        next.add(color.code);
      }
    }
    onChange({ restrictEnabled: true, allowedCodes: next });
  };

  const keepCurrentDesign = () => {
    if (!currentDesignCodes || currentDesignCodes.size === 0) {
      return;
    }
    onChange({ restrictEnabled: true, allowedCodes: new Set(currentDesignCodes) });
  };

  const selectedCount = restrictEnabled ? allowedCodes.size : palette.length;
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
                const nextCodes = enabled && allowedCodes.size === 0
                  ? new Set(palette.map((color) => color.code))
                  : allowedCodes;
                onChange({ restrictEnabled: enabled, allowedCodes: nextCodes });
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
                onClick={() => setAll(palette.map((color) => color.code))}
              >
                全选
              </button>
              <button
                type="button"
                className="button small"
                disabled={!restrictEnabled}
                onClick={() => onChange({ restrictEnabled: true, allowedCodes: new Set() })}
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
            勾选你手上已有的豆色，图纸只会从这些色里挑。色名基于 MARD 拼豆色号表，仅作参考，下单前请以官方为准。
          </p>

          {restrictEnabled && (
            <p className="palette-inventory-count">
              库存模式已勾选 <strong>{selectedCount}</strong> 色。
            </p>
          )}

          <div className="palette-grid" role="listbox" aria-label="MARD 色卡颜色" aria-multiselectable={restrictEnabled}>
            {visible.map((color) => {
              const selected = !restrictEnabled || allowedCodes.has(color.code);
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
