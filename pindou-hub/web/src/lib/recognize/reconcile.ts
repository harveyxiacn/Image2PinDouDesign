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

/** OCR 数量读错的常见形态：漏读 / 多读一位数字、3↔8 之类的形近混淆。 */
function countVariants(n: number): number[] {
  const s = String(n);
  const out = new Set<number>();
  for (let i = 0; i <= s.length; i += 1) for (let d = 0; d <= 9; d += 1) if (!(i === 0 && d === 0)) out.add(Number(s.slice(0, i) + d + s.slice(i)));
  if (s.length > 1) for (let i = 0; i < s.length; i += 1) out.add(Number(s.slice(0, i) + s.slice(i + 1)));
  const PARTNER: Record<string, string[]> = { "0": ["8", "6"], "1": ["7"], "3": ["8"], "5": ["6", "3"], "6": ["5", "8", "0"], "7": ["1"], "8": ["3", "0", "6"], "9": ["8", "4"], "2": ["7"], "4": ["1"] };
  for (let i = 0; i < s.length; i += 1) for (const p of PARTNER[s[i]] ?? []) out.add(Number(s.slice(0, i) + p + s.slice(i + 1)));
  out.delete(n);
  return [...out].filter((v) => v >= 1 && v <= 99999 && Number.isFinite(v));
}

/**
 * 图例各色之和不等于图上写的总数时：给每个色号候选值（主读数、备选读法、网格数、数字漏读 / 多读 / 形近混淆后的变体），
 * 用动态规划求“合计恰为总数、改动代价最小”的组合。读数被多遍识别支持（得票 ≥ 2 且没有备选）的色号改动代价高，
 * 所以只有在“非这样改合计就对不上”时才会被改。无解（或要改的色号太多）返回 null。
 */
export function fitLegendToTotal(
  items: LegendItem[],
  grid: Counts | null,
  total: number,
  maxChanged = 4,
  maxCost = Infinity
): Record<string, number> | null {
  if (items.length < 3 || total <= 0) return null;
  const tol = Math.max(1, Math.round(0.0005 * total));
  const cap = Math.round(total * 1.03) + 5;
  type Cand = { value: number; cost: number };
  const opts: Cand[][] = items.map((it) => {
    const strong = (it.votes ?? 0) >= 2 && !it.alts?.length;
    const m = new Map<number, number>();
    const put = (v: number, c: number) => { if (v >= 1 && v <= cap && (m.get(v) ?? 99) > c) m.set(v, c); };
    put(it.count, 0);
    (it.alts ?? []).forEach((a, i) => put(a, 1 + 0.2 * i));
    const g = grid?.[it.code];
    const vs = new Set<number>();
    for (const base of [it.count, ...(it.alts ?? [])]) for (const v of countVariants(base)) vs.add(v);
    // 与网格数吻合（±3%）的 OCR 变体最可信；与读到的数字毫无关系的网格数（颜色相近的色号互相串）代价高
    const nearG = (v: number) => g !== undefined && g >= 5 && Math.abs(v - g) <= Math.max(2, 0.03 * g);
    for (const v of vs) put(v, nearG(v) ? 0.4 + 0.1 * Math.min(1, Math.abs(v - (g as number)) / Math.max(2, 0.03 * (g as number))) : strong ? 4 : 2);
    if (g !== undefined && g >= 5 && !vs.has(g)) put(g, (it.alts ?? []).includes(g) ? 0.5 : 4);
    return [...m.entries()].map(([value, cost]) => ({ value, cost }));
  });
  // layer[i]: 前 i 个色号取到合计 s 的最小代价（及来路）
  type Node = { cost: number; prev: number; k: number; chg: number };
  const layers: Array<Map<number, Node>> = [new Map([[0, { cost: 0, prev: -1, k: -1, chg: 0 }]])];
  for (let i = 0; i < opts.length; i += 1) {
    const next = new Map<number, Node>();
    for (const [s, nd] of layers[i]) {
      opts[i].forEach((o, k) => {
        const s2 = s + o.value;
        if (s2 > cap) return;
        const chg = nd.chg + (o.value === items[i].count ? 0 : 1);
        if (chg > maxChanged) return;
        const cost = nd.cost + o.cost;
        const cur = next.get(s2);
        if (!cur || cost < cur.cost) next.set(s2, { cost, prev: s, k, chg });
      });
    }
    if (next.size > 80_000) return null;
    layers.push(next);
  }
  let bestS = -1, bestCost = Infinity;
  let bestKey = Infinity;
  for (const [s, nd] of layers[opts.length]) {
    // 合计恰好等于总数的优先于差一两颗的（差 1 颗折合 0.3 的代价）
    const key = nd.cost + 0.3 * Math.abs(s - total);
    if (Math.abs(s - total) <= tol && key < bestKey) { bestS = s; bestCost = nd.cost; bestKey = key; }
  }
  if (bestS < 0 || bestCost > maxCost) return null;
  const out: Record<string, number> = {};
  let s = bestS;
  for (let i = opts.length - 1; i >= 0; i -= 1) {
    const nd = layers[i + 1].get(s)!;
    out[items[i].code] = opts[i][nd.k].value;
    s = nd.prev;
  }
  return out;
}

