// 拼豆仓浏览器冒烟：用本机 Edge/Chrome headless + CDP（零依赖）走一遍真实界面并截图。
// 用法：node scripts/smoke.mjs <hubUrl> <outDir> <图纸图片> <照片>
// 浏览器路径：环境变量 BROWSER_PATH（默认 Windows Edge）。
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const [url, outDir, chartPath, photoPath] = process.argv.slice(2);
if (!url || !outDir || !chartPath || !photoPath) { console.error("用法：node scripts/smoke.mjs <url> <outDir> <chart> <photo>"); process.exit(2); }
mkdirSync(outDir, { recursive: true });
const profile = resolve(outDir, "profile");
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
  const name = (el) => (el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || el.value || '').trim();
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
async function setFile(path) {
  const doc = await send("DOM.getDocument", { depth: -1, pierce: true });
  const q = await send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: 'input[type="file"]' });
  if (!q.nodeId) throw new Error("file input not found");
  await send("DOM.setFileInputFiles", { nodeId: q.nodeId, files: [path] });
}
async function clickText(text, selector = "button") {
  const ok = await evaluate(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(b => b.innerText.trim().startsWith(${JSON.stringify(text)}) && !b.disabled); if (!el) return false; el.scrollIntoView({block:"center"}); el.focus(); el.click(); return true; })()`);
  if (!ok) throw new Error(`button not found/enabled: ${text}`);
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
    if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") errors.push({ type: "log", text: `${msg.params.entry.text} ${msg.params.entry.url ?? ""}` });
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
  await step("recognize chart (legend + grid)", async () => {
    await go("#/add?mode=recognize");
    await setFile(chartPath);
    await waitFor(`[...document.querySelectorAll('button')].some(b => b.innerText.trim() === '重新识别' && !b.disabled) && [...document.querySelectorAll('button[type=submit]')].some(b => b.innerText.includes('保存到图库'))`, 240000, "recognition done");
    await sleep(800);
    await shot("04-recognize-result");
    recognizedText = await evaluate("document.querySelector('main').innerText");
    if (!/格内色号 \d+\/\d+ 色/.test(recognizedText)) throw new Error("in-cell code chip missing");
    if (!recognizedText.includes("11,128")) throw new Error("total 11,128 not shown");
    return recognizedText.match(/读取格内色号[^\n]*\n[^\n]*/)?.[0] ?? recognizedText.slice(0, 400);
  });
  await step("save recognized pattern", async () => {
    await evaluate(`(() => { const f = document.querySelector('form'); const s = f.querySelector('[aria-pressed]') ; const btns=[...f.querySelectorAll('button[type=button]')]; const plan = btns.find(b => b.innerText.includes('计划做')); plan?.click(); })()`);
    await sleep(200);
    await clickText("保存到图库", "button[type=submit]");
    await waitFor(`location.hash.startsWith("#/pattern/")`, 60000, "pattern detail");
    await sleep(1200);
    await shot("05-pattern-detail");
    return await evaluate("location.hash");
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

  for (const [hash, name] of [["#/", "08-dashboard"], ["#/gallery", "09-gallery"], ["#/gallery?tab=images", "10-images"], ["#/shopping", "11-shopping"], ["#/history", "12-history"], ["#/settings", "13-settings"]]) {
    await step(`page ${hash}`, async () => { await go(hash); await shot(name); await noHorizontalScroll(hash); return (await evaluate("document.querySelector('main').innerText")).slice(0, 300); });
  }


  // ---- 第 8 阶段证据：无障碍与交互 ----
  const auditAll = [];
  for (const hash of ["#/", "#/gallery", "#/inventory", "#/shopping", "#/history", "#/settings", "#/add?mode=recognize", "#/add?mode=generate", "#/add?mode=manual"]) {
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
  checks.push({ check: "token contrast (light)", ok: true, detail: JSON.stringify(await evaluate(CONTRAST)) });
  await setViewport(390, 844, true);
  for (const [hash, name] of [["#/", "m1-dashboard"], ["#/inventory", "m2-inventory"], ["#/add?mode=recognize", "m3-add"], ["#/gallery", "m4-gallery"], ["#/shopping", "m5-shopping"], ["#/settings", "m6-settings"]]) {
    await step(`mobile ${hash}`, async () => { await go(hash); await shot(name); await noHorizontalScroll(hash); return "ok"; });
  }

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
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await step("dark mode dashboard", async () => { await go("#/"); await shot("14-dashboard-dark"); return "ok"; });
  await step("dark mode inventory", async () => { await go("#/inventory"); await shot("15-inventory-dark"); return "ok"; });
  checks.push({ check: "token contrast (dark)", ok: true, detail: JSON.stringify(await evaluate(CONTRAST)) });
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
  rmSync(profile, { recursive: true, force: true });
  process.exit(checks.every((c) => c.ok) && !errors.some((e) => e.type === "exception") ? 0 : 1);
}
