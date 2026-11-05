import { describe, expect, it } from "vitest";
import { MARD_PALETTE } from "@engine/palette";
import { countAlternatives, findFlatBlobs, splitGlued, nearestCodesByColor, parseCodeCountText, parseCountPattern, validateCodeCandidates } from "../lib/recognize/legend";
import { fitLegendToTotal, fitOrderedCounts, fitToTotal, reconcileCounts } from "../lib/recognize/reconcile";

const VALID = new Set(MARD_PALETTE.map((c) => c.code));
const colorOf = (code: string) => MARD_PALETTE.find((c) => c.code === code)?.rgb ?? null;

describe("数量写法解析 parseCountPattern", () => {
  it.each([
    ["x321", 321], ["×321", 321], ["X321", 321], ["*321", 321], ["321颗", 321], ["321", 321],
    ["B13 315", 315], ["A26 (871)", 871], ["x 1,204", 1204], ["x1O5", 105], ["XI3", 13]
  ])("%s → %d", (text, n) => expect(parseCountPattern(text)).toBe(n));
  it("没有数字 / 超范围 → null", () => {
    expect(parseCountPattern("x")).toBeNull();
    expect(parseCountPattern("")).toBeNull();
    expect(parseCountPattern("x0")).toBeNull();
    expect(parseCountPattern("123456")).toBeNull();
  });
});

describe("色块文字 parseCodeCountText", () => {
  it("“B13 315” → 色号 + 数量", () => {
    const r = parseCodeCountText("B13 315", VALID);
    expect(r.codes[0]).toBe("B13");
    expect(r.count).toBe(315);
  });
  it("“H02 (18)” 零填充 + 括号", () => {
    const r = parseCodeCountText("H02 (18)", VALID);
    expect(r.codes[0]).toBe("H2");
    expect(r.count).toBe(18);
  });
  it("只有色号没有数量", () => {
    const r = parseCodeCountText("A10", VALID);
    expect(r.codes[0]).toBe("A10");
    expect(r.count).toBeNull();
  });
  it("“x321” 单独一个 token 也算数量（色号在别处）", () => {
    const r = parseCodeCountText("x321", VALID);
    expect(r.count).toBe(321);
  });
});

describe("连写 / 杂质 / 单位字", () => {
  it("“A1 - 154 Hi”：数量后面的杂质（颗 被读成 Hi）被跳过", () => {
    const r = parseCodeCountText("A1 - 154 Hi", VALID);
    expect(r.codes[0]).toBe("A1");
    expect(r.count).toBe(154);
  });
  it("“C9 - 51 48”：单位字被读成 2 位假数字时，数量取前一个数字", () => {
    expect(parseCodeCountText("C9 - 51 48", VALID).count).toBe(51);
  });
  it("“B23 - 7TH”：数量后粘着的 TH 去掉", () => {
    expect(parseCodeCountText("B23 - 7TH", VALID).count).toBe(7);
  });
  it("splitGlued：A10195 拆成 A10 + 195（A1 + 0195 有前导零，被排除）", () => {
    const r = splitGlued("A10195", VALID);
    expect(r).toContainEqual({ code: "A10", count: 195 });
    expect(r.some((x) => x.code === "A1")).toBe(false);
  });
  it("splitGlued：数量不超过 4 位", () => {
    expect(splitGlued("H191472", VALID)).toEqual([{ code: "H19", count: 1472 }]);
  });
});

describe("色号候选校验", () => {
  it("绿色块上的 E20 被剔除，留下颜色吻合的候选", () => {
    const green = colorOf("B13")!; // 浅绿
    const ok = validateCodeCandidates(["E20", "B13", "B18"], green, colorOf);
    expect(ok.map((o) => o.code)).toContain("B13");
    expect(ok.map((o) => o.code)).not.toContain("E20");
  });
  it("颜色最近邻", () => {
    const rgb = colorOf("H7")!;
    expect(nearestCodesByColor(rgb, VALID, colorOf, 6, 1)[0].code).toBe("H7");
  });
  it("没有任何候选吻合 → 空", () => {
    expect(validateCodeCandidates(["A1", "A2"], { r: 0, g: 0, b: 0 }, colorOf)).toEqual([]);
  });
});

describe("数字混淆备选", () => {
  it("313 的备选含 318", () => expect(countAlternatives(313)).toContain(318));
  it("不含自身", () => expect(countAlternatives(7)).not.toContain(7));
});

describe("平涂色块查找 findFlatBlobs", () => {
  it("找到两个色块并给出中位颜色（块内的字是少数）", () => {
    const w = 200, h = 60;
    const data = new Uint8ClampedArray(w * h * 4).fill(255);
    const fill = (x0: number, y0: number, ww: number, hh: number, c: [number, number, number]) => {
      for (let y = y0; y < y0 + hh; y += 1) for (let x = x0; x < x0 + ww; x += 1) { const i = (y * w + x) * 4; data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; }
    };
    fill(10, 10, 50, 40, [230, 130, 70]);
    fill(20, 25, 10, 10, [255, 255, 255]); // 白字
    fill(100, 10, 50, 40, [20, 20, 20]);
    const blobs = findFlatBlobs({ width: w, height: h, data }).sort((a, b) => a.x - b.x);
    expect(blobs.length).toBe(2);
    expect(blobs[0].r).toBeGreaterThan(200);
    expect(blobs[1].r).toBeLessThan(40);
  });
});

