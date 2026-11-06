# 拼豆仓（pindou-hub）

拼豆仓是给拼豆爱好者用的本地 + 局域网工具。它可以从图纸截图里识别每种色号需要多少颗，也可以把照片转成拼豆图纸，并管理豆盒库存、采购清单和图库。数据保存在你自己的电脑和手机上，在家里的局域网内同步，不需要账号，也不连公网。

## 功能

### 1. 识别图纸

上传一张拼豆图纸图片，「豆探」助手会按下面的顺序处理：

- 如果图纸上印有每种颜色的用量表（图例），就用离线 OCR 读出来。
- 如果没有用量表，就识别网格，把每个格子的颜色匹配到 MARD 色号，再统计数量。
- 两种信息都有时，会互相核对，并标出不一致的地方。

识别结束后你可以手动修正：框选图纸区域、修改行数和列数、编辑每个色号的数量，然后再保存。

可选的本地视觉模型（见下文「本地视觉模型（可选）」）可以再复核一遍。这不是必需的。

### 2. 生成图纸

上传一张照片，程序会把它像素化并生成拼豆图纸。你可以设置：

- 图纸尺寸（板子大小）
- 最多使用的颜色数
- 色号体系（豆盒套装）
- 「只用库存中有的颜色」
- 抖动（dither）和描边（outline）

生成的图纸可以保存到图库。

### 3. 手动录入

直接粘贴用量文本即可，例如：

```
A1 120, H7×300
```

### 4. 图库

图库包含图纸和本地图片库。每张图纸有四种状态：

| 状态 | 含义 |
| --- | --- |
| 收藏 | 只是先存着 |
| 计划拼 | 准备拼 |
| 制作中 | 正在做 |
| 已完成 | 做完了 |

每张图纸还可以设置「做几份」（copies）。把状态改为「已完成」会从库存里扣掉用量，这一步可以撤销。

### 5. 豆盒库存

库存按色号分格显示，像一排排的豆盒。每个色号的库存是一本流水账，支持三种操作：

- 入库（买回来的豆）
- 消耗（做图纸用掉的豆）
- 盘点（按实际数量校正）

你还可以给每个色号设置最低库存，也可以批量入库，或者从一个套装初始化库存。

### 6. 采购清单

采购清单根据「计划拼」的图纸计算还需要买多少颗：

> 需求 = 计划图纸的用量 × 份数 × (1 + 损耗率) − 库存

结果会向上取整到包装规格。默认值是：每包 1000 颗，损耗率 5%，低库存线 200 颗。清单还包括需要补充的低库存色号。你可以复制文本或导出 CSV。

点「买回来了 → 入库」，清单就会生成对应的采购记录，直接进入库存。

### 7. 记录

「记录」页按天和批次列出所有历史操作，支持撤销和导出 CSV。

### 8. 同步与设置

同步与设置页可以配置局域网同步、修改偏好、导出和导入 JSON 备份，以及切换主题。

## 快速开始

### Windows 上运行 Hub

Hub 是运行在家里任意一台电脑上的小服务。局域网内的其他设备通过它同步数据。

最简单的方式：双击 `start-hub.cmd`。

- 第一次运行时会安装依赖并构建网页界面。
- 之后再次运行会直接启动服务。

也可以手动执行：

```
npm install
npm run build
npm start
```

环境要求：**Node.js 22.13 或更新版本**（开发时在 Node 24 上测试过）。

启动后，控制台会打印：

- 本机访问地址（`http://localhost:8787`）
- 局域网地址
- 6 位配对码

默认端口是 **8787**。可以用 `--port 端口号` 或环境变量 `PINDOU_PORT` 修改。服务监听 `0.0.0.0`。数据目录可以用 `--data 路径` 指定。

**防火墙**：Windows 第一次运行时可能会询问是否允许 Node.js 访问网络。请只允许「专用网络」（私有网络）。拼豆仓不会自己修改防火墙设置。

### 手机或其他电脑连接

- **浏览器**：在同一个 Wi-Fi 下，打开控制台显示的局域网地址，例如 `http://<hub-ip>:8787`。输入 6 位配对码即可连接。
- **Android 应用**：打开 App，进入「同步与设置」，填写 Hub 地址和 6 位配对码。

在运行 Hub 的这台电脑上打开页面时，会自动完成配对，不需要输入配对码。

### Android 安装

Android 版是用 Capacitor 8 打包的应用，应用 ID 是 `com.pindou.hub`。

安装包需要自己构建：

```
powershell -ExecutionPolicy Bypass -File scripts\build-android.ps1 [-SdkDir ...] [-JavaHome ...]
```

- 需要 Android SDK 和 JDK 21。Android Studio 自带的 jbr 可以直接使用。
- 脚本的默认 SDK 路径是 `ANDROID_HOME` / `ANDROID_SDK_ROOT`，否则是 `%LOCALAPPDATA%\Android\Sdk`。默认 JDK 路径是 `C:\Program Files\Android\Android Studio\jbr`。
- 输出文件是 `release\pindou-hub-debug.apk`。

这是**调试签名**的 APK，安装方式是侧载（sideload）。应用通过 http 访问局域网里的 Hub，网络安全配置允许明文传输。

## 识别是怎么工作的

