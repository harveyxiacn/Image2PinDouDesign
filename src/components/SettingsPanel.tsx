import type { ReactNode } from "react";
import { STYLE_PRESETS, type RecommendedSettings } from "../domain/recommend";
import type { FitMode, ImageAdjustments, MaxColors, SamplingMode } from "../domain/types";
import { BoardPicker } from "./BoardPicker";
import { IconRotateCcw, IconSparkles } from "./icons";
import { Segmented } from "./Segmented";
import { DEFAULT_SETTINGS, resolveBoardLayout, type UiSettings } from "../domain/settings";
import type { DesignSizeOption } from "../domain/designSizing";
export type { UiSettings } from "../domain/settings";

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
  sizeOptions?: DesignSizeOption[];
  onSelectSize?: (option: DesignSizeOption) => void;
  sourceName?: string;
  aspectRatio?: number | null;
  generatedSize?: { width: number; height: number } | null;
  paletteKitName?: string;
};

const mergeOptions: Array<{ label: string; value: number; title: string }> = [
  { label: "关", value: 0, title: "保留所有匹配到的颜色" },
  { label: "< 3 颗", value: 3, title: "少于 3 颗且有相近主色的颜色并入主色" },
  { label: "< 6 颗", value: 6, title: "少于 6 颗且有相近主色的颜色并入主色" },
  { label: "< 10 颗", value: 10, title: "少于 10 颗且有相近主色的颜色并入主色" }
];

const maxColorOptions: Array<{ label: string; value: MaxColors }> = [
  { label: "8", value: 8 },
  { label: "16", value: 16 },
  { label: "24", value: 24 },
  { label: "32", value: 32 },
  { label: "48", value: 48 },
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
  { label: "角色精细", value: "detail", hint: "保留主色与深色轮廓，适合动漫角色、装甲和服饰；建议搭配精细尺寸。" },
  { label: "照片平滑", value: "area", hint: "面积平均减少锯齿，适合照片、渐变和普通插画。" }
];

const adjustmentControls: Array<{ key: keyof ImageAdjustments; label: string }> = [
  { key: "brightness", label: "亮度" },
  { key: "contrast", label: "对比度" },
  { key: "saturation", label: "饱和度" }
];

type RecommendDiff = { label: string; detail: string };

const formatBoard = (settings: UiSettings): string => {
  if (settings.boardPreset === "smart") return "智能尺寸";
  if (settings.boardPreset === "custom") return `自定义 ${settings.customWidth}×${settings.customHeight}`;
  const layout = resolveBoardLayout(settings);
  return `${layout.pins} 针 ${layout.cols}×${layout.rows} 块`;
};

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
  push("尺寸", formatBoard(settings), formatBoard({ ...settings, boardPreset: recommendation.boardPreset }));
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

type SizeSettingsProps = Pick<SettingsPanelProps,
  "settings" | "onChange" | "smartSizeHint" | "sizeOptions" | "onSelectSize" | "aspectRatio" | "generatedSize">;

/** 尺寸：拼豆板针数、尺寸方式与适配方式。 */
export function SizeSettings({ settings, onChange, smartSizeHint, sizeOptions, onSelectSize, aspectRatio, generatedSize }: SizeSettingsProps) {
  const activeFit = fitOptions.find((option) => option.value === settings.fit) ?? fitOptions[0];
  return (
    <div className="settings-section">
      <BoardPicker
        settings={settings}
        onChange={onChange}
        sizeOptions={sizeOptions}
        onSelectSize={onSelectSize}
        smartSizeHint={smartSizeHint}
        aspectRatio={aspectRatio}
        generatedSize={generatedSize}
      />
      <div className="field">
        <span>适配方式</span>
        <Segmented
          label="适配方式"
          size="compact"
          value={settings.fit}
          options={fitOptions.map((option) => ({ value: option.value, label: option.label, title: option.hint }))}
          onChange={(value) => onChange({ ...settings, fit: value })}
        />
        <small className="muted">{activeFit.hint}</small>
      </div>
    </div>
  );
}

type ColorSettingsProps = Pick<SettingsPanelProps, "settings" | "onChange" | "paletteKitName"> & {
  // 色卡套装、库存模式等由 App 注入（它们是全局偏好，不随单张图纸保存）。
  children?: ReactNode;
};

/** 颜色：色卡套装（外部注入）、最大颜色数与拼豆优化。 */
export function ColorSettings({ settings, onChange, paletteKitName, children }: ColorSettingsProps) {
  return (
    <div className="settings-section">
      {children}
      <div className="field">
        <span id="max-colors-label">最大颜色数</span>
        <Segmented
          label="最大颜色数"
          size="compact"
          value={settings.maxColors}
          options={maxColorOptions.map((option) => ({ value: option.value, label: option.label }))}
          onChange={(value) => onChange({ ...settings, maxColors: value })}
        />
        <small className="muted">
          色数越少越好买豆；角色眼睛等小面积特征色会优先保留。
          {paletteKitName && <> 当前从 {paletteKitName} 中选色。</>}
        </small>
      </div>

      <div className="bead-tuning" role="group" aria-labelledby="bead-tuning-title">
        <span id="bead-tuning-title" className="bead-tuning-title">拼豆优化</span>
        <label className="toggle">
          <input
            type="checkbox"
            checked={settings.cleanupNoise ?? false}
            onChange={(event) => onChange({ ...settings, cleanupNoise: event.target.checked })}
          />
          <span>清理孤豆<small>与周围几乎同色的单颗杂点并入邻色；高光、细线等高对比细节保留。像素画和抖动不处理。</small></span>
        </label>
        <div className="field">
          <span>合并零散色</span>
          <Segmented
            label="合并零散色"
            size="compact"
            value={settings.mergeRareColors ?? 0}
            options={mergeOptions}
            onChange={(value) => onChange({ ...settings, mergeRareColors: value })}
          />
          <small className="muted">用量很少、又有相近主色可替代的颜色并入主色，少买几个色号。</small>
        </div>
      </div>
    </div>
  );
}

