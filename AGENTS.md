# AGENTS.md

DSH 桌面宠物 —— DeepSeek Harness 的**第二个、常驻、对等客户端**:一个独立 Electron 窗口,既能通过 DSH 的 `/api` + WebSocket 主动操作/观察 DSH,又能作为 MCP server 被 DSH Agent 反驱动(Agent → 宠物)。设计见 [doc/01-architecture.md](./doc/01-architecture.md),按 [doc/06-roadmap.md](./doc/06-roadmap.md) 分阶段推进,每步改动记录在 [doc/changes/](./doc/changes/README.md)。

## 当前进度(2026-08-15,新会话从这接续)

- ✅ **阶段 0~4 全部完成**:脚手架 + 连通性 PoC + MVP + 关键操作面(会话/历史/审批/通知)+ **MCP 反向链路(Agent → 宠物)**。改动档案 `doc/changes/0001~0008`。
- ✅ **阶段 4 已实机验证**:DSH 重启加载 `cordis.patch.yml` 后,Agent 真实调用 `mcp__pet__speak` / `mcp__pet__setExpression`,宠物弹气泡、切表情(双向闭环打通)。
- ➡️ **下一步:阶段 5 打包与常驻** —— electron-builder NSIS + portable、开机自启、单实例、图标、配置持久化(详 doc/06)。
- **待办/已知**:
  - 动画素材未到位(`assets/pet/sprites/<state>/` 为空),当前是 PixiJS 几何占位球宠;放置规则见 `assets/pet/README.md`。
  - 真实发消息端到端待用户手动验证(dev 窗口输入框打字;目标会话已在阶段 3 支持切换)。
  - React/Zustand/Tailwind 待设置面板等复杂 UI 时再引入(当前 vanilla DOM)。
  - MCP bridge 端口固定 39761(`PET_BRIDGE_PORT` 可覆盖);宠物未运行时 mcp 工具调用返回 bridge 错误,DSH 侧 `failOnStartupError: false` 不阻塞。
- **阶段 4 架构要点**:MCP server 是 DSH spawn 的**独立 stdio 进程**(`out/main/mcp-server.js`),与常驻 Electron 主进程经 loopback HTTP bridge(39761)通信;工具名 `mcp__pet__speak/setExpression/notify`;DSH 配置在用户 profile 的 `cordis.patch.yml`(`$DSH_HOME/profiles/web/`),改它**必须重启 DSH**(web profile HMR 已禁用)。
- **帧风暴保护(阶段 3 已做)**:`dsh:frame` 不再逐帧推给 renderer(主进程侧仍在,可调试);renderer 只收语义事件(turn/审批/错误/pet)。
- **区分消息来源(设计已定,未实现)**:宠物自己发的消息可用 **rpcId 关联**——`session.prompt` 响应回显 `rpcId`,且该 rpcId 会进 `user/message` 事件的 `message.source.rpcId`(官方对账机制);协议**没有客户端身份字段**,无法区分 Web GUI 与其他 loopback 客户端(`clientTimeZone` 是时区非身份)。做气泡标注时直接实现 rpcId 关联(~15 行)。
- **换 Live2D 评估(已定)**:优先**官方 Cubism Web SDK**(角色层换独立 canvas,不依赖 Pixi);`pixi-live2d-display` 锁 Pixi v6/v7,与项目 PixiJS v8 不兼容。工作量约 1~2 天,`PetAnimator` 接口零改动(见下文动画可插拔)。

## Repository layout

```
src/main/       主进程:窗口、托盘、DSH 连接、PetEvent 总线、MCP server(阶段4)
src/preload/    contextBridge 白名单(renderer 与主进程的唯一通道)
src/renderer/   表现层:PixiJS 角色 + XState 状态机 + vanilla DOM 气泡/输入(React/Zustand/Tailwind 待复杂 UI 再引入)
doc/            技术指导文档(01 架构 … 07 TS 学习路线)+ changes/ 改动档案
```

## Commands

```bash
pnpm install                                      # 仓库根:安装/链接依赖(electron 二进制走镜像)
pnpm --filter @deepseek-ai/dsh-pet run dev        # electron-vite 开发(出窗口)
pnpm --filter @deepseek-ai/dsh-pet run build      # 构建到 out/
pnpm --filter @deepseek-ai/dsh-pet run typecheck  # tsc --noEmit(node + web 两个配置)
pnpm exec tsx scripts/check-workspace-constraints.ts   # 根仓库:workspace 约束 gate
```

