import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { RemovalProgress } from "../domain/backgroundRemoval";
import { IconClose, IconTrash } from "./icons";

export type CropFractions = { fx: number; fy: number; fw: number; fh: number };

type CropDialogProps = {
  previewUrl: string;
  title: string;
  busy: boolean;
  progress: RemovalProgress | null;
  onCancel: () => void;
  onSubmit: (rect: CropFractions | null, removeBg: boolean) => void;
};

type DragRect = { x: number; y: number; w: number; h: number };

export function CropDialog({ previewUrl, title, busy, progress, onCancel, onSubmit }: CropDialogProps) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [rect, setRect] = useState<DragRect | null>(null);
  const [removeBg, setRemoveBg] = useState(true);
  const dragStart = useRef<{ x: number; y: number } | null>(null);

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
    if (busy) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = relativePoint(event);
    dragStart.current = point;
    setRect({ x: point.x, y: point.y, w: 0, h: 0 });
  };

  const handlePointerMove = (event: ReactPointerEvent) => {
    if (!dragStart.current) {
      return;
    }
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
    onSubmit(fractions, removeBg);
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

        <p className="muted">在图上拖一个框圈住一个主体（不框则用整张图）。智能去背景会优先精准清除纯色底，复杂背景再使用 AI，并自动裁到主体边界。</p>

        <div
          className="crop-frame"
          ref={frameRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        >
          <img src={previewUrl} alt={title} draggable={false} />
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

        <div className="crop-controls">
          <label className="toggle">
            <input type="checkbox" checked={removeBg} onChange={(event) => setRemoveBg(event.target.checked)} disabled={busy} />
            <span>智能去背景（复杂背景首次会下载 AI 模型）</span>
          </label>
          <div className="button-row">
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
