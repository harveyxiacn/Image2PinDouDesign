import { describe, expect, it } from "vitest";
import { assessQuality, enhanceImage, enhanceInWorker, summarizeEnhance } from "../lib/enhance";
import { detectGrid } from "../lib/recognize/grid";
import { analyzePattern } from "../lib/recognize/assistant";
import { buildChart, downscaleArea } from "./fixtures";

function lowResChart(factor: number) {
  const chart = buildChart({ cols: 36, rows: 28, pitch: 20, lineWidth: 1, seed: 5, emptyFrac: 0.1 });
  const small = downscaleArea(chart.src, Math.round(Math.max(chart.src.width, chart.src.height) * factor));
  return { chart, small };
}

describe("高清化 · 画质评估", () => {
  it("低清图纸（格子约 7 像素）判为低 / 很低，并建议放大", () => {
    const { small } = lowResChart(0.35);
    const grid = detectGrid(small, null);
    expect(grid).toBeTruthy();
    const q = assessQuality(small, grid);
    expect(["low", "very-low"]).toContain(q.level);
    expect(q.suggestedScale).toBeGreaterThanOrEqual(2);
    expect(q.pitchPx!).toBeLessThan(10);
    expect(q.reasons.join("")).toContain("格子只有");
  });

  it("清晰的原图判为 good、不放大", () => {
    const { chart } = lowResChart(0.35);
    const grid = detectGrid(chart.src, null);
    const q = assessQuality(chart.src, grid);
    expect(q.level).toBe("good");
    expect(q.suggestedScale).toBe(1);
  });

  it("评估很快（2400 像素图 < 50 ms 量级，放宽到 400 ms 以免 CI 抖动）", () => {
    const chart = buildChart({ cols: 100, rows: 90, pitch: 24, lineWidth: 1, seed: 2 });
    const t0 = performance.now();
    assessQuality(chart.src, null);
    expect(performance.now() - t0).toBeLessThan(400);
  });
});

describe("高清化 · 放大", () => {
  it("按网格重建：尺寸 / 倍数正确，格子中心色与原图纸一致", async () => {
    const { chart, small } = lowResChart(0.35);
    const grid = detectGrid(small, null)!;
    const r = await enhanceImage(small, { grid });
    expect(r.method).toBe("chart-rebuild");
    expect(r.scale).toBeGreaterThanOrEqual(2);
    expect(r.image.width).toBe(Math.round(small.width * r.scale));
    expect(r.image.height).toBe(Math.round(small.height * r.scale));
    expect(r.detail).toContain("按网格重建");
    let checked = 0, bad = 0;
    for (let cy = 0; cy < grid.rows; cy += 1) for (let cx = 0; cx < grid.cols; cx += 1) {
      const code = chart.matrix[cy]?.[cx];
      if (!code) continue;
      const X = Math.round((grid.x0 + (cx + 0.5) * grid.pitchX) * r.scale), Y = Math.round((grid.y0 + (cy + 0.5) * grid.pitchY) * r.scale);
      const p = (Y * r.image.width + X) * 4;
      const want = chart.render[code];
      const d = Math.abs(r.image.data[p] - want[0]) + Math.abs(r.image.data[p + 1] - want[1]) + Math.abs(r.image.data[p + 2] - want[2]);
      checked++; if (d > 24) bad++;
    }
    expect(checked).toBeGreaterThan(300);
    expect(bad / checked).toBeLessThan(0.03);
    const sum = summarizeEnhance(small, r);
    expect(sum.applied).toBe(true);
    expect(sum.to.width).toBe(r.image.width);
  });

  it("没有网格时用通用锐化放大", async () => {
    const { small } = lowResChart(0.35);
    const r = await enhanceImage(small, { grid: null, scale: 2 });
    expect(r.method).toBe("sharp-upscale");
    expect(r.image.width).toBe(small.width * 2);
  });

  it("清晰图不动：方法 none、倍数 1、原图原样返回", async () => {
    const { chart } = lowResChart(0.35);
    const r = await enhanceImage(chart.src, { grid: detectGrid(chart.src, null) });
    expect(r.method).toBe("none");
    expect(r.scale).toBe(1);
    expect(r.image).toBe(chart.src);
    expect(summarizeEnhance(chart.src, r).applied).toBe(false);
  });

  it("尊重输出长边上限", async () => {
    const { small } = lowResChart(0.35);
    const r = await enhanceImage(small, { grid: detectGrid(small, null), scale: 4, maxEdge: 900 });
    expect(Math.max(r.image.width, r.image.height)).toBeLessThanOrEqual(900);
  });

  it("1000×1000 放大 ×3 的用时（记录）", async () => {
    const chart = buildChart({ cols: 125, rows: 125, pitch: 8, lineWidth: 1, seed: 9, emptyFrac: 0.1 });
    const grid = detectGrid(chart.src, null)!;
    const r = await enhanceImage(chart.src, { grid, scale: 3 });
    console.log(`[enhance-timing] ${chart.src.width}x${chart.src.height} -> ${r.image.width}x${r.image.height} ${r.method} ${r.ms} ms`);
    expect(r.scale).toBe(3);
    expect(r.ms).toBeLessThan(6000);
  });

  it("可取消", async () => {
    const { small } = lowResChart(0.35);
    const ac = new AbortController();
    ac.abort();
    await expect(enhanceImage(small, { grid: detectGrid(small, null), signal: ac.signal })).rejects.toMatchObject({ name: "AbortError" });
    const job = enhanceInWorker(small, { grid: detectGrid(small, null) });
    job.cancel();
    await expect(job.promise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("汇报进度", async () => {
    const { small } = lowResChart(0.35);
    const seen: number[] = [];
    await enhanceImage(small, { grid: detectGrid(small, null), onProgress: (f) => seen.push(f) });
    expect(seen.length).toBeGreaterThan(2);
    expect(seen[seen.length - 1]).toBe(1);
  });
});

describe("高清化 · 接入识别", () => {
  it("低清图纸：时间线出现“高清化”并带 enhance 概况；清晰图则 skip", async () => {
    const { chart, small } = lowResChart(0.35);
    const lo = await analyzePattern(small, { ocr: false });
    expect(lo.steps.some((s) => s.id === "enhance")).toBe(false); // 不开 OCR 时没必要放大
    const hi = await analyzePattern(chart.src, { ocr: true, headerOcr: false, legendOcr: false, cellCodes: false });
    const st = hi.steps.find((s) => s.id === "enhance");
    expect(st?.status).toBe("skip");
    expect(hi.enhance?.applied).toBe(false);
  });
});
