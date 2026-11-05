#!/usr/bin/env node
// 合成图纸基准：程序生成像素画 + 5 种真实图纸版式，用 headless Edge 的 canvas 渲染（真实字体），
// 输出图片 + truth.json（与 web/src/test/chart-truth.json 同格式，eval-recognition.mjs 可直接使用）。
// 用法（在 pindou-hub 目录）：node scripts/synth-charts.mjs [--out DIR] [--n N] [--seed S] [--palette palette.ts]
//   默认输出 %TEMP%\ph-synth，每个 seed 结果确定。文件：<style>/<id>_<variant>.<ext>，variant = orig / w1080q75 / halfq60 / w720q60。
// 评测：node scripts/eval-recognition.mjs <DIR> --truth <DIR>\truth.json --out <结果.json>
// 图片只写到输出目录，不进仓库。无 npm 依赖（jpeg-js 为现有 devDependency）。
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

const HUB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const OUT = resolve(opt("--out", join(tmpdir(), "ph-synth")));
const N = Number(opt("--n", 40));
const SEED = Number(opt("--seed", 1));
const BROWSER = process.env.BROWSER_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const jpeg = createRequire(join(HUB, "package.json"))("jpeg-js");

// ---------------------------------------------------------------- 随机数
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const mkRng = (seed, idx) => {
  const r = mulberry32((seed * 2654435761 + idx * 40503 + 12345) >>> 0);
  const o = {
    f: r, int: (a, b) => a + Math.floor(r() * (b - a + 1)), range: (a, b) => a + r() * (b - a),
    pick: (arr) => arr[Math.floor(r() * arr.length)], chance: (p) => r() < p,
    shuffle: (arr) => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
  };
  return o;
};

// ---------------------------------------------------------------- MARD 色卡（直接读 src/domain/palette.ts）
function loadPalette() {
  const cands = [opt("--palette", null), join(HUB, "..", "src", "domain", "palette.ts"), join(HUB, "src", "domain", "palette.ts")].filter(Boolean);
  const file = cands.find((p) => existsSync(p));
  if (!file) throw new Error("找不到 palette.ts（用 --palette 指定）");
  const text = readFileSync(file, "utf8");
  const seen = new Map();
  for (const m of text.matchAll(/code:\s*"([A-Z]\d{1,2})"[^}]*?hex:\s*"(#[0-9a-fA-F]{6})"/g)) if (!seen.has(m[1])) seen.set(m[1], m[2].toLowerCase());
  const pal = [...seen].map(([code, hex]) => ({ code, hex, rgb: [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) }));
  if (pal.length < 100) throw new Error(`色卡只解析到 ${pal.length} 色`);
  return pal;
}
const lum = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// ---------------------------------------------------------------- 版式
const STYLES = [
  { dir: "a-codes-legend", desc: "synthetic A: codes printed in every cell, legend chips below as 'A1 154'", fonts: ["Arial", "Microsoft YaHei"] },
  { dir: "b-kaiti-chips", desc: "synthetic B: no cell codes, KaiTi legend chips with code inside and 'x671' count beside", fonts: ["KaiTi"] },
  { dir: "c-twoline-legend", desc: "synthetic C: codes in cells, two-line legend entries (code over count)", fonts: ["SimHei", "Microsoft YaHei"] },
  { dir: "d-header-ruler", desc: "synthetic D: header '尺寸:CxR · N 色 · T 颗', rulers on top/left, checkerboard empty cells, legend chips 'A26 (871)'", fonts: ["Microsoft YaHei"] },
  { dir: "e-watermark", desc: "synthetic E: diagonal semi-transparent watermark over chart, '材料清单统计 总计: T 颗 | 规格 CxR' legend grid", fonts: ["Arial", "Microsoft YaHei"] }
];
const VARIANTS = [
  { name: "orig", ext: "png" },
  { name: "w1080q75", ext: "jpg", long: 1080, q: 75 },
  { name: "halfq60", ext: "jpg", scale: 0.5, q: 60 },
  { name: "w720q60", ext: "jpg", long: 720, q: 60 }
];

// ---------------------------------------------------------------- 设计生成
function genSize(rng, styleIdx) {
  const logu = (lo, hi) => Math.round(Math.exp(rng.range(Math.log(lo), Math.log(hi))));
  let cols = styleIdx === 4 ? logu(60, 140) : logu(29, 140);
  let rows = rng.chance(0.3) ? cols + rng.int(-2, 2) : logu(29, 140);
  if (styleIdx === 4 && rows < 50) rows = rng.int(50, 100);
  const clamp = (v) => Math.max(29, Math.min(140, v));
  cols = clamp(cols); rows = clamp(rows);
  // 长宽比限制在 1:2.2 以内
  if (cols / rows > 2.2) rows = clamp(Math.ceil(cols / 2.2)); else if (rows / cols > 2.2) cols = clamp(Math.ceil(rows / 2.2));
  return { cols, rows };
}

