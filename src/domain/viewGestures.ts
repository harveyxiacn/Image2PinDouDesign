/**
 * 图纸视图的手势与快捷键决策：全是纯函数，不碰 DOM，便于单元测试。
 * 组件只负责把事件翻译成这里的入参，再按返回值执行。
 */

export type ZoomValue = "fit" | number;

export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 4;
/** 按钮 / 键盘 +/- 的档位；滚轮与双指捏合则连续缩放。 */
export const ZOOM_STEPS = [1, 1.5, 2, 3, 4] as const;

export function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

/** 按钮 / 键盘的下一档：从“适应屏幕”放大到 100%；缩小到最低档后回到“适应屏幕”。 */
export function stepZoom(current: ZoomValue, direction: 1 | -1): ZoomValue {
  if (current === "fit") return direction > 0 ? ZOOM_STEPS[0] : "fit";
  if (direction > 0) {
    const next = ZOOM_STEPS.find((step) => step > current + 1e-6);
    return next ?? MAX_ZOOM;
  }
  const lower = [...ZOOM_STEPS].reverse().find((step) => step < current - 1e-6);
  return lower ?? "fit";
}

/** 滚轮一格对应的缩放倍率（deltaY 向下为缩小）；兼容“按行”滚动的鼠标。 */
export function wheelZoomFactor(deltaY: number, deltaMode = 0): number {
  const pixels = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  const clamped = Math.max(-240, Math.min(240, pixels));
  return Math.exp(-clamped * 0.0018);
}

/**
 * 缩放后让锚点（光标 / 双指中心）下的内容保持不动：
 * anchor 是相对视口左上角的像素，旧宽度和新宽度是内容（舞台）的像素宽度。
 */
export function anchoredScroll(input: {
  scroll: number;
  anchor: number;
  oldSize: number;
  newSize: number;
}): number {
  const { scroll, anchor, oldSize, newSize } = input;
  if (!(oldSize > 0) || !(newSize > 0)) return Math.max(0, scroll);
  return Math.max(0, (scroll + anchor) * (newSize / oldSize) - anchor);
}

export type Point = { x: number; y: number };

export function pinchMetrics(a: Point, b: Point): { distance: number; center: Point } {
  return {
    distance: Math.hypot(a.x - b.x, a.y - b.y),
    center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  };
}

/** 双指捏合：起始缩放 × 当前指距 / 起始指距；指距太小（几乎重合）时不变。 */
export function pinchZoom(startZoom: number, startDistance: number, distance: number): number {
  if (!(startDistance > 8) || !(distance > 0)) return clampZoom(startZoom);
  return clampZoom(startZoom * (distance / startDistance));
}

export type PointerKind = "mouse" | "pen" | "touch";

/**
 * 单指 / 单键按下时应该做什么：
 * - 鼠标中键：任何模式都拖动平移；
 * - 查看模式（或已放大且不在编辑）下，鼠标左键 / 单指拖动平移；
 * - 编辑 / 框选 / 打卡模式下，左键 / 单指是编辑，不抢手势。
 */
export function singlePointerAction(input: {
  button: number;
  pointerType: PointerKind;
  editing: boolean;
  zoomed: boolean;
}): "pan" | "edit" | "none" {
  if (input.button === 1) return "pan";
  if (input.button !== 0) return "none";
  if (input.editing) return "edit";
  if (input.pointerType === "touch" && !input.zoomed) return "none"; // 适应屏幕时留给页面滚动
  return "pan";
}

/** 视口的 touch-action：编辑或已放大时由我们接管全部触摸手势，否则保留页面纵向滚动。 */
export function viewportTouchAction(input: { editing: boolean; zoomed: boolean }): "none" | "pan-y" {
  return input.editing || input.zoomed ? "none" : "pan-y";
}

export type TypingTarget = {
  tagName?: string;
  type?: string;
  isContentEditable?: boolean;
} | null | undefined;

const TEXT_LIKE_INPUT = new Set(["text", "search", "email", "url", "tel", "password", "number", "date", "datetime-local", "month", "time", "week"]);

/** 正在输入文字的元素：此时所有单键快捷键都不应触发。下拉框也算（方向键 / 字母用于选项）。 */
export function isTypingTarget(target: TypingTarget): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = (target.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") return TEXT_LIKE_INPUT.has((target.type ?? "text").toLowerCase());
  return false;
}

export type ToolMode = "view" | "paint" | "fill" | "pick" | "erase" | "select";

export type ShortcutAction =
  | { type: "zoomIn" }
  | { type: "zoomOut" }
  | { type: "zoomFit" }
  | { type: "tool"; mode: ToolMode }
  | { type: "toggleCodes" }
  | { type: "help" };

