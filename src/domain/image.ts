import type { PixelSource } from "./types";

export async function imageFileToPixelSource(file: File, maxDimension = 1200): Promise<PixelSource> {
  const url = URL.createObjectURL(file);
  try {
    const image = await loadImage(url);
    const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) {
      throw new Error("当前浏览器不支持 Canvas 2D。");
    }

    context.clearRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    const imageData = context.getImageData(0, 0, width, height);

    return {
      width,
      height,
      data: imageData.data
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片读取失败，请换一张图片重试。"));
    image.src = url;
  });
}

export function pixelSourceToCanvas(source: PixelSource): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("当前浏览器不支持 Canvas 2D。");
  }
  const imageData = context.createImageData(source.width, source.height);
  imageData.data.set(source.data);
  context.putImageData(imageData, 0, 0);
  return canvas;
}

export function pixelSourceToDataUrl(source: PixelSource): string {
  return pixelSourceToCanvas(source).toDataURL("image/png");
}

export function pixelSourceToBlob(source: PixelSource): Promise<Blob> {
  return new Promise((resolve, reject) => {
    pixelSourceToCanvas(source).toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("图片编码失败。"));
      }
    }, "image/png");
  });
}

export async function blobToPixelSource(blob: Blob): Promise<PixelSource> {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) {
      throw new Error("当前浏览器不支持 Canvas 2D。");
    }
    context.drawImage(bitmap, 0, 0);
    const imageData = context.getImageData(0, 0, bitmap.width, bitmap.height);
    return { width: bitmap.width, height: bitmap.height, data: imageData.data };
  } finally {
    bitmap.close();
  }
}
