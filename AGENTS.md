# AGENTS.md

DSH 桌面宠物 —— DeepSeek Harness 的**第二个、常驻、对等客户端**:一个独立 Electron 窗口,既能通过 DSH 的 `/api` + WebSocket 主动操作/观察 DSH,又能作为 MCP server 被 DSH Agent 反驱动(Agent → 宠物)。设计见 [doc/01-architecture.md](./doc/01-architecture.md),按 [doc/06-roadmap.md](./doc/06-roadmap.md) 分阶段推进,每步改动记录在 [doc/changes/](./doc/changes/README.md)。

## Repository layout

```
src/main/       主进程:窗口、托盘(阶段2+)、DSH 连接、PetEvent 总线、MCP server(阶段4)
src/preload/    contextBridge 白名单(renderer 与主进程的唯一通道)
src/renderer/   表现层:React/Zustand/XState/PixiJS(阶段2+)
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
- `"type": "module"` 下 electron-vite 把 preload 输出为 `out/preload/index.mjs`,主进程引用它且 `webPreferences.sandbox: false`。
- `apps/pet` 的 tsconfig 继承仓库 base 但**清空 `paths`**:workspace 依赖走 `node_modules` 里已构建的 `lib/types/*.d.ts`;若类型报"找不到模块",先确认对应包构建产物存在(根仓库 `pnpm run build:lib`)。
