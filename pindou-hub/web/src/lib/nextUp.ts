// 下一张拼什么：在“计划拼”（其次“收藏”）的图纸里，按库存多的颜色推荐。纯计算，不碰存储、不依赖 React。
// 口径：库存多 = 库存 − 制作中图纸已占用 − 该色最低库存，不足 0 按 0；用量一律含份数与损耗（与洞察 / 采购同口径）。
import type { Counts, Pattern, SharedPrefs } from "./model";
import { totalOf } from "./model";
import { compareCodes, demandByCode, withLoss } from "./inventory";

/** 一句话说明排序规则，面板直接显示。 */
export const NEXT_UP_RULE = "先看现在能不能直接拼（缺豆少的在前），再看用了多少库存多的颜色，最后看拼完会让几个颜色偏少。";

export type NextUpGroup = "planned" | "idea";
export type SurplusUse = { code: string; beads: number };
export type ShortColor = { code: string; need: number; have: number; gap: number };
export type LowAfter = { code: string; after: number; floor: number };

export type NextUpRow = {
  id: string;
  name: string;
  copies: number;
  group: NextUpGroup;
  /** 含份数、含损耗的总颗数 */
  needed: number;
  /** 每个色号含份数、含损耗的用量 */
  needs: Counts;
  canMake: boolean;
  shortBeads: number;
  shortColors: ShortColor[];
  /** 用到库存多的颜色的颗数 / 占总颗数（0–1） */
  surplusBeads: number;
  surplusShare: number;
  /** 用得最多的前 3 个库存多的颜色 */
  surplusTop: SurplusUse[];
  /** 拼完后会低于最低库存的色号（不含已经缺的） */
  pushLow: LowAfter[];
  score: number;
  /** 组内名次，从 1 开始 */
  rank: number;
  why: string;
};

export type NextUpResult = {
  rows: NextUpRow[];
  /** 可用库存 = 库存 − 制作中占用（负数按 0） */
  available: Counts;
  /** 每个色号的“库存多”颗数（只列大于 0 的） */
  surplus: Counts;
};

const floorOf = (prefs: Pick<SharedPrefs, "minStock" | "lowStock">, code: string): number => Math.max(0, prefs.minStock?.[code] ?? prefs.lowStock ?? 0);
const pctOf = (share: number): number => Math.round(share * 100);

function listCodes(codes: string[], max = 3): string {
  return codes.slice(0, max).join("、") + (codes.length > max ? ` 等 ${codes.length} 色` : "");
}

export function whyText(r: Pick<NextUpRow, "canMake" | "shortBeads" | "shortColors" | "surplusShare" | "surplusTop" | "pushLow">): string {
  const parts: string[] = [];
  parts.push(r.canMake ? "不缺豆" : `缺 ${r.shortBeads.toLocaleString("zh-CN")} 颗（${listCodes(r.shortColors.map((s) => s.code))}）`);
  parts.push(r.surplusShare > 0 && r.surplusTop.length ? `${pctOf(r.surplusShare)}% 用的是库存多的颜色（${r.surplusTop.map((s) => s.code).join("、")}）` : "没用到库存多的颜色");
  if (r.pushLow.length) parts.push(`拼完 ${listCodes(r.pushLow.map((s) => s.code))} 会偏少`);
  return parts.join(" · ");
}

/**
 * 推荐下一张拼什么。先“计划拼”，再“收藏”，各自按分数排；制作中的不推荐，但它的用量先从库存里扣掉。
 * 没有任何库存记录（全 0 / 空）时返回空，避免把“没录入”当成“全缺”。
 */
