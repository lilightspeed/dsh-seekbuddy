# 0023 · 输入条贴底 —— 通栏贴窗底,与窗口边缘零空隙

## 状态

已验证(2026-08-17;纯 CSS 改动,静态验证,视觉效果待重启窗口确认)

## 日期

2026-08-17

## 目的

输入条原本是悬浮样式(`left/right/bottom: 10px`),离窗口底部与两侧各有 10px 空隙,
看起来像"浮在窗口里"。按用户要求改为**置于窗口底部、与窗口边缘紧密贴合、中间不留空隙**。

## 改动清单

### apps/pet(独立仓库)

| 文件 | 改动 |
|---|---|
| `src/renderer/index.html` | `#inputbar`:`left/right 10px → 0`、`bottom 10px → 0`(通栏贴底)、`border-radius 12px → 12px 12px 0 0`(仅顶部圆角)、`box-shadow 0 2px → 0 -2px`(阴影翻转到上方);`#panel` 与 `#approval-card` 的 `bottom 64px → 54px`(见关键决策 4) |
| `doc/changes/0023-inputbar-flush-bottom.md` | 本文 |

## 关键决策

1. **通栏贴底(两侧也归零)**:只贴底而两侧留 10px 会显得"悬空在底边",与"与窗口边缘紧密贴合"
   不符;`left/right: 0` 让输入条横贯窗口底部,两侧同样零空隙。
2. **底部圆角去掉(`12px 12px 0 0`)**:窗口本身透明,贴边后若保留底部圆角,圆角处会露出
   透明的窗口底角缺口;只留顶部圆角,底部与窗边直角相接。
3. **阴影方向翻转为向上(`0 -2px 8px`)**:原 `0 2px 8px` 的向下阴影被窗口底边整体裁掉,
   等于没有阴影;翻转后阴影从输入条顶部向外扩散,贴底的同时保留层次感。
4. **面板/审批卡 `bottom 64px → 54px`**:输入条整体下移 10px(顶边从约 52px 降到约 42px),
   若不调整,面板/审批卡与输入条之间的空隙会从 12px 拉大到 22px;同步下移 10px 保持原有
   12px 间距,底部叠层视觉节奏不变。审批卡仍保留左右 10px 边距(它是浮动卡片,不是贴边条)。

## 踩坑记录

- 无运行时踩坑。仅确认:renderer TS 中没有依赖输入条几何位置的代码
  (`grep inputbar|getBoundingClientRect|offsetHeight|bottom` 仅命中 CSS),纯 CSS 改动
  不影响 typecheck / 打包;`-webkit-app-region: no-drag` 保留,输入条仍可交互,拖拽区
  (`#stage` 全窗 drag)不受影响。

## 验证结果

- `apps/pet` grep `inputbar|getBoundingClientRect|offsetHeight`:renderer TS 无匹配,
  位置逻辑全部在 CSS。
- `#inputbar` 现为 `left: 0; right: 0; bottom: 0`,贴底通栏,底边与窗口边缘零空隙。
- `#panel` / `#approval-card` `bottom: 54px` ≈ 输入条顶部(约 42px)+ 12px 间距,与改动前一致。
- 纯 CSS,typecheck 不受影响(未重跑)。
- 视觉确认:需重启 dev 窗口或重新构建后观察。

## 遗留 / 后续

- 正在运行的宠物窗口需重启 dev / 重新构建后生效。
- 窗口缩放设置(60%–150%)按比例缩放整窗,贴底样式随窗口等比变化,无额外处理。
