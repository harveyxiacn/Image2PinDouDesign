// 浏览器冒烟检查：无第三方依赖，用本机 Chromium 内核浏览器（Edge / Chrome）的 headless + CDP
// 走一遍真实界面流程并截图。不在 CI 里跑（需要真实浏览器和一张测试图片），发布前本机执行。
//
// 用法（Node ≥ 22，自带 WebSocket）：
//   npm run build && npx vite preview --port 4173
//   node scripts/smoke/browser-smoke.mjs http://127.0.0.1:4173 <测试图片> <输出目录>
// 浏览器路径用环境变量 BROWSER_PATH 指定；默认 Windows 版 Edge。每次运行用全新的浏览器
// 配置目录（输出目录/profile），避免 PWA 缓存旧版本。
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [url, imagePath, outDir] = process.argv.slice(2);
if (!url || !imagePath || !outDir) {
  console.error("用法：node scripts/smoke/browser-smoke.mjs <url> <imagePath> <outDir>");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });
rmSync(resolve(outDir, "profile"), { recursive: true, force: true });
const port = Number(process.env.CDP_PORT ?? 9336);
const browserPath = process.env.BROWSER_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const edge = spawn(browserPath, [
  "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${resolve(outDir, "profile")}`,
  "--no-first-run", "--disable-gpu", "--hide-scrollbars", "about:blank"
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
const checks = [];
let ws; let seq = 0; const pending = new Map();

async function connect() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error("browser CDP not reachable");
}
// 每个 CDP 调用都带超时；浏览器连接断开时让所有等待中的调用立即失败，避免脚本无声挂起。
function send(method, params = {}, timeoutMs = 30000) {
  const id = ++seq;
  if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("browser connection closed"));
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => {
    const timer = setTimeout(() => { pending.delete(id); rej(new Error(`CDP timeout: ${method}`)); }, timeoutMs);
    pending.set(id, { res: (v) => { clearTimeout(timer); res(v); }, rej: (e) => { clearTimeout(timer); rej(e); } });
  });
}
// 取图纸画布在当前窗口内可见部分的矩形（鼠标事件只能落在可见区域）。
const visibleCanvasBox = () => evaluate(`(() => {
  const v = document.querySelector('.canvas-viewport'); v.scrollIntoView({ block: "center" });
  const c = v.querySelector('canvas').getBoundingClientRect(); const r = v.getBoundingClientRect();
  const left = Math.max(c.left, r.left, 0), top = Math.max(c.top, r.top, 0);
  const right = Math.min(c.right, r.right, innerWidth), bottom = Math.min(c.bottom, r.bottom, innerHeight);
  return { x: left, y: top, w: right - left, h: bottom - top };
})()`);
async function evaluate(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + expression);
  return r.result.value;
}
async function waitFor(expression, timeout = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await evaluate(expression)) return true;
    await sleep(250);
  }
  throw new Error("timeout: " + expression);
}
async function viewport(width, height, mobile = false) {
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
}
async function shot(name, selector, full = false) {
  let clip;
  if (selector) {
    const box = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null;
      el.scrollIntoView({block: "start"}); const r = el.getBoundingClientRect();
      return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: Math.min(r.height, 3000) }; })()`);
    if (!box) { errors.push("missing selector " + selector); return; }
    clip = { ...box, scale: 1 };
  } else {
    const m = await send("Page.getLayoutMetrics");
    const height = full ? Math.min(m.cssContentSize.height, 5000) : m.cssLayoutViewport.clientHeight;
    await evaluate("window.scrollTo(0, 0)");
    clip = { x: 0, y: 0, width: m.cssLayoutViewport.clientWidth, height, scale: 1 };
  }
  await sleep(450);
  const r = await send("Page.captureScreenshot", { format: "png", clip, captureBeyondViewport: true });
  writeFileSync(join(outDir, name + ".png"), Buffer.from(r.data, "base64"));
  console.log("shot", name, Math.round(clip.width), "x", Math.round(clip.height));
}
const click = (text, selector = "button, [role=tab]") => evaluate(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(selector)})].find((el) => el.textContent.trim() === ${JSON.stringify(text)} && el.offsetParent !== null); if (!b) return false; b.click(); return true; })()`);
async function step(label, fn) {
  try {
    const ok = await fn();
    checks.push(`${ok === false ? "FAIL" : "ok"} ${label}`);
  } catch (error) {
    checks.push(`FAIL ${label}: ${error.message}`);
  }
}
const overflow = () => evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth");

