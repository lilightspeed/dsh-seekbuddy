# 06 · 开发路线图(进度现状)

> 按"先闭环、再增强"的顺序推进。已完成的阶段链接到 changes/ 档案;未完成项保持勾选状态。

## 阶段 0 · 准备 ✅ 已完成

`apps/pet` 接入 monorepo、electron-vite 空窗口、client 包类型可用。→ [changes/0001](./changes/0001-scaffold-and-network-setup.md)

## 阶段 1 · 连通性 PoC ✅ 已完成

主进程连接 `127.0.0.1:3080`,`host.describe` 握手、订阅两条 WS 事件流、断线重连。→ [changes/0002](./changes/0002-connectivity-poc.md)

## 阶段 2 · 最小可用宠物(MVP)✅ 已完成

透明置顶窗口 + 托盘 + PixiJS 占位球宠 + XState 状态机 + 气泡发消息。→ [changes/0003](./changes/0003-stage2-mvp.md)

## 阶段 3 · 关键操作面 ✅ 已完成

会话列表/切换/历史、审批(loopback 特权)、系统通知、preload 白名单 + 连接下沉主进程。→ [changes/0006](./changes/0006-stage3-operations.md)

## 阶段 4 · 反向链路 MCP ✅ 已完成

MCP server(`setExpression / notify`)+ 主进程 loopback bridge + DSH `mcp-client` 接入,实机验证双向闭环。→ [changes/0008](./changes/0008-mcp-reverse-link.md)、[0011](./changes/0011-packaged-mcp-verify.md)

## 阶段 5 · 打包与常驻 ✅ 已完成

electron-builder NSIS/portable、单实例、开机自启、配置持久化(手写 `PetConfigStore`)、目标会话记忆。→ [changes/0009](./changes/0009-stage5-packaging-persistence.md)

## 阶段 5.5 · Live2D 视角跟随 ✅ 已完成(后续里程碑之外的追加)

官方 Cubism SDK for Web 5-r.5 vendor + 独立 canvas 自绘运行时;鼠标视角跟随(头部/眼珠/身体、窗外跟随)、后发物理、眨眼、呼吸、设置面板宠物参数(位置/大小/手感)。→ [changes/0014](./changes/0014-live2d-view-follow-skeleton.md) 至 [0019](./changes/0019-breath-clamp-fix.md)

## 阶段 6 · 增强(进行中)

- [x] Live2D 角色替换精灵图(0015,已现役)
- [x] 多会话雷达(0012,已并入会话页)
- [x] 动态 Cordis 插件**只读**监控(0013;B3)
- [ ] 动态 Cordis 插件管理界面(define/run/update/stop/undefine/inspect)
- [ ] Live2D 表情/姿势/动画/HitAreas(素材与 `model3.json` 注册,清单见 `assets/pet/live2d/README.md` §4)
- [ ] 桌面自动化 MCP 工具(openApp / switchWindow,谨慎开放)
- [ ] electron-updater 自动更新

## 风险清单(已解决项移入历史)

| 风险 | 状态 |
|---|---|
| 复用 client 包时方法签名/导出与文档不符 | ✅ 已解决:全程 import 仓库 `.d.ts`(0002 踩过 tsdown CJS 包装坑) |
| Live2D 与 PixiJS v8 兼容性 | ✅ 已解决:不走 `@pixi/live2d-display`,官方 SDK + 独立 canvas(0015) |
| DSH webserver 无 CORS / 事件流只收 WS | ✅ 已解决:连接放主进程 + `ws` 下行(0002) |
| IPC 参数不可序列化崩主进程 | ✅ 已解决:preload 边界收敛(0004) |
| 拖拽区域吞 renderer 鼠标事件 | ✅ 已解决:光标改主进程轮询(0016) |
| MCP `mcp-client` 的 config 字段名 | 以 `@deepseek-ai/dsh-mcp-client` 的 `Config` schema 为准(0008 已按实际核对) |

## 每个阶段的"完成定义"

- 有可运行产物,不只是代码;
- 类型检查通过(`tsc --noEmit`);
- 关键路径手动验证过(不是"应该能跑")。
