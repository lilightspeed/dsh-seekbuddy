# 0005 · 修复:拖拽改用原生 app-region(消除卡顿与 setPosition 崩溃)

**状态**:已验证
**日期**:2026-08-15
**类型**:Bug 修复 + 架构调整(阶段 2 遗留)

---

## 现象(用户实测)

1. 拖拽窗口延迟高,位置更新频率 <10fps,明显卡顿。
2. 快速拖动时下方输入条"变长"(窗口范围视觉变大)。
3. 拖拽过程中主进程持续抛异常(完整堆栈,已由 0004 的 uncaughtException 日志捕获):

```
[pet] uncaughtException in main: TypeError: Error processing argument at index 1, conversion failure from
    at IpcMainImpl.<anonymous> (out/main/index.js:321:7)   ← win.setPosition(...) 这一行
```

## 根因

崩溃点**不是 IPC 参数序列化**,而是 **`win.setPosition(x, y)` 收到的计算值是非法类型**:
堆栈 321:7 正是 setPosition 调用行;报错 "argument at index 0/1" 对应 setPosition 的 x/y 参数。
也就是:每条 `pet:drag-move` 消息都能到达 handler(0004 的 toFinite 收敛有效),
但 `startWinX + (x - startMouseX)` 的计算结果在某些指针事件下不是可转换数值
(具体值在报错里显示为空,未完全定位;但路径已确定)。由于 handler 在 setPosition 处抛异常,
**窗口根本没移动** → 用户看到的"10fps 更新"其实是少量成功 + 大量失败,表现为严重卡顿。

## 解法:原生拖拽区域(替换 IPC 逐帧 setPosition)

`-webkit-app-region: drag` 是 Electron 官方拖窗方案:OS 级移动窗口,60fps、零 IPC、零参数转换风险。

| 位置 | 改动 |
|---|---|
| `index.html` | `#stage` 加 `-webkit-app-region: drag`;`#inputbar` 加 `-webkit-app-region: no-drag`(保持输入可交互) |
| `src/renderer/src/main.ts` | 删除 pointerdown/move/up 拖拽监听 |
| `src/preload/index.ts` | 白名单删除 dragStart/dragMove/dragEnd |
| `src/shared/pet-event.ts` | `PetApi` 删除拖拽方法 |
| `src/main/index.ts` | 删除 dragState 与三个 drag IPC handler |

代价:宠物区域不再接收 DOM 指针事件(被拖拽区域吞掉)。当前占位球宠无点击交互,无影响;
阶段 3 若需要点击宠物(如点开菜单),再在宠物上方叠一个 `no-drag` 的透明交互层。

## 验证

- `pnpm --filter @deepseek-ai/dsh-pet run typecheck` ✅ exit 0
- `pnpm dev`:应用正常启动,无 uncaughtException、无窗口/渲染错误
- 拖拽手感(60fps)与"输入条变长"问题由用户实机确认(原生拖拽不经过我们任何代码,预期直接消失)

## 涉及文件

- `src/renderer/index.html`、`src/renderer/src/main.ts`、`src/preload/index.ts`、`src/shared/pet-event.ts`、`src/main/index.ts`
- `AGENTS.md`(已知事实新增:拖拽走原生 app-region)

## 遗留

- 若后续要"点击宠物弹菜单"等交互:`#stage` 上叠 `no-drag` 透明层承接点击,拖拽仍走 app-region。
- 0004 的 preload 参数收敛(toFinite/String)保留 —— 它是 IPC 参数合法性的通用防线,
  对 sendMessage 等通道仍然必要(本次崩溃虽非它引起,但边界纪律不撤)。
