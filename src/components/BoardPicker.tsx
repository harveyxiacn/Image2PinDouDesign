import { useState } from "react";
import {
  BOARD_PIN_OPTIONS,
  MAX_BOARD_PINS,
  MIN_BOARD_PINS,
  boardsNeeded,
  maxBoardsPerSide,
  sanitizeBoardPins,
  suggestBoardLayout
} from "../domain/boards";
import type { DesignSizeOption } from "../domain/designSizing";
import { resolveBoardLayout, resolveBoardSize, resolveTilePins, type UiSettings } from "../domain/settings";
import { IconMinus, IconPlus, IconWand } from "./icons";
import { Segmented } from "./Segmented";

export type SizeMode = "smart" | "boards" | "custom";

type BoardPickerProps = {
  settings: UiSettings;
  onChange: (settings: UiSettings) => void;
  sizeOptions?: DesignSizeOption[];
  onSelectSize?: (option: DesignSizeOption) => void;
  smartSizeHint?: string | null;
  // 当前图片（紧贴主体后）的宽 / 高，用于按比例排板和示意图里的主体框。
  aspectRatio?: number | null;
  // 智能尺寸下实际生成的图纸尺寸（来自最近一次转换结果）。
  generatedSize?: { width: number; height: number } | null;
};

// 标准 5mm 拼豆的豆距约 5mm，用于估算成品尺寸。
const BEAD_PITCH_MM = 5;

export function getSizeMode(settings: UiSettings, sizeOptions?: DesignSizeOption[]): SizeMode {
  if (settings.boardPreset === "smart") return "smart";
  if (settings.boardPreset === "custom") {
    const fromRatio = sizeOptions?.some((option) =>
      option.width === settings.customWidth && option.height === settings.customHeight);
    return fromRatio ? "smart" : "custom";
  }
  return "boards";
}

