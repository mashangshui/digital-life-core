/**
 * 看一眼「模型到底收到了什么」。
 *
 * 用法：
 *   node scripts/preview-prompt.mjs                 # 读默认存档
 *   node scripts/preview-prompt.mjs path/state.json # 读指定存档
 *
 * 三个设计约束：
 *   1. **不改真实存档**：把存档复制到临时目录再跑，衰减/落盘都发生在副本上。
 *   2. **不用模型**：只触发提示词组装（section 的 text provider），不发起任何请求。
 *   3. **会自检**：顺手检查注入文本里有没有体征读数——v0.9.1 之后不该有。
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, defaultStatePath } from '../lib/index.js'

const source = process.argv[2] ?? defaultStatePath()

/** 最小可用的 DSH 上下文：只实现插件真的会调的那几个面。 */
function stubCtx() {
  const sections = new Map()
  const handlers = new Map()
  return {
    tools: { register: () => () => {} },
    on: (event, handler) => {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(handler)
    },
    effect: (fn) => fn(),
    inject: (_deps, callback) => callback({ interval: () => () => {} }),
    get: (key) => {
      if (key === 'systemPrompt') {
        return { section: (def) => { sections.set(def.name, def); return () => {} } }
      }
      if (key === 'commands') return { register: () => () => {} }
      if (key === 'timer') return { interval: () => () => {} }
      return undefined
    },
    sections,
    handlers,
  }
}

const tmpDir = mkdtempSync(join(tmpdir(), 'dlc-preview-'))
const copy = join(tmpDir, 'state.json')

if (existsSync(source)) {
  copyFileSync(source, copy)
} else {
  const stamp = new Date().toISOString()
  mkdirSync(tmpDir, { recursive: true })
  writeFileSync(copy, JSON.stringify({
    version: 4, energy: 45, maxEnergy: 100, frozen: false,
    dopamine: 55, cortisol: 62, serotonin: 38,
    totalRequests: 0, blockedRequests: 0, totalTurns: 0, failedRequests: 0,
    lastInteractionAt: stamp, lastTransition: 'init', createdAt: stamp, updatedAt: stamp,
  }, null, 2))
  console.log(`（没有找到 ${source}，用一份合成存档演示）\n`)
}

const ctx = stubCtx()
apply(ctx, { statePath: copy, will: { enabled: false }, dream: { enabled: false } })

const section = ctx.sections.get('digital-life:endocrine')
if (!section) {
  console.error('未注册提示词段落：systemPrompt 服务不可用？')
  process.exitCode = 1
} else {
  const text = section.text()
  const state = JSON.parse(readFileSync(copy, 'utf8'))

  console.log('—— 存档里的真实体征（模型看不到这些数字）——')
  console.log(
    `能量 ${Math.round(state.energy)} · 多巴胺 ${Math.round(state.dopamine)}`
    + ` · 皮质醇 ${Math.round(state.cortisol)} · 血清素 ${Math.round(state.serotonin ?? 50)}`,
  )
  console.log('')
  console.log('—— 每次请求前注入 System Prompt 最前面的文本 ——')
  console.log(text)
  console.log('')

  const leaks = [
    ['能量', /能量\s*\d/],
    ['多巴胺', /多巴胺\s*\d/],
    ['皮质醇', /皮质醇\s*\d/],
    ['血清素', /血清素\s*\d/],
    ['张力', /张力\s*\d/],
  ].filter(([, re]) => re.test(text)).map(([label]) => label)

  console.log('—— 自检 ——')
  console.log(leaks.length === 0
    ? '✅ 没有任何体征读数（只剩行为指令）'
    : `❌ 仍在报数：${leaks.join('、')}`)
  console.log(text.includes('digital_life_status')
    ? '✅ 保留「用户明确要求报数」这一唯一出口'
    : '❌ 铁律里丢了唯一的报数出口')

  // 器官沙盒规则是独立段落（自举通道开着才有），单独打印，方便确认"出口"写进去了。
  const sandbox = ctx.sections.get('digital-life:organ-sandbox')
  console.log('')
  if (sandbox) {
    console.log('—— 器官沙盒规则（仅自举通道开启时注入）——')
    console.log(sandbox.text())
    console.log('')
    console.log(sandbox.text().includes('ctx.hostMetrics')
      ? '✅ 想读宿主指标的人能在这里被指到 ctx.hostMetrics'
      : '❌ 沙盒规则没给出口，器官作者只看到禁区')
  } else {
    console.log('（自举通道关闭，未注入器官沙盒规则）')
  }
}

rmSync(tmpDir, { recursive: true, force: true })
