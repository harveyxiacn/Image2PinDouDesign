// 多来源核对：图例读数（含备选读法）、网格数出的颜色（含格内色号校正）、抬头总数 / 色数。
// 不是简单的“谁优先”：先看哪个来源和抬头总数吻合；来源矛盾时，在各来源给出的候选值里挑“合计恰好等于总数”的组合；
// 挑不出来的色号标记为 uncertain，让界面提示用户核对。纯函数，便于单测。
import type { Counts, LegendItem } from "./types";

export type Prov = {
  code: string;
  count: number;
  source: "legend" | "grid" | "both" | "total-fit";
  /** 0–1 */
  confidence: number;
  uncertain: boolean;
  /** 各来源的读数，供界面 / 调试 */
  candidates: { legend: number | null; grid: number | null; alts: number[] };
};

export type ReconcileInput = {
  /** 当前采用的用量（旧逻辑已合并图例 + 网格补全） */
  current: Counts;
  legend: LegendItem[] | null;
  grid: Counts | null;
  /** 格内色号是否参与了网格读数（参与时网格数更可信） */
  cellCodes?: boolean;
  /** 抬头 / 图上写的总数、色数 */
  total: number | null;
  colors: number | null;
};

export type ReconcileResult = {
  counts: Counts;
  prov: Record<string, Prov>;
  /** 因“合计必须等于总数”而改动的色号：旧值 → 新值 */
  changed: Array<{ code: string; from: number; to: number }>;
  notes: string[];
};

const sumOf = (c: Counts) => Object.values(c).reduce((a, b) => a + b, 0);
const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(2, Math.round(0.03 * Math.max(a, b)));

/** 在每个“有争议”色号的候选值里找合计最接近 total 的组合（最多评估 maxEval 种）。cost：偏离当前值的代价，平手取小者。 */
export function fitToTotal(
  base: Counts,
  options: Record<string, Array<{ value: number; cost: number }>>,
  total: number,
  maxEval = 300_000
): { counts: Counts; diff: number; cost: number } | null {
  const codes = Object.keys(options);
  if (!codes.length) return null;
  const fixedSum = sumOf(base) - codes.reduce((s, c) => s + (base[c] ?? 0), 0);
  let best: { pick: number[]; diff: number; cost: number } | null = null;
  const pick = new Array<number>(codes.length).fill(0);
  let evals = 0;
  const dfs = (i: number, s: number, cost: number) => {
    if (evals > maxEval) return;
    if (i === codes.length) {
      evals += 1;
      const diff = Math.abs(s - total);
      if (!best || diff < best.diff || (diff === best.diff && cost < best.cost)) best = { pick: [...pick], diff, cost };
      return;
    }
    options[codes[i]].forEach((o, k) => { pick[i] = k; dfs(i + 1, s + o.value, cost + o.cost); });
  };
  dfs(0, fixedSum, 0);
  if (!best) return null;
  const b = best as { pick: number[]; diff: number; cost: number };
  const counts: Counts = { ...base };
  codes.forEach((c, i) => { counts[c] = options[c][b.pick[i]].value; });
  return { counts, diff: b.diff, cost: b.cost };
}

