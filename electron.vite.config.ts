import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
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
