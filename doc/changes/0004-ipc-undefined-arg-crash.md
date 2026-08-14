# 0004 · 修复:IPC 参数 `undefined` 触发主进程崩溃

**状态**:已验证
**日期**:2026-08-15
**类型**:Bug 修复(阶段 2 遗留)

---

## 现象

用户运行 `pnpm dev` 后(与宠物窗口交互时),主进程弹窗:

```
Uncaught Exception:
TypeError: Error processing argument at index 1, conversion failure from
    at ipcMainImpl.<anonymous> ...
```

## 根因

Electron IPC 参数序列化:renderer → 主进程传参时,若参数是 `undefined`(或同类不可转换值),
主进程在 **handler 执行前**的序列化阶段直接抛 `conversion failure`,导致未捕获异常崩溃。
(与 [fast-vite-electron issue #1074](https://github.com/ArcherGu/fast-vite-electron/issues/1074) 同族:
那个 case 是 `loadURL(undefined)`。)

本应用唯一"无守卫透传原始值"的 IPC 通道是**拖拽**:`dragStart/dragMove` 直接把
`e.screenX/e.screenY` 透传给 `ipcRenderer.send`。某个指针事件下 `screenX/screenY`
为 `undefined`(具体触发点未逐帧复现,但通道形态符合报错特征:index 1 即第一个自定义参数)。

## 修复(分层防御)

1. **preload 边界统一收敛(主防线)**:`toFinite(value)` 把非有限数值收敛为 0,
   `sendMessage` 用 `String(text ?? '')`。renderer 与主进程之间从此不可能出现
   `undefined`/`NaN` 参数。参数合法性只在 preload 这一层管,handler 不再假设。
2. **renderer 调用点**:拖拽坐标 `Number(e.screenX) || 0` 双重收敛。
3. **主进程 handler**:`drag-start/drag-move` 增加 `Number.isFinite` 检查,非法坐标直接忽略。

## 验证

- 临时回归测试:renderer 启动 3 秒后故意 `api.dragStart(undefined, undefined)` +
  `api.dragMove(undefined, undefined)` + `api.sendMessage(undefined)` ——
  **主进程不崩溃**,应用持续运行(日志 `undefined-arg regression test sent` 后无异常)。
  `sendMessage(undefined)` → `String('')` → handler 正常拒绝(empty message)。
- `pnpm --filter @deepseek-ai/dsh-pet run typecheck` ✅ exit 0

## 涉及文件

- `src/preload/index.ts`(toFinite 收敛)
- `src/renderer/src/main.ts`(拖拽坐标 Number 收敛)
- `src/main/index.ts`(drag handler 有限数值检查)
- `AGENTS.md`(已知事实新增:IPC 参数可序列化要求)

## 遗留

- 拖拽坐标收敛为 0 的极端情形(坐标确实非法时窗口不动)可接受,后续若需精确诊断,
  可在 preload 打印被收敛的原始值。
