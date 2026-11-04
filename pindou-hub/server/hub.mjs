#!/usr/bin/env node
// 拼豆仓 Hub：在家里任意一台电脑上运行，负责
//   1. 提供 Web 界面（同一局域网的电脑/平板浏览器直接打开）；
//   2. 作为同步中心：Web 端与 Android App 各自离线保存数据，连上 Hub 后双向合并；
//   3. 保存图片原件（按 SHA-256 内容寻址）；
//   4. 可选：把“图纸识别”转发给本机的 Ollama 视觉模型复核。
// 不需要账号、不连公网。局域网访问用 6 位配对码换取访问令牌。
import http from "node:http";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { openStore } from "./store.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "..");
const args = parseArgs(process.argv.slice(2));
const PORT = Number(args.port ?? process.env.PINDOU_PORT ?? 8787);
const HOST = String(args.host ?? process.env.PINDOU_HOST ?? "0.0.0.0");
const DATA_DIR = path.resolve(String(args.data ?? process.env.PINDOU_DATA ?? path.join(appRoot, "data")));
const DIST_DIR = path.resolve(String(args.dist ?? path.join(appRoot, "dist")));
const OLLAMA_URL = String(process.env.PINDOU_OLLAMA_URL ?? "http://127.0.0.1:11434").replace(/\/$/, "");
const VISION_MODEL = String(process.env.PINDOU_VISION_MODEL ?? "qwen2.5vl:7b");
const MAX_BLOB = 30 * 1024 * 1024;
const MAX_JSON = 20 * 1024 * 1024;
const VERSION = "0.1.0";

const BLOB_DIR = path.join(DATA_DIR, "blobs");
mkdirSync(BLOB_DIR, { recursive: true });
const config = loadConfig();
const store = openStore(DATA_DIR);

function parseArgs(list) {
  const out = {};
  for (let i = 0; i < list.length; i++) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(list[i]);
    if (!m) continue;
    out[m[1]] = m[2] ?? (list[i + 1] && !list[i + 1].startsWith("--") ? list[++i] : "true");
  }
  return out;
}

function loadConfig() {
  const file = path.join(DATA_DIR, "config.json");
  let current = {};
  if (existsSync(file)) {
    try { current = JSON.parse(readFileSync(file, "utf8")); } catch { current = {}; }
  }
  let changed = false;
  if (!current.token) { current.token = crypto.randomBytes(24).toString("base64url"); changed = true; }
  if (!/^\d{6}$/.test(current.pairCode ?? "")) { current.pairCode = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0"); changed = true; }
  if (!current.name) { current.name = `${os.hostname()} 的拼豆仓`; changed = true; }
  if (changed) {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(current, null, 2));
    renameSync(tmp, file);
  }
  return current;
}

function lanAddresses() {
  const list = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      // 跳过链路本地地址和 198.18.0.0/15（VPN/代理软件的 TUN 虚拟网卡常用，手机连不到）。
      if (entry.family === "IPv4" && !entry.internal && !entry.address.startsWith("169.254.") && !/^198\.(18|19)\./.test(entry.address)) {
        list.push({ name, address: entry.address, url: `http://${entry.address}:${PORT}` });
      }
    }
  }
  return list;
}

// ---------- helpers ----------
function isLoopback(req) {
  const a = req.socket.remoteAddress ?? "";
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ""));
  const right = Buffer.from(String(b ?? ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function authorized(req) {
  return safeEqual(req.headers["x-pindou-token"], config.token);
}

function setCors(req, res) {
  // 只有带令牌的请求能读写数据；CORS 放开是为了 Android App（http://localhost 源）跨源访问。
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin ?? "*");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", "content-type, x-pindou-token, x-pindou-device");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, OPTIONS");
  res.setHeader("Access-Control-Max-Age", "600");
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(text);
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("请求体过大"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const raw = await readBody(req, MAX_JSON);
  try { return JSON.parse(raw.toString("utf8") || "{}"); } catch { throw Object.assign(new Error("JSON 格式错误"), { status: 400 }); }
}

const pairFailures = new Map();
function pairLimited(ip) {
  const now = Date.now();
  const list = (pairFailures.get(ip) ?? []).filter((t) => now - t < 60_000);
  pairFailures.set(ip, list);
  return list.length >= 5;
}

const BLOB_RE = /^[a-f0-9]{64}$/;
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".webp": "image/webp", ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".wasm": "application/wasm", ".gz": "application/gzip", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8"
};

