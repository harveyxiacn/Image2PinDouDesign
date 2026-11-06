// 本地图库：图片按内容 SHA-256 存进 IndexedDB，元数据进 images 集合并同步到 Hub。
import type { PixelSource } from "@engine/types";
import { getSnapshot, putBlob, putRecords } from "./db";
import type { ImageMeta } from "./model";

const MAX_STORED_EDGE = 4096;
const MAX_STORED_BYTES = 6 * 1024 * 1024;

/** SHA-256 十六进制。局域网 http 页面不是安全上下文，crypto.subtle 不可用时走纯 JS 实现。 */
export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const digest = await crypto.subtle.digest("SHA-256", data);
    return toHex(new Uint8Array(digest));
  }
  return toHex(sha256Fallback(new Uint8Array(data)));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

export function sha256Fallback(msg: Uint8Array): Uint8Array {
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const len = msg.length;
  const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
  padded.set(msg);
  padded[len] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(len / 0x20000000), false);
  view.setUint32(padded.length - 4, (len << 3) >>> 0, false);
  const w = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15], b = w[i - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [A, B, C, D, E, F, G, H] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = ((E >>> 6) | (E << 26)) ^ ((E >>> 11) | (E << 21)) ^ ((E >>> 25) | (E << 7));
      const ch = (E & F) ^ (~E & G);
      const t1 = (H + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = ((A >>> 2) | (A << 30)) ^ ((A >>> 13) | (A << 19)) ^ ((A >>> 22) | (A << 10));
      const maj = (A & B) ^ (A & C) ^ (B & C);
      const t2 = (S0 + maj) >>> 0;
      H = G; G = F; F = E; E = (D + t1) >>> 0; D = C; C = B; B = A; A = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + A) >>> 0; h[1] = (h[1] + B) >>> 0; h[2] = (h[2] + C) >>> 0; h[3] = (h[3] + D) >>> 0;
    h[4] = (h[4] + E) >>> 0; h[5] = (h[5] + F) >>> 0; h[6] = (h[6] + G) >>> 0; h[7] = (h[7] + H) >>> 0;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  h.forEach((v, i) => ov.setUint32(i * 4, v, false));
  return out;
}

async function decode(blob: Blob): Promise<ImageBitmap> {
  return createImageBitmap(blob);
}

/** 过大的照片先缩到 4096 长边再存，图纸截图通常原样保存（保留格子细节）。 */
async function normalizeForStorage(blob: Blob): Promise<{ blob: Blob; width: number; height: number }> {
  const bitmap = await decode(blob);
  try {
    const { width, height } = bitmap;
    if (Math.max(width, height) <= MAX_STORED_EDGE && blob.size <= MAX_STORED_BYTES) return { blob, width, height };
    const scale = Math.min(1, MAX_STORED_EDGE / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const out = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("图片编码失败"))), "image/jpeg", 0.92));
    return { blob: out, width: canvas.width, height: canvas.height };
  } finally {
    bitmap.close();
  }
}

/** 和 saveImage 用同一套存储规格算出内容哈希，用来在识别前查重（不写入）。 */
export async function imageContentId(input: Blob): Promise<string> {
  const { blob } = await normalizeForStorage(input);
  return sha256Hex(await blob.arrayBuffer());
}

export async function saveImage(input: Blob, name: string, role: ImageMeta["role"]): Promise<ImageMeta> {
  const { blob, width, height } = role === "preview" ? { blob: input, ...(await dims(input)) } : await normalizeForStorage(input);
  const id = await sha256Hex(await blob.arrayBuffer());
  const existing = getSnapshot().images.find((img) => img.id === id);
  await putBlob(id, blob);
  if (existing) return existing;
  const now = Date.now();
  const meta: ImageMeta = { id, name, mime: blob.type || "image/png", width, height, bytes: blob.size, role, createdAt: now, updatedAt: now };
  await putRecords("images", [meta]);
  return meta;
}

async function dims(blob: Blob): Promise<{ width: number; height: number }> {
  const bitmap = await decode(blob);
  const out = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return out;
}

/** 解码成 RGBA 像素（识别 / 生成图纸用），长边不超过 maxDim。 */
export async function loadPixelSource(blob: Blob, maxDim = 2400): Promise<PixelSource> {
  const bitmap = await decode(blob);
  try {
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, width, height);
    const data = ctx.getImageData(0, 0, width, height).data;
    return { width, height, data };
  } finally {
    bitmap.close();
  }
}
