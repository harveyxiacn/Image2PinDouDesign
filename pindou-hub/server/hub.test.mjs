// 端到端：启动真实 Hub 进程（临时数据目录、随机端口），模拟两台设备配对与同步。
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const port = 18000 + Math.floor(Math.random() * 2000);
const base = `http://127.0.0.1:${port}`;
const dataDir = mkdtempSync(path.join(os.tmpdir(), "pindou-hub-e2e-"));
let child;

test.before(async () => {
  child = spawn(process.execPath, [path.join(here, "hub.mjs"), "--port", String(port), "--host", "127.0.0.1", "--data", dataDir], { stdio: "pipe" });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${base}/api/ping`)).ok) return; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("hub did not start");
});
test.after(async () => {
  child.kill();
  await new Promise((r) => child.once("exit", r));
  rmSync(dataDir, { recursive: true, force: true });
});

const json = (body) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("pairing: wrong code rejected, right code returns token, API needs token", async () => {
  const config = JSON.parse(readFileSync(path.join(dataDir, "config.json"), "utf8"));
  assert.equal((await fetch(`${base}/api/info`)).status, 401);
  assert.equal((await fetch(`${base}/api/pair`, json({ code: "000000" === config.pairCode ? "111111" : "000000" }))).status, 401);
  const ok = await fetch(`${base}/api/pair`, json({ code: config.pairCode, deviceId: "phone", deviceName: "测试手机" }));
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).token, config.token);
  const local = await (await fetch(`${base}/api/local-token`)).json();
  assert.equal(local.token, config.token, "loopback page gets token automatically");
});

test("two devices converge through the hub; blobs are hash-checked", async () => {
  const { token } = JSON.parse(readFileSync(path.join(dataDir, "config.json"), "utf8"));
  const auth = (init = {}) => ({ ...init, headers: { ...(init.headers ?? {}), "x-pindou-token": token } });
  const sync = (body) => fetch(`${base}/api/sync`, auth(json(body))).then((r) => r.json());

  const blob = Buffer.from("fake-png-bytes");
  const id = crypto.createHash("sha256").update(blob).digest("hex");
  const pc = await sync({
    deviceId: "pc", since: 0, blobsHave: [id],
    changes: [
      { collection: "patterns", id: "p1", updatedAt: 100, data: { name: "亚古兽", counts: { A1: 10 } } },
      { collection: "txns", id: "t1", updatedAt: 100, data: { code: "A1", delta: 1000, kind: "purchase", at: 100 } },
      { collection: "images", id, updatedAt: 100, data: { name: "x.png" } }
    ]
  });
  assert.equal(pc.accepted, 3);
  assert.deepEqual(pc.blobsMissing, [id]);
  assert.equal((await fetch(`${base}/api/blobs/${id}`, auth({ method: "PUT", body: Buffer.from("tampered") }))).status, 400);
  assert.equal((await fetch(`${base}/api/blobs/${id}`, auth({ method: "PUT", body: blob }))).status, 200);

  // 手机离线时改了同一张图纸（更晚），并记了一笔消耗
  const phone = await sync({
    deviceId: "phone", since: 0,
    changes: [
      { collection: "patterns", id: "p1", updatedAt: 200, data: { name: "亚古兽（改）", counts: { A1: 12 } } },
      { collection: "txns", id: "t2", updatedAt: 150, data: { code: "A1", delta: -12, kind: "consume", at: 150 } }
    ]
  });
  assert.equal(phone.accepted, 2);
  const names = phone.changes.filter((c) => c.collection === "patterns").map((c) => c.data.name);
  assert.deepEqual(names, ["亚古兽（改）"]);
  assert.equal(phone.changes.filter((c) => c.collection === "txns").length, 2, "ledger entries from both devices survive");

  // 电脑拿着旧游标再同步：收到手机的改动；它的旧版本不会覆盖新版本
  const again = await sync({ deviceId: "pc", since: pc.cursor, changes: [{ collection: "patterns", id: "p1", updatedAt: 100, data: { name: "亚古兽" } }] });
  assert.equal(again.accepted, 0);
  assert.ok(again.changes.some((c) => c.id === "p1" && c.data.name === "亚古兽（改）"));

  const got = await fetch(`${base}/api/blobs/${id}`, auth());
  assert.equal(Buffer.from(await got.arrayBuffer()).toString(), "fake-png-bytes");
});