DSH 运行实例默认在 `http://127.0.0.1:3080`(loopback 受信,宠物权限与 Web GUI 同级;**不要**部署到非 loopback)。

## Conventions

- 全栈 TypeScript(strict)+ ESM;**DSH 调用面一律 import 仓库 client 类型,禁止手写接口类型**——方法签名以 `packages/**/lib/types/*.d.ts` 为准,`doc/03` 的示例代码可能有漂移,先核对再写。
- 提交用 conventional commits(如 `feat(pet): …` / `chore(pet): …`)。
- 每完成一步(阶段或独立修复),在 `doc/changes/` 写一篇 `NNNN-<slug>.md`(约定见其 README);**不改写历史文档**。
- 本目录是**独立 git 仓库**(harness 根仓库通过 `.git/info/exclude` 排除了 `apps/pet/`);不要向根仓库提交 apps/pet 的内容。

## 网络环境(国内镜像)

- 根仓库 `.npmrc`:registry → npmmirror、`electron_mirror`、`electron_builder_binaries_mirror`。
- pnpm 11 的依赖构建脚本放行在 `pnpm-workspace.yaml` 的 `allowBuilds`(electron 已放行);**不要**再往根 `package.json` 写 `pnpm` 字段(pnpm 11 不读,会告警)。
- electron 二进制缺失时(pnpm 可能缓存"已忽略"状态,install/rebuild 不重跑),直接执行:

  ```powershell
  $env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
  node node_modules/.pnpm/electron@*/node_modules/electron/install.js
  ```

## 已知架构事实(避免重复踩坑)

- `WebApiClient` / `AbstractApiClient` 构造器参数是 `timeoutMs?`,**没有 baseUrl 选项**;基址来自 `resolveBase()`(浏览器=同源)。连 `127.0.0.1:3080` 需子类覆写 `protected override resolveBase()`。
- DSH webserver **无 CORS 处理**:renderer 跨源直连 `/api` 会被浏览器拦截。DSH 连接必须放**主进程**(Node fetch/WebSocket 无 CORS),事件经 preload 白名单推给 renderer。
- DSH 事件流服务端**只接受 WebSocket**:`GET /api/events.mux|host` 返回 **426 Upgrade Required**。主进程下行用 `ws` 包(见 `src/main/dsh/client.ts`);`AbstractApiClient` 默认的 SSE 下行(`readSse`)不可用。
- `@deepseek-ai/dsh-client-connection/client` 是**纯浏览器包**(引用 `window`,Node 加载即崩);主进程载体用 `@deepseek-ai/dsh-host-apiproxy/client` 的 `AbstractApiClient`(Node-safe)。
- `"type": "module"` 下 electron-vite 把 preload 输出为 `out/preload/index.mjs`,主进程引用它且 `webPreferences.sandbox: false`。
- `apps/pet` 的 tsconfig 继承仓库 base 但**清空 `paths`**:workspace 依赖走 `node_modules` 里已构建的 `lib/types/*.d.ts`;若类型报"找不到模块",先确认对应包构建产物存在(根仓库 `pnpm run build:lib`)。
- **动画可插拔**:状态机只输出语义状态(`idle/thinking/happy/sad/talking`),`PetAnimator` 接口(`src/renderer/src/pet/animator.ts`)是唯一懂动画后端的层——换 Lottie/Live2D 只加实现类,状态机/事件/UI 零改动。占位实现是 PixiJS 几何"球宠";素材规则见 `assets/pet/README.md`。
- **PixiJS v8 要求 CSP 允许 `unsafe-eval`**(WebGL 着色器生成),renderer 的 CSP 已为此放开;代价是 Electron dev 期的安全警告(打包后消失)。
- **IPC 参数必须可序列化**:`undefined`/`NaN` 过 IPC 会触发主进程 `Error processing argument at index N, conversion failure` 崩溃。参数合法性在 **preload 边界统一收敛**(`toFinite` / `String`),renderer 与主进程 handler 不要透传原始值。
- **窗口拖拽用原生 `-webkit-app-region: drag`**(`#stage`),**不要**用 IPC 逐帧 `setPosition`(曾导致卡顿 + setPosition 参数转换崩溃)。可交互区域(输入条)必须标 `no-drag`;要点击宠物时在 `#stage` 上叠 `no-drag` 透明层。
