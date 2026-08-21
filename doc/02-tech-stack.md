# 02 · 技术栈清单(当前现状)

> 原则:**全栈只用 TypeScript 一门语言**,并尽量复用 harness 仓库里现成的 client 包。
> 本文是**当前实际采用**的技术栈(与代码一致);规划中但未引入的项明确标注"未采用"。

## 0. 工程形态

`apps/pet` 位于 harness monorepo 内,`workspace:^` 直接引用 DSH 的 client 包 —— 类型零漂移,协议升级跟着走。独立 git 仓库(根仓库经 `.git/info/exclude` 排除),提交只在 apps/pet 内。

## 1. 语言 / 运行时

| 项 | 选型 | 说明 |
|---|---|---|
| 语言 | TypeScript(strict) | 全栈一门语言 |
| 运行时 | Node.js `^22.19.0`(或 `>=24`) | 与 harness `engines` 一致 |
| 模块 | ESM(`"type": "module"`) | 与仓库一致 |

## 2. 包管理 / 构建

| 项 | 选型 |
|---|---|
| 包管理 | pnpm(workspaces) |
| Electron 三段构建 | electron-vite(底层 Vite) |
| 主进程打包 | electron-vite 全量 bundle(只 external electron 与 node 内置;不再拖 node_modules,见 0009) |
| 类型检查 | `tsc --noEmit`(node + web 两个 tsconfig,`pnpm typecheck`) |

## 3. 桌面壳层

| 项 | 选型 | 说明 |
|---|---|---|
| 壳 | Electron | 主进程即 Node,可直接复用 DSH 的 TS 包 |
| 打包/分发 | electron-builder | NSIS + portable(`scripts/package.mjs`) |
| 自动更新 | 未采用 | electron-updater 未接入 |
| 进程通信 | `ipcMain`/`ipcRenderer` + `contextBridge`(preload 白名单) | 安全边界;0004 纪律:IPC 参数必须可序列化标量,preload 边界收敛 |

## 4. 前端 UI(renderer)

| 项 | 选型 | 说明 |
|---|---|---|
| UI | **vanilla DOM** | 气泡/输入条/面板全部手写 DOM + CSS(现状) |
| React / Zustand / Tailwind / shadcn | **未采用** | AGENTS.md 既定:等复杂 UI 再引入,当前规模 vanilla 足够 |

## 5. 角色渲染 / 动画(宠物核心表现)

| 项 | 选型 | 说明 |
|---|---|---|
| **Live2D(现役)** | **官方 Cubism SDK for Web 5-r.5 + 独立 WebGL2 canvas 自绘** | `vendor/live2d`(编译产物 + d.ts,别名 `@live2d/framework`);Core 06.00.0001 支持 moc3 v6;见 08 篇与 vendor README |
| 占位回落 | PixiJS v8 几何"球宠" | WebGL2 不可用/无 Live2D 时回落(`sprite-animator.ts`) |
| Lottie / Spine | 未采用 | 素材规则保留在 assets README,暂无用 |
| 状态机 | XState | 语义状态 `idle/thinking/happy/sad/talking`,与动画后端解耦 |
| 视角跟随/眨眼/呼吸 | 自研 follower + SDK updater | 0014–0019;设置面板可调(位置/大小/幅度/死区/距离/速度) |

## 6. DSH 集成层(★核心,复用仓库包)

| 包(精确导入路径) | 用途 |
|---|---|
| `@deepseek-ai/dsh-host-apiproxy/client` | 主进程载体 `AbstractApiClient` 子类(上行 Node fetch,下行 `ws`;基址 `resolveBase()` 覆写为 `127.0.0.1:3080`) |
| `@deepseek-ai/dsh-client-connection/client` | `ConnectionController`(握手/重连)、`IApiClient`、帧/API 类型(主进程用 apiproxy 的 Node-safe 面,renderer 不直连 DSH) |
| `@deepseek-ai/dsh-api-remotes/client` | 参考 Remote 命名空间语义(不直接依赖) |
| `ws` | 主进程下行 WebSocket(DSH 事件流只接受 WS,SSE 返回 426) |

协议不新增:上行 `POST /api/<namespace>/<method>`,下行 `WS /api/events.mux` + `/api/events.host`,握手 `host.describe`。详见 [03-dsh-integration.md](./03-dsh-integration.md)。**DSH 连接必须放主进程**(webserver 无 CORS;renderer 跨源直连会被浏览器拦截)。

## 7. MCP server(让 Agent 反驱动宠物)

| 项 | 选型 |
|---|---|
| SDK | `@modelcontextprotocol/sdk`(`McpServer`) |
| 传输 | **loopback TCP bridge(实际落地)**:宠物主进程开 `127.0.0.1:39761` 桥,DSH 用裸 node spawn `out/main/mcp-server.js`(stdio)对接;见 `mcp/bridge.ts` + `mcp/server.ts` |
| 工具(现役) | `pet.setExpression`、`pet.notify`(已实机验证,见 0008/0011) |

## 8. 语音(未计划)

| 项 | 选型 |
|---|---|
| TTS | 未接入;设置面板"语音提示"开关已移除(不再计划实现) |
| ASR | 未接入 |

## 9. 本地存储 / 配置

| 项 | 选型 |
|---|---|
| 配置持久化 | **手写 `PetConfigStore`**(`src/main/config.ts`,JSON 原子写,零依赖) | 
| electron-store / better-sqlite3 | 未采用(设置项少、写频率低,手写足够,见 0009) |

## 10. 测试 / 质量

| 项 | 选型 |
|---|---|
| 质量门槛 | `pnpm typecheck`(strict + noUnusedLocals/Parameters + exactOptionalPropertyTypes 等) |
| 单测 / E2E | 未搭建(当前靠 typecheck + 真机验证) |

## 11. 打包 / 分发(Windows)

| 项 | 选型 |
|---|---|
| 打包 | electron-builder(NSIS / portable) |
| 图标/托盘/通知/自启 | Electron 内置 + electron-builder 配置(已实现,阶段 5) |

## 三条工程纪律(个人 + AI 辅助)

1. **一门语言到底**:全程 TS。
2. **类型当契约**:DSH 调用全部 import 仓库 client 类型,不手写接口类型(方法签名以 `packages/**/lib/types/*.d.ts` 为准)。
3. **IPC 参数必须可序列化**:`undefined`/`NaN` 过 IPC 会崩主进程,参数合法性在 preload 边界收敛(0004)。
