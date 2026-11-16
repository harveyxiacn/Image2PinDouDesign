import { parseInventoryCsv } from "./projectFile";
import type { OwnedInventory } from "./shortfall";

export type HubInventoryImport = {
  /** 替换后的库存（已开启“只用我手头有的颜色”）；文件里没有可识别的库存时为 null，调用方不应改动现有库存。 */
  inventory: OwnedInventory | null;
  colors: number;
  beads: number;
  unknown: number;
  /** 给用户看的一句话。 */
  message: string;
};

/**
 * 读取拼豆仓导出的库存 CSV 并“替换”已登记库存（和通用的“导入库存 CSV”不同，那个是合并）：
 * 文件里没有的色号视为没有，颗数为 0 的不登记；同时开启“只用我手头有的颜色”，之后的图纸就按这些颜色生成。
 * 纯函数，不碰存储。
 */
export function replaceInventoryFromHub(csvText: string, validCodes: ReadonlySet<string>): HubInventoryImport {
  const { owned: parsed, unknown } = parseInventoryCsv(csvText, validCodes);
  const owned: Record<string, number> = {};
  for (const [code, count] of Object.entries(parsed)) if (count > 0) owned[code] = count;
  const colors = Object.keys(owned).length;
  const beads = Object.values(owned).reduce((sum, n) => sum + n, 0);
  if (colors === 0) {
    return { inventory: null, colors: 0, beads: 0, unknown: unknown.length, message: "文件里没有找到库存颜色，没有改动现有库存。请在拼豆仓 → 库存 → 导出库存 CSV 重新导出。" };
  }
  const ignored = unknown.length > 0 ? `（${unknown.length} 个无法识别的色号已忽略）` : "";
  return {
    inventory: { restrictEnabled: true, owned },
    colors, beads, unknown: unknown.length,
    message: `已从拼豆仓载入 ${colors} 种颜色、共 ${beads} 颗，替换了原来的库存${ignored}。现在生成的图纸只会使用这些颜色。`
  };
}
