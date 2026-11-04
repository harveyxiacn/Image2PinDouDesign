import { useRef } from "react";
import type { View } from "./zoomMath";

/**
 * 原图 / 高清 对比分隔线（作为 ZoomPan 的叠层，不随缩放变粗）。pos = 分隔位置，内容比例 0–1：
 * 左边显示原图、右边显示高清。拖动手柄（指针事件，触屏可用）或聚焦后用 ← → 键移动（Shift 为大步，Home/End 到两端）。
 * 手柄的 pointerdown 不会冒泡，所以拖它不会平移图片。
 */
export default function CompareHandle({ pos, onPos, v, box, leftLabel = "原图", rightLabel = "高清" }: {
  pos: number; onPos: (p: number) => void; v: View; box: { w: number; h: number }; leftLabel?: string; rightLabel?: string;
}) {
  const drag = useRef(false);
  const ws = box.w * v.s;
  const xs = box.w / 2 + v.x + (pos - 0.5) * ws; // 分隔线在容器内的 x
  const inView = xs >= 0 && xs <= box.w;
  const x = Math.max(0, Math.min(box.w, xs));
  const at = (e: React.PointerEvent) => {
    const r = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
    const p = (e.clientX - r.left - box.w / 2 - v.x) / ws + 0.5;
    onPos(Math.max(0, Math.min(1, p)));
  };
  const pct = Math.round(pos * 100);
  return (
    <>
      <span className="pt-cmp-tag l">{leftLabel}</span>
      <span className="pt-cmp-tag r">{rightLabel}</span>
      <div className="pt-cmp-line" data-edge={!inView} style={{ left: x }}>
        <div
          className="pt-cmp-knob" role="slider" tabIndex={0} aria-label={`${leftLabel}与${rightLabel}对比分隔位置`} aria-orientation="horizontal"
          aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-valuetext={`${leftLabel} ${pct}%，${rightLabel} ${100 - pct}%`}
          onPointerDown={(e) => { e.stopPropagation(); drag.current = true; e.currentTarget.setPointerCapture(e.pointerId); at(e); }}
          onPointerMove={(e) => { if (drag.current) { e.stopPropagation(); at(e); } }}
          onPointerUp={(e) => { drag.current = false; e.stopPropagation(); }}
          onPointerCancel={() => { drag.current = false; }}
          onKeyDown={(e) => {
            const big = e.shiftKey ? 0.1 : 0.02;
            let n: number | null = null;
            if (e.key === "ArrowLeft" || e.key === "ArrowDown") n = pos - big;
            else if (e.key === "ArrowRight" || e.key === "ArrowUp") n = pos + big;
            else if (e.key === "Home") n = 0;
            else if (e.key === "End") n = 1;
            if (n == null) return;
            e.preventDefault(); e.stopPropagation();
            onPos(Math.max(0, Math.min(1, n)));
          }}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 7l-5 5 5 5M15 7l5 5-5 5" /></svg>
        </div>
      </div>
    </>
  );
}
