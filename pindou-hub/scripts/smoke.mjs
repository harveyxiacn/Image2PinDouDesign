// 拼豆仓浏览器冒烟：用本机 Edge/Chrome headless + CDP（零依赖）走一遍真实界面并截图。
// 用法：node scripts/smoke.mjs <hubUrl> <outDir> <图纸图片> <照片>
// 浏览器路径：环境变量 BROWSER_PATH（默认 Windows Edge）。
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const [url, outDir, chartPath, photoPath, chartsArg] = process.argv.slice(2);
if (!url || !outDir || !chartPath || !photoPath) { console.error("用法：node scripts/smoke.mjs <url> <outDir> <chart> <photo>"); process.exit(2); }
mkdirSync(outDir, { recursive: true });
const profile = resolve(outDir, "profile");
// 真实图纸目录（拼豆图/数码暴龙|游戏王|chiikawa）：第 5 个参数、环境变量 CHARTS_DIR，或 cwd / cwd 上一级下的“拼豆图”
const chartsDir = [chartsArg, process.env.CHARTS_DIR, resolve("拼豆图"), resolve("..", "拼豆图")].find((d) => d && existsSync(d));
const realChart = (...parts) => { if (!chartsDir) throw new Error("找不到 拼豆图 目录（可用 CHARTS_DIR 指定）"); const f = resolve(chartsDir, ...parts); if (!existsSync(f)) throw new Error(`缺少测试图片 ${f}`); return f; };
rmSync(profile, { recursive: true, force: true });
const port = Number(process.env.CDP_PORT ?? 9347);
const browserPath = process.env.BROWSER_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const browser = spawn(browserPath, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
const checks = [];
let ws; let seq = 0; const pending = new Map();

async function connect() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* starting */ }
    await sleep(250);
  }
  throw new Error("browser CDP not reachable");
}
function send(method, params = {}, timeoutMs = 60000) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => {
    const timer = setTimeout(() => { pending.delete(id); rej(new Error(`CDP timeout ${method}`)); }, timeoutMs);
    pending.set(id, { res: (v) => { clearTimeout(timer); res(v); }, rej: (e) => { clearTimeout(timer); rej(e); } });
  });
}
async function evaluate(expression, timeoutMs) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
  if (r.exceptionDetails) throw new Error(`eval failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}
async function waitFor(expression, timeoutMs = 30000, label = expression) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { if (await evaluate(`!!(${expression})`)) return true; } catch { /* page navigating */ }
    await sleep(300);
  }
  throw new Error(`timeout waiting for ${label}`);
}
async function shot(name) {
  const metrics = await send("Page.getLayoutMetrics");
  const h = Math.min(6000, Math.ceil(metrics.cssContentSize?.height ?? 900));
  const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: viewport.width, height: Math.max(h, viewport.height), scale: 1 } });
  writeFileSync(resolve(outDir, `${name}.png`), Buffer.from(r.data, "base64"));
}

const AUDIT = `(() => {
  const name = (el) => (el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || el.value || el.textContent || '').trim();
  const visible = (el) => el.offsetParent !== null || el.getClientRects().length > 0;
  const issues = [];
  document.querySelectorAll('button, a[href], [role=button]').forEach((el) => { if (visible(el) && !name(el) && !el.querySelector('img[alt]:not([alt=""])')) issues.push('unnamed ' + el.tagName + ' ' + (el.className || '')); });
  document.querySelectorAll('input:not([type=hidden]):not([type=file]), select, textarea').forEach((el) => {
    if (!visible(el)) return;
    const labelled = el.labels?.length || el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('placeholder');
    if (!labelled) issues.push('unlabelled ' + el.tagName + ' ' + (el.name || el.type));
  });
  document.querySelectorAll('img').forEach((el) => { if (!el.hasAttribute('alt')) issues.push('img without alt'); });
  const h1 = document.querySelectorAll('main h1').length;
  if (h1 !== 1) issues.push('main h1 count ' + h1);
  return issues;
})()`;
const CONTRAST = `(() => {
  const css = getComputedStyle(document.documentElement);
  const hex = (v) => { v = v.trim(); if (v.startsWith('#')) { const n = parseInt(v.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; } const m = v.match(/[\\d.]+/g).map(Number); return m.slice(0, 3); };
  const lum = (c) => { const [r, g, b] = c.map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (a, b) => { const [x, y] = [lum(hex(css.getPropertyValue(a))), lum(hex(css.getPropertyValue(b)))].sort((p, q) => q - p); return +((x + 0.05) / (y + 0.05)).toFixed(2); };
  return { ink_paper: ratio('--ink', '--paper'), ink2_paper: ratio('--ink-2', '--paper'), ink3_paper: ratio('--ink-3', '--paper'), ink3_raised: ratio('--ink-3', '--paper-raised'), ink3_sunk: ratio('--ink-3', '--paper-sunk'), iron_paper: ratio('--iron', '--paper'), white_on_iron: ratio('--paper-lift', '--iron'), ironink_raised: ratio('--iron-ink', '--paper-raised'), leaf_raised: ratio('--leaf', '--paper-raised'), amber_raised: ratio('--amber', '--paper-raised') };
})()`;
let viewport = { width: 1366, height: 900 };
async function setViewport(width, height, mobile = false) {
  viewport = { width, height };
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
  await send("Emulation.setTouchEmulationEnabled", { enabled: mobile });
}
async function go(hash) {
  await evaluate(`location.hash = ${JSON.stringify(hash)}`);
  await sleep(900);
  await waitFor(`!document.querySelector('[aria-busy="true"]')`, 15000, `page ${hash}`);
}
async function noHorizontalScroll(name) {
  const over = await evaluate(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
  checks.push({ check: `no horizontal scroll: ${name} @${viewport.width}`, ok: over <= 1, detail: `overflow ${over}px` });
}
async function setFile(path, selector = 'input[type="file"]') {
  const paths = Array.isArray(path) ? path : [path];
  const doc = await send("DOM.getDocument", { depth: -1, pierce: true });
  const q = await send("DOM.querySelector", { nodeId: doc.root.nodeId, selector });
  if (!q.nodeId) throw new Error("file input not found");
  await send("DOM.setFileInputFiles", { nodeId: q.nodeId, files: paths });
}
async function clickText(text, selector = "button") {
  const ok = await evaluate(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(b => b.innerText.trim().startsWith(${JSON.stringify(text)}) && !b.disabled); if (!el) return false; el.scrollIntoView({block:"center"}); el.focus(); el.click(); return true; })()`);
  if (!ok) throw new Error(`button not found/enabled: ${text}`);
}

// ---- 缩放 / 核对 / 对比 辅助 ----
const VK = { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Escape: 27, Home: 36, End: 35 };
async function pressKey(k, modifiers = 0) {
  const vk = VK[k];
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code: vk ? k : undefined, windowsVirtualKeyCode: vk, text: k.length === 1 ? k : undefined, modifiers });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: vk ? k : undefined, windowsVirtualKeyCode: vk, modifiers });
}
async function clickAt(x, y, count = 1) {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  for (let i = 0; i < count; i++) {
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: i + 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: i + 1 });
  }
}
const zscale = () => evaluate(`+document.querySelector('.pt-zoom-box').dataset.scale`);
const zpct = () => evaluate(`document.querySelector('[data-testid=zoom-pct]').innerText`);
const gridCenter = () => evaluate(`(() => { const b = document.querySelector('.pt-zoom-box'); b.scrollIntoView({block:'center'}); const r = document.querySelector('.pt-ov-lines').getBoundingClientRect(); const br = b.getBoundingClientRect(); return { x: Math.max(br.left + 10, Math.min(br.right - 10, r.left + r.width / 2)), y: Math.max(br.top + 10, Math.min(br.bottom - 10, r.top + r.height / 2)) }; })()`);
const inspectorText = () => evaluate(`document.querySelector('[data-testid=cell-inspector]')?.innerText ?? ''`);
async function zoomFit() { await clickText("适应", ".pt-zoom button").catch(() => {}); await sleep(250); }
/** 缩放 4×并点选一个非空格子，返回核对面板文字 */
async function zoomAndInspect() {
  await zoomFit();
  const p = await gridCenter();
  await clickAt(p.x, p.y, 2); // 双击放大（以该点为中心）
  await sleep(700);
  let txt = "";
  for (const [dx, dy] of [[0, 0], [30, 0], [-30, 0], [0, 30], [60, 40], [-60, -40], [90, 0], [0, -60]]) {
    await clickAt(p.x + dx, p.y + dy);
    await sleep(500);
    txt = await inspectorText();
    if (/[A-Z]+\d+/.test(txt.replace(/行 \d+ · 列 \d+/, ""))) break;
    await sleep(350);
  }
  return txt.replace(/\n/g, " ");
}

async function step(name, fn) {
  const t = Date.now();
  try { const detail = await fn(); checks.push({ check: name, ok: true, ms: Date.now() - t, detail }); }
  catch (e) { checks.push({ check: name, ok: false, ms: Date.now() - t, detail: String(e.message ?? e) }); await shot(`fail-${name.replace(/[^\w-]+/g, "_")}`).catch(() => {}); }
}

