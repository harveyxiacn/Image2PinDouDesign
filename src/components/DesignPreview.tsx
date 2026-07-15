import { useEffect, useRef, useState } from "react";
import { renderDesignToCanvas } from "../domain/rendering";
import type { BeadDesign, PaletteColor } from "../domain/types";

type DesignPreviewProps = {
  design?: BeadDesign;
  palette: PaletteColor[];
  showLabels: boolean;
  originalUrl?: string;
  onDownload?: () => void;
  isDownloading?: boolean;
};

type PreviewZoom = "fit" | 1 | 1.5 | 2;

const ZOOM_LEVELS: Array<Exclude<PreviewZoom, "fit">> = [1, 1.5, 2];

export function DesignPreview({
  design,
  palette,
  showLabels,
  originalUrl,
  onDownload,
  isDownloading = false
}: DesignPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const previousZoomRef = useRef<PreviewZoom>("fit");
  const [zoom, setZoom] = useState<PreviewZoom>("fit");
  const [canvasWidth, setCanvasWidth] = useState(0);

  useEffect(() => {
    setZoom("fit");
  }, [design?.id]);

  useEffect(() => {
    if (!design || !canvasRef.current) {
      return;
    }

    // 预览先适应卡片宽度；切到 100% 后保留足够的单格像素，手机可滚动逐格查看。
    // 大板按总像素预算降低单格尺寸，避免移动端 Canvas 占用过多内存。
    const cellCount = design.boardWidth * design.boardHeight;
    const cellSize = Math.max(16, Math.min(22, Math.floor(Math.sqrt(16_000_000 / cellCount))));

    renderDesignToCanvas(canvasRef.current, design, palette, {
      cellSize,
      showLabels,
      boardLineEvery: 52,
      showCoordinates: true
    });
    setCanvasWidth(canvasRef.current.width);
  }, [design, palette, showLabels]);

  useEffect(() => {
    const previousZoom = previousZoomRef.current;
    previousZoomRef.current = zoom;
    if (previousZoom !== "fit" || zoom === "fit") {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      const viewport = viewportRef.current;
      if (!viewport) {
        return;
      }
      viewport.scrollLeft = Math.max(0, (viewport.scrollWidth - viewport.clientWidth) / 2);
      viewport.scrollTop = Math.max(0, (viewport.scrollHeight - viewport.clientHeight) / 2);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [zoom]);

  const zoomIn = () => {
    setZoom((current) => {
      if (current === "fit") {
        return ZOOM_LEVELS[0];
      }
      return ZOOM_LEVELS[Math.min(ZOOM_LEVELS.indexOf(current) + 1, ZOOM_LEVELS.length - 1)];
    });
  };

  const zoomOut = () => {
    setZoom((current) => {
      if (current === "fit" || current === ZOOM_LEVELS[0]) {
        return "fit";
      }
      return ZOOM_LEVELS[Math.max(0, ZOOM_LEVELS.indexOf(current) - 1)];
    });
  };

  const zoomLabel = zoom === "fit" ? "适应屏幕" : `${Math.round(zoom * 100)}%`;
  const canvasStyle = zoom === "fit" || canvasWidth === 0
    ? undefined
    : { width: `${Math.round(canvasWidth * zoom)}px` };

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
            <div className="canvas-toolbar">
              <span>放大后可滑动查看每格色号与坐标</span>
              <div className="zoom-controls" role="group" aria-label="图纸缩放">
                <button type="button" onClick={zoomOut} disabled={zoom === "fit"} aria-label="缩小图纸">−</button>
                <button type="button" className="zoom-value" onClick={() => setZoom("fit")}>{zoomLabel}</button>
                <button type="button" onClick={zoomIn} disabled={zoom === 2} aria-label="放大图纸">＋</button>
              </div>
            </div>
            <div
              ref={viewportRef}
              className={`canvas-viewport ${zoom === "fit" ? "is-fit" : "is-zoomed"}`}
              tabIndex={0}
              aria-label="可缩放和滚动的拼豆图纸"
              onDoubleClick={() => setZoom((current) => current === "fit" ? 1 : "fit")}
            >
              <canvas
                ref={canvasRef}
                style={canvasStyle}
                aria-label={`${design.fileName} 拼豆图纸`}
              />
            </div>
            <div className="canvas-footer">
              <figcaption>拼豆图纸 · 粗线为 52 针分板边界</figcaption>
              {onDownload && (
                <button
                  id="download-pattern"
                  type="button"
                  className="button primary pattern-download"
                  onClick={onDownload}
                  disabled={isDownloading}
                >
                  {isDownloading ? "正在生成高清图…" : "下载高清色号图"}
                </button>
              )}
            </div>
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
