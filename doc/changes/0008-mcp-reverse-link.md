# 0008 · 阶段 4:MCP 反向链路 —— Agent → 宠物(speak / setExpression / notify)

**状态**:已验证
**日期**:2026-08-15
**对应路线图**:doc/06 阶段 4(反向链路 MCP,双向闭环)

---

## 目的

打通 **DSH Agent → 宠物** 的反向链路:DSH 的 Agent 在回答过程中能调用 `mcp__pet__speak` 等工具,让桌面宠物真开口/变表情/弹通知,形成"你 ↔ 宠物 ↔ DSH ↔ Agent"三方闭环。

## 架构

```
DSH Agent 调用 mcp__pet__speak(text)
  → DSH mcp-client 插件(stdio)spawn 宠物侧独立 MCP server 进程
  → MCP server 收到工具调用 → POST 127.0.0.1:39761/pet/bridge(loopback)
  → 宠物 Electron 主进程 bridge → PetEvent(pet:speak/expression/notify)
  → preload 白名单 → renderer → 气泡 / 表情 / 系统通知
```

关键点:MCP server 是被 DSH spawn 的**独立 Node 进程**(stdio 传输),与常驻 Electron 主进程通过 **loopback HTTP bridge** 通信(固定端口,环境变量 `PET_BRIDGE_PORT` 可覆盖,默认 39761)。

## 改动清单

### apps/pet —— 依赖

| 包 | 版本 | 说明 |
|---|---|---|
| `@modelcontextprotocol/sdk` | ^1.29.0 | MCP server 实现 |
| `zod` | ^4.4.3 | SDK 的 peer 依赖,工具入参 schema |

根仓库 `pnpm-lock.yaml` 相应更新。

### apps/pet —— 源码

| 文件 | 改动 |
|---|---|
| `src/shared/mcp-bridge.ts`(新) | bridge HTTP 协议类型(`PetBridgeAction` speak/expression/notify、`PetBridgeResult`)、`BRIDGE_PATH`、`resolveBridgePort`(默认 39761,env 覆盖;web tsconfig 无 Node 类型,用 `globalThis` 访问 env) |
| `src/main/mcp/bridge.ts`(新) | 主进程 loopback HTTP server:POST `/pet/bridge` → `onAction` 回调 → `bridgeActionToEvent` 转 PetEvent;仅绑定 127.0.0.1 |
| `src/main/mcp/server.ts`(新) | 独立 stdio MCP server(`dsh-pet` v0.1.0):`speak(text)` / `setExpression(state)` / `notify(title,body)`,每个工具 POST 到 bridge;`AbortSignal.timeout(5000)` 防挂死 |
| `src/main/index.ts` | `app.whenReady` 启动 bridge;`pet:*` 事件走统一 `onPetEvent` 出口(通知 + renderer);`will-quit` 关 bridge |
| `src/main/notify.ts` | `pet:notify` → Electron 系统通知 |
| `src/shared/pet-event.ts` | `PetEvent` 新增 `pet:speak` / `pet:expression` / `pet:notify` |
| `src/renderer/src/main.ts` | 事件映射:`pet:speak` → 气泡 + TALK;`pet:expression` → 对应状态机事件;`pet:notify` → 气泡 |
| `electron.vite.config.ts` | main 多入口(index + mcp-server);**显式 external electron 与 node 内置模块**(见踩坑 1) |
| `scripts/mcp-bridge-smoke.mjs`(新) | 开发验证脚本:模拟 DSH mcp-client,stdio 连宠物 MCP server 依次调用 3 个工具 |

### DSH 配置(根仓库外,用户 profile)

| 文件 | 改动 |
|---|---|
| `C:\Users\wanyu\.dsh\profiles\web\cordis.patch.yml` | insert `mcp-client` 行:`serverName: pet`、`command: node`、args 指向 `apps/pet/out/main/mcp-server.js`,reconnect 开启 |

## 关键决策

