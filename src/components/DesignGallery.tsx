import { useEffect, useMemo, useRef } from "react";
import type { ConversionTaskProgress } from "../domain/conversionCoordinator";
import type { BeadDesign, PaletteColor, PixelSource } from "../domain/types";
import { IconClose } from "./icons";

type DesignGalleryProps = {
  designs: BeadDesign[];
  activeId?: string;
  palette: PaletteColor[];
  draftIds: ReadonlySet<string>;
  progress: Record<string, ConversionTaskProgress>;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
};

/**
 * 图纸画廊：每张图纸一张缩略卡（色号矩阵直接绘制），显示尺寸、用豆数、草稿 / 生成中状态。
 * 首次生成中、尚无结果的图片显示占位卡；取消后占位卡随进度一起消失。
 */
export function DesignGallery({ designs, activeId, palette, draftIds, progress, onSelect, onRemove }: DesignGalleryProps) {
  const designIds = new Set(designs.map((design) => design.id));
  const pending = Object.entries(progress).filter(([id]) => !designIds.has(id));
  if (designs.length === 0 && pending.length === 0) {
    return null;
  }

  return (
    <div className="design-gallery" role="list" aria-label="图纸列表">
      {designs.map((design) => {
        const active = design.id === activeId;
        const task = progress[design.id];
        const beads = Object.values(design.colorCounts).reduce((sum, count) => sum + count, 0);
        return (
          <div key={design.id} role="listitem" className={`design-card ${active ? "active" : ""} ${task ? "is-busy" : ""}`}>
            <button
              type="button"
              className="design-card-select"
              aria-label={design.fileName}
              aria-current={active ? "true" : undefined}
              onClick={() => onSelect(design.id)}
            >
              <span className="design-card-thumb">
                <MatrixThumb design={design} palette={palette} />
                {task && <span className="design-card-spinner" aria-hidden="true" />}
              </span>
              <span className="design-card-text">
                <span className="design-card-name">{design.fileName}</span>
                <small>{design.boardWidth} × {design.boardHeight} · {beads} 颗</small>
              </span>
              {draftIds.has(design.id) && <em className="design-card-badge">草稿</em>}
            </button>
            <button
              type="button"
              className="design-card-remove"
              aria-label={`移除 ${design.fileName}`}
              onClick={() => onRemove(design.id)}
            >
              <IconClose />
            </button>
          </div>
        );
      })}
      {pending.map(([id, task]) => (
        <div key={id} role="listitem" className="design-card is-pending" aria-label={`${task.fileName} 生成中`}>
          <span className="design-card-thumb">
            <span className="bead-loader" aria-hidden="true"><i /><i /><i /><i /></span>
          </span>
          <span className="design-card-text">
            <span className="design-card-name">{task.fileName}</span>
            <small>生成中 {task.percent}%</small>
          </span>
        </div>
      ))}
    </div>
  );
}

/** 把色号矩阵按色卡颜色画成 1 格 1 像素的位图，再由 CSS 以 pixelated 方式放大。 */
export function MatrixThumb({ design, palette }: { design: BeadDesign; palette: PaletteColor[] }) {
  const pixels = useMemo(() => matrixToPixels(design, palette), [design.matrix, palette]);
  return <PixelCanvas source={pixels} className="matrix-thumb" />;
}

export function PixelCanvas({ source, className, label }: { source: PixelSource; className?: string; label?: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = source.width;
    canvas.height = source.height;
    let context: CanvasRenderingContext2D | null = null;
    try {
      context = canvas.getContext("2d");
    } catch {
      context = null;
    }
    // 测试环境或受限浏览器可能没有完整的 2D 上下文：缩略图只是装饰，静默跳过。
    if (!context || typeof context.createImageData !== "function" || typeof context.putImageData !== "function") return;
    const image = context.createImageData(source.width, source.height);
    image.data.set(source.data);
    context.putImageData(image, 0, 0);
  }, [source]);
  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ aspectRatio: `${source.width} / ${source.height}` }}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? "img" : undefined}
    />
  );
}

function matrixToPixels(design: BeadDesign, palette: PaletteColor[]): PixelSource {
  const byCode = new Map(palette.map((color) => [color.code, color.rgb]));
  const data = new Uint8ClampedArray(design.boardWidth * design.boardHeight * 4);
  for (let y = 0; y < design.boardHeight; y += 1) {
    for (let x = 0; x < design.boardWidth; x += 1) {
      const code = design.matrix[y]?.[x];
      const rgb = code ? byCode.get(code) : undefined;
      if (!rgb) continue;
      const offset = (y * design.boardWidth + x) * 4;
      data[offset] = rgb.r;
      data[offset + 1] = rgb.g;
      data[offset + 2] = rgb.b;
      data[offset + 3] = 255;
    }
  }
  return { width: design.boardWidth, height: design.boardHeight, data };
}
