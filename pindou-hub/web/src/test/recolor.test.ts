import { describe, expect, it } from "vitest";
import { encodeDone, decodeDone, newFlags } from "../lib/build";
import { encodeMatrix, matrixOf } from "../lib/matrix";
import { totalOf, type Pattern } from "../lib/model";
import { colorOf } from "../lib/palette";
import { ALL_CODES, kitCodes } from "../lib/palette";
import { allowedCodes, applyRecolor, distanceLabel, hasBuildProgress, nearestAllowed, outsideColors, planBatch, planRecolor, recolorBlock, restoreRecolor } from "../lib/recolor";

const KIT = "mard-221";
const outside = ALL_CODES.filter((c) => !kitCodes(KIT).includes(c));

function pat(over: Partial<Pattern> = {}): Pattern {
  return { id: "p1", name: "t", kind: "generated", method: "generate", counts: {}, status: "planned", copies: 1, tags: [], notes: "", createdAt: 1, updatedAt: 10, ...over };
}

describe("allowedCodes", () => {
  it("managed 含套装和套装外有货的；缺货的套装色仍在", () => {
    const kit = kitCodes(KIT);
    const extra = outside[0];
    const a = allowedCodes("managed", KIT, { [kit[0]]: 0, [extra]: 5 });
    expect(a).toContain(kit[0]);
    expect(a).toContain(extra);
    expect(a).not.toContain(outside[1]);
  });
  it("instock 只要有货的", () => {
    const kit = kitCodes(KIT);
    expect(allowedCodes("instock", KIT, { [kit[0]]: 0, [kit[1]]: 3, ZZZ: 9 })).toEqual([kit[1]]);
  });
});

describe("planRecolor", () => {
  const allowed = kitCodes(KIT);
  it("范围内的颜色不动；没有要做的事", () => {
    const plan = planRecolor({ counts: { [allowed[0]]: 4 } }, allowed);
    expect(plan.rows).toEqual([]);
    expect(plan.reason).toBeTruthy();
  });
  it("允许集合为空时说明原因", () => {
    const plan = planRecolor({ counts: { A1: 4 } }, []);
    expect(plan.rows).toEqual([]);
    expect(plan.reason).toContain("没有可换成");
  });
  it("范围外的换成最近色，总颗数不变，矩阵一起换", () => {
    const o = outside.find((c) => !!colorOf(c))!;
    const a0 = allowed[0], a1 = allowed[1];
    const matrix = [[o, o, a0], [null, o, a1]];
    const counts = { [o]: 3, [a0]: 1, [a1]: 1 };
    const plan = planRecolor({ counts, matrix }, allowed);
    expect(plan.rows).toHaveLength(1);
    expect(plan.rows[0].from).toBe(o);
    expect(allowed).toContain(plan.rows[0].to);
    expect(totalOf(plan.newCounts)).toBe(totalOf(counts));
    expect(plan.beads).toBe(5);
    expect(plan.changedBeads).toBe(3);
    expect(plan.newMatrix![0][0]).toBe(plan.rows[0].to);
    expect(plan.newMatrix![1][0]).toBeNull();
    // 矩阵里的颗数和新用量一致
    const tally: Record<string, number> = {};
    for (const row of plan.newMatrix!) for (const c of row) if (c) tally[c] = (tally[c] ?? 0) + 1;
    expect(tally).toEqual(plan.newCounts);
  });
  it("多个色合并到同一个色时数量相加", () => {
    const o1 = outside[0], o2 = outside[1];
    const plan = planRecolor({ counts: { [o1]: 2, [o2]: 3 } }, ["A1"]);
    expect(plan.newCounts).toEqual({ A1: 5 });
    expect(totalOf(plan.newCounts)).toBe(5);
  });
  it("色卡里没有的色号保持不动并单独列出", () => {
    const plan = planRecolor({ counts: { QQ99: 7, [outside[0]]: 1 } }, allowed);
    expect(plan.unknown).toEqual([{ code: "QQ99", count: 7 }]);
    expect(plan.newCounts.QQ99).toBe(7);
    expect(plan.beads).toBe(8);
  });
  it("距离相同按色号顺序取前面的，结果稳定", () => {
    // 候选里同一个色号重复出现不影响；两个候选同距离（同一颜色值）时取 compareCodes 小的
    const best = nearestAllowed(outside[0], ["B3", "A9", "A10"]);
    expect(best).toEqual(nearestAllowed(outside[0], ["A10", "A9", "B3"]));
  });
  it("标签随距离变化", () => {
    expect(distanceLabel(1)).toBe("几乎一样");
    expect(distanceLabel(3)).toBe("很接近");
    expect(distanceLabel(7)).toBe("相近");
    expect(distanceLabel(12)).toBe("差别明显");
  });
  it("outsideColors 只算色卡里有、范围外的", () => {
    expect(outsideColors({ [outside[0]]: 2, QQ99: 1, [allowed[0]]: 3 }, allowed)).toEqual([{ code: outside[0], count: 2 }]);
  });
});

