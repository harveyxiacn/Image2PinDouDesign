import type { BeadDesign } from "./types";

export type StatsSourceFilter = "all" | "projects" | "drafts";

type CountedDesign = Pick<BeadDesign, "id" | "colorCounts">;

export function matchesStatsSource(
  designId: string,
  draftIds: ReadonlySet<string>,
  filter: StatsSourceFilter
): boolean {
  if (filter === "all") return true;
  const isDraft = draftIds.has(designId);
  return filter === "drafts" ? isDraft : !isDraft;
}

export function countDesignsBySource(
  designs: Array<Pick<BeadDesign, "id">>,
  draftIds: ReadonlySet<string>,
  filter: StatsSourceFilter
): number {
  return designs.filter((design) => matchesStatsSource(design.id, draftIds, filter)).length;
}

export function aggregateCounts(
  designs: CountedDesign[],
  draftIds: ReadonlySet<string>,
  filter: StatsSourceFilter
): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const design of designs) {
    if (!matchesStatsSource(design.id, draftIds, filter)) continue;
    for (const [code, count] of Object.entries(design.colorCounts)) {
      if (!Number.isFinite(count) || count <= 0) continue;
      totals[code] = (totals[code] ?? 0) + count;
    }
  }
  return totals;
}
