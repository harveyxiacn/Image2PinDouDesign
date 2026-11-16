import { describe, expect, it } from "vitest";
import { ALL_CODES, managedCodes } from "../lib/palette";
import { effectiveColorCount, loadOnlyStock, outsideCount, pickerItems, saveOnlyStock } from "../lib/managed";

const match = (c: string, q: string) => c.toUpperCase().includes(q.toUpperCase());

describe("pickerItems", () => {
  const managed = ["A1", "A2", "B1"];
  const all = ["A1", "A2", "B1", "P1", "ZG3"];
  it("默认只列管理的色号", () => {
    expect(pickerItems(managed, "", false, match, all)).toEqual(managed.map((code) => ({ code, outside: false })));
  });
  it("搜索时套装外的色号排在后面并标记", () => {
    expect(pickerItems(managed, "1", false, match, all).map((i) => `${i.code}${i.outside ? "*" : ""}`)).toEqual(["A1", "B1", "P1*"]);
  });
  it("显示全部时追加套装外", () => {
    expect(pickerItems(managed, "", true, match, all).filter((i) => i.outside).map((i) => i.code)).toEqual(["P1", "ZG3"]);
  });
  it("outsideCount", () => { expect(outsideCount(managed, all)).toBe(2); });
});

describe("effectiveColorCount", () => {
  it("不限库存 = 套装色数；套装外有货不算", () => {
    const kit = managedCodes("mard-221", {});
    expect(kit.length).toBe(221);
    expect(effectiveColorCount("mard-221", {}, false)).toBe(221);
    expect(effectiveColorCount("mard-221", { P1: 50 }, false)).toBe(221);
  });
  it("只用库存：套装 ∩ 有货；交集为空退回套装", () => {
    expect(effectiveColorCount("mard-221", { A1: 5, A2: 0, B1: 3, P1: 9 }, true)).toBe(2);
    expect(effectiveColorCount("mard-221", { P1: 9 }, true)).toBe(221);
    expect(effectiveColorCount("mard-221", {}, true)).toBe(221);
  });
  it("全套 291 色", () => { expect(ALL_CODES.length).toBeGreaterThan(221); });
});

describe("onlyStock 偏好", () => {
  it("读写与失败降级", () => {
    const mem: Record<string, string> = {};
    const st = { getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => { mem[k] = v; } };
    expect(loadOnlyStock(st)).toBe(false);
    saveOnlyStock(true, st);
    expect(loadOnlyStock(st)).toBe(true);
    saveOnlyStock(false, st);
    expect(loadOnlyStock(st)).toBe(false);
    const bad = { getItem: () => { throw new Error("x"); }, setItem: () => { throw new Error("x"); } };
    expect(loadOnlyStock(bad)).toBe(false);
    expect(() => saveOnlyStock(true, bad)).not.toThrow();
    expect(loadOnlyStock(null)).toBe(false);
  });
});