/**
 * 按数量从大到小排列的图例（happy拼豆嘛 等）：每个色块给一组候选读数（带代价，null = 一点都没读到、取值不限），
 * 在“数量不增、合计恰为总数”的约束下求总代价最小的一组。动态规划：每个色块的候选按数值降序，
 * 用“前一个色块的候选前缀最小代价”完成不增约束，状态 = (候选, 合计)，复杂度 ≈ 候选数 × 总数。
 * 总代价超过 maxCost 或没有恰好吻合的组合返回 null。
 */
export function fitOrderedCounts(
  cands: Array<Array<{ value: number; cost: number }> | null>,
  total: number,
  maxCost: number,
  freeCost = 2.5
): number[] | null {
  const n = cands.length;
  if (n === 0 || total <= 0 || total > 20000) return null;
  const tol = Math.max(1, Math.round(0.0005 * total));
  const S = total + tol + 1;
  let maxV = 1;
  for (const c of cands) if (c) for (const o of c) maxV = Math.max(maxV, o.value);
  maxV = Math.min(maxV, total, 400);
  const lists: Array<Array<{ value: number; cost: number }>> = cands.map((c) => {
    if (c) {
      const m = new Map<number, number>();
      for (const o of c) if (o.value >= 1 && o.value <= total && (m.get(o.value) ?? 99) > o.cost) m.set(o.value, o.cost);
      return [...m.entries()].map(([value, cost]) => ({ value, cost })).sort((a, b) => b.value - a.value);
    }
    return Array.from({ length: maxV }, (_, k) => ({ value: maxV - k, cost: freeCost }));
  });
  if (lists.some((l) => !l.length)) return null;
  if (lists.reduce((t, l) => t + l.length, 0) * S > 60_000_000) return null;
  const INF = 1e9;
  const dp: Float32Array[] = [];
  let prevPref: Float32Array | null = null; // prevPref[k*S+s] = 前一层中 min over k' ≤ k of dp[k'*S+s]
  for (let i = 0; i < n; i += 1) {
    const L = lists[i];
    const cur = new Float32Array(L.length * S).fill(INF);
    if (i === 0) {
      L.forEach((o, j) => { if (o.value < S) cur[j * S + o.value] = o.cost; });
    } else {
      const P = prevPref!, PL = lists[i - 1];
      let idx = -1;
      // 候选按数值降序：对每个 j 找前一层中“数值 ≥ 当前值”的最后一个下标（j 增大、数值变小，idx 只增不减）
      for (let j = 0; j < L.length; j += 1) {
        const v = L[j].value;
        while (idx + 1 < PL.length && PL[idx + 1].value >= v) idx += 1;
        if (idx < 0) continue;
        const base = idx * S;
        for (let s = 0; s + v < S; s += 1) {
          const c = P[base + s];
          if (c < INF) cur[j * S + s + v] = c + L[j].cost;
        }
      }
    }
    dp.push(cur);
    const P2 = new Float32Array(cur.length);
    for (let k = 0; k < L.length; k += 1) for (let s = 0; s < S; s += 1) { const a = cur[k * S + s]; const b = k ? P2[(k - 1) * S + s] : INF; P2[k * S + s] = a < b ? a : b; }
    prevPref = P2;
  }
  let bj = -1, bs = -1, bc = INF;
  const last = dp[n - 1];
  for (let j = 0; j < lists[n - 1].length; j += 1) for (let s = Math.max(0, total - tol); s <= total + tol && s < S; s += 1) { const c = last[j * S + s]; if (c < bc) { bc = c; bj = j; bs = s; } }
  if (bj < 0 || bc > maxCost) return null;
  const out = new Array<number>(n);
  let j = bj, s = bs;
  for (let i = n - 1; i >= 0; i -= 1) {
    const v = lists[i][j].value;
    out[i] = v;
    if (i === 0) break;
    const target = dp[i][j * S + s] - lists[i][j].cost;
    const s2 = s - v;
    let found = -1;
    for (let k = 0; k < lists[i - 1].length && lists[i - 1][k].value >= v; k += 1) if (Math.abs(dp[i - 1][k * S + s2] - target) < 1e-3) { found = k; break; }
    if (found < 0) return null;
    j = found; s = s2;
  }
  return out;
}
