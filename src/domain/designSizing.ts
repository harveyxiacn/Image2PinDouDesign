import { estimatePixelArtScale, isLikelyPixelArt, resolveSmartGridSize } from "./conversion";
import { autoFramePixelSource } from "./crop";
import type { PixelSource } from "./types";

export type DesignSizeOption = {
  id: string;
  label: string;
  width: number;
  height: number;
  description: string;
};

export function getDesignSizeOptions(source: PixelSource, autoFrame = true, ignoreWhiteBg = true): DesignSizeOption[] {
  const framed = autoFrame ? autoFramePixelSource(source, { ignoreWhiteBg }) : source;
  const pixelArt = isLikelyPixelArt(framed);
  const scale = pixelArt ? estimatePixelArtScale(framed) ?? 1 : 1;
  const width = Math.max(1, Math.round(framed.width / scale));
  const height = Math.max(1, Math.round(framed.height / scale));
  const options: DesignSizeOption[] = [];
  const add = (id: string, label: string, limit: number, description: string) => {
    const shrink = Math.min(1, limit / width, limit / height);
    const w = Math.max(1, Math.round(width * shrink));
    const h = Math.max(1, Math.round(height * shrink));
    if (!options.some((option) => option.width === w && option.height === h)) {
      options.push({ id, label, width: w, height: h, description });
    }
  };
  if (pixelArt) add("native", "原始像素", 208, "还原已有像素格；放大尺寸不会增加原图细节");
  add("compact", "简洁", 40, "用豆较少，适合头像、小挂件");
  add("balanced", "标准", 72, "兼顾轮廓、细节与制作量");
  add("detailed", "精细", 104, "保留眼睛、装甲与衣饰层次");
  if (!pixelArt) add("large", "超精细", 156, "适合复杂全身角色，制作量较大");
  return options;
}

export function getSmartSizeDescription(source: PixelSource, autoFrame: boolean, ignoreWhiteBg: boolean): string {
  const framed = autoFrame ? autoFramePixelSource(source, { ignoreWhiteBg }) : source;
  const size = resolveSmartGridSize(framed, { boardWidth: 156, boardHeight: 156, smartSize: true });
  return `${isLikelyPixelArt(framed) ? "像素画还原" : "按图片比例生成"} ${size.width} × ${size.height}；可选择上方尺寸方案。`;
}
