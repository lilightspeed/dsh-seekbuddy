# 0022 · 主题换肤 —— 强调色由暖黄改为 DeepSeek 主题蓝

## 状态

已验证(2026-08-17;typecheck 通过)

## 日期

2026-08-17

## 目的

pet 界面(输入条按钮、面板激活 tab、目标横幅、审批卡、设置滑块等)的强调色是暖黄/橙色
(`#ffaa55` / `#ff9933` 系),与 DSH 本体 Web UI 的蓝色主题不一致。本次把整条强调色
换成与 DeepSeek 主题相同的蓝色系——色值直接取自根仓库
`packages/client/ui-theme/src/styles/design-platform.css` 的 `--dsw-static-deepseek-*`
静态色(浅色模式主色为 deepseek-500 `#4176e6`)。

## 改动清单

### apps/pet(独立仓库)

| 文件 | 改动 |
|---|---|
| `src/renderer/index.html` | 全部 29 处黄色强调色按映射表替换为 DeepSeek 蓝(见下表);无 CSS 结构变化 |
| `src/renderer/src/pet/sprite-animator.ts` | PixiJS 占位"球宠"5 个状态体色:黄/橙(0xffaa55、0xffcc33、0xffaa88)改为蓝系,浅蓝/灰蓝状态对齐 deepseek scale |
| `doc/changes/0022-deepseek-blue-theme.md` | 本文 |

### 色板映射(黄色 → DeepSeek 蓝)

| 原色 | 新色 | DeepSeek token |
|---|---|---|
| `#ffaa55`(主强调:按钮/激活 tab/边框/accent-color/目标标签) | `#4176e6` | deepseek-500 |
| `#ff9933`(悬停/高亮:按钮 hover、设置值文本、面板按钮 hover 色) | `#679efe` | deepseek-400 |
| `rgba(255, 170, 85, X)`(半透明强调背景:会话行 hover/选中、目标横幅、插件待审批、历史标题/tool 行) | `rgba(65, 118, 230, X)` | deepseek-500 + alpha(保持同色相) |
| `rgba(255, 248, 235, 0.97)`(审批卡底) | `rgba(237, 243, 254, 0.97)` | deepseek-50 |
| `#ffd9a0`(审批卡浅边框) | `#d3e2ff` | deepseek-200 |
| `#7a4a00`(深强调文字:目标横幅文案、历史标题) | `#2f4c8f` | deepseek-700 |
| `#8a5a00` / `#9a5b00`(中强调文字:审批标题、插件待审批状态、历史 tool 行) | `#4868b2` | deepseek-600 |
| `#b07000`(交互文字:横幅清除按钮) | `#5686fe` | deepseek-450 |

球宠状态色:`idle 0xffaa55 → 0x4176e6`(deepseek-500)、`thinking 0x88ccff → 0xb7c8fe`
(deepseek-300)、`happy 0xffcc33 → 0x679efe`(deepseek-400)、`sad 0x99aacc` 保留、
`talking 0xffaa88 → 0x5686fe`(deepseek-450)。

## 关键决策

1. **色值来源以根仓库 design-platform.css 为准**:直接抄 `--dsw-static-deepseek-*`
   静态色 hex,不凭印象选色,保证与 DSH Web 主题"同一蓝色系";浅色模式主色取
   `--dsw-alias-brand-primary-new-colorprimary-new-color` 的 light 值 deepseek-500。
2. **悬停色用 deepseek-400 而非加深**:浅色模式下主题别名
   `--dsw-alias-button-info-hover: deepseek-400`,与主题的"悬停提亮"习惯保持一致。
3. **半透明背景保留原 alpha,只换 RGB**:`rgba(255,170,85,X)` 的透明度语义(选中 0.3、
   悬停 0.15 等)不变,只把 RGB 换成 deepseek-500(65,118,230),色相统一、深浅层级不破坏。
4. **文字色选深档保证可读性**:深/中强调文字用 deepseek-700/600(对比度高于 400/450),
   浅色底(白/极浅蓝)上的可读性与原橙系文字相当。
5. **占位球宠一并换色**:虽然现役动画后端是 Live2D(模型贴图自带颜色、不受主题控制),
   PixiJS 球宠是 WebGL2 不可用时的回落后端,若仍保留黄色会在回落时与主题割裂,故同步纳入。
   眼睛/嘴的深棕(0x332211/0x553322)是面部特征色,非主题色,不动。

## 验证结果

- `apps/pet` 全仓库 grep 黄色残留(`ffaa|ff9933|ffcc33|ffd9|255,170,85|255,248,235|7a4a00|8a5a00|9a5b00|b07000`):无匹配。
- `apps/pet` 全仓库 grep 新蓝(`4176e6|679efe|65,118,230|237,243,254|d3e2ff|2f4c8f|4868b2|5686fe`):index.html 29 处 + sprite-animator.ts 5 处,与映射表一一对应。
- `pnpm --filter @deepseek-ai/dsh-pet run typecheck`:通过(TS 字面量改动)。

## 遗留 / 后续

- 本改动为源码级;正在运行的宠物窗口需重启 dev 或重新构建后才会显示蓝色主题。
- Live2D 模型的贴图/配色是模型资产本身的,不属于界面主题,未纳入本次换肤。
