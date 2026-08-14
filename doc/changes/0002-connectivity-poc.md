# 0002 · 阶段 1:连通性 PoC(主进程 DSH 客户端层)

**状态**:已验证
**日期**:2026-08-15
**对应路线图**:doc/06 阶段 1(连通性 PoC,全项目最大技术风险点)

---

## 目的

1. 证明"宠物读得到运行中的 DSH 实例":主进程连 `127.0.0.1:3080`,`host.describe` 握手成功。
2. 订阅两条事件流(mux/host)并看到帧流动。
3. 跑通一条真实操作(`sessions.list`)。
4. 验证断线→重连自动恢复。
5. 把连接放在**主进程**(doc 03 §8 推荐架构),renderer 只经 preload 白名单取事件——阶段 3 的"下沉主进程"在此一步到位。

## 改动清单

### 根仓库(harness monorepo)

| 文件 | 改动 |
|---|---|
| `pnpm-lock.yaml` | 新增 devDep `@types/ws`(ws 包的 TS 类型) |

### apps/pet

| 文件 | 内容 |
|---|---|
| `src/shared/pet-event.ts`(新) | 共享类型:`PetEvent`(dsh:connected / dsh:state / dsh:frame / op:result)、`PetApi`(preload 白名单接口)、`PetConnectionState`、`PetOpResult`;`HostDescription`/`ConnectionState` 在此定义(node 与 web 两个 tsconfig 都 include `src/shared`) |
| `src/main/dsh/client.ts`(新) | `DshApiClient extends AbstractApiClient`:覆写 `doFetch`(全局 fetch)与 `resolveBase()`(→ `http://127.0.0.1:3080`);覆写 `openMux`/`openHost` 用 `ws` 包实现 WebSocket 下行,帧解析与浏览器 `WebApiClient` 同一套 schema |
| `src/main/dsh/connection.ts`(新) | 自写连接循环:`host.describe` 握手 → 起 mux/host 两条 WS 流 → 泵帧;断流/失败 → `reconnecting` → 指数退避(500ms 起,×2,上限 30s,带抖动)重试;`stop()` 中止当前代际 |
| `src/main/index.ts` | 装配:窗口 + `createConnection(sendPetEvent)` + ipcMain 白名单(`pet:get-state` / `pet:list-sessions` / `pet:debug-reconnect`);`will-quit` 停连接 |
| `src/preload/index.ts` | contextBridge 暴露 `window.petApi`:`onPetEvent`(可退订)/ `getState` / `listSessions` / `debugReconnect` |
| `src/renderer/index.html` | PoC 面板:连接状态、describe(JSON)、操作结果、两个按钮(列会话 / 断开重连)、帧列表 |
| `src/renderer/src/main.ts` | 订阅事件渲染;连接就绪自动跑一次 `listSessions`;`getState()` 兜底首次 connected 竞态 |
| `tsconfig.node.json` / `tsconfig.web.json` | include 增加 `src/shared/**/*` |
| `package.json` | devDeps 增加 `@types/ws` |
| `AGENTS.md` | 已知架构事实补充:事件流只接受 WebSocket(426)、client 子路径是浏览器包 |

## 关键决策

1. **连接放主进程,不用 renderer 直连**:DSH webserver 全仓库无 CORS 处理(已核实),renderer 跨源 POST 会被浏览器拦;主进程 Node fetch/WS 无此问题。也省掉 vite proxy 这类 dev-only 魔法。
2. **载体基类用 `@deepseek-ai/dsh-host-apiproxy/client` 的 `AbstractApiClient`**,不用 `@deepseek-ai/dsh-client-connection/client`:后者是纯浏览器包,Node 里 `import` 即抛 `window is not defined`(实测)。前者 Node-safe,且上行(`callUnary` POST `/api/<method>`)与信封/帧 schema 全部自带。
3. **下行走 WebSocket(`ws` 包)**:服务端事件流只接受 WS,`GET /api/events.mux|host` 返回 **426 Upgrade Required**(实测)——`AbstractApiClient` 默认的 SSE 下行(`readSse`)不可用。帧解析逻辑从浏览器 `WebApiClient.readWebSocket` 移植(同一套 `serverRequestSchema` + `muxFrameSchema`/`hostFrameSchema`)。
4. **连接循环自己写(~50 行),不引 `ConnectionController`**:该控制器是 connection 包的包内私有(设计上经 cordis 插件 `ctx.connection.start(sinks)` 消费),主进程没有 cordis 运行时;连接循环是生命周期胶水(握手/重连/退避),协议本身仍由 `AbstractApiClient` 承担,不算"自造协议"。
5. **共享类型放 `src/shared/`**:main/preload/renderer 三端共用的 `PetEvent`/`PetApi` 类型,避免跨目录 import 拖进各自不该有的依赖;两套 tsconfig 都 include。
6. **阶段 1 只做只读操作**(`sessions.list`):`session.prompt`(真实发消息驱动 agent)留给阶段 2 气泡输入。

