# 0001 · 阶段 0:脚手架搭建 + 国内网络镜像配置

**状态**:已验证
**日期**:2026-08-14
**对应路线图**:doc/06 阶段 0(准备),并完成阶段 0 → 阶段 1 的前置网络准备。

---

## 目的

1. 在 harness monorepo 里把 `apps/pet` 从"只有 doc/"变成**可运行的 electron-vite 工程**(空窗口能启动、类型编译通过)。
2. 解决国内网络环境下的依赖安装问题:registry / Electron 二进制 / electron-builder 工具链的镜像配置。
3. 验证核心前提:`workspace:^` 引用 `@deepseek-ai/dsh-client-connection/client` 能通过类型检查——这是后续全部 DSH 集成的地基。

## 改动清单

### 根仓库(harness monorepo,均未提交,由用户决定提交策略)

| 文件 | 改动 |
|---|---|
| `.npmrc`(新增) | `registry` → npmmirror;`electron_mirror` → `https://npmmirror.com/mirrors/electron/`;`electron_builder_binaries_mirror` → npmmirror 的 electron-builder 镜像 |
| `pnpm-workspace.yaml` | `allowBuilds` 增加 `electron: true`(pnpm 11 的构建脚本放行配置,见踩坑 1/2) |
| `scripts/check-workspace-constraints.ts` | `appPackageFiles` 增加 `'@deepseek-ai/dsh-pet': ['out', 'assets']`(仓库约束要求每个 app 有明确 files 策略) |
| `pnpm-lock.yaml` | 由 pnpm 自动更新(pet 依赖入锁) |

### apps/pet(独立 git 仓库,尚无提交,全部文件未跟踪)

| 文件 | 内容 |
|---|---|
| `package.json` | `@deepseek-ai/dsh-pet`;release member 字段齐备(publishConfig.access public / repository / files=`["out","assets"]`);脚本 `dev` / `build` / `start` / `typecheck`;deps 见下 |
| `electron.vite.config.ts` | main/preload 用 `externalizeDepsPlugin()`,renderer 空配置 |
| `tsconfig.json` | solution 文件,references 指向 node/web 两个子配置 |
| `tsconfig.node.json` | main + preload + electron.vite.config.ts;继承仓库 `tsconfig.base.json`;**清空 `paths`** 让 workspace 依赖走 node_modules 里已构建的 `lib/types/*.d.ts`;`lib: ["ES2024"]`;输出隔离到 `lib/types/node` |
| `tsconfig.web.json` | renderer;同上但 `lib: ["ES2024","DOM","DOM.Iterable"]`、`types: []` |
| `src/main/index.ts` | 创建 360×480 窗口;preload 引用 `../preload/index.mjs`(见踩坑 4);dev 加载 `ELECTRON_RENDERER_URL`,生产加载 `out/renderer/index.html`;`window-all-closed` 退出 |
| `src/preload/index.ts` | `contextBridge` 最小白名单探针(`petApi.platform`),阶段 3 再扩展 |
| `src/renderer/index.html` | 空页面 + CSP(connect-src 已为阶段 1 预留 `http://127.0.0.1:3080` / `ws://127.0.0.1:3080`) |
| `src/renderer/src/main.ts` | `import type { IApiClient } from '@deepseek-ai/dsh-client-connection/client'` 类型探针 + 就绪日志 |
| `.gitignore` | 忽略 `out/`、`dist/`、`node_modules/`、`lib/`、`*.tsbuildinfo` |

### 依赖版本(安装时解析)

- dependencies:`@deepseek-ai/dsh-client-connection@workspace:^`、`@deepseek-ai/dsh-host-apiproxy@workspace:^`、`ws@^8.21.0`
- devDependencies:`electron@^43.4.0`、`electron-vite@^5.0.0`、`typescript@^6.0.3`、`@types/node@^22.20.0`

> 刻意**不装**表现层依赖(React/PixiJS/Zustand/Tailwind 等):doc/02 MVP 最小集里它们属于阶段 2,先让"验证 DSH 连通"与"桌面壳层调试"互不干扰(doc 03 §8 同建议)。

## 关键决策

1. **工程形态 = monorepo 内 `apps/pet`**(doc/02 决策 A):直接 `workspace:^` 引用 client 包,类型零漂移,协议升级跟着仓库走。
2. **最小脚手架先行**:第一步只保证"空窗口 + 类型 + workspace 链接",不引入托盘/透明窗口/动画——把最大技术风险(DSH 连通)留到阶段 1 单独打掉。
3. **tsconfig 清空 `paths`**:继承仓库 base 的严格选项,但 workspace 依赖改从 `node_modules` 解析已构建的 `lib/types/*.d.ts`。好处:typecheck 快、自包含;与 doc 03 §9"开工前读 .d.ts"的建议一致。代价:若某依赖的构建产物缺失会报错(当前全仓库已构建,无此问题)。
4. **`@types/node` 对齐仓库 `^22`**:pnpm 默认解析到 26,与仓库(以及 Node 24 运行时的实际 API 面)不一致,主动改回。
5. **npmrc 放根仓库**:registry 与 electron 镜像对整个 monorepo 生效;`@deepseek-ai/*` 是 `workspace:` 本地链接,不受 registry 影响。

