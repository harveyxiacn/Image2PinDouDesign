#!/usr/bin/env node
// 识别引擎评测：遍历图纸文件夹（默认 pindou-hub/拼豆图/），逐张跑 analyzePattern（图例 + 格内色号 OCR 全开，
// ocrSource = 原图），与 web/src/test/chart-truth.json 对照，打印表格与汇总，并把 JSON 写到 $TEMP/pindou-eval.json。
// 用法（在 pindou-hub 目录）：node scripts/eval-recognition.mjs [目录] [--only 关键字] [--truth 路径] [--out 路径] [--no-ocr] [--summarize 旧结果.json]
//       [--lowres F]  把每张图按面积平均缩到 F 倍（如 0.5 / 0.33）再以 JPEG 质量 60 重新编码，模拟“上传的是低清图”
//       [--enhance off|auto|force]  高清化模式（默认 auto）
// 图片和 truth 都不进仓库；本脚本经 vite 的 ssrLoadModule 直接加载 TS 源码（走同一套 @engine 别名）。
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const HUB = resolve(HERE, "..");
const IMG_EXT = new Set([".jpg", ".jpeg", ".png"]);
const PER_IMAGE_TIMEOUT_MS = 45_000;

export function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (IMG_EXT.has(extname(name).toLowerCase())) out.push(p);
  }
  return out;
}

