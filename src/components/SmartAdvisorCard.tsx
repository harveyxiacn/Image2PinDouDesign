import type { ReactNode } from "react";
import type { SmartAdvice } from "../domain/smartAdvisor";
import type { PaletteColor } from "../domain/types";
import { IconSparkles } from "./icons";

type SmartAdvisorCardProps = {
  advice: SmartAdvice;
  palette: PaletteColor[];
  kitName: string;
  currentMaxColors: number | "all";
  currentSize: { width: number; height: number } | null;
  onApplyColors: () => void;
  onApplySize: () => void;
  onApplyAll: () => void;
  // 其余推荐参数（采样、抖动等）的差异明细，折叠展示。
  details?: ReactNode;
};

const COMPOSITION_SLOTS = 10;

/** 智能分析：颜色组成条 + 推荐色数 + 推荐尺寸，每条建议都附理由并可单独采用。 */
export function SmartAdvisorCard({
  advice,
  palette,
  kitName,
  currentMaxColors,
  currentSize,
  onApplyColors,
  onApplySize,
  onApplyAll,
  details
}: SmartAdvisorCardProps) {
  const byCode = new Map(palette.map((color) => [color.code, color]));
  const top = advice.colors.composition.slice(0, COMPOSITION_SLOTS);
  const rest = 1 - top.reduce((sum, entry) => sum + entry.share, 0);
  const colorsMatch = currentMaxColors === advice.colors.recommended;
  const size = advice.size;
  const sizeMatch = Boolean(size && currentSize && currentSize.width === size.width && currentSize.height === size.height);

  return (
    <section className="advisor-card" aria-labelledby="advisor-title">
      <div className="advisor-head">
        <span id="advisor-title"><IconSparkles className="button-icon" />智能分析</span>
        {(!colorsMatch || !sizeMatch) && (
          <button type="button" className="button small recommend-apply" onClick={onApplyAll}>一键采用</button>
        )}
      </div>

      <div className="composition" aria-label={`颜色组成（按 ${kitName} 匹配）`}>
        <div className="composition-bar" role="img" aria-label={top.map((entry) => `${entry.code} ${Math.round(entry.share * 100)}%`).join("，")}>
          {top.map((entry) => (
            <span
              key={entry.code}
              style={{ flexGrow: entry.share, backgroundColor: byCode.get(entry.code)?.hex ?? "#ccc" }}
              title={`${entry.code} ${byCode.get(entry.code)?.nameZh ?? ""} · ${(entry.share * 100).toFixed(1)}%`}
            />
          ))}
          {rest > 0.005 && <span className="composition-rest" style={{ flexGrow: rest }} title={`其他 ${(rest * 100).toFixed(1)}%`} />}
        </div>
        <small>
          主色：{top.slice(0, 4).map((entry) => `${entry.code} ${Math.round(entry.share * 100)}%`).join(" · ")}
          {" "}· 共约 {advice.colors.composition.length} 色，{advice.colors.colorsFor95} 色覆盖 95% 面积
        </small>
      </div>

      <div className="advisor-row">
        <div>
          <strong>推荐 {advice.colors.recommended} 色</strong>
          <small>{advice.colors.reason}</small>
        </div>
        <button type="button" className="button small" onClick={onApplyColors} disabled={colorsMatch} aria-label={`采用 ${advice.colors.recommended} 色`}>
          {colorsMatch ? "已采用" : "采用"}
        </button>
      </div>

      {size && (
        <div className="advisor-row">
          <div>
            <strong>推荐 {size.width} × {size.height} 格</strong>
            <small>
              {size.reason} 需 {size.boards.cols * size.boards.rows} 块 {size.boards.pins} 针板（{size.boards.cols} × {size.boards.rows}）。
            </small>
          </div>
          <button type="button" className="button small" onClick={onApplySize} disabled={sizeMatch} aria-label={`采用 ${size.width} × ${size.height} 格`}>
            {sizeMatch ? "已采用" : "采用"}
          </button>
        </div>
      )}

      {details && (
        <details className="advisor-details">
          <summary>其他推荐参数</summary>
          {details}
        </details>
      )}
    </section>
  );
}
