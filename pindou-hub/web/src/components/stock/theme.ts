// 外观偏好：跟随系统 / 浅色 / 深色，存在 localStorage（读写都 try/catch）。
export type ThemePref = "system" | "light" | "dark";
const KEY = "pindou-theme";

export function readTheme(): ThemePref {
  try { const v = localStorage.getItem(KEY); return v === "light" || v === "dark" ? v : "system"; } catch { return "system"; }
}
export function applyTheme(pref: ThemePref): void {
  if (pref === "system") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = pref;
}
export function saveTheme(pref: ThemePref): void {
  applyTheme(pref);
  try { if (pref === "system") localStorage.removeItem(KEY); else localStorage.setItem(KEY, pref); } catch { /* 隐私模式 */ }
}
/** 启动时调用一次即可恢复上次选择。 */
export function applyStoredTheme(): void { applyTheme(readTheme()); }
