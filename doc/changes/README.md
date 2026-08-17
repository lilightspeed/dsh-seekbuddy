# doc/changes —— 项目改动档案

> 本目录按"一次改动一篇文档"的方式,记录 `apps/pet` 开发过程中每一步的实际改动、决策与踩坑。
> 它是**变更记录**(发生了什么、为什么、怎么验证),不是操作手册;操作步骤见 `doc/05-scaffolding.md` 等主题文档。

## 约定

### 命名

```
NNNN-<简短英文slug>.md
```

- `NNNN`:四位递增序号(0001、0002、…),按改动发生顺序分配,不重复、不重排。
- slug:一眼能看出改动主题的英文短语(如 `scaffold-and-network-setup`)。

### 一篇改动文档必须包含的章节

| 章节 | 内容 |
|---|---|
| 状态 | `草稿` / `已验证` / `已废弃`(验证完成后把 `草稿` 改为 `已验证`) |
| 日期 | 改动完成(或开始)的日期 |
| 目的 | 这一步要解决什么问题、属于 doc/06 路线图的哪个阶段 |
| 改动清单 | 改了哪些文件、各自做了什么(根仓库与 apps/pet 分开列) |
| 关键决策 | 取舍与理由(为什么这样做、为什么不那样做) |
| 踩坑记录 | 实际遇到的坑、根因、解法 —— **这是最有价值的部分** |
| 验证结果 | 每个验收点的实际输出(命令 + 结果),能复现为准 |
| 遗留 / 后续 | 未完成的事、已知问题、下一步 |

### 更新时机

- **每完成一步**(阶段 0/1/2/… 或一次独立修复),写一篇新的 `NNNN` 文档。
- 已写过的文档原则上**不改写历史**;错误修正或补充放在新文档里说明,保持档案的时序性。

## 文档列表

