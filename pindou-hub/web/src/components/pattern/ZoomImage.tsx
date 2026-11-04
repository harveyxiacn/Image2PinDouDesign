import { useState } from "react";
import ZoomPan from "./ZoomPan";

/** 一张可缩放的普通图片：自动读取自然宽度，放大上限据此计算（最高能把 1 个图像像素放大到约 24 屏幕像素）。 */
export default function ZoomImage({ src, alt, label }: { src: string; alt: string; label?: string }) {
  const [natW, setNatW] = useState<number | undefined>();
  return (
    <ZoomPan label={label ?? alt} natW={natW} thumb={src}>
      <img src={src} alt={alt} draggable={false} onLoad={(e) => setNatW(e.currentTarget.naturalWidth || undefined)} />
    </ZoomPan>
  );
}
