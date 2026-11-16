import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "./store.mjs";

function withStore(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pindou-hub-test-"));
  const store = openStore(dir);
  try { fn(store); } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
}

test("last writer wins and replays converge", () => {
  withStore((store) => {
    const older = { collection: "patterns", id: "p1", updatedAt: 100, data: { name: "旧" } };
    const newer = { collection: "patterns", id: "p1", updatedAt: 200, data: { name: "新" } };
    assert.equal(store.applyChanges([newer], "phone"), 1);
    assert.equal(store.applyChanges([older], "pc"), 0, "older edit must not overwrite");
    assert.equal(store.applyChanges([newer], "phone"), 0, "replay is idempotent");
    const { changes } = store.changesSince(0);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].data.name, "新");
  });
});

test("tombstones replicate and cursor advances", () => {
  withStore((store) => {
    store.applyChanges([{ collection: "txns", id: "t1", updatedAt: 10, data: { code: "A1", delta: 500 } }], "pc");
    const first = store.changesSince(0);
    store.applyChanges([{ collection: "txns", id: "t1", updatedAt: 20, deleted: true, data: {} }], "phone");
    const next = store.changesSince(first.cursor);
    assert.equal(next.changes.length, 1);
    assert.equal(next.changes[0].deleted, true);
    assert.ok(next.cursor > first.cursor);
  });
});

test("invalid records are dropped without failing the batch", () => {
  withStore((store) => {
    const accepted = store.applyChanges([
      { collection: "evil", id: "x", updatedAt: 1, data: {} },
      { collection: "patterns", id: "../etc", updatedAt: 1, data: {} },
      { collection: "patterns", id: "ok", updatedAt: 5, data: { name: "fine" } }
    ], "pc");
    assert.equal(accepted, 1);
  });
});

test("epoch is stable per database, rotates on demand, high-water mark tracks seq", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pindou-hub-test-"));
  try {
    const a = openStore(dir);
    const epoch = a.epoch();
    assert.ok(epoch.length >= 8);
    assert.equal(a.epoch(), epoch, "same value on every call");
    assert.equal(a.highWater(), 0);
    a.applyChanges([{ collection: "txns", id: "t1", updatedAt: 5, data: {} }, { collection: "txns", id: "t2", updatedAt: 6, data: {} }], "pc");
    assert.equal(a.highWater(), 2);
    a.close();
    const b = openStore(dir);
    assert.equal(b.epoch(), epoch, "survives reopen");
    const next = b.rotateEpoch();
    assert.notEqual(next, epoch);
    assert.equal(b.epoch(), next);
    b.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("pushing the same batch in chunks, in any order and repeated, converges", () => {
  withStore((store) => {
    const all = Array.from({ length: 30 }, (_, i) => ({ collection: "txns", id: `t${i}`, updatedAt: 100 + i, data: { delta: i } }));
    const chunks = [all.slice(0, 10), all.slice(10, 20), all.slice(20)];
    for (const c of [chunks[2], chunks[0], chunks[0], chunks[1], chunks[2]]) store.applyChanges(c, "pc");
    const { changes } = store.changesSince(0, 100);
    assert.equal(changes.length, 30);
    assert.equal(store.applyChanges(all, "pc"), 0, "full replay accepts nothing new");
  });
});

test("sync marks: issued per cursor, stable, and unknown to a restored older copy", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pindou-hub-marks-"));
  try {
    const a = openStore(dir);
    assert.equal(a.markFor(0), null);
    assert.equal(a.markKnown(undefined), true, "no mark sent: nothing to judge");
    assert.equal(a.markKnown({ seq: "x", token: 1 }), true, "malformed: treated as absent");
    a.applyChanges([{ collection: "txns", id: "t1", updatedAt: 10, data: {} }, { collection: "txns", id: "t2", updatedAt: 11, data: {} }], "pc");
    const m1 = a.markFor(a.highWater());
    assert.deepEqual(a.markFor(a.highWater()), m1, "same seq, same token");
    assert.equal(a.markKnown(m1), true);
    assert.equal(a.markKnown({ seq: m1.seq, token: "forged" }), false);
    assert.equal(a.markKnown({ seq: m1.seq + 50, token: m1.token }), false);
    a.close();
    // 另一个数据库（= 恢复了旧副本 / 换了库）不认识 a 发的标记，即使它的序号已经长过去了
    const other = mkdtempSync(path.join(os.tmpdir(), "pindou-hub-marks2-"));
    try {
      const b = openStore(other);
      b.applyChanges(Array.from({ length: 5 }, (_, i) => ({ collection: "txns", id: `x${i}`, updatedAt: 20 + i, data: {} })), "pc");
      assert.ok(b.highWater() >= m1.seq);
      assert.equal(b.markKnown(m1), false);
      b.close();
    } finally { rmSync(other, { recursive: true, force: true }); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("sync marks are pruned to a bounded number", () => {
  withStore((store) => {
    store.applyChanges(Array.from({ length: 5100 }, (_, i) => ({ collection: "txns", id: `m${i}`, updatedAt: 1 + i, data: {} })), "pc");
    for (let seq = 1; seq <= 5100; seq++) store.markFor(seq);
    assert.equal(store.markKnown({ seq: 5100, token: store.markFor(5100).token }), true, "newest kept");
    assert.equal(store.markKnown({ seq: 1, token: "whatever" }), false, "oldest pruned");
  });
});
