# 0009 · 阶段 5:打包与常驻 —— NSIS/portable 安装包、单实例、开机自启、配置持久化

**状态**:已验证
**日期**:2026-08-15
**对应路线图**:doc/06 阶段 5(打包与常驻,可分发、可常驻的 exe)

---

## 目的

把宠物从"开发态 electron-vite 进程"变成**可分发、可常驻的 Windows exe**:

1. electron-builder 打出 **NSIS 安装包 + portable 免安装版**(国内镜像配置已生效);
2. **开机自启** + **单实例锁**(second-instance 唤起已运行实例);
3. **应用图标**(确认占位图可用,并生成多尺寸 .ico);
4. **配置持久化**(等价 electron-store 的零依赖实现):DSH 地址、外观(透明度/缩放)、语音开关、目标会话记忆;
5. 阶段 4 的 **MCP server 独立入口纳入打包**(asarUnpack + 共享 chunk),DSH 能 spawn 打包后的 server。

## 改动清单

### apps/pet —— 依赖与配置

| 文件 | 改动 |
|---|---|
| `package.json` | devDependencies 加 `electron-builder@^26.0.0`;新增 `dist` / `dist:dir` 脚本(走独立目录打包);补 `author`(NSIS 元信息需要) |
| `electron-builder.yml`(新) | appId/productName/electronVersion=43.4.0;files: out+assets;**asarUnpack: mcp-server.js + out/main/chunks/***;win: nsis + portable;nsis 可选安装目录;镜像兜底 |
| `scripts/package.mjs`(新) | 打包工作流:把 out/assets/build 复制到**工作区外**临时独立目录,在那里跑 electron-builder,产物输出到 `apps/pet/dist/`(为什么必须独立目录见踩坑 1/2) |
| `scripts/make-icon.ps1`(新) | 由 `assets/pet/icons/icon.png` 生成多尺寸 `build/icon.ico`(16–256,纯 System.Drawing,零依赖) |
| `build/icon.ico`(新) | 生成的应用图标(NSIS/exe 用;托盘仍用 tray.png) |
| `scripts/mcp-server-boot-test.mjs`(新) | 验证脚本:用裸 node spawn 打包/未打包的 mcp-server,证明自包含 |

### apps/pet —— 源码

| 文件 | 改动 |
|---|---|
| `src/shared/pet-config.ts`(新) | 配置类型 + 默认值(`dsh.baseUrl` / `appearance.opacity/scale` / `voice.enabled` / `launchAtLogin` / `targetSessionId`);纯类型文件,node/web 双 tsconfig 共用 |
| `src/main/config.ts`(新) | `PetConfigStore`:userData/config.json 读 + 原子写(tmp→rename);合并默认值、baseUrl 归一化、数值 clamp;失败不崩溃 |
| `src/main/index.ts` | 重构为 `bootstrap()`;顶部单实例锁(`requestSingleInstanceLock`,失败即退出);`second-instance` → 唤起/聚焦窗口;`app.setName('DSH Pet')` 统一 dev/prod userData;启动时应用持久化配置(目标会话/外观/自启);`pet:get-config`/`pet:set-config` IPC(改 DSH 地址 → 重建连接,外观 → setOpacity/setBounds,自启 → setLoginItemSettings);`setTargetSessionId` 回调同时落盘 |
| `src/main/dsh/client.ts` | `DshApiClient` 构造器改为注入 `getBaseUrl`(读配置),删除硬编码 `DSH_BASE_URL` |
| `src/main/dsh/connection.ts` | `createConnection(onEvent, getBaseUrl)` 透传基址读取器 |
| `src/preload/index.ts` | 白名单新增 `getConfig`/`setConfig`,扁平补丁在 preload 边界做 String/toFinite/Boolean 收敛(0004 纪律) |
| `src/shared/pet-event.ts` | `PetApi` 新增 getConfig/setConfig |
| `src/renderer/src/ui/panel.ts` | 面板新增「设置」tab:DSH 地址应用、透明度/缩放滑块(120ms 防抖)、开机自启/语音开关;打开 tab 时回填配置 |
| `src/renderer/index.html` | 设置 tab 结构与样式(CSS);CSP 无需改(renderer 仍不直连 DSH) |
| `src/renderer/src/pet/stage.ts` | `resize` 监听重定位角色锚点(窗口缩放后宠物仍居中) |
| `electron.vite.config.ts` | main **移除 externalizeDepsPlugin** → 全量打包成自包含 bundle(保留 electron/node 内置 external);preload 不变 |

### 根仓库(harness)

| 文件 | 改动 |
|---|---|
| `pnpm-lock.yaml` | electron-builder 依赖树(含 @electron/get 5.1.0 override 后的解析) |
| `pnpm-workspace.yaml` | `allowBuilds` 加 `electron-winstaller: false`(Squirrel 工具链,不需要);`overrides` 加 `app-builder-lib>@electron/get: ^5.1.0`(见踩坑 3) |

## 关键决策

1. **主进程全量打包,产物零 node_modules**:`@deepseek-ai/dsh-host-apiproxy` 的 workspace 闭包有 30+ 包,若 externalize + 打包 node_modules,安装包会臃肿且依赖 pnpm 布局解析(易碎)。改为 Vite 把一切打进 `out/main/index.js` 与 `out/main/mcp-server.js`(各 ~190KB / 540KB),electron-builder 只打包 `out/** + assets/**`。副作用:mcp-server.js 因此**自包含**,DSH 可用裸 `node` 直接 spawn(配合 asarUnpack)。
2. **独立 staging 目录打包工作流**(`scripts/package.mjs`):electron-builder 不能在 monorepo 内原地打包(踩坑 1/2),脚本把已构建产物复制到 `%TEMP%/dsh-pet-pack`(无 node_modules/lockfile/workspace),在那里跑 builder;PM 检测回退到环境检测 → pnpm,`pnpm list` 只看到空依赖单条目 → 秒回;产物输出到 `apps/pet/dist/`。
3. **asarUnpack mcp-server.js + 共享 chunk**:DSH 用裸 node spawn mcp-server(node 读不了 asar),必须解出 asar;且 index 与 mcp-server 共享 `out/main/chunks/*`,chunk 不一起解出则相对 import 解析失败(踩坑 5)。
4. **配置持久化用手写 JSON 而非 electron-store**:设置项少、写频率低,`PetConfigStore`(~90 行)足够,还避免 electron-store(ESM-only)+ pnpm 的额外依赖风险;原子写(先写 .tmp 再 rename)防损坏。IPC 面用**扁平补丁**(`{dshBaseUrl?, opacity?, scale?, voiceEnabled?, launchAtLogin?}`),遵守 0004"IPC 参数必须可序列化标量"纪律。
5. **单实例锁在 whenReady 之前请求**(Windows 命名互斥量),拿不到锁的实例直接 `app.quit()`;已运行实例经 `second-instance` 事件 restore+show+focus。开机自启用 `app.setLoginItemSettings({ openAtLogin })`(NSIS 安装版写 HKCU Run)。
6. **图标走"确认占位可用 + 生成 .ico"路线**:`icon.png`(256×256,32bpp ARGB,内容包围盒 32–224)确认是带透明底的角色占位图,可先用;`make-icon.ps1` 生成 7 尺寸 DIB 结构 .ico,后续换正式头像只需替换 icon.png 重跑脚本。
7. **electronVersion 精确写死 43.4.0**:electron-builder 要下载对应版本二进制,不接受 `^43.4.0` 范围(踩坑 6)。

## 踩坑记录

### 坑 1:electron-builder pnpm 依赖收集器在 monorepo 根上卡死(20+ 分钟)
`collectNodeModulesWithLogging` 的搜索目录 = `[appDir, projectDir, workspaceRoot]` —— 在 apps/pet 原地打包时,**workspaceRoot 被当成搜索目录**,pnpm collector 跑 `pnpm list --prod --json --depth Infinity`(v11 输出全 59 包工作区树,3.7MB),再对每个包做磁盘探测(`locatePackageVersion`),实测 25 分钟无进展。解法:独立 staging 目录(无 workspace 祖先)打包,`pnpm list` 秒回单条目。

### 坑 2:npm collector 被 "Active code page: 65001" 污染(Windows PowerShell 批处理回显)
逃过坑 1 后(env 剥离导致 PM 检测落到 npm),npm collector 在 Windows 用 `powershell.exe -EncodedCommand` 执行 `npm.cmd`,`chcp` 回显 "Active code page: 65001" 混进 stdout,`extractJsonFromPollutedOutput` 的 bracket 扫描找不到干净 JSON → "No JSON content found in output"。解法:不剥离 env,让 PM 检测命中 pnpm(独立目录下 pnpm list 干净且快)。

### 坑 3:app-builder-lib 26.15.3 声明 @electron/get@^3,代码却用 v5 枚举
打包报 `Cannot read properties of undefined (reading 'ReadWrite')` —— `electronGet.js` 用 `ElectronDownloadCacheMode`(v5 才有),但 package.json 声明 `^3.0.0` 解析到 3.0.0。electron@43 已用 @electron/get@5.1.0。解法:pnpm `overrides` 加 `'app-builder-lib>@electron/get': '^5.1.0'`。

### 坑 4:pnpm 11 拦截 electron-winstaller 的 build script
electron-builder 的传递依赖 `electron-winstaller`(Squirrel.Windows 工具链)有 install 脚本,allowBuilds 未放行 → install 整体报 `[ERR_PNPM_IGNORED_BUILDS]`。我们不打 squirrel target,`allowBuilds` 显式 `electron-winstaller: false` 即可(pnpm 会顺手往 workspace 文件写占位行,改成 false)。

### 坑 5:mcp-server 与 index 共享 rollup chunk,chunk 必须一起 asarUnpack
index 与 mcp-server 都 import `./chunks/mcp-bridge-*.js`(zod/协议共享段)。只 unpack mcp-server.js 时,DSH 裸 node spawn 会因找不到 chunk 报 `ERR_MODULE_NOT_FOUND`。`asarUnpack` 加 `out/main/chunks/*` 后,打包版 mcp-server 用 MCP SDK 握手 + listTools + 工具调用全部通过。

### 坑 6:electronVersion 必须是精确版本
`electronVersion: "^43.4.0"` → 报 "is a range, not a fixed version"。electron-builder 需要精确版本去下载对应平台二进制;在 electron-builder.yml 写死 `43.4.0`。

### 坑 7(好消息):这次 pnpm install 没弄丢 electron 二进制
0008 记录过 install 后 electron 二进制丢失;本次两次 install(加 electron-builder、加 override)后 `apps/pet/node_modules/electron/dist/electron.exe` 均在位,未触发 install.js 修复。

## 验证结果

- `pnpm --filter @deepseek-ai/dsh-pet run typecheck` ✅ exit 0(node + web 双配置)
- `pnpm --filter @deepseek-ai/dsh-pet run build` ✅ out/main/index.js(190KB)+ mcp-server.js(540KB)+ preload + renderer;grep 确认 bundle 只 external `electron`/`node:*` 内置
- **自包含 mcp-server**(dev 构建产物):裸 `node out/main/mcp-server.js` + MCP SDK 客户端 → listTools = speak/setExpression/notify,三个工具调用均执行(bridge 未监听时返回错误文本不崩溃)✅
- **打包版 mcp-server**(`dist/win-unpacked/resources/app.asar.unpacked/out/main/mcp-server.js`):同上 MCP SDK 握手成功,tools 注册、handler 执行 ✅ —— 证明 DSH 改指向打包路径即可 spawn
- **win-unpacked 应用启动**:`dsh-pet.exe` 启动 8s 存活(单实例锁/配置/窗口/连接/桥全部初始化,无崩溃)✅
- **单实例**:启动第二个实例 → 3s 内退出,第一实例存活 ✅
- **portable**:`DSH Pet-Portable-0.1.0-rc.5.exe` 自解压启动,dsh-pet 主进程 + 渲染/GPU 进程正常 ✅
- **NSIS**:`DSH Pet-Setup-0.1.0-rc.5.exe`(95.7MB)+ blockmap 生成(nsis 工具链走 npmmirror 镜像下载成功)
- **dev 模式**:`pnpm --filter @deepseek-ai/dsh-pet run dev` 窗口正常,vite connected(仅预期的 CSP dev 警告)
- **asar 内容**:31 个条目,`out/**` + `assets/**` + package.json,node_modules 为 0

## 遗留 / 后续

- **NSIS 实际安装**:安装向导(UAC/快捷方式/可选目录)需用户跑一遍 Setup exe 确认;开机自启需在设置页勾选后重启验证(HKCU Run 项)。
- **打包版 DSH mcp-client 指向**:用户 `C:\Users\wanyu\.dsh\profiles\web\cordis.patch.yml` 的 args 目前指向 `apps/pet/out/main/mcp-server.js`(开发态);安装版应指向 `<install>/resources/app.asar.unpacked/out/main/mcp-server.js`(改完需重启 DSH)。
- **语音开关**:仅持久化,阶段 6(TTS)接入后生效。
- **图标**:当前为占位角色图,正式头像替换 `assets/pet/icons/icon.png` 后重跑 `scripts/make-icon.ps1`。
- **配置无迁移**:阶段 5 之前无配置,userData 目录直接新起;后续若改 schema,建议写迁移而不是覆盖。
- 窗口缩放改动后 renderer 重载阶段(stage.ts resize 监听已加)需要人工把玩确认动画锚点。
