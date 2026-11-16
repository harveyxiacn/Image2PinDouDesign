// 抠图模型离线化：安装时一次性下载 @imgly/background-removal-data@1.7.0 的数据包（固定版本 + SHA-256 校验），
// 只取 isnet_fp16 模型和 ONNX runtime（CPU/WASM）需要的文件放进 public/bg-model/，应用运行时不再访问任何第三方。
// 失败只打印一行警告并以 0 退出（不影响 npm install）；应用会照旧使用库默认的 CDN 地址。
// 环境变量 BG_ASSETS_SKIP=1 可跳过；BG_ASSETS_FORCE=1 强制重新下载。
import { createHash } from "node:crypto";
import {
  createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync
} from "node:fs";
import https from "node:https";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import zlib from "node:zlib";

export const DATA_VERSION = "1.7.0";
export const TGZ_URL = `https://staticimgly.com/@imgly/background-removal-data/${DATA_VERSION}/package.tgz`;
// 2026-11-16 在客户电脑上下载一次并计算；任何不一致都会拒绝使用。
export const TGZ_SHA256 = "a44fdaf4f3b06a952dcd9a61720bac1e6bc41392aa474e68863a2e54ca2d0df5";
export const TGZ_SIZE = 284706412;
const MAX_BYTES = 400 * 1024 * 1024;
const IDLE_TIMEOUT_MS = 30_000;
const TOTAL_TIMEOUT_MS = 10 * 60_000;
const MAX_REDIRECTS = 5;
// 应用默认（device: cpu）只需要这三项；GPU 版 jsep 与其它模型不下载。
export const WANTED_KEYS = [
  "/models/isnet_fp16",
  "/onnxruntime-web/ort-wasm-simd-threaded.wasm",
  "/onnxruntime-web/ort-wasm-simd-threaded.mjs"
];
export const MANIFEST_NAME = "manifest.json";
const CHUNK_NAME = /^[0-9a-f]{64}$/;

// tar 条目名：去掉 package/ 前缀，拒绝绝对路径、.. 、盘符、反斜杠、NUL。返回 posix 相对路径或 null。
export function sanitiseEntryName(raw) {
  if (typeof raw !== "string" || raw.length === 0 || raw.includes("\0") || raw.includes("\\")) return null;
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) return null;
  const parts = raw.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.length === 0 || parts.some((part) => part === "..")) return null;
  if (parts[0] === "package") parts.shift();
  return parts.length > 0 ? parts.join("/") : null;
}

// 按 resources.json 挑出所需键的块；返回精简后的 resources 与块文件名列表。缺键、块名异常都会抛错。
export function selectAssets(resources, keys = WANTED_KEYS) {
  if (!resources || typeof resources !== "object") throw new Error("resources.json 不是对象");
  const subset = {};
  const chunks = new Set();
  for (const key of keys) {
    const entry = resources[key];
    if (!entry || !Array.isArray(entry.chunks) || typeof entry.size !== "number") throw new Error(`resources.json 缺少 ${key}`);
    let total = 0;
    for (const chunk of entry.chunks) {
      if (!CHUNK_NAME.test(chunk?.name ?? "") || chunk.hash !== chunk.name) throw new Error(`${key} 含有异常的块名`);
      if (!Array.isArray(chunk.offsets) || chunk.offsets[1] <= chunk.offsets[0]) throw new Error(`${key} 块偏移异常`);
      total += chunk.offsets[1] - chunk.offsets[0];
      chunks.add(chunk.name);
    }
    if (total !== entry.size) throw new Error(`${key} 块大小之和与 size 不符`);
    subset[key] = entry;
  }
  return { resources: subset, chunks: [...chunks].sort() };
}

// 校验清单：manifest 描述的每个文件都必须存在、大小与哈希一致。actual 为 { 名称: { size, sha256 } }。返回问题列表（空 = 完整）。
export function manifestProblems(manifest, actual) {
  if (!manifest || manifest.format !== 1 || manifest.version !== DATA_VERSION || manifest.model !== "isnet_fp16" || !Array.isArray(manifest.files)) {
    return ["清单格式不符"];
  }
  const problems = [];
  const names = new Set(manifest.files.map((file) => file?.name));
  for (const needed of ["resources.json"]) if (!names.has(needed)) problems.push(`清单缺少 ${needed}`);
  for (const file of manifest.files) {
    const name = typeof file?.name === "string" ? file.name : "";
    if (name === "" || name !== sanitiseEntryName(name) || name.includes("/")) { problems.push(`非法文件名 ${name}`); continue; }
    const found = actual[name];
    if (!found) problems.push(`缺少 ${name}`);
    else if (found.size !== file.size) problems.push(`${name} 大小不符`);
    else if (found.sha256 !== file.sha256) problems.push(`${name} 哈希不符`);
  }
  return problems;
}

