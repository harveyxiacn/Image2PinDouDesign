// 网格尺寸存疑时提示用户确认（纯函数，只读 AnalyzeResult 已有字段）。
import type { AnalyzeResult } from "./types";

export type Size = { cols: number; rows: number };
export type SizeCheck = { reason: string; detected: Size | null; suggested?: Size };

const TOTAL_TOLERANCE = 0.01;

function beadTotal(counts: Record<string, number>): number {
  let sum = 0;
  for (const v of Object.values(counts)) sum += v > 0 ? v : 0;
  return sum;
}

/**
 * 需要请用户确认尺寸时返回提示，否则 null。
 * - 抬头标注的列 / 行数与检测到的网格不同：建议按标注重新识别；
 * - 没找到网格，但抬头给出了尺寸：建议按标注重新识别；
 * - 数量来自网格（没有被图例覆盖），而标注的总数与豆子数相差超过 1%：提示核对，不给建议；
 * - 图片很模糊（very-low）：低清图上自动尺寸最容易错，提示核对，不给建议。
 */
export function checkSize(result: AnalyzeResult): SizeCheck | null {
  const h = result.header;
  const g = result.grid?.grid ?? null;
  const detected = g && g.cols > 0 && g.rows > 0 ? { cols: g.cols, rows: g.rows } : null;
  const hc = h?.cols && h.cols > 0 ? h.cols : null;
  const hr = h?.rows && h.rows > 0 ? h.rows : null;
  const stated = hc && hr ? { cols: hc, rows: hr } : null;

  if (!detected) {
    if (stated) return { reason: `没有找到网格，图上标注 ${stated.cols}×${stated.rows}`, detected: null, suggested: stated };
    return null;
  }
  const label = `${detected.cols}×${detected.rows}`;
  if (stated && (stated.cols !== detected.cols || stated.rows !== detected.rows)) {
    return { reason: `识别为 ${label}，图上标注 ${stated.cols}×${stated.rows}`, detected, suggested: stated };
  }
  if ((hc && hc !== detected.cols) || (hr && hr !== detected.rows)) {
    const part = hc && hc !== detected.cols ? `列数标注 ${hc}` : `行数标注 ${hr}`;
    return { reason: `识别为 ${label}，图上${part}`, detected };
  }
  const total = result.legend?.statedTotal ?? h?.total ?? null;
  if (total && total > 0 && result.method === "grid") {
    const beads = beadTotal(result.counts);
    if (Math.abs(beads - total) / total > TOTAL_TOLERANCE) {
      return { reason: `识别为 ${label}，数出 ${beads} 颗，图上标注共 ${total} 颗`, detected };
    }
  }
  // 图片很糊（高清化评估为 very-low）：细格线基本看不清，自动尺寸常差一两行 / 列，提示核对
  if (result.enhance?.level === "very-low") {
    return { reason: `图片很模糊，识别为 ${label}，可能差一两行或列`, detected };
  }
  return null;
}