function genMask(rng, cols, rows) {
  const shapes = [];
  const K = rng.int(3, 7);
  const sym = rng.chance(0.5);
  for (let i = 0; i < K; i++) {
    const s = { u: rng.range(0.2, 0.8), v: rng.range(0.15, 0.85), a: rng.range(0.09, 0.3), b: rng.range(0.09, 0.3), p: rng.pick([2, 2, 2, 3, 4]) };
    shapes.push(s);
    if (sym) shapes.push({ ...s, u: 1 - s.u });
  }
  const inside = (x, y) => shapes.some((s) => (Math.abs((x - s.u) / s.a) ** s.p + Math.abs((y - s.v) / s.b) ** s.p) <= 1);
  // 连续空间的包围盒
  let x0 = 1, x1 = 0, y0 = 1, y1 = 0;
  for (let j = 0; j < 160; j++) for (let i = 0; i < 160; i++) {
    const x = (i + 0.5) / 160, y = (j + 0.5) / 160;
    if (inside(x, y)) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  }
  if (x1 <= x0 || y1 <= y0) return null;
  const mx = rng.int(0, 2), my = rng.int(0, 2);
  const m = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const fx = (c + 0.5 - mx) / (cols - 2 * mx), fy = (r + 0.5 - my) / (rows - 2 * my);
    if (fx < 0 || fx > 1 || fy < 0 || fy > 1) continue;
    if (inside(x0 + fx * (x1 - x0), y0 + fy * (y1 - y0))) m[r * cols + c] = 1;
  }
  // 保留最大 4 连通块，并填掉封闭空洞
  const lab = new Int32Array(cols * rows).fill(-1); const sizes = [];
  for (let s = 0; s < m.length; s++) {
    if (!m[s] || lab[s] >= 0) continue;
    const id = sizes.length; let n = 0; const st = [s]; lab[s] = id;
    while (st.length) { const p = st.pop(); n++; const c = p % cols, r = (p / cols) | 0; for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const cc = c + dc, rr = r + dr; if (cc < 0 || rr < 0 || cc >= cols || rr >= rows) continue; const q = rr * cols + cc; if (m[q] && lab[q] < 0) { lab[q] = id; st.push(q); } } }
    sizes.push(n);
  }
  if (!sizes.length) return null;
  const best = sizes.indexOf(Math.max(...sizes));
  for (let i = 0; i < m.length; i++) m[i] = lab[i] === best ? 1 : 0;
  const outside = new Uint8Array(cols * rows); const st = [];
  for (let c = 0; c < cols; c++) for (const r of [0, rows - 1]) { const p = r * cols + c; if (!m[p] && !outside[p]) { outside[p] = 1; st.push(p); } }
  for (let r = 0; r < rows; r++) for (const c of [0, cols - 1]) { const p = r * cols + c; if (!m[p] && !outside[p]) { outside[p] = 1; st.push(p); } }
  while (st.length) { const p = st.pop(); const c = p % cols, r = (p / cols) | 0; for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const cc = c + dc, rr = r + dr; if (cc < 0 || rr < 0 || cc >= cols || rr >= rows) continue; const q = rr * cols + cc; if (!m[q] && !outside[q]) { outside[q] = 1; st.push(q); } } }
  let area = 0;
  for (let i = 0; i < m.length; i++) { if (!outside[i]) m[i] = 1; area += m[i]; }
  return area >= cols * rows * 0.22 ? m : null;
}

