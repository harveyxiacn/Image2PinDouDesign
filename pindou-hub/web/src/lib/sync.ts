// 局域网同步：本机发件箱推送到 Hub，再按游标拉取 Hub 上的新变更；图片按 SHA-256 补传/补下。
import { useSyncExternalStore } from "react";
import { ackOutbox, getSnapshot, listBlobIds, mergeRemote, putBlob, readOutbox, saveDevice, setLocalChangeHandler, getBlob, thumbIdOf } from "./db";
import { ensureThumb, ensureThumbs } from "./images";
import type { CollectionName } from "./model";

export type SyncState = {
  phase: "unpaired" | "idle" | "syncing" | "error" | "offline";
  message: string;
  lastSyncAt: number;
  hubName: string;
  /** 上一次同步实际传输的图片体积与张数（只算需要的 blob，不再每次全量） */
  lastUpBytes: number;
  lastDownBytes: number;
  lastUpBlobs: number;
  lastDownBlobs: number;
};

let state: SyncState = { phase: "unpaired", message: "", lastSyncAt: 0, hubName: "", lastUpBytes: 0, lastDownBytes: 0, lastUpBlobs: 0, lastDownBlobs: 0 };
const listeners = new Set<() => void>();
function setState(patch: Partial<SyncState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}
export function useSyncState(): SyncState {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => state, () => state);
}