export function nextUp(patterns: Pattern[], stock: Counts, prefs: Pick<SharedPrefs, "minStock" | "lowStock" | "lossRate">): NextUpResult {
  const loss = prefs.lossRate;
  const empty: NextUpResult = { rows: [], available: {}, surplus: {} };
  if (!Object.values(stock).some((n) => n > 0)) return empty;

  const reservedRaw = demandByCode(patterns, (p) => !p.deleted && !p.consumed && p.status === "making");
  const available: Counts = {};
  const surplus: Counts = {};
  for (const code of new Set([...Object.keys(stock), ...Object.keys(reservedRaw)])) {
    const free = Math.max(0, (stock[code] ?? 0) - withLoss(reservedRaw[code] ?? 0, loss));
    available[code] = free;
    const extra = free - floorOf(prefs, code);
    if (extra > 0) surplus[code] = extra;
  }

  const rows: NextUpRow[] = [];
  for (const p of patterns) {
    if (p.deleted || p.consumed) continue;
    if (p.status !== "planned" && p.status !== "idea") continue;
    if (!(totalOf(p.counts) > 0)) continue;
    const copies = Math.max(1, p.copies || 1);
    const needs: Counts = {};
    let needed = 0;
    let surplusBeads = 0;
    let shortBeads = 0;
    const shortColors: ShortColor[] = [];
    const uses: SurplusUse[] = [];
    const pushLow: LowAfter[] = [];
    for (const [code, n] of Object.entries(p.counts)) {
      if (!(n > 0)) continue;
      const need = withLoss(n * copies, loss);
      needs[code] = need;
      needed += need;
      const have = available[code] ?? 0;
      if (have < need) {
        shortBeads += need - have;
        shortColors.push({ code, need, have, gap: need - have });
        continue;
      }
      const usedSurplus = Math.min(need, surplus[code] ?? 0);
      if (usedSurplus > 0) { surplusBeads += usedSurplus; uses.push({ code, beads: usedSurplus }); }
      const floor = floorOf(prefs, code);
      if (floor > 0 && have - need < floor) pushLow.push({ code, after: have - need, floor });
    }
    // 缺的色里，库存多的那部分（已有的豆子）不算“库存多”的贡献，只看够用的色。
    shortColors.sort((a, b) => b.gap - a.gap || compareCodes(a.code, b.code));
    uses.sort((a, b) => b.beads - a.beads || compareCodes(a.code, b.code));
    pushLow.sort((a, b) => compareCodes(a.code, b.code));
    const canMake = shortColors.length === 0;
    const share = needed > 0 ? surplusBeads / needed : 0;
    const sharePct = pctOf(share);
    const base = canMake ? 1000 : 500 * (1 - Math.min(1, shortBeads / needed));
    const score = base + sharePct - Math.min(50, 5 * pushLow.length);
    const row: NextUpRow = {
      id: p.id, name: p.name, copies, group: p.status === "planned" ? "planned" : "idea",
      needed, needs, canMake, shortBeads, shortColors, surplusBeads, surplusShare: share, surplusTop: uses.slice(0, 3),
      pushLow, score, rank: 0, why: ""
    };
    row.why = whyText(row);
    rows.push(row);
  }
  const created = new Map(patterns.map((p) => [p.id, p.createdAt ?? 0]));
  rows.sort((a, b) =>
    (a.group === b.group ? 0 : a.group === "planned" ? -1 : 1) ||
    b.score - a.score ||
    (created.get(a.id) ?? 0) - (created.get(b.id) ?? 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const counter: Record<NextUpGroup, number> = { planned: 0, idea: 0 };
  for (const r of rows) r.rank = ++counter[r.group];
  return { rows, available, surplus };
}

export type TogetherCheck = { ok: boolean; count: number; short: ShortColor[] };

/** 排在最前面的 n 张图（同一组里）能不能一起拼：把它们的用量加起来对照可用库存。 */
export function canMakeTogether(result: NextUpResult, n: number, group: NextUpGroup = "planned"): TogetherCheck {
  const picked = result.rows.filter((r) => r.group === group).slice(0, Math.max(0, n));
  const total: Counts = {};
  for (const r of picked) for (const [code, need] of Object.entries(r.needs)) total[code] = (total[code] ?? 0) + need;
  const short: ShortColor[] = [];
  for (const [code, need] of Object.entries(total)) {
    const have = result.available[code] ?? 0;
    if (have < need) short.push({ code, need, have, gap: need - have });
  }
  short.sort((a, b) => b.gap - a.gap || compareCodes(a.code, b.code));
  return { ok: short.length === 0, count: picked.length, short };
}
