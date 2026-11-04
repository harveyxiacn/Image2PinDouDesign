// 第三方真实图纸（用户自己的 JPEG，不进仓库）：文件夹或 truth 不在时整组跳过。
// 这里不启动 OCR（node 下 tesseract 的 wasm 偶尔会让进程崩溃），只测网格 / 标尺 / 非图纸判断；
// 只断言“确定能对”的项目：是否图纸判断、有把握的尺寸；完整指标由 scripts/eval-recognition.mjs 评测。
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyzePattern } from "../lib/recognize/assistant";

const DIR = fileURLToPath(new URL("../../../拼豆图/", import.meta.url));
const TRUTH = fileURLToPath(new URL("./chart-truth.json", import.meta.url));
const READY = existsSync(DIR) && existsSync(TRUTH);

type Truth = { file: string; isChart: boolean; cols: number | null; rows: number | null };
const truth: Truth[] = READY ? JSON.parse(readFileSync(TRUTH, "utf8")).charts : [];
// 不含：蟹老板（尺寸靠抬头 OCR，本测试不开 OCR）、全力以赴（海报，truth 的 34×30 疑似只是标尺上的标注）、力天使（truth 行数 59，图上标尺读到 60）
const SIZE_OK = [
  "数码暴龙/丧失暴龙兽2.jpg", "数码暴龙/丧尸暴龙兽.jpg", "数码暴龙/亚古兽.jpg", "数码暴龙/战斗暴龙兽.jpg", "数码暴龙/暴龙兽.jpg", "数码暴龙/机械暴龙兽.jpg", "数码暴龙/黑球兽滚球兽.jpg",
  "比奇堡居民/7a790f9dddebd2ec1aaf41a100e835cf.jpg", "比奇堡居民/吃手指.jpg", "比奇堡居民/比耶.jpg", "比奇堡居民/酷酷鱼01.jpg", "比奇堡居民/酷酷鱼02.jpg", "比奇堡居民/酷酷鱼03.jpg",
  "游戏王/暗游戏.jpg", "游戏王/海马濑人.jpg", "高达/00R.jpg", "高达/主天使.jpg", "高达/德天使.jpg", "高达/自由.jpg"
];

function load(rel: string) {
  const jpeg = createRequire(import.meta.url)("jpeg-js");
  const j = jpeg.decode(readFileSync(DIR + rel), { useTArray: true, formatAsRGBA: true });
  return { width: j.width as number, height: j.height as number, data: new Uint8ClampedArray(j.data.buffer, j.data.byteOffset, j.data.length) };
}

describe.skipIf(!READY)("真实第三方图纸", () => {
  it.each(truth.filter((t) => !t.isChart).map((t) => t.file))("不是图纸：%s", async (file) => {
    if (!existsSync(DIR + file)) return;
    const res = await analyzePattern(load(file), { ocr: false });
    expect(res.isChart).toBe(false);
    expect(res.method).toBe("none");
    expect(res.notChartReason).toBeTruthy();
  }, 120000);

  it.each(SIZE_OK)("图纸尺寸与 truth 一致：%s", async (file) => {
    const t = truth.find((x) => x.file === file);
    if (!t || !existsSync(DIR + file)) return;
    const res = await analyzePattern(load(file), { ocr: false });
    expect(res.isChart).toBe(true);
    expect(res.grid?.grid.cols).toBe(t.cols);
    expect(res.grid?.grid.rows).toBe(t.rows);
  }, 120000);
});
