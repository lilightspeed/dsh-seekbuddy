# 0032 · 拖动物理反馈:应用 Live2D 导出参数「上下/左右拖动宠物」

## 状态

已验证(2026-08-18 typecheck + build 通过;用户真机确认拖动物理反馈效果正常)

## 日期

2026-08-18

## 目的

Live2D 导出(physics3.json)自带 `ParamDragX`(左右拖动宠物)/ `ParamDragY`(上下拖动宠物)
两个物理输入参数:它们连接 `PhysicsSetting6/5`,经 SDK 粒子模拟(延迟/惯性)输出到尾巴、
前发、后发 —— 只要在拖动窗口时把位移写进这两个参数,宠物就会有"被拖着走、身体部件惯性
摆动"的物理反馈。此前这两个参数从未被驱动(物理只有头部角度 → 后发一条接线)。
本次把拖动位移从主进程采样到 renderer 写入参数,打通整条链路。

## 改动清单

### apps/pet(独立仓库)

| 文件 | 改动 |
|---|---|
| `src/main/index.ts` | 光标轮询(33ms)中采样窗口位置增量:拖动中连续非零、静止为 0,`<1px` 视为 0(防慢速抖动);窗口不可见/重建时重置采样,避免恢复可见时算出虚假大位移;随 `pet:cursor` 推送 `dragDx/dragDy` |
| `src/shared/pet-event.ts` | `PetCursorPosition` 新增 `dragDx`/`dragDy`(px,下为正);`PetApi.onCursor` 注释补充拖动用途 |
| `src/preload/index.ts` | `onCursor` 边界用 `toFinite` 收敛 `dragDx/dragDy`(0004 IPC 纪律) |
| `src/renderer/src/pet/live2d/parameters.ts` | 新增 `PARAM_DRAG = { x: 'ParamDragX', y: 'ParamDragY' }` 契约(cdi3 对照) |
| `src/renderer/src/pet/live2d/runtime.ts` | `Live2dRuntime` 接口新增 `setDrag({ x, y })`(归一化 -1..1,内部映射 min/max) |
| `src/renderer/src/pet/live2d/cubism-runtime.ts` | 缓存 `ParamDragX/Y` 索引;`setDrag` 暂存、`update()` 在 load/save 之间写入(与视角参数同节奏) |
| `src/renderer/src/pet/live2d/create-live2d-animator.ts` | 消费 `onCursor` 的拖动增量 → 按窗口尺寸归一化(半宽/半高 = 满行程)→ 每帧指数平滑 → `runtime.setDrag`;停止拖动后目标为 0,参数回中 |
| `assets/pet/live2d/README.md` | §2 新增「拖动反馈」参数小节;§3 新增第 8 条拖动接线说明 |
| `doc/changes/0032-drag-physics-feedback.md` | 本文 |

### 未改动(设计使然)

- `PetAnimator` 接口 / `sprite-animator.ts`(占位球宠):拖动反馈是 Live2D 后端专属能力,
  全部封装在 `create-live2d-animator` 内部(它本就订阅 `onCursor`),接口零改动、占位后端不参与。
- 设置面板 / 配置链路:未加 UI(无用户要求),调参用文件内常量(`DRAG_FULL_TRAVEL` / `DRAG_SMOOTHING`)。

## 关键决策

1. **拖动信号 = 窗口位置增量,而非鼠标按键**:拖拽区域(`-webkit-app-region: drag`)会吞掉
   renderer 的鼠标事件(0016),按键状态在主进程也不可读(无原生钩子)。窗口被拖时位置连续变化,
   33ms 轮询里的位置增量就是"拖动速度"的近似,天然区分拖动/静止;`<1px` 置 0 避免慢拖抖动。
2. **并入现有 `pet:cursor` 轮询,不新增定时器/通道**:拖动与光标本来就是同一采样循环,
   一次推送两个信息,renderer 端同一订阅消费,链路最短。
3. **瞬时位移(速度)驱动,而非累计位移**:拖动持续越猛参数偏离越大;停止后目标为 0、经指数
   平滑回中,配合 physics 的 delay/mobility 自然形成"拖动摆动 → 松手余韵衰减",无需检测
   mouseup(不可靠)即可回中。
4. **归一化 -1..1 + setParam 映射 min/max**:与 `setViewLook` 同一套参数映射;`ParamDragX/Y`
   满行程写满,物理输入(relative normalization ±10)打满,输出摆动幅度由 physics3.json 决定,
   运行时零魔法数。
5. **写入节奏跟随 0019 load/save 纪律**:物理 evaluate 直接读模型参数当前值(相对
   min/max/default 归一化),必须在 `loadParameters` 之后、`saveParameters` 之前写,每帧生效
   (源码确认:CubismPhysics.Evaluate 读 `parameters.values`,输出 weight=100 为直接赋值)。
6. **窗口隐藏/重建重置采样**:否则 `isVisible()` 跳过期间位置陈旧,恢复可见时一次算出大位移,
   宠物会"凭空"摆动一下。

## 踩坑记录

- **`win.getPosition()` 索引可能 undefined**:tsconfig `noUncheckedIndexedAccess` 下 `pos[0]`
  是 `number | undefined`,typecheck 报 TS2532/TS2322;用 `const posX = pos[0] ?? 0` 收敛
  (主进程已有 `getPosition` 解构先例,但那是 `const [x, y] = mainWindow.getPosition()`
  场景,此处直接索引需兜底)。

## 验证结果

```powershell
pnpm --filter @deepseek-ai/dsh-pet run typecheck   # exit=0
pnpm --filter @deepseek-ai/dsh-pet run build       # exit=0
```

✅ 用户真机确认:拖动宠物窗口(上下/左右/斜向)时,尾巴、前后发随拖动方向产生惯性摆动;
快速拖动摆动明显,停止后摆动逐渐衰减回中;慢速拖动无高频抖动。
(拖动强度设置见 0033。)

## 遗留 / 后续

- [ ] 真机目视调优:`DRAG_FULL_TRAVEL`(满行程阈值,当前 = 窗口半宽/半高)与
      `DRAG_SMOOTHING`(平滑速度,当前 10/s);若摆动幅度不足/过猛改这两个常量即可。
- [ ] 若后续希望用户可调,把上述两常量提为设置面板项(走 pet-config 链路)。
- [ ] (备忘)模型若重导改名 `ParamDragX/Y`,同步 `parameters.ts` 的 `PARAM_DRAG`。