export function BoardPicker({
  settings,
  onChange,
  sizeOptions,
  onSelectSize,
  smartSizeHint,
  aspectRatio,
  generatedSize
}: BoardPickerProps) {
  const mode = getSizeMode(settings, sizeOptions);
  const layout = resolveBoardLayout(settings);
  const pins = mode === "boards" ? layout.pins : resolveTilePins(settings);
  const isPresetPins = BOARD_PIN_OPTIONS.some((option) => option.pins === pins);
  const [otherPinsOpen, setOtherPinsOpen] = useState(!isPresetPins);
  const showOtherPins = otherPinsOpen || !isPresetPins;

  const size = mode === "smart" && settings.boardPreset === "smart"
    ? generatedSize ?? null
    : resolveBoardSize(settings);
  const needed = size ? boardsNeeded(size.width, size.height, pins) : null;

  const switchMode = (next: SizeMode) => {
    if (next === mode) return;
    if (next === "smart") {
      onChange({ ...settings, boardPreset: "smart" });
    } else if (next === "boards") {
      const start = settings.boardPreset === "boards"
        ? layout
        : aspectRatio
          ? suggestBoardLayout(aspectRatio, pins, Math.max(layout.cols, layout.rows))
          : { pins, cols: layout.cols, rows: layout.rows };
      onChange({ ...settings, boardPreset: "boards", boardPins: start.pins, boardCols: start.cols, boardRows: start.rows });
    } else {
      const current = size ?? resolveBoardSize(settings);
      onChange({ ...settings, boardPreset: "custom", customWidth: current.width, customHeight: current.height });
    }
  };

  const setPins = (nextPins: number) => {
    const safe = sanitizeBoardPins(nextPins);
    const limit = maxBoardsPerSide(safe);
    if (mode === "boards") {
      onChange({
        ...settings,
        boardPreset: "boards",
        boardPins: safe,
        boardCols: Math.min(layout.cols, limit),
        boardRows: Math.min(layout.rows, limit)
      });
    } else {
      onChange({ ...settings, boardPins: safe });
    }
  };

  const setLayout = (cols: number, rows: number) => {
    const limit = maxBoardsPerSide(layout.pins);
    onChange({
      ...settings,
      boardPreset: "boards",
      boardPins: layout.pins,
      boardCols: Math.max(1, Math.min(limit, cols)),
      boardRows: Math.max(1, Math.min(limit, rows))
    });
  };

  const fitLayoutToImage = () => {
    if (!aspectRatio) return;
    const next = suggestBoardLayout(aspectRatio, layout.pins, Math.max(layout.cols, layout.rows));
    setLayout(next.cols, next.rows);
  };

  return (
    <fieldset className="board-picker">
      <legend>图纸尺寸</legend>

      <div className="board-picker-row">
        <span className="board-picker-label" id="board-pins-label">我的拼豆板</span>
        <Segmented
          label="单块拼豆板针数"
          size="compact"
          value={showOtherPins ? "other" : String(pins)}
          options={[
            ...BOARD_PIN_OPTIONS.map((option) => ({ value: String(option.pins), label: option.label, title: option.hint })),
            { value: "other", label: "其他", title: `手动输入 ${MIN_BOARD_PINS}–${MAX_BOARD_PINS} 针` }
          ]}
          onChange={(value) => {
            if (value === "other") {
              setOtherPinsOpen(true);
              return;
            }
            setOtherPinsOpen(false);
            setPins(Number(value));
          }}
        />
        {showOtherPins && (
          <PinsInput value={pins} onCommit={setPins} />
        )}
        <small className="muted">粗线和打印分页按 {pins} × {pins} 针一块板划分。</small>
      </div>

      <Segmented
        label="尺寸方式"
        value={mode}
        options={[
          { value: "smart", label: "智能比例", title: "按原图主体比例选择细节档位" },
          { value: "boards", label: "按拼豆板", title: "用整块板拼接，尺寸 = 针数 × 块数" },
          { value: "custom", label: "自定义", title: "手动输入宽 × 高（1–208 格）" }
        ]}
        onChange={switchMode}
      />

      {mode === "smart" && (
        <div className="board-mode-body" key="smart">
          <div className="size-options-grid">
            <button
              type="button"
              className="size-option"
              aria-pressed={settings.boardPreset === "smart"}
              onClick={() => onChange({ ...settings, boardPreset: "smart" })}
              title="像素画还原原始格数；普通图片长边最多 104 格"
            >
              <strong>自动</strong>
              <span>{settings.boardPreset === "smart" && generatedSize ? `${generatedSize.width} × ${generatedSize.height}` : "按图识别"}</span>
              <small>像素画还原原始格</small>
            </button>
            {sizeOptions && onSelectSize && sizeOptions.map((option) => (
              <button
                key={option.id}
                type="button"
                className="size-option"
                aria-pressed={settings.boardPreset === "custom"
                  && settings.customWidth === option.width && settings.customHeight === option.height}
                onClick={() => onSelectSize(option)}
                title={option.description}
              >
                <strong>{option.label}</strong>
                <span>{option.width} × {option.height}</span>
                <small>{option.description}</small>
              </button>
            ))}
          </div>
          {!sizeOptions && <small className="muted">上传图片后按主体比例给出简洁 / 标准 / 精细档位。</small>}
          {settings.boardPreset === "smart" && smartSizeHint && (
            <small className="smart-size-feedback" aria-live="polite">{smartSizeHint}</small>
          )}
        </div>
      )}

      {mode === "boards" && (
        <div className="board-mode-body" key="boards">
          <div className="board-layout">
            <div className="board-steppers">
              <Stepper
                label="横向块数"
                value={layout.cols}
                min={1}
                max={maxBoardsPerSide(layout.pins)}
                onChange={(cols) => setLayout(cols, layout.rows)}
              />
              <Stepper
                label="纵向块数"
                value={layout.rows}
                min={1}
                max={maxBoardsPerSide(layout.pins)}
                onChange={(rows) => setLayout(layout.cols, rows)}
              />
              <button
                type="button"
                className="button small board-fit-button"
                onClick={fitLayoutToImage}
                disabled={!aspectRatio}
                title="长边保持当前块数，短边按图片比例取整，减少空白"
              >
                <IconWand className="button-icon" />按图片比例排板
              </button>
            </div>
            <BoardDiagram cols={layout.cols} rows={layout.rows} pins={layout.pins}
              aspectRatio={settings.fit === "contain" ? aspectRatio ?? null : null} />
          </div>
        </div>
      )}

      {mode === "custom" && (
        <div className="board-mode-body inline-fields" key="custom">
          <label className="field">
            <span>宽度（格）</span>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={208}
              value={settings.customWidth}
              onChange={(event) => onChange({ ...settings, customWidth: Number(event.target.value) })}
            />
          </label>
          <label className="field">
            <span>高度（格）</span>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={208}
              value={settings.customHeight}
              onChange={(event) => onChange({ ...settings, customHeight: Number(event.target.value) })}
            />
          </label>
        </div>
      )}

      <p className="board-summary" aria-live="polite">
        {size ? (
          <>
            <strong>{size.width} × {size.height}</strong> 格
            {needed && <> · {needed.cols * needed.rows} 块 {pins} 针板（{needed.cols} × {needed.rows}）</>}
            <span>成品约 {formatCm(size.width)} × {formatCm(size.height)} cm · 最多 {size.width * size.height} 颗</span>
          </>
        ) : (
          <>尺寸将在生成后按图片自动确定</>
        )}
      </p>
    </fieldset>
  );
}

