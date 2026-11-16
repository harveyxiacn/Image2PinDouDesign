// 拼豆仓“同步恢复演练”：真 Hub + 真浏览器（headless Edge，经 CDP，零依赖），把 Hub 的数据库删掉 / 恢复成旧副本 / 中途断开，
// 检查两台设备（两个浏览器配置）与 Hub 最终是否都收敛、有没有丢或重复。
// 用法：node scripts/restore-drill.mjs <outDir> [--only A,B1,B2,C1,C2,C3,D,E,F]
// 只用临时目录（<outDir>/…），只停自己启动的 Hub 和浏览器进程；不碰 pindou-hub/data/。
import { spawn } from "node:child_process";
import http from "node:http";
import crypto from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const here = path.dirname(fileURLToPath(import.meta.url));
const hubScript = path.resolve(here, "..", "server", "hub.mjs");
const argv = process.argv.slice(2);
const outDir = path.resolve(argv.find((a) => !a.startsWith("--")) ?? path.join(process.env.TEMP ?? ".", "pindou-restore-drill"));
const onlyIdx = argv.indexOf("--only");
const only = onlyIdx >= 0 ? new Set(String(argv[onlyIdx + 1]).split(",").map((s) => s.trim().toUpperCase())) : null;
const HUB_PORT = Number(process.env.DRILL_HUB_PORT ?? 18795);
const PROXY_PORT = Number(process.env.DRILL_PROXY_PORT ?? 18796);
const CDP_BASE = Number(process.env.DRILL_CDP_PORT ?? 9351);
const browserPath = process.env.BROWSER_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------- results
const results = [];
let currentScenario = "-";
function check(name, ok, detail = "") {
  results.push({ scenario: currentScenario, name, ok: Boolean(ok), detail: String(detail) });
  console.log(`${ok ? "PASS" : "FAIL"} [${currentScenario}] ${name}${detail ? ` — ${detail}` : ""}`);
  return Boolean(ok);
}
const note = (text) => console.log(`     [${currentScenario}] ${text}`);

// ---------------------------------------------------------------- hub
class Hub {
  constructor(dir, port = HUB_PORT) { this.dir = dir; this.port = port; this.url = `http://127.0.0.1:${port}`; this.child = null; }
  async start() {
    this.child = spawn(process.execPath, [hubScript, "--port", String(this.port), "--host", "127.0.0.1", "--data", this.dir], { stdio: "ignore" });
    this.exited = new Promise((r) => this.child.once("exit", r));
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${this.url}/api/ping`, { signal: AbortSignal.timeout(1000) })).ok) return; } catch { /* starting */ }
      await sleep(150);
    }
    throw new Error("hub did not start");
  }
  async stop() {
    if (!this.child) return;
    const child = this.child; this.child = null;
    child.kill();
    await Promise.race([this.exited, sleep(5000)]);
  }
  get dbFile() { return path.join(this.dir, "hub.db"); }
  config() { return JSON.parse(readFileSync(path.join(this.dir, "config.json"), "utf8")); }
  wipeDb() { for (const suffix of ["", "-wal", "-shm"]) rmSync(this.dbFile + suffix, { force: true }); }
  async call(p, body) {
    const res = await fetch(`${this.url}${p}`, {
      method: body ? "POST" : "GET",
      headers: { "x-pindou-token": this.config().token, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    return res.json();
  }
  /** 作为一台“第三方设备”直接往 Hub 推记录（不经浏览器）。 */
  push(device, changes) { return this.call("/api/sync", { deviceId: device, since: 0, changes }); }
  async state() {
    const exp = await this.call("/api/export");
    const out = { patterns: {}, txns: {}, images: {}, prefs: {} };
    const seen = new Set();
    let dup = 0;
    for (const r of exp.records) {
      const k = `${r.collection}/${r.id}`;
      if (seen.has(k)) dup += 1;
      seen.add(k);
      out[r.collection][r.id] = [r.updatedAt, r.deleted ? 1 : 0, r.data?.delta ?? r.data?.copies ?? 0];
    }
    out.dup = dup;
    return out;
  }
  /** 对账用快照：VACUUM INTO 得到单文件一致副本，模拟“备份”。 */
  backupTo(file) {
    rmSync(file, { force: true });
    const db = new DatabaseSync(this.dbFile);
    try { db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`); } finally { db.close(); }
  }
  restoreFrom(file) { this.wipeDb(); copyFileSync(file, this.dbFile); }
  rowCount(collection) {
    const db = new DatabaseSync(this.dbFile);
    try { return Number(db.prepare("SELECT COUNT(*) AS n FROM records WHERE collection = ?").get(collection).n); } finally { db.close(); }
  }
}

