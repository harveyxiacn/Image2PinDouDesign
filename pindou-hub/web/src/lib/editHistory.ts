// 拼豆图编辑的撤销 / 重做栈（纯函数）。快照共享未改动的行，100 步也很省内存。
import type { Matrix } from "./matrix";
import type { Counts } from "./model";

export type EditSnapshot = { matrix: Matrix; counts: Counts };
export type EditState = EditSnapshot & { past: EditSnapshot[]; future: EditSnapshot[] };
export const MAX_EDIT_HISTORY = 100;

export const initEdit = (s: EditSnapshot): EditState => ({ matrix: s.matrix, counts: s.counts, past: [], future: [] });

/** 提交一次改动；矩阵和用量引用都没变时原样返回。 */
export function commitEdit(st: EditState, next: EditSnapshot): EditState {
  if (next.matrix === st.matrix && next.counts === st.counts) return st;
  return {
    matrix: next.matrix, counts: next.counts,
    past: [...st.past.slice(-(MAX_EDIT_HISTORY - 1)), { matrix: st.matrix, counts: st.counts }],
    future: []
  };
}

export function undoEdit(st: EditState): EditState {
  const prev = st.past[st.past.length - 1];
  if (!prev) return st;
  return {
    matrix: prev.matrix, counts: prev.counts,
    past: st.past.slice(0, -1),
    future: [{ matrix: st.matrix, counts: st.counts }, ...st.future].slice(0, MAX_EDIT_HISTORY)
  };
}

export function redoEdit(st: EditState): EditState {
  const next = st.future[0];
  if (!next) return st;
  return {
    matrix: next.matrix, counts: next.counts,
    past: [...st.past.slice(-(MAX_EDIT_HISTORY - 1)), { matrix: st.matrix, counts: st.counts }],
    future: st.future.slice(1)
  };
}