try {
  ws = new WebSocket(await connect());
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result); return; }
    if (msg.method === "Runtime.exceptionThrown") errors.push({ type: "exception", text: msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text });
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") errors.push({ type: "console", text: msg.params.args.map((a) => a.value ?? a.description).join(" ") });
    // tesseract 的 chi_sim 训练数据带有 LSTM-only 内核不认识的旧引擎参数，加载时会打印 "Warning: Parameter not found: …"，无害，不算错误
    if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error" && !/^Warning: Parameter not found: /.test(msg.params.entry.text ?? "")) errors.push({ type: "log", text: `${msg.params.entry.text} ${msg.params.entry.url ?? ""}` });
  };
  await send("Page.enable"); await send("Runtime.enable"); await send("Log.enable"); await send("DOM.enable");
  await setViewport(1366, 900);
  await send("Page.navigate", { url });
  await waitFor(`document.querySelector(".shell") && !document.querySelector('[aria-busy="true"]')`, 30000, "app shell");
  await sleep(1500);

  await step("empty dashboard renders", async () => { await shot("01-dashboard-empty"); return (await evaluate("document.querySelector('main').innerText")).slice(0, 160); });
  await step("auto-paired with local hub", async () => {
    await waitFor(`document.querySelector(".sync-dot.idle")`, 45000, "sync idle");
    return await evaluate(`document.querySelector(".rail-foot").innerText`);
  });

  // ---- 批量入库（让库存与采购有数据） ----
  await step("batch purchase via inventory", async () => {
    await go("#/inventory");
    await clickText("批量入库").catch(async () => clickText("入库"));
    await sleep(500);
    const filled = await evaluate(`(() => { const ta = document.querySelector('.sheet textarea'); if (!ta) return false; const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(ta, 'A26 3000, B19 1000, H7 500, A1×200, F11 300, ZG1 100'); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    if (!filled) throw new Error("paste textarea not found in batch sheet");
    await sleep(300);
    await clickText("加入下面的列表", ".sheet button");
    await sleep(500);
    await shot("02-batch-entry");
    const btn = await evaluate(`(() => { const b = [...document.querySelectorAll('.sheet button')].find(b => /^入库 \\d/.test(b.innerText.trim()) && !b.disabled); if (!b) return null; const t = b.innerText; b.click(); return t; })()`);
    if (!btn) throw new Error("confirm button not found");
    await sleep(1200);
    const stock = await evaluate(`document.querySelector('main').innerText.includes('3,000') || document.querySelector('main').innerText.includes('3000')`);
    await shot("03-inventory");
    if (!stock) throw new Error("A26 3000 not visible after purchase");
    return `clicked ${btn}`;
  });

  // ---- 识别图纸 ----
  let recognizedText = "";
  let recognizedHash = "";
  await step("recognize chart (legend + grid)", async () => {
    await go("#/add?mode=recognize");
    await setFile(chartPath);
    await waitFor(`[...document.querySelectorAll('button')].some(b => b.innerText.trim() === '重新识别' && !b.disabled) && [...document.querySelectorAll('button[type=submit]')].some(b => b.innerText.includes('保存到图库'))`, 240000, "recognition done");
    await sleep(800);
    await shot("04-recognize-result");
    recognizedText = await evaluate("document.querySelector('main').innerText");
    if (!/格内色号 [\d,]+\/[\d,]+ (色|格)/.test(recognizedText)) throw new Error("in-cell code chip missing");
    if (!recognizedText.includes("11,128")) throw new Error("total 11,128 not shown");
    return recognizedText.match(/读取格内色号[^\n]*\n[^\n]*/)?.[0] ?? recognizedText.slice(0, 400);
  });
  // ---- 信任工具：色号高亮 / 复原预览 / 图上标注 ----
  await step("color highlight toggles on the analysis image", async () => {
    const overlayInk = `(() => { const svg = document.querySelector('svg.pt-over'); if (!svg) return -1; return [...svg.children].map((c) => c.getAttribute('class') + ':' + (c.getAttribute('d')?.length ?? 0)).join('|'); })()`;
    const before = await evaluate(overlayInk);
    const picked = await evaluate(`(() => { const b = document.querySelector('.pt-counts .pt-pick'); if (!b) return null; b.scrollIntoView({block:'center'}); b.click(); return b.getAttribute('aria-label'); })()`);
    if (!picked) throw new Error("no pickable colour row (grid matrix missing?)");
    await sleep(500);
    const rows = await evaluate(`document.querySelectorAll('.pt-counts tr[data-focus="true"]').length`);
    const chip = await evaluate(`[...document.querySelectorAll('.chip-iron')].some(c => c.innerText.startsWith('高亮'))`);
    const during = await evaluate(overlayInk);
    await shot("04b-highlight");
    if (rows !== 1 || !chip) throw new Error(`focus row=${rows} chip=${chip}`);
    if (during === before) throw new Error(`overlay unchanged (${before})`);
    await evaluate(`document.querySelector('.pt-counts .pt-pick[aria-pressed="true"]').click()`);
    await sleep(400);
    const off = await evaluate(`document.querySelectorAll('.pt-counts tr[data-focus="true"]').length`);
    const after = await evaluate(overlayInk);
    if (off !== 0 || after !== before) throw new Error(`not restored: rows=${off} ink ${before}->${after}`);
    return `${picked}: overlay ink ${before} -> ${during} -> ${after}`;
  });
  await step("restored preview toggle shows the recognised bead chart", async () => {
    await clickText("复原预览");
    await waitFor(`document.querySelector('.pt-matrix canvas')`, 5000, "matrix canvas");
    await sleep(500);
    await shot("04c-restored");
    const dims = await evaluate(`(() => { const c = document.querySelector('.pt-matrix canvas'); return c.width + 'x' + c.height; })()`);
    await clickText("原图", ".seg button");
    return `restored canvas ${dims}`;
  });
  // ---- 缩放组件 / 格子核对（桌面，真实识别结果） ----
  await step("zoom: buttons change scale and readout; 1:1; fit", async () => {
    await evaluate(`document.querySelector('.pt-zoom-box').scrollIntoView({block:'center'})`);
    await sleep(400);
    const p0 = await zpct(), s0 = await zscale();
    await clickText("+", ".pt-zoom button"); await sleep(350);
    const p1 = await zpct(), s1 = await zscale();
    if (!(s1 > s0 * 1.2) || p0 === p1) throw new Error(`+ did not zoom: ${p0}/${s0} -> ${p1}/${s1}`);
    await clickText("1:1", ".pt-zoom button"); await sleep(350);
    const s2 = await zscale();
    const want = await evaluate(`(() => { const b = document.querySelector('.pt-zoom-box'); const i = b.querySelector('img'); return i.naturalWidth / b.getBoundingClientRect().width; })()`);
    const pct2 = await zpct();
    if (Math.abs(s2 - want) > 0.03 * want + 0.02 || pct2.trim() !== "100%") throw new Error(`1:1 scale ${s2} want ${want} pct ${pct2}`);
    const px = await evaluate(`document.querySelector('.pt-zoom-box').dataset.pixel`);
    await clickText("适应", ".pt-zoom button"); await sleep(350);
    const s3 = await zscale();
    if (Math.abs(s3 - 1) > 0.01) throw new Error("fit did not restore 1");
    const max = await evaluate(`(() => { const b = document.querySelector('.pt-zoom-box'); const i = b.querySelector('img'); return Math.min(96, Math.max(8, 24 * i.naturalWidth / b.getBoundingClientRect().width)); })()`);
    return `pct ${p0} -> ${p1}; 1:1 scale ${s2.toFixed(2)} (pct ${pct2}, pixelated=${px}); fit ${s3}; max scale ~${max.toFixed(0)}`;
  });
  await step("zoom: double-click zooms in at the point and back to fit", async () => {
    const p = await gridCenter();
    await clickAt(p.x, p.y, 2); await sleep(500);
    const s1 = await zscale();
    if (Math.abs(s1 - 4) > 0.2) throw new Error("double click scale " + s1);
    await clickAt(p.x, p.y, 2); await sleep(500);
    const s2 = await zscale();
    if (Math.abs(s2 - 1) > 0.01) throw new Error("second double click did not fit: " + s2);
    return `1 -> ${s1.toFixed(2)} -> ${s2}`;
  });
  await step("zoom: wheel needs Ctrl (plain wheel never zooms)", async () => {
    const p = await gridCenter();
    await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: p.x, y: p.y, deltaX: 0, deltaY: -120 });
    await sleep(300);
    const s1 = await zscale();
    const p2 = await gridCenter();
    await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: p2.x, y: p2.y, deltaX: 0, deltaY: -240, modifiers: 2 });
    await sleep(300);
    const s2 = await zscale();
    if (Math.abs(s1 - 1) > 0.01) throw new Error("plain wheel zoomed: " + s1);
    if (!(s2 > 1.2)) throw new Error("ctrl+wheel did not zoom: " + s2);
    await zoomFit();
    return `plain ${s1} · ctrl ${s2.toFixed(2)}`;
  });
  await step("zoom: keyboard + - 1 0 / arrows pan", async () => {
    await evaluate(`document.querySelector('.pt-zoom-box').focus()`);
    await pressKey("+"); await pressKey("+"); await sleep(400);
    const a = await zscale();
    if (!(a > 1.4)) throw new Error("+ key scale " + a);
    await pressKey("1"); await sleep(400);
    const one = await zpct();
    if (one.trim() !== "100%") throw new Error("1 key did not give 100%: " + one);
    const before = await evaluate(`document.querySelector('.pt-zoom-inner').style.transform`);
    await pressKey("ArrowRight"); await sleep(400);
    const after = await evaluate(`document.querySelector('.pt-zoom-inner').style.transform`);
    if (before === after) throw new Error("arrow did not pan: " + before);
    await pressKey("-"); await sleep(300);
    await pressKey("0"); await sleep(400);
    const f = await zscale();
    if (Math.abs(f - 1) > 0.01) throw new Error("0 key did not fit: " + f);
    return `+ + -> ${a.toFixed(2)}; 1 -> ${one}; arrow panned; 0 -> fit`;
  });
  await step("cell inspector: tap shows row/col, sampled colour, code, total; arrow keys move the cell", async () => {
    const txt = await zoomAndInspect();
    await shot("04d-zoomed-inspector");
    if (!/行 \d+ · 列 \d+/.test(txt)) throw new Error("inspector not open: " + txt);
    if (!/#[0-9a-f]{6}/i.test(txt)) throw new Error("no sampled hex: " + txt);
    const hasCode = /\b[A-Z]{1,2}\d{1,2}\b/.test(txt);
    if (!hasCode) throw new Error("no recognised code in inspector: " + txt);
    if (!/\d+ 颗/.test(txt)) throw new Error("no total in inspector: " + txt);
    const col = (t) => Number(t.match(/列 (\d+)/)[1]);
    await evaluate(`document.querySelector('.pt-zoom-box').focus()`);
    await pressKey("ArrowRight"); await sleep(400);
    const t2 = await inspectorText();
    if (col(t2) !== col(txt) + 1) throw new Error(`ArrowRight: col ${col(txt)} -> ${col(t2)}`);
    await pressKey("Escape"); await sleep(300);
    if (await inspectorText()) throw new Error("Esc did not close inspector");
    const sc = await zscale();
    if (sc < 3) throw new Error("first Esc must only close the inspector, scale is " + sc);
    await zoomFit();
    return txt.slice(0, 150);
  });
  await step("tap vs drag: dragging pans, does not open the inspector", async () => {
    const p = await gridCenter();
    await clickAt(p.x, p.y, 2); await sleep(500);
    const t0 = await evaluate(`document.querySelector('.pt-zoom-inner').style.transform`);
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: "left", buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 6; i++) await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x - i * 12, y: p.y, button: "left", buttons: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x - 72, y: p.y, button: "left", buttons: 0, clickCount: 1 });
    await sleep(400);
    const t1 = await evaluate(`document.querySelector('.pt-zoom-inner').style.transform`);
    const open = await inspectorText();
    await zoomFit();
    if (t0 === t1) throw new Error("drag did not pan");
    if (open) throw new Error("drag opened the inspector");
    return "dragged 72px: panned, inspector stayed closed";
  });
  await step("region select mode: dragging draws the region instead of panning", async () => {
    await clickText("框选图纸区域");
    const p = await gridCenter();
    const t0 = await evaluate(`document.querySelector('.pt-zoom-inner').style.transform`);
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x - 80, y: p.y - 60 });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x - 80, y: p.y - 60, button: "left", buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 6; i++) await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x - 80 + i * 25, y: p.y - 60 + i * 20, button: "left", buttons: 1 });
    const drawing = await evaluate(`!!document.querySelector('.pt-ov-region')`);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x + 70, y: p.y + 60, button: "left", buttons: 0, clickCount: 1 });
    await sleep(300);
    const t1 = await evaluate(`document.querySelector('.pt-zoom-inner').style.transform`);
    const kept = await evaluate(`!!document.querySelector('.pt-ov-region')`);
    await clickText("清除框选").catch(() => {});
    await clickText("拖动框选中").catch(() => {});
    if (!drawing || !kept) throw new Error(`region not drawn (drawing=${drawing} kept=${kept})`);
    if (t0 !== t1) throw new Error("view moved while selecting");
    return "region drawn, view unchanged";
  });
  // 为 HD 流程准备一张“糊图”：把当前预览图缩小 + 重压缩
  const degradedPath = resolve(outDir, "degraded.jpg");
  await step("make a degraded upload for the HD flow", async () => {
    const b64 = await evaluate(`new Promise((res) => { const img = document.querySelector('.pt-stage img'); const c = document.createElement('canvas'); const k = 360 / img.naturalWidth; c.width = 360; c.height = Math.round(img.naturalHeight * k); const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(img, 0, 0, c.width, c.height); c.toBlob((b) => { const f = new FileReader(); f.onload = () => res(String(f.result).split(',')[1]); f.readAsDataURL(b); }, 'image/jpeg', 0.35); })`);
    writeFileSync(degradedPath, Buffer.from(b64, "base64"));
    return `${Math.round(b64.length * 0.75 / 1024)} KB`;
  });
  await step("header info vs read chips (if the engine fills header)", async () => {
    const t = await evaluate(`document.querySelector('.pt-header')?.innerText ?? ''`);
    return t ? t.replace(/\n/g, " ") : "header not provided by engine (skipped)";
  });
  await step("save recognized pattern", async () => {
    await evaluate(`(() => { const f = document.querySelector('form'); const s = f.querySelector('[aria-pressed]') ; const btns=[...f.querySelectorAll('button[type=button]')]; const plan = btns.find(b => b.innerText.includes('计划拼')); plan?.click(); })()`);
    await sleep(200);
    await clickText("保存到图库", "button[type=submit]");
    await waitFor(`document.querySelector('.pt-save[data-success="true"]') || location.hash.startsWith("#/pattern/")`, 30000, "save success state");
    await waitFor(`location.hash.startsWith("#/pattern/")`, 60000, "pattern detail");
    await sleep(1200);
    await shot("05-pattern-detail");
    recognizedHash = await evaluate("location.hash");
    return recognizedHash;
  });

  // ---- 图库详情：编辑格子（橡皮点击 + 拖动）→ 保存 → 用量减少且变为未核对；色号标注 ----
  await step("gallery detail: erase cells, save, codes toggle", async () => {
    await go(recognizedHash || "#/gallery");
    await waitFor(`[...document.querySelectorAll('button')].some(b => b.innerText.trim().startsWith('编辑格子'))`, 15000, "编辑格子 button");
    const totalOf = () => evaluate(`(() => { const m = (document.querySelector('.pd-controls')?.innerText ?? '').match(/([\\d,]+) 颗/); return m ? Number(m[1].replace(/,/g, '')) : -1; })()`);
    const before = await totalOf();
    await clickText("编辑格子");
    await waitFor(`document.querySelector('.me .me-bar [aria-pressed="true"]')?.innerText.trim() === '橡皮'`, 10000, "editor open with eraser");
    const wrapRect = async () => evaluate(`(() => { const w = document.querySelector('.me .pt-matrix-scroll'); w.scrollIntoView({block:'center'}); const r = w.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
    await sleep(300);
    const r = await wrapRect();
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    await clickAt(cx, cy); // 单点
    for (const dy of [-12, 0, 12]) { // 三条拖动
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: cx - 40, y: cy + dy });
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x: cx - 40, y: cy + dy, button: "left", buttons: 1, clickCount: 1 });
      for (let i = 1; i <= 8; i++) await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: cx - 40 + i * 10, y: cy + dy, button: "left", buttons: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: cx + 40, y: cy + dy, button: "left", buttons: 0, clickCount: 1 });
    }
    await sleep(300);
    const footer = await evaluate(`document.querySelector('.me-foot')?.innerText ?? ''`);
    if (!/已改 \d+ 格/.test(footer)) throw new Error(`no cells erased: ${footer}`);
    await clickText("保存修改");
    await waitFor(`!document.querySelector('.me')`, 15000, "editor closed after save");
    await sleep(600);
    const after = await totalOf();
    const page = await evaluate(`document.querySelector('main').innerText`);
    if (!(after >= 0 && before >= 0 && after < before)) throw new Error(`total not decreased: ${before} -> ${after}`);
    if (!page.includes("标为已核对")) throw new Error("pattern not shown as unverified");
    if (!/已手动修改 \d+ 格/.test(page)) throw new Error("review reason missing");
    // 色号标注
    const on = await evaluate(`(() => { const i = document.querySelector('.pt-codes-toggle input'); if (!i) return null; if (!i.checked) i.click(); return true; })()`);
    if (!on) throw new Error("显示色号 toggle missing");
    for (let i = 0; i < 25; i++) {
      if (await evaluate(`document.querySelector('.pt-matrix')?.dataset.codes === 'on'`)) break;
      await evaluate(`document.querySelector('.pt-matrix-tools button[aria-label="放大"]').click()`);
      await sleep(150);
    }
    await waitFor(`document.querySelector('.pt-matrix')?.dataset.codes === 'on'`, 5000, "data-codes=on after zoom");
    await shot("05b-pattern-codes");
    return `total ${before} -> ${after}; codes on`;
  });

  // ---- 生成图纸 ----
  await step("generate pattern from photo", async () => {
    await go("#/add?mode=generate");
    await clickText("换一张").catch(() => {});
    await sleep(300);
    await setFile(photoPath);
    await sleep(1500);
    await clickText("生成图纸", "button.btn-iron");
    await waitFor(`[...document.querySelectorAll('button')].some(b => b.innerText.startsWith('重新生成'))`, 180000, "generation done");
    await sleep(800);
    await shot("06-generate-result");
    await clickText("保存到图库", "button[type=submit]");
    await waitFor(`location.hash.startsWith("#/pattern/")`, 60000, "generated pattern saved");
    await sleep(1200);
    await shot("07-generated-detail");
    return await evaluate("location.hash");
  });

  // ---- 高清化 UI：糊图上传 → 卡片 / 对比滑块 / 下载 / 开关（引擎没有放大时只验证卡片与开关） ----
  await step("HD card: degraded upload, toggle persists, compare slider", async () => {
    await go("#/add?mode=recognize");
    await clickText("换一张").catch(() => {});
    await sleep(300);
    await setFile(degradedPath);
    await waitFor(`document.querySelector('[data-testid=enhance-card]')?.dataset.state === 'done' && [...document.querySelectorAll('button')].some(b => b.innerText.trim() === '重新识别' && !b.disabled)`, 240000, "hd card done + recognition finished");
    await sleep(600);
    await shot("21-hd-card");
    const card = await evaluate(`document.querySelector('[data-testid=enhance-card]').innerText.replace(/\\n/g, ' ')`);
    const applied = await evaluate(`document.querySelector('[data-testid=enhance-card]').dataset.applied === 'true'`);
    const tl = await evaluate(`[...document.querySelectorAll('.pt-steps li')].map(l => l.innerText.replace(/\\n/g, ' / ')).join(' || ')`);
    let note = "stub: engine did not enhance → compare slider not exercised";
    if (applied) {
      await waitFor(`document.querySelector('.pt-zoom-box img')`, 8000, "hd image");
      await clickText("对比", ".pt-enh .seg button");
      await waitFor(`document.querySelector('[role=slider][aria-label*=对比]')`, 5000, "compare slider");
      await sleep(400);
      const v0 = await evaluate(`+document.querySelector('[role=slider][aria-label*=对比]').getAttribute('aria-valuenow')`);
      await evaluate(`document.querySelector('[role=slider][aria-label*=对比]').focus()`);
      await pressKey("ArrowRight"); await pressKey("ArrowRight"); await pressKey("ArrowRight");
      await sleep(200);
      const v1 = await evaluate(`+document.querySelector('[role=slider][aria-label*=对比]').getAttribute('aria-valuenow')`);
      await pressKey("ArrowLeft", 8); await sleep(200);
      const v2 = await evaluate(`+document.querySelector('[role=slider][aria-label*=对比]').getAttribute('aria-valuenow')`);
      const clip = await evaluate(`document.querySelector('.pt-cmp-top').style.clipPath`);
      await shot("22-compare");
      if (!(v1 > v0) || !(v2 < v1)) throw new Error(`slider keys: ${v0} -> ${v1} -> ${v2}`);
      // 拖动手柄
      const k = await evaluate(`(() => { const r = document.querySelector('[role=slider][aria-label*=对比]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: k.x, y: k.y });
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x: k.x, y: k.y, button: "left", buttons: 1, clickCount: 1 });
      for (let i = 1; i <= 5; i++) await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: k.x + i * 20, y: k.y, button: "left", buttons: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: k.x + 100, y: k.y, button: "left", buttons: 0, clickCount: 1 });
      await sleep(250);
      const v3 = await evaluate(`+document.querySelector('[role=slider][aria-label*=对比]').getAttribute('aria-valuenow')`);
      if (!(v3 > v2 + 5)) throw new Error(`drag did not move slider: ${v2} -> ${v3}`);
      const dl = await evaluate(`[...document.querySelectorAll('button')].some(b => b.innerText.includes('下载高清图'))`);
      if (!dl) throw new Error("no download button");
      note = `slider ${v0} -> ${v1} -> ${v2} -> drag ${v3}; clip ${clip}; download button present`;
    }
    // 开关：关 → 无高清、记住；再开
    await clickText("关", ".pt-enh .seg button");
    await waitFor(`document.querySelector('[data-testid=enhance-card]').dataset.state === 'off'`, 5000, "hd off");
    const stored = await evaluate(`localStorage.getItem('pindou.hdMode')`);
    if (stored !== "off") throw new Error("hd mode not persisted: " + stored);
    if (await evaluate(`!!document.querySelector('.pt-cmp-line')`)) throw new Error("compare slider still shown when off");
    await waitFor(`[...document.querySelectorAll('button')].some(b => b.innerText.trim() === '重新识别' && !b.disabled)`, 240000, "re-recognition after toggle");
    await clickText("自动", ".pt-enh .seg button");
    await waitFor(`document.querySelector('[data-testid=enhance-card]').dataset.state === 'done'`, 60000, "hd back on");
    await waitFor(`[...document.querySelectorAll('button')].some(b => b.innerText.trim() === '重新识别' && !b.disabled)`, 240000, "re-recognition after toggle on");
    return `${card.slice(0, 120)} · applied=${applied} · ${note} · timeline: ${tl.slice(0, 260)}`;
  });

  // ---- 不是图纸 ----
  await step("not-a-chart card on chiikawa1", async () => {
    await go("#/add?mode=recognize");
    await clickText("换一张").catch(() => {});
    await sleep(300);
    await setFile(realChart("chiikawa", "chiikawa1.jpg"));
    await waitFor(`document.querySelector('.pt-notchart') || [...document.querySelectorAll('button')].some(b => b.innerText.trim() === '重新识别' && !b.disabled) && document.querySelector('form button[type=submit]')`, 240000, "analysis done");
    await sleep(600);
    await shot("16-not-a-chart");
    const card = await evaluate(`document.querySelector('.pt-notchart')?.innerText ?? ''`);
    if (!card.includes("不是图纸")) throw new Error("not-a-chart card missing; page shows: " + (await evaluate("document.querySelector('main').innerText")).slice(0, 200));
    if (!card.includes("用它生成图纸") || !card.includes("仍然按图纸识别")) throw new Error("card buttons missing: " + card);
    await clickText("用它生成图纸");
    await waitFor(`location.hash.includes('mode=generate')`, 5000, "route generate");
    await sleep(800);
    const kept = await evaluate(`!!document.querySelector('main img, main canvas') && [...document.querySelectorAll('button')].some(b => b.innerText.startsWith('生成图纸'))`);
    await shot("17-not-chart-to-generate");
    if (!kept) throw new Error("generate mode did not keep the image");
    return card.replace(/\n/g, " ").slice(0, 120);
  });

  // ---- 批量导入 ----
  const batchFiles = () => [realChart("数码暴龙", "亚古兽.jpg"), realChart("游戏王", "黑魔导士.jpg"), realChart("chiikawa", "chiikawa1.jpg")];
  await step("batch import of 3 files reaches a final state each", async () => {
    await go("#/add?mode=batch");
    await setFile(batchFiles());
    await waitFor(`document.querySelectorAll('.bt-item').length === 3`, 15000, "3 queued items");
    await sleep(400);
    await shot("18-batch-queued");
    const sawBar = await evaluate(`!!document.querySelector('.bt-bar[role=progressbar]')`);
    await waitFor(`document.querySelectorAll('.bt-item').length === 3 && ![...document.querySelectorAll('.bt-item')].some(i => ['waiting','running'].includes(i.dataset.state))`, 900000, "queue settled");
    await sleep(600);
    await shot("19-batch-done");
    const states = await evaluate(`[...document.querySelectorAll('.bt-item')].map(i => (i.querySelector('.bt-name')?.value ?? i.querySelector('.bt-name')?.innerText ?? '') + ':' + i.dataset.state + (i.dataset.review === 'true' ? '(review)' : ''))`);
    const live = await evaluate(`document.querySelector('.bt-wrap [role=status]')?.innerText ?? ''`);
    if (!sawBar) throw new Error("no progress bar");
    if (!live) throw new Error("live region stayed empty");
    const chiikawa = states.find((x) => x.startsWith("chiikawa1"));
    if (!chiikawa?.includes("notchart")) throw new Error("chiikawa1 not classified notchart: " + states.join(" | "));
    return states.join(" | ") + " · live=" + live;
  });
  await step("batch: non-chart offers generate; save all", async () => {
    const gen = await evaluate(`[...document.querySelectorAll('.bt-item[data-state=notchart] button')].some(b => b.innerText.includes('用它生成图纸'))`);
    if (!gen) throw new Error("no 用它生成图纸 on the non-chart row");
    // 批量页底部的主按钮：“全部保存为计划拼 / 全部保存为收藏”（带检查提示的项也一并保存，标为未核对）
    const clicked = await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(b => /^全部保存为/.test(b.innerText.trim()) && !b.disabled); if (!b) return false; b.click(); return true; })()`);
    if (!clicked) throw new Error("no enabled 全部保存为… button");
    await waitFor(`document.querySelectorAll('.bt-item[data-saved=true]').length >= 1`, 60000, "items saved");
    await sleep(500);
    await shot("20-batch-saved");
    return await evaluate(`document.querySelectorAll('.bt-item[data-saved=true]').length + ' saved; ' + document.querySelector('.bt-foot').innerText.replace(/\\n/g, ' ')`);
  });

  // ---- 多张截图拼接 + 取图小贴士 ----
  const tilePaths = [1, 2, 3, 4].map((k) => resolve(outDir, `tile${k}.jpg`));
  const tileOrder = [tilePaths[2], tilePaths[0], tilePaths[3], tilePaths[1]]; // 打乱顺序
  const freshRecognize = async () => {
    await go("#/add?mode=batch"); await go("#/add?mode=recognize"); // 切走再切回：丢掉拼接面板 / 选择卡片的状态
    await clickText("换一张").catch(() => {}); await sleep(400);
  };
  await step("capture tips card on the upload area: visible, toggles, remembers", async () => {
    await freshRecognize();
    await evaluate(`localStorage.removeItem('pindou.tipsOpen')`);
    await go("#/add?mode=batch"); await freshRecognize();
    const open0 = await evaluate(`document.querySelector('[data-testid=capture-tips]')?.dataset.open`);
    if (open0 !== "true") throw new Error("tips not open by default: " + open0);
    const txt = await evaluate(`document.querySelector('[data-testid=capture-tips]').innerText`);
    for (const k of ["长按图片", "保存图片", "缩略图", "1/4", "多张截图拼接", "原图"]) if (!txt.includes(k)) throw new Error("tips missing: " + k);
    await shot("30-tips-open");
    await clickText("怎样拿到更清楚的图纸");
    const closed = await evaluate(`document.querySelector('[data-testid=capture-tips]').dataset.open === 'false' && !document.querySelector('#st-tips-body') && document.querySelector('.st-tips-head').getAttribute('aria-expanded') === 'false'`);
    if (!closed) throw new Error("tips did not collapse");
    await go("#/add?mode=batch"); await freshRecognize();
    const still = await evaluate(`document.querySelector('[data-testid=capture-tips]').dataset.open`);
    if (still !== "false") throw new Error("collapsed state not remembered");
    await clickText("怎样拿到更清楚的图纸");
    return "open → closed (remembered) → open";
  });
  await step("make 4 overlapping phone screenshots (fake status/nav bars, JPEG) from the chart", async () => {
    await freshRecognize();
    await setFile(chartPath);
    await waitFor(`(() => { const i = document.querySelector('.pt-stage img'); return i && i.naturalWidth > 100; })()`, 60000, "chart image shown");
    const tiles = await evaluate(`new Promise(async (res) => {
      const img = document.querySelector('.pt-stage img');
      const W = 3200, H = Math.round(img.naturalHeight * W / img.naturalWidth);
      const base = document.createElement('canvas'); base.width = W; base.height = H;
      const bx = base.getContext('2d'); bx.imageSmoothingQuality = 'high'; bx.drawImage(img, 0, 0, W, H);
      const cw = 1900, ch = 1700, xs = [0, W - cw], ys = [0, H - ch], out = [];
      for (const y of ys) for (const x of xs) {
        const c = document.createElement('canvas'); c.width = cw; c.height = ch + 130;
        const g = c.getContext('2d');
        g.fillStyle = '#111'; g.fillRect(0, 0, cw, 60); g.fillStyle = '#f2f2f2'; g.fillRect(0, 60, cw, 70);
        g.fillStyle = '#eee'; g.font = '28px sans-serif'; g.fillText('9:41', 24, 40); g.fillRect(cw - 120, 22, 90, 18);
        g.fillStyle = '#222'; g.font = '30px sans-serif'; g.fillText('< 拼豆图纸', 24, 108);
        g.drawImage(base, x, y, cw, ch, 0, 130, cw, ch);
        g.fillStyle = '#fafafa'; g.fillRect(0, 130 + ch - 0, cw, 0);
        out.push(await new Promise((r) => c.toBlob((b) => { const f = new FileReader(); f.onload = () => r(String(f.result).split(',')[1]); f.readAsDataURL(b); }, 'image/jpeg', 0.8)));
      }
      res(out);
    })`, 120000);
    tiles.forEach((b64, i) => writeFileSync(tilePaths[i], Buffer.from(b64, "base64")));
    return tiles.map((t) => Math.round(t.length * 0.75 / 1024) + " KB").join(", ");
  });
  await step("multi-select in the drop area asks: 拼接 vs 批量导入", async () => {
    await freshRecognize();
    await setFile(tileOrder);
    await waitFor(`document.querySelector('[data-testid=multi-choice]')`, 10000, "choice card");
    const t = await evaluate(`document.querySelector('[data-testid=multi-choice]').innerText`);
    if (!t.includes("同一张图纸的分段截图") || !t.includes("不同的图纸") || !t.includes("批量导入") || !t.includes("拼接")) throw new Error("choice text: " + t);
    await shot("31-multi-choice");
    await clickText("重新选择");
    await waitFor(`!document.querySelector('[data-testid=multi-choice]') && document.querySelector('[data-testid=capture-tips]')`, 5000, "back to upload");
    return "both options shown, cancel returns";
  });
  await step("stitch 4 shuffled screenshots → preview with seams → recognise", async () => {
    await freshRecognize();
    await setFile(tileOrder, '[data-testid=stitch-input]');
    await waitFor(`document.querySelector('[data-testid=stitch-panel]')`, 10000, "stitch panel");
    const thumbs = await evaluate(`document.querySelectorAll('.st-thumbs .st-thumb:not(.st-add)').length`);
    if (thumbs !== 4) throw new Error("thumbs " + thumbs);
    await waitFor(`document.querySelector('[data-testid=stitch-result]')`, 120000, "stitch result");
    await sleep(500);
    const info = await evaluate(`document.querySelector('[data-testid=stitch-result]').innerText.replace(/\\n/g, ' ')`);
    const out = await evaluate(`document.querySelectorAll('.st-thumb[data-out=true]').length`);
    if (out) throw new Error("some tiles not joined: " + info);
    const m = info.match(/(\d[\d,]*)×(\d[\d,]*)/); const conf = info.match(/可信度 (\d+)%/);
    if (!m || !conf || +conf[1] < 80) throw new Error("result/confidence: " + info.slice(0, 200));
    const w = +m[1].replace(/,/g, ""), h = +m[2].replace(/,/g, "");
    if (Math.abs(w - 3200) > 8) throw new Error("stitched width " + w);
    const seams = await evaluate(`!!document.querySelector('.st-seams') && document.querySelectorAll('.st-rect').length`);
    if (seams !== 4) throw new Error("seam rects " + seams);
    await shot("32-stitch-result");
    // 接缝开关
    await evaluate(`[...document.querySelectorAll('.pt-check')].find(l => l.innerText.includes('显示接缝')).querySelector('input').click()`);
    await sleep(150);
    if (await evaluate(`!!document.querySelector('.st-seams')`)) throw new Error("seams still drawn after toggle off");
    await evaluate(`[...document.querySelectorAll('.pt-check')].find(l => l.innerText.includes('显示接缝')).querySelector('input').click()`);
    // 缩略图排序 / 移除后结果失效，需要重新拼接
    await evaluate(`document.querySelector('.st-thumb button[aria-label="第 1 张后移"]').click()`);
    await sleep(200);
    if (await evaluate(`!!document.querySelector('[data-testid=stitch-result]')`)) throw new Error("result should reset after reorder");
    await clickText("开始拼接");
    await waitFor(`document.querySelector('[data-testid=stitch-result]')`, 120000, "stitch result again");
    await clickText("用拼好的图识别");
    await waitFor(`!document.querySelector('[data-testid=stitch-panel]') && document.querySelector('.pt-stage img')`, 20000, "recognise view");
    await waitFor(`[...document.querySelectorAll('button')].some(b => b.innerText.trim() === '重新识别' && !b.disabled) && document.body.innerText.includes('识别结果')`, 240000, "recognition of stitched image");
    await sleep(600);
    await shot("33-stitched-recognised");
    const timeline = await evaluate(`[...document.querySelectorAll('.pt-steps li')].map(l => l.innerText.replace(/\\n/g, ' / ')).join(' || ')`);
    if (!/检测到 156×138 网格/.test(timeline)) throw new Error("stitched image not read as 156×138: " + timeline.slice(0, 500));
    const t = await evaluate("document.querySelector('main').innerText");
    return `${w}×${h}, conf ${conf[1]}% · ` + (t.match(/可信度 \d+%/)?.[0] ?? "") + " · " + (t.match(/合计[^\n]*/)?.[0] ?? "");
  });
  await step("batch import keeps working from the choice card", async () => {
    await freshRecognize();
    await setFile(tileOrder.slice(0, 2));
    await waitFor(`document.querySelector('[data-testid=multi-choice]')`, 10000, "choice card");
    await clickText("是不同的图纸");
    await waitFor(`document.querySelectorAll('.bt-item').length >= 2`, 15000, "queue shows items");
    return await evaluate(`location.hash + ' · ' + document.querySelectorAll('.bt-item').length + ' queued'`);
  });
  await step("low-quality hint links to the tips (HD card degraded upload)", async () => {
    await freshRecognize();
    await setFile(degradedPath);
    await waitFor(`[...document.querySelectorAll('button')].some(b => b.innerText.trim() === '重新识别' && !b.disabled) && document.querySelector('[data-testid=enhance-card]')?.dataset.state === 'done'`, 240000, "recognition done");
    await sleep(500);
    const has = await evaluate(`!!document.querySelector('[data-testid=low-quality-hint]')`);
    const lvl = await evaluate(`document.querySelector('[data-testid=enhance-card]').innerText.replace(/\\n/g, ' ').slice(0, 80)`);
    if (!has) return "no low/very-low level reported for this upload (hint not shown): " + lvl;
    await clickText("怎样拿到更清楚的图");
    const ok = await evaluate(`document.querySelector('[data-testid=low-quality-hint]').innerText.includes('长按图片')`);
    if (!ok) throw new Error("hint did not reveal tips");
    await shot("34-low-quality-hint");
    return "hint shown and expands tips";
  });

  for (const [hash, name] of [["#/", "08-dashboard"], ["#/gallery", "09-gallery"], ["#/gallery?tab=images", "10-images"], ["#/shopping", "11-shopping"], ["#/purchase", "11b-purchase"], ["#/insights", "11c-insights"], ["#/works", "11d-works"], ["#/history", "12-history"], ["#/settings", "13-settings"]]) {
    await step(`page ${hash}`, async () => { await go(hash); await shot(name); await noHorizontalScroll(hash); return (await evaluate("document.querySelector('main').innerText")).slice(0, 300); });
  }


  // ---- 第 8 阶段证据：无障碍与交互 ----
  const auditAll = [];
  for (const hash of ["#/", "#/gallery", "#/inventory", "#/shopping", "#/purchase", "#/insights", "#/works", "#/history", "#/settings", "#/add?mode=recognize", "#/add?mode=generate", "#/add?mode=manual", "#/add?mode=batch"]) {
    await go(hash);
    const issues = await evaluate(AUDIT);
    auditAll.push(...issues.map((i) => `${hash}: ${i}`));
  }
  checks.push({ check: "a11y audit (names, labels, alt, one h1)", ok: auditAll.length === 0, detail: auditAll.slice(0, 15).join(" | ") || "0 issues" });
  await step("route change focuses page heading", async () => {
    await go("#/inventory"); await go("#/shopping"); await sleep(300);
    const ok = await evaluate(`document.activeElement?.tagName === 'H1' && document.activeElement.innerText`);
    if (!ok) throw new Error("focus not on h1: " + await evaluate("document.activeElement?.tagName"));
    return `${ok} · title=${await evaluate("document.title")}`;
  });
  await step("sheet: focus trap, Esc closes, focus returns", async () => {
    await go("#/inventory");
    await clickText("批量入库");
    await waitFor(`document.querySelector('.sheet')`, 5000, "sheet open");
    await sleep(300);
    for (let i = 0; i < 25; i++) await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 }).then(() => send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 }));
    const inside = await evaluate(`!!document.activeElement?.closest('.sheet')`);
    if (!inside) throw new Error("focus escaped sheet after Tab x25");
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await waitFor(`!document.querySelector('.sheet')`, 3000, "sheet closed by Esc");
    const back = await evaluate(`document.activeElement?.innerText?.trim() ?? ''`);
    if (!back.includes("批量入库")) throw new Error("focus did not return to trigger: " + back);
    return "trap ok · closed · focus back on 批量入库";
  });
  // ---- 第 3 波：入库价格 / 补货预告 / 快捷键 ----
  const setInput = (selector, value) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(String(value))}); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await step("price: batch stock-in with a row price in the text and an order total", async () => {
    await go("#/inventory");
    await clickText("批量入库");
    await waitFor(`document.querySelector('.sheet textarea')`, 5000, "batch sheet");
    if (!(await setInput('.sheet textarea', 'C3 1200 ¥1.26, C5 500, C7 500'))) throw new Error("textarea missing");
    await sleep(300);
    await clickText("加入下面的列表", ".sheet button");
    await sleep(500);
    const rows = await evaluate(`document.querySelectorAll('[data-batch-row]').length`);
    if (rows !== 3) throw new Error("expected 3 rows, got " + rows);
    if (!(await setInput('[data-batch-total]', '3.26'))) throw new Error("order total input missing");
    await sleep(400);
    const summary = await evaluate(`document.querySelector('[data-price-summary]')?.innerText ?? ''`);
    const rowAmounts = await evaluate(`JSON.stringify([...document.querySelectorAll('[data-row-amount]')].map((i) => [i.value, i.placeholder]))`);
    if (await evaluate(`!!document.querySelector('[data-price-warning]')`)) throw new Error("unexpected price warning: " + summary);
    await shot("40-batch-price");
    const btn = await evaluate(`(() => { const b = [...document.querySelectorAll('.sheet button')].find(b => /^入库 \\d/.test(b.innerText.trim()) && !b.disabled); if (!b) return null; b.click(); return b.innerText; })()`);
    if (!btn) throw new Error("confirm button not found");
    await sleep(1200);
    await go("#/history");
    const hist = await evaluate(`document.querySelector('main').innerText`);
    if (!hist.includes("3.26")) throw new Error("history does not show ¥3.26: " + hist.slice(0, 300));
    const edit = await evaluate(`document.querySelectorAll('[data-hist-price]').length`);
    if (!edit) throw new Error("no 补填价格 button in history");
    await evaluate(`document.querySelector('[data-hist-price]').click()`);
    await waitFor(`document.querySelector('[data-hist-price-edit] input')`, 3000, "price edit form");
    await shot("41-history-price");
    return `rows ${rowAmounts} · ${summary.replace(/\s+/g, " ").slice(0, 120)} · edit buttons ${edit}`;
  });
  await step("price: over-allocated rows show a warning", async () => {
    await go("#/inventory");
    await clickText("批量入库");
    await waitFor(`document.querySelector('.sheet textarea')`, 5000, "batch sheet");
    await setInput('.sheet textarea', 'C3 1200 ¥5, C5 500');
    await sleep(300);
    await clickText("加入下面的列表", ".sheet button");
    await sleep(400);
    await setInput('[data-batch-total]', '2');
    await sleep(400);
    const warn = await evaluate(`document.querySelector('[data-price-warning="over"]')?.innerText ?? ''`);
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await sleep(500);
    await evaluate(`[...document.querySelectorAll('button')].find((b) => /放弃|不保存|确定|离开/.test(b.innerText))?.click()`);
    await sleep(300);
    if (!warn) throw new Error("no over-allocation warning");
    return warn.replace(/\s+/g, " ").slice(0, 100);
  });
  await step("forecast: panel, horizon selector, method line, dashboard card", async () => {
    await go("#/insights");
    await waitFor(`document.querySelector('[data-forecast-panel]')`, 8000, "forecast panel");
    await evaluate(`document.querySelector('[data-horizon="3"]')?.click()`);
    await sleep(400);
    const pressed = await evaluate(`document.querySelector('[data-horizon="3"]')?.getAttribute('aria-pressed')`);
    if (pressed !== "true") throw new Error("horizon 3 not pressed: " + pressed);
    const how = await evaluate(`document.querySelector('[data-forecast-how]')?.innerText ?? ''`);
    const rows = await evaluate(`JSON.stringify([...document.querySelectorAll('[data-forecast-row]')].slice(0, 5).map((r) => r.dataset.code + ':' + r.dataset.status))`);
    const thin = await evaluate(`!!document.querySelector('[data-forecast-thin]')`);
    await evaluate(`document.querySelector('[data-forecast-panel]').scrollIntoView({ block: 'start' })`);
    await shot("42-forecast");
    await go("#/");
    const card = await evaluate(`!!document.querySelector('[data-forecast-card]')`);
    return `rows ${rows} · thin=${thin} · card=${card} · ${how.replace(/\s+/g, " ").slice(0, 100)}`;
  });
  await step("shortcuts: ? opens help, Esc closes, / focuses search, g then i goes to inventory", async () => {
    await go("#/gallery");
    await evaluate(`document.activeElement?.blur?.()`);
    await pressKey("?");
    await waitFor(`document.querySelector('[data-shortcut-help]')`, 4000, "shortcut help sheet");
    await shot("43-shortcut-help");
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await waitFor(`!document.querySelector('[data-shortcut-help]')`, 4000, "help closed");
    await evaluate(`document.activeElement?.blur?.()`);
    await pressKey("/");
    await sleep(300);
    const focused = await evaluate(`!!document.activeElement?.matches?.('[data-quick-search], input[type=search]')`);
    if (!focused) throw new Error("/ did not focus search: " + await evaluate("document.activeElement?.tagName"));
    const typed = await evaluate(`document.activeElement.value`);
    if (typed.includes("/")) throw new Error("the / character was typed into the search box");
    await evaluate(`document.activeElement?.blur?.()`);
    await pressKey("g"); await sleep(100); await pressKey("i");
    await sleep(900);
    const hash = await evaluate("location.hash");
    if (!hash.startsWith("#/inventory")) throw new Error("g i went to " + hash);
    return "help ok · / focuses search · g i → " + hash;
  });
  await step("price: single-colour stock-in asks what was paid", async () => {
    await go("#/inventory");
    const opened = await evaluate(`(() => { const el = [...document.querySelectorAll('main button, main [role=button]')].find((b) => /\\bA26\\b/.test(b.innerText)); if (!el) return false; el.scrollIntoView({ block: 'center' }); el.click(); return true; })()`);
    if (!opened) throw new Error("no A26 control on the inventory page");
    await waitFor(`document.querySelector('[data-buy-paid]')`, 5000, "paid field");
    await evaluate(`document.querySelector('[data-pack="1200"]')?.click()`);
    await sleep(200);
    await setInput('[data-buy-paid]', '1.26');
    await sleep(300);
    const derived = await evaluate(`document.querySelector('[data-buy-derived]')?.innerText ?? ''`);
    await shot("44-code-sheet-price");
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await sleep(400);
    if (!/1\.05/.test(derived)) throw new Error("derived price text: " + derived);
    return derived.replace(/\s+/g, " ");
  });
  await step("reopen a finished pattern: shortage list, deduct, ask, refund puts beads back", async () => {
    if (!recognizedHash) throw new Error("no saved pattern");
    await go(recognizedHash);
    await clickText("标记完成");
    await waitFor(`document.querySelector('.sheet')`, 5000, "mark-done sheet");
    const shortList = await evaluate(`document.querySelector('[data-short-list]')?.innerText ?? ''`);
    await shot("45-mark-done-short");
    await clickText("扣除库存并完成", ".sheet button");
    await waitFor(`!document.querySelector('.sheet')`, 5000, "sheet closed");
    await sleep(800);
    await clickText("计划拼");
    await waitFor(`document.querySelector('[data-reopen-ask]')`, 5000, "reopen question");
    const ask = await evaluate(`document.querySelector('[data-reopen-ask]').innerText`);
    await shot("46-reopen-ask");
    await evaluate(`document.querySelector('[data-reopen-refund]').click()`);
    await waitFor(`!document.querySelector('[data-reopen-ask]')`, 5000, "reopen sheet closed");
    await sleep(800);
    const toastText = await evaluate(`[...document.querySelectorAll('.toast, [role=status]')].map((t) => t.innerText).join(' | ')`);
    if (!/放回了库存/.test(toastText)) throw new Error("no refund toast: " + toastText.slice(0, 200));
    const planned = await evaluate(`[...document.querySelectorAll('button[aria-pressed="true"]')].some((b) => b.innerText.trim() === '计划拼')`);
    if (!planned) throw new Error("status is not 计划拼 after reopening");
    await go("#/history");
    const hist = await evaluate(`document.querySelector('main').innerText`);
    if (!/退回/.test(hist)) throw new Error("history does not show the refund");
    return `short: ${shortList.replace(/\s+/g, " ").slice(0, 80) || "(none)"} · ask: ${ask.replace(/\s+/g, " ").slice(0, 90)}`;
  });
  // ---- 第 5 波：在途订单 / 卖家 / 作品集 / 分板打印 / 快速核对 / 拼装 Esc ----
  const esc = async () => { await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }); await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }); await sleep(400); };
  const patternId = () => (recognizedHash.match(/#\/pattern\/([^?]+)/) ?? [])[1];
  await step("orders: section on the shopping page, manual order sheet opens", async () => {
    await go("#/shopping");
    await waitFor(`document.querySelector('[data-orders-section]')`, 8000, "orders section");
    await evaluate(`document.querySelector('[data-order-add]').click()`);
    await waitFor(`document.querySelector('.sheet')`, 5000, "manual order sheet");
    await shot("47-order-add");
    await esc();
    await evaluate(`[...document.querySelectorAll('button')].find((b) => /放弃|不保存|离开/.test(b.innerText))?.click()`);
    await sleep(300);
    await noHorizontalScroll("#/shopping with orders");
    return `count=${await evaluate(`document.querySelector('[data-orders-count]')?.innerText ?? ''`)} transit=${await evaluate(`!!document.querySelector('[data-transit-note]')`)}`;
  });
  await step("sellers: manage sheet, add form, comparison block", async () => {
    await go("#/purchase");
    await waitFor(`document.querySelector('[data-purchase-seller-manage]')`, 8000, "seller manage button");
    await evaluate(`document.querySelector('[data-purchase-seller-manage]').click()`);
    await waitFor(`document.querySelector('[data-seller-sheet]')`, 5000, "seller sheet");
    await evaluate(`document.querySelector('[data-seller-add]').click()`);
    await waitFor(`document.querySelector('[data-seller-form]')`, 5000, "seller form");
    await shot("48-seller-form");
    await esc(); await esc();
    await evaluate(`[...document.querySelectorAll('button')].find((b) => /放弃|不保存|离开/.test(b.innerText))?.click()`);
    await sleep(300);
    return `sum=${(await evaluate(`document.querySelector('[data-purchase-seller-sum]')?.innerText ?? ''`)).replace(/\s+/g, " ").slice(0, 80)}`;
  });
  await step("works: finish with a record, 作品集 shows the piece, detail panel lists it", async () => {
    if (!recognizedHash) throw new Error("no saved pattern");
    await go(recognizedHash);
    await clickText("标记完成");
    await waitFor(`document.querySelector('.sheet [data-work-form], .sheet')`, 5000, "mark-done sheet");
    const hasForm = await evaluate(`!!document.querySelector('[data-work-form]')`);
    await shot("49-mark-done-work");
    await clickText("只标记完成", ".sheet button");
    await waitFor(`!document.querySelector('.sheet')`, 5000, "sheet closed");
    await sleep(800);
    const entries = await evaluate(`document.querySelectorAll('[data-work-entry]').length`);
    await go("#/works");
    await waitFor(`document.querySelector('[data-works-page]')`, 8000, "works page");
    const cards = await evaluate(`document.querySelectorAll('[data-work-card]').length`);
    await shot("50-works");
    if (!hasForm) throw new Error("no work form in the mark-done sheet");
    if (!cards) throw new Error("作品集 has no card after finishing a pattern");
    if (!entries) throw new Error("detail page shows no work entry");
    await go(recognizedHash);
    await clickText("计划拼");
    await sleep(600);
    await evaluate(`document.querySelector('[data-reopen-keep]')?.click()`);
    await sleep(600);
    return `entries ${entries} · cards ${cards} · totals ${(await evaluate(`document.querySelector('[data-works-totals]')?.innerText ?? ''`)).replace(/\s+/g, " ").slice(0, 60)}`;
  });
  await step("print: overview + board pages, legend, all pages present for printing", async () => {
    const id = patternId(); if (!id) throw new Error("no saved pattern");
    await go(recognizedHash);
    if (!(await evaluate(`!!document.querySelector('[data-print-link]')`))) throw new Error("no print link on the detail page");
    await go("#/print/" + id);
    await waitFor(`document.querySelector('[data-print-root] [data-print-page]')`, 10000, "print pages");
    await evaluate(`window.dispatchEvent(new Event('beforeprint'))`);
    await sleep(1200);
    const info = await evaluate(`JSON.stringify({ pages: document.querySelectorAll('[data-print-page]').length, boards: document.querySelectorAll('[data-print-page="board"]').length, overview: document.querySelectorAll('[data-print-page="overview"]').length, legend: document.querySelectorAll('[data-print-legend] [data-legend-code]').length, drawn: [...document.querySelectorAll('[data-print-page="board"]')].filter((p) => p.querySelector('svg, canvas, table')).length, summary: document.querySelector('[data-print-summary]')?.innerText ?? '' })`);
    await evaluate(`window.dispatchEvent(new Event('afterprint'))`);
    await shot("51-print");
    const o = JSON.parse(info);
    if (o.overview !== 1 || o.boards < 1 || o.legend < 1) throw new Error("print pages incomplete: " + info);
    if (o.drawn !== o.boards) throw new Error("not every board page is rendered for printing: " + info);
    if (!(await evaluate(`!!document.querySelector('[data-print-go]')`))) throw new Error("no print button");
    return info;
  });
  await step("verify: queue from gallery, ok then undo, flag, keys ignored while typing, leave", async () => {
    await go("#/gallery");
    await waitFor(`document.querySelector('[data-verify-start]')`, 8000, "快速核对 button");
    const label = await evaluate(`document.querySelector('[data-verify-start]').innerText`);
    await evaluate(`document.querySelector('[data-verify-start]').click()`);
    await waitFor(`document.querySelector('[data-verify-page]')`, 8000, "verify page");
    await sleep(800);
    const p0 = await evaluate(`document.querySelector('[data-verify-progress]')?.innerText ?? ''`);
    await shot("52-verify");
    await evaluate(`document.querySelector('[data-verify-ok]').click()`);
    await sleep(700);
    await evaluate(`document.querySelector('[data-verify-undo]')?.click()`);
    await sleep(700);
    const p1 = await evaluate(`document.querySelector('[data-verify-progress]')?.innerText ?? ''`);
    if (p1 !== p0) throw new Error("undo did not return to the same place: " + p0 + " / " + p1);
    await evaluate(`document.querySelector('[data-verify-skip]').click()`);
    await sleep(600);
    const after = await evaluate(`document.querySelector('[data-verify-progress]')?.innerText ?? (document.querySelector('[data-verify-end]') ? 'end' : '')`);
    await evaluate(`document.querySelector('[data-verify-leave]')?.click()`);
    await sleep(700);
    return `${label.replace(/\s+/g, " ")} · ${p0.replace(/\s+/g, " ")} → ${String(after).replace(/\s+/g, " ")} · left to ${await evaluate("location.hash")}`;
  });
  await step("build: drag toggle present, Esc saves and returns to the pattern", async () => {
    const id = patternId(); if (!id) throw new Error("no saved pattern");
    await go("#/build/" + id);
    await waitFor(`document.querySelector('[data-build-root]')`, 15000, "build page");
    await sleep(600);
    if (!(await evaluate(`!!document.querySelector('[data-build-drag-toggle]')`))) throw new Error("no drag toggle");
    await evaluate(`document.activeElement?.blur?.()`);
    await esc();
    await sleep(900);
    const hash = await evaluate("location.hash");
    if (!hash.startsWith("#/pattern/")) throw new Error("Esc did not leave build mode: " + hash);
    return "Esc → " + hash;
  });
  await step("polish: gallery chips, shopping seller + shipping line, purchase transit note, settings seller link, build time, print symbols", async () => {
    const out = {};
    await go("#/gallery");
    out.galleryWorks = await evaluate(`!!document.querySelector('[data-gallery-works]')`);
    await go("#/shopping");
    out.shopSeller = await evaluate(`(document.querySelector('[data-shop-seller]')?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 40)`);
    await go("#/purchase");
    out.purchaseSeller = await evaluate(`!!document.querySelector('[data-purchase-seller]')`);
    await go("#/settings");
    out.settingsSellers = await evaluate(`!!document.querySelector('[data-settings-sellers]')`);
    const id = patternId(); if (!id) throw new Error("no saved pattern");
    await go("#/build/" + id);
    await waitFor(`document.querySelector('[data-build-root]')`, 15000, "build page");
    await sleep(500);
    out.buildTime = await evaluate(`(document.querySelector('[data-build-time]')?.innerText ?? '').replace(/\\s+/g, ' ')`);
    await go("#/print/" + id);
    await waitFor(`document.querySelector('[data-print-root] [data-print-page]')`, 10000, "print pages");
    await evaluate(`(() => { const sel = [...document.querySelectorAll('[data-print-options] select, [data-print-options] button, [data-print-options] input')].find((el) => /符号/.test(el.innerText || el.value || el.parentElement?.innerText || '')); if (sel?.tagName === 'SELECT') { const o = [...sel.options].find((x) => /符号/.test(x.text)); if (o) { sel.value = o.value; sel.dispatchEvent(new Event('change', { bubbles: true })); } } else sel?.click(); })()`);
    await sleep(600);
    await evaluate(`window.dispatchEvent(new Event('beforeprint'))`);
    await sleep(1000);
    out.printPages = await evaluate(`document.querySelectorAll('[data-print-page]').length`);
    out.printLegendPages = await evaluate(`document.querySelectorAll('[data-print-page="legend"]').length`);
    await shot("53-print-symbols");
    await evaluate(`window.dispatchEvent(new Event('afterprint'))`);
    if (!out.galleryWorks || !out.purchaseSeller || !out.settingsSellers) throw new Error("missing entry point: " + JSON.stringify(out));
    // 用时标签只在累计满一分钟后出现（设计如此），这里只记录不强求
    return JSON.stringify(out);
  });
  // ---- 按库存颜色：手动录入一张用到套装外色号的图纸 → 换色预览 → 确认 → 恢复 → 图库批量换色；库存导出按钮；“下一张拼什么” ----
  await step("stock colours: outside-kit hint, recolor preview/apply/restore, gallery batch, export button, next-up", async () => {
    const out = {};
    await go("#/add?mode=manual");
    await waitFor(`document.querySelector('textarea')`, 8000, "manual textarea");
    await evaluate(`(() => { const t = document.querySelector('textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, 'P1 30, R3 20, A4 50'); t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await sleep(200);
    await clickText("解析并加入");
    await waitFor(`document.querySelector('[data-outside-hint]')`, 5000, "outside-kit hint");
    out.hint = await evaluate(`document.querySelector('[data-outside-hint]').innerText.slice(0, 12)`);
    await evaluate(`(() => { const i = document.querySelector('form input.input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, '套装外测试'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await evaluate(`document.querySelector('.pt-save').click()`);
    await waitFor(`location.hash.startsWith("#/pattern/")`, 30000, "manual pattern detail");
    const hash = await evaluate("location.hash");
    await waitFor(`document.querySelector('[data-recolor-card] [data-recolor-open]')`, 8000, "recolor card");
    await evaluate(`document.querySelector('[data-recolor-open]').click()`);
    await waitFor(`document.querySelector('[data-recolor-sheet] [data-recolor-row]')`, 5000, "recolor sheet rows");
    out.rows = await evaluate(`JSON.stringify([...document.querySelectorAll('[data-recolor-row]')].map((r) => r.dataset.recolorRow + '→' + r.innerText.replace(/\\s+/g, ' ').slice(0, 40)))`);
    await shot("54-recolor-sheet");
    await evaluate(`document.querySelector('[data-recolor-confirm]').click()`);
    await waitFor(`document.querySelector('[data-recolor-restore]')`, 8000, "restore button after apply");
    await sleep(400);
    const usesOld = () => evaluate(`/\\bP1\\b|\\bR3\\b/.test([...document.querySelectorAll('.pd-controls, table')].map((el) => el.innerText).join(' '))`);
    out.afterApplyHasOld = await usesOld();
    const totalOf = () => evaluate(`(() => { const m = (document.querySelector('.pd-controls')?.innerText ?? '').match(/([\\d,]+) 颗/); return m ? Number(m[1].replace(/,/g, '')) : -1; })()`);
    out.totalAfter = await totalOf();
    await shot("55-recolor-applied");
    await evaluate(`document.querySelector('[data-recolor-restore]').click()`);
    await waitFor(`document.querySelector('[data-recolor-open]') && !document.querySelector('[data-recolor-restore]')`, 8000, "card back to offer after restore");
    out.afterRestoreHasOld = await usesOld();
    out.totalRestored = await totalOf();
    if (out.afterApplyHasOld) throw new Error("old codes still listed after recolor: " + JSON.stringify(out));
    if (!out.afterRestoreHasOld) throw new Error("restore did not bring the original codes back: " + JSON.stringify(out));
    if (out.totalAfter !== 100 || out.totalRestored !== 100) throw new Error("bead total changed: " + JSON.stringify(out));
    await go("#/gallery");
    await waitFor(`document.querySelector('[data-recolor-banner] [data-recolor-all]')`, 8000, "gallery recolor banner");
    await evaluate(`document.querySelector('[data-recolor-all]').click()`);
    await waitFor(`document.querySelector('[data-recolor-all-sheet]')`, 5000, "batch recolor sheet");
    if (await evaluate(`!document.querySelector('[data-recolor-all-confirm]') || document.querySelector('[data-recolor-all-confirm]').disabled`)) throw new Error('batch confirm missing or disabled');
    out.batch = await evaluate(`document.querySelector('[data-recolor-all-sheet]').innerText.replace(/\\s+/g, ' ').slice(0, 160)`);
    await shot("56-recolor-all");
    await evaluate(`document.querySelector('[data-recolor-all-confirm]').click()`);
    await waitFor(`!document.querySelector('[data-recolor-all-sheet]')`, 8000, "batch sheet closed");
    await sleep(600);
    out.bannerAfter = await evaluate(`document.querySelector('[data-recolor-banner]')?.innerText.replace(/\\s+/g, ' ').slice(0, 60) ?? null`);
    await go(hash);
    await waitFor(`document.querySelector('[data-recolor-restore]')`, 8000, "batch-recoloured pattern offers restore");
    await go("#/inventory");
    await waitFor(`document.querySelector('[data-inventory-export-csv]')`, 8000, "inventory export button");
    await go("#/insights?focus=nextup");
    await waitFor(`document.querySelector('[data-nextup-panel]')`, 8000, "next-up panel");
    await sleep(500);
    out.nextRows = await evaluate(`JSON.stringify([...document.querySelectorAll('[data-nextup-row]')].slice(0, 3).map((r) => r.dataset.group + '#' + r.dataset.rank + ' ' + (r.querySelector('[data-nextup-why]')?.innerText ?? '').slice(0, 60)))`);
    out.nextHow = await evaluate(`(document.querySelector('[data-nextup-how]')?.innerText ?? '').slice(0, 80)`);
    await evaluate(`document.querySelector('[data-nextup-panel]').scrollIntoView({ block: 'start' })`);
    await shot("57-nextup");
    if (!(await evaluate(`document.querySelectorAll('[data-nextup-row]').length`))) throw new Error("no next-up rows: " + JSON.stringify(out));
    const go1 = await evaluate(`document.querySelector('[data-nextup-go]')?.getAttribute('href') ?? ''`);
    if (!go1.startsWith("#/pattern/")) throw new Error("next-up action href: " + go1);
    await go("#/");
    await sleep(400);
    out.card = await evaluate(`!!document.querySelector('[data-nextup-card]')`);
    await shot("58-nextup-card");
    return JSON.stringify(out);
  });
  // ---- 编辑时格内色号 + 导出图纸 PNG（黑线分割、四边编号、底部色号统计） ----
  await step("sheet: codes on while editing, zoom-to-codes, export sheet PNG", async () => {
    const out = {};
    await go(recognizedHash || "#/gallery");
    await waitFor(`document.querySelector('[data-export-sheet]')`, 15000, "export sheet button");
    await evaluate(`localStorage.setItem('pindou.matrix.showCodes', '0')`);
    await evaluate(`(() => { window.__dlr = null; if (window.__capOn) return; window.__capOn = true; const oc = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { if (this.download && this.href.startsWith('blob:')) { const name = this.download; fetch(this.href).then((r) => r.blob()).then((b) => { const fr = new FileReader(); fr.onload = () => { window.__dlr = { name, size: b.size, data: fr.result }; }; fr.readAsDataURL(b); }).catch((e) => { window.__dlr = { error: String(e) }; }); return; } return oc.call(this); }; })()`);
    await evaluate(`document.querySelector('[data-export-sheet]').click()`);
    await waitFor(`window.__dlr`, 60000, "sheet PNG download");
    const dl = await evaluate(`window.__dlr`);
    if (dl.error || !/^data:image\/png;base64,/.test(dl.data)) throw new Error("sheet export: " + JSON.stringify({ ...dl, data: String(dl.data).slice(0, 40) }));
    const png = Buffer.from(dl.data.split(",")[1], "base64");
    writeFileSync(resolve(outDir, "59-sheet-export.png"), png);
    out.file = dl.name; out.bytes = png.length; out.w = png.readUInt32BE(16); out.h = png.readUInt32BE(20);
    if (out.w < 600 || out.h <= out.w * 0.5) throw new Error("sheet size looks wrong: " + JSON.stringify(out));
    await clickText("编辑格子");
    await waitFor(`document.querySelector('.me [data-codes-toggle]')`, 10000, "editor codes toggle");
    await sleep(600);
    out.toggle = await evaluate(`(() => { const t = document.querySelector('.me [data-codes-toggle]'); const i = t.matches('input') ? t : t.querySelector('input'); return i ? i.checked : t.getAttribute('aria-pressed'); })()`);
    out.codes = await evaluate(`document.querySelector('.me .pt-matrix')?.dataset.codes`);
    out.hint = await evaluate(`!!document.querySelector('.me [data-codes-hint]')`);
    if (out.codes !== "on" && out.hint) { await evaluate(`document.querySelector('.me [data-codes-zoom]').click()`); await sleep(600); out.codesAfterZoom = await evaluate(`document.querySelector('.me .pt-matrix')?.dataset.codes`); }
    await evaluate(`document.querySelector('.me .pt-matrix-scroll')?.scrollIntoView({ block: 'center' })`);
    await shot("60-edit-codes");
    if (String(out.toggle) !== "true" || (out.codes !== "on" && out.codesAfterZoom !== "on")) throw new Error("codes not shown while editing: " + JSON.stringify(out));
    out.remembered = await evaluate(`localStorage.getItem('pindou.matrix.showCodes')`);
    await go("#/gallery");
    await sleep(300);
    await evaluate(`[...document.querySelectorAll('.sheet button, dialog button, button')].find((b) => /放弃|不保存|离开/.test(b.innerText))?.click()`);
    await sleep(300);
    return JSON.stringify(out);
  });
  checks.push({ check: "token contrast (light)", ok: true, detail: JSON.stringify(await evaluate(CONTRAST)) });
  await setViewport(390, 844, true);
  for (const [hash, name] of [["#/", "m1-dashboard"], ["#/inventory", "m2-inventory"], ["#/add?mode=recognize", "m3-add"], ["#/add?mode=batch", "m8-batch"], ["#/gallery", "m4-gallery"], ["#/shopping", "m5-shopping"], ["#/purchase", "m5b-purchase"], ["#/insights", "m5c-insights"], ["#/works", "m5d-works"], ["#/settings", "m6-settings"]]) {
    await step(`mobile ${hash}`, async () => { await go(hash); await shot(name); await noHorizontalScroll(hash); return "ok"; });
  }

  await step("mobile: 更多 sheet reaches 采购方案 / 数据洞察 / 记录 / 设置", async () => {
    await go("#/");
    await evaluate(`document.querySelector('.tab-more').click()`);
    await waitFor(`document.querySelector('.sheet-backdrop')`, 5000, "更多 sheet");
    const labels = await evaluate(`[...document.querySelectorAll('.sheet-backdrop a.more-row')].map(a => a.getAttribute('href') + ' ' + (a.textContent || '').trim().slice(0, 12))`);
    for (const h of ["#/shopping", "#/purchase", "#/insights", "#/history", "#/settings"]) if (!labels.some((l) => l.startsWith(h + " "))) throw new Error(`更多 sheet lacks ${h}: ${labels.join(" | ")}`);
    await shot("m9-more-sheet");
    await evaluate(`document.querySelector('.sheet-backdrop a[href="#/insights"]').click()`);
    await sleep(900);
    const state = await evaluate(`({ hash: location.hash, sheet: !!document.querySelector('.sheet-backdrop'), cur: document.querySelector('.tab-more')?.getAttribute('aria-current') })`);
    if (state.hash !== "#/insights" || state.sheet || state.cur !== "page") throw new Error(JSON.stringify(state));
    return labels.join(" | ");
  });
  await step("mobile: 拼装模式 from pattern detail (finish colour, undo, row mode, board sheet, resume)", async () => {
    if (!recognizedHash) throw new Error("no saved pattern");
    await go(recognizedHash);
    await waitFor(`[...document.querySelectorAll('button')].some(b => /^(开始拼|继续拼)/.test(b.innerText.trim()))`, 15000, "开始拼 button");
    await evaluate(`[...document.querySelectorAll('button')].find(b => /^(开始拼|继续拼)/.test(b.innerText.trim())).click()`);
    await waitFor(`location.hash.startsWith('#/build/') && document.querySelector('[data-build-root]')`, 15000, "build page");
    await sleep(500);
    const read = () => evaluate(`(() => { const r = document.querySelector('[data-build-root]'); return { board: r.dataset.buildBoard, color: r.dataset.buildColor, progress: Number(r.dataset.buildProgress), chip: document.querySelector('[data-build-chip]')?.innerText ?? '', chrome: !!document.querySelector('.tabbar') && getComputedStyle(document.querySelector('.tabbar')).display !== 'none' }; })()`);
    const s0 = await read();
    if (s0.board !== "1" || !s0.color || s0.progress !== 0) throw new Error("bad initial state " + JSON.stringify(s0));
    if (s0.chrome) throw new Error("tab bar still visible in build mode");
    await noHorizontalScroll("build mode");
    await shot("m10-build");
    await evaluate(`document.querySelector('[data-build-finish]').click()`);
    await sleep(400);
    const s1 = await read();
    if (s1.board === s0.board && s1.color === s0.color) {
      const dbg = await evaluate(`JSON.stringify({ ds: { ...document.querySelector('[data-build-root]').dataset }, btn: document.querySelector('[data-build-finish]')?.outerHTML.slice(0, 200), txt: document.querySelector('[data-build-root]').innerText.slice(0, 300) })`);
      throw new Error("finish colour did not advance " + JSON.stringify(s1) + " :: " + dbg);
    }
    await evaluate(`document.querySelector('[data-build-undo]').click()`);
    await sleep(300);
    const s2 = await read();
    if (s2.color !== s0.color || s2.board !== s0.board) throw new Error("undo did not restore " + JSON.stringify(s2));
    await evaluate(`document.querySelector('[data-build-finish]').click()`);
    await sleep(300);
    await evaluate(`document.querySelector('[data-build-mode-toggle]').click()`);
    await waitFor(`document.querySelector('[data-build-row]')`, 5000, "row strip");
    const rowText = await evaluate(`document.querySelector('[data-build-row]').innerText`);
    await evaluate(`document.querySelector('[data-build-mode-toggle]').click()`);
    await evaluate(`document.querySelector('[data-build-board-open]').click()`);
    await waitFor(`document.querySelector('[data-build-board-btn="2"]')`, 5000, "board map");
    await shot("m11-build-boards");
    await evaluate(`document.querySelector('[data-build-board-btn="2"]').click()`);
    await sleep(400);
    const s3 = await read();
    if (s3.board !== "2") throw new Error("board did not switch " + JSON.stringify(s3));
    await sleep(2200); // 等防抖保存
    await evaluate(`location.reload()`);
    await waitFor(`document.querySelector('[data-build-root]')`, 30000, "build page after reload");
    await sleep(600);
    const s4 = await read();
    if (s4.board !== "2") throw new Error("position not restored after reload " + JSON.stringify(s4));
    return `start ${s0.color} → ${s1.color} (${s1.progress}%); row "${rowText.slice(0, 40)}"; resumed board ${s4.board} ${s4.progress}%`;
  });

  await step("mobile 390: zoomed recognition preview, inspector, pinch, no overflow; dark + desktop-dark shots", async () => {
    await go("#/add?mode=recognize");
    await clickText("换一张").catch(() => {});
    await sleep(300);
    await setFile(chartPath);
    await waitFor(`[...document.querySelectorAll('button')].some(b => b.innerText.trim() === '重新识别' && !b.disabled) && [...document.querySelectorAll('button[type=submit]')].some(b => b.innerText.includes('保存到图库'))`, 240000, "recognition done (mobile)");
    await sleep(800);
    await evaluate(`document.querySelector('.pt-zoom-box').scrollIntoView({block:'center'})`);
    await shot("m10-recognize-fit");
    // 双指捏合（触摸）
    const c = await evaluate(`(() => { const r = document.querySelector('.pt-zoom-box').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + Math.min(r.height, 400) / 2 }; })()`);
    const pt = (dx) => [{ x: c.x - dx, y: c.y, id: 1 }, { x: c.x + dx, y: c.y, id: 2 }];
    await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pt(20) });
    for (let d = 30; d <= 120; d += 10) await send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pt(d) });
    await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await sleep(500);
    const sp = await zscale();
    if (!(sp > 2)) throw new Error("touch pinch did not zoom: " + sp);
    await zoomFit();
    const txt = await zoomAndInspect();
    await evaluate(`document.querySelector('.pt-zoom-box').scrollIntoView({block:'start'})`);
    await sleep(300);
    await shot("m11-zoomed-inspector");
    await noHorizontalScroll("recognize zoomed + inspector");
    // 触屏点按核对：一次轻点
    const tap = await evaluate(`(() => { const r = document.querySelector('.pt-ov-lines').getBoundingClientRect(); const b = document.querySelector('.pt-zoom-box').getBoundingClientRect(); return { x: Math.min(b.right - 20, Math.max(b.left + 20, r.left + r.width / 2 + 25)), y: Math.min(b.bottom - 20, Math.max(b.top + 20, r.top + r.height / 2)) }; })()`);
    await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: tap.x, y: tap.y, id: 1 }] });
    await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await sleep(500);
    const tapTxt = await inspectorText();
    if (!/行 \d+/.test(tapTxt)) throw new Error("touch tap did not open inspector");
    // 减少动态：缩放无过渡
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await clickText("+", ".pt-zoom button"); await sleep(60);
    const rm = await evaluate(`(() => { const b = document.querySelector('.pt-zoom-box'); return { smooth: b.dataset.smooth, td: getComputedStyle(b.querySelector('.pt-zoom-inner')).transitionDuration }; })()`);
    await send("Emulation.setEmulatedMedia", { features: [] });
    if (rm.smooth !== "false" && rm.td !== "0s") throw new Error("reduced motion still animates zoom: " + JSON.stringify(rm));
    // 暗色
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
    await sleep(300);
    await shot("m12-zoomed-dark");
    await setViewport(1366, 900);
    await sleep(600);
    await evaluate(`document.querySelector('.pt-zoom-box').scrollIntoView({block:'center'})`);
    await shot("23-zoomed-inspector-dark-desktop");
    await noHorizontalScroll("recognize zoomed dark desktop");
    await send("Emulation.setEmulatedMedia", { features: [] });
    await setViewport(390, 844, true);
    return `pinch ${sp.toFixed(2)} · ${txt.slice(0, 90)} · reduced-motion ${JSON.stringify(rm)}`;
  });
  await step("mobile: pattern detail pinch-zooms the bead chart (touch)", async () => {
    await go(recognizedHash || "#/gallery");
    await waitFor(`document.querySelector('.pt-matrix-scroll canvas')`, 15000, "matrix canvas");
    await sleep(500);
    const w0 = await evaluate(`document.querySelector('.pt-matrix-scroll canvas').width`);
    const c = await evaluate(`(() => { const r = document.querySelector('.pt-matrix-scroll').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + Math.min(r.height, 300) / 2 }; })()`);
    await evaluate(`document.querySelector('.pt-matrix-scroll').scrollIntoView({block:'center'})`);
    const c2 = await evaluate(`(() => { const r = document.querySelector('.pt-matrix-scroll').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + Math.min(r.height, 300) / 2 }; })()`);
    const pt = (dx) => [{ x: c2.x - dx, y: c2.y, id: 1 }, { x: c2.x + dx, y: c2.y, id: 2 }];
    await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pt(20) });
    for (let d = 30; d <= 110; d += 10) await send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pt(d) });
    await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await sleep(600);
    const w1 = await evaluate(`document.querySelector('.pt-matrix-scroll canvas').width`);
    await shot("m9-pattern-pinched");
    void c;
    if (!(w1 > w0 * 1.3)) throw new Error(`canvas width ${w0} -> ${w1}: pinch did not zoom`);
    return `canvas ${w0} -> ${w1}`;
  });
  await step("pattern detail: source image zooms with buttons", async () => {
    await clickText("原图", ".seg button").catch(() => {});
    await sleep(500);
    const ok = await evaluate(`!!document.querySelector('.pt-zoom-box')`);
    if (ok) { await clickText("+", ".pt-zoom button"); await sleep(200); }
    const pct = ok ? await evaluate(`document.querySelector('.pt-zoom .meta.num').innerText`) : "no source view";
    if (ok && pct.trim() === "100%") throw new Error("zoom stayed 100%");
    return pct;
  });
  await step("mobile sheet drag-down closes", async () => {
    await go("#/inventory");
    await clickText("批量入库");
    await waitFor(`document.querySelector('.sheet .sheet-head')`, 5000, "sheet open");
    await sleep(400);
    const box = await evaluate(`(() => { const r = document.querySelector('.sheet .sheet-head h3').getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 }; })()`);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
    for (let i = 1; i <= 8; i++) await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y + i * 20, button: "left", buttons: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y + 160, button: "left", clickCount: 1 });
    await waitFor(`!document.querySelector('.sheet')`, 3000, "sheet closed by drag");
    return "dragged 160px → closed";
  });
  await step("mobile sheet small drag springs back", async () => {
    await clickText("批量入库");
    await waitFor(`document.querySelector('.sheet .sheet-head')`, 5000, "sheet open");
    await sleep(400);
    const box = await evaluate(`(() => { const r = document.querySelector('.sheet .sheet-head h3').getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 }; })()`);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y + 40, button: "left", buttons: 1 });
    await sleep(200);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y + 40, button: "left", clickCount: 1 });
    await sleep(500);
    if (!(await evaluate(`!!document.querySelector('.sheet')`))) throw new Error("sheet closed on a 40px drag");
    await shot("m7-sheet");
    await clickText("取消", ".sheet button");
    await waitFor(`!document.querySelector('.sheet')`, 3000, "sheet closed");
    return "40px → stayed open";
  });
  await setViewport(1366, 900);
  await step("reduced motion: sheet closes instantly, no running animations", async () => {
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await go("#/inventory");
    await clickText("批量入库");
    await waitFor(`document.querySelector('.sheet')`, 5000, "sheet open");
    await clickText("取消", ".sheet button");
    const gone = await evaluate(`new Promise((r) => requestAnimationFrame(() => r(!document.querySelector('.sheet'))))`);
    if (!gone) throw new Error("sheet still mounted one frame after close under reduced motion");
    const running = await evaluate(`document.getAnimations().filter((a) => a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity).length`);
    await send("Emulation.setEmulatedMedia", { features: [] });
    return `closed next frame · running finite animations ${running}`;
  });
  await step("mobile 390: capture tips + stitch flow, no overflow; dark; reduced motion", async () => {
    await setViewport(390, 844, true);
    await freshRecognize();
    await sleep(300);
    await noHorizontalScroll("add recognise upload (tips)");
    await shot("m30-tips");
    await setFile(tileOrder, '[data-testid=stitch-input]');
    await waitFor(`document.querySelector('[data-testid=stitch-result]')`, 120000, "stitch result (mobile)");
    await sleep(600);
    await noHorizontalScroll("stitch result");
    await evaluate(`document.querySelector('[data-testid=stitch-result]').scrollIntoView({block:'start'})`);
    await shot("m31-stitch-result");
    // 缩略图操作按钮触控尺寸 ≥ 44px
    const small = await evaluate(`[...document.querySelectorAll('.st-thumb-actions button')].filter(b => { const r = b.getBoundingClientRect(); return r.width < 43 || r.height < 43; }).length`);
    if (small) throw new Error(small + " thumb buttons smaller than 44px");
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
    await sleep(400);
    await shot("m32-stitch-dark");
    await evaluate(`window.scrollTo(0, 0)`);
    await shot("m33-stitch-dark-top");
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await freshRecognize();
    await clickText("怎样拿到更清楚的图纸");
    await sleep(100);
    const dur = await evaluate(`getComputedStyle(document.querySelector('.st-tips-chev')).transitionDuration`);
    await clickText("怎样拿到更清楚的图纸");
    await send("Emulation.setEmulatedMedia", { features: [] });
    if (!/^(0(\.00?\d*)?s)(, 0(\.00?\d*)?s)*$/.test(dur)) throw new Error("tips chevron still animates under reduced motion: " + dur);
    await setViewport(1366, 900);
    return "no overflow, 44px targets, dark ok, reduced-motion transition " + dur;
  });
  await step("desktop dark: stitch result", async () => {
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
    await freshRecognize();
    await setFile(tileOrder, '[data-testid=stitch-input]');
    await waitFor(`document.querySelector('[data-testid=stitch-result]')`, 120000, "stitch result (desktop dark)");
    await sleep(600);
    await shot("35-stitch-dark");
    await send("Emulation.setEmulatedMedia", { features: [] });
    return "ok";
  });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await step("dark mode dashboard", async () => { await go("#/"); await shot("14-dashboard-dark"); return "ok"; });
  await step("dark mode batch + recognise", async () => { await go("#/add?mode=batch"); await shot("17-batch-dark"); return "ok"; });
  await step("dark mode inventory", async () => { await go("#/inventory"); await shot("15-inventory-dark"); return "ok"; });
  checks.push({ check: "token contrast (dark)", ok: true, detail: JSON.stringify(await evaluate(CONTRAST)) });
  checks.push({ check: "console/page errors = 0", ok: errors.length === 0, detail: errors.slice(0, 5).map((e) => e.text).join(" | ") });
} catch (e) {
  checks.push({ check: "smoke harness", ok: false, detail: String(e.stack ?? e) });
} finally {
  writeFileSync(resolve(outDir, "report.json"), JSON.stringify({ url, checks, errors }, null, 2));
  for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.check}${c.ms ? ` (${c.ms}ms)` : ""}${c.ok ? "" : `  -> ${c.detail}`}`);
  console.log(`console/page errors: ${errors.length}`);
  for (const e of errors.slice(0, 20)) console.log(`  [${e.type}] ${String(e.text).slice(0, 300)}`);
  try { ws?.close(); } catch { /* */ }
  browser.kill();
  await sleep(500);
  // Edge 有时还没完全释放用户目录：清理失败不影响检查结果
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 }); } catch (e) { console.log(`(profile cleanup skipped: ${e?.code ?? e})`); }
  process.exit(checks.every((c) => c.ok) && !errors.some((e) => e.type === "exception") ? 0 : 1);
}
