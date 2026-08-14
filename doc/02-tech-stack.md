# 02 · 技术栈清单

> 原则:**全栈只用 TypeScript 一门语言**,并尽量复用 harness 仓库里现成的 client 包。这样 AI 辅助时上下文最充足、类型最硬、幻觉最少。

## 0. 工程形态(第一个决策)

| 方案 | 说明 | 推荐 |
|---|---|---|
| **A. 放进 harness monorepo(`apps/pet`)** | 直接 `workspace:^` 引用 client 包,类型零漂移,协议升级跟着走 | ✅ **强烈推荐** |
| B. 独立仓库 | 需把 client 包发 npm 或用 path 依赖,升级同步自己管 | 仅当不想动本仓库 |

仓库 `workspaces` 已含 `apps/*`,新建 `apps/pet` 即可。

---

## 1. 语言 / 运行时

| 项 | 选型 | 说明 |
|---|---|---|
| 语言 | TypeScript(strict) | 全栈一门语言 |
| 运行时 | Node.js `^22.19.0`(或 `>=24`) | 与 harness `engines` 一致 |
| 模块 | ESM(`"type": "module"`) | 与仓库一致 |

## 2. 包管理 / 构建

| 项 | 选型 |
|---|---|
| 包管理 | pnpm `11.7.0`(workspaces) |
| Electron 三段构建 | electron-vite(底层 Vite,与仓库同源) |
| TS 运行脚本 | tsx |
| 库打包(如需发包) | tsdown(与仓库一致) |

## 3. 桌面壳层

| 项 | 选型 | 说明 |
|---|---|---|
| 壳 | Electron(最新 stable) | 主进程即 Node,可直接复用 DSH 的 TS 包 |
| 打包/分发 | electron-builder | Windows NSIS / portable |
| 自动更新 | electron-updater | 可选,后期 |
| 进程通信 | `ipcMain`/`ipcRenderer` + `contextBridge`(preload 白名单) | 安全边界 |

## 4. 前端 UI(renderer)

| 项 | 选型 | 理由 |
|---|---|---|
| UI 框架 | React 18/19 + TS | 与 DSH Web 客户端同栈 |
| 状态管理 | Zustand | 轻量少样板 |
| 样式 | Tailwind CSS v4 | 快速出 UI |
| UI 动效 | Framer Motion | 面板/气泡/过渡 |
| 设置面板组件 | shadcn/ui(Radix + Tailwind) | 可选 |

## 5. 角色渲染 / 动画(宠物核心表现)

| 档位 | 选型 | 说明 |
|---|---|---|
| 起步(推荐先做) | PixiJS v8 + 精灵/骨骼 + Lottie(`lottie-web`) | 免模型授权、素材多、完全可控 |
| 进阶 | Live2D Cubism(`pixi-live2d-display`) | 经典桌面宠物;需模型授权,注意与 PixiJS v8 兼容性(社区桥常锁 v7) |
| 备选 | Spine(`pixi-spine`) | 付费工具链 |
| 状态机 | XState | 定义 `idle/talking/thinking/working/error/awaiting-approval` 与迁移 |

## 6. DSH 集成层(★核心,复用仓库包)

| 包(精确导入路径) | 用途 |
|---|---|
| `@deepseek-ai/dsh-client-connection/client` | `ConnectionController`(重连/退避)、`IApiClient`、`WebApiClient`、全部帧/API 类型 |
| `@deepseek-ai/dsh-host-apiproxy/api`、`/client` | `AbstractApiClient`、schema、`ApiProxy`/`MuxFrame`/`HostFrame` 类型 |
| `@deepseek-ai/dsh-api-remotes/client` | 了解 `commands/goals/dynamic/pluginInventory/messageFeedback` 等 Remote 命名空间与转发事件(参考语义) |
| `ws`(^8.21) | 主进程(Node)自实现传输时用;renderer 用原生 `fetch`+`WebSocket` |

协议不新增:上行 `POST /api/<namespace>/<method>`,下行 `WS /api/events.mux` + `/api/events.host`,握手 `host.describe`。详见 [03-dsh-integration.md](./03-dsh-integration.md)。

## 7. MCP server(让 Agent 反驱动宠物)

| 项 | 选型 |
|---|---|
| SDK | `@modelcontextprotocol/sdk@^1.12.0`(`McpServer`) |
| 传输 | streamable HTTP(SSE)或 stdio(DSH `mcp-client` 两者都支持) |
| 工具示例 | `pet.speak`、`pet.setExpression`、`pet.playAnimation`、`pet.notify`、`pet.showBubble` |

## 8. 语音(可选,二期)

| 项 | 选型 |
|---|---|
| TTS | edge-tts(免费、中文好)或 Azure Speech;兜底 Web Speech API |
| ASR | faster-whisper / Whisper.cpp 或 Vosk;兜底 Web Speech API |

## 9. 本地存储 / 配置

| 项 | 选型 |
|---|---|
| 简单配置 | electron-store(JSON KV) |
| 结构化数据(会话缓存/日志) | better-sqlite3(同步、零部署)或 lowdb |

## 10. 测试 / 质量

| 项 | 选型 |
|---|---|
| 单测 | vitest(与仓库一致) |
| 组件测试 | @testing-library/react |
| E2E | Playwright(Electron driver),可选 |
| Lint | oxlint(与仓库一致)+ prettier |
| Git hooks | lefthook(仓库 postinstall 已装) |

## 11. 打包 / 分发(Windows)

| 项 | 选型 |
|---|---|
| 打包 | electron-builder(NSIS / portable) |
| 图标/托盘/通知/自启 | Electron 内置 + electron-builder 配置 |
| 代码签名 | 可选(个人项目先跳过) |

---

## MVP 最小集(第一版只装这些)

1. `apps/pet` + electron-vite + React + TS + Zustand + Tailwind
2. `@deepseek-ai/dsh-client-connection/client` + `@deepseek-ai/dsh-host-apiproxy`(连通性:describe 握手 + 一条 session 操作 + 事件订阅)
3. PixiJS v8 + 一张精灵图/Lottie(先不做 Live2D)
4. electron-builder(先能打出 exe)
5. `@modelcontextprotocol/sdk`(`pet.speak` 打通)

## 三条工程纪律(个人 + AI 辅助)

1. **一门语言到底**:全程 TS,绝不引入 Rust(除非改走 Tauri)。
2. **类型当契约**:DSH 调用全部 import 仓库 client 类型,不手写接口类型。
3. **首选 AI 训练充分的主流库**(Electron/React/Vite/PixiJS/Zustand/Tailwind/electron-builder),把小众库限制在 DSH 内部那几个 client 包。
