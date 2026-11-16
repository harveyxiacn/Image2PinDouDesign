import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import {
  buildMattingPreview,
  describeBackground,
  localMethodLine,
  STRENGTH_LABELS,
  type MattingEdits,
  type MattingStrength
} from "../domain/matting";
import type { BackgroundMethod } from "../domain/backgroundRemoval";
import type { PixelSource } from "../domain/types";
import "./background-matting.css";

export type MattingSettings = {
  strength: MattingStrength;
  edits: MattingEdits;
  method: BackgroundMethod;
};

export const DEFAULT_MATTING: MattingSettings = {
  strength: "standard",
  edits: { keep: [], remove: [] },
  method: "auto"
};

type EditTool = "none" | "remove" | "keep";
type EditAction = { kind: "keep" | "remove"; index: number };

type Props = {
  source: PixelSource;
  value: MattingSettings;
  disabled: boolean;
  onChange: (next: MattingSettings) => void;
};

const STRENGTHS: MattingStrength[] = ["conservative", "standard", "strong"];

export function BackgroundMattingPanel({ source, value, disabled, onChange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [tool, setTool] = useState<EditTool>("none");
  const [view, setView] = useState<"after" | "before">("after");
  const [history, setHistory] = useState<EditAction[]>([]);

  const preview = useMemo(
    () => buildMattingPreview(source, value.strength, value.edits),
    [source, value.strength, value.edits]
  );
  const forcedLocal = value.method === "local";
  // 背景杂乱且未强制本地：预览不跑算法，提交时由 AI 模型处理。
  const modelPending = !preview.analysis.usable && !forcedLocal;
  const shown = view === "before" || !preview.output ? preview.source : preview.output.source;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      canvas.width = shown.width;
      canvas.height = shown.height;
      const context = canvas.getContext("2d");
      if (!context) return;
      const image = context.createImageData(shown.width, shown.height);
      image.data.set(shown.data);
      context.putImageData(image, 0, 0);
    } catch {
      // 无 Canvas 环境（如测试）：忽略预览绘制。
    }
  }, [shown]);

  let line: string;
  if (modelPending) {
    line = `${describeBackground(preview.analysis)}，本地方式不够准，添加时会改用 AI 模型（首次需联网下载，下载失败会自动退回本地方式）。`;
  } else if (preview.output) {
    line = localMethodLine(preview.analysis);
  } else if (preview.analysis.usable) {
    line = `${describeBackground(preview.analysis)}，但没有可去除的部分，将保持原图。`;
  } else {
    line = "已选择只用本地方式；背景较杂，可能留有残余，可用「点选去除」修正。";
  }

  const editable = !disabled && !modelPending;

  const handlePointer = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!editable || tool === "none" || view === "before") return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const point = {
      x: Math.min(source.width - 1, Math.max(0, ((event.clientX - bounds.left) / bounds.width) * source.width)),
      y: Math.min(source.height - 1, Math.max(0, ((event.clientY - bounds.top) / bounds.height) * source.height))
    };
    const list = tool === "keep" ? value.edits.keep : value.edits.remove;
    onChange({ ...value, edits: { ...value.edits, [tool]: [...list, point] } });
    setHistory((current) => [...current, { kind: tool, index: list.length }]);
  };

  const undoEdit = () => {
    const last = history[history.length - 1];
    if (!last) return;
    const list = value.edits[last.kind].slice(0, last.index);
    onChange({ ...value, edits: { ...value.edits, [last.kind]: list } });
    setHistory((current) => current.slice(0, -1));
  };

  const resetAll = () => {
    onChange({ ...DEFAULT_MATTING, method: value.method });
    setHistory([]);
    setTool("none");
    setView("after");
  };

  const dirty = value.strength !== "standard" || value.edits.keep.length + value.edits.remove.length > 0;

  return (
    <section className="matting-panel" aria-label="去背景调整" data-matting-panel>
      <p className="matting-line" role="status" aria-live="polite" data-matting-line>{line}</p>

      <div className="matting-row">
        <div className="matting-seg" role="group" aria-label="去背景力度">
          {STRENGTHS.map((strength) => (
            <button
              key={strength}
              type="button"
              aria-pressed={value.strength === strength}
              data-matting-strength={strength}
              disabled={disabled}
              onClick={() => onChange({ ...value, strength })}
            >
              {STRENGTH_LABELS[strength]}
            </button>
          ))}
        </div>
        <div className="matting-seg" role="group" aria-label="前后对比">
          <button type="button" aria-pressed={view === "before"} data-matting-view="before" onClick={() => setView("before")} disabled={disabled}>原图</button>
          <button type="button" aria-pressed={view === "after"} data-matting-view="after" onClick={() => setView("after")} disabled={disabled}>去背景后</button>
        </div>
      </div>

      <div className="matting-stage">
        <canvas
          ref={canvasRef}
          className={`matting-canvas matting-tool-${tool}`}
          data-matting-preview
          role="img"
          aria-label={view === "before" ? "原图预览" : "去背景后的预览"}
          onPointerDown={handlePointer}
        />
      </div>

      <div className="matting-row">
        <div className="matting-seg" role="group" aria-label="点选修正">
          <button
            type="button"
            aria-pressed={tool === "remove"}
            data-matting-tool="remove"
            disabled={!editable}
            onClick={() => { setTool(tool === "remove" ? "none" : "remove"); setView("after"); }}
          >
            点选去除
          </button>
          <button
            type="button"
            aria-pressed={tool === "keep"}
            data-matting-tool="keep"
            disabled={!editable}
            onClick={() => { setTool(tool === "keep" ? "none" : "keep"); setView("after"); }}
          >
            点选保留
          </button>
        </div>
        <button type="button" className="button secondary" data-matting-undo onClick={undoEdit} disabled={disabled || history.length === 0}>
          撤销一步
        </button>
        <button type="button" className="button secondary" data-matting-reset onClick={resetAll} disabled={disabled || !dirty}>
          还原
        </button>
      </div>
      <p className="matting-hint">
        {tool === "none" ? "去得不对？选一种力度，或选「点选去除 / 点选保留」后点预览图上的位置。" : tool === "remove" ? "点预览图上还想去掉的背景区域。" : "点预览图上被误去掉的部分，把它保留下来。"}
        {` 保守：只清明显背景；强力：连阴影和封闭的白块也一起清，可能误伤主体里的白色。`}
      </p>

      <label className="matting-local">
        <input
          type="checkbox"
          data-matting-local
          checked={forcedLocal}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, method: event.target.checked ? "local" : "auto" })}
        />
        <span>只用本地快速方式（不下载 AI 模型）</span>
      </label>
    </section>
  );
}