function chooseColours(rng, pal, nColors) {
  const dark = pal.filter((c) => lum(c.rgb) < 70);
  const outline = rng.pick(dark.length ? dark : pal);
  const whites = pal.filter((c) => Math.min(...c.rgb) >= 232 && c !== outline);
  const chosen = [];
  const add = (c) => { if (c && c !== outline && !chosen.includes(c)) chosen.push(c); };
  // 近白组（H1/H2/H9/H12/H19 一类）
  if (rng.chance(0.65)) rng.shuffle(whites).slice(0, rng.int(1, Math.min(4, whites.length))).forEach(add);
  // 近色对：任选一色加入它最近的邻色
  const pairs = rng.int(1, 3);
  for (let i = 0; i < pairs && chosen.length < nColors - 1; i++) {
    const a = rng.pick(pal.filter((c) => c !== outline && !whites.includes(c)));
    add(a);
    const near = pal.filter((c) => c !== a && c !== outline && dist(c.rgb, a.rgb) > 4).sort((p, q) => dist(p.rgb, a.rgb) - dist(q.rgb, a.rgb)).slice(0, 3);
    if (near.length) add(rng.pick(near));
  }
  let guard = 0;
  while (chosen.length < nColors - 1 && guard++ < 500) add(rng.pick(pal));
  return { outline, body: chosen.slice(0, nColors - 1) };
}

function genDesign(rng, pal, styleIdx) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const { cols, rows } = genSize(rng, styleIdx);
    const mask = genMask(rng, cols, rows);
    if (!mask) continue;
    const nWant = Math.min(30, Math.max(6, rng.int(6, 12) + (rng.chance(0.4) ? rng.int(0, 18) : 0)));
    const { outline, body } = chooseColours(rng, pal, nWant);
    const cells = new Int16Array(cols * rows).fill(-1);
    const colours = [outline, ...body];
    const interior = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const p = r * cols + c; if (!mask[p]) continue;
      const edge = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dc, dr]) => { const cc = c + dc, rr = r + dr; return cc < 0 || rr < 0 || cc >= cols || rr >= rows || !mask[rr * cols + cc]; });
      if (edge) cells[p] = 0; else interior.push(p);
    }
    if (interior.length < body.length * 3) continue;
    // 加权 Voronoi 色块（小权重 → 高光/眼睛类小块）
    const seeds = rng.shuffle(interior).slice(0, body.length).map((p, i) => {
      const isWhite = Math.min(...body[i].rgb) >= 232;
      return { x: p % cols, y: (p / cols) | 0, w: isWhite ? rng.range(-0.02, 0.02) : rng.range(-0.01, 0.12), sx: rng.range(0.6, 1.6), sy: rng.range(0.6, 1.6), p, i };
    });
    const ph = rng.range(0, 6), amp = rng.range(0, 2.5);
    const scale = (cols * rows) / body.length;
    for (const p of interior) {
      const x = p % cols, y = (p / cols) | 0; let bi = 0, bd = Infinity;
      for (const s of seeds) {
        const dx = (x + amp * Math.sin(y * 0.35 + ph) - s.x) * s.sx, dy = (y + amp * Math.sin(x * 0.3 + ph * 1.7) - s.y) * s.sy;
        const d = dx * dx + dy * dy - s.w * scale;
        if (d < bd) { bd = d; bi = s.i; }
      }
      cells[p] = bi + 1;
    }
    for (const s of seeds) cells[s.p] = s.i + 1;
    // 图内少量空格
    const holes = rng.int(2, 6);
    for (let h = 0; h < holes; h++) { const p = rng.pick(interior); if (!seeds.some((s) => s.p === p)) cells[p] = -1; }
    // 去掉未使用的颜色并重映射
    const used = new Map(); const out = [];
    colours.forEach((c, i) => { if (cells.includes(i)) { used.set(i, out.length); out.push(c); } });
    for (let p = 0; p < cells.length; p++) if (cells[p] >= 0) cells[p] = used.get(cells[p]);
    if (out.length < 6) continue;
    return { cols, rows, cells: Array.from(cells), colours: out };
  }
  throw new Error("生成设计失败");
}

