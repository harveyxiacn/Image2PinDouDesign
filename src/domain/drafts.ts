import { countMatrixColors } from "./conversion";
import type { BeadDesign } from "./types";

export const DRAFTS_STORAGE_KEY = "image2pindou:design-drafts:v1";
export const MAX_LOCAL_DRAFTS = 6;

// 把 localStorage 里的一条草稿原始值校验/规整为 BeadDesign。
// 校验规则与 App.tsx 原有实现逐字节一致：boardWidth/Height 必须为 1..208 的整数，
// matrix 逐格只保留 validCodes 中的色号（其余置 null），colorCounts 一律重算。
export function deserializeDraft(
  raw: unknown,
  index: number,
  validCodes: ReadonlySet<string>
): BeadDesign | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<BeadDesign>;
  const width = Number(value.boardWidth);
  const height = Number(value.boardHeight);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 208 || height > 208) {
    return null;
  }
  const rawMatrix = Array.isArray(value.matrix) ? value.matrix : [];
  const matrix = Array.from({ length: height }, (_, y) => {
    const rawRow = Array.isArray(rawMatrix[y]) ? rawMatrix[y] : [];
    return Array.from({ length: width }, (_, x) => {
      const code = rawRow[x];
      return typeof code === "string" && validCodes.has(code) ? code : null;
    });
  });
  return {
    id: typeof value.id === "string" && value.id.startsWith("draft-") ? value.id : `draft-restored-${index}-${Date.now()}`,
    fileName: typeof value.fileName === "string" ? value.fileName : `本机草稿 ${index + 1}`,
    boardWidth: width,
    boardHeight: height,
    matrix,
    colorCounts: countMatrixColors(matrix),
    settings: value.settings
  };
}

// 草稿的可 JSON 序列化表示：只保留反序列化所需的字段，colorCounts 在读取时重算。
export function serializeDraft(design: BeadDesign): unknown {
  return {
    id: design.id,
    fileName: design.fileName,
    boardWidth: design.boardWidth,
    boardHeight: design.boardHeight,
    matrix: design.matrix,
    settings: design.settings
  };
}

export function loadDesignDrafts(validCodes: ReadonlySet<string>): BeadDesign[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(DRAFTS_STORAGE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, MAX_LOCAL_DRAFTS).map((candidate, index) =>
      deserializeDraft(candidate, index, validCodes)
    ).filter((draft): draft is BeadDesign => Boolean(draft));
  } catch {
    return [];
  }
}

export function persistDesignDrafts(drafts: BeadDesign[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify(drafts.slice(0, MAX_LOCAL_DRAFTS)));
  } catch {
    // 隐私模式或存储空间不足时不阻断编辑。
  }
}
