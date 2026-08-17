# vendor/live2d —— Cubism SDK for Web 5-r.5(仓库内 vendor)

> 官方 Cubism SDK for Web 5-r.5(`CubismSdkForWeb-5-r.5.zip`)的仓库内副本,供 DSH 桌面宠物
> renderer 使用。**许可**:Core 为 Live2D Proprietary Software License,Framework 为
> Live2D Open Software License,详见本目录各 LICENSE/NOTICE 文件;角色素材版权另算。
> 接入方案见 `doc/08-live2d-integration.md`,模型兼容性见 `assets/pet/live2d/README.md`。

## 目录

| 路径 | 内容 | 用途 |
|---|---|---|
| `Core/live2dcubismcore.d.ts` | Core 全局命名空间类型声明 | 编译/typecheck 用(运行时是 `assets/pet/live2d/core/live2dcubismcore.js`,经 index.html script 标签引入) |
| `Core/LICENSE.md` | Core 专有许可 | 许可合规 |
| `Framework/src/` | 官方框架 TS 源码(59 文件,含 1 处本地补丁) | 编译输入 |
| `Framework/dist/` | 编译产物(ESM + d.ts,118 文件) | renderer 实际引用(别名 `@live2d/framework`) |
| `Framework/tsconfig.build.json` | 仓库内编译配置 | 再构建用 |
| `Framework/LICENSE.md` | Framework 开源许可 | 许可合规 |
| `LICENSE.md` / `NOTICE.md` | SDK 根许可/声明 | 许可合规 |

运行时还用到两份静态资源(在 `assets/pet/live2d/`,经 publicDir 提供):

- `core/live2dcubismcore.js` —— 定义全局 `Live2DCubismCore`(index.html 引用)
- `shaders/*.vert|*.frag` —— WebGL 着色器(renderer.loadShaders 按路径拉取)

## 版本与兼容性

- SDK:Cubism SDK for Web **5-r.5**(id 10,2026-04-01);Core 版本 **06.00.0001**
- 本仓库模型 `ds-pet.moc3` 的格式版本 = **6**(= `MocVersion_53`,5.3.00+),该 Core 支持 ✅
- 经典插件 `@pixi/live2d-display` 仅支持 Pixi v6/v7 且不再维护 → 本项目走**独立 canvas 自绘**
  (`src/renderer/src/pet/live2d/cubism-runtime.ts`),见 doc/08 §4。

## 再构建 Framework(dist)

框架以"编译后 vendor"方式引用:源码不进 renderer 的 strict typecheck 程序,产物直接打包。
用**官方同版本 TypeScript 5.9.3**(TS 6 会因严格性/方差规则多报 2 个错误):

```powershell
pnpm --package=typescript@5.9.3 dlx tsc -p vendor/live2d/Framework/tsconfig.build.json
```

本地补丁(升级 SDK 时需重新核对):

- `Framework/src/rendering/cubismoffscreenrendertarget_webgl.ts` —— `_gl` 字段加 `declare`
  (较新 TS 报 TS2612"覆盖基类属性";运行时字段由基类提供)。

## 更新 SDK 的步骤

1. 从 https://www.live2d.com/download/cubism-sdk/download-web/ 下载新版 zip;
2. 覆盖 `Core/*`、`Framework/src/**`、`Framework/LICENSE.md`、根 `LICENSE.md`/`NOTICE.md`;
3. 同步 `assets/pet/live2d/core/live2dcubismcore.js` 与 `assets/pet/live2d/shaders/**`;
4. 按上文再构建 dist,核对补丁;更新本文件版本号与 moc3 兼容性结论。