// ---------------------------------------------------------------- 版式参数
function genSpec(rng, styleIdx, design) {
  const { cols, rows, cells, colours } = design;
  const counts = new Array(colours.length).fill(0);
  for (const v of cells) if (v >= 0) counts[v]++;
  const total = counts.reduce((a, b) => a + b, 0);
  const style = STYLES[styleIdx];
  const zeroPad = (styleIdx === 3 || styleIdx === 4) ? rng.chance(0.5) : rng.chance(0.2);
  const label = (code) => (zeroPad ? code[0] + code.slice(1).padStart(2, "0") : code);
  let order = colours.map((_, i) => i);
  if (rng.chance(0.7)) order.sort((a, b) => counts[b] - counts[a]); else order.sort((a, b) => colours[a].code.localeCompare(colours[b].code, "en", { numeric: true }));
  const pitch = Math.max(9, Math.min(40, Math.floor(rng.range(1100, 2400) / cols)));
  const spec = {
    style: style.dir, styleIdx, cols, rows, cells, pitch, zeroPad,
    pal: colours.map((c, i) => ({ code: c.code, label: label(c.code), hex: c.hex, count: counts[i] })),
    order, total,
    margin: rng.int(12, 60),
    fontUi: rng.pick(style.fonts), fontCell: rng.pick(style.fonts),
    codesInCell: styleIdx !== 1,
    boldEvery: rng.pick([5, 10, 10]),
    boldW: rng.pick([2, 2, 3]),
    boldColor: rng.pick(["#2f5fd0", "#d33a3a", "#222222", "#5a6fd6", "#888888"]),
    thinColor: rng.pick(["#d8d8d8", "#c4c4c4", "#a8a8a8", "#8c8c8c", "#e6e6e6", "#b5bde0"]),
    thinW: pitch >= 22 && rng.chance(0.3) ? 2 : 1,
    bgMode: styleIdx === 3 ? "checker" : rng.pick(["white", "white", "light"]),
    legendCols: rng.int(2, 7), legScale: rng.range(0.8, 1.25),
    rulers: styleIdx === 3 ? 1 : styleIdx === 4 ? 1 : (rng.chance(0.3) ? 1 : 0),
    rulers2: styleIdx === 3 ? rng.chance(0.5) : rng.chance(0.2),
    rulerColor: rng.pick(["#4a63d8", "#e8ebf8", "#c9d1f5"]),
    header: styleIdx === 3 ? `尺寸:${cols}x${rows} · ${colours.length} 色 · ${total} 颗` : null,
    title: styleIdx === 4 ? "材料清单统计" : null,
    sub: styleIdx === 4 ? `总计: ${total} 颗 | 规格: ${cols}×${rows}` : null,
    wm: styleIdx === 4 ? { text: rng.pick(["小红书@拼豆梦想家 免费分享", "@拼豆小屋 仅供参考", "小红书 5361336915"]), alpha: rng.range(0.16, 0.3), color: rng.pick(["#3a6fe0", "#d04a8a", "#2fa89a"]), ang: rng.range(-0.6, -0.25) } : null
  };
  if (styleIdx === 1) spec.legendCols = rng.int(3, 8);
  if (styleIdx === 3 || styleIdx === 4) spec.legendCols = rng.pick([3, 4, 4, 5]);
  spec.statedTotal = (styleIdx === 3 || styleIdx === 4) ? total : null;
  return spec;
}

