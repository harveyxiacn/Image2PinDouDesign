// 本地抠图模型（public/bg-model/，由 scripts/copy-bg-assets.mjs 在安装时准备）的探测与地址解析。
// 纯函数部分可单测；探测结果在会话内缓存，且探测只访问本站同源地址，不产生第三方请求。

export const LOCAL_MODEL_DIR = "bg-model/";
export const LOCAL_MODEL_MANIFEST = "manifest.json";

// 本站地址 + Vite base + bg-model/；保证以 / 结尾（库用 new URL(name, publicPath) 拼接）。
export function resolveLocalPublicPath(pageHref: string, baseUrl: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(`${base}${LOCAL_MODEL_DIR}`, pageHref).href;
}

// 清单必须是脚本写出的格式；开发服务器在文件缺失时会返回 index.html，不能把它误当成“已就绪”。
export function isLocalModelManifest(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const manifest = value as { format?: unknown; model?: unknown; files?: unknown };
  return (
    manifest.format === 1 &&
    manifest.model === "isnet_fp16" &&
    Array.isArray(manifest.files) &&
    manifest.files.some((file) => (file as { name?: unknown } | null)?.name === "resources.json")
  );
}

let cached: Promise<string | null> | null = null;
let known: boolean | null = null;

// 本地资源已确认存在时返回其 publicPath，否则 null（沿用库默认地址）。成功与否都缓存到页面刷新。
export function probeLocalModel(
  fetcher: typeof fetch = fetch,
  pageHref: string = typeof location === "undefined" ? "http://localhost/" : location.href,
  baseUrl: string = import.meta.env.BASE_URL
): Promise<string | null> {
  cached ??= (async () => {
    try {
      const publicPath = resolveLocalPublicPath(pageHref, baseUrl);
      const response = await fetcher(new URL(LOCAL_MODEL_MANIFEST, publicPath).href, { cache: "no-cache" });
      if (!response.ok) return null;
      return isLocalModelManifest(await response.json()) ? publicPath : null;
    } catch {
      return null;
    }
  })().then((result) => {
    known = result !== null;
    return result;
  });
  return cached;
}

// 同步读取：探测完成前为 null（界面据此选择措辞）。
export function localModelKnown(): boolean | null {
  return known;
}

export function resetLocalModelProbe(): void {
  cached = null;
  known = null;
}
