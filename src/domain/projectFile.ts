import { deserializeDraft, serializeDraft } from "./drafts";
import { csvCell } from "./exporters";
import type { BeadDesign, PaletteColor } from "./types";

// 图纸文件：把图纸导出成一个 JSON 文件，换设备 / 清缓存后再导入，不需要服务器。
// 只保存色号矩阵和生成设置，不含原图（体积小，也不外传照片）。
export const PROJECT_FILE_FORMAT = "image2pindou-designs";
export const PROJECT_FILE_VERSION = 1;
export const PROJECT_FILE_EXTENSION = ".pindou.json";
// 单个文件最多导入的图纸数，防止误选超大文件拖垮页面。
export const MAX_IMPORT_DESIGNS = 50;

type ProjectFile = {
  format: typeof PROJECT_FILE_FORMAT;
  version: number;
  exportedAt: string;
  designs: unknown[];
};

export function buildProjectFile(designs: BeadDesign[], now = new Date()): string {
  const file: ProjectFile = {
    format: PROJECT_FILE_FORMAT,
    version: PROJECT_FILE_VERSION,
    exportedAt: now.toISOString(),
    designs: designs.map((design) => serializeDraft(design))
  };
  return JSON.stringify(file);
}

export type ImportedDesigns = { designs: BeadDesign[]; skipped: number };

/** 解析图纸文件；格式不对时抛出可直接展示给用户的中文错误。 */
export function parseProjectFile(text: string, validCodes: ReadonlySet<string>): ImportedDesigns {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("这不是有效的图纸文件（无法解析 JSON）。");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("这不是有效的图纸文件。");
  }
  const file = parsed as Partial<ProjectFile>;
  if (file.format !== PROJECT_FILE_FORMAT || !Array.isArray(file.designs)) {
    throw new Error("这不是本站导出的图纸文件。");
  }
  if (typeof file.version === "number" && file.version > PROJECT_FILE_VERSION) {
    throw new Error("这个图纸文件来自更新的版本，请先刷新网站到最新版本。");
  }
  const candidates = file.designs.slice(0, MAX_IMPORT_DESIGNS);
  const stamp = Date.now().toString(36);
  const designs: BeadDesign[] = [];
  candidates.forEach((candidate, index) => {
    const design = deserializeDraft(candidate, index, validCodes);
    if (!design) return;
    // 导入的图纸一律换新 id，避免与本机已有草稿冲突。
    designs.push({ ...design, id: `draft-import-${stamp}-${index}-${Math.random().toString(36).slice(2, 6)}` });
  });
  return { designs, skipped: file.designs.length - designs.length };
}

// ---- 库存 CSV ----

const INVENTORY_HEADER = ["色号", "颜色", "HEX", "颗数"];

export function inventoryToCsv(owned: Record<string, number>, palette: PaletteColor[]): string {
  const rows = palette
    .filter((color) => (owned[color.code] ?? 0) > 0)
    .map((color) => [color.code, color.nameZh, color.hex, String(owned[color.code])].map(csvCell).join(","));
  // 带 BOM，Excel 直接打开不乱码。
  return `﻿${INVENTORY_HEADER.join(",")}\n${rows.join("\n")}\n`;
}

/**
 * 读取库存 CSV（本站导出的，或自己在表格里整理的）：每行第一列是色号，
 * 最后一个纯数字列是颗数；表头、空行和不认识的色号忽略。
 */
export function parseInventoryCsv(text: string, validCodes: ReadonlySet<string>): { owned: Record<string, number>; unknown: string[] } {
  const owned: Record<string, number> = {};
  const unknown: string[] = [];
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    const cells = splitCsvLine(line).map((cell) => cell.trim());
    const code = (cells[0] ?? "").toUpperCase();
    if (!code || code === "色号" || code === "CODE") continue;
    const countCell = [...cells.slice(1)].reverse().find((cell) => /^\d+$/.test(cell));
    if (!validCodes.has(code)) {
      unknown.push(code);
      continue;
    }
    if (countCell === undefined) continue;
    owned[code] = Math.min(99999, Number(countCell));
  }
  return { owned, unknown };
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === "\"" && line[index + 1] === "\"") {
        current += "\"";
        index += 1;
      } else if (char === "\"") {
        quoted = false;
      } else {
        current += char;
      }
    } else if (char === "\"") {
      quoted = true;
    } else if (char === "," || char === "\t" || char === "，") {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}