function formatCm(pins: number): string {
  const cm = (pins * BEAD_PITCH_MM) / 10;
  return Number.isInteger(cm) ? String(cm) : cm.toFixed(1);
}

// 针数输入先保留草稿文本，合法（10–104）时立即生效，失焦时把不合法的输入恢复为当前值。
function PinsInput({ value, onCommit }: { value: number; onCommit: (pins: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  const [lastValue, setLastValue] = useState(value);
  if (value !== lastValue) {
    setLastValue(value);
    setDraft(String(value));
  }
  return (
    <label className="board-pins-input">
      <span>每边针数</span>
      <input
        type="number"
        inputMode="numeric"
        min={MIN_BOARD_PINS}
        max={MAX_BOARD_PINS}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          const next = Number(event.target.value);
          if (Number.isInteger(next) && next >= MIN_BOARD_PINS && next <= MAX_BOARD_PINS) onCommit(next);
        }}
        onBlur={() => setDraft(String(value))}
      />
    </label>
  );
}

type StepperProps = {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
};

function Stepper({ label, value, min, max, onChange }: StepperProps) {
  return (
    <div className="stepper" role="group" aria-label={label}>
      <span className="stepper-label">{label}</span>
      <div className="stepper-control">
        <button type="button" aria-label={`减少${label}`} onClick={() => onChange(value - 1)} disabled={value <= min}>
          <IconMinus />
        </button>
        <output aria-live="polite">{value}</output>
        <button type="button" aria-label={`增加${label}`} onClick={() => onChange(value + 1)} disabled={value >= max}>
          <IconPlus />
        </button>
      </div>
    </div>
  );
}

type BoardDiagramProps = {
  cols: number;
  rows: number;
  pins: number;
  aspectRatio: number | null;
};

/** 拼板示意：每块板一个方格；“完整显示”时叠加主体实际占用范围，直观看到留白。 */
function BoardDiagram({ cols, rows, pins, aspectRatio }: BoardDiagramProps) {
  const boardRatio = cols / rows;
  let subject: { width: number; height: number } | null = null;
  if (aspectRatio) {
    subject = aspectRatio >= boardRatio
      ? { width: 100, height: (boardRatio / aspectRatio) * 100 }
      : { width: (aspectRatio / boardRatio) * 100, height: 100 };
  }
  return (
    <div className="board-diagram-wrap" aria-hidden="true">
      <div
        className="board-diagram"
        style={{ aspectRatio: `${cols} / ${rows}`, gridTemplateColumns: `repeat(${cols}, 1fr)` }}
      >
        {Array.from({ length: cols * rows }, (_, index) => (
          <span key={`${cols}x${rows}-${index}`} style={{ animationDelay: `${index * 35}ms` }} />
        ))}
        {subject && (
          <i
            className="board-diagram-subject"
            style={{ width: `${subject.width}%`, height: `${subject.height}%` }}
          />
        )}
      </div>
      <small>{cols} × {rows} 块 · 每块 {pins} 针</small>
    </div>
  );
}
