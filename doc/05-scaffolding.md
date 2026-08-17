# 05 · 工程脚手架(`apps/pet` 现状)

> 本文描述 **apps/pet 当前的实际结构**(与代码一致)。骨架阶段的历史建议见 changes/0001。
> 本目录是独立 git 仓库,提交只在 apps/pet 内(根仓库经 `.git/info/exclude` 排除)。

## 1. 目录结构(现状)

```
apps/pet/
├── package.json              # @deepseek-ai/dsh-pet;type=module;main=out/main/index.js
├── electron.vite.config.ts   # main 全量 bundle + preload + renderer(assets publicDir + @live2d 别名)
├── tsconfig.json             # 引用 node/web 两个配置
├── tsconfig.node.json        # main + preload + shared(node 侧)
├── tsconfig.web.json         # renderer + shared(浏览器侧;@live2d/framework 路径别名)
├── electron-builder.yml      # NSIS / portable 打包配置
├── AGENTS.md                 # 仓库约定(改动档案、命令、已知架构事实)
├── scripts/
│   ├── package.mjs           # electron-builder 打包脚本(dist / dist:dir)
│   ├── mcp-server-boot-test.mjs / mcp-bridge-smoke.mjs   # MCP 冒烟测试
│   └── make-icon.ps1         # 图标生成
├── vendor/live2d/            # Cubism SDK for Web 5-r.5(许可 + Framework src/dist + 再构建说明)
├── assets/pet/               # publicDir 静态根(dev 下 /pet/** 可访问)
│   ├── live2d/               # ds-pet 模型 + core(live2dcubismcore.js)+ shaders/ + 兼容性说明卡
│   ├── sprites/ lottie/ icons/ audio/   # 规则目录(占位/Live2D 回落素材,见 assets/pet/README.md)
└── src/
    ├── main/
    │   ├── index.ts          # 入口:窗口/托盘/单实例/IPC 注册/光标轮询(视角跟随)
    │   ├── config.ts         # PetConfigStore(JSON 原子写持久化)
    │   ├── dsh/
    │   │   ├── client.ts      # AbstractApiClient 的 Node 载体(覆写 resolveBase → 127.0.0.1:3080)
    │   │   ├── connection.ts  # ConnectionController 生命周期(握手/重连/事件归一化)
    │   │   ├── ops.ts         # 会话/历史/审批操作
    │   │   └── plugin-ops.ts  # B3 只读插件监控
    │   ├── mcp/
    │   │   ├── server.ts     # MCP server(独立入口,被 DSH 裸 node spawn)
    │   │   └── bridge.ts     # 主进程 ↔ MCP 子进程的 loopback TCP 桥
    │   ├── notify.ts         # 系统通知
    │   └── tray.ts           # 托盘
    ├── preload/
    │   └── index.ts          # contextBridge 白名单(window.petApi);IPC 参数收敛(toFinite/String)
    ├── renderer/
    │   ├── index.html        # #stage(拖拽区)+ 气泡/输入条/面板;CSP 放行 unsafe-eval(Pixi/Live2D)
    │   └── src/
    │       ├── main.ts       # 启动:舞台 → 动画后端 → 状态机 → 面板/审批/事件
    │       ├── fsm/pet-machine.ts        # XState 语义状态
    │       ├── pet/
    │       │   ├── stage.ts              # PixiJS 舞台(占位层)
    │       │   ├── animator.ts           # PetAnimator 接口(含 applyPetSettings?)
    │       │   ├── sprite-animator.ts    # 占位球宠(回落)
    │       │   ├── assets.ts             # 素材加载占位
    │       │   └── live2d/
    │       │       ├── parameters.ts     # 模型参数 ID 契约
    │       │       ├── view-follower.ts  # 视角跟随核心逻辑(纯计算)
    │       │       ├── runtime.ts        # Live2dRuntime 接口(注册机制)
    │       │       ├── cubism-runtime.ts # 官方 SDK 实现(独立 canvas 自绘)
    │       │       └── create-live2d-animator.ts  # 动画后端工厂(默认 Live2D)
    │       └── ui/
    │           ├── panel.ts              # 会话/历史/审批/插件/设置面板
    │           └── approvals.ts          # 审批中心
    └── shared/
        ├── pet-event.ts      # PetEvent / PetApi 白名单类型
        └── pet-config.ts     # PetConfig(含 pet 外观/手感)+ 默认值
```

## 2. 构建与命令

```bash
pnpm --filter @deepseek-ai/dsh-pet run dev        # electron-vite dev(出窗口)
pnpm --filter @deepseek-ai/dsh-pet run build      # 构建到 out/(main + preload + renderer)
pnpm --filter @deepseek-ai/dsh-pet run typecheck  # tsc --noEmit(node + web 两个配置)
pnpm --filter @deepseek-ai/dsh-pet run dist       # 打包 NSIS + portable
```

关键配置事实(踩过坑,见 changes):

- `electron.vite.config.ts`:main 用 **全量 bundle**(只 external electron 与 node 内置),产物自包含,
  `mcp-server.js` 可被 DSH 用裸 node spawn(配 asarUnpack);renderer 的 `publicDir = assets`
  (dev 下 `/pet/**` 可访问),并加 `@live2d/framework` → `vendor/live2d/Framework/dist/src` 别名。
- `"type": "module"` 下 preload 输出为 `out/preload/index.mjs`,`webPreferences.sandbox: false`。
- CSP:`script-src 'self' 'unsafe-eval'`(Pixi 着色器 / Live2D Core 需要);`connect-src` 放行
  `ws: http://127.0.0.1:3080 ws://127.0.0.1:3080`。

## 3. preload / contextBridge 白名单(安全关键)

renderer 只能通过 `window.petApi` 调白名单方法(见 `shared/pet-event.ts` 的 `PetApi` 类型):

- 事件下行:`onPetEvent(handler)`、`onCursor(handler)`(主进程光标轮询,视角跟随用)
- DSH 操作:`getState / sendMessage / listSessions / getHistory / selectSession / createSession / respondApproval / listPlugins`
- 配置:`getConfig / setConfig`
- 纪律(0004):IPC 参数必须是可序列化标量,`undefined`/`NaN` 在 preload 边界收敛(`toFinite`/`String`),
  renderer 与主进程 handler 不透传原始值。

## 4. 主进程 DSH 连接

- 载体:`AbstractApiClient` 子类覆写 `resolveBase()` → `http://127.0.0.1:3080`(Node fetch 上行)。
- 下行:`ws` 连 `/api/events.mux` + `/api/events.host`(DSH 事件流只接受 WebSocket,SSE 返回 426)。
- 生命周期:`ConnectionController` 负责握手/断线重连;事件经 `PetEvent` 归一化后 `webContents.send` 推给 renderer。
- renderer **不直连 DSH**(webserver 无 CORS,浏览器跨源会被拦),连接必须放主进程。

## 5. 事件 → 状态机 → 表现

DSH 帧 → `PetEvent`(主进程归一化)→ XState 迁移(`pet-machine.ts`)→ `PetAnimator.play(state)`
→ Live2D 运行时切状态/跟随/眨眼/呼吸。**不要在动画回调里直接调 `/api`**(表现与逻辑分离)。

## 6. 打包(Windows)

`electron-builder.yml`:appId/productName、NSIS + portable、asarUnpack(mcp-server.js)。产物见 `out/`。

> 涉及动态 Cordis 插件、Remote 绑定、composition 配置时,务必先加载 `cordis-plugin-development` 与
> `editing-cordis-compositions` 两个 skill 再动手。