| 编号 | 主题 | 状态 |
|---|---|---|
| [0001-scaffold-and-network-setup.md](./0001-scaffold-and-network-setup.md) | 阶段 0:脚手架搭建 + 国内网络镜像配置 | 已验证 |
| [0002-connectivity-poc.md](./0002-connectivity-poc.md) | 阶段 1:连通性 PoC(主进程 DSH 客户端层) | 已验证 |
| [0003-stage2-mvp.md](./0003-stage2-mvp.md) | 阶段 2:MVP(透明窗口 + 占位动画管线 + 状态机 + 气泡发消息) | 已验证 |
| [0004-ipc-undefined-arg-crash.md](./0004-ipc-undefined-arg-crash.md) | 修复:IPC 参数 undefined 触发主进程崩溃 | 已验证 |
| [0005-native-drag-region.md](./0005-native-drag-region.md) | 修复:拖拽改用原生 app-region(消除卡顿与 setPosition 崩溃) | 已验证 |
| [0006-stage3-operations.md](./0006-stage3-operations.md) | 阶段 3:会话列表/切换 + 历史查看 + 审批 + 系统通知 | 已验证 |
| [0007-session-panel-ux.md](./0007-session-panel-ux.md) | 修复:会话面板 UX —— 发送目标横幅 + 点击只设目标不跳转 | 已验证 |
| [0008-mcp-reverse-link.md](./0008-mcp-reverse-link.md) | 阶段 4:MCP 反向链路(Agent → 宠物 speak/setExpression/notify) | 已验证 |
| [0009-stage5-packaging-persistence.md](./0009-stage5-packaging-persistence.md) | 阶段 5:NSIS/portable 打包 + 单实例 + 开机自启 + 配置持久化 | 已验证 |
| [0010-scale-slider-oscillation.md](./0010-scale-slider-oscillation.md) | 修复:缩放滑块拖拽反馈回路(来回跳 10% / 窗口不断缩放)→ 松手应用 | 已验证 |
| [0011-packaged-mcp-verify.md](./0011-packaged-mcp-verify.md) | A1 收尾:打包版 MCP 反向链路实机验证(DSH → 打包 mcp-server → 宠物) | 已验证 |
| [0012-session-radar-merge.md](./0012-session-radar-merge.md) | B2 多会话雷达(并入会话页:实时状态列 + 运行中角标) | 已验证 |
| [0013-plugin-monitor-readonly.md](./0013-plugin-monitor-readonly.md) | B3(只读)插件监控:agent 中介读取 DSH 动态插件清单 | 已验证 |
| [0014-live2d-view-follow-skeleton.md](./0014-live2d-view-follow-skeleton.md) | Live2D 视角跟随:动画器骨架 + 跟随核心逻辑 + SDK 接缝(SDK 未接入,回落球宠) | 已验证 |
| [0015-live2d-cubism-runtime.md](./0015-live2d-cubism-runtime.md) | Live2D 视角跟随落地:vendor Cubism SDK for Web 5-r.5 + 独立 canvas 运行时(默认启用) | 已验证 |
| [0016-cursor-follow-fix.md](./0016-cursor-follow-fix.md) | 修复:视角跟随不动 —— 拖拽区域吞鼠标事件,光标改由主进程轮询推送 | 已验证 |
| [0017-pet-settings-tune.md](./0017-pet-settings-tune.md) | 视角跟随调优(Y 反转/幅度/窗外距离)+ 设置面板宠物参数(位置/大小/手感,持久化) | 已验证 |
| [0018-blink-breath.md](./0018-blink-breath.md) | 实现自动眨眼(显式注入眨眼参数 ID)+ 确认自动呼吸;解释 ParamAngleZ 未用与身体幅度无效果的原因 | 已验证 |
| [0019-breath-clamp-fix.md](./0019-breath-clamp-fix.md) | 修复:自动呼吸不可见 —— 加算型更新器的 load/save 节奏 + 呼吸 offset 校正(参数波形实测) | 已验证 |
| [0020-docs-cleanup.md](./0020-docs-cleanup.md) | 文档整理:删除 TS 学习路径,主题文档对齐现状(技术栈/结构/路线图/Live2D 落地) | 已验证 |
| [0021-live2d-project-files-out.md](./0021-live2d-project-files-out.md) | 文档:Live2D 编辑器工程(.cmo3)移出 assets 至仓库外 | 已验证 |
| [0022-deepseek-blue-theme.md](./0022-deepseek-blue-theme.md) | 主题换肤:强调色由暖黄改为 DeepSeek 主题蓝(design-platform deepseek scale) | 已验证 |
| [0023-inputbar-flush-bottom.md](./0023-inputbar-flush-bottom.md) | 输入条贴底:通栏贴窗底(两侧/底部零空隙),面板/审批卡同步下移 | 已验证 |
| [0024-inputbar-bottom-round-corners.md](./0024-inputbar-bottom-round-corners.md) | 输入条底角圆角:贴底基础上底部抬高 6px,四角圆角留空隙,面板/审批卡同步上调 | 已验证 |
| [0025-inputbar-position-revert.md](./0025-inputbar-position-revert.md) | 输入条位置回退:整体贴底位置不动(bottom 0),仅保留四角圆角,面板/审批卡随动回退 | 已验证 |
| [0026-multiline-input-and-stop-button.md](./0026-multiline-input-and-stop-button.md) | 输入框多行自动增高(封顶后滚轮翻看)+ 运行中发送变红色停止按钮(sessions.cancel) | 已验证 |
| [0027-inputbar-detail-fixes.md](./0027-inputbar-detail-fixes.md) | 输入框细节修复:垂直等距 / 精确填满换行(break-all)/ 删除即时收缩 / 输入法不再反复换行 | 已验证 |
| [0028-drop-space-wrap.md](./0028-drop-space-wrap.md) | 决定:放弃"空格当普通字符"换行方案(Chromium 限制,用户确认当前排版已满足) | 已验证 |
| [0029-pupil-contraction-reaction.md](./0029-pupil-contraction-reaction.md) | 瞳孔收缩反应:空闲时鼠标快速接近宠物 → ParamPupilSize 缩瞳,停驻后缓慢复原 | 草稿 |
| [0030-settings-pupil-knobs.md](./0030-settings-pupil-knobs.md) | 设置面板:删除「身体幅度」滑块,新增瞳孔缩放(灵敏度 px/s + 收缩幅度),实时生效并持久化 | 草稿 |
| [0031-settings-follow-collapse.md](./0031-settings-follow-collapse.md) | 设置面板:视线跟随相关 7 个滑块收进可展开合集「视线跟随鼠标时」(原生 details,默认收起) | 草稿 |
