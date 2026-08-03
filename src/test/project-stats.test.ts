import { describe, expect, it } from "vitest";
import { aggregateCounts, countDesignsBySource, matchesStatsSource } from "../domain/projectStats";

const designs: Array<{ id: string; colorCounts: Record<string, number> }> = [
  { id: "project-a", colorCounts: { A1: 10, B1: 2 } },
  { id: "draft-a", colorCounts: { A1: 3, C1: 4 } }
];
const draftIds = new Set(["draft-a"]);

describe("project statistics source filters", () => {
  it("distinguishes projects and local drafts", () => {
    expect(matchesStatsSource("project-a", draftIds, "projects")).toBe(true);
    expect(matchesStatsSource("project-a", draftIds, "drafts")).toBe(false);
    expect(matchesStatsSource("draft-a", draftIds, "drafts")).toBe(true);
  });

  it("aggregates all, project-only, and draft-only counts", () => {
    expect(aggregateCounts(designs, draftIds, "all")).toEqual({ A1: 13, B1: 2, C1: 4 });
    expect(aggregateCounts(designs, draftIds, "projects")).toEqual({ A1: 10, B1: 2 });
    expect(aggregateCounts(designs, draftIds, "drafts")).toEqual({ A1: 3, C1: 4 });
  });

  it("reports the source count used by the UI scope label", () => {
    expect(countDesignsBySource(designs, draftIds, "all")).toBe(2);
    expect(countDesignsBySource(designs, draftIds, "projects")).toBe(1);
    expect(countDesignsBySource(designs, draftIds, "drafts")).toBe(1);
  });

  it("ignores invalid and non-positive count values", () => {
    expect(aggregateCounts([
      { id: "project-b", colorCounts: { A1: 2, B1: -1, C1: Number.NaN } }
    ], new Set(), "all")).toEqual({ A1: 2 });
  });
});
