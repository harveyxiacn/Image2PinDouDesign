import { BOARD_PRESETS } from "../domain/boards";
import { STYLE_PRESETS, type RecommendedSettings } from "../domain/recommend";
import type { FitMode, ImageAdjustments, MaxColors, SamplingMode } from "../domain/types";
import { IconChevronDown, IconRotateCcw } from "./icons";

export type UiSettings = {
  boardPreset: string;
  customWidth: number;
  customHeight: number;
  maxColors: MaxColors;
  keepTransparent: boolean;
  showLabels: boolean;
  fit: FitMode;
  sampling: SamplingMode;
  autoFrame: boolean;
  dither: boolean;
  ditherMode: "floyd-steinberg" | "bayer";
  adjustments: ImageAdjustments;
  smooth: number;
  outline: boolean;
  ignoreWhiteBg: boolean;
};

/** 与 App.tsx initialSettings 保持一致的默认值，用于“恢复默认”。 */
const DEFAULT_SETTINGS: UiSettings = {
  boardPreset: "smart",
  customWidth: 64,
  customHeight: 64,
  maxColors: 24,
  keepTransparent: true,
  showLabels: true,
  fit: "contain",
  sampling: "auto",
  autoFrame: true,
  dither: false,
  ditherMode: "floyd-steinberg",
  adjustments: { brightness: 0, contrast: 0, saturation: 0 },
  smooth: 0,
  outline: false,
  ignoreWhiteBg: true
};

const smoothOptions: Array<{ label: string; value: number }> = [
  { label: "关", value: 0 },
  { label: "弱", value: 1 },
  { label: "强", value: 2 }
];

type SettingsPanelProps = {
  settings: UiSettings;
  onChange: (settings: UiSettings) => void;
  onApplyPreset?: (presetId: string) => void;
  recommendation?: RecommendedSettings | null;
  onApplyRecommendation?: () => void;
  smartSizeHint?: string | null;
};

const maxColorOptions: Array<{ label: string; value: MaxColors }> = [
  { label: "8 色", value: 8 },
  { label: "16 色", value: 16 },
  { label: "24 色", value: 24 },
  { label: "32 色", value: 32 },
  { label: "48 色", value: 48 },
  { label: "全部", value: "all" }
];

const fitOptions: Array<{ label: string; value: FitMode; hint: string }> = [
  { label: "完整显示", value: "contain", hint: "保持原图比例，空白区当作空格" },
  { label: "填满裁剪", value: "cover", hint: "保持原图比例，围绕自动或手动焦点裁掉超出部分" },
  { label: "拉伸", value: "stretch", hint: "强制铺满整块板，可能变形" }
];

const samplingOptions: Array<{ label: string; value: SamplingMode; hint: string }> = [
  { label: "智能细节（推荐）", value: "auto", hint: "自动识别像素画并保持硬边；照片继续平滑缩放。" },
  { label: "像素锐利", value: "nearest", hint: "不混合相邻色块，适合像素画、图标和已有拼豆图。" },
  { label: "照片平滑", value: "area", hint: "面积平均减少锯齿，适合照片、渐变和普通插画。" }
];

const adjustmentControls: Array<{ key: keyof ImageAdjustments; label: string }> = [
  { key: "brightness", label: "亮度" },
  { key: "contrast", label: "对比度" },
  { key: "saturation", label: "饱和度" }
];

type RecommendDiff = { label: string; detail: string };

const formatBoard = (id: string): string =>
  BOARD_PRESETS.find((preset) => preset.id === id)?.name ?? id;

const formatColors = (value: string | number): string =>
  value === "all" ? "全部" : `${value} 色`;

const formatSampling = (value: string): string =>
  samplingOptions.find((option) => option.value === value)?.label ?? value;

const formatOnOff = (value: boolean): string => (value ? "开" : "关");
const formatDitherMode = (value: "floyd-steinberg" | "bayer"): string =>
  value === "bayer" ? "有序抖动" : "误差扩散";
const formatSmooth = (value: number): string => (value === 0 ? "关" : `${value} 级`);

