#!/usr/bin/env node
/**
 * 阶段 5 打包脚本(electron-builder 的"独立目录"工作流)。
 *
 * 为什么不在 apps/pet 原地打包:
 * 1. electron-builder 的 pnpm 依赖收集器会把 pnpm-workspace.yaml 所在根(整个
 *    59 包 monorepo)当作搜索目录,`pnpm list --prod --depth Infinity` 输出全
 *    工作区树,再逐个包做磁盘探测 —— 实测卡死 20+ 分钟(见 0009 踩坑记录)。
 * 2. npm 收集器在本机 PowerShell 执行 .cmd 时会回显 "Active code page: 65001"
 *    污染 JSON 输出,collector 解析失败 → 构建直接报错。
 *
 * 解法:把已构建产物(out/ + assets/ + build/)复制到工作区外的临时独立目录
 * (无 node_modules、无 pnpm-workspace.yaml、无 lockfile),在那里跑
 * electron-builder:
 * - PM 检测:无 lockfile → 回退环境检测 → pnpm(继承 npm_execpath);
 * - `pnpm list` 在独立目录只输出"空依赖的自引用"单条目 → 收集瞬间完成;
 * - 收集结果为空 → 打包产物零 node_modules(主进程/渲染进程/ MCP server 均
 *   已全量打包,out/main/mcp-server.js 自包含)。
 *
 * 用法:
 *   node scripts/package.mjs [--dir] [--] [electron-builder 额外参数]
 *   --dir    只打免安装目录(dist/win-unpacked),用于快速验证
 *   默认     按 electron-builder.yml 打 NSIS + portable
 *
 * 产物直接输出到 apps/pet/dist/(electron-builder 的 directories.output 重定向)。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import os from 'node:os'

const petRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const stageDir = join(os.tmpdir(), 'dsh-pet-pack')
const ebCli = join(petRoot, 'node_modules', 'electron-builder', 'cli.js')

// 透传参数:--dir 打免安装目录;其余原样交给 electron-builder
const args = process.argv.slice(2)
const dirOnly = args.includes('--dir')
const ebArgs = args.filter((a) => a !== '--dir')

const pkg = JSON.parse(readFileSync(join(petRoot, 'package.json'), 'utf8'))
const version = pkg.version

// 1. 重建独立 staging 目录
rmSync(stageDir, { recursive: true, force: true })
mkdirSync(join(stageDir, 'out'), { recursive: true })
mkdirSync(join(stageDir, 'build'), { recursive: true })
cpSync(join(petRoot, 'out'), join(stageDir, 'out'), { recursive: true })
cpSync(join(petRoot, 'assets'), join(stageDir, 'assets'), { recursive: true })
cpSync(join(petRoot, 'build'), join(stageDir, 'build'), { recursive: true })
cpSync(join(petRoot, 'electron-builder.yml'), join(stageDir, 'electron-builder.yml'))

// koffi 是 external 的原生 FFI 依赖(主进程 bundle 不自包含它,见 electron.vite.config):
// 打包时把 koffi 与平台包(内含 .node 二进制)原样拷进 staging 的 node_modules,
// 由 electron-builder.yml 的 files 收进产物、.node 解出 asar。
for (const dep of ['koffi', '@koromix/koffi-win32-x64']) {
  const src = join(petRoot, 'node_modules', dep)
  const dest = join(stageDir, 'node_modules', dep)
  if (!existsSync(src)) {
    console.error(`[package] 缺少 koffi 依赖:${src}(先 pnpm install)`)
    process.exit(1)
  }
  // dereference:pnpm 的 node_modules/koffi 是符号链接,必须拷真实内容
  cpSync(src, dest, { recursive: true, dereference: true })
}

// 独立目录的 package.json:声明 koffi(见下方说明),其余依赖清空
// (产物已自包含);保留元信息;electron 版本由 electron-builder.yml 的 electronVersion 决定。
writeFileSync(
  join(stageDir, 'package.json'),
  JSON.stringify(
    {
      name: pkg.name,
      description: pkg.description,
      version,
      author: pkg.author,
      license: pkg.license,
      type: 'module',
      main: './out/main/index.js',
      // electron-builder 的 files 模式**不处理 node_modules**,node_modules 只由
      // 依赖收集器管理(无 lockfile → manual traversal 扫描物理 node_modules)。
      // 因此这里必须声明 koffi 两个包,收集器才会把上方拷贝进来的 koffi
      // (含 @koromix 平台包的 .node 二进制)收进产物并自动解出 asar。
      dependencies: {
        koffi: '3.1.5',
        '@koromix/koffi-win32-x64': '3.1.5',
      },
      devDependencies: {},
    },
    null,
    2,
  ),
)

// 2. 跑 electron-builder(cwd = staging;继承 npm_execpath → PM 检测为 pnpm,
//    独立目录下 pnpm list 秒回,收集零 node_modules)
const outputDir = join(petRoot, 'dist')
const cmdArgs = [
  ebCli,
  '--config',
  join(stageDir, 'electron-builder.yml'),
  `--config.directories.output=${outputDir}`,
  ...ebArgs,
  ...(dirOnly ? ['--dir'] : []),
]
console.error(`[package] electron-builder in ${stageDir}`)
console.error(`[package] ${process.execPath} ${cmdArgs.join(' ')}`)
const result = spawnSync(process.execPath, cmdArgs, {
  cwd: stageDir,
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_BUILDER_CACHE: process.env.ELECTRON_BUILDER_CACHE ?? join(os.homedir(), '.cache', 'electron-builder') },
})
if (result.status !== 0) {
  console.error(`[package] electron-builder exited ${result.status ?? 'signal'}`)
  process.exit(result.status ?? 1)
}

console.error(`[package] done: artifacts in ${outputDir} (version ${version})`)
