import { useMemo, useState } from "react";
import type { PaletteColor } from "../domain/types";

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

  return (
    <section className="panel palette-panel" aria-labelledby="palette-title">
      <div className="section-header">
        <div>
          <p className="eyebrow">Palette</p>
          <h2 id="palette-title">MARD 色卡</h2>
        </div>
        <span className="badge">{selectedCount} / {palette.length}</span>
      </div>

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
        <input
          className="palette-search"
          type="search"
          placeholder="搜索色号 / 颜色名 / HEX"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      <p className="muted">
        勾选你手上已有的豆色，图纸只会从这些色里挑。色名基于 MARD 拼豆色号表，仅作参考，下单前请以官方为准。
      </p>

      <div className="palette-grid" role="list">
        {visible.map((color) => {
          const selected = !restrictEnabled || allowedCodes.has(color.code);
          const usedInCurrent = currentDesignCodes?.has(color.code) ?? false;
          return (
            <button
              type="button"
              role="listitem"
              className={`palette-chip ${selected ? "selected" : "muted-chip"} ${usedInCurrent ? "in-use" : ""}`}
              key={color.code}
              title={`${color.code} · ${color.nameZh} · ${color.hex}${usedInCurrent ? " · 当前图纸已用" : ""}`}
              onClick={() => toggleColor(color.code)}
              aria-pressed={selected}
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
    </section>
  );
}