## 踩坑记录

### 坑 1:doc 03 的 `new WebApiClient({ baseUrl })` 已漂移
当前 `AbstractApiClient` 构造器是 `constructor(timeoutMs?)`,**没有 baseUrl 选项**;基址来自 `resolveBase()`(浏览器=同源,Node=占位 `http://dsh.internal`)。必须子类覆写 `protected override resolveBase()`。doc 03 §3.2/3.3 的示例照抄会直接类型报错。

### 坑 2:client 子路径不导出 WebApiClient / ConnectionController / resultOf
`@deepseek-ai/dsh-client-connection/client` 只导出 `AbstractApiClient`、`RpcId`、`transportError` 及类型;`ConnectionController` 注释明言"controller remains package-internal"(设计上经 cordis 插件消费)。这也是决策 4 的直接原因。

### 坑 3:`dsh-client-connection/client` 在 Node 加载即崩
`import('@deepseek-ai/dsh-client-connection/client')` 在 Node 报 `window is not defined`——纯浏览器包(它依赖 `location`/`window`)。主进程集成必须绕开它(决策 2)。

### 坑 4:SSE 下行被服务端拒绝(HTTP 426)
先按 `AbstractApiClient` 默认走 SSE(基类 `readSse`),服务端返回 **426 Upgrade Required**——事件流只接受 WebSocket。文档里"两条 WS"的说法是对的;SSE 通道虽然代码里有 GET 分支,实际部署不提供。已改为 `ws` 包实现下行。

### 坑 5:tsdown 的 CJS 包装产物 + rollup 静态分析
曾尝试 `externalizeDepsPlugin({ exclude: ['@deepseek-ai/dsh-client-connection'] })` 把该包打进主进程 bundle 以用其 `./src/*` 源码通道,结果 rollup 报 `MISSING_EXPORT "AbstractApiClient" is not exported by lib/client.js`——tsdown 产物是 CJS 包装格式(`exports.X = ...` + `return module.exports`),rollup 无法静态分析。结论:**不打包该包**,主进程只用 Node-safe 的 apiproxy/client。

### 坑 6:首次 `dsh:connected` 早于 renderer 订阅(良性竞态)
窗口加载比握手慢时,首个 `dsh:connected` 事件在 renderer 订阅前已发出,事件处理器看不到(实测:自动列会话只在重连后才触发)。解法:`getState()` 在订阅后补读一次当前状态(实测兜底生效)。长线方案(阶段 2)是 renderer 显式"请求连接"或 main 侧缓冲最近状态。

### 坑 7:vite 依赖重优化造成"旧 bundle"假象
调试时 renderer 日志行号与源码对不上、新加的日志不出现——是 vite 因 lockfile 变化触发 deps 重优化后缓存了旧 transform。排查方法:在模块顶层打版本标记(`[pet] renderer bundle v3`),确认当前代码真的在跑。重启 dev 进程后正常。

## 验证结果(实测日志节选)

```text
[pet] renderer bundle v3, petApi = present        # renderer 当前 bundle,preload 白名单注入成功
[pet] state: connected                            # 连接建立(握手成功)
[pet] describe: [object Object]                   # host.describe 返回 HostDescription
[pet] op ok: 8 sessions(1 running,7 non-blank)    # 真实操作 sessions.list 成功
[pet] frame [mux] session/event                   # mux 帧流动
[pet] frame [mux] session/projection
# 重连后(debugReconnect stop+start):
[pet] state: connected
[pet] frame [mux] session/subscribed  ×14         # 每个 attached session 一条 subscribed 控制帧
[pet] frame [mux] session/queue
[pet] frame [mux] session/jobs
```

- `pnpm --filter @deepseek-ai/dsh-pet run typecheck` ✅ exit 0
- 重连的**失败→reconnecting→退避→重连**路径在修复 426 前已被实测(HTTP 426 循环期间状态机正确流转),修复后为 stop→start 的新代际握手,同样通过。

## 遗留 / 后续

- **阶段 2(MVP)**:透明无边框置顶窗口 + 托盘、PixiJS 待机动画、XState 状态映射、气泡输入(接 `session.prompt`)、消息完成事件→气泡。此时"连接下沉主进程"已就位,可直接在 renderer 接表现层。
- **帧归一化深化**:当前 `dsh:frame` 只带 `frameType`;阶段 2 按 doc 03 的"事件→状态机→动作"把关键帧(session/event、审批、错误)归一化成 `PetEvent` 语义(如 `agent:working` / `approval:pending`)。
- **重连体验**:手动 stop 时不发 `reconnecting`(abort 是干净退出,非故障);后续可区分"主动断开"与"故障重连"两种状态语义。
- **渲染层噪音**:现在每条帧都经 IPC 推给 renderer;阶段 2 引入批量/节流(帧风暴保护)。
