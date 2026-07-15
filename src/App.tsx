import { useEffect, useMemo, useRef, useState } from "react";
import { CropDialog, type CropFractions } from "./components/CropDialog";
import { DesignPreview } from "./components/DesignPreview";
import { PalettePanel } from "./components/PalettePanel";
import { SettingsPanel, type UiSettings } from "./components/SettingsPanel";
import { StatsTable } from "./components/StatsTable";
import { UploadPanel } from "./components/UploadPanel";
import { removeBackgroundFromSource, type RemovalProgress } from "./domain/backgroundRemoval";
import { getBoardSize } from "./domain/boards";
import { summarizeProject } from "./domain/conversion";
import { autoCropToContent, cropPixelSource, rectFromFractions } from "./domain/crop";
import { countsToCsv, downloadDataUrl, downloadTextFile, openPrintableSheet } from "./domain/exporters";
import { imageFileToPixelSource, pixelSourceToDataUrl } from "./domain/image";
import { MARD_PALETTE } from "./domain/palette";
import { renderDesignToDataUrl } from "./domain/rendering";
import type { BeadDesign, PixelSource } from "./domain/types";
import type { ConversionRequest, ConversionResponse } from "./worker/conversion.worker";

type UploadedImage = {
  id: string;
  fileName: string;
  source: PixelSource;
  previewUrl: string;
};

const STORAGE_KEY = "image2pindou:inventory:v1";

const initialSettings: UiSettings = {
  boardPreset: "52",
  customWidth: 64,
  customHeight: 64,
  maxColors: 24,
  keepTransparent: true,
  showLabels: true,
  fit: "contain",
  dither: false,
  adjustments: { brightness: 0, contrast: 0, saturation: 0 },
  smooth: 0,
  outline: false,
  ignoreWhiteBg: true
};

type InventoryState = {
  restrictEnabled: boolean;
  allowedCodes: Set<string>;
};

function loadInventory(): InventoryState {
  if (typeof window === "undefined") {
    return { restrictEnabled: false, allowedCodes: new Set() };
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { restrictEnabled: false, allowedCodes: new Set() };
    }
    const parsed = JSON.parse(raw) as { restrictEnabled?: boolean; allowedCodes?: string[] };
    return {
      restrictEnabled: Boolean(parsed.restrictEnabled),
      allowedCodes: new Set(Array.isArray(parsed.allowedCodes) ? parsed.allowedCodes : [])
    };
  } catch {
    return { restrictEnabled: false, allowedCodes: new Set() };
  }
}

