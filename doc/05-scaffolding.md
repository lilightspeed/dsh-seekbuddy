# 05 · 工程脚手架(`apps/pet`)

> 目标:在 harness monorepo 里新建 `apps/pet`,用 electron-vite 组织 Electron 的三段(main / preload / renderer),直接 `workspace:^` 引用 DSH 的 client 包。以下为目录结构与配置骨架,具体字段以你实际安装的 electron-vite / electron-builder 版本为准。

## 1. 目录结构(建议)

```
apps/pet/
├── package.json
├── electron.vite.config.ts
├── tsconfig.json
├── electron-builder.yml
├── src/
│   ├── main/
│   │   ├── index.ts              # 主进程入口:创建窗口/托盘/单实例
│   │   ├── window.ts             # 透明置顶无边框窗口封装
│   │   ├── tray.ts               # 托盘菜单
│   │   ├── dsh/
│   │   │   ├── client.ts         # 装配 IApiClient(renderer 用 WebApiClient 或 Node 载体)
│   │   │   └── connection.ts     # ConnectionController 生命周期
│   │   ├── events/
│   │   │   └── pet-event-bus.ts  # DSH 帧 → 归一化 PetEvent
│   │   └── mcp/
│   │       └── server.ts         # MCP server(暴露 pet.* 工具)
│   ├── preload/
│   │   └── index.ts              # contextBridge 白名单
│   └── renderer/
│       ├── index.html
│       └── src/
│           ├── main.tsx          # React 入口
│           ├── App.tsx
│           ├── store/            # Zustand
│           ├── fsm/              # XState 状态机
│           ├── pet/              # PixiJS 舞台 + 角色
│           └── components/       # 气泡/设置面板
└── assets/
    └── pet/                      # 精灵图 / Lottie / Live2D 模型
```

## 2. `package.json`(骨架)

```jsonc
{
  "name": "@deepseek-ai/dsh-pet",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./out/main/index.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "dist": "electron-vite build && electron-builder",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@deepseek-ai/dsh-client-connection": "workspace:^",
    "@deepseek-ai/dsh-host-apiproxy": "workspace:^",
    "@modelcontextprotocol/sdk": "^1.12.0",
    "ws": "^8.21.0",
    "zustand": "^5.0.0",
    "xstate": "^5.0.0",
    "pixi.js": "^8.0.0",
    "react": "^18.3.0",
    "react-dom": "^18.3.0"
  },
  "devDependencies": {
    "electron": "^latest",
    "electron-vite": "^latest",
    "electron-builder": "^latest",
    "@vitejs/plugin-react": "^latest",
    "typescript": "^6.0.0",
    "@types/node": "^22.0.0",
    "@types/react": "^18.0.0",
    "@types/react-dom": "^18.0.0",
    "@types/ws": "^8.18.0"
  }
}
```

> `workspace:^` 只在本 monorepo 内生效。若最终改独立仓库,需换成已发布版本号或 path 依赖。

## 3. `electron.vite.config.ts`(骨架)

```ts
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()], // 主进程把依赖当外部包,不打包 Node 内建
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    plugins: [react()],
  },
})
```

> `@deepseek-ai/dsh-client-connection/client` 是纯 client-safe 类型 + 传输代码;若在主进程打包时遇到 Node 内建或包根副作用问题,优先用 `externalizeDepsPlugin()` 处理,再按报错调整。

## 4. preload / contextBridge 白名单(安全关键)

renderer 不直接碰 Node/网络。主进程把"宠物能用的能力"以白名单形式暴露:

```ts
// preload/index.ts(示意)
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('petApi', {
  // 只暴露最小必要能力
  sendUserMessage: (sessionId: string, text: string) =>
    ipcRenderer.invoke('pet:send-message', { sessionId, text }),
  approve: (requestId: string, ok: boolean) =>
    ipcRenderer.invoke('pet:approve', { requestId, ok }),
  onPetEvent: (handler: (event: PetEvent) => void) => {
    const listener = (_e, payload) => handler(payload)
    ipcRenderer.on('pet:event', listener)
    return () => ipcRenderer.removeListener('pet:event', listener)
  },
  setExpression: (expression: string) => ipcRenderer.invoke('pet:set-expression', { expression }),
})
```

原则:renderer 只能通过 `window.petApi` 调用白名单方法,**永远不把 `ipcRenderer` 或完整连接对象直接暴露**。

## 5. 主进程连接装配(骨架)

```ts
// main/dsh/connection.ts(示意)
import { ConnectionController, WebApiClient } from '@deepseek-ai/dsh-client-connection/client'

export function createConnection(bus: PetEventBus): ConnectionController {
  const api = new WebApiClient({ baseUrl: 'http://127.0.0.1:3080' })
  return new ConnectionController(api, {
    onConnected(description) {
      bus.emit({ type: 'dsh:connected', description })
    },
    onMuxEnvelope(envelope) {
      bus.emit(toPetEvent(envelope))      // 归一化成 PetEvent
    },
    onHostEnvelope(envelope) {
      bus.emit(toPetEvent(envelope))
    },
    onStateChange(state) {
      bus.emit({ type: 'dsh:connection', state })
    },
  })
}
```

> `WebApiClient` 需要 `fetch` + `WebSocket` 的上下文(renderer 可用;主进程 Node 18+ 有 `fetch`,但 `WebSocket` 需 `ws` 或 Node 内置版本)。若要放主进程,改用一个基于 `AbstractApiClient` 的 Node 载体(上行 `undici`,下行 `ws`)。

## 6. 事件 → 状态机 → 表现

```ts
// renderer/fsm(示意,用 XState)
const petMachine = createMachine({
  id: 'pet',
  initial: 'idle',
  states: {
    idle: { on: { DSH_WORKING: 'thinking' } },
    thinking: { on: { DSH_DONE: 'idle', DSH_ERROR: 'error' } },
    error: { on: { DSH_RECOVER: 'idle' } },
  },
})
```

DSH 帧 → `PetEvent` → XState 迁移 → 动画/气泡动作。不要在动画回调里直接调 `/api`。

## 7. 打包(Windows)

`electron-builder.yml` 骨架:

```yaml
appId: com.example.dsh-pet
productName: DSH Pet
directories:
  output: dist
win:
  target:
    - nsis
    - portable
nsis:
  oneClick: false
  allowToChangeInstallationDirectory: true
```

## 8. 开工顺序

1. 先只做连通性 PoC:renderer 里 `WebApiClient` + `host.describe` + 订阅两条 WS,打印帧,确认能连上当前 `127.0.0.1:3080`。
2. 跑通一条 session 操作(如列会话)。
3. 再补窗口/托盘/preload 白名单/PixiJS。
4. 最后接 MCP server。

> 涉及动态 Cordis 插件、Remote 绑定、composition 配置时,务必先加载 `cordis-plugin-development` 与 `editing-cordis-compositions` 两个 skill 再动手。