type EffectSettingsProps = Pick<SettingsPanelProps, "settings" | "onChange" | "onApplyPreset">;

/** 效果：风格预设、细节算法、图像预处理、降噪、抖动、透明/背景、描边与显示。 */
export function EffectSettings({ settings, onChange, onApplyPreset }: EffectSettingsProps) {
  const activeSampling = samplingOptions.find((option) => option.value === settings.sampling) ?? samplingOptions[0];
  const hasAdjustment = adjustmentControls.some(({ key }) => settings.adjustments[key] !== 0);
  const toggles: Array<{ key: "autoFrame" | "keepTransparent" | "ignoreWhiteBg" | "outline" | "showLabels"; label: string }> = [
    { key: "autoFrame", label: "智能紧贴主体（裁掉透明/白色留白，提高有效细节）" },
    { key: "keepTransparent", label: "保留 PNG 透明区域为空格" },
    { key: "ignoreWhiteBg", label: "忽略白色背景（主体外白色不计入、不标色号）" },
    { key: "outline", label: "黑色描边（H7，包含画布最外圈）" },
    { key: "showLabels", label: "在图纸格子中显示色号" }
  ];
  return (
    <div className="settings-section">
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
              onClick={() => onChange({ ...settings, adjustments: { brightness: 0, contrast: 0, saturation: 0 } })}
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

      <div className="field">
        <span>色块简化 / 降噪</span>
        <Segmented
          label="色块简化"
          size="compact"
          value={settings.smooth}
          options={smoothOptions}
          onChange={(value) => onChange({ ...settings, smooth: value })}
        />
        <small className="muted">把碎噪点合并成干净色块；截图/照片类源建议开「弱」或「强」。</small>
      </div>

      <div className="field">
        <span>抖动</span>
        <Segmented
          label="抖动"
          size="compact"
          value={settings.dither ? settings.ditherMode : "off"}
          options={[
            { value: "off", label: "关" },
            { value: "floyd-steinberg", label: "误差扩散", title: "适合照片渐变" },
            { value: "bayer", label: "有序", title: "Bayer 4×4，保留硬边" }
          ]}
          onChange={(value) => onChange(value === "off"
            ? { ...settings, dither: false }
            : { ...settings, dither: true, ditherMode: value as "floyd-steinberg" | "bayer" })}
        />
        <small className="muted">用相邻豆子的混色模拟渐变；平涂角色一般保持关闭。</small>
      </div>

      <div className="toggle-list">
        {toggles.map(({ key, label }) => (
          <label className="toggle" key={key}>
            <input
              type="checkbox"
              checked={settings[key]}
              onChange={(event) => onChange({ ...settings, [key]: event.target.checked })}
            />
            <span>{label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

type RecommendationCardProps = {
  settings: UiSettings;
  recommendation: RecommendedSettings;
  onApply: () => void;
};

/** 智能推荐：只列与当前设置不同的项；全部一致时收起成一行确认。 */
export function RecommendationCard({ settings, recommendation, onApply }: RecommendationCardProps) {
  const diffs = buildRecommendDiffs(settings, recommendation);
  return (
    <div className={`recommend-box ${diffs.length === 0 ? "is-settled" : ""}`} role="group" aria-labelledby="recommend-title">
      <div className="recommend-head">
        <span id="recommend-title"><IconSparkles className="button-icon" />智能推荐</span>
        {diffs.length > 0 && (
          <button type="button" className="button small recommend-apply" onClick={onApply}>
            一键应用
          </button>
        )}
      </div>
      {diffs.length === 0 ? (
        <p className="muted recommend-ok">当前设置已符合推荐。</p>
      ) : (
        <ul className="recommend-diffs">
          {diffs.map((diff) => (
            <li key={diff.label}>
              <span>{diff.label}</span>
              <b>{diff.detail}</b>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 完整设置面板（各分区依次排列）；工作台里由 Inspector 按标签页分别使用各分区。 */
export function SettingsPanel(props: SettingsPanelProps) {
  const { settings, onChange, recommendation, onApplyRecommendation, sourceName } = props;
  return (
    <section className="panel settings-panel" aria-labelledby="settings-title">
      <div className="section-header settings-head">
        <h2 id="settings-title">生成设置</h2>
        <button type="button" className="link-button" onClick={() => onChange(DEFAULT_SETTINGS)} title="恢复全部设置为默认值">
          <IconRotateCcw className="link-button-icon" />
          恢复默认
        </button>
      </div>
      {sourceName && <p className="muted settings-scope">当前图片：{sourceName}。调整仅影响这张图纸。</p>}
      {recommendation && onApplyRecommendation && (
        <RecommendationCard settings={settings} recommendation={recommendation} onApply={onApplyRecommendation} />
      )}
      <SizeSettings {...props} />
      <ColorSettings {...props} />
      <EffectSettings {...props} />
    </section>
  );
}
