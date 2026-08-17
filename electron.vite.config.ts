import { builtinModules } from 'node:module'
import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: {
    build: {
      // 多入口:默认主进程 index + 阶段 4 的独立 MCP stdio server(被 DSH spawn)。
      // 阶段 5:不再 externalize 依赖(@deepseek-ai/dsh-host-apiproxy 的 workspace 闭包
      // 有 30+ 包,打包时拖 node_modules 既脆弱又臃肿)—— 改为全量打包成自包含
      // bundle(只 external electron 与 node 内置模块),打包产物零 node_modules 依赖,
      // mcp-server.js 也因此能被 DSH 用裸 node 直接 spawn(配合 asarUnpack)。
      // koffi 除外:它是带 native 二进制(.node)的 FFI 库,打进 bundle 会丢失
      // 原生模块("Cannot find the native Koffi module"),必须 external,运行时
      // 从 node_modules 加载(dev 由 pnpm 解析,dist 由 electron-builder 打包)。
      rollupOptions: {
        external: ['electron', 'koffi', /^electron\/.+/, ...builtinModules.flatMap((m) => [m, `node:${m}`])],
        input: {
          index: resolve(import.meta.dirname, 'src/main/index.ts'),
          'mcp-server': resolve(import.meta.dirname, 'src/main/mcp/server.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    // 把 apps/pet/assets 作为 renderer 的静态根:dev 下 /pet/** 直接可访问,
    // build 时拷入 out/renderer(素材统一放 assets/pet/,见其 README 规则)。
    publicDir: resolve(import.meta.dirname, 'assets'),
    resolve: {
      alias: {
        // Cubism Framework 编译产物(vendor/live2d/README.md 有再构建说明)。
        '@live2d/framework': resolve(import.meta.dirname, 'vendor/live2d/Framework/dist/src'),
      },
    },
  },
})
