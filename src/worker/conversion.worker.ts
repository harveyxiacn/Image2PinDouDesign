/// <reference lib="webworker" />
import { convertPixelSourceToDesign } from "../domain/conversion";
import { MARD_PALETTE } from "../domain/palette";
import type { BeadDesign, ConversionSettings, PixelSource } from "../domain/types";

export type ConversionRequest = {
  generation: number;
  id: string;
  fileName: string;
  source: PixelSource;
  settings: ConversionSettings;
};

// 转换进度消息：转换是同步执行的大块计算，worker 在可观察的阶段边界上报百分比。
// 新字段全部放在 type 后面，不影响旧的 design/error 消息解析。
export type ConversionProgress = {
  type: "progress";
  generation: number;
  id: string;
  phase: "prepare" | "done";
  percent: number;
};

// 取消控制消息：只登记，不回复。正在执行的同步转换无法中途打断，
// 但排在它后面的同代请求会被跳过，避免继续无意义地占用 CPU。
export type ConversionCancel = {
  type: "cancel";
  generation: number;
  id: string;
};

// 被跳过的任务发出的终结消息：App 用它收尾计数（每个请求恰好一个终结消息）。
export type ConversionSkipped = {
  type: "cancelled";
  generation: number;
  id: string;
};

export type ConversionResponse =
  | { generation: number; id: string; design: BeadDesign }
  | { generation: number; id: string; error: string }
  | ConversionProgress
  | ConversionSkipped;

// 按代次记录被取消的任务 id（代次隔离，避免旧代次的取消误伤新代次重新转换）。
const cancelledByGeneration = new Map<number, Set<string>>();

function post(message: ConversionResponse): void {
  (self as unknown as Worker).postMessage(message);
}

self.addEventListener("message", (event: MessageEvent<ConversionRequest | ConversionCancel>) => {
  const data = event.data;

  // 取消控制消息：登记 id，不回复。
  if ("type" in data) {
    if (data.type === "cancel") {
      const cancelled = cancelledByGeneration.get(data.generation) ?? new Set<string>();
      cancelled.add(data.id);
      cancelledByGeneration.set(data.generation, cancelled);
    }
    return;
  }

  const { generation, id, fileName, source, settings } = data;
  const cancelled = cancelledByGeneration.get(generation);
  if (cancelled?.has(id)) {
    cancelled.delete(id);
    post({ type: "cancelled", generation, id });
    return;
  }

  try {
    post({ type: "progress", generation, id, phase: "prepare", percent: 0 });
    const design = convertPixelSourceToDesign(source, fileName, settings, MARD_PALETTE);
    design.id = id;
    post({ type: "progress", generation, id, phase: "done", percent: 100 });
    post({ generation, id, design });
  } catch (caught) {
    const response: ConversionResponse = {
      generation,
      id,
      error: caught instanceof Error ? caught.message : "转换失败"
    };
    post(response);
  }
});
