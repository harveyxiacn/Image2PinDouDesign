import { putRecords } from "../../lib/db";
import { uid, type CountMethod, type Counts, type Pattern, type PatternKind } from "../../lib/model";
import type { SaveValues } from "./SaveForm";

export function cleanCounts(counts: Counts): Counts {
  const out: Counts = {};
  for (const [code, n] of Object.entries(counts)) if (n > 0) out[code] = Math.round(n);
  return out;
}

export async function createPattern(values: SaveValues, extra: {
  kind: PatternKind; method: CountMethod; counts: Counts; imageId?: string; previewId?: string;
  width?: number; height?: number; matrix?: Pattern["matrix"]; confidence?: number; colorMatch?: number;
  reviewReasons?: string[]; verifiedAt?: number;
}): Promise<Pattern> {
  const now = Date.now();
  const pattern: Pattern = {
    id: uid("p"), name: values.name, kind: extra.kind, method: extra.method,
    imageId: extra.imageId, previewId: extra.previewId, width: extra.width, height: extra.height, matrix: extra.matrix,
    counts: cleanCounts(extra.counts), confidence: extra.confidence, colorMatch: extra.colorMatch,
    reviewReasons: extra.reviewReasons, verifiedAt: extra.verifiedAt,
    status: values.status, copies: values.copies, tags: values.tags, notes: "", createdAt: now, updatedAt: now
  };
  await putRecords("patterns", [pattern]);
  return pattern;
}
