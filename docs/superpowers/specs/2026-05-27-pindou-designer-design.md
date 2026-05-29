# 拼豆设计图生成网站设计

## 目标

按 `design.md` 的产品方向实现一个可部署的 MVP 网站：用户在浏览器上传一张或多张图片，选择 52 针、104 针或自定义尺寸，前端将图片转换为 MARD 拼豆图纸，并统计单图和项目总用豆数量。

## 最佳方案

采用 Vite + React + TypeScript 的纯前端静态站点。图片处理在浏览器 Canvas 中完成，不需要后端上传图片，部署简单，适合直接发布到 VPS 的 Nginx 静态目录。

## 模块边界

- `src/domain/types.ts`：统一类型定义。
- `src/domain/boards.ts`：拼豆板预设与尺寸解析。
- `src/domain/palette.ts`：MARD 色卡数据与颜色预处理。
- `src/domain/color.ts`：HEX/RGB/Lab 转换与颜色距离。
- `src/domain/conversion.ts`：图片像素化、近色匹配、数量统计、项目汇总。
- `src/domain/exporters.ts`：CSV 与 PNG 导出辅助。
- `src/components/*`：上传、设置、图纸预览、统计、色卡 UI。
- `src/App.tsx`：页面组合与状态编排。

## 功能范围

MVP 包含：

1. 多图拖拽/选择上传。
2. 52x52、104x104、52x104、自定义尺寸。
3. 最大颜色数限制：8、16、24、32、48、全部。
4. 透明像素可跳过。
5. 最近色匹配到 MARD 色卡。
6. 图纸预览：网格、分板线、色号标签。
7. 单图颜色数量统计和项目总统计。
8. 导出：单图 PNG、单图 CSV、项目 CSV。

不在本次实现范围：

- 登录、云端保存、社区分享、库存管理。
- 后端任务队列。
- PDF/Excel 真实文件生成；本次用 CSV 覆盖采购清单。

## 部署

构建产物 `dist/` 通过 `scp` 上传到 `root@136.175.83.102:/var/www/image2pindou/`。远端 Nginx 配置监听 80 端口并回退到 `index.html`。

## 验证

- Vitest 覆盖核心算法：颜色解析、最近色匹配、数量统计、项目汇总、CSV 导出。
- `npm run build` 验证 TypeScript 与 Vite 构建。
- 部署后用 `curl http://136.175.83.102/` 验证页面可访问。