// ---------------------------------------------------------------- minimal CDP browser
const PAGE_HELPERS = `(() => {
  const open = () => new Promise((res, rej) => { const r = indexedDB.open('pindou-hub'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const q = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
  const doneTx = (tx) => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
  window.confirm = () => true;
  window.__fx = [];
  const of = window.fetch.bind(window);
  window.fetch = async (u, i) => { const t = Date.now(); try { const r = await of(u, i); window.__fx.push([String(u).slice(-30), r.status, Date.now() - t]); return r; } catch (e) { window.__fx.push([String(u).slice(-30), 'ERR ' + e.name, Date.now() - t]); throw e; } };
  window.__drill = {
    async dump() {
      const db = await open(); const out = {};
      for (const c of ['patterns', 'txns', 'images', 'prefs']) {
        out[c] = {};
        for (const r of await q(db.transaction(c).objectStore(c).getAll())) out[c][r.id] = [r.updatedAt, r.deleted ? 1 : 0, r.delta ?? r.copies ?? 0];
      }
      out.blobs = await q(db.transaction('blobs').objectStore('blobs').getAllKeys());
      out.outbox = await q(db.transaction('outbox').objectStore('outbox').count());
      out.device = await q(db.transaction('meta').objectStore('meta').get('device'));
      out.sync = await q(db.transaction('meta').objectStore('meta').get('sync'));
      db.close(); return out;
    },
    async meta() {
      const db = await open();
      const out = {
        outbox: await q(db.transaction('outbox').objectStore('outbox').count()),
        device: await q(db.transaction('meta').objectStore('meta').get('device')),
        sync: await q(db.transaction('meta').objectStore('meta').get('sync'))
      };
      db.close();
      out.phase = (document.querySelector('.sync-dot')?.className ?? '').split(' ')[1] ?? '';
      out.msg = (document.querySelector('.rail-foot')?.innerText ?? '').replace(/\\s+/g, ' ').trim();
      return out;
    },
    async get(c, id) { const db = await open(); const r = await q(db.transaction(c).objectStore(c).get(id)); db.close(); return r; },
    async inject(c, recs) {
      const db = await open(); const tx = db.transaction([c, 'outbox'], 'readwrite');
      for (const r of recs) { tx.objectStore(c).put(r); tx.objectStore('outbox').put({ key: c + '/' + r.id, collection: c, id: r.id, updatedAt: r.updatedAt }); }
      await doneTx(tx); db.close(); return recs.length;
    }
  };
})()`;

