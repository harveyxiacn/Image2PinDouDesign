import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["pindou.svg"],
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
          }
        ]
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,woff2}"],
        // 抠图用的 onnxruntime + 24MB WASM 是按需懒加载，别塞进首屏预缓存；
        // 用到时再下载，并交给浏览器/Cloudflare 缓存。
        globIgnores: ["**/ort*", "**/*.wasm"],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        cleanupOutdatedCaches: true
      }
    })
  ],
  test: {
    environment: "node",
    globals: true
  }
});