// ---------------------------------------------------------------- 浏览器端渲染（canvas）
const PAGE_JS = String.raw`
window.R = function (spec) {
  const S = spec, P = S.pitch, cols = S.cols, rows = S.rows;
  const cv = document.createElement('canvas'); const g = cv.getContext('2d');
  const measure = (font, t) => { g.font = font; return g.measureText(t).width; };
  const rul = S.rulers ? Math.max(14, Math.round(P * 0.9)) : 0;
  const rul2 = S.rulers && S.rulers2 ? rul : 0;
  const M = S.margin;
  const gridW = cols * P, gridH = rows * P;
  const fsL = Math.max(15, Math.min(32, Math.round(P * 0.8 * S.legScale)));
  const legFont = (b) => (b ? 'bold ' : '') + fsL + 'px "' + S.fontUi + '"';
  const sidx = S.styleIdx;
  const order = S.order;
  // 图例条目
  const ents = order.map(i => {
    const e = S.pal[i]; let w, h, parts;
    if (sidx === 0) { const t = e.label + ' ' + e.count; w = fsL * 1.6 + measure(legFont(false), t); h = fsL * 1.5; parts = { t }; }
    else if (sidx === 1) { const cw = measure(legFont(true), e.label) + fsL * 1.2; const t = 'x' + e.count; w = cw + 8 + measure(legFont(false), t); h = fsL * 1.7; parts = { cw, t }; }
    else if (sidx === 2) { const cw = Math.max(measure(legFont(true), e.label), measure(legFont(false), String(e.count))) + fsL * 1.2; w = cw; h = fsL * 2.9; parts = { cw }; }
    else if (sidx === 3) { const t = e.label + ' (' + e.count + ')'; w = measure(legFont(true), t) + fsL * 1.6; h = fsL * 1.9; parts = { t }; }
    else { const t = e.label + ': ' + e.count; w = fsL * 1.7 + measure(legFont(false), t); h = fsL * 1.5; parts = { t }; }
    return { e, w, h, parts };
  });
  const gapX = Math.round(fsL * 0.9), gapY = Math.round(fsL * 0.6);
  const entW = Math.max(...ents.map(x => x.w)) + gapX, entH = Math.max(...ents.map(x => x.h)) + gapY;
  const availW = Math.max(gridW + rul + rul2, 640);
  const nCol = Math.max(1, Math.min(S.legendCols, Math.floor(availW / entW), ents.length));
  const legRows = Math.ceil(ents.length / nCol);
  const legH = legRows * entH + 10;
  const hdrH = S.header ? Math.round(fsL * 3.4) : 0;
  const titleH = S.title ? Math.round(fsL * 3.6) : 0;
  const bodyW = Math.max(gridW + rul + rul2, nCol * entW);
  const W = Math.round(bodyW + 2 * M);
  const gx0 = Math.round(M + (bodyW - (gridW + rul + rul2)) / 2 + rul); // 网格左上角
  const gy0 = M + hdrH + rul;
  const legTop = gy0 + gridH + rul2 + Math.round(fsL * 0.8);
  const sidxE = sidx === 4;
  const H = Math.round(legTop + titleH + legH + M);
  cv.width = W; cv.height = H;
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H);
  g.textBaseline = 'middle'; g.textAlign = 'center';
  // 头部
  if (S.header) {
    g.fillStyle = '#1b1b1b'; g.textAlign = 'left'; g.font = 'bold ' + Math.round(fsL * 1.15) + 'px "' + S.fontUi + '"';
    g.fillText(S.header, M, M + hdrH * 0.4); g.textAlign = 'center';
  }
  // 标尺
  const rulerFont = Math.max(7, Math.min(Math.round(rul * 0.55), Math.round(P * 0.55)));
  const drawRuler = () => {
    if (!rul) return;
    const dark = S.rulerColor === '#4a63d8';
    g.font = 'bold ' + rulerFont + 'px "Arial"';
    const edges = [['t', gy0 - rul], ['l', gx0 - rul]]; if (rul2) { edges.push(['b', gy0 + gridH]); edges.push(['r', gx0 + gridW]); }
    for (const [k, off] of edges) {
      const n = (k === 't' || k === 'b') ? cols : rows;
      for (let i = 0; i < n; i++) {
        const x = (k === 't' || k === 'b') ? gx0 + i * P : off, y = (k === 't' || k === 'b') ? off : gy0 + i * P;
        g.fillStyle = S.rulerColor; g.fillRect(x, y, (k === 't' || k === 'b') ? P : rul, (k === 't' || k === 'b') ? rul : P);
        g.strokeStyle = dark ? '#ffffff' : '#9aa5d8'; g.lineWidth = 1; g.strokeRect(x + 0.5, y + 0.5, ((k === 't' || k === 'b') ? P : rul) - 1, ((k === 't' || k === 'b') ? rul : P) - 1);
        g.fillStyle = dark ? '#ffffff' : '#1e2a6b';
        g.fillText(String(i + 1), x + ((k === 't' || k === 'b') ? P : rul) / 2, y + ((k === 't' || k === 'b') ? rul : P) / 2 + 0.5);
      }
    }
  };
  drawRuler();
  // 背景格
  const bgCol = S.bgMode === 'light' ? '#f6f6f4' : '#ffffff';
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const v = S.cells[r * cols + c]; const x = gx0 + c * P, y = gy0 + r * P;
    if (v < 0) {
      if (S.bgMode === 'checker') {
        const h = P / 2;
        g.fillStyle = '#ffffff'; g.fillRect(x, y, P, P); g.fillStyle = '#ececec';
        g.fillRect(x, y, h, h); g.fillRect(x + h, y + h, h, h);
      } else { g.fillStyle = bgCol; g.fillRect(x, y, P, P); }
    } else { g.fillStyle = S.pal[v].hex; g.fillRect(x, y, P, P); }
  }
  // 细线
  g.strokeStyle = S.thinColor; g.lineWidth = S.thinW;
  g.beginPath();
  for (let c = 0; c <= cols; c++) { g.moveTo(gx0 + c * P + 0.5, gy0); g.lineTo(gx0 + c * P + 0.5, gy0 + gridH); }
  for (let r = 0; r <= rows; r++) { g.moveTo(gx0, gy0 + r * P + 0.5); g.lineTo(gx0 + gridW, gy0 + r * P + 0.5); }
  g.stroke();
  // 粗线
  g.strokeStyle = S.boldColor; g.lineWidth = S.boldW; g.beginPath();
  for (let c = 0; c <= cols; c += S.boldEvery) { g.moveTo(gx0 + c * P + 0.5, gy0); g.lineTo(gx0 + c * P + 0.5, gy0 + gridH); }
  for (let r = 0; r <= rows; r += S.boldEvery) { g.moveTo(gx0, gy0 + r * P + 0.5); g.lineTo(gx0 + gridW, gy0 + r * P + 0.5); }
  g.stroke();
  g.strokeStyle = S.boldColor; g.strokeRect(gx0 + 0.5, gy0 + 0.5, gridW, gridH);
  // 格内色号
  const drawn = {}; const lumOf = (hex) => { const n = parseInt(hex.slice(1), 16); return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255); };
  let cfs = 0;
  if (S.codesInCell) {
    cfs = P * 0.5; const widest = S.pal.reduce((a, e) => (e.label.length > a.length ? e.label : a), 'H00');
    while (cfs > 5 && measure('bold ' + cfs + 'px "' + S.fontCell + '"', widest + '') > P * 0.9) cfs -= 0.5;
    g.font = 'bold ' + cfs + 'px "' + S.fontCell + '"';
  }
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const v = S.cells[r * cols + c]; if (v < 0) continue;
    const e = S.pal[v]; drawn[e.code] = (drawn[e.code] || 0) + 1;
    if (S.codesInCell) { g.fillStyle = lumOf(e.hex) > 140 ? '#111111' : '#ffffff'; g.fillText(e.label, gx0 + c * P + P / 2, gy0 + r * P + P / 2 + 0.5); }
  }
  // 水印
  if (S.wm) {
    g.save(); g.beginPath(); g.rect(gx0, gy0, gridW, gridH); g.clip();
    g.globalAlpha = S.wm.alpha; g.fillStyle = S.wm.color; g.textAlign = 'center';
    const wf = Math.max(18, Math.round(Math.min(gridW, gridH) / 14)); g.font = 'bold ' + wf + 'px "Microsoft YaHei"';
    const tw = g.measureText(S.wm.text).width; const stepX = tw * 1.5, stepY = wf * 7;
    g.translate(gx0 + gridW / 2, gy0 + gridH / 2); g.rotate(S.wm.ang);
    const span = Math.hypot(gridW, gridH);
    for (let yy = -span / 2; yy < span / 2; yy += stepY) for (let xx = -span / 2; xx < span / 2; xx += stepX) g.fillText(S.wm.text, xx + ((Math.round(yy / stepY) & 1) ? stepX / 2 : 0), yy);
    g.restore(); g.globalAlpha = 1;
  }
  // 标题行（E）
  let ly = legTop;
  g.textAlign = 'left';
  if (S.title) {
    g.fillStyle = '#111'; g.font = 'bold ' + Math.round(fsL * 1.3) + 'px "' + S.fontUi + '"'; g.fillText(S.title, M, ly + fsL * 0.8);
    g.fillStyle = '#555'; g.font = Math.round(fsL * 1.05) + 'px "' + S.fontUi + '"'; g.fillText(S.sub, M, ly + fsL * 2.4);
    ly += titleH;
  }
  // 图例
  const lx0 = Math.round(M + (bodyW - nCol * entW) / 2);
  ents.forEach((it, k) => {
    const col = k % nCol, row = (k / nCol) | 0; const x = lx0 + col * entW, y = ly + row * entH + it.h / 2; const e = it.e;
    const fg = lumOf(e.hex) > 140 ? '#111111' : '#ffffff';
    g.textAlign = 'left';
    if (sidx === 0 || sidx === 4) {
      const sq = fsL * 1.05; g.fillStyle = e.hex; g.fillRect(x, y - sq / 2, sq, sq); g.strokeStyle = '#888'; g.lineWidth = 1; g.strokeRect(x + 0.5, y - sq / 2 + 0.5, sq, sq);
      g.fillStyle = '#111'; g.font = legFont(false); g.fillText(it.parts.t, x + sq + fsL * 0.5, y);
    } else if (sidx === 1) {
      const rr = (fsL * 1.5); g.fillStyle = e.hex; g.fillRect(x, y - rr / 2, it.parts.cw, rr); g.strokeStyle = '#999'; g.strokeRect(x + 0.5, y - rr / 2 + 0.5, it.parts.cw, rr);
      g.fillStyle = fg; g.font = legFont(true); g.textAlign = 'center'; g.fillText(e.label, x + it.parts.cw / 2, y + 1);
      g.textAlign = 'left'; g.fillStyle = '#222'; g.font = legFont(false); g.fillText(it.parts.t, x + it.parts.cw + 8, y);
    } else if (sidx === 2) {
      const hh = fsL * 2.6; g.fillStyle = e.hex; g.fillRect(x, y - hh / 2, it.parts.cw, hh); g.strokeStyle = '#aaa'; g.strokeRect(x + 0.5, y - hh / 2 + 0.5, it.parts.cw, hh);
      g.fillStyle = fg; g.textAlign = 'center'; g.font = legFont(true); g.fillText(e.label, x + it.parts.cw / 2, y - fsL * 0.55);
      g.font = legFont(false); g.fillText(String(e.count), x + it.parts.cw / 2, y + fsL * 0.65);
    } else if (sidx === 3) {
      const hh = fsL * 1.7; g.fillStyle = e.hex; g.beginPath(); g.roundRect(x, y - hh / 2, it.w - gapX * 0.0, hh, 6); g.fill();
      g.fillStyle = fg; g.textAlign = 'center'; g.font = legFont(true); g.fillText(it.parts.t, x + it.w / 2, y + 1);
    }
  });
  return { url: cv.toDataURL('image/png'), drawn, w: W, h: H };
};
`;

