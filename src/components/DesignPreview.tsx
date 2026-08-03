import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import { renderDesignToCanvas } from "../domain/rendering";
import type { BeadDesign, PaletteColor } from "../domain/types";
import { designFingerprint, getColorBuildProgress } from "../domain/workbench";
import { IconCheck, IconEdit, IconPlus } from "./icons";

type DesignPreviewProps = {
  design?: BeadDesign;
  palette: PaletteColor[];
  showLabels: boolean;
  originalUrl?: string;
  onDownload?: () => void;
  isDownloading?: boolean;
  onCellChange?: (x: number, y: number, code: string | null) => void;
  onMirror?: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  onReset?: () => void;
  onSaveDraft?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  canReset?: boolean;
};

type PreviewZoom = "fit" | 1 | 1.5 | 2;
type InteractionMode = "view" | "paint" | "pick" | "erase" | "build";

const ZOOM_LEVELS: Array<Exclude<PreviewZoom, "fit">> = [1, 1.5, 2];
const PROGRESS_PREFIX = "image2pindou:build-progress:v1:";

export function DesignPreview({
  design,
  palette,
  showLabels,
  originalUrl,
  onDownload,
  isDownloading = false,
  onCellChange,
  onMirror,
  onUndo,
  onRedo,
  onReset,
  onSaveDraft,
  canUndo = false,
  canRedo = false,
  canReset = false
}: DesignPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const previousZoomRef = useRef<PreviewZoom>("fit");
  const renderCellSizeRef = useRef(22);
  const [zoom, setZoom] = useState<PreviewZoom>("fit");
  const [canvasWidth, setCanvasWidth] = useState(0);
  const [mode, setMode] = useState<InteractionMode>("view");
  const [paintCode, setPaintCode] = useState("H7");
  const [focusCode, setFocusCode] = useState("H7");
  const [completedCells, setCompletedCells] = useState<Set<number>>(() => new Set());
  const [draftSaved, setDraftSaved] = useState(false);
  // 键盘网格光标：cursorCell 是逻辑格子坐标，cursorBox 是屏幕像素框（由 effect 计算）。
  const [cursorCell, setCursorCell] = useState<{ x: number; y: number } | null>(null);
  const [cursorBox, setCursorBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const cursorRef = useRef<HTMLDivElement | null>(null);

  const byCode = useMemo(() => new Map(palette.map((color) => [color.code, color])), [palette]);
  const designCodes = useMemo(() => Object.entries(design?.colorCounts ?? {})
    .sort(([, leftCount], [, rightCount]) => rightCount - leftCount), [design?.colorCounts]);
  const progressStorageKey = useMemo(
    () => design ? `${PROGRESS_PREFIX}${designFingerprint(design)}` : "",
    [design]
  );
  const buildProgress = useMemo(
    () => design ? getColorBuildProgress(design, completedCells, focusCode) : { total: 0, completed: 0, remaining: 0 },
    [completedCells, design, focusCode]
  );

  useEffect(() => {
    setZoom("fit");
    setMode("view");
    setDraftSaved(false);
    setCursorCell(null);
    const defaultCode = designCodes[0]?.[0] ?? "H7";
    setPaintCode(defaultCode);
    setFocusCode(defaultCode);
  // 只在切换图纸时重置工具；改单格仍沿用当前画笔。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [design?.id]);

  useEffect(() => {
    setDraftSaved(false);
  }, [progressStorageKey]);

  useEffect(() => {
    if (designCodes.length === 0) {
      return;
    }
    if (!designCodes.some(([code]) => code === focusCode)) {
      setFocusCode(designCodes[0][0]);
    }
  }, [designCodes, focusCode]);

  useEffect(() => {
    if (!design || !progressStorageKey || typeof window === "undefined") {
      setCompletedCells(new Set());
      return;
    }
    try {
      const parsed = JSON.parse(window.localStorage.getItem(progressStorageKey) ?? "[]") as unknown;
      const maximum = design.boardWidth * design.boardHeight;
      const restored = Array.isArray(parsed)
        ? parsed.filter((value): value is number => Number.isInteger(value) && value >= 0 && value < maximum)
        : [];
      setCompletedCells(new Set(restored));
    } catch {
      setCompletedCells(new Set());
    }
  }, [design?.boardHeight, design?.boardWidth, progressStorageKey]);

  useEffect(() => {
    if (!design || !canvasRef.current) {
      return;
    }

    // 预览先适应卡片宽度；切到 100% 后保留足够的单格像素，手机可滚动逐格查看。
    const cellCount = design.boardWidth * design.boardHeight;
    const cellSize = Math.max(16, Math.min(22, Math.floor(Math.sqrt(16_000_000 / cellCount))));
    renderCellSizeRef.current = cellSize;

    renderDesignToCanvas(canvasRef.current, design, palette, {
      cellSize,
      showLabels,
      boardLineEvery: 52,
      showCoordinates: true,
      focusCode: mode === "build" ? focusCode : null,
      completedCells: mode === "build" ? completedCells : undefined
    });
    setCanvasWidth(canvasRef.current.width);
  }, [completedCells, design, focusCode, mode, palette, showLabels]);

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

  // 根据画布实际显示尺寸换算光标高亮框的像素位置。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !design || !cursorCell) {
      setCursorBox(null);
      return;
    }
    const cellSize = renderCellSizeRef.current;
    const gutterX = canvas.width - design.boardWidth * cellSize;
    const gutterY = canvas.height - design.boardHeight * cellSize;
    const rect = canvas.getBoundingClientRect();
    const scale = rect.width > 0 ? rect.width / canvas.width : 1;
    setCursorBox({
      left: (gutterX + cursorCell.x * cellSize) * scale,
      top: (gutterY + cursorCell.y * cellSize) * scale,
      width: cellSize * scale,
      height: cellSize * scale
    });
  }, [cursorCell, design, mode, zoom]);

  // 光标高亮框渲染完成后，把它滚动进可视区（方向键移动、聚焦、Tab 切回时都会触发）。
  useEffect(() => {
    if (!cursorBox) {
      return;
    }
    cursorRef.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [cursorBox]);

  const persistCompleted = (next: Set<number>) => {
    setCompletedCells(next);
    if (!progressStorageKey || typeof window === "undefined") {
      return;
    }
    try {
      window.localStorage.setItem(progressStorageKey, JSON.stringify(Array.from(next)));
    } catch {
      // 隐私模式或配额不足时仍保留当前会话进度。
    }
  };

  const toggleCompletedCell = (cellIndex: number) => {
    const next = new Set(completedCells);
    if (next.has(cellIndex)) {
      next.delete(cellIndex);
    } else {
      next.add(cellIndex);
    }
    persistCompleted(next);
  };

  const markFocusedColorComplete = () => {
    if (!design) return;
    const next = new Set(completedCells);
    for (let y = 0; y < design.boardHeight; y += 1) {
      for (let x = 0; x < design.boardWidth; x += 1) {
        if (design.matrix[y]?.[x] === focusCode) {
          next.add(y * design.boardWidth + x);
        }
      }
    }
    persistCompleted(next);
  };

  const clearBuildProgress = () => persistCompleted(new Set());

  // 鼠标点击与键盘 Enter/空格共用同一套格子动作，保证两种输入方式行为一致。
  const applyCellAction = (x: number, y: number) => {
    if (!design || mode === "view") {
      return;
    }
    const currentCode = design.matrix[y]?.[x] ?? null;
    if (mode === "pick") {
      if (currentCode) {
        setPaintCode(currentCode);
        setMode("paint");
      }
      return;
    }
    if (mode === "build") {
      if (currentCode === focusCode) {
        toggleCompletedCell(y * design.boardWidth + x);
      }
      return;
    }
    if (mode === "paint") {
      onCellChange?.(x, y, paintCode);
    } else if (mode === "erase") {
      onCellChange?.(x, y, null);
    }
  };

  const handleCanvasClick = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    if (!design || mode === "view") {
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;
    const bounds = canvas.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;

    const cellSize = renderCellSizeRef.current;
    const gutterX = canvas.width - design.boardWidth * cellSize;
    const gutterY = canvas.height - design.boardHeight * cellSize;
    const intrinsicX = (event.clientX - bounds.left) * canvas.width / bounds.width;
    const intrinsicY = (event.clientY - bounds.top) * canvas.height / bounds.height;
    const x = Math.floor((intrinsicX - gutterX) / cellSize);
    const y = Math.floor((intrinsicY - gutterY) / cellSize);
    if (x < 0 || y < 0 || x >= design.boardWidth || y >= design.boardHeight) return;

    // 点击时同步光标位置，键盘用户与鼠标用户看到同一格。
    setCursorCell({ x, y });
    applyCellAction(x, y);
  };

  // 键盘网格操作：方向键移动光标，Enter/空格按当前模式动作，Delete/Backspace 擦除。
  const handleGridKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!design) {
      return;
    }
    const width = design.boardWidth;
    const height = design.boardHeight;
    const current = cursorCell ?? { x: 0, y: 0 };

    let target: { x: number; y: number } | null = null;
    if (event.key === "ArrowUp") {
      target = { x: current.x, y: Math.max(0, current.y - 1) };
    } else if (event.key === "ArrowDown") {
      target = { x: current.x, y: Math.min(height - 1, current.y + 1) };
    } else if (event.key === "ArrowLeft") {
      target = { x: Math.max(0, current.x - 1), y: current.y };
    } else if (event.key === "ArrowRight") {
      target = { x: Math.min(width - 1, current.x + 1), y: current.y };
    }
    if (target) {
      event.preventDefault();
      setCursorCell(target);
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      if (mode === "view") {
        return;
      }
      event.preventDefault();
      applyCellAction(current.x, current.y);
      return;
    }

    if (event.key === "Delete" || event.key === "Backspace") {
      if (mode !== "paint" && mode !== "erase") {
        return;
      }
      event.preventDefault();
      onCellChange?.(current.x, current.y, null);
    }
  };

  const zoomIn = () => {
    setZoom((current) => current === "fit"
      ? ZOOM_LEVELS[0]
      : ZOOM_LEVELS[Math.min(ZOOM_LEVELS.indexOf(current) + 1, ZOOM_LEVELS.length - 1)]);
  };
  const zoomOut = () => {
    setZoom((current) => current === "fit" || current === ZOOM_LEVELS[0]
      ? "fit"
      : ZOOM_LEVELS[Math.max(0, ZOOM_LEVELS.indexOf(current) - 1)]);
  };

  const selectMode = (nextMode: InteractionMode) => {
    setMode(nextMode);
    if (nextMode !== "view" && zoom === "fit") {
      setZoom(1);
    }
    if (nextMode !== "view") {
      window.requestAnimationFrame(() => viewportRef.current?.focus());
    }
  };

  const zoomLabel = zoom === "fit" ? "适应屏幕" : `${Math.round(zoom * 100)}%`;
  const stageStyle = zoom === "fit" || canvasWidth === 0
    ? undefined
    : { width: `${Math.round(canvasWidth * zoom)}px` };
  const paintColor = byCode.get(paintCode);

  return (
    <section className="panel preview-panel" aria-labelledby="preview-title">
      <div className="section-header">
        <div>
          <p className="eyebrow">Step 03</p>
          <h2 id="preview-title">图纸预览与编辑</h2>
        </div>
        {design && <span className="badge">{design.boardWidth} x {design.boardHeight}</span>}
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
            {onCellChange && (
              <div id="pattern-editor" className="pattern-workbench" aria-label="图纸编辑与制作工具">
                <div className="workbench-heading">
                  <div>
                    <strong>编辑图纸</strong>
                    <small>选择工具后直接点击图纸格子，修改会立即反映到下载文件。</small>
                  </div>
                  {mode === "view" ? (
                    <button type="button" className="button primary" aria-pressed={false} onClick={() => selectMode("paint")}><IconEdit />开始编辑图纸</button>
                  ) : (
                    <button type="button" className="button secondary" aria-pressed={true} onClick={() => selectMode("view")}><IconCheck />完成编辑</button>
                  )}
                </div>
                <div className="workbench-modes" role="group" aria-label="图纸操作模式">
                  {([
                    ["view", "查看成品"],
                    ["paint", "逐格改色"],
                    ["pick", "取色"],
                    ["erase", "擦除"],
                    ["build", "制作打卡"]
                  ] as Array<[InteractionMode, string]>).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      className={mode === value ? "active" : ""}
                      aria-pressed={mode === value}
                      onClick={() => selectMode(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                <div className="workbench-actions">
                  <button type="button" className="button small" onClick={onUndo} disabled={!canUndo}>撤销</button>
                  <button type="button" className="button small" onClick={onRedo} disabled={!canRedo}>重做</button>
                  <button type="button" className="button small" onClick={onMirror}>水平镜像</button>
                  <button type="button" className="button small" onClick={onReset} disabled={!canReset}>恢复生成结果</button>
                  <button
                    type="button"
                    className="button small"
                    onClick={() => { onSaveDraft?.(); setDraftSaved(true); }}
                  >
                    {draftSaved ? "已保存到本机 ✓" : "保存本机草稿"}
                  </button>
                </div>

                {(mode === "paint" || mode === "pick") && (
                  <div className="workbench-detail">
                    <span className="workbench-swatch" style={{ backgroundColor: paintColor?.hex ?? "#000" }} />
                    <label>
                      <span>{mode === "pick" ? "当前取色" : "绘制色号"}</span>
                      <select aria-label="绘制色号" value={paintCode} onChange={(event) => setPaintCode(event.target.value)}>
                        {palette.map((color) => (
                          <option key={color.code} value={color.code}>{color.code} · {color.nameZh}</option>
                        ))}
                      </select>
                    </label>
                    <small>{mode === "pick" ? "点图纸中的颜色后自动切回逐格改色。" : "点一个格子即可替换；每步都能撤销。"}</small>
                  </div>
                )}

                {mode === "erase" && <p className="workbench-hint">点一个格子清成空格；可随时撤销。</p>}

                {mode === "build" && (
                  <div className="build-assistant">
                    <label>
                      <span>当前制作色号</span>
                      <select aria-label="制作聚焦色号" value={focusCode} onChange={(event) => setFocusCode(event.target.value)}>
                        {designCodes.map(([code, count]) => (
                          <option key={code} value={code}>{code} · {byCode.get(code)?.nameZh ?? code} · {count} 颗</option>
                        ))}
                      </select>
                    </label>
                    <div className="build-progress-copy">
                      <strong>{focusCode} 剩余 {buildProgress.remaining} 颗</strong>
                      <span>{buildProgress.completed} / {buildProgress.total}</span>
                    </div>
                    <progress value={buildProgress.completed} max={Math.max(1, buildProgress.total)} aria-label={`${focusCode} 制作进度`} />
                    <div className="workbench-actions">
                      <button type="button" className="button small" onClick={markFocusedColorComplete}>此色全部完成</button>
                      <button type="button" className="button small" onClick={clearBuildProgress} disabled={completedCells.size === 0}>清空全部进度</button>
                    </div>
                    <small>非当前色会淡化；点当前色格子打勾。进度自动保存在本机。</small>
                  </div>
                )}
              </div>
            )}

            <div className="canvas-toolbar">
              <span>{mode === "view"
                ? "放大后可滑动查看每格色号与坐标；聚焦图纸后可用方向键逐格查看"
                : "点格子或按方向键移动光标，Enter/空格上色，Delete 擦除"}</span>
              <div className="zoom-controls" role="group" aria-label="图纸缩放">
                <button type="button" onClick={zoomOut} disabled={zoom === "fit"} aria-label="缩小图纸">−</button>
                <button type="button" className="zoom-value" onClick={() => setZoom("fit")}>{zoomLabel}</button>
                <button type="button" onClick={zoomIn} disabled={zoom === 2} aria-label="放大图纸"><IconPlus /></button>
              </div>
            </div>
            <div
              ref={viewportRef}
              className={`canvas-viewport ${zoom === "fit" ? "is-fit" : "is-zoomed"} ${mode !== "view" ? "is-interactive" : ""}`}
              tabIndex={0}
              role="grid"
              aria-rowcount={design.boardHeight}
              aria-colcount={design.boardWidth}
              aria-label="拼豆图纸网格：可用方向键移动光标，Enter 或空格上色，Delete 擦除"
              onFocus={() => {
                if (!cursorCell) {
                  setCursorCell({ x: 0, y: 0 });
                } else {
                  // Tab 切走再切回时已有关键格：确保光标框仍然可见。
                  cursorRef.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
                }
              }}
              onKeyDown={handleGridKeyDown}
              onDoubleClick={() => { if (mode === "view") setZoom((current) => current === "fit" ? 1 : "fit"); }}
            >
              <div className={`canvas-stage ${zoom === "fit" ? "is-fit" : "is-zoomed"}`} style={stageStyle}>
                <canvas
                  ref={canvasRef}
                  aria-label={`${design.fileName} 拼豆图纸`}
                  onClick={handleCanvasClick}
                />
                {cursorBox && (
                  <div ref={cursorRef} className="grid-cursor" style={cursorBox} aria-hidden="true" />
                )}
              </div>
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
          <span>上传图片后会自动生成，并显示“编辑图纸”入口。</span>
        </div>
      )}
    </section>
  );
}