try {
  ws = new WebSocket(await connect());
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  ws.addEventListener("close", () => {
    errors.push("smoke failure: browser connection closed");
    for (const [, p] of pending) p.rej(new Error("browser connection closed"));
    pending.clear();
  });
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result);
    } else if (msg.method === "Inspector.targetCrashed") {
      errors.push("smoke failure: page crashed");
    } else if (msg.method === "Runtime.exceptionThrown") {
      errors.push("exception: " + (msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text));
    } else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      errors.push("console.error: " + msg.params.args.map((a) => a.value ?? a.description).join(" "));
    } else if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
      errors.push("log: " + msg.params.entry.text + " " + (msg.params.entry.url ?? ""));
    }
  });
  await send("Page.enable"); await send("Inspector.enable"); await send("Runtime.enable"); await send("Log.enable"); await send("DOM.enable");
  await viewport(1440, 900);
  await send("Page.navigate", { url });
  await waitFor("document.readyState === 'complete' && !!document.querySelector('input[type=file]')");
  await sleep(900);
  await shot("01-welcome-desktop");
  await step("welcome has no inspector", async () => !(await evaluate("!!document.querySelector('[role=tablist]')")));

  const doc = await send("DOM.getDocument", { depth: -1, pierce: true });
  const { nodeId } = await send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: ".dropzone input[type=file]" });
  await send("DOM.setFileInputFiles", { nodeId, files: [resolve(imagePath)] });
  await waitFor("!!document.querySelector('.canvas-stage canvas') && !document.querySelector('.converting-banner')", 90000);
  await sleep(1400);
  await shot("02-workbench-desktop");
  await step("three panes visible", () => evaluate(`["rail","stage","inspector"].every((c) => { const el = document.querySelector("." + c); return el && el.getBoundingClientRect().width > 150; })`));

  await step("advisor card visible", () => evaluate("!!document.querySelector('.advisor-card .composition-bar span')"));
  await shot("02b-advisor", ".advisor-card");
  await step("104-pin option", () => evaluate("[...document.querySelectorAll('[aria-label=单块拼豆板针数] button')].some((b) => b.textContent.trim() === '104 针')"));

  await step("brush drag is one undo step", async () => {
    await click("开始编辑图纸");
    await sleep(300);
    // 用橡皮：任何非空格都会被改动；在视口可见区域内横向拖动。
    await click("擦除");
    await sleep(400);
    const box = await evaluate(`(() => { const v = document.querySelector('.canvas-viewport'); v.scrollIntoView({block: "center"}); v.scrollTop = v.scrollHeight; const r = v.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
    await sleep(300);
    const y = box.y + box.h * 0.75;
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x + box.w * 0.3, y, button: "left", clickCount: 1 });
    for (let i = 1; i <= 8; i += 1) {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x + box.w * (0.3 + i * 0.04), y, button: "left", buttons: 1 });
    }
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x + box.w * 0.62, y, button: "left", clickCount: 1 });
    await sleep(500);
    const undoEnabled = await evaluate("!![...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '撤销' && !b.disabled)");
    await shot("02c-brush-stroke", ".preview-panel");
    await click("撤销");
    await sleep(300);
    const undoDisabledAfterOne = await evaluate("!![...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '撤销' && b.disabled)");
    await click("完成编辑");
    return undoEnabled && undoDisabledAfterOne;
  });

  await step("view switch pixelated", () => click("像素化"));
  await sleep(500);
  await shot("03-stage-pixelated", ".stage");
  await click("图纸");

  await step("board mode", () => click("按拼豆板"));
  await sleep(200);
  await click("29 针");
  await evaluate(`document.querySelector('[aria-label="增加横向块数"]')?.click()`);
  await sleep(200);
  await click("按图片比例排板");
  await waitFor("!document.querySelector('.converting-banner')", 90000);
  await sleep(1000);
  await shot("04-inspector-size", ".inspector");
  const state = await evaluate(`({ summary: document.querySelector('.board-summary')?.textContent, badge: document.querySelector('.preview-panel .badge')?.textContent })`);
  console.log("state", JSON.stringify(state));
  await step("board size 58x58", () => state.badge === "58 x 58");

  await step("build mode board navigation", async () => {
    await click("开始编辑图纸");
    await sleep(200);
    await click("制作打卡");
    await sleep(400);
    const options = await evaluate("document.querySelector('select[aria-label=当前制作的板]')?.options.length ?? 0");
    await click("下一块");
    await sleep(400);
    await shot("04b-build-board", ".preview-panel");
    const label = await evaluate("document.querySelector('.build-progress-copy strong')?.textContent ?? ''");
    return options === 5 && label.includes("本板");
  });

  await step("paint bucket is one undo step", async () => {
    await click("油漆桶");
    await sleep(300);
    // 换成图里不会出现的色号（珠光 P1），保证点哪里都会产生改动。
    await evaluate(`(() => { const sel = document.querySelector('select[aria-label=绘制色号]');
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(sel, "P1");
      sel.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    await sleep(200);
    const box = await visibleCanvasBox();
    await sleep(300);
    const before = await evaluate("[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '撤销' && !b.disabled)");
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x + box.w * 0.5, y: box.y + box.h * 0.5, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x + box.w * 0.5, y: box.y + box.h * 0.5, button: "left", clickCount: 1 });
    await sleep(500);
    const after = await evaluate("[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '撤销' && !b.disabled)");
    if (after) { await click("撤销"); await sleep(300); }
    return !before && after;
  });

  await step("marquee select shows a selection box", async () => {
    await click("框选");
    await sleep(300);
    const box = await visibleCanvasBox();
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x + box.w * 0.3, y: box.y + box.h * 0.3, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x + box.w * 0.45, y: box.y + box.h * 0.45, button: "left", buttons: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x + box.w * 0.45, y: box.y + box.h * 0.45, button: "left", clickCount: 1 });
    await sleep(400);
    await shot("04c-marquee", ".preview-panel");
    const ok = await evaluate("!!document.querySelector('.grid-selection') && /已选 \\d+ × \\d+ 格/.test(document.querySelector('.selection-tools')?.textContent ?? '')");
    await click("完成编辑");
    return ok;
  });

  await step("bead look preview", async () => {
    await click("成品效果");
    await sleep(500);
    await shot("04d-bead-look", ".stage");
    const ok = await evaluate("!!document.querySelector('.bead-preview canvas')");
    await click("图纸");
    return ok;
  });

  await step("import design file adds a draft", async () => {
    const fixture = resolve(outDir, "fixture.pindou.json");
    writeFileSync(fixture, JSON.stringify({ format: "image2pindou-designs", version: 1, designs: [
      { id: "draft-x", fileName: "导入测试.png", boardWidth: 3, boardHeight: 2, matrix: [["A4", "H7", null], ["H7", "A4", "B3"]] }
    ] }));
    const before = await evaluate("document.querySelectorAll('.gallery-card, .design-card, [data-design-id]').length");
    const docNode = await send("DOM.getDocument", { depth: -1, pierce: true });
    const input = await send("DOM.querySelector", { nodeId: docNode.root.nodeId, selector: "input[accept='.json,application/json']" });
    await send("DOM.setFileInputFiles", { nodeId: input.nodeId, files: [fixture] });
    await sleep(800);
    const badge = await evaluate("document.querySelector('.preview-panel .badge')?.textContent");
    console.log("import", before, badge);
    return badge === "3 x 2";
  });

  await step("tab 颜色", () => click("颜色", "[role=tab]"));
  await sleep(400);
  await shot("05-inspector-color", ".inspector");
  await step("kit select has 12 official kits", () => evaluate("document.querySelector('select[aria-label=色卡套装]')?.options.length === 12"));
  await step("open palette dialog", () => click("查看色卡 / 管理库存"));
  await sleep(600);
  await step("dialog visible", () => evaluate("!!document.querySelector('[role=dialog]')"));
  await shot("06-palette-dialog");
  await step("stock list view", async () => {
    await click("库存颗数");
    await sleep(300);
    return evaluate("document.querySelectorAll('.palette-stock-row input').length >= 200");
  });
  await shot("06b-stock-list");
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))");
  await sleep(400);
  await step("dialog closed by Escape", async () => !(await evaluate("!!document.querySelector('[role=dialog]')")));

  await step("tab 效果", () => click("效果", "[role=tab]"));
  await sleep(300);
  await shot("07-inspector-effects", ".inspector");
  await step("tab 用豆", () => click("用豆", "[role=tab]"));
  await sleep(300);
  await shot("08-inspector-beads", ".inspector");

  await step("save draft toast", async () => {
    await click("保存本机草稿");
    await sleep(300);
    return evaluate("!!document.querySelector('.toast')");
  });
  await sleep(200);
  await shot("09-toast-desktop");

  await viewport(1024, 768);
  await sleep(800);
  await step("tablet no overflow", async () => (await overflow()) <= 0);
  await shot("10-tablet");

  await viewport(390, 844, true);
  await sleep(800);
  console.log("mobile horizontal overflow px", await overflow());
  await step("mobile no overflow", async () => (await overflow()) <= 0);
  await shot("11-mobile-top");
  await step("mobile nav opens 用豆", () => click("用豆", ".mobile-nav button"));
  await sleep(600);
  await shot("12-mobile-full", null, true);
} catch (error) {
  errors.push("smoke failure: " + error.message);
} finally {
  writeFileSync(join(outDir, "errors.json"), JSON.stringify({ errors, checks }, null, 2));
  console.log("checks", JSON.stringify(checks));
  console.log("errors", JSON.stringify(errors));
  try { await send("Browser.close"); } catch {}
  edge.kill();
  const failed = errors.some((e) => e.startsWith("smoke failure") || e.startsWith("exception")) || checks.some((c) => c.startsWith("FAIL"));
  process.exit(failed ? 1 : 0);
}