export function reconcileCounts(inp: ReconcileInput): ReconcileResult {
  const cur: Counts = { ...inp.current };
  const notes: string[] = [];
  const changed: ReconcileResult["changed"] = [];
  const leg = new Map<string, LegendItem>((inp.legend ?? []).map((it) => [it.code, it]));
  const grid = inp.grid ?? {};
  const T = inp.total && inp.total > 0 ? inp.total : null;

  // 0) 图例数量有备选读法（OCR 数字混淆）、而网格数恰好与某个备选吻合、与主读数不吻合：采用备选
  for (const [code, l] of leg) {
    const g = grid[code];
    if (g === undefined || g < 5 || cur[code] === undefined || !l.alts?.length || (l.votes ?? 0) >= 3) continue;
    if (near(cur[code], g)) continue;
    const alt = l.alts.find((a) => near(a, g));
    if (alt !== undefined) { changed.push({ code, from: cur[code], to: alt }); cur[code] = alt; }
  }
  if (changed.length) notes.push(`网格数与图例数字的备选读法吻合，改用备选：${changed.map((c) => `${c.code} ${c.from}→${c.to}`).join("、")}`);

  // 1) 合计与总数对不上：只在“有争议”的色号里找组合
  if (T && Math.abs(sumOf(cur) - T) / T > 0.003 && leg.size) {
    const options: Record<string, Array<{ value: number; cost: number }>> = {};
    for (const code of Object.keys(cur)) {
      const l = leg.get(code), g = grid[code];
      const vals = new Map<number, number>();
      vals.set(cur[code], 0);
      if (l) {
        vals.set(l.count, Math.min(vals.get(l.count) ?? 9, 0.5));
        (l.alts ?? []).forEach((a, i) => vals.set(a, Math.min(vals.get(a) ?? 9, 1 + i * 0.2)));
      }
      if (g !== undefined && g > 0) vals.set(g, Math.min(vals.get(g) ?? 9, 1.5));
      // 只有读数确实有分歧的色号才参与（避免所有色号都带 3 个候选而组合爆炸）
      const disputed = vals.size > 1 && !(l && (l.votes ?? 0) >= 2 && !l.alts?.length && g !== undefined && near(l.count, g));
      if (disputed) options[code] = [...vals.entries()].map(([value, cost]) => ({ value, cost }));
    }
    // 争议色号过多时只保留候选最多的 12 个，其余固定
    const keys = Object.keys(options);
    if (keys.length > 12) for (const k of keys.sort((a, b) => options[b].length - options[a].length).slice(12)) delete options[k];
    const fit = fitToTotal(cur, options, T);
    if (fit && fit.diff <= Math.max(1, Math.round(0.001 * T)) && fit.diff < Math.abs(sumOf(cur) - T)) {
      for (const code of Object.keys(options)) if (fit.counts[code] !== cur[code]) { changed.push({ code, from: cur[code], to: fit.counts[code] }); cur[code] = fit.counts[code]; }
      if (changed.length) notes.push(`按总数 ${T} 重新挑选了 ${changed.length} 个色号的读数：${changed.map((c) => `${c.code} ${c.from}→${c.to}`).join("、")}`);
    }
  }

  // 2) 逐色把握：来源一致 + 合计吻合 → 高；单一来源且有备选读法 / 与另一来源矛盾 → 不确定
  const totalOk = T ? Math.abs(sumOf(cur) - T) / T <= 0.01 : null;
  const prov: Record<string, Prov> = {};
  for (const [code, count] of Object.entries(cur)) {
    const l = leg.get(code) ?? null;
    const g = grid[code] !== undefined ? grid[code] : null;
    const agree = l !== null && g !== null && near(l.count, g);
    const wasFit = changed.some((c) => c.code === code);
    let conf: number;
    let source: Prov["source"];
    if (wasFit) { source = "total-fit"; conf = 0.7; }
    else if (agree) { source = "both"; conf = 0.95; }
    else if (l && near(count, l.count)) { source = "legend"; conf = (l.votes ?? 0) >= 2 && !l.alts?.length ? 0.85 : 0.65; if (g !== null && g >= 5 && !near(l.count, g)) conf -= 0.15; }
    else if (g !== null && near(count, g)) { source = "grid"; conf = inp.cellCodes ? 0.7 : 0.55; }
    else { source = l ? "legend" : "grid"; conf = 0.4; }
    if (totalOk === true) conf = Math.min(1, conf + 0.05);
    else if (totalOk === false) conf = Math.max(0, conf - 0.1);
    const uncertain = conf < 0.6 || (!agree && !!l && g !== null && g >= 5 && !near(l.count, g) && (l.alts?.length ?? 0) > 0);
    prov[code] = { code, count, source, confidence: Number(conf.toFixed(2)), uncertain, candidates: { legend: l?.count ?? null, grid: g, alts: l?.alts ?? [] } };
  }
  if (inp.colors && Math.abs(Object.keys(cur).length - inp.colors) <= 3 && Object.keys(cur).length !== inp.colors) notes.push(`抬头写 ${inp.colors} 色，实际得到 ${Object.keys(cur).length} 色`);
  return { counts: cur, prov, changed, notes };
}
