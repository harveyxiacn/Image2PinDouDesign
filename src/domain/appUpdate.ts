// 新版本提示：Service Worker 发现新版本后不再静默接管（否则用户会一直看到旧界面），
// 而是登记一个“立即更新”的动作，由界面询问用户后再刷新。
type Listener = () => void;

let applyUpdate: (() => Promise<void> | void) | null = null;
const listeners = new Set<Listener>();

export function announceUpdate(apply: () => Promise<void> | void): void {
  applyUpdate = apply;
  for (const listener of listeners) listener();
}

export function isUpdateReady(): boolean {
  return applyUpdate !== null;
}

export function subscribeUpdate(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function applyPendingUpdate(): Promise<void> {
  const apply = applyUpdate;
  if (!apply) return;
  await apply();
}

/** 仅供测试：清空状态。 */
export function resetUpdateState(): void {
  applyUpdate = null;
  listeners.clear();
}
