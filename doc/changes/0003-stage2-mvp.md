# 0003 · 阶段 2:MVP —— 透明宠物窗口 + 占位动画管线 + 状态机 + 气泡发消息

**状态**:已验证
**日期**:2026-08-15
**对应路线图**:doc/06 阶段 2(最小可用宠物 MVP)

---

## 目的

1. 透明无边框置顶窗口 + 托盘(桌面宠物壳)。
2. **可插拔动画管线**:PetAnimator 接口 + 占位"球宠"(PixiJS 几何图形),素材到位只换实现不换接口——这是将来换 Live2D/Lottie 的架构锚点。
3. XState 把"DSH 空闲/忙碌/完成/报错"映射成 ≥4 个语义状态(idle/thinking/happy/sad/talking)。
4. 气泡输入框 → `session.prompt` 发消息到 DSH 会话。
5. turn/end 完成事件 → 气泡提示 + happy 动作。

## 改动清单

### 依赖

| 包 | 版本 | 位置 |
|---|---|---|
| `pixi.js` | ^8.19.0 | apps/pet dependencies(角色渲染) |
| `xstate` | ^5.32.5 | apps/pet dependencies(状态机) |

根仓库仅 `pnpm-lock.yaml` 变化。

### apps/pet —— 主进程

| 文件 | 内容 |
|---|---|
| `src/main/index.ts` | 窗口改为宠物壳:`frame:false` + `transparent:true` + `alwaysOnTop:true` + `resizable:false` + `skipTaskbar:true` + `hasShadow:false`;新增 IPC:`pet:send-message`(ensureTargetSession → `session.prompt`)、`pet:drag-start/move/end`(屏幕坐标增量 setPosition);移除阶段 1 的 PoC 调试 IPC(list-sessions / debug-reconnect) |
| `src/main/tray.ts`(新) | 托盘:显示/隐藏 + 退出,双击切换;图标占位 `assets/pet/icons/tray.png` |
| `src/main/dsh/connection.ts` | 帧富化:`dsh:frame` 携带 `eventType`(session/event 帧的 SessionEvent.type);新增语义事件 `dsh:turn-start` / `dsh:turn-end`(turn 生命周期) |
| `src/preload/index.ts` | 白名单更新:`sendMessage` / `dragStart` / `dragMove` / `dragEnd`(移除 PoC 的 listSessions / debugReconnect) |

### apps/pet —— renderer

| 文件 | 内容 |
|---|---|
| `index.html` | 透明窗口 UI:舞台 + 气泡 + 底部输入条 + 角落状态;CSP script-src 增加 `'unsafe-eval'`(见踩坑 1) |
| `src/fsm/pet-machine.ts`(新) | XState 状态机:5 个语义状态,happy/sad/talking 延时自动回 idle;事件 DSH_WORKING / DSH_DONE / DSH_ERROR / TALK |
| `src/pet/animator.ts`(新) | **PetAnimator 接口**——换动画后端的成本锚点:`play(state)` / `tick(dt)` / `dispose()` |
| `src/pet/stage.ts`(新) | PixiJS v8 透明舞台(backgroundAlpha 0,resizeTo window),角色层独立容器 |
| `src/pet/sprite-animator.ts`(新) | 占位后端:几何"球宠"(身体/眼睛/嘴随状态变化:idle 缓跳、thinking 快跳+抬眼、happy 大跳+微笑、sad 低垂+撇嘴、talking 嘴开合) |
| `src/pet/assets.ts`(新) | 素材加载占位:当前返回空 → 回落几何占位;素材到位后在此加载 sprites/<state>/ 贴图 |
| `src/main.ts` | 装配:createStage → animator → createActor(machine);DSH 事件 → 机器事件;气泡;拖拽;输入发送 |

### apps/pet —— 其他

| 文件 | 内容 |
|---|---|
| `assets/pet/icons/tray.png` / `icon.png` | 占位图标(System.Drawing 生成:橙色圆 + 眼睛 + 微笑),后续换角色头像 |
| `electron.vite.config.ts` | renderer `publicDir` = `apps/pet/assets`(dev 下 `/pet/**` 可访问,build 拷入 out/renderer) |
| `AGENTS.md` | 更新 renderer 布局描述 + 已知事实(PixiJS 需要 unsafe-eval、PetAnimator 架构) |

## 关键决策

