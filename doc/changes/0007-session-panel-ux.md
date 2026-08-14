# 0007 · 会话面板 UX 修复:发送目标横幅 + 点击只设目标不跳转

**状态**:已验证
**日期**:2026-08-15
**类型**:UX 修复(阶段 3 反馈)

---

## 目的

用户实机反馈两条会话面板体验问题:

1. **会话页没有指出"发消息会发到哪个会话"**:只靠橙色高亮暗示目标,未选目标时的自动回退(最近会话)毫无提示,信息缺失。
2. **点击会话项会立即跳转到"历史"页**:用户预期"点一下只是选为目标",跳转打断了浏览会话列表的节奏。

## 改动清单

### apps/pet —— renderer

| 文件 | 改动 |
|---|---|
| `src/renderer/src/ui/panel.ts` | 新增 `resolveTarget()`:显式目标优先,否则回退"最近更新的非空会话"(与主进程 `ensureTargetSession` 的 fallback 逻辑一致);`renderSessions` 顶部渲染"发送目标"横幅(`📤 发送到 <会话>` / `📤 自动发送到 <最近会话>` / 无会话提示),目标行加"目标"徽标,横幅附"取消选择"按钮(回退自动);**`selectSession` 移除 `switchTab('history')`** —— 点击会话只设目标并停留会话页,历史锚点后台预置;历史 tab 顶部显示当前查看会话标题(`💬 <标题>`),未选会话时显示引导提示 |
| `src/renderer/index.html` | 新增 `.target-banner` / `.target-tag` / `.target-clear` / `.history-title` 样式 |

## 关键决策

1. **"目标"语义集中在一处解析**:`resolveTarget(items)` 是唯一的目标解析入口,renderer 与主进程 `ensureTargetSession` 的 fallback(最近非空会话)保持一致——横幅和徽标永远显示"真实会发送到的会话",不会出现"列表高亮 A 但实际发到 B"的错位。
2. **点击会话 = 设目标,不跳转**:`selectSession` 只更新目标并刷新横幅/徽标;历史锚点(historySessionId/title)后台预置但不切换 tab,用户主动切到"历史"时直接看到所选会话。
3. **清除目标有显式入口**:横幅上的"取消选择"调 `selectSession(null)`,回退自动模式,交互闭环。
4. **历史页补标题**:与会话页同理,历史 tab 顶部注明正在看哪个会话,避免"不知道历史是谁的"。

## 验证结果

- `pnpm --filter @deepseek-ai/dsh-pet run typecheck` ✅ exit 0
- `pnpm dev` 用户实机验证通过:
  - 会话页顶部显示"📤 自动发送到 <最近会话>"(未选目标时)
  - 点击会话 → 停留会话页,横幅变"📤 发送到 <该会话>",目标行出现"目标"徽标
  - "取消选择" → 回退自动模式
  - 手动切"历史"tab → 显示所选会话历史,顶部有会话标题

## 遗留 / 后续

- 阶段 4(MCP 反向链路):Agent → 宠物 speak/setExpression/notify。
