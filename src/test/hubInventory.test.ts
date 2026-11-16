import { describe, expect, it } from "vitest";
import { replaceInventoryFromHub } from "../domain/hubInventory";

const valid = new Set(["A1", "A2", "B1"]);
const csv = "﻿色号,颜色,HEX,颗数\nA1,白,#FFFFFF,100\nA2,\"红,深\",#FF0000,5\nZZ9,未知,#000000,7\nB1,蓝,#0000FF,0\n";

describe("replaceInventoryFromHub", () => {
  it("替换库存并开启只用手头颜色，汇总颜色数与颗数", () => {
    const r = replaceInventoryFromHub(csv, valid);
    expect(r.inventory).toEqual({ restrictEnabled: true, owned: { A1: 100, A2: 5 } });
    expect(r.colors).toBe(2);
    expect(r.beads).toBe(105);
    expect(r.unknown).toBe(1);
    expect(r.message).toContain("2 种颜色");
    expect(r.message).toContain("105 颗");
  });
  it("没有可识别内容时不改动库存", () => {
    const r = replaceInventoryFromHub("色号,颜色,HEX,颗数\n", valid);
    expect(r.inventory).toBeNull();
    expect(r.message).toContain("拼豆仓");
  });
});
