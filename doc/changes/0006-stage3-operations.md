# 0006 · 阶段 3:关键操作面 —— 会话列表/切换 + 历史查看 + 审批 + 系统通知

**状态**:已验证
**日期**:2026-08-15
**对应路线图**:doc/06 阶段 3(关键操作面,宠物能完成 DSH 日常高频操作)

---

## 目的

1. **会话列表/切换**:宠物窗口列出 DSH 全部会话,点选即设为"目标会话"(发消息的落点),替代阶段 2 的"永远最近会话"。
2. **历史查看**:面板里看目标会话的消息历史(尾部页 + 向上翻页)。
3. **审批**:DSH 发来 `approval/requested` 时,宠物窗口弹审批卡,点"允许/拒绝"回包(`/api/respond` echo rpcId,loopback 特权)。
4. **系统通知**:需审批 / 回合异常 / agent 报错时发桌面通知;回合完成仅在窗口隐藏时通知。
5. 顺手处理阶段 2 遗留:**帧风暴保护**——`dsh:frame` 不再逐帧推给 renderer。

## 改动清单

### apps/pet —— 共享类型

| 文件 | 改动 |
|---|---|
| `src/shared/pet-event.ts` | `PetEvent` 新增:`dsh:turn-end.reason/sessionId`、`approval:pending`(rpcId/sessionId/approvalId/toolName)、`approval:resolved`、`agent:error`;`PetApi` 新增 `listSessions/getHistory/selectSession/createSession/respondApproval`;新增 `PetSessionSummary/PetSessionListResult/PetHistoryEntry/PetHistoryResult/PetCreateResult/PetApprovalRequest`;`PetConnectionState` 增加 `targetSessionId` |

### apps/pet —— 主进程

| 文件 | 改动 |
|---|---|
| `src/main/dsh/ops.ts`(新) | 阶段 3 操作面:`createPetOps` 提供 listSessions(摊平 title/updatedAt/running/blank)、getHistory(翻页:beforeSeq/maxMessages)、selectSession、createSession、respondApproval;`flattenEvent` 把 SessionEvent 摊平成展示行(user/assistant/tool/meta),噪音事件(chunk/step/request/todo)丢弃;审批回包构造 `ClientResponse` 走 `api.respond`(echo rpcId) |
| `src/main/dsh/connection.ts` | mux 帧富化:turn-end 带 `reason`+`sessionId`;`approval/requested` → `approval:pending`(带 rpcId);`approval/resolved` → `approval:resolved`;host 帧 `host/agent-error` → `agent:error` |
| `src/main/notify.ts`(新) | 系统通知策略:审批/异常/报错总是通知;回合完成仅当窗口隐藏且属于目标会话 |
| `src/main/index.ts` | 目标会话状态(`targetSessionId`);新增 5 个 IPC handler;`sendPetEvent` 丢弃 `dsh:frame`(帧风暴保护);Windows 通知 `setAppUserModelId` |

### apps/pet —— preload

| 文件 | 改动 |
|---|---|
| `src/preload/index.ts` | 白名单新增 5 个方法;参数收敛纪律(0004)延续:字符串一律 `String`,数值 `toFinite`,`null` 显式传递(`beforeSeq/maxMessages` 无值时传 `null` 而非 `undefined`),审批对象字段全部 sanitize |

### apps/pet —— renderer

| 文件 | 改动 |
|---|---|
| `src/renderer/index.html` | 新增面板开关按钮 `#btn-panel`、会话/历史/审批三 tab 面板 `#panel`、浮动审批卡 `#approval-card`(允许/拒绝按钮);样式 |
| `src/renderer/src/ui/approvals.ts`(新) | 审批中心:pending 表(rpcId 键)+ 浮动卡渲染逻辑;`respond` 调 `api.respondApproval`,成功移除条目并闪气泡 |
| `src/renderer/src/ui/panel.ts`(新) | 会话面板:三 tab(会话列表/历史/审批);会话行显示标题/运行点/相对时间,点选切换目标并跳历史;历史尾部页 + "加载更早"向上翻页;审批 tab 与浮动卡共用审批中心;角标计数 |
| `src/renderer/src/main.ts` | 装配审批中心 + 面板;事件映射:turn-end 按 reason 区分正常/异常、`approval:pending/resolved`、`agent:error`;connected 时刷新会话列表;`getState()` 兜底补读时也刷新面板 |

## 关键决策