/** 推荐值 vs 当前值：只列有差异的要点，标签用中文短词。 */
function buildRecommendDiffs(settings: UiSettings, recommendation: RecommendedSettings): RecommendDiff[] {
  const diffs: RecommendDiff[] = [];
  const push = (label: string, current: string, recommended: string) => {
    if (current !== recommended) {
      diffs.push({ label, detail: `${current} → ${recommended}` });
    }
  };
  push("板型", formatBoard(settings.boardPreset), formatBoard(recommendation.boardPreset));
  push("色数", formatColors(settings.maxColors), formatColors(recommendation.maxColors));
  push("采样", formatSampling(settings.sampling), formatSampling(recommendation.sampling));
  push("抖动", formatOnOff(settings.dither), formatOnOff(recommendation.dither));
  push("抖动算法", formatDitherMode(settings.ditherMode), formatDitherMode(recommendation.ditherMode));
  push("降噪", formatSmooth(settings.smooth), formatSmooth(recommendation.smooth));
  push("描边", formatOnOff(settings.outline), formatOnOff(recommendation.outline));
  push("去背景", formatOnOff(settings.ignoreWhiteBg), formatOnOff(recommendation.ignoreWhiteBg));
  push("紧贴主体", formatOnOff(settings.autoFrame), formatOnOff(recommendation.autoFrame));
  push("透明空格", formatOnOff(settings.keepTransparent), formatOnOff(recommendation.keepTransparent));
  return diffs;
}

