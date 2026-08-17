# 0026 · 输入框多行自动增高 + 发送/停止按钮

## 状态

已验证(2026-08-17;typecheck 通过)

## 日期

2026-08-17

## 目的

两个功能:

1. **输入框多行化**:输入框原本是单行 `<input>`,没有换行逻辑。改为多行 textarea:
   文本长度接近"发送"按钮时自动换行,每换一行输入框增高一行文本高度;当输入框高度
   接近右上角"菜单"按钮(☰)时停止增高,改为在输入框内用滚轮翻看输入内容。
2. **发送 → 停止**:目标会话运行中时,"发送"按钮变为红色的"停止"按钮,点击可停止
   pet 当前目标对话的运行中回合(走 DSH 现有 `sessions.cancel`)。

## 改动清单

### apps/pet(独立仓库)

| 文件 | 改动 |
|---|---|
| `src/renderer/index.html` | `#msg-input` 由 `<input type="text">` 改为 `<textarea rows="1">`;CSS `#inputbar input` → `#inputbar textarea`(resize:none / overflow-y:auto / max-height:calc(100vh - 52px) / line-height:1.4 / min-width:0 / scrollbar-width:thin);按钮加 `align-self:flex-start`(textarea 变高时按钮不拉伸);新增 `#inputbar button.stop` 红色样式(#e5484d,与审批拒绝色一致) |
| `src/shared/pet-event.ts` | `PetApi` 新增 `stopTurn(): Promise<PetOpResult>` |
| `src/preload/index.ts` | `stopTurn` → `ipcRenderer.invoke('pet:stop-turn')` |
| `src/main/dsh/ops.ts` | `PetOps` 新增 `stopTurn`;`createPetOps` 新增第 4 参 `resolveTargetSession`;实现走 `connection.api.sessions.cancel({ sessionId })` |
| `src/main/index.ts` | 新增 `resolveTargetSession()`(非新建目标解析);`createPetOps` 传第 4 参;注册 `ipcMain.handle('pet:stop-turn', …)` |
| `src/renderer/src/ui/panel.ts` | `PanelHooks` 新增 `onTargetChange?`;`renderSessions` 中按"有效目标"(显式或自动回退)去重通知 |
| `src/renderer/src/main.ts` | textarea 元素类型;新增 `targetSessionId` + `runningSessions` 跟踪、`renderSendButton`、`autoGrowInput`、`seedRunningSessions`;`dsh:session-update` 增量维护运行中集合;`dsh:connected` 清空重播种;输入条 Enter 发送/停止、Shift+Enter 换行、`e.isComposing` 保护 |

## 关键决策

1. **封顶高度 = `calc(100vh - 52px)`**:输入条高度 ≈ textarea + 12px(padding 6+6)。
   textarea 封顶后输入条顶边停在距窗顶 40px —— 与 `#panel` 的 `top: 40px` 一致,
   紧贴"菜单"按钮(底边 32px)下方,即"接近菜单按钮时停止增长";`100vh` 随窗口
   缩放(60%–150%)自适应。
2. **换行与增高交给 textarea 原生能力**:`flex: 1 + min-width: 0` 让 textarea 宽度
   顶到"发送"按钮,文本到宽度即自动换行;每行增高由 `autoGrowInput` 实现
   (先 `height:auto` 复位再按 `scrollHeight` 撑高,删文本会回缩)。
3. **封顶后转内部滚动**:textarea 自带 `overflow-y:auto` + `max-height`,内容超出后
   滚轮在输入框内滚动查看,无需额外逻辑;输入条是 `no-drag` 区域,滚轮事件不被
   `#stage` 的拖拽区吞掉。
4. **Enter 与按钮行为一致**:运行中 Enter = 停止(避免误把消息排进队列),空闲时
   Enter = 发送;Shift+Enter 插入换行;`e.isComposing` 保护中文输入法组词回车
   (确认候选不触发发送)。
5. **停止按钮状态来源**:`runningSessions` 由 `dsh:session-update` 增量维护,并用
   会话列表 running 快照播种(覆盖"窗口连接时回合已在跑"的场景);有效目标由面板
   `onTargetChange` 提供(含自动回退会话,与发消息落点一致)。
6. **停止动作由主进程解析权威目标**:renderer 只负责"是否显示停止",点击后走
   `sessions.cancel`,目标由主进程解析(显式目标优先,否则最近非空会话)。
7. **停止不新建会话**:发送路径的 `ensureTargetSession` 在无会话时会 `create`,
   停止不该产生会话,故单独实现非新建的 `resolveTargetSession`。

## 踩坑记录

- **品牌类型 SessionId(TS2322)**:`sessions.cancel({ sessionId })` 要求品牌类型
  `SessionId`,而主进程的显式目标 `targetSessionId` 是普通 `string`,直接传报
  `Type 'string' is not assignable to type 'SessionId'`。解法与 `ensureTargetSession`
  一致:先 `sessions.list`,用 `String(item.sessionId) === targetSessionId` 匹配后
  返回列表里带品牌的值(顺带覆盖"显式目标已被删除"的回退)。
- **renderer 目标竞态**:启动时若 `getState()` 在面板 `refreshSessions` 之后返回,
  其 `targetSessionId`(显式,null 或无)会覆盖面板算出的"有效目标"(自动回退)。
  解法:按钮状态的目标统一由 `onTargetChange` 提供,`getState` 不再直接赋值。

## 验证结果

- `pnpm --filter @deepseek-ai/dsh-pet run typecheck`(node + web 双配置):通过。
- `sessions.cancel` 为 DSH 现成契约(packages/host/apiproxy `sessions.d.ts`:"Stops
  an ordinary session's active turn"),非新协议。
- 视觉/交互(增高、滚动、按钮变色、停止生效)需重启 dev 窗口后实测。

## 遗留 / 后续

- 输入条增高后会覆盖面板/审批卡/气泡区域(封顶为贴近菜单按钮);面板打开时若输入条
  很高会叠在面板下层上。后续如需避免,可在面板打开时临时压缩输入条封顶高度。
- "连接时目标回合已在跑"由会话列表快照近似覆盖;列表 running 与事件流存在短暂竞态时,
  按钮状态最迟在下一个 turn 事件时刷新。
- 语音输入等后续能力可复用 textarea 高度逻辑。
