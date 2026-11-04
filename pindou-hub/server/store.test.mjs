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