describe("多来源核对 reconcile", () => {
  it("fitToTotal：在候选里挑合计恰为总数的组合", () => {
    const base = { A: 100, B: 200, C: 50 };
    const fit = fitToTotal(base, { A: [{ value: 100, cost: 0 }, { value: 180, cost: 1 }], B: [{ value: 200, cost: 0 }, { value: 280, cost: 1 }] }, 510);
    expect(fit?.diff).toBe(0);
    expect(fit?.counts).toEqual({ A: 180, B: 280, C: 50 });
  });
  it("合计与总数对不上时，用备选读法凑出总数，并标注来源", () => {
    const legend = [
      { code: "A1", count: 318, source: "x", alts: [313], votes: 1 },
      { code: "B2", count: 100, source: "x", votes: 2 }
    ];
    const r = reconcileCounts({ current: { A1: 318, B2: 100 }, legend, grid: { A1: 313, B2: 100 }, total: 413, colors: 2 });
    expect(r.counts.A1).toBe(313);
    expect(r.changed.length).toBe(1);
    expect(r.prov.A1.source).toBe("total-fit");
    expect(r.prov.B2.source).toBe("both");
  });
  it("网格数恰好等于图例某个备选读法（OCR 数字混淆）时，改用备选", () => {
    const legend = [{ code: "A1", count: 300, source: "x", alts: [380], votes: 1 }, { code: "B2", count: 100, source: "x", votes: 2 }];
    const r = reconcileCounts({ current: { A1: 300, B2: 100 }, legend, grid: { A1: 380, B2: 100 }, total: null, colors: 2 });
    expect(r.counts.A1).toBe(380);
    expect(r.changed.length).toBe(1);
  });
  it("合计已吻合时不改动；与网格矛盾、备选也对不上的色号标为不确定", () => {
    const legend = [{ code: "A1", count: 300, source: "x", alts: [310], votes: 1 }, { code: "B2", count: 100, source: "x", votes: 2 }];
    const r = reconcileCounts({ current: { A1: 300, B2: 100 }, legend, grid: { A1: 380, B2: 100 }, total: 400, colors: 2 });
    expect(r.changed.length).toBe(0);
    expect(r.counts.A1).toBe(300);
    expect(r.prov.A1.uncertain).toBe(true);
    expect(r.prov.B2.uncertain).toBe(false);
  });
  it("没有总数时保持原读数", () => {
    const r = reconcileCounts({ current: { A1: 10 }, legend: null, grid: { A1: 10 }, total: null, colors: null });
    expect(r.counts).toEqual({ A1: 10 });
  });
});

describe("图例合计 = 总数 的补救", () => {
  it("fitLegendToTotal：OCR 漏读一位（67→671）、网格数佐证时，凑出总数", () => {
    const items = [
      { code: "A1", count: 67, source: "x", votes: 2 },
      { code: "B2", count: 366, source: "x", votes: 2 },
      { code: "C3", count: 309, source: "x", votes: 2 },
      { code: "D4", count: 243, source: "x", votes: 2 }
    ];
    const fit = fitLegendToTotal(items, { A1: 671, B2: 366, C3: 309, D4: 243 }, 671 + 366 + 309 + 243);
    expect(fit?.A1).toBe(671);
    expect(fit?.B2).toBe(366);
  });
  it("fitLegendToTotal：合计已对、或无解时不乱改", () => {
    const items = [{ code: "A1", count: 10, source: "x" }, { code: "B2", count: 20, source: "x" }, { code: "C3", count: 30, source: "x" }];
    expect(fitLegendToTotal(items, null, 60)?.A1).toBe(10);
    expect(fitLegendToTotal(items, null, 5_000_000)).toBeNull();
  });
  it("fitOrderedCounts：数量不增 + 合计等于总数，从带噪的候选里挑出一组", () => {
    // 真值 500 300 200 100 50 40 30 20 10 5；其中几个读数被读错（括号读成 1：1300 / 1200）
    const truth = [500, 300, 200, 100, 50, 40, 30, 20, 10, 5];
    const reads = [500, 1300, 200, 100, 50, 40, 30, 1200, 10, 5];
    const cands = reads.map((v, i) => [{ value: v, cost: 0 }, { value: truth[i], cost: 2 }]);
    expect(fitOrderedCounts(cands, 1255, 20)).toEqual(truth);
    // 一个色块什么都没读到（null）：由合计和顺序定出
    const withFree = cands.map((c, i) => (i === 6 ? null : c));
    const v6 = fitOrderedCounts(withFree, 1255, 20)?.[6] ?? 0;
    expect(v6 >= 29 && v6 <= 31).toBe(true); // 合计允许 ±1 的误差
  });
});
