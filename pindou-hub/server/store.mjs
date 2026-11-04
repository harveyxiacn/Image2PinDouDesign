// 拼豆仓 Hub 的同步存储：一张 records 表承载所有集合（图纸 / 库存流水 / 图片元数据 / 共享设置）。
// 冲突规则：按记录 updatedAt 后写者胜（同一毫秒按设备 id 字典序决胜），删除是带时间戳的墓碑，
// 因此任意顺序、任意次数重放同一批变更都会收敛到同一结果。
// 库存本身是“流水账”（每次入库/消耗/盘点各是一条记录），多台设备离线各记各的也不会互相覆盖。
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

export const COLLECTIONS = new Set(["patterns", "txns", "images", "prefs"]);
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

export function openStore(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "hub.db"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS records (
      collection TEXT NOT NULL,
      id TEXT NOT NULL,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0,
      device TEXT NOT NULL DEFAULT '',
      seq INTEGER NOT NULL,
      PRIMARY KEY (collection, id)
    );
    CREATE INDEX IF NOT EXISTS records_seq ON records(seq);
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      last_seen INTEGER NOT NULL
    );
  `);

  const selectOne = db.prepare("SELECT updated_at, device FROM records WHERE collection = ? AND id = ?");
  const upsert = db.prepare(`
    INSERT INTO records (collection, id, data, updated_at, deleted, device, seq)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(collection, id) DO UPDATE SET
      data = excluded.data, updated_at = excluded.updated_at, deleted = excluded.deleted,
      device = excluded.device, seq = excluded.seq
  `);
  const maxSeq = db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM records");
  const since = db.prepare("SELECT collection, id, data, updated_at, deleted, device, seq FROM records WHERE seq > ? ORDER BY seq LIMIT ?");
  const touchDevice = db.prepare(`
    INSERT INTO devices (id, name, last_seen) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, last_seen = excluded.last_seen
  `);

  function wins(incoming, existing) {
    if (!existing) return true;
    if (incoming.updatedAt !== existing.updated_at) return incoming.updatedAt > existing.updated_at;
    return String(incoming.device) > String(existing.device);
  }

  /** 应用一批来自设备的变更，返回实际被接受的条数。非法记录直接丢弃，不影响整批。 */
  function applyChanges(changes, device) {
    let accepted = 0;
    let seq = Number(maxSeq.get().seq);
    db.exec("BEGIN");
    try {
      for (const change of changes) {
        if (!isValidChange(change)) continue;
        const existing = selectOne.get(change.collection, change.id);
        const incoming = { updatedAt: Math.trunc(change.updatedAt), device };
        if (!wins(incoming, existing)) continue;
        seq += 1;
        const data = JSON.stringify(change.data ?? {});
        upsert.run(change.collection, change.id, data, incoming.updatedAt, change.deleted ? 1 : 0, device, seq);
        accepted += 1;
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return accepted;
  }

  function changesSince(cursor, limit = 2000) {
    const rows = since.all(Math.max(0, Math.trunc(Number(cursor) || 0)), limit);
    return {
      changes: rows.map((row) => ({
        collection: row.collection,
        id: row.id,
        data: JSON.parse(row.data),
        updatedAt: Number(row.updated_at),
        deleted: Boolean(row.deleted),
        device: row.device
      })),
      cursor: rows.length ? Number(rows[rows.length - 1].seq) : Math.max(0, Math.trunc(Number(cursor) || 0)),
      more: rows.length === limit
    };
  }

  function referencedBlobIds() {
    const rows = db.prepare("SELECT id FROM records WHERE collection = 'images' AND deleted = 0").all();
    return rows.map((row) => row.id);
  }

  function stats() {
    const rows = db.prepare("SELECT collection, COUNT(*) AS n FROM records WHERE deleted = 0 GROUP BY collection").all();
    const devices = db.prepare("SELECT id, name, last_seen FROM devices ORDER BY last_seen DESC LIMIT 20").all();
    return {
      collections: Object.fromEntries(rows.map((row) => [row.collection, Number(row.n)])),
      devices: devices.map((d) => ({ id: d.id, name: d.name, lastSeen: Number(d.last_seen) })),
      cursor: Number(maxSeq.get().seq)
    };
  }

  function exportAll() {
    return db.prepare("SELECT collection, id, data, updated_at, deleted FROM records ORDER BY seq").all()
      .map((row) => ({ collection: row.collection, id: row.id, data: JSON.parse(row.data), updatedAt: Number(row.updated_at), deleted: Boolean(row.deleted) }));
  }

  return {
    applyChanges,
    changesSince,
    referencedBlobIds,
    stats,
    exportAll,
    touchDevice: (id, name) => touchDevice.run(String(id).slice(0, 80), String(name ?? "").slice(0, 80), Date.now()),
    close: () => db.close()
  };
}

export function isValidChange(change) {
  return Boolean(change)
    && COLLECTIONS.has(change.collection)
    && typeof change.id === "string" && ID_RE.test(change.id)
    && Number.isFinite(change.updatedAt) && change.updatedAt > 0
    && (change.data === undefined || (typeof change.data === "object" && change.data !== null));
}
