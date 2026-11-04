// 本地优先存储：所有数据先写进本机 IndexedDB（浏览器 / Android WebView 都支持），
// 再由 sync.ts 与局域网 Hub 合并。界面通过 useData() 订阅内存快照。
import { useSyncExternalStore } from "react";
import {
  DEFAULT_PREFS,
  type CollectionName,
  type DeviceSettings,
  type ImageMeta,
  type Pattern,
  type RecordOf,
  type SharedPrefs,
  type Txn,
  uid
} from "./model";

const DB_NAME = "pindou-hub";
const DB_VERSION = 1;
const COLLECTIONS: CollectionName[] = ["patterns", "txns", "images", "prefs"];

export type Snapshot = {
  ready: boolean;
  patterns: Pattern[];
  txns: Txn[];
  images: ImageMeta[];
  prefs: SharedPrefs;
  device: DeviceSettings;
  outbox: number;
};

type OutboxEntry = { key: string; collection: CollectionName; id: string; updatedAt: number };

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of COLLECTIONS) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("blobs")) db.createObjectStore("blobs");
      if (!db.objectStoreNames.contains("outbox")) db.createObjectStore("outbox", { keyPath: "key" });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("无法打开本地数据库"));
  });
  return dbPromise;
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("事务中止"));
  });
}

// ---------- in-memory snapshot + subscription ----------
function defaultDevice(): DeviceSettings {
  return {
    deviceId: uid("d"),
    deviceName: guessDeviceName(),
    hubUrl: "",
    token: "",
    cursor: 0,
    lastSyncAt: 0,
    autoSync: true
  };
}

function guessDeviceName(): string {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (/Android/i.test(ua)) return "Android 手机";
  if (/iPhone|iPad/i.test(ua)) return "iPhone / iPad";
  if (/Windows/i.test(ua)) return "Windows 电脑";
  if (/Mac/i.test(ua)) return "Mac";
  return "此设备";
}

let snapshot: Snapshot = {
  ready: false,
  patterns: [],
  txns: [],
  images: [],
  prefs: DEFAULT_PREFS,
  device: defaultDevice(),
  outbox: 0
};
const listeners = new Set<() => void>();

function emit(next: Partial<Snapshot>) {
  snapshot = { ...snapshot, ...next };
  for (const listener of listeners) listener();
}

export function getSnapshot(): Snapshot {
  return snapshot;
}

export function useData(): Snapshot {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    getSnapshot,
    getSnapshot
  );
}

function sortPatterns(list: Pattern[]): Pattern[] {
  return list.filter((p) => !p.deleted).sort((a, b) => b.updatedAt - a.updatedAt);
}
function sortTxns(list: Txn[]): Txn[] {
  return list.filter((t) => !t.deleted).sort((a, b) => b.at - a.at);
}
function sortImages(list: ImageMeta[]): ImageMeta[] {
  return list.filter((i) => !i.deleted).sort((a, b) => b.createdAt - a.createdAt);
}

// 带墓碑的完整记录（同步与合并要用），界面快照里只放未删除的。
const raw: { [C in CollectionName]: Map<string, RecordOf<C>> } = {
  patterns: new Map(),
  txns: new Map(),
  images: new Map(),
  prefs: new Map()
};

function publish(collections: CollectionName[]) {
  const next: Partial<Snapshot> = {};
  if (collections.includes("patterns")) next.patterns = sortPatterns([...raw.patterns.values()]);
  if (collections.includes("txns")) next.txns = sortTxns([...raw.txns.values()]);
  if (collections.includes("images")) next.images = sortImages([...raw.images.values()]);
  if (collections.includes("prefs")) {
    const prefs = raw.prefs.get("shared");
    next.prefs = prefs && !prefs.deleted ? { ...DEFAULT_PREFS, ...prefs } : DEFAULT_PREFS;
  }
  emit(next);
}

export async function initDb(): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([...COLLECTIONS, "meta", "outbox"], "readonly");
  const results = await Promise.all(COLLECTIONS.map((name) => promisify(tx.objectStore(name).getAll())));
  const device = (await promisify(tx.objectStore("meta").get("device"))) as DeviceSettings | undefined;
  const outbox = await promisify(tx.objectStore("outbox").count());
  COLLECTIONS.forEach((name, index) => {
    const map = raw[name] as Map<string, unknown>;
    map.clear();
    for (const record of results[index] as Array<{ id: string }>) map.set(record.id, record);
  });
  const resolvedDevice = { ...defaultDevice(), ...(device ?? {}) };
  if (!device) await saveDevice(resolvedDevice);
  publish(COLLECTIONS);
  emit({ ready: true, device: resolvedDevice, outbox });
}

export async function saveDevice(patch: Partial<DeviceSettings>): Promise<DeviceSettings> {
  const next = { ...snapshot.device, ...patch };
  const db = await openDb();
  const tx = db.transaction("meta", "readwrite");
  tx.objectStore("meta").put(next, "device");
  await done(tx);
  emit({ device: next });
  return next;
}

