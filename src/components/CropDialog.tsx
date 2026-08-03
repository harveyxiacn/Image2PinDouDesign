import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import type { RemovalProgress } from "../domain/backgroundRemoval";
import { computeCropRect, estimateFocus, type FocusPoint } from "../domain/focus";
import type { FitMode, PixelSource } from "../domain/types";
import { IconClose, IconTrash } from "./icons";

export type CropFractions = { fx: number; fy: number; fw: number; fh: number };

type CropDialogProps = {
  previewUrl: string;
  source: PixelSource;
  title: string;
  fitMode: FitMode;
  targetAspect: number;
  busy: boolean;
  progress: RemovalProgress | null;
  onCancel: () => void;
  onSubmit: (rect: CropFractions | null, removeBg: boolean, focus: FocusPoint) => void;
};

type DragRect = { x: number; y: number; w: number; h: number };
type CropTool = "focus" | "selection";

export function CropDialog({
  previewUrl,
  source,
  title,
  fitMode,
  targetAspect,
  busy,
  progress,
  onCancel,
  onSubmit
}: CropDialogProps) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [rect, setRect] = useState<DragRect | null>(null);
  const [removeBg, setRemoveBg] = useState(true);
  const [tool, setTool] = useState<CropTool>("focus");
  const autoFocus = useMemo(() => estimateFocus(source), [source]);
  const [focus, setFocus] = useState<FocusPoint>(autoFocus);
  const [focusOrigin, setFocusOrigin] = useState<"auto" | "manual">("auto");
  const dragStart = useRef<{ x: number; y: number } | null>(null);

  const cropWindow = useMemo(() => computeCropRect(
    source,
    focus,
    fitMode === "cover" ? "cover" : "contain",
    targetAspect
  ), [fitMode, focus, source, targetAspect]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [busy, onCancel]);

  const relativePoint = (event: ReactPointerEvent) => {
    const frame = frameRef.current;
    if (!frame) {
      return { x: 0, y: 0 };
    }
    const bounds = frame.getBoundingClientRect();
    return {
      x: clamp(event.clientX - bounds.left, 0, bounds.width),
      y: clamp(event.clientY - bounds.top, 0, bounds.height)
    };
  };

  const handlePointerDown = (event: ReactPointerEvent) => {
    if (busy) return;
    (event.currentTarget as HTMLElement).focus();
    const point = relativePoint(event);
    if (tool === "focus") {
      setFocusFromFramePoint(point);
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStart.current = point;
    setRect({ x: point.x, y: point.y, w: 0, h: 0 });
  };

  const handlePointerMove = (event: ReactPointerEvent) => {
    if (tool !== "selection" || !dragStart.current) return;
    const point = relativePoint(event);
    const start = dragStart.current;
    setRect({
      x: Math.min(start.x, point.x),
      y: Math.min(start.y, point.y),
      w: Math.abs(point.x - start.x),
      h: Math.abs(point.y - start.y)
    });
  };

  const handlePointerUp = () => {
    dragStart.current = null;
  };

  const handleFrameKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (busy || tool !== "focus" || !event.key.startsWith("Arrow")) return;
    event.preventDefault();
    const stepX = Math.max(1, source.width * (event.shiftKey ? 0.1 : 0.02));
    const stepY = Math.max(1, source.height * (event.shiftKey ? 0.1 : 0.02));
    setFocus((current) => ({
      x: clamp(current.x + (event.key === "ArrowLeft" ? -stepX : event.key === "ArrowRight" ? stepX : 0), 0, source.width - 1),
      y: clamp(current.y + (event.key === "ArrowUp" ? -stepY : event.key === "ArrowDown" ? stepY : 0), 0, source.height - 1)
    }));
    setFocusOrigin("manual");
  };

  const setFocusFromFramePoint = (point: { x: number; y: number }) => {
    const frame = frameRef.current;
    if (!frame) return;
    const bounds = frame.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    setFocus({
      x: (point.x / bounds.width) * Math.max(0, source.width - 1),
      y: (point.y / bounds.height) * Math.max(0, source.height - 1)
    });
    setFocusOrigin("manual");
    setRect(null);
  };

  const resetAutoFocus = () => {
    setFocus(autoFocus);
    setFocusOrigin("auto");
    setRect(null);
    setTool("focus");
  };

  const submit = () => {
    const frame = frameRef.current;
    let fractions: CropFractions | null = null;
    if (frame && rect && rect.w > 6 && rect.h > 6) {
      const bounds = frame.getBoundingClientRect();
      fractions = {
        fx: rect.x / bounds.width,
        fy: rect.y / bounds.height,
        fw: rect.w / bounds.width,
        fh: rect.h / bounds.height
      };
    }
    onSubmit(fractions, removeBg, focus);
  };

  const progressPercent = progress ? Math.round(progress.ratio * 100) : null;
  const progressText = !progress
    ? "正在分析背景…"
    : progress.stage === "analyze"
      ? "正在识别背景类型…"
      : progress.stage === "solid-background"
        ? "纯色背景已清理"
        : progress.stage === "already-transparent"
          ? "图片已有透明背景"
          : `AI 正在抠图… ${progressPercent}%`;

  return (
    <div className="crop-overlay" role="dialog" aria-modal="true" aria-label="裁剪与抠图">
      <div className="crop-modal">
        <div className="crop-head">
          <h3>{title}</h3>
          <button type="button" className="link-button" onClick={onCancel} disabled={busy}>
            <IconClose className="link-button-icon" />
            关闭
          </button>
        </div>

        <p className="muted">点击设置主体焦点，填满裁剪时会围绕焦点智能取景；也可切换为手动框选。智能去背景会优先清理纯色底，复杂背景再使用 AI。</p>

        <div className="crop-tool-switch" role="group" aria-label="裁剪工具">
          <button
            type="button"
            aria-pressed={tool === "focus"}
            onClick={() => { setTool("focus"); setRect(null); }}
            disabled={busy}
          >
            设置焦点
          </button>
          <button
            type="button"
            aria-pressed={tool === "selection"}
            onClick={() => setTool("selection")}
            disabled={busy}
          >
            手动框选
          </button>
        </div>

        <div
          className={`crop-frame crop-frame-${tool}`}
          ref={frameRef}
          tabIndex={busy ? -1 : 0}
          role="group"
          aria-label={tool === "focus" ? "图片焦点区域，可点击或用方向键移动焦点" : "图片裁剪区域，可拖动框选主体"}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onKeyDown={handleFrameKeyDown}
        >
          <img src={previewUrl} alt={title} draggable={false} />
          {!rect && (
            <div
              className="crop-window-preview"
              aria-hidden="true"
              style={{
                left: `${(cropWindow.x / source.width) * 100}%`,
                top: `${(cropWindow.y / source.height) * 100}%`,
                width: `${(cropWindow.width / source.width) * 100}%`,
                height: `${(cropWindow.height / source.height) * 100}%`
              }}
            />
          )}
          {!rect && (
            <span
              className="crop-focus-marker"
              aria-hidden="true"
              style={{
                left: `${source.width > 1 ? (focus.x / (source.width - 1)) * 100 : 50}%`,
                top: `${source.height > 1 ? (focus.y / (source.height - 1)) * 100 : 50}%`
              }}
            />
          )}
          {rect && rect.w > 0 && rect.h > 0 && (
            <div
              className="crop-selection"
              style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
            />
          )}
          {busy && (
            <div className="crop-busy" role="status" aria-live="polite">
              <span>{progressText}</span>
              {progressPercent !== null && (
                <div
                  className="crop-progress"
                  role="progressbar"
                  aria-label="去背景进度"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={progressPercent}
                >
                  <div style={{ width: `${progressPercent}%` }} />
                </div>
              )}
            </div>
          )}
        </div>

        <p className="crop-focus-status" aria-live="polite">
          {rect && rect.w > 6 && rect.h > 6
            ? "当前使用手动选框；选框优先于焦点。"
            : `${focusOrigin === "auto" ? "已使用自动焦点" : "已设置手动焦点"} · ${fitMode === "cover" ? "蓝框为最终填满裁剪范围" : "完整显示模式保留整张图片"}`}
        </p>

        <div className="crop-controls">
          <label className="toggle">
            <input type="checkbox" checked={removeBg} onChange={(event) => setRemoveBg(event.target.checked)} disabled={busy} />
            <span>智能去背景（复杂背景首次会下载 AI 模型）</span>
          </label>
          <div className="button-row">
            <button type="button" className="button secondary" onClick={resetAutoFocus} disabled={busy}>
              恢复自动焦点
            </button>
            <button type="button" className="button secondary" onClick={() => setRect(null)} disabled={busy || !rect}>
              <IconTrash className="button-icon" />
              清除选框
            </button>
            <button type="button" className="button primary" onClick={submit} disabled={busy}>添加为新图纸</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
