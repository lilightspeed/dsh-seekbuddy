# design/live2d —— Live2D 编辑器源文件(非运行时)

> 这里是角色 **`ds-pet`** 的 **Cubism Editor 源工程**,不是运行时资源。

## 是什么

| 文件 | 说明 | 体积 |
|---|---|---|
| `ds-pet.cmo3` | Cubism Editor 主工程(角色网格 / 参数 / 变形器 / 动画时间轴 / 物理接线)**源文件** | ~50 MB |
| `ds-pet-mothon.can3` | 配套素材文件(编辑器辅助源) | ~0.1 MB |

## 与运行时资源的关系

- 运行时加载的是 **`assets/pet/live2d/`** 下的导出物(`ds-pet.model3.json` →
  `ds-pet.moc3` + 纹理 + `physics3.json` + `cdi3.json` 等)。那才是 app 实际用、会被打包的。
- 本目录是**用 Cubism Editor 编辑/再导出**的**源工程**,app **运行不需要它**。
  **不在打包范围内**(electron-builder `files` 只含 `out/**` 与 `assets/**`,web publicDir 也只指向 `assets/`),
  因此不会进 `node_modules`、`out/` 或安装包。

## 怎么用

- 用 **Live2D Cubism Editor** 打开 `ds-pet.cmo3` 修改(网格 / 贴图 / 物理 / 动画 / 参数)。
- 修改后按 `assets/pet/live2d/README.md` §4 的**导出清单**重新导出到 `assets/pet/live2d/`,
  并核对 model3.json 的引用(参数改名必须整包重导)。
- 改完把更新后的 `.cmo3` / `.can3` 放回本目录(保持源与产物在同一个仓库内)。

## 使用前必读

- 需要 **Cubism Editor**(官方付费/试用版)才能打开编辑;非编辑器用户只读本仓库的运行时产物即可。
- 模型 moc3 格式版本 = **6**(`MocVersion_53`,5.3.00+),配套 SDK 为 Cubism SDK for Web **5-r.5**
  (Core 06.00.0001,见 `vendor/live2d/README.md`)。用旧 Editor/Core 打开或导出可能不兼容。

## 许可(本目录素材 = CC BY-NC-SA 4.0,非 MIT)

- **角色形象素材(源工程 / 立绘 / 贴图 / 动画)**版权归:
  - **上善无形**(B 站) —— 鲸鱼娘**角色形象原作**
  - **ZipZipPipe**(B 站 / [Pixiv](https://www.pixiv.net/users/18604994)) —— 加入 DeepSeek 元素的**女仆鲸鱼娘二次设计**
- 本仓库的正面视图、表情等素材**在上两人基础上由本项目 AI 重绘/再创作**,属**衍生作品**;依据
  CC BY-NC-SA 4.0 的「相同方式共享」,**衍生作品同样遵循 CC BY-NC-SA 4.0**。
- 许可约束:**署名**(上善无形 & ZipZipPipe)、**非商业**、**相同方式共享**(衍生必须同许可,不能改 MIT)。
- 因此**本目录不能按 MIT 授权**;再分发请保持 CC BY-NC-SA 4.0 并保留上述署名。
- 若你不接受 CC 约束(尤其「非商业」),请**不要提交本目录**(只提交 `assets/pet/live2d/` 的运行时
  导出物,那同样受 CC BY-NC-SA 4.0 约束)。
- 运行时(渲染/动画系统/交互逻辑)为本项目自研,遵循仓库根 `LICENSE`(MIT)。

> ⚠️ **体积提示**:`ds-pet.cmo3` 约 50 MB。仓库已配置 **Git LFS**(`.gitattributes` 把
> `*.cmo3` / `*.can3` 走 LFS),`git add` 这些文件会按 LFS 指针入库,`git lfs push` 上传实体,
> 不使 git 仓库膨胀。
