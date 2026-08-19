# DSH 桌面宠物 —— 技术指导文档

> 目标:开发一个与 DSH(DeepSeek Harness)深度链接的桌面宠物。宠物窗口独立于 DSH 窗口,既能通过宠物**主动操作 DSH 的绝大部分能力**,又能被 DSH 的 Agent **反驱动**(通过 MCP),同时叠加桌面宠物特有的表现能力(Live2D、托盘、通知等)。

本目录是这套应用的技术指导文档,按主题拆分。建议按顺序阅读。**实际开发过程与踩坑见 [changes/](./changes/) 改动档案**(按改动时序,是最贴近现状的一手记录)。

## 文档索引

| 文件 | 内容 | 阅读优先级 |
|---|---|---|
| [01-architecture.md](./01-architecture.md) | 整体架构、双向控制模型、与主流 MCP 宠物的区别 | ★★★ 先读 |
| [02-tech-stack.md](./02-tech-stack.md) | 技术栈清单(当前实际采用) | ★★★ |
| [03-dsh-integration.md](./03-dsh-integration.md) | **核心**:如何消费 DSH 的 `/api` + WebSocket 客户端面 | ★★★ |
| [04-mcp-integration.md](./04-mcp-integration.md) | 如何让宠物成为 MCP server,被 DSH Agent 调用 | ★★ |
| [05-scaffolding.md](./05-scaffolding.md) | `apps/pet` 工程现状:目录结构、构建、preload 白名单 | ★★ |
| [06-roadmap.md](./06-roadmap.md) | 分阶段开发路线图(阶段 0–5.5 已完成,阶段 6 进行中) | ★ |
| [08-live2d-integration.md](./08-live2d-integration.md) | Live2D 角色接入:Cubism 工程 → runtime 包、兼容矩阵、落地记录 | ★★ |
| [09-animation-arbitration.md](./09-animation-arbitration.md) | 动画仲裁:表情互斥 + 动作通道预留(Animation Director) | ★★ |

> **项目改动档案**:[changes/](./changes/) 按"一次改动一篇文档"记录实际开发过程(改动清单、决策、踩坑、验证),约定见 [changes/README.md](./changes/README.md)。主题文档描述"当前应该是什么样",changes/ 记录"当时怎么走到这里的"。

## 一句话结论

宠物不是"给 Agent 的一个会动的挂件",而是 **DSH 的第二个、常驻的、对等客户端**:

- **上行(宠物 → DSH)**:复用 Web 客户端同一条 `POST /api/<namespace>/<method>` 通道,权限与本机浏览器页面同级(loopback 受信)。
- **下行(DSH → 宠物)**:订阅 `/api/events.mux`(会话级)+ `/api/events.host`(全局)两条 WebSocket 事件流,把状态翻译成宠物动作。
- **反向(Agent → 宠物)**:宠物额外跑一个 MCP server,DSH 的 `mcp-client` 把它的工具注册成 `mcp__<serverName>__<toolName>`,Agent 即可调宠物"说话/做动作/弹提醒"。

## 已在 harness 源码中核对过的事实(写作依据)

以下关键信息直接来自 `deepseek-harness` 仓库源码,后续实现以这些为准:

- 仓库工具链:`pnpm@11.7.0`、Node `^22.19.0 || >=24`、`"type": "module"`、TypeScript 6、`workspaces` 含 `apps/*` 与 `packages/*/*`(`package.json`)。
- `/api` 前缀与两条 WS 路径:`API_PATH = '/api'`、`MUX_EVENTS_PATH = '/api/events.mux'`、`HOST_EVENTS_PATH = '/api/events.host'`(`packages/client/connection/src/api-path.ts`)。
- 客户端传输与类型:`@deepseek-ai/dsh-client-connection/client` 导出 `ConnectionController`(含 `host.describe` 握手、断线重连/退避)、`WebApiClient`、`IApiClient`、`AbstractApiClient` 及全部帧/API 类型。
- API 面类型集中在 `@deepseek-ai/dsh-host-apiproxy/api` 与 `/client`:含 `sessions / host / events / workspace / skills / models / goals / settings / credentials / llm / subagents / jobs` 等命名空间。
- 特权方法(loopback-only):`agentPreset.*`、`host.pickDirectory`、`host.openPath`、`settings.*`、`credentials.*`、`llm.discoverModels`(`packages/client/connection/src/index.ts` 的 `PRIVILEGED_METHODS`)。
- MCP 客户端插件:`@deepseek-ai/dsh-mcp-client`,插件名 `mcp-client`,`inject: ['tools']`,工具命名 `mcp__<serverName>__<rawName>`,依赖 `@modelcontextprotocol/sdk@^1.12.0`。
- 需区分:`@deepseek-ai/dsh-sdk-*`(stdio JSON-RPC)是**内嵌/无头**模型(客户端自己 spawn 一个全新运行时),**不是**连接已运行实例的通道,宠物不要用它。

## 与"主流 MCP 宠物"的本质区别

| 维度 | MCP 服务器宠物 | 本项目(DSH 对等客户端) |
|---|---|---|
| 宠物在架构中的位置 | 被调用方(外设) | 对等客户端(控制器 + 观察者) |
| 控制流 | 单向 Agent → 宠物 | 双向 宠物 ⇄ DSH |
| 主动操作 DSH | ❌ | ✅(建会话/发消息/审批/管插件) |
| 实时观察 DSH 内部状态 | 基本盲 | ✅(完整事件流) |
| 权限面 | 仅自己写的几个工具 | 与 Web GUI 同级的 loopback 特权面 |

**结论:两者应叠加**。宠物既是 DSH 的 `/api` 客户端(主动控制 + 实时观察),又是一个 MCP server(被 Agent 反驱动表现)。