export function loadTruth(path) {
  if (!path || !existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

/** 兼容几种 key：相对路径（/ 或 \）、文件名、不带扩展名的文件名。 */
export function findTruth(truth, rel) {
  if (!truth) return null;
  let map = truth.charts ?? truth;
  if (Array.isArray(map)) map = Object.fromEntries(map.map((e) => [e.file, e]));
  const posix = rel.replaceAll("\\", "/");
  const base = basename(posix);
  const stem = base.replace(/\.[^.]+$/, "");
  for (const k of [posix, rel, base, stem]) if (map[k]) return map[k];
  for (const [k, v] of Object.entries(map)) {
    const kk = k.replaceAll("\\", "/");
    if (kk.endsWith("/" + base) || kk.endsWith("/" + stem) || kk === stem) return v;
  }
  return null;
}

const norm = (mods, code) => (mods.normalizeCode ? mods.normalizeCode(code) : code);
const sumOf = (c) => Object.values(c ?? {}).reduce((a, b) => a + b, 0);

export function score(mods, rec, t) {
  const m = {};
  if (!t) return m;
  if (typeof t.isChart === "boolean") m.isChartOk = (rec.isChart !== false) === t.isChart;
  if (t.cols && t.rows) m.sizeOk = rec.cols === t.cols && rec.rows === t.rows;
  const truthTotal = t.statedTotal ?? t.total ?? t.legendSum ?? (t.legend ? sumOf(t.legend) : null);
  if (truthTotal && rec.total != null) m.totalOk = Math.abs(rec.total - truthTotal) / truthTotal <= 0.01;
  if (t.legend && Object.keys(t.legend).length) {
    const tl = {};
    for (const [k, v] of Object.entries(t.legend)) tl[norm(mods, k)] = v;
    const got = {};
    for (const [k, v] of Object.entries(rec.counts ?? {})) got[norm(mods, k)] = v;
    const codes = Object.keys(tl);
    m.codeExact = codes.filter((c) => (got[c] ?? 0) === tl[c]).length;
    m.codeTotal = codes.length;
    m.absErr = codes.reduce((a, c) => a + Math.abs((got[c] ?? 0) - tl[c]), 0) + Object.keys(got).filter((c) => !(c in tl)).reduce((a, c) => a + got[c], 0);
  }
  return m;
}

export function summarize(results, mods) {
  const folders = [...new Set(results.map((r) => (r.name.includes("/") ? r.name.split("/")[0] : "(根目录)")))];
  const parts = [summarizeOne(results, mods, "全部")];
  if (folders.length > 1) for (const f of folders) parts.push(summarizeOne(results.filter((r) => (r.name.includes("/") ? r.name.split("/")[0] : "(根目录)") === f), mods, f));
  return parts.join("\n\n");
}

function summarizeOne(results, mods, title) {
  const withTruth = results.filter((r) => r.truth);
  const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(0)}% (${a}/${b})` : "n/a");
  const lines = [`【${title}】${results.length} 张`];
  const sz = withTruth.filter((r) => r.metrics.sizeOk !== undefined);
  lines.push(`尺寸正确: ${pct(sz.filter((r) => r.metrics.sizeOk).length, sz.length)}`);
  const tt = withTruth.filter((r) => r.metrics.totalOk !== undefined);
  lines.push(`总数误差 ≤1%: ${pct(tt.filter((r) => r.metrics.totalOk).length, tt.length)}`);
  const ce = withTruth.filter((r) => r.metrics.codeTotal);
  lines.push(`色号用量完全一致: ${pct(ce.reduce((a, r) => a + r.metrics.codeExact, 0), ce.reduce((a, r) => a + r.metrics.codeTotal, 0))}`);
  const ic = withTruth.filter((r) => r.metrics.isChartOk !== undefined);
  lines.push(`是否图纸判断正确: ${pct(ic.filter((r) => r.metrics.isChartOk).length, ic.length)}`);
  const ms = results.map((r) => r.ms).sort((a, b) => a - b);
  lines.push(`用时: 中位 ${ms[ms.length >> 1] ?? 0} ms，最大 ${ms[ms.length - 1] ?? 0} ms，共 ${results.length} 张，其中有 truth ${withTruth.length} 张`);
  return lines.join("\n");
}

function table(results) {
  const pad = (s, n) => { s = String(s); let w = 0; for (const ch of s) w += ch.charCodeAt(0) > 255 ? 2 : 1; return s + " ".repeat(Math.max(0, n - w)); };
  const head = ["图", "尺寸(检测/真值)", "表头", "图纸", "总数(终/真)", "码对/码数", "方法", "置信", "ms"];
  const rows = results.map((r) => {
    const t = r.truth;
    return [
      r.name.slice(-22),
      `${r.cols ?? "-"}x${r.rows ?? "-"}/${t?.cols ?? "?"}x${t?.rows ?? "?"}${r.metrics.sizeOk === undefined ? "" : r.metrics.sizeOk ? " ✓" : " ✗"}`,
      r.header ? `${r.header.cols ?? "?"}x${r.header.rows ?? "?"}` : "-",
      r.isChart === false ? "非" : "是",
      `${r.total ?? "-"}/${t?.statedTotal ?? t?.legendSum ?? "?"}${r.metrics.totalOk === undefined ? "" : r.metrics.totalOk ? " ✓" : " ✗"}`,
      r.metrics.codeTotal ? `${r.metrics.codeExact}/${r.metrics.codeTotal}` : "-",
      r.method,
      r.confidence?.toFixed(2),
      r.ms
    ];
  });
  const widths = head.map((h, i) => Math.max(...[h, ...rows.map((x) => x[i])].map((s) => [...String(s)].reduce((a, ch) => a + (ch.charCodeAt(0) > 255 ? 2 : 1), 0))));
  return [head, ...rows].map((r) => r.map((c, i) => pad(c, widths[i])).join("  ")).join("\n");
}

export async function evaluate(mods, { dir, truth, only, ocr = true, lowres = 0, enhance = "auto", log = console.log }) {
  const backend = mods.createNodeOcrBackend?.();
  if (backend && mods.setOcrBackend) mods.setOcrBackend(backend);
  const jpeg = createRequire(join(HUB, "package.json"))("jpeg-js");
  const results = [];
  for (const file of walk(dir)) {
    const rel = relative(dir, file);
    if (only && !rel.replaceAll("\\", "/").includes(only)) continue;
    const rec = { name: rel.replaceAll("\\", "/"), file: rel };
    const t0 = performance.now();
    try {
      const buf = readFileSync(file);
      const full0 = extname(file).toLowerCase() === ".png"
        ? mods.decodePng(buf)
        : (() => { const j = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true }); return { width: j.width, height: j.height, data: new Uint8ClampedArray(j.data.buffer, j.data.byteOffset, j.data.length) }; })();
      let full = full0;
      if (lowres > 0 && lowres < 1) {
        const small = mods.downscaleArea(full0, Math.max(8, Math.round(Math.max(full0.width, full0.height) * lowres)));
        const enc = jpeg.encode({ width: small.width, height: small.height, data: Buffer.from(small.data.buffer, small.data.byteOffset, small.data.length) }, 60);
        const j = jpeg.decode(enc.data, { useTArray: true, formatAsRGBA: true });
        full = { width: j.width, height: j.height, data: new Uint8ClampedArray(j.data.buffer, j.data.byteOffset, j.data.length) };
      }
      const src = Math.max(full.width, full.height) > 2400 ? mods.downscaleArea(full, 2400) : full;
      rec.width = full.width; rec.height = full.height;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), PER_IMAGE_TIMEOUT_MS);
      let res;
      try { res = await mods.analyzePattern(src, { ocr, enhance, ocrSource: src === full ? undefined : full, signal: ac.signal }); }
      finally { clearTimeout(timer); }
      rec.ms = Math.round(performance.now() - t0);
      rec.cols = res.grid?.grid.cols ?? null;
      rec.rows = res.grid?.grid.rows ?? null;
      rec.isChart = res.isChart;
      rec.notChartReason = res.notChartReason;
      rec.header = res.header;
      rec.method = res.method;
      rec.confidence = res.confidence;
      rec.counts = res.counts;
      rec.total = sumOf(res.counts);
      rec.legendTotal = res.legend ? sumOf(res.legend.counts) : null;
      rec.paletteWarning = res.paletteWarning;
      rec.cellCodesRead = res.cellCodesRead;
      rec.legendCounts = res.legend?.counts ?? null;
      rec.bgCode = (res.grid?.clusters ?? []).filter((c) => c.cells.length && c.cells.some((i) => res.grid.backgroundMask?.[i])).map((c) => `${c.colorCode}/${c.code}:${c.cells.filter((i) => res.grid.backgroundMask[i]).length}`).join(" ");
      rec.bgInk = res.grid?.backgroundInkFrac ?? null;
      rec.legendPalette = res.legend?.palette?.map((p) => p.code).join(",") ?? null;
      rec.bgCells = res.grid?.backgroundCells ?? null;
      rec.bgAssigned = res.grid?.backgroundAssigned ?? null;
      rec.checks = res.checks ? `${res.checks.filter((c) => c.status === "ok").length}/${res.checks.filter((c) => c.legend !== null).length}` : null;
      rec.enhance = res.enhance ? `${res.enhance.method} x${Number(res.enhance.scale.toFixed(2))} ${res.enhance.level}` : null;
      rec.steps = res.steps.map((s) => `${s.status} ${s.label}: ${s.detail}`);
    } catch (err) {
      rec.ms = Math.round(performance.now() - t0);
      rec.error = String(err?.message ?? err);
      rec.method = "error";
      rec.confidence = 0;
    }
    rec.truth = findTruth(truth, rec.name);
    rec.metrics = score(mods, rec, rec.truth);
    results.push(rec);
    log(`  ${rec.name}  ${rec.ms} ms  ${rec.method}${rec.error ? "  ERROR " + rec.error : ""}`);
  }
  await mods.terminateOcr?.();
  return results;
}

async function loadViaVite() {
  const { createServer } = await import(pathToFileUrl(join(HUB, "node_modules/vite/dist/node/index.js")));
  const server = await createServer({
    configFile: join(HUB, "web/vite.config.ts"), root: join(HUB, "web"), appType: "custom", logLevel: "error",
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] }
  });
  const ld = (p) => server.ssrLoadModule(p);
  const [assistant, ocr, fx, legend] = await Promise.all([ld("/src/lib/recognize/assistant.ts"), ld("/src/lib/recognize/ocr.ts"), ld("/src/test/fixtures.ts"), ld("/src/lib/recognize/legend.ts")]);
  return {
    server,
    mods: {
      analyzePattern: assistant.analyzePattern, setOcrBackend: ocr.setOcrBackend, terminateOcr: ocr.terminateOcr,
      decodePng: fx.decodePng, downscaleArea: fx.downscaleArea, createNodeOcrBackend: fx.createNodeOcrBackend,
      normalizeCode: legend.normalizeCode
    }
  };
}
function pathToFileUrl(p) { return new URL(`file:///${p.replaceAll("\\", "/").replace(/^\//, "")}`).href; }

async function main() {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const dir = resolve(args.find((a, i) => !a.startsWith("--") && !["--only", "--truth", "--out", "--summarize", "--lowres", "--enhance"].includes(args[i - 1])) ?? join(HUB, "拼豆图"));
  const truthPath = opt("--truth") ?? join(HUB, "web/src/test/chart-truth.json");
  const truth = loadTruth(truthPath);
  const out = opt("--out") ?? join(tmpdir(), "pindou-eval.json");
  console.log(`目录 ${dir}；truth ${truth ? truthPath : "（无）"}`);
  const { server, mods } = await loadViaVite();
  try {
    let results;
    if (opt("--summarize")) {
      results = JSON.parse(readFileSync(opt("--summarize"), "utf8"));
      for (const r of results) { r.truth = findTruth(truth, r.name); r.metrics = score(mods, r, r.truth); }
    } else if (args.includes("--single")) {
      results = await evaluate(mods, { dir, truth, only: opt("--only"), ocr: !args.includes("--no-ocr"), lowres: Number(opt("--lowres") ?? 0), enhance: opt("--enhance") ?? "auto" });
    } else {
      // 每张图一个子进程：tesseract 的 wasm 在个别输入上会直接让 node 进程崩溃，隔离后只丢一张，其余照常
      results = [];
      for (const file of walk(dir)) {
        const rel = relative(dir, file).replaceAll("\\", "/");
        if (opt("--only") && !rel.includes(opt("--only"))) continue;
        const tmp = join(tmpdir(), `pindou-eval-one-${process.pid}.json`);
        const run = (extra) => spawnSync(process.execPath, [fileURLToPath(import.meta.url), dir, "--single", "--only", rel, "--truth", truthPath, "--out", tmp, ...(opt("--lowres") ? ["--lowres", opt("--lowres")] : []), ...(opt("--enhance") ? ["--enhance", opt("--enhance")] : []), ...extra], { encoding: "utf8", timeout: 120_000 });
        let r = run([]);
        let one = null;
        try { one = JSON.parse(readFileSync(tmp, "utf8")).find((x) => x.name === rel) ?? null; } catch { one = null; }
        if (!one) {
          // 崩溃：用不带 OCR 的结果兜底，并标注
          r = run(["--no-ocr"]);
          try { one = JSON.parse(readFileSync(tmp, "utf8")).find((x) => x.name === rel) ?? null; } catch { one = null; }
          if (one) { one.steps = [`warn OCR 崩溃（子进程退出码 ${r.status ?? "?"}），已退回无 OCR 的结果`, ...(one.steps ?? [])]; one.ocrCrashed = true; }
        }
        if (!one) one = { name: rel, file: rel, ms: 0, method: "error", confidence: 0, error: "子进程失败", truth: findTruth(truth, rel), metrics: {} };
        results.push(one);
        console.log(`  ${one.name}  ${one.ms} ms  ${one.method}${one.ocrCrashed ? "  (OCR 崩溃，无 OCR 兜底)" : ""}${one.error ? "  ERROR " + one.error : ""}`);
      }
    }
    console.log("\n" + table(results) + "\n\n" + summarize(results, mods));
    writeFileSync(out, JSON.stringify(results, null, 1));
    console.log(`\n结果已写入 ${out}`);
  } finally { await server.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