export function SettingsPanel({
  settings,
  onChange,
  onApplyPreset,
  recommendation,
  onApplyRecommendation,
  smartSizeHint
}: SettingsPanelProps) {
  const activeBoard = BOARD_PRESETS.find((preset) => preset.id === settings.boardPreset) ?? BOARD_PRESETS[0];
  const activeFit = fitOptions.find((option) => option.value === settings.fit) ?? fitOptions[0];
  const activeSampling = samplingOptions.find((option) => option.value === settings.sampling) ?? samplingOptions[0];
  const hasAdjustment = adjustmentControls.some(({ key }) => settings.adjustments[key] !== 0);
  const recommendDiffs = recommendation ? buildRecommendDiffs(settings, recommendation) : [];

  return (
    <section className="panel settings-panel" aria-labelledby="settings-title">
      <div className="section-header settings-head">
        <div>
          <p className="eyebrow">Step 02</p>
          <h2 id="settings-title">生成设置</h2>
        </div>
        <button
          type="button"
          className="link-button"
          onClick={() => onChange(DEFAULT_SETTINGS)}
          title="恢复全部设置为默认值"
        >
          <IconRotateCcw className="link-button-icon" />
          恢复默认
        </button>
      </div>

      {onApplyPreset && (
        <div className="preset-section">
          <div className="preset-head">
            <span className="preset-title">风格预设</span>
            <small className="muted">一键套用常用参数组合</small>
          </div>
          <div className="preset-chips">
            {STYLE_PRESETS.map((preset) => (
              <button
                type="button"
                key={preset.id}
                className="button small preset-chip"
                title={preset.description}
                aria-label={`应用风格预设：${preset.name}`}
                onClick={() => onApplyPreset(preset.id)}
              >
                {preset.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {recommendation && onApplyRecommendation && (
        <div className="recommend-box" role="group" aria-labelledby="recommend-title">
          <div className="recommend-head">
            <span id="recommend-title">✨ 智能推荐</span>
            <button type="button" className="button small recommend-apply" onClick={onApplyRecommendation}>
              一键应用
            </button>
          </div>
          {recommendDiffs.length === 0 ? (
            <p className="muted recommend-ok">当前设置已符合推荐。</p>
          ) : (
            <ul className="recommend-diffs">
              {recommendDiffs.map((diff) => (
                <li key={diff.label}>
                  <span>{diff.label}</span>
                  <b>{diff.detail}</b>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* 基础区：高频项 */}
      <label className="field">
        <span>板型</span>
        <select
          aria-label="板型"
          value={settings.boardPreset}
          onChange={(event) => onChange({ ...settings, boardPreset: event.target.value })}
        >
          {BOARD_PRESETS.map((preset) => (
            <option value={preset.id} key={preset.id}>{preset.name}</option>
          ))}
        </select>
        <small className="muted">{activeBoard.description}</small>
        {settings.boardPreset === "smart" && smartSizeHint && (
          <small className="smart-size-feedback" aria-live="polite">{smartSizeHint}</small>
        )}
      </label>

      {settings.boardPreset === "custom" && (
        <div className="inline-fields">
          <label className="field">
            <span>宽度</span>
            <input
              type="number"
              min={8}
              max={208}
              value={settings.customWidth}
              onChange={(event) => onChange({ ...settings, customWidth: Number(event.target.value) })}
            />
          </label>
          <label className="field">
            <span>高度</span>
            <input
              type="number"
              min={8}
              max={208}
              value={settings.customHeight}
              onChange={(event) => onChange({ ...settings, customHeight: Number(event.target.value) })}
            />
          </label>
        </div>
      )}

      <label className="field">
        <span>最大颜色数</span>
        <select
          value={String(settings.maxColors)}
          onChange={(event) => {
            const value = event.target.value === "all" ? "all" : Number(event.target.value) as MaxColors;
            onChange({ ...settings, maxColors: value });
          }}
        >
          {maxColorOptions.map((option) => (
            <option key={String(option.value)} value={String(option.value)}>{option.label}</option>
          ))}
        </select>
      </label>

      <label className="field">
        <span>适配方式</span>
        <select
          aria-label="适配方式"
          value={settings.fit}
          onChange={(event) => onChange({ ...settings, fit: event.target.value as FitMode })}
        >
          {fitOptions.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        <small className="muted">{activeFit.hint}</small>
      </label>

      {/* 高级区：低频项渐进披露 */}
      <details className="advanced-settings">
        <summary className="advanced-summary">
          <span className="advanced-summary-label">
            <IconChevronDown className="advanced-chevron" />
            高级选项
          </span>
          <small>细节算法、图像预处理、描边与显示</small>
        </summary>

        <div className="advanced-body">
          <label className="field">
            <span>细节算法</span>
            <select
              aria-label="细节算法"
              value={settings.sampling}
              onChange={(event) => onChange({ ...settings, sampling: event.target.value as SamplingMode })}
            >
              {samplingOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <small className="muted">{activeSampling.hint}</small>
          </label>

          <div className="field">
            <div className="field-head">
              <span>图像预处理</span>
              {hasAdjustment && (
                <button
                  type="button"
                  className="link-button"
                  onClick={() => onChange({
                    ...settings,
                    adjustments: { brightness: 0, contrast: 0, saturation: 0 }
                  })}
                >
                  重置
                </button>
              )}
            </div>
            {adjustmentControls.map(({ key, label }) => (
              <label className="slider-row" key={key}>
                <span>{label}</span>
                <input
                  type="range"
                  min={-100}
                  max={100}
                  step={1}
                  value={settings.adjustments[key]}
                  onChange={(event) => onChange({
                    ...settings,
                    adjustments: { ...settings.adjustments, [key]: Number(event.target.value) }
                  })}
                />
                <small className="slider-value">{settings.adjustments[key]}</small>
              </label>
            ))}
          </div>

          <label className="field">
            <span>色块简化 / 降噪</span>
            <select
              aria-label="色块简化"
              value={String(settings.smooth)}
              onChange={(event) => onChange({ ...settings, smooth: Number(event.target.value) })}
            >
              {smoothOptions.map((option) => (
                <option key={option.value} value={String(option.value)}>{option.label}</option>
              ))}
            </select>
            <small className="muted">把碎噪点合并成干净色块；截图/照片类源建议开「弱」或「强」。</small>
          </label>

          <label className="toggle">
            <input
              type="checkbox"
              checked={settings.autoFrame}
              onChange={(event) => onChange({ ...settings, autoFrame: event.target.checked })}
            />
            <span>智能紧贴主体（裁掉透明/白色留白，提高有效细节）</span>
          </label>

          <label className="toggle">
            <input
              type="checkbox"
              checked={settings.dither}
              onChange={(event) => onChange({ ...settings, dither: event.target.checked })}
            />
            <span>启用抖动</span>
          </label>
          {settings.dither && (
            <label className="field">
              <span>抖动算法</span>
              <select
                aria-label="抖动算法"
                value={settings.ditherMode}
                onChange={(event) =>
                  onChange({ ...settings, ditherMode: event.target.value as "floyd-steinberg" | "bayer" })
                }
              >
                <option value="floyd-steinberg">Floyd-Steinberg（误差扩散，推荐）</option>
                <option value="bayer">Bayer 4×4（有序抖动，适合像素画硬边）</option>
              </select>
              <small className="muted">误差扩散适合照片渐变；有序抖动保留硬边细节。</small>
            </label>
          )}

          <label className="toggle">
            <input
              type="checkbox"
              checked={settings.keepTransparent}
              onChange={(event) => onChange({ ...settings, keepTransparent: event.target.checked })}
            />
            <span>保留 PNG 透明区域为空格</span>
          </label>

          <label className="toggle">
            <input
              type="checkbox"
              checked={settings.ignoreWhiteBg}
              onChange={(event) => onChange({ ...settings, ignoreWhiteBg: event.target.checked })}
            />
            <span>忽略白色背景（主体外白色不计入、不标色号）</span>
          </label>

          <label className="toggle">
            <input
              type="checkbox"
              checked={settings.showLabels}
              onChange={(event) => onChange({ ...settings, showLabels: event.target.checked })}
            />
            <span>在图纸格子中显示色号</span>
          </label>

          <label className="toggle">
            <input
              type="checkbox"
              checked={settings.outline}
              onChange={(event) => onChange({ ...settings, outline: event.target.checked })}
            />
            <span>黑色描边（H7，包含画布最外圈）</span>
          </label>
        </div>
      </details>
    </section>
  );
}
