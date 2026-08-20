# AGENTS.md

DSH 桌面宠物 —— DeepSeek Harness 的**第二个、常驻、对等客户端**:一个独立 Electron 窗口,既能通过 DSH 的 `/api` + WebSocket 主动操作/观察 DSH,又能作为 MCP server 被 DSH Agent 反驱动(Agent → 宠物)。设计见 [doc/01-architecture.md](./doc/01-architecture.md),按 [doc/06-roadmap.md](./doc/06-roadmap.md) 分阶段推进,每步改动以 git 提交记录(见 Conventions;历史改动档案见 [doc/changes/](./doc/changes/README.md),已停用)。

## Repository layout

```
src/main/       主进程:窗口、托盘、DSH 连接、PetEvent 总线、MCP server/bridge、光标轮询
src/preload/    contextBridge 白名单(renderer 与主进程的唯一通道)
src/renderer/   表现层:Live2D(官方 Cubism SDK 独立 canvas)+ PixiJS 占位 + XState 状态机 + vanilla DOM 气泡/输入
doc/            技术指导文档(01 架构 … 08 Live2D);changes/ 为历史改动档案(约定已停用,不再新增)
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
- **每次改动都提交 git**:每完成一步(阶段或独立修复),用 conventional commits(如 `feat(pet): …` / `chore(pet): …`)立即提交,不攒多次改动;**不再写 `doc/changes/` 改动文档**(该目录为历史档案,约定已停用);**不改写历史文档**。
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
- **动画可插拔**:状态机只输出语义状态(`idle/thinking/happy/sad/talking`),`PetAnimator` 接口(`src/renderer/src/pet/animator.ts`)是唯一懂动画后端的层——换 Lottie/Live2D 只加实现类,状态机/事件/UI 零改动。**现役后端是 Live2D**(`createLive2dAnimator`,官方 Cubism SDK + 独立 canvas 自绘,见 `pet/live2d/` 与 `vendor/live2d/README.md`);占位实现是 PixiJS 几何"球宠",WebGL2 不可用时回落。
- **动画互斥/优先级走 AnimationDirector(doc/09,0037t)**:animator 只发 `director.request(spec)`(摸头/sad 等),同通道互斥、优先级打断、hold 冻结、眨眼接管、兜底复位由导演集中管理——**不要**在 animator 手写 `patActive`/`holdFrozen` 之类标志位。新增动画的唯一登记处是 `animation-registry.ts` 的 `ANIMATIONS`(声明 channel/priority/mode/autoBlink 等,仲裁与播放代码零改动);runtime 每通道独立 motion 队列,start 前 stop 同通道(物理兜底,绕过导演也不可能并行)。`AnimationChannel = 'expression' | 'action'` 定义在 `pet/live2d/runtime.ts`(底层,避免 director 反向依赖)。
- **Live2D 运行时事实**:SDK vendor 在 `vendor/live2d/`(Framework 编译产物走 `@live2d/framework` 别名,Core 全局经 index.html script 引入);着色器在 `assets/pet/live2d/shaders/`;每帧必须按 `loadParameters → 写跟随参数 → saveParameters → 调度器 → model.update` 节奏(加算型更新器如呼吸,缺了会跨帧累加被 clamp 钉死,0019)。**motion 时间线是 per-channel 的(0037w)**:曲线按 `channelTime = motionTime + channelTimeOffset` 求值,按住摸头的 4x 加速只累加该通道 offset(`setMotionRate`),`getMotionElapsed`/`seekMotion`/`startMotion` 起点统一用 channelTime;`stopChannel` 只清 rate 不清 offset(时间线平移无害,下个动画起点按新 channelTime 记录)。
- **Live2D motion 播放四坑(0037 实测)**:
  1. `CubismMotion.create` 后**必须 `setEffectIds([], [])`**(本模型 EyeBlink/LipSync 组为空;不调则 `_eyeBlinkParameterIds` 为 null,`doUpdateParameters` 首帧抛 `null.length` TypeError → 动画器 tick 崩溃、模型定格)。若素材加了 Effect 组,传 model3.json Groups 里的 Ids。
  2. `CubismMotion.create` **不读 json 的 `Loop` 字段**(create 内赋值被注释),须按配置显式 `setLoop`。**淡入淡出一律全局禁用(0047 规则)**:`startMotion` 里 `setFadeInTime(0)` + `setFadeOutTime(0)`(fadeWeight 恒 1,曲线按素材原值直写)——渐入渐出由用户在 Live2D 素材里制作,运行时绝不额外补;若出现"动画和 Live2D 里预览不一致",先确认是不是又加了 fade 配置。`_motionBehavior` 默认已是 V2(不用设)。
  3. **SDK fadeOut 拉向"当前值"而非默认值**:每帧 save 快照已含 motion 写的表情 → fadeOut 无法回归待机,表情残留。停止/自然结束须 `stopAllMotions()` 后由运行时把表情参数指数平滑拉回模型默认(`expressionReset`,`EXPRESSION_PARAM_IDS` 见 cubism-runtime.ts);非循环动画播完(队列 `isFinished`)也会自动复位。
  4. **loop 动画循环点跳变**:素材曲线首尾不一致(如摸头 `EyeLSmile` 0s=0 / 3.833s=1)时,循环点处表情闪没重来(V2 的 correctEndPoint + loop fade-in 只能平滑无法消除)。**摸头强制非循环**(MOTION_FILES 配置 loop:false),播一遍自然结束自动复位;素材曲线首尾对齐后才适合 loop(淡入已禁用,循环点跳变更要靠素材作者对齐曲线/在 Live2D 里画淡入淡出)。**序列动画(0050)**:若曲线首尾是序列**相邻状态**(如思考气泡点点走路 `___`→`.__`,中间态全亮 `...` 不允许在循环点闪现),V2 correctEndPoint 会把终点值线性扫回起点、**途经中间态** → 每圈闪出中间帧;注册表配置 `hardLoopRestart: true`(内部切 MotionBehavior_V1 硬跳)即可消除,素材不用改。
  5. **动画切换残留(0037u)**:startMotion 若整体取消上一动画的复位(expressionReset),新动画曲线**不覆盖**的参数会卡在残留值——sad(不驱动 EyeLOpen/EyeLSmile)接管摸头时,摸头的闭眼/微笑残留 → **两个表情叠加**。修复:startMotion 解析新动画 Curves 参数集(`parseMotionParamIds` 缓存于 motionParamIds),复位缩减为"新动画不驱动的参数"继续拉回(`keepUncoveredReset`);expressionReset 存 `{id, index}` 列表。**新增表情素材时留意其曲线驱动参数集**——换着打断测试(摸头↔sad)确认无残留。**随机变体(0044 `files[]`)的每个变体都要核对**(0051:exclaim1 变体的 `ParamStickerLightbulb` 漏进复位清单,灯泡贴纸播完卡住不消失)。
  6. **素材未写 FadeOutTime 时 SDK 默认 1.0s 淡出(0038)**:`ACubismMotion.parse` 里 `_fadeOutSeconds` 缺省 1.0(编辑器无此默认)——**短动作(如思考 0.5s)会被全程淡出压扁,曲线到不了终点值**(0038 实测:ParamArmRChange 只到 0.52,待机/思考两只右手各约 50% 半透明)。已在 `startMotion` 统一 `setFadeOutTime(0)` 禁用(0047:淡入淡出一并禁用,见坑 2);新增动作素材后若出现"动画播不完/值偏小",先查这条。
- **HitArea 命中(0037)**:Editor 里 `建模 → 图形网格 → 创建触碰检测用途的图形网格`(红框)→ 编辑纹理集 → 导出 = 标准流程;导出的 `model3.json` HitAreas 是**旧格式**(仅 `Id`/`Name`,Id 引用 moc3 里的触碰检测网格 drawable,**没有 X/Y/Width/Height**——正常,走网格命中而非矩形)。运行时 `parseHitAreas` 兼容新旧格式;`computeHeadMesh` 优先取 Id 对应 drawable 顶点,经 `buildProjectionMatrix`(渲染同款矩阵)映射到屏幕做**射线法点包含测试**(`hitTestPoint`),无网格回退矩形四角/估算。坐标语义:画布归一化左上原点;moc3 画布 `canvasWidth=1` 时渲染/换算走 else 分支适配。另:Name 可留空,匹配按 Name/Id 含 "head"。**drawable 顶点数组顺序不保证是环绕序**(0037k:原样连线会自交成沙漏,polygon 显示与射线法判定都错)——`makeHeadMesh` 统一过 Andrew 单调链凸包重排。
- **视角跟随的光标来自主进程轮询**:`#stage` 整窗是 `-webkit-app-region: drag`,拖拽区域会吞掉 renderer 的鼠标事件(0016)→ 主进程 33ms 轮询 `screen.getCursorScreenPoint()` + 窗口 bounds,经 `pet:cursor` 推给 renderer;**不要**在 renderer 里依赖 pointermove 做跟随。
- **PixiJS v8 要求 CSP 允许 `unsafe-eval`**(WebGL 着色器生成),renderer 的 CSP 已为此放开;代价是 Electron dev 期的安全警告(打包后消失)。
- **IPC 参数必须可序列化**:`undefined`/`NaN` 过 IPC 会触发主进程 `Error processing argument at index N, conversion failure` 崩溃。参数合法性在 **preload 边界统一收敛**(`toFinite` / `String`),renderer 与主进程 handler 不要透传原始值。
- **窗口拖拽用原生 `-webkit-app-region: drag`**(`#stage`),**不要**用 IPC 逐帧 `setPosition`(曾导致卡顿 + setPosition 参数转换崩溃)。可交互区域(输入条)必须标 `no-drag`;要点击宠物时在 `#stage` 上叠 `no-drag` 透明层。**窗口缩放(0056)同理**:renderer 铺 8 条透明 `no-drag` 边缘手柄,只在按下/松开时发 `pet:resize-start/end`(edge ∈ n/s/e/w/ne/nw/se/sw),尺寸计算在主进程 33ms 光标轮询里做(锚定对侧边 `setBounds`,夹取 MIN/MAX),**不做逐帧 IPC**。
