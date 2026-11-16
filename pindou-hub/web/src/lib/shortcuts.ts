// 键盘快捷键的纯判断逻辑（不碰 DOM，可单测）。组件只负责把事件翻译成 KeyLike / TargetLike，再按返回的动作执行。
// 规则：输入框里打字、输入法组字、浏览器自己的组合键（Ctrl/⌘/Alt + 字母，撤销重做除外）一律不触发。

export type KeyLike = {
  key: string;
  ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean;
  repeat?: boolean; isComposing?: boolean; defaultPrevented?: boolean;
};
export type TargetLike = { tagName?: string; type?: string; isContentEditable?: boolean } | null | undefined;

const TEXT_INPUT_TYPES = new Set(["", "text", "search", "number", "email", "url", "tel", "password", "date", "time", "datetime-local", "month", "week"]);

/** 正在输入文字的控件：这时所有字母 / 数字 / 空格快捷键都应让给输入。 */
export function isTypingTarget(t: TargetLike): boolean {
  if (!t) return false;
  if (t.isContentEditable) return true;
  const tag = (t.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") return TEXT_INPUT_TYPES.has((t.type ?? "").toLowerCase());
  return false;
}
/** 按钮 / 链接：Enter 与空格是它们自己的“点击”，快捷键不要抢。 */
export function isActivatable(t: TargetLike): boolean {
  const tag = (t?.tagName ?? "").toUpperCase();
  return tag === "BUTTON" || tag === "A" || (tag === "INPUT" && !isTypingTarget(t));
}

const isMod = (e: KeyLike) => !!(e.ctrlKey || e.metaKey);
/** 不带 Ctrl/⌘/Alt、不在输入法组字、没被别人处理过的按键；Shift 允许（? 需要）。返回小写 key，否则 null。 */
export function plainKey(e: KeyLike, t?: TargetLike): string | null {
  if (e.isComposing || e.defaultPrevented || e.key === "Process") return null;
  if (isMod(e) || e.altKey) return null;
  if (isTypingTarget(t)) return null;
  return e.key.length === 1 ? e.key.toLowerCase() : e.key;
}

// ---------- 全局：/ 搜索，? 帮助，g 然后字母 跳页 ----------
export const GO_TO: Record<string, { href: string; label: string }> = {
  h: { href: "#/", label: "总览" },
  g: { href: "#/gallery", label: "图库" },
  i: { href: "#/inventory", label: "豆盒库存" },
  s: { href: "#/shopping", label: "采购清单" },
  p: { href: "#/purchase", label: "采购方案" },
  c: { href: "#/insights", label: "数据洞察" },
  r: { href: "#/history", label: "记录" },
  a: { href: "#/add", label: "添加图纸" },
  ",": { href: "#/settings", label: "同步与设置" }
};

export type GlobalAction =
  | { type: "focusSearch" }
  | { type: "help" }
  | { type: "goto"; href: string }
  | null;

/** pendingG：上一个按键是不是单独的 g（两键组合 g→h 之类）。返回新的 pendingG。 */
export function globalKey(e: KeyLike, t: TargetLike, pendingG: boolean): { action: GlobalAction; pendingG: boolean } {
  const k = plainKey(e, t);
  if (k === null || e.repeat) return { action: null, pendingG: false };
  if (pendingG) {
    const to = GO_TO[k];
    if (to && !e.shiftKey) return { action: { type: "goto", href: to.href }, pendingG: false };
    // 不是有效第二键：丢弃组合，但这个键本身继续当作新按键处理
  }
  if (k === "/" && !e.shiftKey) return { action: { type: "focusSearch" }, pendingG: false };
  if (k === "?") return { action: { type: "help" }, pendingG: false };
  if (k === "g" && !e.shiftKey && !isActivatable(t)) return { action: null, pendingG: true };
  return { action: null, pendingG: false };
}

// ---------- 格子编辑器 ----------
export type EditorTool = "eraser" | "brush" | "pick" | "pan";
export type EditorAction =
  | { type: "undo" } | { type: "redo" }
  | { type: "tool"; tool: EditorTool }
  | { type: "size"; size: 1 | 2 | 3 }
  | { type: "color"; dir: 1 | -1 }
  | null;

const EDITOR_TOOLS: Record<string, EditorTool> = { e: "eraser", b: "brush", i: "pick", h: "pan" };

export function editorKey(e: KeyLike, t: TargetLike): EditorAction {
  if (e.isComposing || e.defaultPrevented || isTypingTarget(t) || e.altKey) return null;
  const k = e.key.toLowerCase();
  if (isMod(e)) {
    if (k === "z") return e.shiftKey ? { type: "redo" } : { type: "undo" };
    if (k === "y" && !e.shiftKey) return { type: "redo" };
    return null;
  }
  if (e.repeat && !(k === "[" || k === "]")) return null;
  if (EDITOR_TOOLS[k]) return { type: "tool", tool: EDITOR_TOOLS[k] };
  if (k === "1" || k === "2" || k === "3") return { type: "size", size: Number(k) as 1 | 2 | 3 };
  if (k === "[") return { type: "color", dir: -1 };
  if (k === "]") return { type: "color", dir: 1 };
  return null;
}

/** 在已用色号里循环切换画笔色。current 不在列表里时：往后从头、往前从尾。 */
export function cycleCode(list: readonly string[], current: string | null, dir: 1 | -1): string | null {
  if (!list.length) return null;
  const i = current === null ? -1 : list.indexOf(current);
  if (i < 0) return dir === 1 ? list[0] : list[list.length - 1];
  return list[(i + dir + list.length) % list.length];
}

// ---------- 拼装模式 ----------
export type BuildAction =
  | { type: "color"; dir: 1 | -1 }
  | { type: "board"; dir: 1 | -1 }
  | { type: "finish" }
  | { type: "toggleRow" }
  | { type: "row"; dir: 1 | -1 }
  | { type: "undo" }
  | { type: "openMap" }
  | { type: "zoom"; by: "in" | "out" | "fit" }
  | null;

/** rowMode：按行模式下 ↑/↓ 换行。弹层打开时由调用方整体跳过。 */
export function buildKey(e: KeyLike, t: TargetLike, rowMode: boolean): BuildAction {
  if (e.isComposing || e.defaultPrevented || isTypingTarget(t) || e.altKey) return null;
  const k = e.key.toLowerCase();
  if (isMod(e)) return k === "z" && !e.shiftKey ? { type: "undo" } : null;
  const onButton = isActivatable(t);
  if (k === "arrowleft") return { type: "color", dir: -1 };
  if (k === "arrowright") return { type: "color", dir: 1 };
  if (k === "enter" || k === " ") return onButton ? null : e.repeat ? null : { type: "finish" };
  if (e.repeat) return null;
  if (k === "r") return { type: "toggleRow" };
  if (k === "z" || k === "u") return { type: "undo" };
  if (k === "[" || k === "pageup") return { type: "board", dir: -1 };
  if (k === "]" || k === "pagedown") return { type: "board", dir: 1 };
  if (k === "m" || k === "b") return { type: "openMap" };
  if (rowMode && k === "arrowup") return { type: "row", dir: -1 };
  if (rowMode && k === "arrowdown") return { type: "row", dir: 1 };
  if (k === "+" || k === "=") return { type: "zoom", by: "in" };
  if (k === "-" || k === "_") return { type: "zoom", by: "out" };
  if (k === "0") return { type: "zoom", by: "fit" };
  return null;
}

// ---------- 帮助面板内容（单一来源，帮助面板直接渲染它） ----------
export type ShortcutGroup = { id: "global" | "editor" | "build" | "view" | "sheet"; title: string; rows: { keys: string[]; desc: string }[] };
export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  { id: "global", title: "任何页面", rows: [
    { keys: ["/"], desc: "跳到搜索框（当前页没有搜索框时去图库搜索）" },
    { keys: ["?"], desc: "打开这份快捷键清单" },
    { keys: ["g 然后字母"], desc: "跳页：h 总览 · g 图库 · i 库存 · s 采购清单 · p 采购方案 · c 洞察 · r 记录 · a 添加 · , 设置" },
    { keys: ["Esc"], desc: "关闭最上面的弹层，焦点回到打开它的按钮" }
  ] },
  { id: "editor", title: "图库 · 改格子", rows: [
    { keys: ["E", "B", "I", "H"], desc: "橡皮 / 画笔 / 取色 / 移动" },
    { keys: ["1", "2", "3"], desc: "笔刷 1×1 / 2×2 / 3×3" },
    { keys: ["[", "]"], desc: "上一个 / 下一个画笔色" },
    { keys: ["Ctrl+Z", "Ctrl+Shift+Z"], desc: "撤销 / 重做（Mac 用 ⌘；Ctrl+Y 也是重做）" },
    { keys: ["空格 + 拖动", "鼠标中键拖动"], desc: "临时平移，不画格子" },
    { keys: ["Ctrl + 滚轮"], desc: "以鼠标位置为中心缩放" }
  ] },
  { id: "build", title: "拼装模式", rows: [
    { keys: ["←", "→"], desc: "上一色 / 下一色" },
    { keys: ["Enter", "空格"], desc: "这色拼完，进入下一色" },
    { keys: ["Z", "Ctrl+Z"], desc: "撤销上一步" },
    { keys: ["[", "]"], desc: "上一块 / 下一块板" },
    { keys: ["B"], desc: "打开拼板选择" },
    { keys: ["R", "↑", "↓"], desc: "切换按行拼；按行时 ↑ ↓ 换行" },
    { keys: ["+", "−", "0"], desc: "棋盘放大 / 缩小 / 适合屏幕；滚轮以鼠标位置缩放" }
  ] },
  { id: "view", title: "图片 / 图纸查看", rows: [
    { keys: ["+", "−"], desc: "缩放（先点一下图）" },
    { keys: ["0", "Esc"], desc: "适应窗口" },
    { keys: ["1"], desc: "实际像素" },
    { keys: ["方向键"], desc: "平移" }
  ] }
];

/** 打开帮助时把当前页最相关的一组排到最前。route：路由首段（如 "pattern" / "build"）。 */
export function groupsForRoute(head: string | undefined): ShortcutGroup[] {
  const first = head === "build" ? "build" : head === "pattern" ? "editor" : null;
  if (!first) return SHORTCUT_GROUPS;
  return [...SHORTCUT_GROUPS].sort((a, b) => (a.id === first ? -1 : b.id === first ? 1 : 0));
}
