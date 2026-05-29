import { useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { RemovalProgress } from "../domain/backgroundRemoval";

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

  return (
    <div className="crop-overlay" role="dialog" aria-modal="true" aria-label="裁剪与抠图">
      <div className="crop-modal">
        <div className="crop-head">
          <h3>{title}</h3>
          <button type="button" className="link-button" onClick={onCancel} disabled={busy}>关闭</button>
        </div>

        <p className="muted">在图上拖一个框圈住一个主体（不框则用整张图）。勾选 AI 去背景会自动抠出主体并裁到主体边界。</p>

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
            <div className="crop-busy">
              <span>{progress ? `AI 去背景… ${progressPercent}%` : "处理中…"}</span>
              {progressPercent !== null && (
                <div className="crop-progress"><div style={{ width: `${progressPercent}%` }} /></div>
              )}
            </div>
          )}
        </div>

        <div className="crop-controls">
          <label className="toggle">
            <input type="checkbox" checked={removeBg} onChange={(event) => setRemoveBg(event.target.checked)} disabled={busy} />
            <span>AI 去背景（首次会下载模型，稍等片刻）</span>
          </label>
          <div className="button-row">
            <button type="button" className="button secondary" onClick={() => setRect(null)} disabled={busy || !rect}>清除选框</button>
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
