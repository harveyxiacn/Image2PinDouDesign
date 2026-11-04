// 库存写入动作：生成流水、写库、给出“撤销”提示。
import { getSnapshot, putRecords, softDelete } from "../../lib/db";
import type { Txn } from "../../lib/model";
import { fmt, toast } from "../ui";
import { purchaseTxns, type ParsedRow } from "../../lib/stockview";

export function deviceId(): string {
  return getSnapshot().device.deviceId;
}

export async function addTxns(txns: Txn[], message: string): Promise<void> {
  if (!txns.length) return;
  await putRecords("txns", txns);
  const ids = txns.map((t) => t.id);
  toast(message, { label: "撤销", run: () => { void softDelete("txns", ids); } });
}

export async function commitPurchase(rows: ParsedRow[], opts: { note?: string; totalPrice?: number }): Promise<number> {
  const txns = purchaseTxns(rows, { device: deviceId(), note: opts.note, totalPrice: opts.totalPrice });
  const beads = txns.reduce((a, t) => a + t.delta, 0);
  await addTxns(txns, `已入库 ${txns.length} 色 ${fmt(beads)} 颗`);
  return txns.length;
}