// ---------------------------------------------------------------- CDP / Edge
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function freePort() { return new Promise((res, rej) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); s.on("error", rej); }); }
async function startBrowser() {
  let port = await freePort(); if (port === 9347) port = await freePort();
  const profile = join(tmpdir(), `ph-SY-edge-${process.pid}`);
  rmSync(profile, { recursive: true, force: true });
  const proc = spawn(BROWSER, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
  let wsUrl = null;
  for (let i = 0; i < 80 && !wsUrl; i++) {
    try { const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); wsUrl = list.find((t) => t.type === "page")?.webSocketDebuggerUrl ?? null; } catch { /* 启动中 */ }
    if (!wsUrl) await sleep(250);
  }
  if (!wsUrl) { proc.kill(); throw new Error("Edge CDP 不可达"); }
  const ws = new WebSocket(wsUrl); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0; const pending = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } };
  const send = (method, params = {}, ms = 120000) => new Promise((res, rej) => {
    const id = ++seq; const t = setTimeout(() => { pending.delete(id); rej(new Error(`CDP timeout ${method}`)); }, ms);
    pending.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => { const r = await send("Runtime.evaluate", { expression, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value; };
  const close = async () => { try { await send("Browser.close", {}, 5000); } catch { /* ignore */ } try { ws.close(); } catch { /* ignore */ } await sleep(500); try { proc.kill(); } catch { /* ignore */ } await sleep(500); rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); };
  return { evaluate, close };
}

// ---------------------------------------------------------------- PNG 解码 / 缩小 / JPEG
function decodePng(buf) {
  let p = 8, w = 0, h = 0, ct = 0; const idat = [];
  while (p < buf.length) { const len = buf.readUInt32BE(p), type = buf.toString("latin1", p + 4, p + 8); const d = buf.subarray(p + 8, p + 8 + len); if (type === "IHDR") { w = d.readUInt32BE(0); h = d.readUInt32BE(4); if (d[8] !== 8 || d[12] !== 0) throw new Error("PNG: 需 8bit 非隔行"); ct = d[9]; } else if (type === "IDAT") idat.push(d); p += 12 + len; }
  const bpp = ct === 6 ? 4 : ct === 2 ? 3 : 0; if (!bpp) throw new Error("PNG 颜色类型 " + ct);
  const raw = inflateSync(Buffer.concat(idat)); const stride = w * bpp; const out = Buffer.alloc(w * h * 4, 255); let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]; const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0; let v = line[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      line[i] = v & 255;
    }
    for (let x = 0; x < w; x++) { const o = (y * w + x) * 4; out[o] = line[x * bpp]; out[o + 1] = line[x * bpp + 1]; out[o + 2] = line[x * bpp + 2]; if (bpp === 4) out[o + 3] = line[x * bpp + 3]; }
    prev = line;
  }
  return { width: w, height: h, data: out };
}
/** 按面积平均缩小（可分离箱式滤波）。 */
function resizeArea(img, nw, nh) {
  const { width: w, height: h, data } = img;
  const axis = (n, m) => { const k = n / m; return Array.from({ length: m }, (_, i) => { const a = i * k, b = (i + 1) * k; const lo = Math.floor(a), hi = Math.min(n - 1, Math.ceil(b) - 1); const ws = []; for (let j = lo; j <= hi; j++) ws.push(Math.min(b, j + 1) - Math.max(a, j)); return { lo, ws, sum: ws.reduce((x, y) => x + y, 0) }; }); };
  const xs = axis(w, nw), ys = axis(h, nh);
  const tmp = new Float32Array(h * nw * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < nw; x++) { const { lo, ws, sum } = xs[x]; let r = 0, g = 0, b = 0; for (let j = 0; j < ws.length; j++) { const o = (y * w + lo + j) * 4; r += data[o] * ws[j]; g += data[o + 1] * ws[j]; b += data[o + 2] * ws[j]; } const t = (y * nw + x) * 3; tmp[t] = r / sum; tmp[t + 1] = g / sum; tmp[t + 2] = b / sum; }
  const out = Buffer.alloc(nw * nh * 4, 255);
  for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) { const { lo, ws, sum } = ys[y]; let r = 0, g = 0, b = 0; for (let j = 0; j < ws.length; j++) { const t = ((lo + j) * nw + x) * 3; r += tmp[t] * ws[j]; g += tmp[t + 1] * ws[j]; b += tmp[t + 2] * ws[j]; } const o = (y * nw + x) * 4; out[o] = Math.round(r / sum); out[o + 1] = Math.round(g / sum); out[o + 2] = Math.round(b / sum); }
  return { width: nw, height: nh, data: out };
}

