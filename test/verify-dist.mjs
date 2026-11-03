// 打包体检：确认 DSH 真的能加载到这个插件（问题二的根因排查工具）
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const results = []

async function check(label, fn) {
  try {
    results.push({ ok: true, label, detail: await fn() })
  } catch (error) {
    results.push({ ok: false, label, detail: error.message })
  }
}

// 1. main 必须指向编译后的 .js，不能是 .ts
await check('main 指向编译产物 .js 且文件存在', () => {
  assert.ok(pkg.main, 'package.json 缺少 main 字段')
  assert.ok(pkg.main.endsWith('.js'), `main 指向了源码：${pkg.main}`)
  assert.ok(existsSync(join(root, pkg.main)), `main 文件不存在：${pkg.main}（先跑 npm run build）`)
  return pkg.main
})

// 2. exports 的 default / types
await check("exports['.'].default 指向 .js 且存在", () => {
  const target = pkg.exports?.['.']?.default
  assert.ok(target, "缺少 exports['.'].default")
  assert.ok(target.endsWith('.js'), `default 指向了源码：${target}`)
  assert.ok(existsSync(join(root, target)), `文件不存在：${target}`)
  return target
})

await check("exports['.'].types 指向 .d.ts 且存在", () => {
  const target = pkg.exports?.['.']?.types
  assert.ok(target?.endsWith('.d.ts'), `types 不合法：${target}`)
  assert.ok(existsSync(join(root, target)), `文件不存在：${target}`)
  return target
})

// 3. build 脚本
await check('package.json 声明了 build 脚本', () => {
  assert.ok(pkg.scripts?.build, '缺少 scripts.build')
  return pkg.scripts.build
})

// 4. dsh.bundle.patch 存在，且被 files 收录
const patchRel = pkg.dsh?.bundle?.patch
await check('dsh.bundle.patch 指向真实文件且被 files 收录', () => {
  assert.ok(patchRel, '缺少 dsh.bundle.patch —— 安装后不会被挂载')
  assert.ok(existsSync(join(root, patchRel)), `patch 文件不存在：${patchRel}`)
  const bare = patchRel.replace(/^\.\//, '')
  assert.ok((pkg.files ?? []).includes(bare), `files 未包含 ${bare}，发包后配置层会丢`)
  return patchRel
})

// 5. patch 里的 name 必须等于包名（模块解析靠包名）
await check('cordis.patch.yml 的 name 与包名一致', () => {
  const patch = readFileSync(join(root, patchRel), 'utf8')
  const ok = patch.includes(`name: '${pkg.name}'`) || patch.includes(`name: ${pkg.name}`)
  assert.ok(ok, `patch 里的 name 不是 ${pkg.name}`)
  return pkg.name
})

// 6. 产物能真实 import，并导出 Cordis 插件三件套
await check('产物可加载且导出 name / inject / apply', async () => {
  const mod = await import(pathToFileURL(join(root, pkg.main)).href)
  assert.equal(typeof mod.apply, 'function', '缺少 apply 导出')
  assert.equal(mod.name, pkg.name, `导出 name (${mod.name}) 与包名不一致`)
  assert.ok(Array.isArray(mod.inject) && mod.inject.includes('tools'), "inject 必须包含 'tools'")
  return `${mod.name} | inject=[${mod.inject.join(',')}]`
})

for (const r of results) {
  console.log(`${r.ok ? '✅' : '❌'} ${r.label} → ${r.detail}`)
}
const failed = results.filter((r) => !r.ok)
if (failed.length) {
  console.error(`\n${failed.length} 项未通过：DSH 很可能看不到 digital_life_* 工具。`)
  process.exit(1)
}
console.log('\n✅ 打包体检通过：DSH 能按 package.json 找到并加载这个插件')
