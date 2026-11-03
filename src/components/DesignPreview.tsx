import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { renderDesignToCanvas } from "../domain/rendering";
import type { BeadDesign, PaletteColor } from "../domain/types";
import { BEAD_PITCH_MM, physicalSizeCm } from "../domain/boards";
import {
  boardTiles,
  cellsWithCode,
  copyRect,
  designFingerprint,
  fillRectPatch,
  floodFillRegion,
  getColorBuildProgress,
  mirrorX,
  normalizeRect,
  pastePatch,
  type CellPatch,
  type CellRect
} from "../domain/workbench";
import { BeadPreviewCanvas } from "./BeadPreviewCanvas";
import { PixelCanvas } from "./DesignGallery";
import { IconCheck, IconDownload, IconEdit, IconMinus, IconPlus } from "./icons";
import { Segmented } from "./Segmented";

type DesignPreviewProps = {
  design?: BeadDesign;
  palette: PaletteColor[];
  showLabels: boolean;
  originalUrl?: string;
  onDownload?: () => void;
  isDownloading?: boolean;
  onCellChange?: (x: number, y: number, code: string | null) => void;
  // 画笔 / 橡皮拖动一笔改多格：整笔作为一步撤销。未提供时退回逐格 onCellChange。
  onCellsChange?: (cells: Array<{ x: number; y: number }>, code: string | null) => void;
  // 每格颜色不同的一次性修改（粘贴、剪切）：整次作为一步撤销。
  onPatch?: (changes: CellPatch[]) => void;
  onMirror?: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  onReset?: () => void;
  onSaveDraft?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  canReset?: boolean;
  onExportPdf?: () => void;
  // 标题栏右侧的图纸级操作（裁剪 / 复制为另一尺寸），由 App 注入。
  headerActions?: ReactNode;
};

type PreviewZoom = "fit" | 1 | 1.5 | 2;
type StageView = "pattern" | "pixelated" | "original" | "beads";
type InteractionMode = "view" | "paint" | "fill" | "pick" | "erase" | "select" | "build";
type Box = { left: number; top: number; width: number; height: number };

