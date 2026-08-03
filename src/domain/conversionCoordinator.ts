import type { BeadDesign } from "./types";
import type { ConversionResponse } from "../worker/conversion.worker";

// 每个转换任务在 UI 上的进度（App 主列的“正在生成图纸…”区域）。
export type ConversionTaskProgress = {
  fileName: string;
  percent: number;
  phase: string;
};

export type ConversionCoordinatorState = {
  generation: number;
  images: Array<{ id: string; fileName: string }>;
  progress: Record<string, ConversionTaskProgress>;
  results: Record<string, BeadDesign>;
  pending: number;
  cancelled: Set<string>;
  error: string | null;
  done: boolean;
  // 内部记账：已经收到终结消息（cancelled/design/error）的任务 id，
  // 防止同一 id 的重复终结消息把 pending 减穿（pending 最低 0）。
  finalized: Set<string>;
};

export function createConversionCoordinator(
  generation: number,
  images: Array<{ id: string; fileName: string }>
): ConversionCoordinatorState {
  const progress: Record<string, ConversionTaskProgress> = {};
  for (const image of images) {
    progress[image.id] = { fileName: image.fileName, percent: 0, phase: "prepare" };
  }
  return {
    generation,
    images,
    progress,
    results: {},
    pending: images.length,
    cancelled: new Set(),
    error: null,
    done: images.length === 0,
    finalized: new Set()
  };
}

// 纯函数：返回新状态，不修改入参。
export function applyConversionMessage(
  state: ConversionCoordinatorState,
  message: ConversionResponse
): ConversionCoordinatorState {
  // 过期代次消息直接丢弃。
  if (message.generation !== state.generation) {
    return state;
  }

  // 终结消息（cancelled/design/error）的公共收尾：每个 id 只收尾一次，
  // 移除 progress、pending-1（最低 0），pending 归 0 时置 done。
  const finalize = (next: ConversionCoordinatorState, id: string): ConversionCoordinatorState => {
    if (next.finalized.has(id)) {
      return next;
    }
    const finalized = new Set(next.finalized);
    finalized.add(id);
    const progress = { ...next.progress };
    delete progress[id];
    const pending = Math.max(0, next.pending - 1);
    return { ...next, finalized, progress, pending, done: pending === 0 ? true : next.done };
  };

  if ("type" in message) {
    if (message.type === "progress") {
      // 已取消的任务忽略后续进度消息。
      if (state.cancelled.has(message.id)) {
        return state;
      }
      return {
        ...state,
        progress: {
          ...state.progress,
          [message.id]: {
            fileName: state.progress[message.id]?.fileName
              ?? state.images.find((image) => image.id === message.id)?.fileName
              ?? "",
            percent: message.percent,
            phase: message.phase
          }
        }
      };
    }
    // type: "cancelled"（worker 侧被跳过的任务发出的终结消息）。
    return finalize(state, message.id);
  }

  if ("design" in message) {
    if (state.cancelled.has(message.id)) {
      // 用户已取消该任务：结果即使到达也直接丢弃，只收尾计数。
      const cancelled = new Set(state.cancelled);
      cancelled.delete(message.id);
      return finalize({ ...state, cancelled }, message.id);
    }
    return finalize(
      { ...state, results: { ...state.results, [message.id]: message.design } },
      message.id
    );
  }

  // 错误消息：记录 error 并收尾。
  return finalize({ ...state, error: message.error }, message.id);
}

// 用户取消：把 id 加入 cancelled（重复取消幂等），并立刻从 progress 移除该任务，
// 与 App 原有“取消后任务立刻从 UI 进度列表消失”的行为保持一致。
export function cancelConversionTask(
  state: ConversionCoordinatorState,
  id: string
): ConversionCoordinatorState {
  if (state.cancelled.has(id) && !(id in state.progress)) {
    return state;
  }
  const cancelled = new Set(state.cancelled);
  cancelled.add(id);
  const progress = { ...state.progress };
  delete progress[id];
  return { ...state, cancelled, progress };
}