这部分说明识别功能的实际能力，帮助你判断什么时候需要手动修正。

- 识别是**启发式**的，不是语义 AI。它依靠网格的周期性、颜色聚类和 OCR。
- **OCR** 使用离线的英文模型（已随应用打包，不需要联网）。它能读取色号和数字，但**会忽略中文文字**。
- 颜色匹配使用 CIEDE2000 色差公式，对应 MARD 色卡（291 个色号）。
- 以下情况可能需要手动修正：照片模糊、透视变形严重、水印很重，或者图纸的渲染颜色和 MARD 色差距较大。

## 数据与同步

- **每台设备各自保存数据**。网页版使用浏览器的 IndexedDB，Android 版使用 WebView 中的 IndexedDB。没有网络也能正常使用。
- **同步时由 Hub 合并**：
  - 图纸记录按 `updatedAt` 「后写者胜」。
  - 库存是只追加的流水账。两台设备同时增减同一个色号，两次变化都会计入。
  - 删除使用墓碑（tombstone）标记，不会直接抹掉记录。
  - 图片按 SHA-256 内容寻址，同步时按需传输。
- **Hub 的数据**保存在 `pindou-hub/data/` 目录下：
  - `hub.db`：SQLite 数据库（使用 Node 内置的 `node:sqlite`）
  - `blobs/`：图片原件
  - `config.json`：访问令牌和 6 位配对码
- **请定期备份整个 `data/` 目录。** 也可以在「同步与设置」里导出 JSON 备份。

## 本地视觉模型（可选）

这是一个可选功能，不装也能完整使用。

- Hub 可以把识别结果转发给运行在 Hub 电脑上的 **Ollama** 视觉模型，让它再复核一遍。
- 默认模型是 `qwen2.5vl:7b`，可以用环境变量 `PINDOU_VISION_MODEL` 修改。
- Ollama 地址默认是 `http://127.0.0.1:11434`，可以用 `PINDOU_OLLAMA_URL` 修改。
- 如果没有检测到 Ollama，或者没有安装模型，界面会提示原因。安装模型可以运行 `ollama pull qwen2.5vl:7b`。

## 安全须知

- 拼豆仓**只适合局域网使用**，没有账号系统。
- 任何知道配对码、且能连到你的 Wi-Fi 的人，都可以读写数据。
- **不要把 8787 端口暴露到互联网。**
- 配对码连续失败 5 次后，同一个 IP 会被限制 1 分钟。

## 开发者

### 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm install` | 安装依赖（会运行 postinstall，把 OCR 资源复制到 `web/public/ocr`） |
| `npm run dev` | 启动 Vite 开发服务器（端口 5174），`/api` 代理到 `127.0.0.1:8787` |
| `npm start` | 启动 Hub（开发时需要和 `npm run dev` 一起运行） |
| `npm run build` | 类型检查并构建网页界面到 `dist/` |
| `npm test` | 运行 vitest 测试（识别、库存、生成、库存辅助函数） |
| `npm run test:server` | 运行 node:test 测试（store 和 Hub 端到端） |
| `npm run android:sync` | 构建网页并同步到 Android 工程（`cap sync android`） |
| `npm run android:open` | 用 Android Studio 打开工程 |

### 目录结构

```
pindou-hub/
├── server/
│   ├── hub.mjs          # HTTP 服务：静态页面、配对、同步、图片、视觉模型转发
│   └── store.mjs        # 数据存储
├── web/src/
│   ├── lib/             # model、db、sync、inventory、images、palette、generate
│   │   └── recognize/   # grid、legend、ocr、assistant
│   ├── pages/           # 各个页面
│   └── components/
├── scripts/
│   ├── copy-ocr-assets.mjs   # postinstall：复制 OCR worker、wasm 和 eng 模型
│   ├── build-android.ps1     # 构建 Android 调试版 APK
│   └── patch-android.mjs
├── start-hub.cmd
└── data/                # 运行时生成：hub.db、blobs/、config.json
```

### 与上级项目的关系

拼豆仓位于「拼豆图纸工坊」项目的 `pindou-hub/` 目录下，复用上级项目 `../src/domain` 中的引擎，包括像素化、CIEDE2000 颜色匹配、MARD 色卡（291 个色号）、套装（kit）和图表渲染。

### Hub 接口概览

- `GET /api/ping`：健康检查，不需要令牌。
- `POST /api/pair`：用配对码换取令牌。
- `GET /api/local-token`：只允许 Hub 本机访问，返回令牌和配对码。
- `GET /api/info`、`POST /api/sync`、`PUT/GET /api/blobs/:sha256`、`GET /api/export`、`GET /api/ai/status`、`POST /api/ai/vision`：需要令牌（请求头 `x-pindou-token`）。

## 已知限制

- **识别是启发式的**。模糊、透视变形、水印重，或颜色与 MARD 差距大的图纸，都可能需要手动修正。
- **OCR 只识别英文和数字**，中文文字会被忽略。
- **同一色号的两次同时盘点**：如果两台离线设备同时对同一色号做盘点，两次盘点的差值都会计入，合并后的库存可能与实际数量不一致。
- **Android 版是调试签名**（debug-signed），不是正式发布签名。
- 当前只支持局域网同步，没有账号和公网访问。
