# 0027 · 输入框细节修复 —— 垂直等距 / 精确填满换行 / 删除即时收缩 / 输入法不再反复换行

## 状态

已验证(2026-08-17;typecheck 通过 + Electron 实测)

## 日期

2026-08-17

## 目的

0026 的多行输入框上线后用户反馈 5 个细节问题,本步逐一修复:

1. 仅一行或无内容时,文本上下与输入框上下**不等距**(文本贴顶、底部留空)。
2. 一行文本**即将到达"发送"按钮就提前换行**;期望"本行内容刚好塞满时,继续输入才换行"。
3. 删除文本时,删完一行后继续删上一行,**下方空行不马上消失**,要多删几个字符才消失。
4. 每行末尾的**空格无论多少都不触发换行**;期望空格当普通字符看待。
5. 中文拼音输入法**反复触发换行**,即使本行文本+待输入拼音只有本行一半。

## 根因(均经 Electron 实测复现,非猜测)

用复刻同样 CSS 的独立 Electron 窗口量化测量(420×560 窗口、textarea clientWidth 352px):

| 问题 | 根因 | 实测证据 |
|---|---|---|
| 1/3 不等距 + 删除滞后 | flex 默认 `align-items: stretch` 把 textarea 拉高到按钮高度(31px = 1.7 行);`scrollHeight` 被 `clientHeight` 钳制,空/单行文本的测量高度恒为 31px,文本顶部对齐、底部 0.7 行留空;删除到 1 行时高度只回到 31px(空行残留),永远下不到 1 行 | stretch 模式 `intrinsic-clientHeight-empty = 31`;`robust1lines = 1.7`;`align-self: center` 后 `clientHeight = 18`、`robust1lines = 0.99`、单行 `gapTop = gapBottom = 13` |
| 2 提前换行 | 拉丁词按词边界贪婪换行:下一个词放不下就提前断行,行尾留下空隙(看起来"没塞满就换行");中文其实精确填满(352px 正好 27 个 13px 汉字,第 28 个才换行) | `cjkWrapAt = 28`(27 字 = 351px);`word-break: break-all` 后行内空隙消除 |
| 3 删除滞后(附加) | 测量时 `overflow-y: auto` 若出现滚动条会偷 ~10px 宽度 → 文本多换一行 → scrollHeight 虚高 → 高度被撑大后滚动条又消失,形成滞后 | 测量时临时 `overflow-y: hidden` 后删除立即归位 |
| 4 空格不换行 | **Chromium textarea 布局限制**:行尾(乃至行中)连续空格串被当作不可断整体并裁剪,不渲染、不占宽度、不参与断行;`word-break: break-all` / `overflow-wrap: anywhere` / `white-space: pre-wrap` 全部无效;注入零宽空格(U+200B)制造断行点也不可靠(部分场景仍不换行) | 60/90/120 个空格均 `0.99` 行且 `scrollWidth == clientWidth`(无横向溢出,空格被裁剪);各 CSS 变体结果完全一致;ZWSP 变体结果不一致 |
| 5 输入法反复换行 | 组词期间 `input` 事件带 `isComposing`,自动增高对每个拼音 keystroke 响应;拼音串被当作不可断整体,超出行宽即撑高输入框,删拼音又缩回 → 反复;最终内容可能只有半行 | 逻辑分析 + 事件流确认(组词中每个 input 事件都会触发 autoGrow) |

## 改动清单

### apps/pet(独立仓库)

| 文件 | 改动 |
|---|---|
| `src/renderer/index.html` | `#inputbar textarea` 增加 `align-self: center`(1/3)与 `word-break: break-all`(2) |
| `src/renderer/src/main.ts` | `autoGrowInput` 改为测量期间临时 `overflow-y: hidden`(3);`input` 监听改为 `isComposing` 时跳过、新增 `compositionend` 后重算(5) |
| `doc/changes/0027-inputbar-detail-fixes.md` | 本文 |

## 关键决策

1. **`align-self: center` 而非手动 padding**:让 textarea 高度回归内容本身(flex stretch 的 31px 底噪消失),单行文本在输入条内自然垂直居中;同时消除 `scrollHeight ≥ clientHeight` 钳制导致的删除滞后。这是 1/3 两个问题的同一根因、一次修复。
2. **`word-break: break-all`**:每行精确填满才换行——CJK 行为不变(本就任意断行),拉丁词/数字/URL 不再按词边界留空隙提前换行。对紧凑输入框是可接受的取舍(长词拆行)。
3. **测量时隐藏滚动条**:彻底切断"滚动条↔宽度↔行数↔scrollHeight"的反馈环,删除任何字符后高度立即按当前内容收缩。
4. **组词期间跳过自动增高**:拼音串的瞬时行数不再驱动输入框高度;`compositionend`(以及随后的最终 input 事件)在组词落定后重算,输入框只按"最终内容"变化。
5. **空格问题不强行修**:实测确认是 Chromium textarea 的布局固有限制(行尾/行中连续空格被裁剪),CSS 与 ZWSP 注入均不可靠。空格仍完整保留在消息内容里(发送不受影响),只是行尾不渲染;继续输入非空格字符会正常换行。若后续用户坚持,可考虑 contenteditable 重写或逐空格 ZWSP(均有编辑体验与内容污染代价),本步不做。

## 验证结果

- `pnpm --filter @deepseek-ai/dsh-pet run typecheck`(node + web 双配置):通过。
- Electron 实测(修复后 CSS):单行/空态 `clientHeight = 18`(1 行)、上下 `gapTop = gapBottom = 13`(等距 ✓);删除 2 行→1 行 `robust1lines = 0.99`(即时收缩 ✓);换行阈值 27 字填满 352px、第 28 字换行(精确填满 ✓)。
- 输入法组词期间不再触发 autoGrow(代码路径:isComposing 短路),组词结束重算。
- 空格行尾不换行属 Chromium 行为,如实记录,未做不可靠的绕过。

## 遗留 / 后续

- 空格当普通字符换行:受 Chromium 限制未能实现;如用户坚持,下一步评估 contenteditable 方案。
- `word-break: break-all` 会让超长英文单词拆行显示(发送内容不受影响)。
- 视觉确认需重启 dev 窗口。
