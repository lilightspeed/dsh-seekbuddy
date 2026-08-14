# 06 · 开发路线图

> 按"先闭环、再增强"的顺序推进。每个阶段结束都有一个可运行、可演示的产物,避免一次铺太大。

## 阶段 0 · 准备(0.5 天)

- [ ] 在 harness monorepo 新建 `apps/pet` 并接入 `pnpm workspaces`。
- [ ] electron-vite 跑通空窗口(`pnpm dev` 能出窗口)。
- [ ] 确认能用 `workspace:^` import `@deepseek-ai/dsh-client-connection/client` 且类型不报错。
- [ ] 记录 DSH 运行实例的 `/api` 地址(默认 `http://127.0.0.1:3080`)。

**产物**:空 Electron 窗口能启动,类型编译通过。

## 阶段 1 · 连通性 PoC(核心验证,0.5–1 天)

- [ ] renderer 里用 `WebApiClient` 连 `127.0.0.1:3080`。
- [ ] `host.describe` 握手成功。
- [ ] 订阅 `/api/events.mux` + `/api/events.host`,把帧打印出来。
- [ ] 跑通一条真实操作(如列会话/发一条测试消息)。
- [ ] 断连 → 重连自动恢复(验证 `ConnectionController`)。

**产物**:能证明"宠物读得到运行中的 DSH 实例"。这是全项目最大的技术风险点,先打掉。

## 阶段 2 · 最小可用宠物(MVP,2–3 天)

- [ ] 透明无边框置顶窗口 + 托盘。
- [ ] PixiJS + 一张精灵图/Lottie,跑一个待机动画。
- [ ] 用 XState 把"DSH 空闲/忙碌/报错"映射成至少 3 个状态动作。
- [ ] 气泡输入框:输入文字 → `/api` 发到指定 session。
- [ ] 收到消息完成事件 → 气泡提示。

**产物**:能主动发消息、能看到忙碌/完成表现的宠物。

## 阶段 3 · 关键操作面(1–2 天)

- [ ] 会话列表/切换、历史查看。
- [ ] 审批:在宠物窗口点"允许/拒绝"(loopback 特权)。
- [ ] 系统通知(工具完成/报错/需审批时)。
- [ ] preload `contextBridge` 白名单 + 把连接下沉到主进程(若阶段 1 用 renderer 实现)。

**产物**:宠物能完成 DSH 的日常高频操作,不必常开网页。

## 阶段 4 · 反向链路 MCP(1–2 天)

- [ ] 宠物侧用 `@modelcontextprotocol/sdk` 起 MCP server,暴露 `pet.speak / setExpression / notify`。
- [ ] DSH `cordis.yml` 加 `mcp-client` 行接入。
- [ ] 验证 Agent 能调用 `mcp__pet__speak`,宠物真开口/变表情。

**产物**:双向闭环 —— 你 ↔ 宠物 ↔ DSH ↔ Agent。

## 阶段 5 · 打包与常驻(1 天)

- [ ] electron-builder 打出 NSIS + portable。
- [ ] 开机自启、单实例、图标。
- [ ] 配置持久化(electron-store):DSH 地址、外观、语音开关。

**产物**:可分发、可常驻的 exe。

## 阶段 6 · 增强(可选,逐步)

- [ ] 语音:TTS(edge-tts)+ ASR(Whisper/Vosk)。
- [ ] Live2D/Spine 角色替换精灵图。
- [ ] 多会话雷达(同时盯多个 session)。
- [ ] 动态 Cordis 插件管理界面(define/run/update/stop/undefine、inspect)。
- [ ] 桌面自动化 MCP 工具(openApp / switchWindow,谨慎开放)。
- [ ] electron-updater 自动更新。

## 风险清单(提前标注)

| 风险 | 应对 |
|---|---|
| 复用 client 包时方法签名/导出与文档不符 | 阶段 0/1 就 import 真实 `.d.ts` 核对,别照抄示例字段 |
| Live2D 与 PixiJS v8 兼容性 | 先精灵图/Lottie;Live2D 阶段再单独验证 |
| MCP `mcp-client` 的 config 字段名 | 以 `@deepseek-ai/dsh-mcp-client` 的 `Config` schema 为准 |
| 主进程 `WebSocket` 可用性 | renderer 用 `WebApiClient`;主进程用 `ws` 或 Node 内置 |
| 安全面扩大 | 全程 `contextBridge` 白名单,不暴露 `ipcRenderer` |

## 每个阶段的"完成定义"

- 有可运行产物,不只是代码;
- 类型检查通过(`tsc --noEmit`);
- 关键路径手动验证过(不是"应该能跑")。
