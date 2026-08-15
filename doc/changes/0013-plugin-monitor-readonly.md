# 0013 · B3(只读)插件监控 —— agent 中介读取 DSH 动态插件清单

**状态**:已验证
**日期**:2026-08-15
**对应路线图**:阶段 6 增强 —— 动态 Cordis 插件管理界面(本次先做只读监控)

---

## 目的

给宠物加一个「插件」tab,展示 DSH 会话的动态插件清单(pluginId/状态/package/运行信息)。**只读**,不做 define/run/stop —— 用户决策:harness 正在快速迭代,不深度改造 harness,等正式版稳定后再考虑完整集成。

## 前置侦察结论(为什么是"agent 中介")

1. `@deepseek-ai/dsh-host-apiproxy` 的 `ApiProxy` **没有 `plugin.*` 域**(全部域:sessions/subagents/host/workspace/skills/agentPresets/events/goals/settings/credentials/llm/downloads/respond)—— 宠物无法经 `/api` 直接调 define/run/stop/undefine。
2. 动态插件管理(`cordis_inspect_*/define/run/stop/undefine`)是**会话级 agent 工具**(`packages/extensions/tool-cordis`),由模型在回合内调用,底层走 Host 服务 `ctx.dynamicCordisRunner`(agent 作用域,`TypertRemoteService`);Web GUI 的插件管理同样靠驱动模型调这些工具。
3. 三条路线:A agent 中介(零 harness 改动)/ B 扩展 harness `plugin` API(动核心)/ C 只读过渡。用户选 **C**(先只读,等 harness 稳定)。

## 改动清单

| 文件 | 改动 |
|---|---|
| `src/main/dsh/plugin-ops.ts`(新) | `createPluginOps`:`listPlugins()` —— 记尾部 seq → `sessions.prompt`(严格 JSON 指令)→ 轮询 `sessions.history` 等新 assistant 回复(60s 超时,1.5s 间隔)→ 容错解析 `{plugins:[...]}` → 摊平成扁平类型;解析失败带 `rawReply` 诊断 |
| `src/shared/pet-event.ts` | 新增 `PetPluginEntry` / `PetPluginListResult` 类型;`PetApi.listPlugins()` |
| `src/main/index.ts` | 装配 `pluginOps`(注入 getConnection + getTargetSession=ensureTargetSession);`pet:list-plugins` IPC |
| `src/preload/index.ts` | 白名单新增 `listPlugins` |
| `src/renderer/src/ui/panel.ts` | 「插件」tab:刷新按钮(loading 态)+ 状态栏 + 插件卡片(状态徽章/元信息/可折叠原始 JSON)+ 错误展示 |
| `src/renderer/index.html` | 插件 tab 按钮/容器 + 样式 |

## 关键决策

1. **agent 中介 + 轮询 history,而不是监听 turn 事件**:目标会话可能正忙(排队),turn 锚定易误配;直接"记下指令前的尾部 seq → 轮询直到出现 seq 更大的 assistant 回复"最稳,复用已有的 sessions.history。
2. **严格 JSON 指令**:prompt 明确"只输出 JSON、不要解释、不要 markdown 围栏";解析时仍容错(剥 ```、找首个 {…} 平衡块),失败则把 agent 原始回复前 500 字符回传 UI 诊断。
3. **监控目标会话**:动态插件本就 session-scoped,查目标会话最有意义;代价是目标会话里会出现一条查询指令消息、且每次刷新耗一次模型回合(UI 有提示)。
4. **字段缺省容错**:agent 回吐的摘要字段可能缺省,摊平时逐个 `typeof` 守卫,不因缺字段崩。

## 踩坑记录

### 无重大坑;一个可预期的脆弱点
agent 是否严格按 JSON 回复取决于模型 —— 指令已经写得很死,但解析层仍做了三层容错(剥围栏 / 平衡块 / rawReply 兜底)。若模型持续不守格式,后续可改走"让 agent 把结果写入文件,宠物读文件"的旁路,但优先保持简单。

## 验证结果

- `pnpm --filter @deepseek-ai/dsh-pet run typecheck` ✅ exit 0
- `pnpm --filter @deepseek-ai/dsh-pet run build` ✅;重新打包 NSIS + portable ✅
- **端到端(用户确认)**:宠物「插件」tab 点刷新 → 给目标会话发指令 → 目标会话 agent 执行 `cordis_inspect_self()` → 原样回吐 `{"mode":"plugins","plugins":[]}` → 宠物解析渲染(本次该会话无动态插件,空列表正确显示)✅
- 链路复用:宠物发消息 / 读历史 / turn 监听均为既有能力,无新协议

## 遗留 / 后续

- **完整管理(define/run/update/stop/undefine)待 DSH 原生 plugin API**:harness 正式版稳定后,走 B 路线新增 `plugin.*` 域(照 `subagents.*` 模式:`{sessionId}` → 会话 agent → `ctx.dynamicCordisRunner`),宠物即可直连管理。
- **刷新成本**:每次刷新 = 一次模型回合;若频繁使用可考虑节流或定时自动刷新。
- 插件卡目前展示摘要;package 级 inspect(源码/诊断)要再发一轮指令,暂未做(成本高)。