function serveStatic(req, res, urlPath) {
  if (!existsSync(DIST_DIR)) {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    res.end("Web 界面尚未构建：请先在 pindou-hub 目录运行 npm run build。API 已可用。");
    return;
  }
  let rel = decodeURIComponent(urlPath).replace(/^\/+/, "");
  let file = path.resolve(DIST_DIR, rel || "index.html");
  if (!file.startsWith(DIST_DIR)) { res.writeHead(403).end(); return; }
  if (!existsSync(file) || statSync(file).isDirectory()) {
    if (path.extname(rel)) { res.writeHead(404).end(); return; }
    file = path.join(DIST_DIR, "index.html");
  }
  const ext = path.extname(file).toLowerCase();
  const immutable = file.includes(`${path.sep}assets${path.sep}`);
  res.writeHead(200, {
    "content-type": MIME[ext] ?? "application/octet-stream",
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache"
  });
  if (req.method === "HEAD") { res.end(); return; }
  createReadStream(file).pipe(res);
}

async function putBlob(req, res, id) {
  const body = await readBody(req, MAX_BLOB);
  const digest = crypto.createHash("sha256").update(body).digest("hex");
  if (digest !== id) { sendJson(res, 400, { error: "内容哈希与 id 不一致" }); return; }
  const file = path.join(BLOB_DIR, id);
  if (!existsSync(file)) {
    const tmp = `${file}.${process.pid}.tmp`;
    const handle = await open(tmp, "w");
    try { await handle.writeFile(body); await handle.sync(); } finally { await handle.close(); }
    try { renameSync(tmp, file); } catch (error) { await unlink(tmp).catch(() => {}); if (!existsSync(file)) throw error; }
  }
  sendJson(res, 200, { ok: true, id, bytes: body.length });
}

function getBlob(req, res, id) {
  const file = path.join(BLOB_DIR, id);
  if (!existsSync(file)) { sendJson(res, 404, { error: "not found" }); return; }
  const size = statSync(file).size;
  res.writeHead(200, { "content-type": "application/octet-stream", "content-length": size, "cache-control": "private, max-age=31536000, immutable" });
  if (req.method === "HEAD") { res.end(); return; }
  createReadStream(file).pipe(res);
}

let aiCache = { at: 0, value: null };
async function aiStatus() {
  if (Date.now() - aiCache.at < 30_000 && aiCache.value) return aiCache.value;
  let value = { available: false, model: VISION_MODEL, url: OLLAMA_URL, reason: "" };
  try {
    const response = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(1500) });
    const tags = await response.json();
    const names = (tags.models ?? []).map((m) => m.name);
    value = { ...value, available: names.some((n) => n === VISION_MODEL || n.startsWith(`${VISION_MODEL}:`)), models: names };
    if (!value.available) value.reason = `Ollama 已运行，但未安装 ${VISION_MODEL}（ollama pull ${VISION_MODEL}）`;
  } catch {
    value.reason = "未检测到本机 Ollama（可选功能）";
  }
  aiCache = { at: Date.now(), value };
  return value;
}

const VISION_PROMPT = `你是拼豆（perler/fuse bead）图纸读图助手。图片是一张拼豆图纸，色号体系为 MARD（如 A1、B12、H7、M3、ZG2）。
任务：读出图纸中“每个色号需要多少颗”。如果图上有色号用量表/图例，逐项抄写；否则根据格子颜色和格内色号估算。
只输出 JSON：{"counts": {"色号": 数量}, "grid": {"width": 列数或null, "height": 行数或null}, "source": "legend" 或 "estimate", "notes": "简短说明"}。`;

async function aiVision(req, res) {
  const status = await aiStatus();
  if (!status.available) { sendJson(res, 503, { error: status.reason || "本地视觉模型不可用" }); return; }
  const body = await readJson(req);
  const image = String(body.imageBase64 ?? "").replace(/^data:[^,]+,/, "");
  if (!image) { sendJson(res, 400, { error: "缺少图片" }); return; }
  const hint = typeof body.hint === "string" ? `\n已知线索：${body.hint.slice(0, 2000)}` : "";
  const response = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(180_000),
    body: JSON.stringify({
      model: VISION_MODEL,
      stream: false,
      format: "json",
      options: { temperature: 0 },
      messages: [{ role: "user", content: VISION_PROMPT + hint, images: [image] }]
    })
  });
  if (!response.ok) { sendJson(res, 502, { error: `Ollama 返回 ${response.status}` }); return; }
  const result = await response.json();
  let parsed = null;
  try { parsed = JSON.parse(result.message?.content ?? ""); } catch { parsed = null; }
  sendJson(res, 200, { model: VISION_MODEL, result: parsed, raw: parsed ? undefined : String(result.message?.content ?? "").slice(0, 4000) });
}