## 踩坑记录

### 坑 1:pnpm 11 不再读 `package.json` 的 `pnpm` 字段

先按旧习惯在根 `package.json` 加了 `pnpm.onlyBuiltDependencies`。pnpm 11 直接警告:

```
[WARN] The "pnpm" field in package.json is no longer read by pnpm.
The following keys were ignored: "pnpm.onlyBuiltDependencies".
```

**根因**:pnpm 10+ 把设置搬到了 `pnpm-workspace.yaml`;本仓库已用 `allowBuilds:` 键管理构建脚本放行。已撤销 package.json 改动,改为在 `pnpm-workspace.yaml` 的 `allowBuilds` 加 `electron: true`。

### 坑 2:pnpm 默认拦截依赖的 postinstall,electron 二进制没下载

装完 electron 后 `node_modules/.../electron/dist/electron.exe` 不存在,`pnpm rebuild electron` 也无输出。

**根因**:pnpm 10+ 默认不执行依赖的生命周期脚本(需在 allowBuilds 显式放行);且放行后,已安装过一次的包被记录为"已忽略"(`.modules.yaml` 的 `pendingBuilds: []`),`pnpm install` / `pnpm rebuild` 都不会回头重跑。

**解法**:直接执行 electron 的安装脚本,带镜像环境变量:

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
node node_modules/.pnpm/electron@43.4.0/node_modules/electron/install.js
```

验证 `dist/electron.exe` 存在 ✅。后续全新 clone 时,`allowBuilds` 已生效,`pnpm install` 会正常走 postinstall。

### 坑 3:`type: module` 下 preload 输出为 `.mjs`

主进程里 `preload: join(import.meta.dirname, '../preload/index.mjs')` 且 `sandbox: false`——这是 electron-vite 在 ESM 工程里的默认产物命名(实测 dev 构建输出 `out/preload/index.mjs` 确认)。若写成 `.js` 会加载失败。

### 坑 4:首次 `pnpm dev` 瞬时 exit 1

第一次 `pnpm dev` 在 "starting electron app..." 后以 exit 1 结束且无报错;直接运行 electron 二进制验证了窗口能存活,重跑 `pnpm dev` 即稳定(renderer 日志、vite HMR 均正常)。未深究,记录备查;若复现再排查(可能与首次启动/端口竞争有关)。

### 小坑:npmmirror 瞬时 ECONNRESET

安装过程中 npmmirror 对 `graceful-fs`、`@types/node` 两个包报过一次 ECONNRESET,自动重试后成功。属镜像抖动,不是配置问题。

## 验证结果

```powershell
# 1. 依赖安装(registry 走镜像)
pnpm --filter @deepseek-ai/dsh-pet add "@deepseek-ai/dsh-client-connection@workspace:^" ...   # exit 0

# 2. electron 二进制经镜像下载
Test-Path node_modules/.pnpm/electron@43.4.0/node_modules/electron/dist/electron.exe   # True

# 3. 类型检查(node + web 两个配置)
pnpm --filter @deepseek-ai/dsh-pet run typecheck   # exit 0,无错误

# 4. 空窗口启动
pnpm --filter @deepseek-ai/dsh-pet run dev
# 输出关键行:out/main/index.js ✓、out/preload/index.mjs ✓、dev server at http://localhost:5173/
# renderer 日志:"[pet] renderer ready, api probe = undefined"、"[vite] connected."

# 5. 仓库约束 gate
pnpm exec tsx scripts/check-workspace-constraints.ts   # exit 0
```

## 遗留 / 后续

- **阶段 1 连通性 PoC**(下一步):renderer 装配 `WebApiClient({ baseUrl: 'http://127.0.0.1:3080' })` + `ConnectionController`,`host.describe` 握手、订阅 `/api/events.mux` + `/api/events.host`、跑通一条 session 操作。
- **未跑全量 hygiene gate**(`pnpm run hygiene` 含 knip / publint 等):新 workspace 成员可能触发新告警,阶段 1 前或提交前补跑。
- **未提交任何改动**:根仓库 4 个文件 + apps/pet 全部新文件,提交策略由用户决定。
- `doc/07` 的 TS 学习路线建议配合本阶段代码阅读(`tsconfig.*.json` 的 `extends` / `paths` 清空即是很好的 strict 配置样例)。