1. **stdio 传输 + 独立进程**:MCP server 是 DSH spawn 的子进程(DSH mcp-client 的 stdio transport),不占 Electron 主进程;宠物常驻主进程只起 bridge 等调用。
2. **loopback HTTP 桥接(不用文件协调端口)**:两进程约定固定端口 39761(env 可覆盖),同机 loopback 受信,无需跨进程文件同步——简单可靠。
3. **工具命名**:`serverName: pet` → 工具注册为 `mcp__pet__speak` / `mcp__pet__setExpression` / `mcp__pet__notify`(DSH mcp-client 的命名空间约定)。
4. **failOnStartupError: false + reconnect**:宠物未启动时 mcp-client 插件不阻塞 DSH 启动,等宠物起来后自动重连(工具调用会返回 bridge 错误提示,不会挂死)。
5. **SDK 用 `registerTool` + zod schema**:入参校验由 MCP SDK 承担;工具实现只做 bridge 转发,保持薄。

## 踩坑记录

### 坑 1:多入口配置导致 electron 包被内联进 main bundle
加了 `rollupOptions.input` 多入口后,electron-vite 默认的 `external: ['electron', ...]` 被合并覆盖,electron 的 `index.js`(内含 `getElectronPath`)被打进 `out/main/index.js`,运行时在 `out/main/` 下找不到 `dist/electron.exe` 而报 `Electron failed to install correctly`。解法:在 `rollupOptions.external` **显式**列 `electron`、`/^electron\/.+/`、`node:内置模块`。构建后 index.js 不再含 electron 代码。

### 坑 2:pnpm install 后 electron 二进制标记缺失
`pnpm install` 重装依赖后 electron 包的 `path.txt`/`dist/version` 校验触发重下载(日志 "Downloading Electron binary..."),且 `node_modules/.pnpm/electron@*/...` 通配符在 PowerShell 下不展开导致 install.js 未真正运行。解法:用真实路径跑 `node <electron包>/install.js`(设 `ELECTRON_MIRROR` 镜像),确认 `dist/electron.exe` 存在后再启动 dev。AGENTS.md 已有同族记录。

### 坑 3:shared 目录被 web tsconfig include,不能引用 Node 类型
`src/shared/mcp-bridge.ts` 会被 web tsconfig(纯 DOM 环境)也编译,`NodeJS.ProcessEnv` / `process` 引用直接类型报错。解法:参数类型用 `Record<string, string | undefined>`,访问 env 经 `globalThis` 兜底。

### 坑 4:DSH 侧模块解析——mcp-client 经 profile 闭包可达
DSH 的 loader 通过 `$DSH_HOME/profiles/node_modules` 平面回退目录解析裸包名(该目录由 app manifest 依赖闭包 BFS symlink 生成)。`@deepseek-ai/dsh-mcp-client` 经 `apps/cli` 依赖闭包已在其中,无需改根 package.json——验证 `profiles/node_modules/@deepseek-ai/dsh-mcp-client` junction 指向 `apps/cli/node_modules/...` 且 `lib/index.js` 存在即可。

### 坑 5:web profile 的 HMR 已禁用,改 cordis.patch.yml 不热载
`dsh-web-app` 的 patch 里 `hmr.disabled: true`,`watchUserPatches` 无调用方——**改 patch 必须重启 DSH** 才生效。

## 验证结果

- `pnpm --filter @deepseek-ai/dsh-pet run typecheck` ✅ exit 0
- `pnpm --filter @deepseek-ai/dsh-pet run build` ✅ `out/main/mcp-server.js` 独立入口生成
- **模拟 mcp-client 端到端**(`scripts/mcp-bridge-smoke.mjs`):stdio 连接宠物 MCP server → `listTools` 返回 `speak, setExpression, notify` → 三个工具调用全部 `ok`;主进程日志 `[pet] bridge action: speak/expression/notify`;**用户确认宠物窗口弹出气泡、切换 happy 表情、弹系统通知** ✅
- DSH 侧 `cordis.patch.yml` 已配置(serverName=pet),`profiles/node_modules` 闭包可解析 mcp-client

## 遗留 / 后续

- **真实 Agent 验证待 DSH 重启后执行**:重启 DSH 使 patch 生效,在会话里让 Agent 调用 `mcp__pet__speak`,确认宠物真开口(用户已同意重启 DSH)。
- **端口冲突**:39761 被占时需设置 `PET_BRIDGE_PORT` 且两侧一致;后续可考虑端口发现文件。
- **阶段 5(打包与常驻)**:MCP server 入口需纳入 electron-builder 的 files;开机自启/单实例。
