// prepack 保险：确保打包/本地安装的产物一定存在且不比源码旧。
// 找不到编译器时只告警、不阻断安装（避免把「没装 devDependencies」变成安装失败）。
import { spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const entry = join(root, 'lib', 'index.js')
const source = join(root, 'index.ts')

const missing = !existsSync(entry)
const stale = !missing && existsSync(source) && statSync(source).mtimeMs > statSync(entry).mtimeMs

if (!missing && !stale) {
  console.log('[digital-life-core] 构建产物已是最新，跳过预构建')
  process.exit(0)
}

console.log(`[digital-life-core] ${missing ? '缺少' : '发现过期的'} lib/index.js，开始预构建…`)
const build = spawnSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'], {
  cwd: root,
  stdio: 'inherit',
})

if (build.status !== 0 || !existsSync(entry)) {
  console.warn(
    '[digital-life-core] 预构建失败：请在本目录手动执行 `npm install && npm run build` 后再安装。'
    + '注意——安装一个没有 lib/index.js 的包，DSH 会挂载失败并且看不到任何 digital_life_* 工具。',
  )
  process.exit(0)
}
console.log('[digital-life-core] 预构建完成：lib/index.js')
