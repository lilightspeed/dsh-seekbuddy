# 0031 · 设置面板:视线跟随相关滑块收进可展开合集「视线跟随鼠标时」

## 状态

草稿(2026-08-17 typecheck + build 通过;待真机目视确认后改"已验证")

## 日期

2026-08-17

## 目的

设置页「宠物(Live2D)」组的滑块已到 10 个,视线跟随相关参数混在一起不便浏览。
把 7 个**视线跟随行为**相关的滑块收进一个可展开合集「视线跟随鼠标时」,默认收起,点标题展开调节;
外观类(水平/垂直位置、显示大小)保持直接可见。

## 改动清单

### apps/pet(独立仓库)

| 文件 | 改动 |
|---|---|
| `src/renderer/index.html` | 7 行滑块(头部幅度/眼珠幅度/瞳孔灵敏度/瞳孔收缩/死区/跟随距离/跟手速度)包进 `<details class="setting-pet-collapse"><summary>视线跟随鼠标时</summary>…</details>`;新增合集折叠 CSS(隐藏原生 marker、▸/▾ 箭头旋转动画、hover 高亮) |
| `doc/changes/0031-settings-follow-collapse.md` | 本文 |

### 未改动(设计使然)

- `panel.ts`:**零改动** —— details 折叠只影响可见性,滑块元素始终在 DOM 中,
  `querySelector` 回填 / 标签刷新 / 120ms 防抖补丁 / 事件绑定全部照常工作。
- 配置链路(pet-config / config.ts / preload / main):无改动,合集只是 UI 收纳。

## 关键决策

1. **用原生 `<details>`/`<summary>` 而非 JS 折叠**:浏览器原生展开/收起,零 JS、零状态管理;
   `refreshSettings` 等逻辑不受影响。代价是默认样式需覆盖(隐藏 `::-webkit-details-marker` +
   `list-style: none`),用 `::before` 的 `▸` 做指示,展开时 `rotate(90deg)` 变为 `▾`。
2. **默认收起**:用户表述为"可展开合集来调节",收纳意图明确;展开是主动操作。
   若想要默认展开,给 `<details>` 加 `open` 属性即可,一行改动。
3. **合集内外的划分**:水平/垂直位置与显示大小属于**外观**(随时可见、常调),留在合集外;
   7 个行为参数(幅度/瞳孔/死区/距离/速度)归入「视线跟随鼠标时」,语义一致。
4. **样式沿用浅色面板 + DeepSeek 蓝**:summary 复用 setting-label 的观感(12px/#666/600),
   箭头与 hover 用主题蓝 #4176e6,与 0022 主题一致。

## 踩坑记录

- 无(纯静态 HTML/CSS 改动;细节为 `details` 默认三角在 Chromium 需 `::-webkit-details-marker`
  隐藏、Firefox 需 `list-style: none`,双写避免跨浏览器残留)。

## 验证结果

```powershell
pnpm --filter @deepseek-ai/dsh-pet run typecheck   # exit=0
pnpm --filter @deepseek-ai/dsh-pet run build       # exit=0
```

待用户真机:设置页「宠物(Live2D)」组显示 位置/大小 + 「视线跟随鼠标时 ▸」标题;
点击标题展开 7 个滑块、箭头旋转为 ▾,拖动仍实时生效;收起后设置持久化不受影响。

## 遗留 / 后续

- [ ] (可选)若想要默认展开合集,给 `<details>` 加 `open`