1. **动画可插拔(核心)**:状态机只输出语义状态名;`PetAnimator` 接口是唯一懂动画后端的层。换 Lottie/Live2D = 新增一个实现类 + 换素材,状态机/事件/UI 零改动(doc 01 §7"表现与逻辑分离")。
2. **占位动画先行**:没有素材就用 PixiJS 几何图形把"状态机 → play(state) → 动画循环"整条管线跑通;素材到位后 `sprite-animator.ts` 内部换成贴图播放,接口与外部调用不变。
3. **阶段 2 暂不引入 React/Zustand/Tailwind**:doc 02 MVP 集里的 UI 框架推迟——当前 UI(气泡/输入条/状态)vanilla DOM 足够且轻;等设置面板等复杂 UI 出现再引入,避免一上来铺太大。已在 AGENTS.md 注明。
4. **窗口拖拽走 IPC**:renderer 传 `screenX/screenY`(CSS px),主进程按"窗口起点 + 屏幕坐标增量"setPosition,天然适配 DPI,无边框窗口必备。
5. **目标会话策略**:`sessions.list` 取最近更新的会话,没有则 `session.create` 新建;`session.prompt` 用 `mode:'queue'`(排队即发送)。
6. **CSP 允许 unsafe-eval**:PixiJS v8 的 WebGL 着色器生成需要 eval;本应用纯本地、脚本全为自有代码,风险可控,代价是 Electron 的 dev 安全警告(打包后不再显示)。

## 踩坑记录

### 坑 1:PixiJS v8 被 CSP 拦(unsafe-eval)
启动即报 `Current environment does not allow unsafe-eval, please use pixi.js/unsafe-eval module`。PixiJS v8 默认入口检测 eval 可用性,被 CSP 禁则抛错。解法:script-src 加 `'unsafe-eval'`(决策 6)。备选(未采用):自编译/预编译着色器,复杂度不值。

### 坑 2:async 初始化 vs 连接握手的时序
`createStage()` 是异步(Pixi init 数百 ms),期间连接握手已完成,首个 `dsh:connected`/`dsh:state` 在订阅注册前发出 → 事件处理器看不到。靠 `getState()` 补读兜底(阶段 1 已设计,继续沿用);帧/turn 事件错过窗口极小,可接受。

### 坑 3:TS 窄化 + 函数声明提升
`send()` 用 `function` 声明会提升到 boot 作用域顶部,逃过 `if (!api) return` 的窄化 → `'api' is possibly 'undefined'`。改箭头函数 `const send = () => {...}` 即修复(经典陷阱,阶段 2 再踩一次)。

### 坑 4:`noUncheckedIndexedAccess` 下的解构
`const [x, y] = win.getPosition()` 得到 `number | undefined`。用 `const [x = 0, y = 0] = ...` 默认值修复。

### 坑 5:`SessionId` 是品牌类型
`session.list/create` 的返回值是 branded `SessionId`,不能当普通 string 传;类型从 `@deepseek-ai/dsh-client-connection/client` 类型导入(type-only,擦除后无运行时副作用,浏览器包也不会崩)。

### 坑 6:逐帧 IPC + console 日志噪音(帧风暴)
调试时每帧都 IPC + console,`assistant/chunk` 每秒几十条刷屏。已移除 renderer 逐帧日志;帧转发仍在(dsh:frame),但 renderer 不再消费。**遗留:帧节流/批量**(doc/0002 已预告,阶段 3 前做)。

## 验证结果

- `pnpm --filter @deepseek-ai/dsh-pet run typecheck` ✅ exit 0
- `pnpm dev` 实测:
  - 透明无边框窗口启动,无窗口/渲染错误
  - PixiJS 占位球宠渲染(idle 跳动)
  - IPC 链验证:空消息被 handler 拒绝(`empty message`)→ invoke 全链路通
  - **mux 帧实时涌入**:`session/event/assistant/chunk`、`assistant/message`、`tool/call`、`session/projection`——宠物实时看到 DSH 会话活动,状态机随 turn 事件流转

## 遗留 / 后续

- **真实消息端到端**:未自动发送(会驱动用户 live session)。窗口已在用户桌面运行,**在输入框打字即可验证**:发送 → agent 工作(thinking)→ turn-end → 气泡"✓ 完成"+ happy。
- **素材到位**:`assets/pet/sprites/<state>/` 贴图就绪后,实现 `sprite-animator.ts` 的贴图版 + `assets.ts` 加载;换 Live2D 走 `PetAnimator` 新实现(1~2 天,接口零改动)。
- **帧节流/批量**:IPC 风暴保护(renderer 目前不消费 dsh:frame,可暂停转发)。
- **React/Zustand/Tailwind**:设置面板/复杂 UI 阶段引入。
- **阶段 3(关键操作面)**:会话列表/切换、审批、系统通知、开机自启、单实例。
