import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["pindou.svg", "pindou-192.png", "pindou-512.png"],
      manifest: {
        name: "拼豆图纸工坊",
        short_name: "拼豆图纸",
        description: "上传图片，一键生成拼豆设计图和 MARD 色卡用豆统计。",
        lang: "zh-CN",
        theme_color: "#0f172a",
        background_color: "#f8fafc",
        display: "standalone",
        start_url: "/",
        icons: [
          {
            src: "pindou.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any maskable"
          },
          {
            src: "pindou-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any"
          },
          {
            src: "pindou-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any"
          },
          {
            src: "pindou-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable"
          }
        ]
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
        // 抠图用的 onnxruntime + 24MB WASM 是按需懒加载，别塞进首屏预缓存；
        // 用到时再下载，并交给浏览器/Cloudflare 缓存。
        globIgnores: ["**/ort*", "**/*.wasm"],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        cleanupOutdatedCaches: true
      }
    })
  ],
  build: {
    rollupOptions: {
      output: {
        // ONNX runtime 的 .mjs 内容可能跨版本不变；加语义后缀可避免旧站点曾以错误
        // MIME 缓存过同一 URL 时继续命中，同时仍保留 Rollup 的内容哈希。
        assetFileNames: (assetInfo) => assetInfo.name?.endsWith(".mjs")
          ? "assets/[name]-[hash]-module[extname]"
          : "assets/[name]-[hash][extname]"
      }
    }
  },
  test: {
    environment: "node",
    globals: true,
    pool: "forks"
  }
});