describe("applyRecolor / restoreRecolor", () => {
  const allowed = kitCodes(KIT);
  const o = outside.find((c) => !!colorOf(c))!;
  const a0 = allowed[0];
  const matrix = [[o, a0, o], [o, null, a0]];
  const base = pat({ counts: { [o]: 3, [a0]: 2 }, width: 3, height: 2, matrixRle: encodeMatrix(matrix), verifiedAt: 5 });

  it("换色再恢复，和原来完全一样（压缩矩阵）", () => {
    const plan = planRecolor({ counts: base.counts, matrix: matrixOf(base) }, allowed);
    const patch = applyRecolor(base, plan, "managed", 100);
    const after = { ...base, ...patch } as Pattern;
    expect(after.counts).not.toEqual(base.counts);
    expect(after.stockRecolor?.origCounts).toEqual(base.counts);
    expect(matrixOf(after)).not.toEqual(matrix);
    const back = { ...after, ...restoreRecolor(after, 200)! } as Pattern;
    expect(back.counts).toEqual(base.counts);
    expect(matrixOf(back)).toEqual(matrix);
    expect(back.matrixRle).toBe(base.matrixRle);
    expect(back.stockRecolor).toBeUndefined();
    expect(after.verifiedAt).toBeUndefined();
    expect(back.verifiedAt).toBe(5);
    expect(back.updatedAt).toBeGreaterThan(after.updatedAt);
  });
  it("原来没有预览图：换色时新画的预览图在恢复原色时拿掉；原来有的换回原来那张", () => {
    const plan = planRecolor({ counts: base.counts, matrix: matrixOf(base) }, allowed);
    const a = { ...base, ...applyRecolor(base, plan, "managed", 100, { previewId: "new" }) } as Pattern;
    expect(a.previewId).toBe("new");
    expect(a.stockRecolor?.previewAdded).toBe(true);
    const back = { ...a, ...restoreRecolor(a, 200)! } as Pattern;
    expect(back.previewId).toBeUndefined();
    const withOld = { ...base, previewId: "old" };
    const b = { ...withOld, ...applyRecolor(withOld, plan, "managed", 100, { previewId: "new" }) } as Pattern;
    expect(b.stockRecolor?.previewAdded).toBeUndefined();
    expect(({ ...b, ...restoreRecolor(b, 200)! } as Pattern).previewId).toBe("old");
  });
  it("老记录存 matrix 时仍写 matrix，恢复也写 matrix", () => {
    const old = pat({ counts: base.counts, width: 3, height: 2, matrix });
    const plan = planRecolor({ counts: old.counts, matrix: matrixOf(old) }, allowed);
    const after = { ...old, ...applyRecolor(old, plan, "managed", 100) } as Pattern;
    expect(after.matrix).toBeDefined();
    expect(after.matrixRle).toBeUndefined();
    const back = { ...after, ...restoreRecolor(after, 200)! } as Pattern;
    expect(back.matrix).toEqual(matrix);
  });
  it("第二次换色保留第一次的原样，恢复回最初", () => {
    const p1 = planRecolor({ counts: base.counts, matrix: matrixOf(base) }, allowed);
    const a1 = { ...base, ...applyRecolor(base, p1, "managed", 100) } as Pattern;
    const target = p1.rows[0].to;
    const narrower = allowed.filter((c) => c !== target);
    const p2 = planRecolor({ counts: a1.counts, matrix: matrixOf(a1) }, narrower);
    const a2 = { ...a1, ...applyRecolor(a1, p2, "instock", 150) } as Pattern;
    expect(a2.stockRecolor?.origCounts).toEqual(base.counts);
    expect(a2.stockRecolor?.mode).toBe("instock");
    expect(a2.stockRecolor?.map.find(([f]) => f === o)?.[1]).toBe(p2.rows[0].to);
    const back = { ...a2, ...restoreRecolor(a2, 200)! } as Pattern;
    expect(back.counts).toEqual(base.counts);
    expect(matrixOf(back)).toEqual(matrix);
  });
  it("没有记录时恢复返回 null", () => {
    expect(restoreRecolor(base, 1)).toBeNull();
  });
  it("没有格子的图纸只换用量", () => {
    const manual = pat({ counts: { [o]: 4 } });
    const plan = planRecolor({ counts: manual.counts }, allowed);
    const after = { ...manual, ...applyRecolor(manual, plan, "managed", 100) } as Pattern;
    expect(totalOf(after.counts)).toBe(4);
    expect(after.matrixRle).toBeUndefined();
    const back = { ...after, ...restoreRecolor(after, 200)! } as Pattern;
    expect(back.counts).toEqual(manual.counts);
  });
  it("拼装进度跟着换色，恢复后回到原来", () => {
    const flags = newFlags(3, 2);
    flags[0] = 1; flags[1] = 1; // o 与 a0 各一格已拼
    const done = encodeDone(matrix, flags, 3, 2);
    const withBuild = pat({ ...base, build: { boardSize: 29, board: 0, colorIndex: 1, mode: "color", done, updatedAt: 20 } });
    expect(hasBuildProgress(withBuild)).toBe(true);
    const plan = planRecolor({ counts: withBuild.counts, matrix: matrixOf(withBuild) }, allowed);
    const after = { ...withBuild, ...applyRecolor(withBuild, plan, "managed", 100) } as Pattern;
    const nm = matrixOf(after)!;
    const f2 = decodeDone(after.build!.done, nm, 3, 2);
    expect(f2[0]).toBe(1);
    expect(f2[1]).toBe(1);
    expect(f2.reduce((a, b) => a + b, 0)).toBe(2);
    const back = { ...after, ...restoreRecolor(after, 200)! } as Pattern;
    expect(back.build!.done).toBe(done);
  });
});

