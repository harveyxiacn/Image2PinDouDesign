// 板选择：整张图的缩略图 + 板格线，每块板按完成度着色；下面再给一排按钮（读屏与键盘用）。
import { useEffect, useMemo, useRef } from "react";
import type { Board } from "../../lib/build";
import { boardProgress, cellAt } from "../../lib/build";
import type { Matrix } from "../../lib/matrix";
import { colorOf } from "../../lib/palette";

type Props = {
  matrix: Matrix;
  width: number;
  height: number;
  boards: Board[];
  flags: Uint8Array;
  current: number;
  onPick: (index: number) => void;
};

const MAX_PX = 300;

export default function BoardMap({ matrix, width, height, boards, flags, current, onPick }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const px = Math.max(1, Math.min(MAX_PX / width, MAX_PX / height));
  const cw = Math.max(1, Math.round(width * px));
  const ch = Math.max(1, Math.round(height * px));
  const progress = useMemo(() => boards.map((b) => boardProgress(matrix, flags, width, b)), [matrix, flags, width, boards]);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const root = getComputedStyle(document.documentElement);
    const leaf = root.getPropertyValue("--leaf").trim() || "#346a42";
    const paper = root.getPropertyValue("--paper").trim() || "#f4f0e6";
    const iron = root.getPropertyValue("--iron").trim() || "#c63f25";
    ctx.fillStyle = paper;
    ctx.fillRect(0, 0, cw, ch);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const c = cellAt(matrix, x, y);
        if (!c) continue;
        ctx.fillStyle = colorOf(c)?.hex ?? "#d4d4d8";
        ctx.fillRect(Math.floor(x * px), Math.floor(y * px), Math.ceil(px), Math.ceil(px));
      }
    }
    boards.forEach((b, i) => {
      const p = progress[i];
      const frac = p.total ? p.done / p.total : 1;
      const x = b.x0 * px, y = b.y0 * px, w = b.w * px, h = b.h * px;
      ctx.globalAlpha = 0.55 * (1 - frac);
      ctx.fillStyle = paper;
      ctx.fillRect(x, y, w, h);
      ctx.globalAlpha = 0.5 * frac;
      ctx.fillStyle = leaf;
      ctx.fillRect(x, y, w, h);
      ctx.globalAlpha = 1;
      ctx.lineWidth = i === current ? 3 : 1;
      ctx.strokeStyle = i === current ? iron : "rgba(40,30,20,.55)";
      ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      ctx.fillStyle = "#fff";
      ctx.strokeStyle = "rgba(0,0,0,.6)";
      ctx.lineWidth = 3;
      ctx.font = `700 ${Math.max(11, Math.min(22, Math.min(w, h) * 0.35))}px system-ui, sans-serif`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.strokeText(String(i + 1), x + w / 2, y + h / 2);
      ctx.fillText(String(i + 1), x + w / 2, y + h / 2);
    });
  }, [matrix, width, height, boards, progress, current, px, cw, ch]);

  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * width;
    const y = ((e.clientY - r.top) / r.height) * height;
    const hit = boards.find((b) => x >= b.x0 && x < b.x0 + b.w && y >= b.y0 && y < b.y0 + b.h);
    if (hit) onPick(hit.index);
  };

  return (
    <div className="bm">
      <canvas ref={ref} className="bm-canvas" style={{ width: cw, height: ch }} onClick={onClick} aria-hidden="true" data-build-map />
      <div className="bm-list" role="group" aria-label="选择拼板">
        {boards.map((b, i) => (
          <button key={b.index} type="button" className="btn btn-sm bm-btn" data-build-board-btn={i + 1} aria-current={i === current ? "true" : undefined}
            aria-label={`第 ${i + 1} 板，完成 ${progress[i].percent}%`} onClick={() => onPick(i)}>
            <b>{i + 1}</b><span className="num">{progress[i].total ? `${progress[i].percent}%` : "空"}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
