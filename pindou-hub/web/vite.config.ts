import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const webRoot = path.dirname(fileURLToPath(import.meta.url));
// 复用上级项目（拼豆图纸工坊）的转换引擎：像素化、CIEDE2000 配色、MARD 色卡、出图。
const engineRoot = path.resolve(webRoot, "../../src/domain");

export default defineConfig({
  root: webRoot,
  // 相对路径：同一份构建既能由 Hub 托管，也能打包进 Android App（Capacitor）。
  base: "./",
  plugins: [react()],
  resolve: { alias: { "@engine": engineRoot } },
  server: {
    host: "0.0.0.0",
    port: 5174,
    fs: { allow: [path.resolve(webRoot, ".."), path.resolve(webRoot, "../../src")] },
    proxy: { "/api": "http://127.0.0.1:8787" }
  },
  build: {
    outDir: path.resolve(webRoot, "../dist"),
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200
  },
  worker: { format: "es" },
  test: {
    root: webRoot,
    environment: "node",
    include: ["src/**/*.test.ts"]
  }
});
