import { builtinModules } from 'node:module'
import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      // 多入口:默认主进程 index + 阶段 4 的独立 MCP stdio server(被 DSH spawn)
      rollupOptions: {
        // 显式 external electron 与 node 内置模块:多入口配置下不能依赖
        // electron-vite preset 的默认 external 被合并覆盖(否则 electron 包
        // 会被内联,其 getElectronPath 会在 out/main 下找 dist 而失败)。
        external: ['electron', /^electron\/.+/, ...builtinModules.flatMap((m) => [m, `node:${m}`])],
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
  },
})