// ---------- router ----------
async function handle(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }
  const url = new URL(req.url ?? "/", "http://hub.local");
  const p = url.pathname;

  if (!p.startsWith("/api/")) { serveStatic(req, res, p); return; }

  if (p === "/api/ping") {
    sendJson(res, 200, { app: "pindou-hub", name: config.name, version: VERSION, time: Date.now(), loopback: isLoopback(req) });
    return;
  }
  if (p === "/api/local-token") {
    // 只有在 Hub 本机上打开的页面能直接拿到令牌；局域网其他设备必须输入配对码。
    if (!isLoopback(req)) { sendJson(res, 403, { error: "仅限本机" }); return; }
    sendJson(res, 200, { token: config.token, pairCode: config.pairCode, name: config.name, addresses: lanAddresses() });
    return;
  }
  if (p === "/api/pair" && req.method === "POST") {
    const ip = req.socket.remoteAddress ?? "?";
    if (pairLimited(ip)) { sendJson(res, 429, { error: "尝试次数过多，请 1 分钟后再试" }); return; }
    const body = await readJson(req);
    if (!safeEqual(String(body.code ?? "").trim(), config.pairCode)) {
      pairFailures.get(ip)?.push(Date.now());
      sendJson(res, 401, { error: "配对码不正确" });
      return;
    }
    if (body.deviceId) store.touchDevice(body.deviceId, body.deviceName);
    sendJson(res, 200, { token: config.token, name: config.name });
    return;
  }

  if (!authorized(req)) { sendJson(res, 401, { error: "需要配对" }); return; }

  if (p === "/api/info") {
    sendJson(res, 200, { name: config.name, version: VERSION, addresses: lanAddresses(), stats: store.stats(), ai: await aiStatus() });
    return;
  }
  if (p === "/api/sync" && req.method === "POST") {
    const body = await readJson(req);
    const device = String(body.deviceId ?? req.headers["x-pindou-device"] ?? "unknown").slice(0, 80);
    store.touchDevice(device, body.deviceName);
    const incoming = Array.isArray(body.changes) ? body.changes : [];
    const accepted = store.applyChanges(incoming, device);
    const pulled = store.changesSince(body.since ?? 0, 2000);
    const have = new Set(Array.isArray(body.blobsHave) ? body.blobsHave.filter((id) => BLOB_RE.test(id)) : []);
    const missing = [...have].filter((id) => !existsSync(path.join(BLOB_DIR, id)));
    sendJson(res, 200, { accepted, ...pulled, blobsMissing: missing, serverTime: Date.now() });
    return;
  }
  const blobMatch = /^\/api\/blobs\/([a-f0-9]{64})$/.exec(p);
  if (blobMatch) {
    if (req.method === "PUT") { await putBlob(req, res, blobMatch[1]); return; }
    if (req.method === "GET" || req.method === "HEAD") { getBlob(req, res, blobMatch[1]); return; }
  }
  if (p === "/api/export") {
    res.setHeader("content-disposition", `attachment; filename="pindou-hub-${new Date().toISOString().slice(0, 10)}.json"`);
    sendJson(res, 200, { app: "pindou-hub", version: VERSION, exportedAt: Date.now(), records: store.exportAll() });
    return;
  }
  if (p === "/api/ai/status") { sendJson(res, 200, await aiStatus()); return; }
  if (p === "/api/ai/vision" && req.method === "POST") { await aiVision(req, res); return; }

  sendJson(res, 404, { error: "unknown endpoint" });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    if (!res.headersSent) sendJson(res, error.status ?? 500, { error: error.message ?? "服务器错误" });
    else res.end();
  });
});

server.listen(PORT, HOST, () => {
  const lines = [
    "",
    `  拼豆仓 Hub v${VERSION} 已启动  ·  ${config.name}`,
    `  本机打开:    http://localhost:${PORT}`,
    ...lanAddresses().map((a) => `  局域网(${a.name}): ${a.url}`),
    `  手机/其他设备配对码: ${config.pairCode}`,
    `  数据目录:    ${DATA_DIR}`,
    ""
  ];
  console.log(lines.join("\n"));
});

function shutdown() {
  server.close(() => { store.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