/** 本地写入：保存记录并登记到发件箱，等待同步。 */
export async function putRecords<C extends CollectionName>(collection: C, records: Array<RecordOf<C>>): Promise<void> {
  if (!records.length) return;
  const db = await openDb();
  const tx = db.transaction([collection, "outbox"], "readwrite");
  for (const record of records) {
    tx.objectStore(collection).put(record);
    const entry: OutboxEntry = { key: `${collection}/${record.id}`, collection, id: record.id, updatedAt: record.updatedAt };
    tx.objectStore("outbox").put(entry);
    (raw[collection] as Map<string, RecordOf<C>>).set(record.id, record);
  }
  const count = promisify(tx.objectStore("outbox").count());
  await done(tx);
  publish([collection]);
  emit({ outbox: await count });
  notifyLocalChange();
}

export async function softDelete(collection: CollectionName, ids: string[]): Promise<void> {
  const now = Date.now();
  const records = ids
    .map((id) => (raw[collection] as Map<string, { id: string; updatedAt: number }>).get(id))
    .filter((r): r is NonNullable<typeof r> => Boolean(r))
    .map((r) => ({ ...r, deleted: true, updatedAt: Math.max(now, r.updatedAt + 1) }));
  await putRecords(collection, records as never);
}

/** 合并来自 Hub 的记录：只接受比本地新的版本；不进发件箱。 */
export async function mergeRemote(changes: Array<{ collection: CollectionName; id: string; data: unknown; updatedAt: number; deleted: boolean }>): Promise<number> {
  if (!changes.length) return 0;
  const db = await openDb();
  const touched = new Set<CollectionName>();
  const tx = db.transaction([...COLLECTIONS], "readwrite");
  let applied = 0;
  for (const change of changes) {
    if (!COLLECTIONS.includes(change.collection)) continue;
    const map = raw[change.collection] as Map<string, { updatedAt: number }>;
    const local = map.get(change.id);
    if (local && local.updatedAt >= change.updatedAt) continue;
    const record = { ...(change.data as object), id: change.id, updatedAt: change.updatedAt, deleted: change.deleted || undefined };
    tx.objectStore(change.collection).put(record);
    map.set(change.id, record as never);
    touched.add(change.collection);
    applied += 1;
  }
  await done(tx);
  publish([...touched]);
  return applied;
}

export async function readOutbox(): Promise<Array<{ collection: CollectionName; id: string; data: unknown; updatedAt: number; deleted: boolean }>> {
  const db = await openDb();
  const tx = db.transaction("outbox", "readonly");
  const entries = (await promisify(tx.objectStore("outbox").getAll())) as OutboxEntry[];
  return entries.flatMap((entry) => {
    const record = (raw[entry.collection] as Map<string, { id: string; updatedAt: number; deleted?: boolean }>).get(entry.id);
    if (!record) return [];
    const { deleted, ...data } = record;
    return [{ collection: entry.collection, id: entry.id, data, updatedAt: record.updatedAt, deleted: Boolean(deleted) }];
  });
}

/** 同步成功后清掉已送达的发件箱项（期间又被修改过的保留到下一轮）。 */
export async function ackOutbox(sent: Array<{ collection: CollectionName; id: string; updatedAt: number }>): Promise<void> {
  const db = await openDb();
  const tx = db.transaction("outbox", "readwrite");
  const store = tx.objectStore("outbox");
  for (const item of sent) {
    const current = (raw[item.collection] as Map<string, { updatedAt: number }>).get(item.id);
    if (!current || current.updatedAt === item.updatedAt) store.delete(`${item.collection}/${item.id}`);
  }
  const count = promisify(store.count());
  await done(tx);
  emit({ outbox: await count });
}

// ---------- blobs (images) ----------
export async function putBlob(id: string, blob: Blob): Promise<void> {
  const db = await openDb();
  const tx = db.transaction("blobs", "readwrite");
  tx.objectStore("blobs").put(blob, id);
  await done(tx);
  blobUrlCache.delete(id);
  for (const listener of blobListeners) listener(id);
}

export async function getBlob(id: string): Promise<Blob | undefined> {
  const db = await openDb();
  const tx = db.transaction("blobs", "readonly");
  return (await promisify(tx.objectStore("blobs").get(id))) as Blob | undefined;
}

export async function listBlobIds(): Promise<string[]> {
  const db = await openDb();
  const tx = db.transaction("blobs", "readonly");
  return (await promisify(tx.objectStore("blobs").getAllKeys())) as string[];
}

const blobUrlCache = new Map<string, string>();
const blobListeners = new Set<(id: string) => void>();
export function onBlobAdded(listener: (id: string) => void): () => void {
  blobListeners.add(listener);
  return () => blobListeners.delete(listener);
}

export async function blobUrl(id: string): Promise<string | null> {
  const cached = blobUrlCache.get(id);
  if (cached) return cached;
  const blob = await getBlob(id);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  blobUrlCache.set(id, url);
  return url;
}

// ---------- local-change hook for auto sync ----------
let localChangeHandler: (() => void) | null = null;
export function setLocalChangeHandler(handler: (() => void) | null) {
  localChangeHandler = handler;
}
function notifyLocalChange() {
  localChangeHandler?.();
}

/** 整机备份：导出全部记录（含图片元数据，不含图片本体）。 */
export function exportRecords() {
  return COLLECTIONS.flatMap((collection) =>
    [...(raw[collection] as Map<string, { id: string; updatedAt: number; deleted?: boolean }>).values()]
      .map((record) => ({ collection, id: record.id, data: record, updatedAt: record.updatedAt, deleted: Boolean(record.deleted) })));
}
