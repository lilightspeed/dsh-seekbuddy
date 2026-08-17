# 0021 · 文档调整 —— Live2D 编辑器工程(.cmo3)移出 assets 至仓库外

## 状态

已验证(2026-08-17;纯文档改动,typecheck/build 不受影响)

## 日期

2026-08-17

## 目的

用户将 `assets/pet/live2d/project file/` 下的 Cubism Editor 工程文件
(`ds-pet.cmo3`、备份 `ds-pet - 副本.cmo3`)移出仓库,放到
`C:\Users\wanyu\Desktop\projects\live2d\`。同步更新引用这些文件的文档,
消除"project file/ 仍在 assets/、会被打进安装包"的过时描述。

## 改动清单

### apps/pet(独立仓库)

| 文件 | 改动 |
|---|---|
| `assets/pet/live2d/README.md` | §1 文件清单删除 `project file/ds-pet.cmo3` 行;目录说明改为"工程文件已移出 assets,存放于仓库外 `C:\Users\wanyu\Desktop\projects\live2d\`,不再随 publicDir 打包";§5 待办"project file/ 移出 assets"勾选完成(0021) |
| `doc/08-live2d-integration.md` | §3 兼容矩阵"编辑器工程文件"行的存放位置改为仓库外新路径;§5 体积/性能条目同步(不再打包) |
| `doc/changes/0021-live2d-project-files-out.md` | 本文 |

## 关键决策

1. **不把工程文件放回 assets/**:`.cmo3` 是编辑器工程,运行时用不到;放 assets/ 只会被
   publicDir 拷进 `out/renderer` 与安装包,白白增加体积(README 原待办)。仓库外存放既保留
   备份又不污染产物。
2. **文档记实际路径**:把 `C:\Users\wanyu\Desktop\projects\live2d\` 写进主题文档,
   后续维护者能按图索骥找到工程源文件。

## 验证结果

- `assets/pet/live2d/` 下已无 `project file/` 目录与 `.cmo3` 文件(glob 确认)。
- `C:\Users\wanyu\Desktop\projects\live2d\` 下确认存在 `ds-pet.cmo3` 与 `ds-pet - 副本.cmo3`。
- 全仓库 grep `project file|cmo3`:仅剩上述两篇主题文档与本文,均已更新为现状。
- 纯文档改动;`pnpm typecheck` / `pnpm build` 与此无关。

## 遗留 / 后续

- `out/renderer/pet/live2d/project file/` 仍是上次构建的旧拷贝(out/ 为 gitignore 产物,
  下次 `pnpm build` 重建后自动消失;dev 模式静态资源直出,不受影响)。
