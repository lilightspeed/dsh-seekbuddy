# DSH 桌面宠物(ds-pet)

DSH 桌面宠物 —— DeepSeek Harness 的**第二个、常驻、对等客户端**:一个独立 Electron 窗口,
既能通过 DSH 的 `/api` + WebSocket 主动操作/观察 DSH,又能作为 MCP server 被 DSH Agent 反驱动
(Agent → 宠物)。

它不只是一个"会动的挂件",而是与 Web GUI 同级的、loopback 受信的对等客户端:
宠物既通过 `/api` 主动控制并实时观察 DSH,又在本地跑一个 MCP server,把"说话 / 做动作 / 弹提醒"
暴露成 `mcp__pet__*` 工具给 Agent 调用。

- 技术栈与工程结构、开发命令见 [AGENTS.md](./AGENTS.md)。
- 架构 / 技术 / DSH 集成 / MCP / Live2D 等主题文档见 [doc/](./doc/README.md)。
- 动画素材放置与命名规则见 [assets/pet/README.md](./assets/pet/README.md)。
- Live2D 模型兼容性说明见 [assets/pet/live2d/README.md](./assets/pet/live2d/README.md)。

## 宠物形象(角色设计)

本项目的角色是 **DeepSeek 鲸鱼标识的"娘化 + 女仆装"Q 版形象**,Live2D 模型名为 `ds-pet`
(model3.json 入口为 `ds-pet.model3.json`)。

参考图(位于 Windows 截图目录,未入库)如下:

```
C:\Users\wanyu\Pictures\Screenshots\屏幕截图 2026-08-22 184155.png
```

### 形象特征

- **头身比**:Q 版(Chibi),大头、大眼、圆润,适合作为桌面宠物窗口的主体。
- **头发**:长发,**蓝色**主色,头顶有一撮**呆毛(ahoge)**;侧边(右)系一个**蓝色蝴蝶结**。
- **眼睛**:大而圆的**蓝色**眼睛,与发色呼应。
- **头部装饰**:白色荷叶边**女仆头饰/发带**。
- **服饰**:白色**女仆装**,配深蓝/海军蓝细节;胸前有深色蝴蝶结(领结),腰身一段深蓝束身。
- **鲸鱼元素**:身体一侧/身后有一片**深蓝色鲸尾(鲸鳍)**,直接点明"DeepSeek 鲸鱼"的出身,是整个形象最具辨识度的设计语言。
- **背景**:参考图为深色背景(透明窗口下角色本体即窗口主体),突出角色本体。

### 设计要点 / 约定

- 角色配色以**蓝 + 白(配深蓝点缀)**为主,与 DSH 的 DeepSeek 蓝主题一致;Live2D 模型的贴图/配色属于
  模型资产本身,不随界面主题换肤(见 `doc/changes/0022-deepseek-blue-theme.md`)。
- 运行时用 **Live2D(官方 Cubism SDK + 独立 canvas 自绘)** 渲染;WebGL2 不可用时回落到 PixiJS 几何"球宠"。
- 可交互、动画仲裁、Live2D 素材规范等详见 [doc/08-live2d-integration.md](./doc/08-live2d-integration.md)
  与 [doc/09-animation-arbitration.md](./doc/09-animation-arbitration.md),动画素材放置见
  [assets/pet/README.md](./assets/pet/README.md)。
- 其他素材(托盘/应用图标)可用角色头像,后续用正式头像替换 `assets/pet/icons/icon.png` 后重跑
  `scripts/make-icon.ps1`。

## 开发

```bash
pnpm install                                        # 仓库根:安装/链接依赖(electron 二进制走镜像)
pnpm --filter @deepseek-ai/dsh-pet run dev          # electron-vite 开发(出窗口)
pnpm --filter @deepseek-ai/dsh-pet run build        # 构建到 out/
pnpm --filter @deepseek-ai/dsh-pet run typecheck    # tsc --noEmit(node + web 两个配置)
pnpm exec tsx scripts/check-workspace-constraints.ts # 根仓库:workspace 约束 gate
```

DSH 运行实例默认在 `http://127.0.0.1:3080`(loopback 受信,宠物权限与 Web GUI 同级;不要部署到非 loopback)。

## License

- 代码与文档遵循仓库约定;Live2D SDK(Framework/Core)与角色素材版权另算,详见
  [vendor/live2d/README.md](./vendor/live2d/README.md) 与 [assets/pet/README.md](./assets/pet/README.md) 的 License 表。
