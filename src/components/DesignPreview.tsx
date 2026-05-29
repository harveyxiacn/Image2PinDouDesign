import { useEffect, useRef } from "react";
import { renderDesignToCanvas } from "../domain/rendering";
import type { BeadDesign, PaletteColor } from "../domain/types";

type DesignPreviewProps = {
  design?: BeadDesign;
  palette: PaletteColor[];
  showLabels: boolean;
  originalUrl?: string;
};

export function DesignPreview({ design, palette, showLabels, originalUrl }: DesignPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!design || !canvasRef.current) {
      return;
    }

    // 画布以高内部分辨率绘制、再由 CSS 缩放到卡片宽度（max-width:100%），
    // 因此无需横向滚动也能完整看到。色号标注仅在格数不太多时绘制，避免大板卡顿；
    // 超大板（如 156 针）请用导出 PDF 查看每格色号。
    const cellCount = design.boardWidth * design.boardHeight;
    const canLabel = showLabels && cellCount <= 12000;
    const cellSize = canLabel ? 14 : (design.boardWidth > 80 || design.boardHeight > 80 ? 10 : 13);

    renderDesignToCanvas(canvasRef.current, design, palette, {
      cellSize,
      showLabels: canLabel,
      boardLineEvery: 52
    });
  }, [design, palette, showLabels]);

  return (
    <section className="panel preview-panel" aria-labelledby="preview-title">
      <div className="section-header">
        <div>
          <p className="eyebrow">Step 03</p>
          <h2 id="preview-title">图纸预览</h2>
        </div>
        {design && (
          <span className="badge">{design.boardWidth} x {design.boardHeight}</span>
        )}
      </div>

      {design ? (
        <div className="preview-compare">
          {originalUrl && (
            <figure className="preview-original">
              <img src={originalUrl} alt={`${design.fileName} 原图`} />
              <figcaption>原图</figcaption>
            </figure>
          )}
          <figure className="canvas-shell">
            <canvas ref={canvasRef} aria-label={`${design.fileName} 拼豆图纸`} />
            <figcaption>拼豆图纸</figcaption>
          </figure>
        </div>
      ) : (
        <div className="empty-state">
          <strong>还没有图纸</strong>
          <span>上传图片后会在这里生成网格预览。</span>
        </div>
      )}
    </section>
  );
}
