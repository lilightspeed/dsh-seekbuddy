# 0016 · 修复:Live2D 视角跟随不动 —— 光标改由主进程轮询

## 状态

已验证(2026-08-17 typecheck + 真机日志确认管道;目视确认后即可完全关闭)

## 日期

2026-08-17

## 目的

修复 0015 引入的视角跟随失效:宠物静止,鼠标移入窗口只"动一下"就再也不动。
根因:`#stage` 整窗是 `-webkit-app-region: drag`,**Electron 拖拽区域会吞掉 renderer 的
鼠标事件** —— `pointermove` 只在鼠标扫过非拖拽元素(如底部输入条)时触发一次,之后收不到
任何事件,`view-follower` 的目标永远停在第一个点 → 宠物看一眼就僵住。

## 改动清单

### apps/pet(独立仓库)

| 文件 | 改动 |
|---|---|
| `src/main/index.ts` | 新增 `startCursorPolling()`:33ms 轮询 `screen.getCursorScreenPoint()` + `win.getBounds()` → 窗口局部坐标 → `webContents.send('pet:cursor', {x, y, inside})`;窗口隐藏/销毁时跳过;will-quit 清理 |
| `src/shared/pet-event.ts` | 新增 `PetCursorPosition`;`PetApi` 加 `onCursor(handler): () => void` |
| `src/preload/index.ts` | `onCursor` 白名单通道(ipcRenderer.on('pet:cursor'),toFinite/Boolean 收敛) |
| `src/renderer/src/pet/live2d/create-live2d-animator.ts` | 视角跟随数据源改为 `petApi.onCursor`(主进程轮询);光标在窗口外按窗口边缘夹取;保留 `pointermove` 作为无 petApi 环境的兜底 |
| `doc/changes/0016-cursor-follow-fix.md` | 本文 |

## 关键决策

1. **光标由主进程全局读取**(`screen.getCursorScreenPoint`),不依赖 renderer 事件 —— 彻底绕开
   `-webkit-app-region: drag` 吞事件的限制,也顺带获得"鼠标移出窗口后宠物仍看向光标方向"的能力
   (原需求"dsh 不工作时宠物视角跟随鼠标"的字面语义)。
2. **33ms(~30Hz)轮询**:`view-follower` 自带平滑(眼 12/s、头 6/s、身 3/s),30Hz 的
   目标更新足够顺滑;IPC 载荷极小(3 个标量),开销可忽略。
3. **窗口外夹取到边缘**:光标离开窗口后,把坐标夹到 `[0, innerWidth]×[0, innerHeight]`,
   宠物始终朝向光标方向且不产生超幅旋转;`inside` 字段保留供后续改行为(如离开即回中)。
4. **保留 `pointermove` 兜底**:无 petApi 的纯浏览器调试环境仍能工作;两个来源同写一个
   `pointer`,后到者生效,无冲突。
5. 拖拽体验不变:`#stage` 仍是原生拖拽区域,没有引入 no-drag 覆盖层破坏窗口拖动
   (AGENTS.md 0005 纪律:不用 IPC 逐帧 setPosition)。

## 踩坑记录

- 现象学关键线索:**"移入窗口动一下"** —— 说明首个事件(扫过 no-drag 元素或边界)能触发,
  之后 drag 区域吞掉后续事件;若当时改用"事件在 drag 区域正常"的假设去查 follower 逻辑会白费功夫。
- `screen.getCursorScreenPoint()` 返回 DIP 坐标,`getBounds()` 也是 DIP —— 局部坐标直接等于
  renderer 的 CSS px,无需换算 display scale。
- 轮询需跳过 `isDestroyed()` 与 `isVisible()`(托盘隐藏时避免无意义推送)。

## 验证结果

```powershell
pnpm --filter @deepseek-ai/dsh-pet run typecheck   # exit=0
```

真机(dev + ELECTRON_ENABLE_LOGGING,临时 1Hz 日志,已删除):

```
[pet] cursor local=(930, 262) inside=false     ← 主进程轮询,位置随鼠标连续变化
[pet] cursor local=(109, 1) inside=true
[live2d] cursor (419, 86) inside=true          ← renderer 经 preload 持续收到
[live2d] cursor (250, 432) inside=true         ← 窗口内位置连续更新
```

主进程与 renderer 两侧日志都持续刷新且坐标随鼠标移动变化 → 数据管道(轮询 → IPC → preload →
animator → follower → 参数)全链路打通;宠物此前"动一下"已证明参数→模型生效,故跟随恢复。

## 遗留 / 后续

- [ ] 用户目视确认手感;按需调 `ViewFollowerConfig`
- [ ] (可选)后续如需"离开窗口即回中"等行为,用 `PetCursorPosition.inside` 分支