// ---------------------------------------------------------------- 主流程
const pal = loadPalette();
console.log(`色卡 ${pal.length} 色；输出 ${OUT}；n=${N} seed=${SEED}`);
mkdirSync(OUT, { recursive: true });
const browser = await startBrowser();
const truth = { version: 1, source: `synth-charts.mjs seed=${SEED} n=${N} (generated, not real charts)`, charts: [] };
try {
  await browser.evaluate(PAGE_JS);
  for (let i = 0; i < N; i++) {
    const styleIdx = i % STYLES.length;
    const rng = mkRng(SEED, i);
    const design = genDesign(rng, pal, styleIdx);
    const spec = genSpec(rng, styleIdx, design);
    const res = await browser.evaluate(`R(${JSON.stringify(spec)})`);
    // 校验：渲染出的格数 = truth 计数
    const legend = {};
    spec.pal.forEach((e) => { legend[e.code] = e.count; });
    for (const [code, n] of Object.entries(legend)) if ((res.drawn[code] ?? 0) !== n) throw new Error(`设计 ${i} 色 ${code}: 渲染 ${res.drawn[code]} ≠ 真值 ${n}`);
    const id = `s${SEED}_${String(i).padStart(3, "0")}`;
    const dir = join(OUT, spec.style); mkdirSync(dir, { recursive: true });
    const png = Buffer.from(res.url.slice(res.url.indexOf(",") + 1), "base64");
    let decoded = null;
    for (const v of VARIANTS) {
      const file = `${id}_${v.name}.${v.ext}`;
      let note = "";
      if (v.name === "orig") writeFileSync(join(dir, file), png);
      else {
        decoded ??= decodePng(png);
        const longE = Math.max(decoded.width, decoded.height);
        const target = v.scale ? Math.round(longE * v.scale) : Math.min(v.long, longE);
        const k = target / longE;
        const img = k < 1 ? resizeArea(decoded, Math.max(8, Math.round(decoded.width * k)), Math.max(8, Math.round(decoded.height * k))) : decoded;
        writeFileSync(join(dir, file), jpeg.encode({ width: img.width, height: img.height, data: img.data }, v.q).data);
        note = ` ${img.width}x${img.height}`;
      }
      truth.charts.push({
        file: `${spec.style}/${file}`, isChart: true, style: STYLES[styleIdx].desc, variant: v.name,
        cols: spec.cols, rows: spec.rows, statedTotal: spec.statedTotal, statedColors: spec.statedTotal != null ? spec.pal.length : null,
        legend, legendSum: spec.total, codeFormat: spec.zeroPad ? "zero-padded" : "plain", emptyCells: spec.bgMode === "checker" ? "checkerboard" : "white",
        codesInCells: spec.codesInCell, confidence: "high", notes: `synthetic ${id}: pitch ${spec.pitch}px, ${spec.pal.length} colours, font ${spec.fontCell}${note}`
      });
    }
    console.log(`  ${spec.style}/${id}  ${spec.cols}x${spec.rows}  ${spec.pal.length} 色  ${spec.total} 颗  ${res.w}x${res.h}`);
  }
  writeFileSync(join(OUT, "truth.json"), JSON.stringify(truth, null, 1));
  console.log(`完成：${truth.charts.length} 张图，truth → ${join(OUT, "truth.json")}`);
} finally { await browser.close(); }