export default function App() {
  const [settings, setSettings] = useState<UiSettings>(initialSettings);
  const [images, setImages] = useState<UploadedImage[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isConverting, setIsConverting] = useState(false);
  const [designs, setDesigns] = useState<BeadDesign[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [inventory, setInventory] = useState<InventoryState>(() => loadInventory());
  const [cropImageId, setCropImageId] = useState<string | null>(null);
  const [cropBusy, setCropBusy] = useState(false);
  const [cropProgress, setCropProgress] = useState<RemovalProgress | null>(null);

  const workerRef = useRef<Worker | null>(null);
  const generationRef = useRef(0);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
        restrictEnabled: inventory.restrictEnabled,
        allowedCodes: Array.from(inventory.allowedCodes)
      }));
    } catch {
      // 忽略写入失败，例如隐私模式或配额超限
    }
  }, [inventory]);

  const boardSize = getBoardSize(settings.boardPreset, settings.customWidth, settings.customHeight);
  const allowedCodesArray = useMemo(
    () => (inventory.restrictEnabled ? Array.from(inventory.allowedCodes) : null),
    [inventory.restrictEnabled, inventory.allowedCodes]
  );

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
      setDesigns([]);
      setIsConverting(false);
      return;
    }

    const generation = (generationRef.current += 1);
    const results = new Map<string, BeadDesign>();
    let pending = images.length;
    setIsConverting(true);

    const handleMessage = (event: MessageEvent<ConversionResponse>) => {
      const data = event.data;
      if (data.generation !== generationRef.current) {
        return;
      }
      if ("design" in data) {
        results.set(data.id, data.design);
      } else {
        pending -= 1;
        setError(data.error);
        if (pending <= 0) {
          setIsConverting(false);
        }
        return;
      }
      setDesigns(images.map((image) => results.get(image.id)).filter((design): design is BeadDesign => Boolean(design)));
      pending -= 1;
      if (pending <= 0) {
        setIsConverting(false);
      }
    };

    worker.addEventListener("message", handleMessage);

    const timer = window.setTimeout(() => {
      for (const image of images) {
        const request: ConversionRequest = {
          generation,
          id: image.id,
          fileName: image.fileName,
          source: image.source,
          settings: {
            boardWidth: boardSize.width,
            boardHeight: boardSize.height,
            maxColors: settings.maxColors,
            keepTransparent: settings.keepTransparent,
            transparentThreshold: 10,
            dither: settings.dither,
            fit: settings.fit,
            allowedColorCodes: allowedCodesArray,
            adjustments: settings.adjustments,
            smooth: settings.smooth,
            outline: settings.outline,
            ignoreWhiteBg: settings.ignoreWhiteBg
          }
        };
        worker.postMessage(request);
      }
    }, 160);

    return () => {
      window.clearTimeout(timer);
      worker.removeEventListener("message", handleMessage);
    };
  }, [
    allowedCodesArray,
    boardSize.height,
    boardSize.width,
    images,
    settings.adjustments,
    settings.dither,
    settings.fit,
    settings.ignoreWhiteBg,
    settings.keepTransparent,
    settings.maxColors,
    settings.outline,
    settings.smooth
  ]);

  const activeDesign = designs.find((design) => design.id === activeId) ?? designs[0];
  const activeOriginalUrl = activeDesign
    ? images.find((image) => image.id === activeDesign.id)?.previewUrl
    : undefined;
  const projectTotals = summarizeProject(designs);
  const totalBeads = Object.values(projectTotals).reduce((sum, count) => sum + count, 0);
  const currentDesignCodes = useMemo(() => {
    return activeDesign ? new Set(Object.keys(activeDesign.colorCounts)) : new Set<string>();
  }, [activeDesign]);

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
        previewUrl: URL.createObjectURL(file)
      })));

      setImages((current) => [...current, ...loaded]);
      setActiveId((current) => current ?? loaded[0]?.id ?? null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "图片处理失败。");
    } finally {
      setIsProcessing(false);
    }
  };

  const removeImage = (id: string) => {
    setImages((current) => {
      const target = current.find((image) => image.id === id);
      if (target) {
        URL.revokeObjectURL(target.previewUrl);
      }
      return current.filter((image) => image.id !== id);
    });
    setActiveId((current) => (current === id ? null : current));
  };

  // 从一张图框选/抠图，生成一张独立的新图纸（支持把一张总图拆成多个主体）。
  const addCroppedDesign = async (rect: CropFractions | null, removeBg: boolean) => {
    const sourceImage = images.find((image) => image.id === cropImageId);
    if (!sourceImage) {
      return;
    }
    setCropBusy(true);
    setCropProgress(null);
    setError(null);
    try {
      let derived: PixelSource = rect
        ? cropPixelSource(sourceImage.source, rectFromFractions(sourceImage.source, rect.fx, rect.fy, rect.fw, rect.fh))
        : sourceImage.source;

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
        previewUrl: pixelSourceToDataUrl(derived)
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

  const exportActiveCsv = () => {
    if (!activeDesign) {
      return;
    }
    downloadTextFile(`${stripExtension(activeDesign.fileName)}-colors.csv`, countsToCsv(activeDesign.colorCounts, MARD_PALETTE));
  };

  const exportProjectCsv = () => {
    downloadTextFile("project-bead-shopping-list.csv", countsToCsv(projectTotals, MARD_PALETTE));
  };

  const exportActivePng = () => {
    if (!activeDesign) {
      return;
    }
    const url = renderDesignToDataUrl(activeDesign, MARD_PALETTE, {
      cellSize: 16,
      showLabels: settings.showLabels,
      boardLineEvery: 52,
      showCoordinates: true
    });
    downloadDataUrl(`${stripExtension(activeDesign.fileName)}-pattern.png`, url);
  };

  const exportActivePdf = () => {
    if (!activeDesign) {
      return;
    }
    const opened = openPrintableSheet(activeDesign, MARD_PALETTE);
    if (!opened) {
      setError("浏览器拦截了打印窗口，请允许弹出窗口后重试。");
    }
  };

  return (
    <div className="app-shell">
      <header className="hero">
        <nav className="nav">
          <strong>Pixel Beads Designer</strong>
          <span>MARD 色卡 · 多图统计 · PNG/CSV 导出</span>
        </nav>
        <div className="hero-grid">
          <div>
            <p className="eyebrow">Image to PinDou Design</p>
            <h1>拼豆图纸工坊</h1>
            <p className="hero-copy">
              上传图片，选择 52 针、104 针或自定义尺寸，自动转换成拼豆网格，并汇总每种 MARD 色号需要多少颗豆。
            </p>
            <div className="hero-actions">
              <a href="#upload-title" className="button primary">开始上传</a>
              <a href="#palette-title" className="button secondary">查看色卡</a>
            </div>
          </div>
          <div className="hero-card">
            <span>当前项目</span>
            <strong>{designs.length}</strong>
            <small>张图纸</small>
            <strong>{totalBeads}</strong>
            <small>颗豆子</small>
          </div>
        </div>
      </header>

      <main className="workspace">
        <aside className="sidebar">
          <UploadPanel onFiles={handleFiles} isProcessing={isProcessing} />
          <SettingsPanel settings={settings} onChange={setSettings} />
          {error && <div className="error-box" role="alert">{error}</div>}
        </aside>

        <section className="main-column">
          {isConverting && (
            <div className="converting-banner" role="status">正在生成图纸…</div>
          )}
          {designs.length > 0 && (
            <div className="design-tabs" aria-label="图纸列表">
              {designs.map((design) => (
                <span key={design.id} className={`design-tab ${design.id === activeDesign?.id ? "active" : ""}`}>
                  <button type="button" onClick={() => setActiveId(design.id)}>
                    {design.fileName}
                  </button>
                  <button
                    type="button"
                    className="design-tab-remove"
                    aria-label={`移除 ${design.fileName}`}
                    onClick={() => removeImage(design.id)}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}

          {activeDesign && activeOriginalUrl && (
            <div className="preview-toolbar">
              <button
                type="button"
                className="button small"
                onClick={() => setCropImageId(activeDesign.id)}
              >
                ✂️ 裁剪 / 智能去背景
              </button>
              <small className="muted">框选一个主体 → 智能去背景 → 生成独立图纸；可对同一张总图重复操作拆出多个。</small>
            </div>
          )}

          <DesignPreview
            design={activeDesign}
            palette={MARD_PALETTE}
            showLabels={settings.showLabels}
            originalUrl={activeOriginalUrl}
          />

          <div className="stats-grid">
            <StatsTable
              title="当前图纸用豆"
              counts={activeDesign?.colorCounts ?? {}}
              palette={MARD_PALETTE}
              action={activeDesign && (
                <div className="button-row">
                  <button type="button" className="button small" onClick={exportActivePng}>导出 PNG</button>
                  <button type="button" className="button small" onClick={exportActivePdf}>导出 PDF</button>
                  <button type="button" className="button small" onClick={exportActiveCsv}>导出 CSV</button>
                </div>
              )}
            />
            <StatsTable
              title="项目总用豆"
              counts={projectTotals}
              palette={MARD_PALETTE}
              action={designs.length > 0 && (
                <button type="button" className="button small" onClick={exportProjectCsv}>导出采购 CSV</button>
              )}
            />
          </div>
        </section>

        <PalettePanel
          palette={MARD_PALETTE}
          restrictEnabled={inventory.restrictEnabled}
          allowedCodes={inventory.allowedCodes}
          currentDesignCodes={currentDesignCodes}
          onChange={setInventory}
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
            title={`裁剪 / 抠图 · ${cropImage.fileName}`}
            busy={cropBusy}
            progress={cropProgress}
            onCancel={() => { if (!cropBusy) setCropImageId(null); }}
            onSubmit={(rect, removeBg) => { void addCroppedDesign(rect, removeBg); }}
          />
        );
      })()}
    </div>
  );
}

function stripExtension(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "");
}
