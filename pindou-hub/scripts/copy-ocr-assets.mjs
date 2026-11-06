// 把 tesseract.js 的 worker / WASM 内核 / 英文识别模型复制到 web/public/ocr，
// 让图例识别完全离线运行（默认 tesseract.js 会去 CDN 下载这些文件）。
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nm = path.join(root, "node_modules");
const out = path.join(root, "web", "public", "ocr");
mkdirSync(out, { recursive: true });

function copy(from, name = path.basename(from)) {
  if (!existsSync(from)) { console.warn(`[ocr-assets] 缺少 ${from}`); return false; }
  copyFileSync(from, path.join(out, name));
  return true;
}

copy(path.join(nm, "tesseract.js", "dist", "worker.min.js"));
const core = path.join(nm, "tesseract.js-core");
if (existsSync(core)) {
  for (const file of readdirSync(core)) {
    if (/^tesseract-core.*-lstm\.(wasm\.js|wasm)$/.test(file)) copy(path.join(core, file));
  }
}
// @tesseract.js-data/eng 自带多种精度的模型，优先用速度和精度折中的 4.0.0_best_int。
const dataRoot = path.join(nm, "@tesseract.js-data", "eng");
const candidates = ["4.0.0_best_int", "4.0.0", "4.0.0_fast"].map((d) => path.join(dataRoot, d, "eng.traineddata.gz"));
const found = candidates.find((file) => existsSync(file));
if (found) copy(found, "eng.traineddata.gz");
else console.warn("[ocr-assets] 没找到 eng.traineddata.gz，图例 OCR 将不可用");

// 中文图例（chi_sim）。best_int 约 1.7 MB，精度够读“色号 + 数量”这种短文本。
const chiRoot = path.join(nm, "@tesseract.js-data", "chi_sim");
const chiCandidates = ["4.0.0_best_int", "4.0.0", "4.0.0_fast"].map((d) => path.join(chiRoot, d, "chi_sim.traineddata.gz"));
const chiFound = chiCandidates.find((file) => existsSync(file));
if (chiFound) copy(chiFound, "chi_sim.traineddata.gz");
else console.warn("[ocr-assets] 没找到 chi_sim.traineddata.gz，中文图例只能按网格识别");
console.log(`[ocr-assets] -> ${path.relative(root, out)}`);