export function isNativeApp(): boolean {
  return Boolean((globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.());
}

export function normalizeHubUrl(input: string): string {
  let text = input.trim();
  if (!text) return "";
  if (!/^https?:\/\//i.test(text)) text = `http://${text}`;
  const url = new URL(text);
  if (!url.port && url.protocol === "http:") url.port = "8787";
  return url.origin;
}

async function api<T>(path: string, init: RequestInit = {}, timeoutMs = 15000): Promise<T> {
  const { hubUrl, token, deviceId } = getSnapshot().device;
  if (!hubUrl) throw new Error("尚未连接 Hub");
  const response = await fetch(`${hubUrl}${path}`, {
    ...init,
    headers: { "x-pindou-token": token, "x-pindou-device": deviceId, ...(init.body && !(init.body instanceof Blob) ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (response.status === 401) {
    setState({ phase: "unpaired", message: "Hub 拒绝访问，请重新配对" });
    throw new Error("需要重新配对");
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Hub 返回 ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export async function pingHub(url: string): Promise<{ name: string; version: string } | null> {
  try {
    const response = await fetch(`${url}/api/ping`, { signal: AbortSignal.timeout(2500) });
    if (!response.ok) return null;
    const body = await response.json();
    return body.app === "pindou-hub" ? body : null;
  } catch {
    return null;
  }
}

/** 页面由 Hub 本机托管时自动连上（只有 Hub 本机能拿到令牌）。 */
export async function tryLocalAutoPair(): Promise<boolean> {
  if (isNativeApp() || typeof location === "undefined" || !/^https?:$/.test(location.protocol)) return false;
  try {
    const response = await fetch(`${location.origin}/api/local-token`, { signal: AbortSignal.timeout(2500) });
    if (!response.ok) return false;
    const body = await response.json();
    if (!body.token) return false;
    const device = getSnapshot().device;
    if (device.hubUrl !== location.origin || device.token !== body.token) {
      await saveDevice({ hubUrl: location.origin, token: body.token, cursor: device.hubUrl === location.origin ? device.cursor : 0 });
    }
    setState({ hubName: body.name ?? "", phase: "idle" });
    return true;
  } catch {
    return false;
  }
}

export async function pairWithHub(urlInput: string, code: string): Promise<string> {
  const hubUrl = normalizeHubUrl(urlInput);
  const info = await pingHub(hubUrl);
  if (!info) throw new Error(`连不上 ${hubUrl}：确认 Hub 已启动、两台设备在同一 Wi-Fi，并且电脑防火墙允许该端口`);
  const device = getSnapshot().device;
  const response = await fetch(`${hubUrl}/api/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: code.trim(), deviceId: device.deviceId, deviceName: device.deviceName }),
    signal: AbortSignal.timeout(5000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? "配对失败");
  await saveDevice({ hubUrl, token: body.token, cursor: device.hubUrl === hubUrl ? device.cursor : 0 });
  setState({ phase: "idle", hubName: body.name ?? info.name, message: "已配对" });
  void syncNow();
  return body.name ?? info.name;
}

export async function unpair(): Promise<void> {
  await saveDevice({ hubUrl: "", token: "", cursor: 0 });
  setState({ phase: "unpaired", message: "", hubName: "" });
}

type SyncResponse = {
  accepted: number;
  changes: Array<{ collection: CollectionName; id: string; data: unknown; updatedAt: number; deleted: boolean }>;
  cursor: number;
  more: boolean;
  blobsMissing: string[];
};

let running: Promise<void> | null = null;
let queued = false;
/** 本次会话里确认 Hub 没有的缩略图：避免每次同步都重复 404。 */
const thumbMiss = new Set<string>();
const remoteTried = new Set<string>();

/** 原图按需下载：本地没有时才向 Hub 要，成功就缓存进 IndexedDB。 */
export async function fetchBlobFromHub(id: string): Promise<Blob | null> {
  if (!/^[a-f0-9]{64}$/.test(id)) return null;
  const local = await getBlob(id);
  if (local) return local;
  if (remoteTried.has(id)) return null;
  const { hubUrl, token } = getSnapshot().device;
  if (!hubUrl || !token) return null;
  try {
    const response = await fetch(`${hubUrl}/api/blobs/${id}`, { headers: { "x-pindou-token": token }, signal: AbortSignal.timeout(120000) });
    if (!response.ok) { if (response.status === 404) remoteTried.add(id); return null; }
    const blob = new Blob([await response.arrayBuffer()], { type: response.headers.get("content-type") || "application/octet-stream" });
    await putBlob(id, blob);
    return blob;
  } catch {
    return null;
  }
}

export function syncNow(): Promise<void> {
  if (running) { queued = true; return running; }
  running = doSync().finally(() => {
    running = null;
    if (queued) { queued = false; void syncNow(); }
  });
  return running;
}

async function doSync(): Promise<void> {
  const device = getSnapshot().device;
  if (!device.hubUrl || !device.token) { setState({ phase: "unpaired" }); return; }
  if (typeof navigator !== "undefined" && navigator.onLine === false) { setState({ phase: "offline", message: "设备离线，恢复网络后自动同步" }); return; }
  setState({ phase: "syncing", message: "同步中…" });
  try {
    const outbox = await readOutbox();
    const localBlobs = await listBlobIds();
    let cursor = device.cursor;
    let pushed = false;
    let received = 0;
    let missing: string[] = [];
    let upBytes = 0, downBytes = 0, upBlobs = 0, downBlobs = 0;
    // 第一轮带上全部发件箱；如果 Hub 一次返回不完（more），继续空推拉取。
    for (let round = 0; round < 50; round++) {
      const changes = pushed ? [] : outbox;
      const body: SyncResponse = await api("/api/sync", {
        method: "POST",
        body: JSON.stringify({ deviceId: device.deviceId, deviceName: device.deviceName, since: cursor, changes, blobsHave: pushed ? [] : localBlobs })
      }, 60000);
      if (!pushed) { await ackOutbox(outbox); missing = body.blobsMissing; pushed = true; }
      received += await mergeRemote(body.changes);
      cursor = body.cursor;
      await saveDevice({ cursor });
      if (!body.more) break;
    }
    // 只补传 Hub 缺的图片 / 缩略图
    for (const id of missing) {
      const blob = await getBlob(id);
      if (blob) {
        await api(`/api/blobs/${id}`, { method: "PUT", body: blob }, 120000);
        upBytes += blob.size;
        upBlobs += 1;
      }
    }
    // 缩略图：本机有原图就先本地补一张；否则向 Hub 要缩略图。原图改为打开详情时按需下载。
    const have = new Set(await listBlobIds());
    const wanted = getSnapshot().images.slice(0, 200);
    for (const img of wanted) {
      try {
        if (!img.thumbId) {
          if (await ensureThumb(img.id)) { /* 新缩略图会在下一轮随发件箱上传 */ }
          continue;
        }
        if (have.has(img.thumbId) || thumbMiss.has(img.thumbId)) continue;
        const { hubUrl, token } = getSnapshot().device;
        const response = await fetch(`${hubUrl}/api/blobs/${img.thumbId}`, { headers: { "x-pindou-token": token }, signal: AbortSignal.timeout(120000) });
        if (response.ok) {
          const blob = new Blob([await response.arrayBuffer()], { type: response.headers.get("content-type") || "image/webp" });
          await putBlob(img.thumbId, blob);
          downBytes += blob.size;
          downBlobs += 1;
        } else if (response.status === 404) {
          thumbMiss.add(img.thumbId);
        }
      } catch { /* 下次再试 */ }
    }
    const now = Date.now();
    await saveDevice({ lastSyncAt: now });
    const size = (n: number) => (n === 0 ? "0 KB" : n >= 1024 * 1024 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
    setState({
      phase: "idle", lastSyncAt: now, lastUpBytes: upBytes, lastDownBytes: downBytes, lastUpBlobs: upBlobs, lastDownBlobs: downBlobs,
      message: `已同步 · 上传 ${outbox.length} 条 / ${size(upBytes)}，收到 ${received} 条 / ${size(downBytes)}`
    });
  } catch (error) {
    if (state.phase !== "unpaired") setState({ phase: "error", message: error instanceof Error ? error.message : "同步失败" });
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
let debounce: ReturnType<typeof setTimeout> | null = null;

export function startAutoSync(): void {
  const device = getSnapshot().device;
  setState({ phase: device.hubUrl && device.token ? "idle" : "unpaired", lastSyncAt: device.lastSyncAt });
  setLocalChangeHandler(() => {
    if (!getSnapshot().device.autoSync) return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => void syncNow(), 2500);
  });
  if (timer) clearInterval(timer);
  timer = setInterval(() => { if (getSnapshot().device.autoSync) void syncNow(); }, 60_000);
  if (typeof window !== "undefined") {
    window.addEventListener("online", () => void syncNow());
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && getSnapshot().device.autoSync) void syncNow(); });
  }
  // 老图库升级：本机有原图但没缩略图的，补一张后再同步，别的设备就能只拉小图。
  void ensureThumbs().then((made) => { if (made) void syncNow(); });
  void syncNow();
}

export async function hubInfo(): Promise<{ name: string; addresses: Array<{ name: string; url: string }>; stats: { devices: Array<{ id: string; name: string; lastSeen: number }> }; ai: { available: boolean; model: string; reason?: string } } | null> {
  try { return await api("/api/info"); } catch { return null; }
}

export async function localPairInfo(): Promise<{ pairCode: string; addresses: Array<{ name: string; url: string }> } | null> {
  if (isNativeApp()) return null;
  try {
    const response = await fetch(`${location.origin}/api/local-token`, { signal: AbortSignal.timeout(2000) });
    return response.ok ? response.json() : null;
  } catch { return null; }
}

export async function aiVision(imageBase64: string, hint: string): Promise<{ result: { counts?: Record<string, number>; notes?: string; grid?: { width?: number; height?: number } } | null; model: string; raw?: string }> {
  return api("/api/ai/vision", { method: "POST", body: JSON.stringify({ imageBase64, hint }) }, 200000);
}