const sha256Of = (buffer) => createHash("sha256").update(buffer).digest("hex");

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file).on("data", (c) => hash.update(c)).on("error", reject).on("end", () => resolve(hash.digest("hex")));
  });
}

export async function verifyInstalled(dir) {
  const manifestPath = path.join(dir, MANIFEST_NAME);
  if (!existsSync(manifestPath)) return false;
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); } catch { return false; }
  if (!manifest || !Array.isArray(manifest.files)) return false;
  const actual = {};
  for (const file of manifest.files) {
    const name = typeof file?.name === "string" ? file.name : "";
    if (name !== sanitiseEntryName(name)) continue;
    const full = path.join(dir, ...name.split("/"));
    if (existsSync(full) && statSync(full).isFile()) actual[name] = { size: statSync(full).size, sha256: await sha256File(full) };
  }
  return manifestProblems(manifest, actual).length === 0;
}

function download(url, destination) {
  const origin = new URL(url).host;
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const attempt = (target, redirects) => {
      const parsed = new URL(target);
      if (parsed.protocol !== "https:" || parsed.host !== origin) return reject(new Error(`拒绝跳转到 ${parsed.protocol}//${parsed.host}`));
      const request = https.get(parsed, { headers: { "user-agent": "pindou-bg-assets" } }, (response) => {
        if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          if (redirects >= MAX_REDIRECTS) return reject(new Error("跳转次数过多"));
          return attempt(new URL(response.headers.location, parsed).toString(), redirects + 1);
        }
        if (response.statusCode !== 200) { response.resume(); return reject(new Error(`HTTP ${response.statusCode}`)); }
        const declared = Number(response.headers["content-length"] ?? 0);
        if (declared > MAX_BYTES) { response.resume(); return reject(new Error("文件超过大小上限")); }
        const hash = createHash("sha256");
        const out = createWriteStream(destination);
        let received = 0;
        response.on("data", (chunk) => {
          received += chunk.length;
          if (received > MAX_BYTES) { request.destroy(new Error("文件超过大小上限")); return; }
          if (Date.now() - started > TOTAL_TIMEOUT_MS) { request.destroy(new Error("下载总时长超时")); return; }
          hash.update(chunk);
        });
        response.pipe(out);
        out.on("finish", () => resolve({ size: received, sha256: hash.digest("hex") }));
        out.on("error", reject);
        response.on("error", reject);
      });
      request.setTimeout(IDLE_TIMEOUT_MS, () => request.destroy(new Error("连接超时")));
      request.on("error", reject);
    };
    attempt(url, 0);
  });
}

function parseOctal(buf) {
  const text = buf.toString("latin1").replace(/\0.*$/s, "").trim();
  return text ? parseInt(text, 8) : 0;
}

