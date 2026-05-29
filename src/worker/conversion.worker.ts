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

export type ConversionResponse =
  | { generation: number; id: string; design: BeadDesign }
  | { generation: number; id: string; error: string };

self.addEventListener("message", (event: MessageEvent<ConversionRequest>) => {
  const { generation, id, fileName, source, settings } = event.data;
  try {
    const design = convertPixelSourceToDesign(source, fileName, settings, MARD_PALETTE);
    design.id = id;
    const response: ConversionResponse = { generation, id, design };
    (self as unknown as Worker).postMessage(response);
  } catch (caught) {
    const response: ConversionResponse = {
      generation,
      id,
      error: caught instanceof Error ? caught.message : "转换失败"
    };
    (self as unknown as Worker).postMessage(response);
  }
});
