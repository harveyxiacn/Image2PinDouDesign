import type { Lab, Rgb } from "./types";

const WHITE_POINT = {
  x: 95.047,
  y: 100,
  z: 108.883
};

export function hexToRgb(hex: string): Rgb {
  const normalized = hex.trim().replace(/^#/, "");
  const expanded = normalized.length === 3
    ? normalized.split("").map((part) => part + part).join("")
    : normalized;

  if (!/^[0-9a-fA-F]{6}$/.test(expanded)) {
    throw new Error(`Invalid hex color: ${hex}`);
  }

  return {
    r: Number.parseInt(expanded.slice(0, 2), 16),
    g: Number.parseInt(expanded.slice(2, 4), 16),
    b: Number.parseInt(expanded.slice(4, 6), 16)
  };
}

export function normalizeHex(hex: string): string {
  const rgb = hexToRgb(hex);
  return rgbToHex(rgb);
}

export function rgbToHex(rgb: Rgb): string {
  const part = (value: number) => Math.round(clamp(value, 0, 255))
    .toString(16)
    .padStart(2, "0");

  return `#${part(rgb.r)}${part(rgb.g)}${part(rgb.b)}`;
}

export function rgbToLab(rgb: Rgb): Lab {
  const r = pivotRgb(rgb.r / 255);
  const g = pivotRgb(rgb.g / 255);
  const b = pivotRgb(rgb.b / 255);

  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) * 100;
  const y = (r * 0.2126 + g * 0.7152 + b * 0.0722) * 100;
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) * 100;

  const fx = pivotXyz(x / WHITE_POINT.x);
  const fy = pivotXyz(y / WHITE_POINT.y);
  const fz = pivotXyz(z / WHITE_POINT.z);

  return {
    l: 116 * fy - 16,
    a: 500 * (fx - fy),
    b: 200 * (fy - fz)
  };
}

// 快速但粗糙的 ΔE*76（Lab 欧氏距离平方）。仅用于"哪些色更常用"这类
// 不要求感知精度、却要在全色卡上跑很多次的粗筛场景。
export function labDistanceSquared(left: Lab, right: Lab): number {
  const dl = left.l - right.l;
  const da = left.a - right.a;
  const db = left.b - right.b;
  return dl * dl + da * da + db * db;
}

// CIEDE2000 色差（kL=kC=kH=1）。ΔE*76 在蓝色与高饱和区域偏差明显，
// CIEDE2000 更贴近人眼，用于最终把像素映射到拼豆色号这一步。
// 公式与符号遵循 Sharma, Wu & Dalal (2005) 的实现参考。
export function ciede2000(reference: Lab, sample: Lab): number {
  const kL = 1;
  const kC = 1;
  const kH = 1;
  const deg = Math.PI / 180;

  const c1 = Math.hypot(reference.a, reference.b);
  const c2 = Math.hypot(sample.a, sample.b);
  const cBar = (c1 + c2) / 2;
  const cBar7 = Math.pow(cBar, 7);
  const g = 0.5 * (1 - Math.sqrt(cBar7 / (cBar7 + POW_25_7)));

  const a1p = (1 + g) * reference.a;
  const a2p = (1 + g) * sample.a;
  const c1p = Math.hypot(a1p, reference.b);
  const c2p = Math.hypot(a2p, sample.b);

  const h1p = hueAngle(reference.b, a1p);
  const h2p = hueAngle(sample.b, a2p);

  const dLp = sample.l - reference.l;
  const dCp = c2p - c1p;

  let dhp: number;
  if (c1p * c2p === 0) {
    dhp = 0;
  } else if (Math.abs(h2p - h1p) <= 180) {
    dhp = h2p - h1p;
  } else if (h2p - h1p > 180) {
    dhp = h2p - h1p - 360;
  } else {
    dhp = h2p - h1p + 360;
  }
  const dHp = 2 * Math.sqrt(c1p * c2p) * Math.sin((dhp * deg) / 2);

  const lBarp = (reference.l + sample.l) / 2;
  const cBarp = (c1p + c2p) / 2;

  let hBarp: number;
  if (c1p * c2p === 0) {
    hBarp = h1p + h2p;
  } else if (Math.abs(h1p - h2p) <= 180) {
    hBarp = (h1p + h2p) / 2;
  } else if (h1p + h2p < 360) {
    hBarp = (h1p + h2p + 360) / 2;
  } else {
    hBarp = (h1p + h2p - 360) / 2;
  }

  const t = 1
    - 0.17 * Math.cos((hBarp - 30) * deg)
    + 0.24 * Math.cos((2 * hBarp) * deg)
    + 0.32 * Math.cos((3 * hBarp + 6) * deg)
    - 0.20 * Math.cos((4 * hBarp - 63) * deg);

  const dTheta = 30 * Math.exp(-Math.pow((hBarp - 275) / 25, 2));
  const cBarp7 = Math.pow(cBarp, 7);
  const rC = 2 * Math.sqrt(cBarp7 / (cBarp7 + POW_25_7));
  const sL = 1 + (0.015 * Math.pow(lBarp - 50, 2)) / Math.sqrt(20 + Math.pow(lBarp - 50, 2));
  const sC = 1 + 0.045 * cBarp;
  const sH = 1 + 0.015 * cBarp * t;
  const rT = -Math.sin(2 * dTheta * deg) * rC;

  const lTerm = dLp / (kL * sL);
  const cTerm = dCp / (kC * sC);
  const hTerm = dHp / (kH * sH);

  return Math.sqrt(lTerm * lTerm + cTerm * cTerm + hTerm * hTerm + rT * cTerm * hTerm);
}

const POW_25_7 = Math.pow(25, 7);

function hueAngle(b: number, ap: number): number {
  if (b === 0 && ap === 0) {
    return 0;
  }
  const angle = Math.atan2(b, ap) * (180 / Math.PI);
  return angle < 0 ? angle + 360 : angle;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function pivotRgb(value: number): number {
  return value > 0.04045
    ? Math.pow((value + 0.055) / 1.055, 2.4)
    : value / 12.92;
}

function pivotXyz(value: number): number {
  return value > 0.008856
    ? Math.cbrt(value)
    : (7.787 * value) + (16 / 116);
}
