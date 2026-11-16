// 局域网同步：本机发件箱推送到 Hub，再按游标拉取 Hub 上的新变更；图片按 SHA-256 补传/补下。
import { useSyncExternalStore } from "react";
import { ackOutbox, getSnapshot, getSyncMeta, listBlobIds, mergeRemote, putBlob, readOutbox, requeueAll, saveDevice, saveSyncMeta, setLocalChangeHandler, getBlob } from "./db";
import { ensureThumb, ensureThumbs, sha256Hex } from "./images";
import { decideCursor, estimateSkew, hashMatches, planChunks } from "./syncPlan";
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
  /** 新版 Hub 才有：Hub 当前时间、数据库标识、最大序号。老 Hub 没有这三项，客户端照旧工作。 */
  serverTime?: number;
  epoch?: string;
  maxSeq?: number;
};

let running: Promise<void> | null = null;
let queued = false;
/** 本次会话里确认 Hub 没有的缩略图：避免每次同步都重复 404。 */
const thumbMiss = new Set<string>();
const remoteTried = new Set<string>();

/** 从 Hub 下载一个 blob 并校验 SHA-256（blob id 就是内容哈希）。哈希对不上就重试一次，仍不对则拒绝（返回 bad）。 */
async function downloadChecked(id: string, fallbackType: string): Promise<{ blob: Blob | null; status: number; bad: boolean }> {
  const { hubUrl, token } = getSnapshot().device;
  let status = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(`${hubUrl}/api/blobs/${id}`, { headers: { "x-pindou-token": token }, signal: AbortSignal.timeout(120000) });
    status = response.status;
    if (!response.ok) return { blob: null, status, bad: false };
    const buffer = await response.arrayBuffer();
    if (hashMatches(id, await sha256Hex(buffer))) {
      return { blob: new Blob([buffer], { type: response.headers.get("content-type") || fallbackType }), status, bad: false };
    }
  }
  return { blob: null, status, bad: true };
}

/** 原图按需下载：本地没有时才向 Hub 要，成功就缓存进 IndexedDB。 */
export async function fetchBlobFromHub(id: string): Promise<Blob | null> {
  if (!/^[a-f0-9]{64}$/.test(id)) return null;
  const local = await getBlob(id);
  if (local) return local;
  if (remoteTried.has(id)) return null;
  const { hubUrl, token } = getSnapshot().device;
  if (!hubUrl || !token) return null;
  try {
    const got = await downloadChecked(id, "application/octet-stream");
    if (!got.blob) { if (got.status === 404 || got.bad) remoteTried.add(id); return null; }
    await putBlob(id, got.blob);
    return got.blob;
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
    let outbox = await readOutbox();
    const localBlobs = await listBlobIds();
    let cursor = device.cursor;
    let received = 0;
    let missing: string[] = [];
    let upBytes = 0, downBytes = 0, upBlobs = 0, downBlobs = 0;
    let total = outbox.length;
    let sentCount = 0;
    let queue = planChunks(outbox);
    let blobsReported = false;
    let resets = 0;
    // 发件箱按批发送（每批 ≤ 约 2 MB），每批成功后立刻确认；中途失败时已确认的不会重发，下次从断点继续。
    // 发完后继续空推拉取，直到 Hub 说没有更多。
    for (let round = 0; round < 2000; round++) {
      const chunk = queue.shift() ?? [];
      const sentAt = Date.now();
      let body: SyncResponse;
      try {
        body = await api("/api/sync", {
          method: "POST",
          body: JSON.stringify({ deviceId: device.deviceId, deviceName: device.deviceName, since: cursor, changes: chunk, blobsHave: blobsReported ? [] : localBlobs })
        }, 60000);
      } catch (error) {
        if (sentCount > 0 && state.phase !== "unpaired") {
          throw new Error(`${error instanceof Error ? error.message : "同步失败"}（已送达 ${sentCount}/${total} 条，下次从断点继续）`);
        }
        throw error;
      }
      const skew = estimateSkew(sentAt, Date.now(), body.serverTime);
      if (skew !== null) await saveSyncMeta({ skew });
      // Hub 数据库被恢复成旧备份或被换掉：游标已经没有意义。重置游标并把本机全部记录重新放进发件箱，
      // 之后按“后写者胜”双向合并，两边都不会丢数据。
      const meta = getSyncMeta();
      const decision = decideCursor({ localCursor: cursor, localEpoch: meta.epoch, hubEpoch: body.epoch, hubMaxSeq: body.maxSeq });
      if (typeof body.epoch === "string" && body.epoch && body.epoch !== meta.epoch) await saveSyncMeta({ epoch: body.epoch });
      if (decision.action === "reset" && resets === 0) {
        resets += 1;
        cursor = 0;
        await saveDevice({ cursor: 0 });
        await requeueAll();
        outbox = await readOutbox();
        total = outbox.length;
        sentCount = 0;
        queue = planChunks(outbox);
        blobsReported = false;
        setState({ message: "Hub 数据库已变化，正在重新对账…" });
        continue;
      }
      if (!blobsReported) { missing = body.blobsMissing ?? []; blobsReported = true; }
      if (chunk.length) {
        await ackOutbox(chunk);
        sentCount += chunk.length;
      }
      received += await mergeRemote(body.changes);
      cursor = body.cursor;
      await saveDevice({ cursor });
      if (queue.length) setState({ message: `同步中… 已上传 ${sentCount}/${total} 条` });
      if (!queue.length && !body.more) break;
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
        const got = await downloadChecked(img.thumbId, "image/webp");
        if (got.blob) {
          await putBlob(img.thumbId, got.blob);
          downBytes += got.blob.size;
          downBlobs += 1;
        } else if (got.status === 404 || got.bad) {
          thumbMiss.add(img.thumbId); // 404 或哈希不符：本次会话不再重复尝试，也不保存可疑内容
        }
      } catch { /* 下次再试 */ }
    }
    const now = Date.now();
    await saveDevice({ lastSyncAt: now });
    const size = (n: number) => (n === 0 ? "0 KB" : n >= 1024 * 1024 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
    setState({
      phase: "idle", lastSyncAt: now, lastUpBytes: upBytes, lastDownBytes: downBytes, lastUpBlobs: upBlobs, lastDownBlobs: downBlobs,
      message: `已同步 · 上传 ${sentCount} 条 / ${size(upBytes)}，收到 ${received} 条 / ${size(downBytes)}`
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