describe("planBatch", () => {
  const allowed = kitCodes(KIT);
  const o = outside.find((c) => !!colorOf(c))!;
  it("统计受影响的并跳过已完成 / 已扣库存 / 拼装进行中", () => {
    const flags = newFlags(1, 1); flags[0] = 1;
    const m = [[o]];
    const list = [
      pat({ id: "a", counts: { [o]: 5 } }),
      pat({ id: "b", counts: { [o]: 5 }, status: "done" }),
      pat({ id: "c", counts: { [o]: 5 }, consumed: true }),
      pat({ id: "d", counts: { [o]: 1 }, width: 1, height: 1, matrixRle: encodeMatrix(m), build: { boardSize: 0, board: 0, colorIndex: 0, mode: "color", done: encodeDone(m, flags, 1, 1), updatedAt: 1 } }),
      pat({ id: "e", counts: { [allowed[0]]: 5 } }),
      pat({ id: "f", counts: { [o]: 5 }, deleted: true })
    ];
    const s = planBatch(list, allowed);
    expect(s.patterns.map((x) => x.id)).toEqual(["a"]);
    expect(s.skippedDone).toBe(1);
    expect(s.skippedConsumed).toBe(1);
    expect(s.skippedProgress).toBe(1);
    expect(s.beads).toBe(5);
    expect(s.colors).toBe(1);
    expect(recolorBlock(list[1])).toBe("done");
    expect(recolorBlock(list[0])).toBeNull();
  });
});