function parsePax(buf) {
  const out = {};
  let i = 0;
  while (i < buf.length) {
    const space = buf.indexOf(0x20, i);
    if (space < 0) break;
    const len = parseInt(buf.toString("latin1", i, space), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const record = buf.toString("utf8", space + 1, i + len - 1);
    const eq = record.indexOf("=");
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    i += len;
  }
  return out;
}

// 流式读取 .tgz；onEntry({name,size}) 返回 true 时才缓存内容并交给 onData(name, Buffer)。name 已经过 sanitiseEntryName；非法名称整条跳过。
export async function readTgz(file, onEntry, onData) {
  const stream = createReadStream(file).pipe(zlib.createGunzip());
  let pending = Buffer.alloc(0);
  let current = null; // { name, size, want, chunks, remaining, pad }
  let longName = null;
  let paxPath = null;
  for await (const chunk of stream) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    for (;;) {
      if (current) {
        const need = current.remaining + current.pad;
        if (pending.length === 0) break;
        const take = Math.min(need, pending.length);
        const body = Math.max(0, Math.min(take, current.remaining));
        if (current.want && body > 0) current.chunks.push(pending.subarray(0, body));
        current.remaining -= body;
        current.pad -= take - body;
        pending = pending.subarray(take);
        if (current.remaining + current.pad > 0) break;
        const done = current; current = null;
        if (done.meta) {
          const data = Buffer.concat(done.chunks);
          if (done.meta === "L") longName = data.toString("utf8").replace(/\0.*$/s, "");
          else paxPath = parsePax(data).path ?? null;
        } else if (done.want) await onData(done.name, Buffer.concat(done.chunks));
        continue;
      }
      if (pending.length < 512) break;
      const header = pending.subarray(0, 512);
      pending = pending.subarray(512);
      if (header.every((b) => b === 0)) continue;
      const size = parseOctal(header.subarray(124, 136));
      const type = String.fromCharCode(header[156] || 0x30);
      const prefix = header.toString("utf8", 345, 500).replace(/\0.*$/s, "");
      const base = header.toString("utf8", 0, 100).replace(/\0.*$/s, "");
      const rawName = paxPath ?? longName ?? (prefix ? `${prefix}/${base}` : base);
      const pad = (512 - (size % 512)) % 512;
      if (type === "L" || type === "x") { current = { meta: type, chunks: [], remaining: size, pad, want: true }; continue; }
      longName = null; paxPath = null;
      const name = type === "0" ? sanitiseEntryName(rawName) : null;
      const want = name !== null && onEntry({ name, size });
      current = { name, want, chunks: [], remaining: size, pad };
    }
  }
}

async function install(root) {
  const target = path.join(root, "public", "bg-model");
  if (process.env.BG_ASSETS_SKIP === "1") { console.log("[bg-assets] 已按 BG_ASSETS_SKIP 跳过"); return; }
  if (process.env.BG_ASSETS_FORCE !== "1" && await verifyInstalled(target)) { console.log("[bg-assets] 已就绪，跳过下载"); return; }
  const work = path.join(root, "public", ".bg-model-tmp");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const tgz = path.join(work, "package.tgz");
  try {
    console.log(`[bg-assets] 下载 ${TGZ_URL}（约 ${Math.round(TGZ_SIZE / 1048576)} MB，仅此一次）…`);
    const got = await download(TGZ_URL, tgz);
    if (got.sha256 !== TGZ_SHA256) throw new Error(`SHA-256 不符（${got.sha256}）`);
    let resourcesText = null;
    let licence = null;
    await readTgz(tgz, ({ name }) => name === "dist/resources.json" || name === "LICENSE.md", (name, data) => {
      if (name === "LICENSE.md") licence = data; else resourcesText = data.toString("utf8");
    });
    if (!resourcesText) throw new Error("数据包里没有 resources.json");
    const { resources, chunks } = selectAssets(JSON.parse(resourcesText));
    const wanted = new Set(chunks.map((name) => `dist/${name}`));
    const out = path.join(work, "out");
    mkdirSync(out, { recursive: true });
    const files = [];
    const emit = (name, data) => {
      writeFileSync(path.join(out, name), data);
      files.push({ name, size: data.length, sha256: sha256Of(data) });
    };
    const seen = new Set();
    await readTgz(tgz, ({ name }) => wanted.has(name), (name, data) => {
      const chunkName = name.slice("dist/".length);
      if (sha256Of(data) !== chunkName) throw new Error(`块 ${chunkName} 哈希不符`);
      seen.add(name);
      emit(chunkName, data);
    });
    if (seen.size !== wanted.size) throw new Error(`数据包缺少 ${wanted.size - seen.size} 个块`);
    emit("resources.json", Buffer.from(JSON.stringify(resources), "utf8"));
    if (licence) emit("LICENSE.md", licence);
    files.sort((a, b) => a.name.localeCompare(b.name));
    const manifest = { format: 1, version: DATA_VERSION, source: TGZ_URL, tgzSha256: TGZ_SHA256, model: "isnet_fp16", files };
    writeFileSync(path.join(out, MANIFEST_NAME), JSON.stringify(manifest, null, 1));
    rmSync(target, { recursive: true, force: true });
    renameSync(out, target);
    const total = files.reduce((sum, file) => sum + file.size, 0);
    console.log(`[bg-assets] -> ${path.relative(root, target)}（${files.length} 个文件，${(total / 1048576).toFixed(1)} MB）`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  install(root).catch((error) => {
    console.warn(`[bg-assets] 警告：没能准备本地抠图模型（${error?.message ?? error}）。应用仍可使用，复杂背景抠图会改用库默认的在线地址。`);
  }).finally(() => { process.exitCode = 0; });
}
