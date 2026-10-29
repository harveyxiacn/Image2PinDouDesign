import { useEffect, useMemo, useRef, useState } from "react";
import { CropDialog, type CropFractions } from "./components/CropDialog";
import { DesignGallery } from "./components/DesignGallery";
import { DesignPreview } from "./components/DesignPreview";
import { PalettePanel } from "./components/PalettePanel";
import { SettingsPanel, type UiSettings } from "./components/SettingsPanel";
import { StatsTable } from "./components/StatsTable";
import { UploadPanel } from "./components/UploadPanel";
import { IconCrop, IconDownload, IconEdit, IconPlus, IconSettings } from "./components/icons";
import { removeBackgroundFromSource, type RemovalProgress } from "./domain/backgroundRemoval";
import { DEFAULT_SETTINGS, resolveBoardSize, toConversionSettings } from "./domain/settings";
import { getDesignSizeOptions, getSmartSizeDescription, type DesignSizeOption } from "./domain/designSizing";
import { autoCropToContent, cropPixelSource, rectFromFractions } from "./domain/crop";
import { countsToCsv, downloadBlob, downloadTextFile, openPrintableSheet } from "./domain/exporters";
import { applyConversionMessage, cancelConversionTask, createConversionCoordinator, type ConversionCoordinatorState, type ConversionTaskProgress } from "./domain/conversionCoordinator";
import { loadDesignDrafts, persistDesignDrafts, DRAFTS_STORAGE_KEY, MAX_LOCAL_DRAFTS } from "./domain/drafts";
import { imageFileToPixelSource, pixelSourceToDataUrl } from "./domain/image";
import { computeCropRect, type FocusPoint } from "./domain/focus";
import { aggregateCounts, countDesignsBySource, type StatsSourceFilter } from "./domain/projectStats";
import { analyzeSource, applyStylePreset, recommendSettings, type RecommendedSettings, type StylePresetId } from "./domain/recommend";
import { computeShortfall, loadOwnedInventory, ownedToAllowedCodes, persistOwnedInventory, setOwnedCount, type OwnedInventory } from "./domain/shortfall";
import { MARD_PALETTE } from "./domain/palette";
import { getHighResolutionCellSize, renderDesignToBlob } from "./domain/rendering";
import type { BeadDesign, PixelSource } from "./domain/types";
import { mirrorDesignHorizontally, replaceDesignCell } from "./domain/workbench";
import type { ConversionRequest, ConversionResponse } from "./worker/conversion.worker";

type UploadedImage = {
  id: string;
  fileName: string;
  source: PixelSource;
  previewUrl: string;
  settings: UiSettings;
};

const VALID_COLOR_CODES = new Set(MARD_PALETTE.map((color) => color.code));
const STATS_SOURCE_LABELS: Record<StatsSourceFilter, string> = {
  all: "全部图纸",
  projects: "正式项目",
  drafts: "本机草稿"
};

type EditHistory = {
  past: BeadDesign[];
  future: BeadDesign[];
};

const MAX_EDIT_HISTORY = 30;

