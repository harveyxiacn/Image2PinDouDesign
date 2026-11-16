// 快速核对会话的 sessionStorage 读写（本标签页内有效；关掉标签页就是新一轮）。
import { newSession, parseSession, serializeSession, type QueueOrder, type Session } from "./verifyQueue";

const KEY = "pindou.verify.session";

export function loadSession(): Session | null {
  try { return parseSession(sessionStorage.getItem(KEY)); } catch { return null; }
}
export function saveSession(s: Session): void {
  try { sessionStorage.setItem(KEY, serializeSession(s)); } catch { /* 无痕模式等：不记住也能用 */ }
}
/** 从图库进入：开一轮新的会话；scope 为空 = 全部未核对。 */
export function startVerify(scope: string[] | null, order: QueueOrder = "confidence"): void {
  saveSession(newSession(order, scope));
}