class Device {
  constructor(name, cdpPort, profile, opts = {}) {
    this.name = name; this.port = cdpPort; this.profile = profile; this.opts = opts; this.seq = 0; this.pending = new Map(); this.errors = [];
  }
  async start(url) {
    rmSync(this.profile, { recursive: true, force: true });
    this.proc = spawn(browserPath, ["--headless=new", `--remote-debugging-port=${this.port}`, `--user-data-dir=${this.profile}`, "--no-first-run", "--disable-gpu", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
    let wsUrl = null;
    for (let i = 0; i < 80 && !wsUrl; i++) {
      try { const list = await (await fetch(`http://127.0.0.1:${this.port}/json/list`)).json(); wsUrl = list.find((t) => t.type === "page")?.webSocketDebuggerUrl; } catch { /* starting */ }
      if (!wsUrl) await sleep(250);
    }
    if (!wsUrl) throw new Error(`${this.name}: browser CDP not reachable`);
    this.ws = new WebSocket(wsUrl);
    await new Promise((r, j) => { this.ws.onopen = r; this.ws.onerror = j; });
    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) { const p = this.pending.get(msg.id); this.pending.delete(msg.id); msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result); return; }
      if (msg.method === "Runtime.exceptionThrown") this.errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
    };
    await this.send("Page.enable"); await this.send("Runtime.enable"); await this.send("Network.enable");
    await this.send("Emulation.setDeviceMetricsOverride", { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
    if (this.opts.lan) await this.send("Network.setBlockedURLs", { urls: ["*/api/local-token"] }); // 像手机那样：拿不到本机令牌，只能输配对码
    let script = PAGE_HELPERS;
    if (this.opts.skewMs) script = `(() => { const o = Date.now.bind(Date); Date.now = () => o() + (${this.opts.skewMs}); })();\n` + script;
    await this.send("Page.addScriptToEvaluateOnNewDocument", { source: script });
    await this.send("Page.navigate", { url });
    await this.ready();
  }
  send(method, params = {}, timeoutMs = 60000) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      const timer = setTimeout(() => { this.pending.delete(id); rej(new Error(`CDP timeout ${method}`)); }, timeoutMs);
      this.pending.set(id, { res: (v) => { clearTimeout(timer); res(v); }, rej: (e) => { clearTimeout(timer); rej(e); } });
    });
  }
  async eval(expression, timeoutMs = 60000) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
    if (r.exceptionDetails) throw new Error(`eval failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  }
  async waitFor(expression, timeoutMs = 30000, label = expression) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) { try { if (await this.eval(`!!(${expression})`)) return true; } catch { /* navigating */ } await sleep(250); }
    throw new Error(`${this.name}: timeout waiting for ${label}`);
  }
  async ready() {
    await this.waitFor(`document.querySelector(".shell") && !document.querySelector('[aria-busy="true"]') && window.__drill`, 30000, "app shell");
    await sleep(400);
  }
  async reload() { await this.send("Page.reload"); await sleep(300); await this.ready(); }
  dump() { return this.eval("__drill.dump()"); }
  meta() { return this.eval("__drill.meta()"); }
  inject(collection, records) { return this.eval(`__drill.inject(${JSON.stringify(collection)}, ${JSON.stringify(records)})`); }
  async go(hash) { await this.eval(`location.hash = ${JSON.stringify(hash)}`); await sleep(800); await this.waitFor(`!document.querySelector('[aria-busy="true"]')`, 15000, `page ${hash}`); }
  async clickText(text, selector = "button") {
    const ok = await this.eval(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(b => b.innerText.trim().startsWith(${JSON.stringify(text)}) && !b.disabled); if (!el) return false; el.scrollIntoView({block:"center"}); el.click(); return true; })()`);
    if (!ok) throw new Error(`${this.name}: button not found/enabled: ${text}`);
  }
  async offline(on) {
    await this.send("Network.emulateNetworkConditions", { offline: on, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await this.eval(`window.dispatchEvent(new Event(${JSON.stringify(on ? "offline" : "online")}))`);
  }
  async close() {
    try {
      const v = await (await fetch(`http://127.0.0.1:${this.port}/json/version`)).json();
      const ws = new WebSocket(v.webSocketDebuggerUrl);
      await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
      ws.send(JSON.stringify({ id: 1, method: "Browser.close" }));
      await sleep(500);
    } catch { /* already gone */ }
    try { this.ws?.close(); } catch { /* ignore */ }
    this.proc?.kill();
    await sleep(300);
  }
}

// ---------------------------------------------------------------- sync helpers
/** 触发一次同步并等到它结束（lastSyncAt 前进且稳定，或进入 error / unpaired / offline）。 */
async function syncSettle(dev, { timeout = 45000, trigger = true } = {}) {
  const t0 = await dev.eval("Date.now()");
  const started = Date.now();
  if (trigger) await dev.eval(`window.dispatchEvent(new Event('online'))`);
  let key = ""; let changed = Date.now(); let last = null; const seen = [];
  while (Date.now() - started < timeout) {
    const m = await dev.meta(); last = m; if (seen[seen.length - 1]?.split('@')[0] !== m.phase) seen.push(`${m.phase}@${Date.now() - started}`);
    const k = `${m.device.lastSyncAt}|${m.phase}|${m.outbox}|${m.device.cursor}`;
    if (k !== key) { key = k; changed = Date.now(); }
    const terminal = (m.device.lastSyncAt > t0 && m.phase === "idle") || (["error", "unpaired", "offline"].includes(m.phase) && Date.now() - started > 1500);
    if (terminal && Date.now() - changed > 1200) return m;
    await sleep(250);
  }
  throw new Error(`${dev.name}: sync did not settle (last: phase ${last?.phase}, lastSyncAt ${last?.device?.lastSyncAt}, t0 ${t0}, outbox ${last?.outbox}, msg ${last?.msg}; phases ${seen.join(',')}; page errors ${JSON.stringify(dev.errors.slice(-2))})`);
}
const mapOf = (dump) => { const out = {}; for (const c of ["patterns", "txns", "images", "prefs"]) for (const [id, v] of Object.entries(dump[c] ?? {})) out[`${c}/${id}`] = v.join(":"); return out; };
const canon = (m) => JSON.stringify(Object.keys(m).sort().map((k) => [k, m[k]]));
const live = (map) => Object.fromEntries(Object.entries(map).filter(([, v]) => v.split(":")[1] === "0"));
function diffMaps(expected, actual) {
  const missing = Object.keys(expected).filter((k) => !(k in actual));
  const extra = Object.keys(actual).filter((k) => !(k in expected));
  const stale = Object.keys(expected).filter((k) => k in actual && expected[k] !== actual[k]);
  return { missing, extra, stale };
}
const sumDelta = (dump) => Object.values(dump.txns).reduce((s, v) => s + (v[1] ? 0 : v[2]), 0);
const countLive = (dump, c) => Object.values(dump[c]).filter((v) => !v[1]).length;

/** 轮流同步，直到 Hub 和各设备的记录完全一致（最多 maxRounds 轮）。返回最后一轮的三方快照。 */
async function converge(hub, devs, maxRounds = 4) {
  let snap;
  for (let round = 1; round <= maxRounds; round++) {
    for (const d of devs) await syncSettle(d);
    snap = { hub: mapOf(await hub.state()), devs: [] };
    for (const d of devs) snap.devs.push(mapOf(await d.dump()));
    const same = snap.devs.every((m) => canon(m) === canon(snap.hub));
    if (same) return { ok: true, rounds: round, snap };
    if (round === maxRounds) snap.devs.forEach((m, i) => { const d = diffMaps(snap.hub, m); note(`not converged: ${devs[i].name} vs hub missing ${d.missing.length} ${JSON.stringify(d.missing.slice(0, 3))} extra ${d.extra.length} ${JSON.stringify(d.extra.slice(0, 3))} stale ${d.stale.length} ${JSON.stringify(d.stale.slice(0, 3).map((k) => [k, snap.hub[k], m[k]]))}`); });
  }
  return { ok: false, rounds: maxRounds, snap };
}
/** 断言 Hub + 各设备都恰好等于 expected（记录键 → “updatedAt:deleted:x”）。 */
async function assertAll(label, hub, devs, expected) {
  const hubMap = mapOf(await hub.state());
  const targets = [["hub", hubMap], ...(await Promise.all(devs.map(async (d) => [d.name, mapOf(await d.dump())])))];
  for (const [name, map] of targets) {
    const d = diffMaps(expected, map);
    check(`${label}: ${name} has exactly the expected records`, !d.missing.length && !d.extra.length && !d.stale.length,
      `${Object.keys(map).length} records; missing ${d.missing.length}${d.missing.length ? ` (${d.missing.slice(0, 3)})` : ""}, extra ${d.extra.length}, stale ${d.stale.length}`);
  }
}

// ---------------------------------------------------------------- data builders
const T = (n) => String(n).padStart(4, "0");
function txns(prefix, n, base, code = "A1") {
  return Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${T(i)}`, code, delta: 10 + (i % 7), kind: "purchase", device: prefix, at: base + i, updatedAt: base + i }));
}
function pattern(id, name, at, extra = {}) {
  return { id, name, kind: "manual", method: "manual", counts: { A1: 20, B2: 5 }, status: "planned", copies: 1, tags: [], notes: "", createdAt: at, updatedAt: at, ...extra };
}
function hubTxnChanges(prefix, n, base) {
  return txns(prefix, n, base).map((r) => ({ collection: "txns", id: r.id, updatedAt: r.updatedAt, data: { code: r.code, delta: r.delta, kind: r.kind, at: r.at } }));
}

// ---------------------------------------------------------------- worlds
async function world(name, opts = {}) {
  const dir = path.join(outDir, `${name}-data`);
  rmSync(dir, { recursive: true, force: true });
  const hub = new Hub(dir);
  await hub.start();
  const d1 = new Device("d1", CDP_BASE, path.join(outDir, `${name}-d1`));
  const d2 = new Device("d2", CDP_BASE + 1, path.join(outDir, `${name}-d2`), { lan: true, skewMs: opts.skewMs2 ?? 0 });
  await d1.start(`${hub.url}/`);
  await d2.start(`${hub.url}/`);
  await syncSettle(d1).catch(() => {});
  return { hub, d1, d2, dir, async close() { await d1.close(); await d2.close(); await hub.stop(); } };
}
async function fillAndPair(dev, hub, label) {
  await dev.go("#/settings");
  const formShown = await dev.eval(`!!document.querySelector('input[placeholder="192.168.1.20:8787"]')`);
  if (!formShown) {
    await dev.clickText("断开");
    await sleep(500);
  }
  await dev.eval(`(() => {
    const set = (el, v) => { const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; d.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
    set(document.querySelector('input[placeholder="192.168.1.20:8787"]'), ${JSON.stringify(hub.url.replace("http://", ""))});
    set(document.querySelector('input[placeholder="6 位数字"]'), ${JSON.stringify(hub.config().pairCode)});
  })()`);
  await sleep(300);
  await dev.clickText("配对");
  await dev.waitFor(`document.querySelector('.set-kv')`, 15000, "paired panel");
  await syncSettle(dev);
  return formShown;
}
const dropBackup = (...files) => { for (const f of files) rmSync(f, { force: true }); };

// ---------------------------------------------------------------- scenarios
/** 共同前置：d1 建图纸 + 界面入库 + 手写流水，d2 配对并收到，再各自离线记一批，收敛。 */
async function baseline(w, withUi) {
  const { hub, d1, d2 } = w;
  const now = await d1.eval("Date.now()");
  await d1.inject("patterns", [pattern("p-dragon", "亚古兽", now)]);
  await d1.inject("txns", txns("d1a", 6, now + 10));
  await d1.reload();
  if (withUi) {
    await d1.go("#/inventory");
    await d1.clickText("批量入库");
    await sleep(500);
    await d1.eval(`(() => { const ta = document.querySelector('.sheet textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(ta, 'A26 300, B19 100'); ta.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await sleep(300);
    await d1.clickText("加入下面的列表", ".sheet button");
    await sleep(500);
    const btn = await d1.eval(`(() => { const b = [...document.querySelectorAll('.sheet button')].find(b => /^入库 \\d/.test(b.innerText.trim()) && !b.disabled); if (!b) return null; const t = b.innerText; b.click(); return t; })()`);
    if (!btn) throw new Error("stock-in confirm button not found");
    await sleep(1200);
  }
  await syncSettle(d1);
  const formShown = await fillAndPair(d2, hub, "d2");
  const now2 = await hub.call("/api/ping").then((p) => p.time);
  await d2.inject("txns", txns("d2a", 4, now2 + 20));
  await d2.reload();
  const c = await converge(hub, [d1, d2]);
  return { converge: c, formShown };
}

async function scenarioA() {
  currentScenario = "A";
  const w = await world("A");
  try {
    const { converge: c, formShown } = await baseline(w, true);
    check("device 2 pairs through the pairing form (LAN-style, no local token)", formShown, "form visible on a fresh LAN device");
    check("baseline converges", c.ok, `${c.rounds} round(s)`);
    const hs = await w.hub.state();
    const d1 = await w.d1.dump(); const d2 = await w.d2.dump();
    // 界面：入库后设备 1 的库存页、设备 2 的库存页都能看到 300
    await w.d1.go("#/inventory"); await w.d2.go("#/inventory");
    const ui1 = await w.d1.eval(`document.querySelector('main').innerText.includes('300')`);
    const ui2 = await w.d2.eval(`document.querySelector('main').innerText.includes('300')`);
    check("UI: both devices show the stocked-in 300 on the inventory page", ui1 && ui2, `d1=${ui1} d2=${ui2}`);
    check("hub: pattern + 12 txns (6 hand-made + 4 from d2 + UI stock-in 2)", Object.keys(hs.patterns).length === 1 && Object.keys(hs.txns).length === 12, `patterns ${Object.keys(hs.patterns).length}, txns ${Object.keys(hs.txns).length}, duplicate rows ${hs.dup}`);
    check("devices: same txn count and same bead total as the hub", countLive(d1, "txns") === 12 && countLive(d2, "txns") === 12 && sumDelta(d1) === sumDelta(d2) && sumDelta(d2) === Object.values(hs.txns).reduce((s, v) => s + v[2], 0), `d1 ${countLive(d1, "txns")} / d2 ${countLive(d2, "txns")} txns, delta sum ${sumDelta(d1)}`);
    check("devices adopted the hub epoch and have a mark", d1.sync?.epoch === w.hub.config().dbEpoch && d2.sync?.epoch === w.hub.config().dbEpoch, `epoch ${d1.sync?.epoch}; d1 mark ${JSON.stringify(d1.device.syncMark ?? null)}`);
    check("no outbox left", d1.outbox === 0 && d2.outbox === 0, `d1 ${d1.outbox}, d2 ${d2.outbox}`);
  } finally { await w.close(); }
}

async function scenarioB(variant) {
  currentScenario = variant;
  const keepConfig = variant === "B1";
  const w = await world(variant);
  try {
    const { hub, d1, d2 } = w;
    await baseline(w, false);
    const before = await converge(hub, [d1, d2]);
    check("before wipe: hub + both devices identical", before.ok, `${Object.keys(before.snap.hub).length} records`);
    const expected = before.snap.hub;
    const cfg0 = hub.config();
    const d2cur = (await d2.meta()).device.cursor;
    await hub.stop();
    hub.wipeDb();
    if (!keepConfig) rmSync(path.join(hub.dir, "config.json"), { force: true });
    await hub.start();
    const cfg1 = hub.config();
    note(`hub restarted with ${keepConfig ? "config.json kept" : "config.json removed"}; token ${cfg1.token === cfg0.token ? "unchanged" : "NEW"}, pair code ${cfg1.pairCode === cfg0.pairCode ? "unchanged" : "NEW"}, epoch ${cfg0.dbEpoch} -> ${cfg1.dbEpoch}`);
    check("hub database really is empty after the wipe", Object.keys((await hub.state()).txns).length === 0);
    check("hub gets a new database epoch", cfg1.dbEpoch !== cfg0.dbEpoch, `${cfg0.dbEpoch} -> ${cfg1.dbEpoch}`);
    check(keepConfig ? "token and pair code survive (config.json kept)" : "token and pair code change (config.json removed)", keepConfig ? cfg1.token === cfg0.token && cfg1.pairCode === cfg0.pairCode : cfg1.token !== cfg0.token && cfg1.pairCode !== cfg0.pairCode);
    if (keepConfig) {
      const m1 = await syncSettle(d1); const m2 = await syncSettle(d2);
      check("no re-pairing needed: both devices sync straight away", m1.phase === "idle" && m2.phase === "idle", `d1 ${m1.phase}, d2 ${m2.phase}`);
      note(`d1 after wipe: epoch ${m1.sync.epoch}, cursor ${m1.device.cursor}; d2 cursor was ${d2cur} -> ${m2.device.cursor}; message "${m1.msg}"`);
    } else {
      const m1 = await syncSettle(d1); const m2 = await syncSettle(d2);
      check("old token is refused: both running devices fall to unpaired", m1.phase === "unpaired" && m2.phase === "unpaired", `d1 ${m1.phase} "${m1.msg}", d2 ${m2.phase}`);
      const hubStillEmpty = Object.keys((await hub.state()).txns).length === 0;
      check("nothing was lost or half-applied while unpaired (hub still empty, devices keep their data)", hubStillEmpty && (await d1.dump()).outbox >= 0 && countLive(await d1.dump(), "txns") > 0);
      await d1.reload(); // 同一台电脑上的页面：重新打开就自动拿到新令牌
      const a1 = await syncSettle(d1);
      check("same-machine device re-pairs itself on reload (local token)", a1.device.token === hub.config().token && a1.phase === "idle", `phase ${a1.phase}`);
      const formShown = await fillAndPair(d2, hub, "d2");
      check("LAN device: pairing form is offered again after the 401 (no manual 断开 needed)", formShown, formShown ? "form visible" : "form hidden: had to click 断开 first");
      check("LAN device re-paired with the NEW code and keeps its data", (await d2.meta()).device.token === hub.config().token && countLive(await d2.dump(), "txns") > 0);
    }
    const c = await converge(hub, [d1, d2]);
    check("after the wipe everything converges", c.ok, `${c.rounds} round(s)`);
    await assertAll("after wipe", hub, [d1, d2], expected);
    const hs = await hub.state();
    check("no duplicated rows on the hub", hs.dup === 0 && Object.keys(hs.txns).length === Object.keys(live(expected)).filter((k) => k.startsWith("txns/")).length);
    const m = await d1.meta();
    check("devices adopted the new epoch", m.sync.epoch === hub.config().dbEpoch && (await d2.meta()).sync.epoch === hub.config().dbEpoch, `epoch ${m.sync.epoch}`);
    // 之后照常记账、照常收敛
    await d1.inject("txns", txns("d1post", 3, await d1.eval("Date.now()")));
    await d1.reload();
    const c2 = await converge(hub, [d1, d2]);
    check("new records after the wipe still flow both ways", c2.ok && Object.keys((await d2.dump()).txns).some((id) => id.startsWith("d1post")), `${c2.rounds} round(s)`);
  } finally { await w.close(); }
}

async function scenarioC(variant) {
  currentScenario = variant;
  // C1: 只恢复数据库，Hub 没有长过；C2: 只恢复数据库，Hub 恢复后又长过设备游标；C3: 数据库 + config.json 一起恢复，也长过（弱情形）
  const grow = variant !== "C1";
  const restoreConfig = variant === "C3";
  const w = await world(variant);
  try {
    const { hub, d1, d2 } = w;
    await baseline(w, false);
    const s0 = await converge(hub, [d1, d2]);
    check("S0 converged", s0.ok);
    const snap = path.join(outDir, `${variant}-snapshot.db`); const cfgCopy = path.join(outDir, `${variant}-config.json`);
    hub.backupTo(snap); copyFileSync(path.join(hub.dir, "config.json"), cfgCopy);
    const hubMax0 = (await hub.call("/api/sync", { deviceId: "probe", since: 0, changes: [] })).maxSeq;
    // 备份之后：两台设备各自又记了一批并同步
    const now = await d1.eval("Date.now()");
    await d1.inject("txns", txns("d1x", 5, now + 100));
    await d1.inject("patterns", [pattern("p-late", "备份之后的图纸", now + 120)]);
    await d1.reload();
    await d2.inject("txns", txns("d2y", 5, now + 140));
    await d2.reload();
    const s1 = await converge(hub, [d1, d2]);
    check("S1 (after backup) converged", s1.ok, `${Object.keys(s1.snap.hub).length} records`);
    const hubMax1 = (await hub.call("/api/sync", { deviceId: "probe", since: 0, changes: [] })).maxSeq;
    const dev1Cursor = (await d1.meta()).device.cursor;
    // 灾难：恢复旧数据库
    await hub.stop();
    hub.restoreFrom(snap);
    if (restoreConfig) copyFileSync(cfgCopy, path.join(hub.dir, "config.json"));
    await hub.start();
    const cfg = hub.config();
    note(`restored backup: hub maxSeq ${hubMax1} -> ${hubMax0}; device cursor ${dev1Cursor}; epoch in config ${cfg.dbEpoch}`);
    let expected = { ...s1.snap.hub };
    if (grow) {
      // 恢复之后、设备还没同步之前，Hub 又收到别的设备（d3）的记录，序号长到了设备游标之上
      const need = Math.max(hubMax1 - hubMax0, 0) + 6;
      await hub.push("d3", hubTxnChanges("d3g", need, now + 1000));
      const after = (await hub.call("/api/sync", { deviceId: "probe", since: 0, changes: [] })).maxSeq;
      check("setup: restored hub has grown past the devices' cursor", after > dev1Cursor, `hub maxSeq ${after} > device cursor ${dev1Cursor}`);
      for (let i = 0; i < need; i++) expected[`txns/d3g-${T(i)}`] = `${now + 1000 + i}:0:${10 + (i % 7)}`;
    }
    const m1 = await syncSettle(d1); const m2 = await syncSettle(d2);
    note(`d1 -> ${m1.phase} cursor ${m1.device.cursor} "${m1.msg}"; d2 -> ${m2.phase} cursor ${m2.device.cursor}`);
    const c = await converge(hub, [d1, d2]);
    check("everything converges after the restore", c.ok, `${c.rounds} round(s)`);
    await assertAll(`restored from older copy (${variant})`, hub, [d1, d2], expected);
    const hs = await hub.state();
    check("no duplicated rows on the hub", hs.dup === 0);
    dropBackup(snap, cfgCopy);
  } finally { await w.close(); }
}

// ---------------------------------------------------------------- D: proxy with a scripted hub kill
class Proxy {
  constructor(hub, port) { this.hub = hub; this.port = port; this.down = false; this.nth = 0; this.plan = null; this.sent = []; this.accepted = []; this.killed = null; this.waiters = []; }
  start() {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    return new Promise((r) => this.server.listen(this.port, "127.0.0.1", r));
  }
  stop() { this.server.closeAllConnections?.(); return new Promise((r) => this.server.close(r)); }
  async handle(req, res) {
    if (this.down) { res.writeHead(502, { "content-type": "text/plain" }); res.end("hub is down"); return; }
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const isSync = req.url === "/api/sync" && req.method === "POST";
    let n = 0;
    if (isSync) { try { n = JSON.parse(body.toString("utf8")).changes?.length ?? 0; } catch { n = 0; } }
    let up;
    try {
      up = await new Promise((resolve, reject) => {
        const r = http.request({ host: "127.0.0.1", port: this.hub.port, path: req.url, method: req.method, headers: req.headers, agent: false }, (u) => {
          const parts = []; u.on("data", (c) => parts.push(c)); u.on("end", () => resolve({ status: u.statusCode, headers: u.headers, body: Buffer.concat(parts) }));
        });
        r.on("error", reject); r.end(body);
      });
    } catch { res.writeHead(502); res.end("upstream error"); return; }
    let killNow = false;
    if (isSync && n > 0) {
      this.nth += 1; this.sent.push(n);
      try { this.accepted.push(JSON.parse(up.body.toString("utf8")).accepted); } catch { /* ignore */ }
      if (this.plan && this.nth === this.plan.nth) killNow = true;
    }
    if (killNow) {
      const plan = this.plan; this.plan = null; this.down = true;
      await this.hub.stop();
      this.killed = { nth: plan.nth, when: plan.when, sentSoFar: this.sent.reduce((a, b) => a + b, 0) };
      for (const w of this.waiters.splice(0)) w();
      if (plan.when === "before") { req.socket.destroy(); return; } // Hub 已提交，但响应没送到客户端
    }
    const headers = { ...up.headers }; delete headers["transfer-encoding"];
    res.writeHead(up.status, headers); res.end(up.body);
  }
  waitKilled(timeoutMs = 60000) { return this.killed ? Promise.resolve() : Promise.race([new Promise((r) => this.waiters.push(r)), sleep(timeoutMs).then(() => { throw new Error("proxy kill never fired"); })]); }
}

async function scenarioD() {
  currentScenario = "D";
  const dir = path.join(outDir, "D-data");
  rmSync(dir, { recursive: true, force: true });
  const hub = new Hub(dir);
  await hub.start();
  const proxy = new Proxy(hub, PROXY_PORT);
  await proxy.start();
  const dev = new Device("d3", CDP_BASE + 2, path.join(outDir, "D-d3"));
  try {
    await dev.start(`http://127.0.0.1:${PROXY_PORT}/`);
    await syncSettle(dev).catch(() => {});
    const TOTAL = 3000;
    const base = await dev.eval("Date.now()");
    for (let i = 0; i < TOTAL; i += 1000) await dev.inject("txns", txns("big", TOTAL, base).slice(i, i + 1000));
    check("setup: device holds 3000 un-synced transactions", (await dev.meta()).outbox === TOTAL, `outbox ${(await dev.meta()).outbox}`);
    // 第 2 批被 Hub 确认后立刻杀掉 Hub（响应照常送达客户端）
    proxy.plan = { nth: 2, when: "after" };
    await dev.go("#/settings"); // 先加载好设置页的代码：Hub 断开后页面还能读到同步状态文字
    await dev.reload();
    await proxy.waitKilled();
    await sleep(1500);
    const mid = await dev.meta();
    const hubRows = hub.rowCount("txns");
    check("interrupted after the first acknowledged chunks: hub holds a partial upload", hubRows > 0 && hubRows < TOTAL, `hub txns ${hubRows}, chunks sent ${JSON.stringify(proxy.sent)}`);
    check("device kept exactly what is not yet acknowledged (nothing lost, nothing acked twice)", mid.outbox === TOTAL - hubRows, `outbox ${mid.outbox} = ${TOTAL} - ${hubRows}`);
    const shown = (await dev.eval(`document.querySelector('.set-status')?.innerText ?? ''`)).replace(/\s+/g, " ");
    check("device reports a resumable failure (how much arrived, resumes from the break)", mid.phase === "error" && /已送达 \d+\/3000/.test(shown) && /断点/.test(shown), `"${shown}"`);
    // 重启 Hub；再让下一次上传“Hub 已提交但回应丢了”
    await hub.start(); proxy.down = false; proxy.nth = 0;
    proxy.plan = { nth: 2, when: "before" }; proxy.killed = null;
    const beforeSecond = proxy.sent.length;
    await syncSettle(dev, { trigger: true }).catch(() => {});
    await proxy.waitKilled();
    await sleep(1500);
    const mid2 = await dev.meta();
    const rows2 = hub.rowCount("txns");
    check("second interruption: hub committed a chunk whose acknowledgement never arrived", rows2 > hubRows && mid2.outbox > TOTAL - rows2, `hub txns ${rows2}, device outbox ${mid2.outbox} (hub has ${rows2 - (TOTAL - mid2.outbox)} the device does not know about)`);
    await hub.start(); proxy.down = false;
    const fin = await syncSettle(dev, { trigger: true });
    const hs = await hub.state();
    const dd = await dev.dump();
    check("resumed: hub has all 3000, once each", Object.keys(hs.txns).length === TOTAL && hs.dup === 0, `hub txns ${Object.keys(hs.txns).length}, duplicate rows ${hs.dup}`);
    check("resumed: device outbox empty, state idle", fin.outbox === 0 && fin.phase === "idle", `phase ${fin.phase}, outbox ${fin.outbox}`);
    const sentTotal = proxy.sent.reduce((a, b) => a + b, 0);
    const acceptedTotal = proxy.accepted.reduce((a, b) => a + b, 0);
    check("each record accepted exactly once; only the un-acknowledged chunk was re-sent", acceptedTotal === TOTAL && sentTotal - TOTAL <= 400, `sent ${sentTotal} (re-sent ${sentTotal - TOTAL}), accepted ${acceptedTotal}, requests ${JSON.stringify(proxy.sent)}`);
    check("hub sequence has no gaps or inflation (3000 txns -> maxSeq 3000)", (await hub.call("/api/sync", { deviceId: "probe", since: 0, changes: [] })).maxSeq === TOTAL);
    check("device content equals hub content", canon(mapOf(dd)) === canon(mapOf(hs)));
  } finally { await dev.close(); await proxy.stop(); await hub.stop(); }
}

// ---------------------------------------------------------------- E: clock skew
async function scenarioE() {
  currentScenario = "E";
  const w = await world("E", { skewMs2: -10 * 60 * 1000 });
  try {
    const { hub, d1, d2 } = w;
    const now = await d1.eval("Date.now()");
    await d1.inject("patterns", [pattern("p-skew", "时钟测试", now)]);
    await d1.reload();
    await syncSettle(d1);
    await fillAndPair(d2, hub, "d2");
    const m2 = await syncSettle(d2);
    const skew = m2.sync?.skew ?? 0;
    check("device 2 (clock 10 min behind) learns the offset from the hub", Math.abs(skew - 600000) < 5000, `skew ${skew} ms`);
    const d2clock = await d2.eval("Date.now()");
    check("setup: device 2's page clock really is ~10 min behind", Math.abs((now - d2clock) - 600000) < 15000, `${Math.round((Date.now() - d2clock) / 1000)} s behind real time`);
    await d2.go("#/pattern/p-skew"); // 先打开图纸页（离线后懒加载的页面代码取不到）
    await d2.offline(true);
    // 设备 1 先改（份数 2），同步到 Hub
    await d1.go("#/pattern/p-skew");
    await d1.waitFor(`document.querySelector('button[aria-label="增加一份"]')`, 8000, "份数 button").catch(async (e) => { throw new Error(`${e.message}; page: ${(await d1.eval("document.querySelector('main').innerText")).slice(0, 200)}`); });
    await d1.eval(`document.querySelector('button[aria-label="增加一份"]').click()`);
    await sleep(500);
    await syncSettle(d1);
    const afterD1 = (await hub.state()).patterns["p-skew"];
    await sleep(4000);
    // 设备 2 在设备 1 之后、离线时改了两次（份数 1 -> 3）；它的钟慢 10 分钟
    await d2.eval(`document.querySelector('button[aria-label="增加一份"]').click()`); await sleep(400);
    await d2.eval(`document.querySelector('button[aria-label="增加一份"]').click()`); await sleep(500);
    const rec2 = await d2.eval(`__drill.get('patterns', 'p-skew')`);
    const realNow = Date.now();
    check("the edit made on the slow clock is stamped in hub time (not 10 min in the past)", Math.abs(rec2.updatedAt - realNow) < 30000, `stamp is ${Math.round((realNow - rec2.updatedAt) / 1000)} s from real time; copies ${rec2.copies}`);
    check("device 2's stamp is newer than device 1's earlier edit", rec2.updatedAt > afterD1[0], `d2 ${rec2.updatedAt} > d1 ${afterD1[0]}`);
    await d2.offline(false);
    const c = await converge(hub, [d1, d2]);
    const finalHub = (await hub.state()).patterns["p-skew"];
    const d1rec = await d1.eval(`__drill.get('patterns', 'p-skew')`);
    check("the later edit (device 2, copies 3) wins on the hub and on device 1", c.ok && finalHub[2] === 3 && d1rec.copies === 3, `hub copies ${finalHub[2]}, d1 copies ${d1rec.copies}, converged ${c.ok}`);
  } finally { await w.close(); }
}

// ---------------------------------------------------------------- F: blob integrity
async function scenarioF() {
  currentScenario = "F";
  const w = await world("F");
  try {
    const { hub, d1, d2 } = w;
    const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
    const good = Buffer.from("good thumbnail bytes"); const goodId = sha(good);
    const evil = Buffer.from("this is not the thumbnail"); const badId = sha(Buffer.from("the thumbnail that was supposed to be here"));
    mkdirSync(path.join(hub.dir, "blobs"), { recursive: true });
    writeFileSync(path.join(hub.dir, "blobs", goodId), good);
    writeFileSync(path.join(hub.dir, "blobs", badId), evil); // 文件名是 badId，内容被损坏
    const now = Date.now();
    const img = (id, thumbId, name) => ({ collection: "images", id, updatedAt: now, data: { name, mime: "image/webp", width: 8, height: 8, bytes: 10, thumbId, role: "source", createdAt: now } });
    await hub.push("d3", [img(sha(Buffer.from("orig-1")), goodId, "good.png"), img(sha(Buffer.from("orig-2")), badId, "bad.png")]);
    await fillAndPair(d2, hub, "d2");
    await syncSettle(d2); await sleep(1500);
    const dump = await d2.dump();
    check("positive control: a correct thumbnail is downloaded and stored", dump.blobs.includes(goodId), `blobs ${JSON.stringify(dump.blobs.map((b) => b.slice(0, 8)))}`);
    check("a corrupted blob served by the hub is refused (not stored)", !dump.blobs.includes(badId), `stored ${dump.blobs.includes(badId)}`);
    const m = await d2.meta();
    check("sync itself still completes", m.phase === "idle", `phase ${m.phase}`);
    // 同样的损坏也不会被设备 1 接受
    const d1m = await syncSettle(d1); await sleep(1500);
    check("device 1 refuses it too", !(await d1.dump()).blobs.includes(badId) && d1m.phase === "idle");
  } finally { await w.close(); }
}

// ---------------------------------------------------------------- main
const plan = [["A", scenarioA], ["B1", () => scenarioB("B1")], ["B2", () => scenarioB("B2")], ["C1", () => scenarioC("C1")], ["C2", () => scenarioC("C2")], ["C3", () => scenarioC("C3")], ["D", scenarioD], ["E", scenarioE], ["F", scenarioF]];
const started = Date.now();
for (const [id, fn] of plan) {
  if (only && !only.has(id)) continue;
  const t = Date.now();
  try { await fn(); } catch (error) { currentScenario = id; check("scenario ran to the end", false, String(error?.stack ?? error).split("\n").slice(0, 4).join(" | ")); }
  console.log(`     [${id}] ${(Date.now() - t) / 1000}s`);
}
const failed = results.filter((r) => !r.ok);
const byScenario = {};
for (const r of results) { (byScenario[r.scenario] ??= { pass: 0, fail: 0 })[r.ok ? "pass" : "fail"] += 1; }
console.log("\nscenario  pass  fail");
for (const [id, v] of Object.entries(byScenario)) console.log(`${id.padEnd(8)}  ${String(v.pass).padStart(4)}  ${String(v.fail).padStart(4)}`);
console.log(`\n${results.length - failed.length}/${results.length} checks passed in ${Math.round((Date.now() - started) / 1000)}s`);
writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
process.exit(failed.length ? 1 : 0);
