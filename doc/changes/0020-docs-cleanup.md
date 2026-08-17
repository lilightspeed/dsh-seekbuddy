# 0020 · 文档整理 —— 删除 TS 学习路径,主题文档对齐现状

## 状态

已验证(2026-08-17;纯文档改动,typecheck/build 不受影响)

## 日期

2026-08-17

## 目的

Live2D 视角跟随里程碑收尾后,整理主题文档:

1. **删除 TypeScript 学习路径**(`doc/07-typescript-learning-path.md`)—— 开发已完成,不再需要"从零到能开工"的学习材料。
2. **修正过时/不符合逻辑的部分**:主题文档描述的是"规划中的样子",实际实现后大量内容漂移
   (技术栈、目录结构、Live2D 状态、路线图进度、MCP 传输),全部对齐现状。
3. **changes/ 改动档案一律不动**(用户明确要求;它是按时序的历史记录)。

## 改动清单

### apps/pet(独立仓库)

| 文件 | 改动 |
|---|---|
| `doc/07-typescript-learning-path.md` | **删除** |
| `doc/README.md` | 删 07 索引行;02/05/06/08 描述改为现状;注明"主题文档=当前应该是什么样,changes/=当时怎么走到这里" |
| `doc/02-tech-stack.md` | 重写为**当前实际技术栈**:UI=vanilla DOM(React/Zustand/Tailwind 未采用)、渲染=Live2D 官方 SDK 独立 canvas(PixiJS 仅回落,Lottie/Spine 未采用)、存储=手写 PetConfigStore(electron-store 未采用)、测试=typecheck 门槛、MCP=loopback TCP bridge、语音未实现 |
| `doc/01-architecture.md` | 架构图 renderer 盒更新(Live2D + vanilla DOM);④ 反向工具清单对齐实际(speak/setExpression/notify);组件表 DSH 客户端层定为主进程 |
| `doc/05-scaffolding.md` | 重写为**实际目录结构** + 构建事实(全量 bundle、@live2d 别名、preload .mjs、CSP)+ preload 白名单通道清单 |
| `doc/06-roadmap.md` | 阶段 0–5 标 ✅(链 changes),新增"阶段 5.5 Live2D" ✅,阶段 6 勾掉已完成项(Live2D/雷达/插件只读监控),风险清单已解决项移入历史 |
| `doc/08-live2d-integration.md` | 从"技术咨询整理(暂无代码落地)"改为**已落地**:§4 写实际接入点(live2d/ 模块、vendor、光标轮询、设置面板),§3 兼容矩阵标注实测/未制作,§6 落地记录(0014–0019)+ 剩余项 |
| `doc/04-mcp-integration.md` | §7 补"本项目实际落地"注:loopback TCP bridge(裸 node stdio spawn 连回桥) |
| `AGENTS.md` | 目录布局更新(Live2D 现役、doc 07 → 08);动画可插拔 bullet 补充现役后端;新增两条已知事实(Load2D 帧节奏 0019、视角跟随光标主进程轮询 0016) |
| `assets/pet/README.md` | 素材路线说明更新:live2d/ 现役,sprites/ 降为回落/备选 |
| `doc/changes/0020-docs-cleanup.md` | 本文 |

## 关键决策

1. **主题文档对齐现状,changes/ 保持时序**:主题文档是"现在应该长什么样"的活文档,与代码一致;
   changes/ 是"当时怎么改的"历史档案,两者分工明确,避免重复。
2. **未采用的技术栈明确标注"未采用"**(React/Zustand/Tailwind、Lottie/Spine、electron-store、electron-updater、
   测试基建)—— 保留为"将来要引入时再读"的占位,但不再误导为现状。
3. **doc/03 基本未动**:它是 DSH 协议指南(基于源码的事实性内容),仍有效;仅 doc/04 补了实际传输落地注。

## 验证结果

纯文档改动;`pnpm typecheck` / `pnpm build` 与此无关。已核对:全仓库(除 changes/0001 的历史引用外)
不再引用 `doc/07-typescript-learning-path.md`。

## 遗留 / 后续

- [ ] changes/0001 里对 doc/07 的历史引用按约定保留(不改写历史)
- [ ] 阶段 6 剩余项(语音/插件管理界面/表情动画 HitAreas/桌面自动化/自动更新)完成后继续更新路线图