const TOOL_KEYS: Record<string, ToolMode> = { v: "view", b: "paint", g: "fill", i: "pick", e: "erase", m: "select" };

export type ShortcutInput = {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
  /** 事件已被别处处理（defaultPrevented） */
  handled?: boolean;
  target?: TypingTarget;
  /** 有模态对话框打开时只留给对话框 */
  modalOpen?: boolean;
  /** 当前有图纸可操作 */
  hasDesign?: boolean;
  /** 允许切换到编辑类工具（画笔、油漆桶等） */
  canEdit?: boolean;
};

/**
 * 单键快捷键解析。不会劫持浏览器组合键（Ctrl / Cmd / Alt 任一按下就不处理，
 * 浏览器自己的 Ctrl+± 页面缩放、Ctrl+0 等保持原样）。
 */
export function resolveShortcut(input: ShortcutInput): ShortcutAction | null {
  if (input.handled || input.modalOpen) return null;
  if (input.ctrlKey || input.metaKey || input.altKey) return null;
  if (isTypingTarget(input.target)) return null;
  const key = input.key;
  if (key === "?" || (key === "/" && input.shiftKey)) return input.repeat ? null : { type: "help" };
  if (!input.hasDesign) return null;
  if (key === "+" || key === "=") return { type: "zoomIn" };
  if (key === "-" || key === "_") return { type: "zoomOut" };
  if (key === "0") return { type: "zoomFit" };
  if (input.repeat) return null;
  const lower = key.length === 1 ? key.toLowerCase() : key;
  if (lower === "c" && !input.shiftKey) return { type: "toggleCodes" };
  const mode = TOOL_KEYS[lower];
  if (mode && !input.shiftKey) {
    if (mode !== "view" && !input.canEdit) return null;
    return { type: "tool", mode };
  }
  return null;
}

/** 粘贴板里第一张图片文件的下标；没有图片返回 -1。 */
export function firstImageIndex(items: ReadonlyArray<{ kind: string; type: string }>): number {
  return items.findIndex((item) => item.kind === "file" && item.type.startsWith("image/"));
}

/** 全局粘贴图片是否应接管：输入框里的普通粘贴与有对话框时不接管。 */
export function shouldHandlePasteImage(input: { target?: TypingTarget; modalOpen?: boolean; disabled?: boolean }): boolean {
  return !input.disabled && !input.modalOpen && !isTypingTarget(input.target);
}

/** 粘贴来的截图常叫 image.png：换成带时间的可读名字，避免多张同名。 */
export function pastedImageName(original: string, type: string, now: Date): string {
  if (original && original.toLowerCase() !== "image.png" && original.toLowerCase() !== "image.jpg") return original;
  const ext = type === "image/jpeg" ? "jpg" : type === "image/webp" ? "webp" : "png";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `粘贴图片-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.${ext}`;
}

export type ShortcutHelpRow = { keys: string; action: string };
export type ShortcutHelpGroup = { title: string; rows: ShortcutHelpRow[] };

export const SHORTCUT_HELP: ShortcutHelpGroup[] = [
  {
    title: "添加图片",
    rows: [
      { keys: "Ctrl + V", action: "粘贴剪贴板里的图片（截图也行）" },
      { keys: "拖放", action: "把图片拖到页面任意位置" }
    ]
  },
  {
    title: "编辑",
    rows: [
      { keys: "Ctrl + Z", action: "撤销" },
      { keys: "Ctrl + Shift + Z 或 Ctrl + Y", action: "重做" },
      { keys: "V / B / G / I / E / M", action: "查看 / 画笔 / 油漆桶 / 取色 / 擦除 / 框选" },
      { keys: "方向键 + Enter", action: "逐格移动并按当前工具操作" },
      { keys: "Delete", action: "擦除当前格或清空选区" },
      { keys: "Ctrl + C / X / V", action: "框选后复制 / 剪切 / 粘贴（在图纸上）" },
      { keys: "Esc", action: "取消选区或关闭窗口" }
    ]
  },
  {
    title: "查看",
    rows: [
      { keys: "+ / -", action: "放大 / 缩小图纸" },
      { keys: "0", action: "适应屏幕" },
      { keys: "Ctrl + 滚轮", action: "以光标位置为中心缩放" },
      { keys: "拖动 / 鼠标中键拖动", action: "平移（查看模式可直接拖；编辑时按住中键）" },
      { keys: "双指捏合 / 双指拖动", action: "手机上缩放与平移" },
      { keys: "C", action: "显示 / 隐藏格内色号" },
      { keys: "?", action: "打开本说明" }
    ]
  }
];