const MODE_SHORTCUTS: Record<string, InteractionMode> = { v: "view", b: "paint", g: "fill", i: "pick", e: "erase", m: "select" };

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
  canReset = false,
  onExportPdf,
  headerActions,
  onCellsChange,
  onPatch
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
  const stageRef = useRef<HTMLDivElement | null>(null);
  // 舞台视图：图纸（可编辑）/ 像素化 / 原图，同尺寸切换便于逐处对比。
  const [stageView, setStageView] = useState<StageView>("pattern");
  const [brushSize, setBrushSize] = useState<1 | 2 | 3>(1);
  // 左右对称：画笔 / 橡皮同时作用于关于中线对称的格子。
  const [symmetric, setSymmetric] = useState(false);
  // 框选：选区（格子坐标）、剪贴板、是否等待点击放置粘贴。
  const [selection, setSelection] = useState<CellRect | null>(null);
  const [selectionBox, setSelectionBox] = useState<Box | null>(null);
  const [clipboard, setClipboard] = useState<Array<Array<string | null>> | null>(null);
  const [pasteArmed, setPasteArmed] = useState(false);
  const [replaceFrom, setReplaceFrom] = useState("");
  const [beadLook, setBeadLook] = useState<"loose" | "fused">("fused");
  // 按板制作：-1 表示整张图，其余为板序号（行优先）。
  const [buildTile, setBuildTile] = useState(-1);
  // 进行中的一笔：记录经过的格子，抬笔时一次提交；点击事件紧跟在抬笔后，需要忽略一次。
  // kind=build 时为拖动打勾（mark=true 打勾 / false 取消）。
  const strokeRef = useRef<{
    kind: "paint" | "build" | "select";
    code: string | null;
    mark?: boolean;
    anchor?: { x: number; y: number };
    cells: Map<number, { x: number; y: number }>;
    last: { x: number; y: number };
  } | null>(null);
  const suppressClickRef = useRef(false);

  const byCode = useMemo(() => new Map(palette.map((color) => [color.code, color])), [palette]);
  const designCodes = useMemo(() => Object.entries(design?.colorCounts ?? {})
    .sort(([, leftCount], [, rightCount]) => rightCount - leftCount), [design?.colorCounts]);
  const progressStorageKey = useMemo(
    () => design ? `${PROGRESS_PREFIX}${designFingerprint(design)}` : "",
    [design]
  );
  const totalBeads = useMemo(
    () => designCodes.reduce((sum, [, count]) => sum + count, 0),
    [designCodes]
  );
  const tilePins = design?.settings?.boardTilePins ?? 52;
  const tiles = useMemo(() => design ? boardTiles(design, tilePins) : [], [design?.boardWidth, design?.boardHeight, tilePins]);
  const activeTile = buildTile >= 0 ? tiles[buildTile] ?? null : null;
  const buildProgress = useMemo(
    () => design ? getColorBuildProgress(design, completedCells, focusCode, activeTile) : { total: 0, completed: 0, remaining: 0 },
    [activeTile, completedCells, design, focusCode]
  );
  const regionProgress = useMemo(
    () => design ? getColorBuildProgress(design, completedCells, null, activeTile) : { total: 0, completed: 0, remaining: 0 },
    [activeTile, completedCells, design]
  );
  const focusInRegion = useMemo(() => {
    if (!design || !activeTile) return designCodes;
    const counts = new Map<string, number>();
    for (let y = activeTile.y; y < activeTile.y + activeTile.height; y += 1) {
      for (let x = activeTile.x; x < activeTile.x + activeTile.width; x += 1) {
        const code = design.matrix[y]?.[x];
        if (code) counts.set(code, (counts.get(code) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort(([, a], [, b]) => b - a);
  }, [activeTile, design, designCodes]);

  useEffect(() => {
    setZoom("fit");
    setMode("view");
    setDraftSaved(false);
    setCursorCell(null);
    setSelection(null);
    setPasteArmed(false);
    setBuildTile(-1);
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
      boardLineEvery: design.settings?.boardTilePins ?? 52,
      guideLineEvery: 5,
      showCoordinates: true,
      focusCode: mode === "build" ? focusCode : null,
      completedCells: mode === "build" ? completedCells : undefined,
      region: mode === "build" ? activeTile : null
    });
    setCanvasWidth(canvasRef.current.width);
  }, [activeTile, completedCells, design, focusCode, mode, palette, showLabels]);

  // 新生成结果（新图纸或重新转换，pixelated 引用会变化）到达时做一次逐行“铺豆”揭示；
  // 单格编辑沿用同一引用，不会反复播放。动画只用 clip-path，结束与否不影响任何状态。
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !design) return;
    stage.classList.remove("is-revealing");
    void stage.offsetWidth;
    stage.classList.add("is-revealing");
    const timer = window.setTimeout(() => stage.classList.remove("is-revealing"), 900);
    return () => window.clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [design?.id, design?.pixelated]);

  useEffect(() => {
    setStageView("pattern");
  }, [design?.id]);

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

  // 格子矩形 → 画布上的显示像素框（随缩放变化）。
  const cellRectToBox = (rect: CellRect): Box | null => {
    const canvas = canvasRef.current;
    if (!canvas || !design) return null;
    const cellSize = renderCellSizeRef.current;
    const gutterX = canvas.width - design.boardWidth * cellSize;
    const gutterY = canvas.height - design.boardHeight * cellSize;
    const bounds = canvas.getBoundingClientRect();
    const scale = bounds.width > 0 ? bounds.width / canvas.width : 1;
    return {
      left: (gutterX + rect.x * cellSize) * scale,
      top: (gutterY + rect.y * cellSize) * scale,
      width: rect.width * cellSize * scale,
      height: rect.height * cellSize * scale
    };
  };

  // 根据画布实际显示尺寸换算光标高亮框的像素位置。
  useEffect(() => {
    setCursorBox(cursorCell && design ? cellRectToBox({ ...cursorCell, width: 1, height: 1 }) : null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursorCell, design, mode, zoom, canvasWidth]);

  useEffect(() => {
    setSelectionBox(selection && mode === "select" && selection.width > 0 ? cellRectToBox(selection) : null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, design, mode, zoom, canvasWidth]);

  // 按板制作切换板子时，把该板滚进视野。
  useEffect(() => {
    if (!activeTile || zoom === "fit") return;
    const frame = window.requestAnimationFrame(() => {
      const viewport = viewportRef.current;
      const box = cellRectToBox(activeTile);
      if (!viewport || !box) return;
      viewport.scrollLeft = Math.max(0, box.left - 12);
      viewport.scrollTop = Math.max(0, box.top - 12);
    });
    return () => window.cancelAnimationFrame(frame);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTile, zoom]);

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

  const isFocusCell = (x: number, y: number) => {
    if (!design || design.matrix[y]?.[x] !== focusCode) return false;
    return !activeTile || (x >= activeTile.x && y >= activeTile.y && x < activeTile.x + activeTile.width && y < activeTile.y + activeTile.height);
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
        if (isFocusCell(x, y)) {
          next.add(y * design.boardWidth + x);
        }
      }
    }
    persistCompleted(next);
  };

  const commitPatch = (changes: CellPatch[]) => {
    if (changes.length === 0) return;
    if (onPatch) {
      onPatch(changes);
    } else {
      for (const change of changes) onCellChange?.(change.x, change.y, change.code);
    }
  };

  const copySelection = (cut: boolean) => {
    if (!design || !selection || selection.width === 0) return;
    setClipboard(copyRect(design, selection));
    if (cut) commitPatch(fillRectPatch(selection, null));
  };

  const pasteAt = (x: number, y: number) => {
    if (!clipboard) return;
    commitPatch(pastePatch(clipboard, x, y));
    setPasteArmed(false);
    setSelection({ x, y, width: Math.min(clipboard[0]?.length ?? 0, (design?.boardWidth ?? 0) - x), height: Math.min(clipboard.length, (design?.boardHeight ?? 0) - y) });
  };

  const replaceAll = () => {
    if (!design || !replaceFrom || replaceFrom === paintCode) return;
    const cells = cellsWithCode(design, replaceFrom);
    if (onCellsChange) onCellsChange(cells, paintCode);
    else commitPatch(cells.map(({ x, y }) => ({ x, y, code: paintCode })));
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
      if (isFocusCell(x, y)) {
        toggleCompletedCell(y * design.boardWidth + x);
      }
      return;
    }
    if (mode === "fill") {
      const cells = floodFillRegion(design, x, y);
      if (onCellsChange) onCellsChange(cells, paintCode);
      else commitPatch(cells.map((cell) => ({ ...cell, code: paintCode })));
      return;
    }
    if (mode === "select") {
      if (pasteArmed) pasteAt(x, y);
      else setSelection({ x, y, width: 1, height: 1 });
      return;
    }
    const code = mode === "paint" ? paintCode : null;
    if (mode === "paint" || mode === "erase") {
      const mirrored = mirrorX(x, design.boardWidth);
      if (symmetric && mirrored !== x && onCellsChange) {
        onCellsChange([{ x, y }, { x: mirrored, y }], code);
      } else {
        onCellChange?.(x, y, code);
      }
    }
  };

  const cellFromPoint = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const canvas = canvasRef.current;
    if (!canvas || !design) return null;
    const bounds = canvas.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return null;
    const cellSize = renderCellSizeRef.current;
    const gutterX = canvas.width - design.boardWidth * cellSize;
    const gutterY = canvas.height - design.boardHeight * cellSize;
    const x = Math.floor(((clientX - bounds.left) * canvas.width / bounds.width - gutterX) / cellSize);
    const y = Math.floor(((clientY - bounds.top) * canvas.height / bounds.height - gutterY) / cellSize);
    return x < 0 || y < 0 || x >= design.boardWidth || y >= design.boardHeight ? null : { x, y };
  };

  // 把一格（按笔刷大小展开成方块）加入当前笔画，并直接在画布上预览，抬笔后再整体重绘。
  const addStrokeCell = (cell: { x: number; y: number }) => {
    const stroke = strokeRef.current;
    const canvas = canvasRef.current;
    if (!stroke || !design || !canvas) return;
    if (stroke.kind === "select") {
      if (stroke.anchor) setSelection(normalizeRect(stroke.anchor, cell, design));
      return;
    }
    const context = canvas.getContext("2d");
    const cellSize = renderCellSizeRef.current;
    const gutterX = canvas.width - design.boardWidth * cellSize;
    const gutterY = canvas.height - design.boardHeight * cellSize;
    const paintCell = (x: number, y: number) => {
      if (x < 0 || y < 0 || x >= design.boardWidth || y >= design.boardHeight) return;
      const key = y * design.boardWidth + x;
      if (stroke.cells.has(key)) return;
      if (stroke.kind === "build") {
        // 拖动打勾只作用于当前制作色（及当前板）。
        if (!isFocusCell(x, y)) return;
        stroke.cells.set(key, { x, y });
        if (context) {
          context.fillStyle = stroke.mark ? "rgba(22, 101, 52, 0.45)" : "rgba(255, 255, 255, 0.6)";
          context.fillRect(gutterX + x * cellSize + 1, gutterY + y * cellSize + 1, cellSize - 2, cellSize - 2);
        }
        return;
      }
      stroke.cells.set(key, { x, y });
      if (context) {
        context.fillStyle = stroke.code ? byCode.get(stroke.code)?.hex ?? "#000" : "#f8fafc";
        context.fillRect(gutterX + x * cellSize + 1, gutterY + y * cellSize + 1, cellSize - 2, cellSize - 2);
      }
    };
    const size = stroke.kind === "build" ? 1 : brushSize;
    const offset = Math.floor((size - 1) / 2);
    for (let dy = 0; dy < size; dy += 1) {
      for (let dx = 0; dx < size; dx += 1) {
        const x = cell.x - offset + dx;
        const y = cell.y - offset + dy;
        paintCell(x, y);
        if (symmetric && stroke.kind === "paint") paintCell(mirrorX(x, design.boardWidth), y);
      }
    }
  };

  // 两次 pointermove 之间可能跨过多格：按直线补齐，快速拖动也不会断笔。
  const addStrokeLine = (from: { x: number; y: number }, to: { x: number; y: number }) => {
    const steps = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y));
    for (let step = 1; step <= steps; step += 1) {
      addStrokeCell({
        x: Math.round(from.x + ((to.x - from.x) * step) / steps),
        y: Math.round(from.y + ((to.y - from.y) * step) / steps)
      });
    }
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const draggable = mode === "paint" || mode === "erase" || mode === "build" || (mode === "select" && !pasteArmed);
    if (!design || !draggable || event.button !== 0) return;
    const cell = cellFromPoint(event.clientX, event.clientY);
    if (!cell) return;
    if (mode === "build" && !isFocusCell(cell.x, cell.y)) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    strokeRef.current = mode === "build"
      ? { kind: "build", code: null, mark: !completedCells.has(cell.y * design.boardWidth + cell.x), cells: new Map(), last: cell }
      : mode === "select"
        ? { kind: "select", code: null, anchor: cell, cells: new Map(), last: cell }
        : { kind: "paint", code: mode === "paint" ? paintCode : null, cells: new Map(), last: cell };
    setCursorCell(cell);
    addStrokeCell(cell);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const stroke = strokeRef.current;
    if (!stroke) return;
    const cell = cellFromPoint(event.clientX, event.clientY);
    if (!cell || (cell.x === stroke.last.x && cell.y === stroke.last.y)) return;
    addStrokeLine(stroke.last, cell);
    stroke.last = cell;
  };

  const finishStroke = () => {
    const stroke = strokeRef.current;
    strokeRef.current = null;
    if (!stroke) return;
    if (stroke.kind === "select") {
      suppressClickRef.current = true;
      window.setTimeout(() => { suppressClickRef.current = false; }, 0);
      return;
    }
    if (stroke.cells.size === 0 || !design) return;
    suppressClickRef.current = true;
    window.setTimeout(() => { suppressClickRef.current = false; }, 0);
    if (stroke.kind === "build") {
      const next = new Set(completedCells);
      for (const key of stroke.cells.keys()) {
        if (stroke.mark) next.add(key);
        else next.delete(key);
      }
      persistCompleted(next);
      return;
    }
    const cells = [...stroke.cells.values()];
    if (onCellsChange) {
      onCellsChange(cells, stroke.code);
    } else {
      for (const { x, y } of cells) onCellChange?.(x, y, stroke.code);
    }
  };

  const handleCanvasClick = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    if (!design || mode === "view") {
      return;
    }
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
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
    // 单键切换工具（聚焦图纸时）：V 查看、B 画笔、G 油漆桶、I 取色、E 擦除、M 框选。
    const shortcut = !event.ctrlKey && !event.metaKey && !event.altKey && onCellChange
      ? MODE_SHORTCUTS[event.key.toLowerCase()]
      : undefined;
    if (shortcut) {
      event.preventDefault();
      selectMode(shortcut);
      return;
    }
    if (mode === "select" && (event.ctrlKey || event.metaKey)) {
      const key = event.key.toLowerCase();
      if (key === "c" || key === "x") {
        event.preventDefault();
        copySelection(key === "x");
        return;
      }
      if (key === "v" && clipboard) {
        event.preventDefault();
        const at = cursorCell ?? { x: 0, y: 0 };
        pasteAt(at.x, at.y);
        return;
      }
    }
    if (event.key === "Escape" && (selection || pasteArmed)) {
      event.preventDefault();
      setSelection(null);
      setPasteArmed(false);
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
      if (mode === "select" && selection) {
        event.preventDefault();
        commitPatch(fillRectPatch(selection, null));
        return;
      }
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
    if (nextMode !== "select") {
      setSelection(null);
      setPasteArmed(false);
    }
    setStageView("pattern");
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
  const sizeMini = design ? physicalSizeCm(design.boardWidth, design.boardHeight, BEAD_PITCH_MM.mini) : null;
  const sizeStandard = design ? physicalSizeCm(design.boardWidth, design.boardHeight, BEAD_PITCH_MM.standard) : null;

  return (
    <section className="panel preview-panel" aria-labelledby="preview-title">
      <div className="stage-header">
        <div className="stage-title">
          <h2 id="preview-title">图纸预览与编辑</h2>
          {design && <span className="stage-file" title={design.fileName}>{design.fileName}</span>}
        </div>
        {design && <span className="badge">{design.boardWidth} x {design.boardHeight}</span>}
        {design && headerActions && <div className="stage-actions">{headerActions}</div>}
      </div>

      {design && (
        <ol className="pipeline-strip" aria-label="生成步骤">
          <li><span>原图</span><small>{originalUrl ? "已裁剪主体" : "本机草稿"}</small></li>
          <li><span>像素化</span><small>{design.boardWidth} × {design.boardHeight} 格</small></li>
          <li><span>匹配色号</span><small>{designCodes.length} 种 MARD 色</small></li>
          <li><span>用豆</span><small>{totalBeads} 颗</small></li>
        </ol>
      )}

      {design ? (
        <div className="preview-stage">
          <figure className="canvas-shell">
            {onCellChange && (
              <div id="pattern-editor" className="pattern-workbench" aria-label="图纸编辑与制作工具">
                <div className="workbench-heading">
                  <div>
                    <strong>编辑图纸</strong>
                    <small>{mode === "view" ? "选择工具后点格子修改，每一步都能撤销。" : "修改会直接进入下载和打印文件；Ctrl+Z 撤销。"}</small>
                  </div>
                  <div className="workbench-heading-actions">
                    <button
                      type="button"
                      className="button small workbench-save"
                      onClick={() => { onSaveDraft?.(); setDraftSaved(true); }}
                    >
                      {draftSaved ? "已保存到本机 ✓" : "保存本机草稿"}
                    </button>
                    {mode === "view" ? (
                      <button type="button" className="button primary" aria-pressed={false} onClick={() => selectMode("paint")}><IconEdit />开始编辑图纸</button>
                    ) : (
                      <button type="button" className="button secondary" aria-pressed={true} onClick={() => selectMode("view")}><IconCheck />完成编辑</button>
                    )}
                  </div>
                </div>
                <div className="workbench-modes" role="group" aria-label="图纸操作模式">
                  {([
                    ["view", "查看成品"],
                    ["paint", "画笔"],
                    ["fill", "油漆桶"],
                    ["pick", "取色"],
                    ["erase", "擦除"],
                    ["select", "框选"],
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

                {/* 撤销/重做/镜像/恢复只在编辑时出现，查看时让图纸尽量靠上。 */}
                {mode !== "view" && (
                  <div className="workbench-actions">
                    <button type="button" className="button small" onClick={onUndo} disabled={!canUndo}>撤销</button>
                    <button type="button" className="button small" onClick={onRedo} disabled={!canRedo}>重做</button>
                    <button type="button" className="button small" onClick={onMirror}>水平镜像</button>
                    <button type="button" className="button small" onClick={onReset} disabled={!canReset}>恢复生成结果</button>
                  </div>
                )}

                {(mode === "paint" || mode === "pick" || mode === "fill") && (
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
                    <small>{mode === "pick"
                      ? "点图纸中的颜色后自动切回画笔。"
                      : mode === "fill"
                        ? "点一格，把与它相连的同色区域整片换成当前色；一次算一步撤销。"
                        : "点格子替换，按住拖动可连续涂色；一笔算一步撤销。"}</small>
                  </div>
                )}

                {mode === "paint" && designCodes.length > 0 && (
                  <div className="replace-all">
                    <label>
                      <span>整图换色</span>
                      <select aria-label="要替换的色号" value={replaceFrom} onChange={(event) => setReplaceFrom(event.target.value)}>
                        <option value="">选择要换掉的颜色…</option>
                        {designCodes.map(([code, count]) => (
                          <option key={code} value={code}>{code} · {byCode.get(code)?.nameZh ?? code} · {count} 颗</option>
                        ))}
                      </select>
                    </label>
                    <button type="button" className="button small" onClick={replaceAll} disabled={!replaceFrom || replaceFrom === paintCode}>
                      全部换成 {paintCode}
                    </button>
                  </div>
                )}

                {mode === "erase" && <p className="workbench-hint">点格子清成空格，按住拖动可连续擦除；一笔算一步撤销。</p>}

                {(mode === "paint" || mode === "erase") && (
                  <div className="brush-size">
                    <span>笔刷大小</span>
                    <Segmented
                      label="笔刷大小"
                      size="compact"
                      value={brushSize}
                      options={[
                        { value: 1 as const, label: "1 格" },
                        { value: 2 as const, label: "2 × 2" },
                        { value: 3 as const, label: "3 × 3" }
                      ]}
                      onChange={setBrushSize}
                    />
                    <label className="toggle compact">
                      <input type="checkbox" checked={symmetric} onChange={(event) => setSymmetric(event.target.checked)} />
                      <span>左右对称</span>
                    </label>
                  </div>
                )}

                {mode === "select" && (
                  <div className="selection-tools">
                    <small className="workbench-hint">
                      {pasteArmed
                        ? "点一格作为粘贴位置（左上角）；空格不会覆盖原有颜色。Esc 取消。"
                        : selection
                          ? `已选 ${selection.width} × ${selection.height} 格。Ctrl+C 复制、Ctrl+X 剪切、Delete 清空。`
                          : "按住拖动框出一块区域，可复制、剪切后粘贴到别处（即移动），或整块填色 / 清空。"}
                    </small>
                    <div className="workbench-actions">
                      <button type="button" className="button small" onClick={() => copySelection(false)} disabled={!selection}>复制</button>
                      <button type="button" className="button small" onClick={() => copySelection(true)} disabled={!selection}>剪切</button>
                      <button type="button" className="button small" aria-pressed={pasteArmed} onClick={() => setPasteArmed((armed) => !armed)} disabled={!clipboard}>
                        {pasteArmed ? "取消粘贴" : "粘贴"}
                      </button>
                      <button type="button" className="button small" onClick={() => selection && commitPatch(fillRectPatch(selection, paintCode))} disabled={!selection}>
                        填充 {paintCode}
                      </button>
                      <button type="button" className="button small" onClick={() => selection && commitPatch(fillRectPatch(selection, null))} disabled={!selection}>清空</button>
                    </div>
                  </div>
                )}

                {mode === "build" && (
                  <div className="build-assistant">
                    {tiles.length > 1 && (
                      <div className="build-board-nav">
                        <label>
                          <span>按板制作</span>
                          <select aria-label="当前制作的板" value={buildTile} onChange={(event) => setBuildTile(Number(event.target.value))}>
                            <option value={-1}>整张图（{tiles.length} 块 {tilePins} 针板）</option>
                            {tiles.map((tile) => (
                              <option key={tile.index} value={tile.index}>第 {tile.row + 1} 行第 {tile.col + 1} 块 · X {tile.x + 1}–{tile.x + tile.width} · Y {tile.y + 1}–{tile.y + tile.height}</option>
                            ))}
                          </select>
                        </label>
                        <div className="workbench-actions">
                          <button type="button" className="button small" onClick={() => setBuildTile((index) => Math.max(0, index - 1))} disabled={buildTile <= 0}>上一块</button>
                          <button type="button" className="button small" onClick={() => setBuildTile((index) => Math.min(tiles.length - 1, index + 1))} disabled={buildTile >= tiles.length - 1}>下一块</button>
                        </div>
                      </div>
                    )}
                    <label>
                      <span>当前制作色号</span>
                      <select aria-label="制作聚焦色号" value={focusCode} onChange={(event) => setFocusCode(event.target.value)}>
                        {focusInRegion.map(([code, count]) => (
                          <option key={code} value={code}>{code} · {byCode.get(code)?.nameZh ?? code} · {count} 颗</option>
                        ))}
                        {activeTile && !focusInRegion.some(([code]) => code === focusCode) && (
                          <option value={focusCode}>{focusCode} · 本板没有</option>
                        )}
                      </select>
                    </label>
                    <div className="build-progress-copy">
                      <strong>{focusCode} {activeTile ? "本板" : ""}剩余 {buildProgress.remaining} 颗</strong>
                      <span>{buildProgress.completed} / {buildProgress.total}</span>
                    </div>
                    <progress value={buildProgress.completed} max={Math.max(1, buildProgress.total)} aria-label={`${focusCode} 制作进度`} />
                    <small className="build-overall">
                      {activeTile ? "本板" : "整张图"}全部颜色已完成 {regionProgress.completed} / {regionProgress.total} 颗
                      {regionProgress.total > 0 ? `（${Math.round((regionProgress.completed / regionProgress.total) * 100)}%）` : ""}
                    </small>
                    <div className="workbench-actions">
                      <button type="button" className="button small" onClick={markFocusedColorComplete}>{activeTile ? "本板此色全部完成" : "此色全部完成"}</button>
                      <button type="button" className="button small" onClick={clearBuildProgress} disabled={completedCells.size === 0}>清空全部进度</button>
                    </div>
                    <small>非当前色会淡化；点当前色格子打勾，按住拖动可连续打勾或取消。进度自动保存在本机。</small>
                  </div>
                )}
              </div>
            )}

            <div className="canvas-toolbar">
              {(
                <Segmented
                  label="对比视图"
                  size="compact"
                  className="stage-view-switch"
                  value={stageView}
                  options={[
                    { value: "pattern" as StageView, label: "图纸" },
                    { value: "beads" as StageView, label: "成品效果" },
                    ...(design.pixelated ? [{ value: "pixelated" as StageView, label: "像素化" }] : []),
                    ...(originalUrl ? [{ value: "original" as StageView, label: "原图" }] : [])
                  ]}
                  onChange={setStageView}
                />
              )}
              <span className="canvas-hint">{stageView !== "pattern"
                ? "与图纸同尺寸对比；切回“图纸”继续查看或编辑"
                : mode === "view"
                  ? "双击或放大查看每格色号；聚焦后方向键逐格移动"
                  : "点格子或方向键 + Enter 操作；快捷键 B 画笔 · G 油漆桶 · I 取色 · E 擦除 · M 框选 · V 查看"}</span>
              <div className="zoom-controls" role="group" aria-label="图纸缩放">
                <button type="button" onClick={zoomOut} disabled={zoom === "fit"} aria-label="缩小图纸"><IconMinus /></button>
                <button type="button" className="zoom-value" onClick={() => setZoom("fit")}>{zoomLabel}</button>
                <button type="button" onClick={zoomIn} disabled={zoom === 2} aria-label="放大图纸"><IconPlus /></button>
              </div>
            </div>
            {stageView !== "pattern" && (
              <div className="compare-frame is-stage">
                {stageView === "beads" ? (
                  <div className="bead-preview">
                    <BeadPreviewCanvas design={design} palette={palette} look={beadLook} className="compare-pixels" />
                    <Segmented
                      label="成品效果"
                      size="compact"
                      value={beadLook}
                      options={[{ value: "fused" as const, label: "熨烫后" }, { value: "loose" as const, label: "未熨烫" }]}
                      onChange={setBeadLook}
                    />
                  </div>
                ) : stageView === "pixelated" && design.pixelated ? (
                  <PixelCanvas source={design.pixelated} className="compare-pixels" label={`${design.fileName} 像素化结果`} />
                ) : stageView === "original" && originalUrl ? (
                  <img src={originalUrl} alt={`${design.fileName} 原图`} />
                ) : null}
              </div>
            )}
            <div
              ref={viewportRef}
              hidden={stageView !== "pattern"}
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
              <div ref={stageRef} className={`canvas-stage ${zoom === "fit" ? "is-fit" : "is-zoomed"}`} style={stageStyle}>
                <canvas
                  ref={canvasRef}
                  aria-label={`${design.fileName} 拼豆图纸`}
                  onClick={handleCanvasClick}
                  onPointerDown={handlePointerDown}
                  onPointerMove={handlePointerMove}
                  onPointerUp={finishStroke}
                  onPointerCancel={finishStroke}
                />
                {selectionBox && (
                  <div className="grid-selection" style={selectionBox} aria-hidden="true" />
                )}
                {cursorBox && (
                  <div ref={cursorRef} className="grid-cursor" style={cursorBox} aria-hidden="true" />
                )}
              </div>
            </div>
            <div className="canvas-footer">
              <figcaption>{stageView === "beads"
                ? "成品效果：按豆子形状模拟，屏幕颜色仅供参考"
                : stageView === "pixelated"
                ? "像素化：每格一个颜色，再匹配到最接近的色号"
                : stageView === "original"
                  ? "原图"
                  : `拼豆图纸 · 粗线为 ${design.settings?.boardTilePins ?? 52} 针分板边界`}
                {sizeMini && sizeStandard && (
                  <span className="finished-size" title={`5mm 豆约 ${sizeStandard.width} × ${sizeStandard.height} cm`}>
                    成品约 {sizeMini.width} × {sizeMini.height} cm（2.6mm 豆）
                  </span>
                )}
              </figcaption>
              <div className="canvas-footer-actions">
                {onExportPdf && (
                  <button type="button" className="button secondary" onClick={onExportPdf}>分板打印 PDF</button>
                )}
                {onDownload && (
                  <button
                    id="download-pattern"
                    type="button"
                    className="button primary pattern-download"
                    onClick={onDownload}
                    disabled={isDownloading}
                  >
                    <IconDownload className="button-icon" />
                    {isDownloading ? "正在生成高清图…" : "下载高清色号图"}
                  </button>
                )}
              </div>
            </div>
          </figure>
        </div>
      ) : (
        <div className="empty-state">
          <EmptyIllustration />
          <strong>还没有图纸</strong>
          <span>上传图片后自动完成：原图 → 像素化 → 匹配色号 → 统计用豆。</span>
        </div>
      )}
    </section>
  );
}

// 空状态插画：一颗 9×9 的像素爱心按顺序“落豆”，示意图片被转换成拼豆格。
const HEART = [
  "..##.##..",
  ".#######.",
  "#########",
  "#########",
  ".#######.",
  "..#####..",
  "...###...",
  "....#....",
  "........."
];

function EmptyIllustration() {
  return (
    <div className="empty-illustration" aria-hidden="true">
      {HEART.flatMap((row, y) => row.split("").map((cell, x) => (
        <i
          key={`${x}-${y}`}
          className={cell === "#" ? (x + y < 6 ? "is-light" : "is-filled") : ""}
          style={{ animationDelay: `${(x + y) * 45}ms` }}
        />
      )))}
    </div>
  );
}