export default function App() {
  const [uploadSettings, setUploadSettings] = useState<UiSettings>(DEFAULT_SETTINGS);
  const [images, setImages] = useState<UploadedImage[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isConverting, setIsConverting] = useState(false);
  const [designs, setDesigns] = useState<BeadDesign[]>(() => loadDesignDrafts(VALID_COLOR_CODES));
  const [error, setError] = useState<string | null>(null);
  const [inventory, setInventory] = useState<OwnedInventory>(() => loadOwnedInventory());
  const [cropImageId, setCropImageId] = useState<string | null>(null);
  const [cropBusy, setCropBusy] = useState(false);
  const [cropProgress, setCropProgress] = useState<RemovalProgress | null>(null);
  const [isExportingPng, setIsExportingPng] = useState(false);
  const [editHistories, setEditHistories] = useState<Record<string, EditHistory>>({});
  const [conversionProgress, setConversionProgress] = useState<Record<string, ConversionTaskProgress>>({});
  const [sourceFilter, setSourceFilter] = useState<StatsSourceFilter>("all");

  const workerRef = useRef<Worker | null>(null);
  const generationRef = useRef(0);
  // 当前转换代次的协调器状态；取消按钮经由它登记已放弃的任务 id。
  const conversionCoordinatorRef = useRef<ConversionCoordinatorState | null>(null);
  const generatedDesignsRef = useRef(new Map<string, BeadDesign>());
  const localDraftsRef = useRef<BeadDesign[]>(designs);
  const localDraftIdsRef = useRef(new Set(designs.map((design) => design.id)));
  const savedCopyIdsRef = useRef(new Map<string, string>());
  const convertedInputsRef = useRef(new Map<string, { source: PixelSource; key: string }>());

  const activeDesign = designs.find((design) => design.id === activeId)
    ?? (images.some((image) => image.id === activeId) ? undefined : designs[0]);
  const activeImage = images.find((image) => image.id === activeId)
    ?? images.find((image) => image.id === activeDesign?.id);
  const settings = activeImage?.settings ?? uploadSettings;
  const setSettings = (update: UiSettings | ((current: UiSettings) => UiSettings)) => {
    const apply = (current: UiSettings) => typeof update === "function" ? update(current) : update;
    if (activeImage) {
      setImages((current) => current.map((image) => image.id === activeImage.id
        ? { ...image, settings: apply(image.settings) } : image));
    } else {
      setUploadSettings(apply);
    }
  };

  useEffect(() => {
    persistOwnedInventory(inventory);
  }, [inventory]);

  const boardSize = resolveBoardSize(settings);
  // v2 库存：限制模式开启时取 owned>0 的色号集合；引用随 inventory 变化，保持转换 effect 依赖稳定。
  const allowedCodesKey = inventory.restrictEnabled ? [...(ownedToAllowedCodes(inventory) ?? [])].sort().join(",") : null;
  const allowedCodesArray = useMemo(() => allowedCodesKey === null ? null : allowedCodesKey.split(",").filter(Boolean), [allowedCodesKey]);

  const recommendationImage = activeImage;

  // 一键推荐：分析当前正在编辑的图片，避免裁剪/去背后仍沿用首张原图的判断。
  const recommendationAnalysis = useMemo(
    () => (recommendationImage ? analyzeSource(recommendationImage.source) : null),
    [recommendationImage?.source]
  );
  const recommendation = useMemo(
    () => (recommendationAnalysis ? recommendSettings(recommendationAnalysis) : null),
    [recommendationAnalysis]
  );
  const sizeOptions = useMemo(() => recommendationImage
    ? getDesignSizeOptions(recommendationImage.source, settings.autoFrame, settings.ignoreWhiteBg) : undefined,
  [recommendationImage?.source, settings.autoFrame, settings.ignoreWhiteBg]);
  // 紧贴主体后的宽高比：用最大的尺寸档位反推，和图纸实际比例一致。
  const subjectAspectRatio = useMemo(() => {
    const reference = sizeOptions?.[sizeOptions.length - 1];
    return reference ? reference.width / reference.height : recommendationAnalysis?.aspectRatio ?? null;
  }, [recommendationAnalysis?.aspectRatio, sizeOptions]);
  const smartSizeHint = useMemo(() => settings.boardPreset === "smart" && recommendationImage
    ? getSmartSizeDescription(recommendationImage.source, settings.autoFrame, settings.ignoreWhiteBg) : null,
  [recommendationImage?.source, settings.boardPreset, settings.autoFrame, settings.ignoreWhiteBg]);

  // 单个常驻 Worker，把整张图的转换搬离主线程；组件卸载时回收。
  useEffect(() => {
    if (typeof Worker === "undefined") {
      return;
    }
    const worker = new Worker(new URL("./worker/conversion.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  // 输入（图片 / 影响转换的设置）变化时，防抖后把每张图派给 Worker 转换。
  // 用 generation 令牌丢弃过期结果，避免快速调参时的竞态。showLabels 只影响渲染、不在依赖内。
  useEffect(() => {
    const worker = workerRef.current;
    if (!worker) {
      return;
    }
    if (images.length === 0) {
      generationRef.current += 1;
      conversionCoordinatorRef.current = null;
      setConversionProgress({});
      setDesigns((current) => current.filter((design) => localDraftIdsRef.current.has(design.id)));
      setEditHistories({});
      generatedDesignsRef.current.clear();
      convertedInputsRef.current.clear();
      setIsConverting(false);
      return;
    }

    const pendingImages = images.map((image) => {
      const conversionSettings = toConversionSettings(image.settings, allowedCodesArray);
      return { image, conversionSettings, key: JSON.stringify(conversionSettings) };
    }).filter(({ image, key }) => {
      const previous = convertedInputsRef.current.get(image.id);
      return previous?.source !== image.source || previous.key !== key;
    });
    if (pendingImages.length === 0) {
      setIsConverting(false);
      setConversionProgress({});
      return;
    }
    const generation = (generationRef.current += 1);
    conversionCoordinatorRef.current = null;
    let coordinator = createConversionCoordinator(
      generation,
      pendingImages.map(({ image }) => ({ id: image.id, fileName: image.fileName }))
    );
    conversionCoordinatorRef.current = coordinator;
    setConversionProgress(coordinator.progress);
    let lastError: string | null = coordinator.error;
    setIsConverting(true);

    const handleMessage = (event: MessageEvent<ConversionResponse>) => {
      if (event.data.generation !== generation) return;
      coordinator = conversionCoordinatorRef.current ?? coordinator;
      const previousResults = coordinator.results;
      coordinator = applyConversionMessage(coordinator, event.data);
      conversionCoordinatorRef.current = coordinator;
      // 过期代次消息会被 applyConversionMessage 原样丢弃，无需单独判断。
      setConversionProgress(coordinator.progress);
      if (coordinator.error !== lastError) {
        lastError = coordinator.error;
        setError(coordinator.error);
      }
      if (coordinator.pending === 0) {
        setIsConverting(false);
      }
      // 新到达的 design：记录 generatedDesignsRef、清理编辑历史，并按 images 顺序映射到 designs。
      if (coordinator.results !== previousResults) {
        for (const id of Object.keys(coordinator.results)) {
          if (Object.prototype.hasOwnProperty.call(previousResults, id)) {
            continue;
          }
          const design = coordinator.results[id];
          const input = pendingImages.find(({ image }) => image.id === id);
          if (input) convertedInputsRef.current.set(id, { source: input.image.source, key: input.key });
          generatedDesignsRef.current.set(id, design);
          setEditHistories((current) => {
            if (!current[id]) return current;
            const next = { ...current };
            delete next[id];
            return next;
          });
        }
        setDesigns((current) => {
          const byId = new Map(current.map((design) => [design.id, design]));
          for (const [id, design] of Object.entries(coordinator.results)) {
            if (!Object.prototype.hasOwnProperty.call(previousResults, id)) byId.set(id, design);
          }
          return [...current.filter((design) => localDraftIdsRef.current.has(design.id)),
            ...images.map((image) => byId.get(image.id)).filter((design): design is BeadDesign => Boolean(design))];
        });
      }
    };

    worker.addEventListener("message", handleMessage);

    const timer = window.setTimeout(() => {
      for (const { image, conversionSettings } of pendingImages) {
        const request: ConversionRequest = {
          generation,
          id: image.id,
          fileName: image.fileName,
          source: image.source,
          settings: conversionSettings
        };
        worker.postMessage(request);
      }
    }, 160);

    return () => {
      window.clearTimeout(timer);
      worker.removeEventListener("message", handleMessage);
      conversionCoordinatorRef.current = null;
    };
  }, [allowedCodesArray, images]);

  const activeOriginalUrl = activeDesign
    ? images.find((image) => image.id === activeDesign.id)?.previewUrl
    : undefined;
  const projectTotals = useMemo(
    () => aggregateCounts(designs, localDraftIdsRef.current, sourceFilter),
    [designs, sourceFilter]
  );
  const filteredDesignCount = useMemo(
    () => countDesignsBySource(designs, localDraftIdsRef.current, sourceFilter),
    [designs, sourceFilter]
  );
  const totalBeads = Object.values(projectTotals).reduce((sum, count) => sum + count, 0);
  const hasInput = images.length > 0 || designs.length > 0;
  const flowStep = !hasInput ? 0 : !activeDesign ? (isConverting ? 2 : 1) : 3;
  const currentDesignCodes = useMemo(() => {
    return activeDesign ? new Set(Object.keys(activeDesign.colorCounts)) : new Set<string>();
  }, [activeDesign]);
  const activeHistory = activeDesign ? editHistories[activeDesign.id] : undefined;
  const activeGeneratedDesign = activeDesign ? generatedDesignsRef.current.get(activeDesign.id) : undefined;

  const persistDraftMutation = (nextDesign: BeadDesign) => {
    if (!localDraftIdsRef.current.has(nextDesign.id)) return;
    localDraftsRef.current = localDraftsRef.current.map((draft) => draft.id === nextDesign.id ? nextDesign : draft);
    persistDesignDrafts(localDraftsRef.current);
  };

  const commitActiveDesign = (nextDesign: BeadDesign) => {
    if (!activeDesign || nextDesign === activeDesign) {
      return;
    }
    setEditHistories((current) => {
      const history = current[activeDesign.id] ?? { past: [], future: [] };
      return {
        ...current,
        [activeDesign.id]: {
          past: [...history.past.slice(-(MAX_EDIT_HISTORY - 1)), activeDesign],
          future: []
        }
      };
    });
    persistDraftMutation(nextDesign);
    setDesigns((current) => current.map((design) => design.id === activeDesign.id ? nextDesign : design));
  };

  const editActiveCell = (x: number, y: number, code: string | null) => {
    if (!activeDesign) return;
    commitActiveDesign(replaceDesignCell(activeDesign, x, y, code));
  };

  const mirrorActiveDesign = () => {
    if (!activeDesign) return;
    commitActiveDesign(mirrorDesignHorizontally(activeDesign));
  };

  const undoActiveEdit = () => {
    if (!activeDesign || !activeHistory || activeHistory.past.length === 0) return;
    const previous = activeHistory.past[activeHistory.past.length - 1];
    setEditHistories((current) => ({
      ...current,
      [activeDesign.id]: {
        past: activeHistory.past.slice(0, -1),
        future: [activeDesign, ...activeHistory.future].slice(0, MAX_EDIT_HISTORY)
      }
    }));
    persistDraftMutation(previous);
    setDesigns((current) => current.map((design) => design.id === activeDesign.id ? previous : design));
  };

  const redoActiveEdit = () => {
    if (!activeDesign || !activeHistory || activeHistory.future.length === 0) return;
    const nextDesign = activeHistory.future[0];
    setEditHistories((current) => ({
      ...current,
      [activeDesign.id]: {
        past: [...activeHistory.past, activeDesign].slice(-MAX_EDIT_HISTORY),
        future: activeHistory.future.slice(1)
      }
    }));
    persistDraftMutation(nextDesign);
    setDesigns((current) => current.map((design) => design.id === activeDesign.id ? nextDesign : design));
  };

  const cancelConversion = (id: string) => {
    // 先在本端登记，保证即使 worker 还在执行同步转换，
    // 结果到达后也会被丢弃；同时通知 worker 跳过尚未开始的同代任务。
    const coordinator = conversionCoordinatorRef.current;
    if (coordinator) {
      conversionCoordinatorRef.current = cancelConversionTask(coordinator, id);
    }
    workerRef.current?.postMessage({ type: "cancel", generation: generationRef.current, id });
    setConversionProgress((current) => removeProgressEntry(current, id));
  };

  // Ctrl+Z / Ctrl+Shift+Z（或 Ctrl+Y）撤销/重做；聚焦输入框、下拉框或可编辑区时不触发。
  const undoRedoRef = useRef({ undo: undoActiveEdit, redo: redoActiveEdit });
  undoRedoRef.current = { undo: undoActiveEdit, redo: redoActiveEdit };

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const isEditable = target instanceof HTMLElement && (
        target.isContentEditable ||
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT"
      );
      if (isEditable || !(event.ctrlKey || event.metaKey)) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "z") {
        event.preventDefault();
        if (event.shiftKey) {
          undoRedoRef.current.redo();
        } else {
          undoRedoRef.current.undo();
        }
      } else if (key === "y") {
        event.preventDefault();
        undoRedoRef.current.redo();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const resetActiveDesign = () => {
    if (activeGeneratedDesign) {
      commitActiveDesign(activeGeneratedDesign);
    }
  };

  const saveActiveDraft = () => {
    if (!activeDesign) return;
    const existingDraftId = localDraftIdsRef.current.has(activeDesign.id)
      ? activeDesign.id
      : savedCopyIdsRef.current.get(activeDesign.id);
    const draftId = existingDraftId ?? `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const snapshot: BeadDesign = {
      ...activeDesign,
      id: draftId,
      fileName: localDraftIdsRef.current.has(activeDesign.id)
        ? activeDesign.fileName
        : `${stripExtension(activeDesign.fileName)}-本机草稿`
    };
    const withoutCurrent = localDraftsRef.current.filter((draft) => draft.id !== draftId);
    localDraftsRef.current = [snapshot, ...withoutCurrent].slice(0, MAX_LOCAL_DRAFTS);
    localDraftIdsRef.current = new Set(localDraftsRef.current.map((draft) => draft.id));
    savedCopyIdsRef.current.set(activeDesign.id, draftId);
    persistDesignDrafts(localDraftsRef.current);
    setDesigns((current) => current.filter((design) =>
      !design.id.startsWith("draft-") || localDraftIdsRef.current.has(design.id)));
  };

  const handleFiles = async (files: File[]) => {
    const imageFiles = files.filter((file) => file.type.startsWith("image/"));
    if (imageFiles.length === 0) {
      setError("请选择 JPG、PNG 或 WebP 图片。");
      return;
    }

    setIsProcessing(true);
    setError(null);
    try {
      const loaded = await Promise.all(imageFiles.map(async (file) => ({
        id: `${file.name}-${file.lastModified}-${Math.random().toString(36).slice(2, 8)}`,
        fileName: file.name,
        source: await imageFileToPixelSource(file),
        previewUrl: URL.createObjectURL(file),
        settings: { ...uploadSettings, adjustments: { ...uploadSettings.adjustments } }
      })));

      setImages((current) => [...current, ...loaded]);
      setActiveId(loaded[0]?.id ?? null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "图片处理失败。");
    } finally {
      setIsProcessing(false);
    }
  };

  const removeDesign = (id: string) => {
    generatedDesignsRef.current.delete(id);
    convertedInputsRef.current.delete(id);
    if (localDraftIdsRef.current.has(id)) {
      localDraftsRef.current = localDraftsRef.current.filter((draft) => draft.id !== id);
      localDraftIdsRef.current.delete(id);
      persistDesignDrafts(localDraftsRef.current);
    }
    setEditHistories((current) => {
      if (!current[id]) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
    setImages((current) => {
      const target = current.find((image) => image.id === id);
      if (target) {
        URL.revokeObjectURL(target.previewUrl);
      }
      return current.filter((image) => image.id !== id);
    });
    setDesigns((current) => current.filter((design) => design.id !== id));
    setActiveId((current) => (current === id ? null : current));
  };

  // 从一张图框选/抠图，生成一张独立的新图纸（支持把一张总图拆成多个主体）。
  const addCroppedDesign = async (rect: CropFractions | null, removeBg: boolean, focus: FocusPoint) => {
    const sourceImage = images.find((image) => image.id === cropImageId);
    if (!sourceImage) {
      return;
    }
    setCropBusy(true);
    setCropProgress(null);
    setError(null);
    try {
      let derived: PixelSource;
      if (rect) {
        derived = cropPixelSource(sourceImage.source, rectFromFractions(sourceImage.source, rect.fx, rect.fy, rect.fw, rect.fh));
      } else if (settings.fit === "cover") {
        derived = cropPixelSource(sourceImage.source, computeCropRect(
          sourceImage.source,
          focus,
          "cover",
          boardSize.width / boardSize.height
        ));
      } else {
        derived = sourceImage.source;
      }

      if (removeBg) {
        derived = await removeBackgroundFromSource(derived, setCropProgress);
        derived = autoCropToContent(derived);
      }

      const base = stripExtension(sourceImage.fileName);
      const ordinal = images.filter((image) => image.fileName.startsWith(`${base}-`)).length + 1;
      const id = `${sourceImage.id}-crop-${ordinal}-${Math.random().toString(36).slice(2, 7)}`;
      const newImage: UploadedImage = {
        id,
        fileName: `${base}-${ordinal}.png`,
        source: derived,
        previewUrl: pixelSourceToDataUrl(derived),
        settings: { ...sourceImage.settings }
      };
      setImages((current) => [...current, newImage]);
      setActiveId(id);
      setCropImageId(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "裁剪/抠图失败。");
    } finally {
      setCropBusy(false);
      setCropProgress(null);
    }
  };

  const selectSize = (option: DesignSizeOption) => {
    setSettings((current) => ({ ...current, boardPreset: "custom", customWidth: option.width,
      customHeight: option.height, fit: "contain", sampling: recommendationAnalysis?.kind === "pixel-art" ? "nearest" : "detail",
      dither: false, smooth: 0, outline: false }));
  };

  const duplicateActiveImage = () => {
    if (!activeImage) return;
    const id = `${activeImage.id}-variant-${Math.random().toString(36).slice(2, 9)}`;
    const copy: UploadedImage = {
      ...activeImage, id, fileName: `${stripExtension(activeImage.fileName)}-尺寸副本.png`,
      previewUrl: pixelSourceToDataUrl(activeImage.source),
      settings: { ...activeImage.settings, adjustments: { ...activeImage.settings.adjustments } }
    };
    setImages((current) => [...current, copy]);
    setActiveId(id);
  };

  const exportActiveCsv = () => {
    if (!activeDesign) {
      return;
    }
    downloadTextFile(`${stripExtension(activeDesign.fileName)}-colors.csv`, countsToCsv(activeDesign.colorCounts, MARD_PALETTE));
  };

  const exportProjectCsv = () => {
    const prefix = sourceFilter === "drafts" ? "draft" : sourceFilter === "projects" ? "project" : "all-designs";
    downloadTextFile(`${prefix}-bead-shopping-list.csv`, countsToCsv(projectTotals, MARD_PALETTE));
  };

  const exportActivePng = async () => {
    if (!activeDesign) {
      return;
    }
    setIsExportingPng(true);
    setError(null);
    // 先让浏览器绘制“生成中”，避免大图编码期间用户以为按钮没有响应。
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    try {
      const blob = await renderDesignToBlob(activeDesign, MARD_PALETTE, {
        cellSize: getHighResolutionCellSize(activeDesign),
        showLabels: true,
        boardLineEvery: activeDesign.settings?.boardTilePins ?? 52,
        showCoordinates: true,
        sheet: true
      });
      downloadBlob(`${stripExtension(activeDesign.fileName)}-高清色号图.png`, blob);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "高清图生成失败，请稍后重试。");
    } finally {
      setIsExportingPng(false);
    }
  };

  const exportActivePdf = () => {
    if (!activeDesign) {
      return;
    }
    const pins = activeDesign.settings?.boardTilePins ?? 52;
    const opened = openPrintableSheet(activeDesign, MARD_PALETTE, {
      boardWidth: pins,
      boardHeight: pins,
      boardLineEvery: pins
    });
    if (!opened) {
      setError("浏览器拦截了打印窗口，请允许弹出窗口后重试。");
    }
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <BrandMark />
            <span className="brand-text">
              <h1>拼豆图纸工坊</h1>
              <small>图片像素化 · MARD 色号 · 用豆清单</small>
            </span>
          </div>
          <ol className="flow-steps" aria-label="制作流程">
            {FLOW_STEPS.map((step, index) => (
              <li key={step.href} data-state={index < flowStep ? "done" : index === flowStep ? "current" : "todo"}>
                <a href={step.href} aria-current={index === flowStep ? "step" : undefined}>
                  <span className="flow-step-index">{index + 1}</span>
                  {step.label}
                </a>
              </li>
            ))}
          </ol>
          <div className="topbar-stats" aria-label={`${STATS_SOURCE_LABELS[sourceFilter]}统计`}>
            <span><strong>{filteredDesignCount}</strong> 张图纸</span>
            <span><strong>{totalBeads}</strong> 颗豆</span>
          </div>
        </div>
        <p className="topbar-lede">
          上传角色或照片，先按拼豆板针数像素化，再逐格匹配 MARD 色号；每张图纸可以独立设置尺寸、手工修改并导出分板打印图。图片只在本机浏览器处理。
        </p>
      </header>

      <nav className="mobile-nav" aria-label="手机端快捷导航">
        <a href="#upload-title"><IconPlus />上传</a>
        <a href={activeDesign ? "#pattern-editor" : "#preview-title"}>
          <IconEdit />{activeDesign ? "编辑" : "图纸"}
        </a>
        <a href="#settings-title"><IconSettings />设置</a>
        <a href="#download-pattern"><IconDownload />保存</a>
      </nav>

      <main className="workspace">
        <aside className="sidebar">
          <UploadPanel onFiles={handleFiles} isProcessing={isProcessing} />
          <SettingsPanel
            settings={settings}
            onChange={setSettings}
            onApplyPreset={(id) => setSettings((s) => ({ ...s, ...applyStylePreset(id as StylePresetId, s as RecommendedSettings) }))}
            recommendation={recommendation}
            smartSizeHint={smartSizeHint}
            sourceName={activeImage?.fileName}
            sizeOptions={sizeOptions}
            onSelectSize={selectSize}
            aspectRatio={subjectAspectRatio}
            generatedSize={activeDesign && activeImage?.id === activeDesign.id
              ? { width: activeDesign.boardWidth, height: activeDesign.boardHeight } : null}
            onApplyRecommendation={() => {
              if (recommendation) {
                setSettings((s) => ({ ...s, ...recommendation }));
              }
            }}
          />
          {error && <div className="error-box" role="alert">{error}</div>}
        </aside>

        <section className="main-column">
          {isConverting && (
            <div className="converting-banner" role="status">
              <span className="bead-loader" aria-hidden="true"><i /><i /><i /><i /></span>
              <strong>正在像素化并匹配色号…</strong>
              {Object.keys(conversionProgress).length > 0 && (
                <ul className="conversion-task-list">
                  {Object.entries(conversionProgress).map(([id, task]) => (
                    <li key={id} className="conversion-task">
                      <span className="conversion-task-name" title={task.fileName}>{task.fileName}</span>
                      <progress
                        className="conversion-task-bar"
                        value={task.percent}
                        max={100}
                        aria-label={`${task.fileName} 转换进度 ${task.percent}%`}
                      />
                      <span className="conversion-task-percent">{task.percent}%</span>
                      <button
                        type="button"
                        className="conversion-cancel"
                        onClick={() => cancelConversion(id)}
                      >
                        取消
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <DesignGallery
            designs={designs}
            activeId={activeDesign?.id}
            palette={MARD_PALETTE}
            draftIds={localDraftIdsRef.current}
            progress={conversionProgress}
            onSelect={setActiveId}
            onRemove={removeDesign}
          />

          {activeDesign && activeOriginalUrl && (
            <div className="preview-toolbar">
              <button
                type="button"
                className="button small"
                onClick={() => setCropImageId(activeDesign.id)}
              >
                <IconCrop /> 裁剪 / 智能去背景
              </button>
              <button type="button" className="button small" onClick={duplicateActiveImage} disabled={isConverting}>
                <IconPlus /> 复制为另一尺寸
              </button>
              <small className="muted">框选一个主体 → 智能去背景 → 生成独立图纸；可对同一张总图重复操作拆出多个。</small>
            </div>
          )}

          {activeDesign && (
            <div className="editor-entry" role="status">
              <div>
                <strong>图纸已经可以编辑</strong>
                <small>逐格改色、取色、擦除，支持撤销和恢复。</small>
              </div>
              <a className="button primary" href="#pattern-editor"><IconEdit />编辑图纸</a>
            </div>
          )}

          <DesignPreview
            design={activeDesign}
            palette={MARD_PALETTE}
            showLabels={settings.showLabels}
            originalUrl={activeOriginalUrl}
            onDownload={activeDesign ? () => { void exportActivePng(); } : undefined}
            isDownloading={isExportingPng}
            onCellChange={activeDesign ? editActiveCell : undefined}
            onMirror={activeDesign ? mirrorActiveDesign : undefined}
            onUndo={activeDesign ? undoActiveEdit : undefined}
            onRedo={activeDesign ? redoActiveEdit : undefined}
            onReset={activeDesign ? resetActiveDesign : undefined}
            onSaveDraft={activeDesign ? saveActiveDraft : undefined}
            canUndo={Boolean(activeHistory?.past.length)}
            canRedo={Boolean(activeHistory?.future.length)}
            canReset={Boolean(activeGeneratedDesign && activeGeneratedDesign !== activeDesign)}
          />

          <div className="stats-grid">
            <StatsTable
              title="当前图纸用豆"
              counts={activeDesign?.colorCounts ?? {}}
              palette={MARD_PALETTE}
              action={activeDesign && (
                <div className="button-row">
                  <button
                    type="button"
                    className="button small"
                    onClick={() => { void exportActivePng(); }}
                    disabled={isExportingPng}
                  >
                    {isExportingPng ? "生成中…" : "高清色号 PNG"}
                  </button>
                  <button type="button" className="button small" onClick={exportActivePdf}>导出 PDF</button>
                  <button type="button" className="button small" onClick={exportActiveCsv}>导出 CSV</button>
                </div>
              )}
            />
            <StatsTable
              title="项目总用豆"
              counts={projectTotals}
              palette={MARD_PALETTE}
              ownedCounts={inventory.owned}
              shortfall={computeShortfall(projectTotals, inventory.owned)}
              sourceFilter={sourceFilter}
              sourceCount={filteredDesignCount}
              onSourceFilterChange={setSourceFilter}
              onOwnedChange={(code, count) =>
                setInventory((inv) => ({ ...inv, owned: setOwnedCount(inv.owned, code, count) }))
              }
              action={filteredDesignCount > 0 && (
                <button type="button" className="button small" onClick={exportProjectCsv}>导出采购 CSV</button>
              )}
            />
          </div>
        </section>

        <PalettePanel
          palette={MARD_PALETTE}
          restrictEnabled={inventory.restrictEnabled}
          ownedCounts={inventory.owned}
          currentDesignCodes={currentDesignCodes}
          onChange={(next) => setInventory({ restrictEnabled: next.restrictEnabled, owned: next.ownedCounts })}
        />
      </main>

      {cropImageId && (() => {
        const cropImage = images.find((image) => image.id === cropImageId);
        if (!cropImage) {
          return null;
        }
        return (
          <CropDialog
            previewUrl={cropImage.previewUrl}
            source={cropImage.source}
            title={`裁剪 / 抠图 · ${cropImage.fileName}`}
            fitMode={settings.fit}
            targetAspect={boardSize.width / boardSize.height}
            busy={cropBusy}
            progress={cropProgress}
            onCancel={() => { if (!cropBusy) setCropImageId(null); }}
            onSubmit={(rect, removeBg, focus) => { void addCroppedDesign(rect, removeBg, focus); }}
          />
        );
      })()}
    </div>
  );
}

const FLOW_STEPS = [
  { label: "上传图片", href: "#upload-title" },
  { label: "选择尺寸", href: "#settings-title" },
  { label: "生成图纸", href: "#preview-title" },
  { label: "编辑导出", href: "#download-pattern" }
];

// 品牌标：3×3 拼豆格，中心空孔呼应真实拼豆。
function BrandMark() {
  const colors = ["#ee6c4d", "#f4a261", "#e9c46a", "#2a9d8f", "#264653", "#e76f51", "#8ab17d", "#3d5a80", "#f2cc8f"];
  return (
    <svg className="brand-mark" viewBox="0 0 36 36" aria-hidden="true">
      {colors.map((color, index) => (
        <g key={color} transform={`translate(${(index % 3) * 12 + 6} ${Math.floor(index / 3) * 12 + 6})`}>
          <circle r="5.2" fill={color} />
          <circle r="1.8" fill="#fffaf2" />
        </g>
      ))}
    </svg>
  );
}

function stripExtension(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "");
}

function removeProgressEntry(
  current: Record<string, ConversionTaskProgress>,
  id: string
): Record<string, ConversionTaskProgress> {
  if (!(id in current)) {
    return current;
  }
  const next = { ...current };
  delete next[id];
  return next;
}