1. **审批走 `api.respond` 而不是 unary 方法**:协议文档明言 approval/requested 是 answerable server-request,`approvalId` 是审计对账键、**rpcId 才是 wire 对账键**;回包是 `POST /api/respond` 的 client-response(echo rpcId),不在 RpcMethodMap 里,不 mint 新 id。`respondApproval` 构造 `ClientResponse` + `ApprovalResponsePayload`(品牌字段编译期标记,renderer 字符串回填后 `as` 转换)。
2. **目标会话状态放主进程**:renderer 不持有会话权威状态;`selectSession` 写主进程 `targetSessionId`,`sendMessage` 优先用目标会话,目标失效(被删/archive)自动回退最近非空会话。`getState()` 回传 `targetSessionId` 供 renderer 高亮。
3. **历史摊平在主进程**:renderer 只消费扁平行(`kind/text/time/seq`),不 import 仓库 session event 类型;噪音事件(assistant/chunk、step/start/end、request/*、todo/write)在 `flattenEvent` 丢弃,减少 IPC 体积与 renderer 复杂度。
4. **帧风暴保护**:renderer 从不消费 `dsh:frame`(阶段 2 遗留),现在主进程直接不转发——语义事件(turn/审批/错误)才是 renderer 关心的。主进程侧 `dsh:frame` 仍在(可调试)。
5. **系统通知策略**:审批/报错/回合异常——需要用户动作或很罕见,总是通知;回合完成——常驻窗口下刷屏无意义,仅窗口隐藏(用户走开)且是目标会话时才通知。策略集中在 `notify.ts`,可调。
6. **UI 仍是 vanilla DOM**:三 tab 面板 + 浮动卡,规模可控,React/Zustand 留到设置面板等复杂 UI(AGENTS.md 既定)。
7. **IPC 参数纪律延续(0004)**:`getHistory` 的 `beforeSeq/maxMessages` 无值传 `null` 而非 `undefined`(undefined 过 IPC 会 conversion failure);preload 是唯一参数收敛点。

## 踩坑记录

### 坑 1:`RpcId` 是 runtime 函数,不是纯类型
审批回包要 `ClientResponse.rpcId: RpcId`,初稿想 `as` 强转;查 `@deepseek-ai/dsh-host-apiproxy/api` 的 d.ts,`RpcId` 有 runtime 实现(`RpcId(id)` 返回 brand 字符串)。`ops.ts` 直接 `import { RpcId }` 调用,不用 cast,和仓库 `client/rpc.ts` 同源。

### 坑 2:品牌类型字段不能从 renderer 字符串直接赋
`ApprovalResponsePayload.sessionId` 是 branded `SessionId`、`approvalId` 是 branded `ApprovalRequestId`。renderer 传回的是普通字符串,直接赋会类型错。解法:整个 value 对象 `as unknown as ApprovalResponsePayload`(品牌是编译期标记,wir e 校验在 `/api/respond` 端由 zod 承担,实测接受字符串)。

### 坑 3:live host 的 history `beforeSeq` 语义与直觉相反
`session.history` 的 `beforeSeq` 是"**这个 seq 之前的**"窗口(向上翻页锚点),不是"从这个 seq 开始"。初稿把 `beforeSeq` 当起始点传,翻页会拿错窗口。实测(见验证):`beforeSeq=32080` 返回到 32079 为止的窗口,`hasMore=true`——语义确认。

### 坑 4:历史翻页锚点要取"已显示最旧条目"的 seq
面板向上翻页时,`beforeSeq` 必须传**当前已加载最旧行的 seq**(`historyBeforeSeq`),下次加载返回它之前的窗口,新行 `prepend` 到列表顶部(按钮保持置顶)。否则重复或跳页。用 `dataset.seq` 锚定,prepend 分支插到"加载更早"按钮之后。

### 坑 5:tsconfig 清空 paths 后 `SessionSummary` 等类型要经 apiproxy/api 拿
apps/pet 的 tsconfig 清空 paths,workspace 依赖走 node_modules 里已构建的 `lib/types/*.d.ts`。`SessionSummary`/`HistoryEntry`/`ApprovalResponsePayload`/`RpcId` 都从 `@deepseek-ai/dsh-host-apiproxy/api` 导入(该包在 node_modules 有构建产物);**没有**去 import `@deepseek-ai/dsh-session` 等深层包(会因 pnpm 严格 node_modules 找不到)。

### 坑 6:dev 启动在受限 sandbox 下 EPERM
`pnpm dev` 的 electron-vite 会 spawn esbuild 服务进程(piped stdio),受限模式返回 `spawn EPERM`。这是 DSH 执行沙箱的已知边界(非代码问题),用危险模式重跑即正常;与项目无关,记录备查。

## 验证结果

- `pnpm --filter @deepseek-ai/dsh-pet run typecheck` ✅ exit 0(node + web 两个配置)
- `pnpm dev` 实测:窗口启动、无 main 进程错误、renderer 编译无错(HMR page reload 正常)、dev server `http://localhost:5173/` 200
- **live DSH(127.0.0.1:3080)协议对拍**:
  - `session.list` ✅ 返回 items(sessionId/title/updatedAt/running/blank/projections)
  - `session.history` ✅ `maxMessages=3` 尾部页 + `beforeSeq=32080` 向上翻页均返回预期窗口,`hasMore` 正确
  - `POST /api/respond`(审批回包 shape)✅ 对 fake approvalId 返回 `{accepted:false, reason:"not-pending"}`——**信封与 payload schema 校验通过**,证明 respond 链路形状正确(真审批需 Agent 实际触发,留给用户实机验证)
- `git status`:上述 9 文件改动,无根仓库污染(本目录独立 git 仓库)

## 遗留 / 后续

- **真审批端到端**:需要 DSH Agent 实际发起一次审批(如配置了需要审批的工具)。用户实机触发即可验证:宠物弹审批卡 → 允许/拒绝 → `approval/resolved` 事件。
- **真发消息端到端**:目标会话切换后,输入框发送应落到所选会话(原阶段 2 遗留,顺带覆盖)。
- **审批在重连后的 replay**:mux 流在订阅时会重放 pending 的 approval/requested(rpcId 复用)——pending 表按 rpcId 键,重放天然去重,未专门测试。
- **阶段 4(MCP 反向链路)**:Agent → 宠物 speak/setExpression/notify。
- **开机自启/单实例**(阶段 5 打包时做)。
