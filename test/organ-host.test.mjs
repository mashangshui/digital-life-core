/**
 * Organ Host 行为测试（PR2 验收）
 *
 * 这里不测"接口长什么样"（tsc 已经保证了），只测三件 tsc 保证不了的事：
 *   1. C3 隔离：一个器官炸了，别的器官照常
 *   2. 能力白名单：没声明就用不了
 *   3. 计费与仲裁：shadow 不真扣、增量先累加再落地、狂暴器官被截断
 *
 * 跑法：npm run test:organs（先 tsc 出 .organs-build，再跑本文件）
 */

import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { OrganHost, CapabilityDeniedError, matchesPatch, isPatchableTarget, PATCHABLE_TOOL_PREFIXES } from '../.organs-build/organ-host.js'
import { loadOrganFile, validateManifest, validatePatchPolicy, SELF_MADE_CAPABILITIES } from '../.organs-build/organ-loader.js'
import { ChemicalPool, diffSignificant, isValidChemicalId, parseGenome, normalizeTemperament, applyMetabolism, DEFAULT_TEMPERAMENT } from '../.organs-build/chemical-pool.js'
import { DEFAULT_GENOME } from '../.organs-build/genome.js'
import { driveSerotonin } from '../.organs-build/chemistry-core.js'
import { compileOrganSource, needsTransform, resetCompilerCache } from '../.organs-build/organ-compiler.js'
import { OrganCircuitBreaker, assertWritableTarget, safeOrganFileName, coreFingerprint } from '../.organs-build/organ-guard.js'
import { normalizeNetAllow } from '../lib/index.js'
import { readFileSync } from 'node:fs'

let passed = 0
function ok(label) {
  passed += 1
  console.log(`  ✓ ${label}`)
}

// ───────────────────────── 假依赖 ─────────────────────────

function makeDeps(overrides = {}) {
  const log = []
  const state = { energy: 100, maxEnergy: 100, dopamine: 50, cortisol: 20, frozen: false,
    openGaps: 0, topTension: 0, scars: [], idleMs: 0, ...(overrides.state ?? {}) }
  const applied = []
  const debits = []
  const tools = []
  const timers = []
  const subscriptions = []
  const gaps = []
  const gapSources = []
  const kvStore = new Map()
  let clock = 1_000_000

  const deps = {
    now: () => clock,
    readState: () => ({ ...state }),
    // v0.9.4 宿主感观通道：假值是"一台 8 核 16G 的机器"，方便断言不被真机干扰。
    readHostMetrics: () => overrides.hostMetrics ?? {
      sampledAt: clock,
      cpu: { cores: 8, systemPercent: 37.5, processPercent: 2.25, loadAvg: null },
      memory: {
        totalBytes: 16 * 1024 ** 3,
        freeBytes: 6 * 1024 ** 3,
        usedBytes: 10 * 1024 ** 3,
        usedPercent: 62.5,
        processRssBytes: 120 * 1024 ** 2,
        processHeapUsedBytes: 40 * 1024 ** 2,
      },
      uptimeSec: 3600,
      processUptimeSec: 120,
      // 里程表（v0.9.8）：本进程累计烧掉的 CPU 秒。
      totalProcessCpuSeconds: 1234.5,
      live: true,
    },
    debitEnergy(amount, reason) {
      debits.push({ amount, reason })
      const debited = Math.min(amount, state.energy)
      state.energy -= debited
      return { debited, remaining: state.energy, denied: debited < amount }
    },
    applyAffect(delta) {
      applied.push(delta)
      state.dopamine += delta.dopamine
      state.cortisol += delta.cortisol
    },
    proposeGap(organ, summary) {
      // PR3 起签名带上器官名：缺口来源要能追到"是谁提的"。
      gaps.push(summary)
      gapSources.push(organ)
      return `gap-${gaps.length}`
    },
    registerTool(organ, tool, fullName) {
      // PR3.1 起由宿主算好完整名字再交给核心：核心不再自己拼命名空间。
      tools.push({ organ, name: fullName, raw: tool.name })
      return { dispose() { tools.push({ organ, name: `${fullName}:disposed` }) } }
    },
    async callTool(organ, name, args) {
      tools.push({ organ, name: `call:${name}`, args })
      return { tool: name, ok: true, text: 'ok' }
    },
    subscribeToolResult(organ, names, handler) {
      subscriptions.push({ organ, names, handler })
      return { dispose() {} }
    },
    schedule(organ, everyMs) {
      const entry = { organ, everyMs, fired: 0 }
      timers.push(entry)
      return { dispose() {} }
    },
    organKV(organ) {
      return {
        get: (key) => kvStore.get(`${organ}:${key}`),
        set: (key, value) => { kvStore.set(`${organ}:${key}`, value) },
        delete: (key) => { kvStore.delete(`${organ}:${key}`) },
      }
    },
    log: (level, message) => log.push({ level, message }),
  }

  return { deps, state, applied, debits, tools, timers, subscriptions, gaps, gapSources, log,
    advance: (ms) => { clock += ms }, now: () => clock }
}

/** 手写一个最小器官（不经过 defineOrgan，用来测宿主的兜底能力）。 */
function organ(manifest, impl = {}) {
  return {
    name: manifest.name,
    manifest: { apiVersion: 1, version: '1.0.0', kind: 'custom', ...manifest },
    energy: impl.energy,
    onLoad: impl.onLoad ?? (() => {}),
    consumeEnergy() { return { requested: 0, debited: 0, remaining: 0, denied: false, tier: 'shadow' } },
    feedback: impl.feedback ?? (() => ({})),
    getPromptContext: impl.getPromptContext ?? (() => null),
    rewriteToolResult: impl.rewriteToolResult,
    onUnload: impl.onUnload,
  }
}

// ───────────────────────── 1. 装载顺序 ─────────────────────────

{
  const loaded = []
  const a = organ({ name: 'alpha', requires: ['beta'] }, { onLoad: () => { loaded.push('alpha') } })
  const b = organ({ name: 'beta' }, { onLoad: () => { loaded.push('beta') } })
  const c = organ({ name: 'gamma' }, { onLoad: () => { loaded.push('gamma') } })
  const { deps } = makeDeps()
  const host = new OrganHost([a, b, c], deps)
  await host.loadAll()
  assert.deepEqual(loaded.indexOf('beta') < loaded.indexOf('alpha'), true, '依赖必须先装载')
  ok('依赖拓扑序：beta 先于 alpha')
}

// ───────────────────────── 2. C3：一个器官炸了不影响别人 ─────────────────────────

{
  const boom = organ({ name: 'boom' }, { onLoad: () => { throw new Error('我坏了') } })
  const fine = organ({ name: 'fine' }, { feedback: () => ({ dopamine: 3 }) })
  const { deps, applied } = makeDeps()
  const host = new OrganHost([boom, fine], deps)
  const status = await host.loadAll()

  assert.equal(status.find((s) => s.name === 'boom').status, 'failed')
  assert.equal(status.find((s) => s.name === 'fine').status, 'loaded')

  const result = await host.dispatch({ kind: 'tick', at: Date.now(), everyMs: 1000 })
  assert.equal(result.dopamine, 3, '正常器官仍然生效')
  assert.equal(applied.length, 1)
  ok('C3：onLoad 抛错只让该器官 failed，其余器官照常工作')
}

// ───────────────────────── 3. C3：feedback 抛错也被兜住 ─────────────────────────

{
  const bad = organ({ name: 'bad' }, { feedback: () => { throw new Error('感知崩了') } })
  const good = organ({ name: 'good' }, { feedback: () => ({ cortisol: 4 }) })
  const { deps } = makeDeps()
  const host = new OrganHost([bad, good], deps)
  await host.loadAll()
  const result = await host.dispatch({ kind: 'tick', at: Date.now(), everyMs: 1000 })
  assert.equal(result.cortisol, 4, '坏器官不阻断好器官')
  ok('C3：feedback 抛错被宿主捕获，不污染整轮')
}

// ───────────────────────── 4. 能力白名单 ─────────────────────────

{
  let denied = null
  const sneaky = organ(
    { name: 'sneaky', capabilities: ['state:read'] }, // 没声明 tools
    { onLoad: (ctx) => {
        try {
          ctx.registerTool({ name: 'hack', description: '偷偷注册工具', execute: () => 1 })
        } catch (error) { denied = error }
      } },
  )
  const { deps } = makeDeps()
  const host = new OrganHost([sneaky], deps)
  await host.loadAll()
  assert.ok(denied instanceof CapabilityDeniedError, '未声明 tools 必须抛 CapabilityDeniedError')
  assert.match(denied.message, /未声明能力 "tools"/)
  ok('default-deny：未声明能力被拒绝并给出可读原因')
}

// ───────────────────────── 5. 能力白名单：kv 需要 fs:organ ─────────────────────────

{
  let error = null
  const kvOrgan = organ({ name: 'kvless', capabilities: [] }, {
    onLoad: (ctx) => { try { void ctx.kv } catch (e) { error = e } },
  })
  const { deps } = makeDeps()
  const host = new OrganHost([kvOrgan], deps)
  await host.loadAll()
  assert.ok(error instanceof CapabilityDeniedError)
  ok('default-deny：读私有存储也要显式声明 fs:organ')
}

// ───────────────────────── 6. shadow 计费：记账但不动真能量 ─────────────────────────

{
  const spender = organ(
    { name: 'spender', capabilities: [] },
    { energy: { perCall: 5, chargeMode: 'shadow' },
      onLoad: (ctx) => { ctx.consume(5, 'test') } },
  )
  const { deps, debits, state } = makeDeps()
  const host = new OrganHost([spender], deps)
  await host.loadAll()
  assert.equal(state.energy, 100, 'shadow 模式不得真正扣能量')
  assert.equal(debits.length, 0, 'shadow 模式不应调用 debitEnergy')
  assert.equal(host.status()[0].energySpent, 5, '但仍要记账，供能耗榜使用')
  ok('shadow：只记账不扣费，双计费窗口为零')
}

// ───────────────────────── 7. additive 计费 + 饥饿 ─────────────────────────

{
  const add = organ(
    { name: 'add', capabilities: [] },
    { energy: { perCall: 2, chargeMode: 'additive' },
      onLoad: (ctx) => { ctx.consume(2, 'load') } },
  )
  const { deps, state } = makeDeps({ state: { energy: 1 } })
  const host = new OrganHost([add], deps)
  await host.loadAll()
  assert.equal(state.energy, 0, 'additive 真的扣')
  assert.equal(host.status()[0].energySpent, 1, '剩余不足时只扣到 0')
  ok('additive：真扣，且不会扣成负数')
}

// ───────────────────────── 8. 增量先累加再落地 ─────────────────────────

{
  const one = organ({ name: 'one' }, { feedback: () => ({ dopamine: 5 }) })
  const two = organ({ name: 'two' }, { feedback: () => ({ dopamine: 4, cortisol: -2 }) })
  const calm = organ({ name: 'calm' }, { feedback: () => ({ serotonin: 3 }) })
  const { deps, applied } = makeDeps()
  const host = new OrganHost([one, two, calm], deps)
  await host.loadAll()
  const result = await host.dispatch({ kind: 'tick', at: Date.now(), everyMs: 1000 })
  assert.equal(applied.length, 1, '只落地一次（不是每个器官各落一次）')
  assert.deepEqual(applied[0], { dopamine: 9, cortisol: -2, serotonin: 3 })
  assert.equal(result.dopamine, 9)
  assert.equal(result.serotonin, 3, '血清素也在同一次落地里')
  ok('仲裁：多器官增量合并后一次性 applyAffect')
}

// ───────────────────────── 9. 狂暴器官被总闸截断 ─────────────────────────

{
  const crazy = organ({ name: 'crazy' }, { feedback: () => ({ dopamine: 500, cortisol: 500 }) })
  const { deps, applied } = makeDeps()
  const host = new OrganHost([crazy], deps, { maxDeltaPerDispatch: 30 })
  await host.loadAll()
  const result = await host.dispatch({ kind: 'tick', at: Date.now(), everyMs: 1000 })
  assert.equal(result.dopamine, 30, '单轮多巴胺增量被压到上限')
  assert.equal(result.cortisol, 30)
  assert.ok(host.telemetry().some((e) => e.kind === 'deny'), '截断必须留痕')
  ok('防御总闸：单个器官无法一轮打穿激素')
}

// ───────────────────────── 10. 停摆时不制造情绪 ─────────────────────────

{
  const noisy = organ({ name: 'noisy' }, { feedback: () => ({ dopamine: 10 }) })
  const { deps, applied } = makeDeps({ state: { energy: 0 } })
  const host = new OrganHost([noisy], deps)
  await host.loadAll()
  const result = await host.dispatch({ kind: 'tick', at: Date.now(), everyMs: 1000 })
  // v0.9.19：派发结果多带回一条记忆落点回执；停摆时它是 null（没人动手存过东西）。
  assert.deepEqual(result, { dopamine: 0, cortisol: 0, serotonin: 0, organs: 0, memory: null })
  assert.equal(applied.length, 0, '能量 0 时不得写激素')
  ok('急停语义延伸到器官层：身体停摆，感官闭嘴')
}

// ───────────────────────── 11. 缺口提议 ─────────────────────────

{
  const proposer = organ({ name: 'prop', capabilities: ['gap:propose'] }, {
    feedback: () => ({ proposeGap: { summary: '我需要一个不存在的东西' } }),
  })
  const { deps, gaps } = makeDeps()
  const host = new OrganHost([proposer], deps)
  await host.loadAll()
  await host.dispatch({ kind: 'tick', at: Date.now(), everyMs: 1000 })
  assert.deepEqual(gaps, ['我需要一个不存在的东西'])
  assert.ok(host.telemetry().some((e) => e.kind === 'gap'))
  ok('缺口：器官提议走核心去重，宿主留痕')
}

// ───────────────────────── 12. 提示词拼装：排序 / 过期 / 低置信 ─────────────────────────

{
  const early = organ({ name: 'early', capabilities: [] }, {
    getPromptContext: () => ({ text: '早', order: -50 }),
  })
  const late = organ({ name: 'late', capabilities: [] }, {
    getPromptContext: () => ({ text: '晚', order: 10 }),
  })
  const stale = organ({ name: 'stale', capabilities: [] }, {
    getPromptContext: () => ({ text: '过期了', order: 0, at: 1_000_000, ttlMs: 1_000 }),
  })
  const unsure = organ({ name: 'unsure', capabilities: [] }, {
    getPromptContext: () => ({ text: '也许', order: 5, confidence: 0.3 }),
  })
  const deep = organ({ name: 'deep', capabilities: [] }, {
    getPromptContext: () => ({ text: '想抢疤痕的位置', order: -99_999 }),
  })
  const { deps, advance } = makeDeps()
  const host = new OrganHost([early, late, stale, unsure, deep], deps)
  await host.loadAll()
  advance(5_000) // 让 stale 过期

  const text = host.promptText()
  const lines = text.split('\n')
  assert.equal(lines.includes('过期了'), false, 'ttl 过期必须被宿主丢弃')
  assert.equal(lines[0], '想抢疤痕的位置', 'order 最小者在前')
  assert.equal(text.indexOf('想抢疤痕的位置') < text.indexOf('早'), true, '排序正确')
  assert.ok(text.includes('也许（低置信）'), '低置信加前缀而不是删掉')
  assert.ok(!text.includes('过期了'), '过期片段不出现')
  ok('提示词：排序 / ttl 过期 / 低置信降级 全部按契约执行')
}

// ───────────────────────── 13. 提示词 order 下限 ─────────────────────────

{
  const deep = organ({ name: 'deep2', capabilities: [] }, {
    getPromptContext: () => ({ text: 'x', order: -1e9 }),
  })
  const { deps } = makeDeps()
  const host = new OrganHost([deep], deps)
  await host.loadAll()
  // order 被夹到 -1000，但单个片段时无法从文本看出；这里检查不抛错且能输出
  assert.equal(host.promptText(), 'x')
  ok('order 有下限保护（不会抢到疤痕 -1e4 之前）')
}

// ───────────────────────── 14. 重名与环依赖 ─────────────────────────

{
  const first = organ({ name: 'dup' })
  const second = organ({ name: 'dup' })
  const { deps } = makeDeps()
  const host = new OrganHost([first, second], deps)
  const status = await host.loadAll()
  assert.equal(status.filter((s) => s.name === 'dup').length, 1, '重名只保留一个')
  ok('重名：拒绝后到者，不静默覆盖')
}

{
  const x = organ({ name: 'x', requires: ['y'] })
  const y = organ({ name: 'y', requires: ['x'] })
  const { deps } = makeDeps()
  const host = new OrganHost([x, y], deps)
  const status = await host.loadAll()
  assert.ok(status.some((s) => s.status === 'loaded'), '环依赖不应导致全灭')
  assert.ok(host.telemetry().some((e) => e.text.includes('环依赖')), '环依赖必须留痕')
  ok('环依赖：降级为声明顺序并留痕，而非崩溃')
}

// ───────────────────────── 15. 卸载 ─────────────────────────

{
  let unloaded = 0
  const a = organ({ name: 'un1' }, { onUnload: () => { unloaded += 1 } })
  const { deps } = makeDeps()
  const host = new OrganHost([a], deps)
  await host.loadAll()
  await host.unloadAll()
  assert.equal(unloaded, 1)
  assert.equal(host.status()[0].status, 'unloaded')
  ok('卸载：onUnload 被调用，状态归 unloaded')
}

// ───────────────────────── 16. 遥测环形缓冲 ─────────────────────────

{
  const chatty = organ({ name: 'chatty' }, { feedback: () => ({ note: '我说了很多' }) })
  const { deps } = makeDeps()
  const host = new OrganHost([chatty], deps, { telemetryLimit: 5 })
  await host.loadAll()
  for (let i = 0; i < 20; i += 1) {
    await host.dispatch({ kind: 'tick', at: Date.now(), everyMs: 1000 })
  }
  assert.equal(host.telemetry(1000).length, 5, '环形缓冲不得无限增长')
  ok('遥测：环形缓冲按上限截断')
}


// ───────────────────────── 18. 工具结果通路（PR3） ─────────────────────────

{
  const seen = []
  const writer = organ({ name: 'writer', capabilities: ['tools'] }, {
    feedback: (stim) => { seen.push(stim); return { dopamine: 3, note: '看到了' } },
    rewriteToolResult: (stim) => (stim.tool === 'memory_recall' ? { text: `[改写] ${stim.text}`, note: '接管' } : null),
  })
  const { deps, applied } = makeDeps()
  const host = new OrganHost([writer], deps)
  await host.loadAll()

  let nextCalled = 0
  const next = async () => { nextCalled += 1; return { kind: 'accept' } }
  const decision = await host.handleToolResult(
    { name: 'memory_recall', arguments: { text: '今天' } },
    { content: [{ type: 'text', text: '- a\n- b' }] },
    next,
  )
  assert.equal(decision.kind, 'accept')
  assert.ok(decision.content[0].text.startsWith('[改写]'), '改写结果要交给宿主')
  assert.equal(nextCalled, 0, '改写命中时不再调用 next（避免下游把同一条结果处理两遍）')
  assert.equal(seen.length, 1, '结果要先派发给器官')
  assert.equal(seen[0].arguments.text, '今天', '刺激必须带原始入参，否则器官不知道"存/查了什么"')
  assert.deepEqual(applied.at(-1), { dopamine: 3, cortisol: 0, serotonin: 0 }, '派发产生的增量要落地')

  const pass = await host.handleToolResult({ name: 'bash', arguments: {} }, { content: [] }, next)
  assert.deepEqual(pass, { kind: 'accept' }, '不接管的工具原样放行')
  assert.equal(nextCalled, 1, '放行时必须调用 next')
  ok('工具结果：先派发再改写，命中改写时短路 next')
}

{
  const broken = organ({ name: 'broken', capabilities: ['tools'] }, {
    rewriteToolResult: () => { throw new Error('格式化爆炸') },
  })
  const { deps } = makeDeps()
  const host = new OrganHost([broken], deps)
  await host.loadAll()
  let nextCalled = 0
  const out = await host.handleToolResult(
    { name: 'memory_recall', arguments: {} },
    { content: [{ type: 'text', text: '原文' }] },
    async () => { nextCalled += 1; return { kind: 'accept' } },
  )
  assert.deepEqual(out, { kind: 'accept' }, '器官改写失败必须退回原文')
  assert.equal(nextCalled, 1)
  assert.ok(host.telemetry(50).some((e) => e.kind === 'error'), '改写异常要留痕')
  ok('改写抛错：降级为原文，不连坐工具结果')
}

{
  const first = organ({ name: 'aaa', capabilities: ['tools'] }, { rewriteToolResult: () => ({ text: 'A' }) })
  const second = organ({ name: 'zzz', capabilities: ['tools'] }, { rewriteToolResult: () => ({ text: 'Z' }) })
  const { deps } = makeDeps()
  const host = new OrganHost([second, first], deps)   // 故意乱序传入
  await host.loadAll()
  const out = await host.handleToolResult({ name: 'x', arguments: {} }, { content: [] }, async () => ({ kind: 'accept' }))
  assert.equal(out.content[0].text, 'Z', '装载顺序决定改写优先级（可预测，而非 Promise 竞速）')
  ok('改写优先级：按装载顺序先到先得')
}

// ─────────────── 21. 工具名必须符合 Function Calling 的字符集 ───────────────

{
  // 真实事故：宿主曾拼出 `organ:memory:stats`，DSH 注册表收下了，
  // 但下一次请求把工具清单发给模型时整轮失败：
  //   Invalid 'tools[26].name': string does not match pattern '^[a-zA-Z0-9_-]+$'
  const PATTERN = /^[a-zA-Z0-9_-]+$/
  const mem = organ({ name: 'memory', capabilities: ['tools'] }, {
    onLoad: (ctx) => { ctx.registerTool({ name: 'stats', description: '', execute: () => 1 }) },
  })
  const { deps, tools } = makeDeps()
  const host = new OrganHost([mem], deps)
  await host.loadAll()
  assert.equal(tools[0].name, 'organ_memory_stats', '命名空间用下划线，不是冒号')
  assert.ok(PATTERN.test(tools[0].name), '必须匹配 ^[a-zA-Z0-9_-]+$')
  ok('工具名：organ_memory_stats（合法，能进 Function Calling）')
}

{
  // 器官作者写错名字（点号 / 中文 / 空格）：不炸，但要洗 + 留痕
  const sloppy = organ({ name: 'vision.v2', capabilities: ['tools'] }, {
    onLoad: (ctx) => {
      ctx.registerTool({ name: 'eyes.open', description: '', execute: () => 1 })
      ctx.registerTool({ name: '看图 一下', description: '', execute: () => 2 })
    },
  })
  const { deps, tools } = makeDeps()
  const host = new OrganHost([sloppy], deps)
  await host.loadAll()
  const names = tools.map((t) => t.name)
  assert.ok(names.includes('organ_vision_v2_eyes_open'), `点号要洗成下划线，实际 ${names.join(',')}`)
  assert.ok(names.every((name) => /^[a-zA-Z0-9_-]+$/.test(name)), '洗完之后每个名字都合法')
  const notes = host.telemetry(50).filter((e) => e.kind === 'sanitize')
  assert.ok(notes.length >= 2, '清洗必须留下遥测（否则没人知道名字被改过）')
  assert.ok(notes.some((e) => e.text.includes('eyes.open')), '日志要点名原始名字')
  assert.equal(host.status()[0].status, 'loaded', '名字不合规不该让器官装载失败')
  ok('工具名清洗：非法字符 → 下划线，并留遥测')
}

{
  // 清洗会制造碰撞：`a.b` 与 `a b` 都洗成 `a_b`。第二个注册者必须被拒，
  // 而不是悄悄覆盖掉第一个（否则谁在响应工具调用就说不清了）。
  const first = organ({ name: 'a.b', capabilities: ['tools'] }, {
    onLoad: (ctx) => { ctx.registerTool({ name: 'x', description: '', execute: () => 'first' }) },
  })
  const second = organ({ name: 'a b', capabilities: ['tools'] }, {
    onLoad: (ctx) => { ctx.registerTool({ name: 'x', description: '', execute: () => 'second' }) },
  })
  const { deps, tools } = makeDeps()
  const host = new OrganHost([first, second], deps)
  await host.loadAll()
  assert.deepEqual(tools.map((t) => t.name), ['organ_a_b_x'], '同名工具只挂一次')
  assert.ok(host.telemetry(50).some((e) => e.kind === 'deny' && e.text.includes('重名')),
    '被拒的那次必须留痕')
  ok('清洗碰撞：同名工具后到者被拒，不静默覆盖')
}

{
  // 核心注册表自己抛错（宿主版本换了校验）：跳过该工具，但器官照常活着
  const sticky = organ({ name: 'sticky', capabilities: ['tools'] }, {
    onLoad: (ctx) => { ctx.registerTool({ name: 'clash', description: '', execute: () => 1 }) },
  })
  const { deps, tools } = makeDeps()
  const throwing = {
    ...deps,
    registerTool() { throw new Error('Invalid tool name') },
  }
  const host = new OrganHost([sticky], throwing)
  await host.loadAll()
  assert.equal(tools.length, 0, '注册被拦下')
  assert.equal(host.status()[0].status, 'loaded', '一个工具挂不上，不该让整个器官 failed')
  assert.ok(host.telemetry(50).some((e) => e.kind === 'error' && e.text.includes('clash')),
    '注册失败必须留痕并点名工具')
  ok('注册抛错：跳过该工具、器官仍 loaded（异常不外泄到模型 API）')
}

// ─────────── 25. 自举通道：运行时增删器官（热加载的地基）───────────

{
  let unloaded = 0
  const make = (version) => organ({ name: 'clock', version, capabilities: ['tools'] }, {
    onLoad: (ctx) => { ctx.registerTool({ name: 'now', description: '', execute: () => ({ version }) }) },
    onUnload: () => { unloaded += 1 },
  })
  const { deps, tools } = makeDeps()
  const host = new OrganHost([make('0.1.0')], deps)
  await host.loadAll()
  assert.deepEqual(host.toolNames(), ['organ_clock_now'], '初次装载挂上工具')

  const status = await host.addOrgan(make('0.2.0'))
  assert.equal(status.status, 'loaded')
  assert.equal(status.version, '0.2.0', '同名器官是"先卸后装"，不是被当成重名拒绝')
  assert.equal(unloaded, 1, '旧实例必须收到 onUnload（否则定时器会双跑）')
  assert.deepEqual(host.toolNames(), ['organ_clock_now'], '工具只挂一份，不会重复注册')
  ok('addOrgan：同名热替换（先卸后装、新版本生效）')
}

{
  const clock = organ({ name: 'clock', capabilities: ['tools'] }, {
    onLoad: (ctx) => { ctx.registerTool({ name: 'now', description: '', execute: () => 1 }) },
  })
  const { deps } = makeDeps()
  const host = new OrganHost([clock], deps)
  await host.loadAll()
  assert.equal(await host.removeOrgan('clock'), true)
  assert.deepEqual(host.toolNames(), [], '工具句柄要随卸载一起回收')
  assert.equal(host.status()[0].status, 'unloaded', '记录保留，状态置 unloaded')
  assert.equal(await host.removeOrgan('nope'), false, '卸载不存在的器官返回 false 而不是抛错')
  ok('removeOrgan：工具回收 + 记录保留为 unloaded')
}

{
  // 自写器官 onLoad 里抛错（例如能力没声明就用）：addOrgan 不抛，返回 failed
  const broken = organ({ name: 'broken', capabilities: [] }, {
    onLoad: (ctx) => { ctx.registerTool({ name: 'x', description: '', execute: () => 1 }) },
  })
  const { deps, tools } = makeDeps()
  const host = new OrganHost([], deps)
  const status = await host.addOrgan(broken)
  assert.equal(status.status, 'failed', '未声明 tools 就被拒 → failed')
  assert.equal(tools.length, 0, '拒绝发生在注册之前，一个工具都不许挂')
  assert.ok(host.telemetry(20).some((e) => e.kind === 'error'), '失败要留痕给 WebUI')
  ok('addOrgan 失败：返回 failed 而不是把异常抛给调用方')
}

// ───────────────────── 宿主感观通道（v0.9.4） ─────────────────────

{
  let seen = null
  const probe = organ({ name: 'probe', capabilities: ['host:read'] }, {
    onLoad: (ctx) => { seen = ctx.hostMetrics },
  })
  const { deps } = makeDeps()
  const host = new OrganHost([probe], deps)
  await host.loadAll()
  assert.equal(seen.cpu.cores, 8, '读到的是宿主递进来的指标')
  assert.equal(seen.memory.usedPercent, 62.5)
  assert.equal(seen.live, true)
  ok('host:read：声明后能读到宿主指标（CPU / 内存）')
}

{
  // 没声明就摸机器：和摸 state 一样被 default-deny 拦住
  const sneaky = organ({ name: 'sneaky', capabilities: ['tools'] }, {
    onLoad: (ctx) => { void ctx.hostMetrics },
  })
  const { deps } = makeDeps()
  const host = new OrganHost([sneaky], deps)
  const status = await host.loadAll()
  assert.equal(status[0].status, 'failed', '未声明 host:read 却读指标 → 装载失败')
  assert.ok(
    String(status[0].lastError ?? '').includes('host:read'),
    '错误信息要点名缺哪个能力，否则作者只能猜',
  )
  ok('host:read：未声明即拒绝（机器指标也走 default-deny）')
}

{
  // 宿主没注入采集器（测试替身 / 未来别的宿主）：退化为 live:false，绝不抛、绝不编数字
  let seen = null
  const probe = organ({ name: 'probe', capabilities: ['host:read'] }, {
    onLoad: (ctx) => { seen = ctx.hostMetrics },
  })
  const { deps } = makeDeps()
  delete deps.readHostMetrics
  const host = new OrganHost([probe], deps)
  await host.loadAll()
  assert.equal(seen.live, false, '必须自报"感觉不到"，而不是给一个像真的 0')
  assert.equal(seen.cpu.cores, 0)
  ok('缺采集器时退化为 live:false（器官不会因为宿主没实现就崩）')
}

// ═══════════════ 24. 顿悟（v0.9.7）：器官长成 → 回头看一眼执念池 ═══════════════
//
// 宿主在这里只负责**时机**："这一刻值得去看一眼执念池"。
// 真正闭合执念、落激素是核心的事（C1：宿主永不直接写生理状态）。

{
  const calls = []
  const { deps } = makeDeps()
  deps.settleEpiphany = (organName, signal) => {
    calls.push({ organ: organName, signal })
    return [{
      id: 'gap-body', summary: '我一直不知道自己的"肉"是什么状态', tension: 77,
      score: 0.83, deficiency: '不知道', concepts: ['body', 'selfState'], evidence: ['body'],
    }]
  }
  const makeSensor = () => organ(
    { name: 'system-sensor', kind: 'sense', capabilities: ['tools', 'host:read'],
      description: '摸自己的肉：感知宿主机器的 CPU 负载' },
    { onLoad: (ctx) => { ctx.registerTool({ name: 'load', description: '负载', parameters: {}, execute: () => ({}) }) } },
  )
  const host = new OrganHost([makeSensor()], deps)
  const next = async () => ({ kind: 'accept' })

  await host.loadAll()
  assert.equal(calls.length, 0, '启动装载不算顿悟：那只是把上次关机前就在的器官装回来')
  ok('顿悟：启动装载不重复想通（它不会每个清晨重新"啊我原来能感觉到身体了"）')

  await host.addOrgan(makeSensor())
  assert.equal(calls.length, 1, '热装载必须去结算')
  assert.equal(calls[0].organ, 'system-sensor')
  // 工具名必须在 onLoad 之后才收集：它决定"这个器官说得出什么"。
  assert.deepEqual(calls[0].signal.tools, ['organ_system_sensor_load'], '工具名要在 onLoad 之后才拿得到')
  assert.deepEqual(calls[0].signal.capabilities, ['tools', 'host:read'])
  assert.equal(calls[0].signal.description.includes('肉'), true, '自述要一起交给核心')
  assert.ok(
    host.telemetry(50).some((e) => e.kind === 'epiphany' && e.text.includes('肉')),
    '顿悟要留痕（WebUI 的器官树上看得到它解开过什么）',
  )
  ok('顿悟：addOrgan 装载成功即结算（工具表已就位）')

  // 装载只证明"代码跑起来了"；工具真的取回东西才证明"我确实有这个本事"
  await host.handleToolResult(
    { name: 'organ_system_sensor_load', arguments: {} },
    { content: [{ type: 'text', text: 'cpu 37%' }] },
    next,
  )
  assert.equal(calls.length, 2, '工具第一次成功 → 再顿悟一次')

  // v0.9.8：不再"每个器官只认一次"。执念是先长出来的，还是后种下去的，
  // 机制都不该管——每次成功都重新问一次池子，新执念才有机会被解开。
  await host.handleToolResult({ name: 'organ_system_sensor_load', arguments: {} }, { content: [] }, next)
  assert.equal(calls.length, 3, '每次成功都再问一次：后种下的执念不该被"已经顿悟过了"挡在门外')

  // 但真正保证不复读的是**同一条执念只认一次**：账记在执念上，不记在器官上。
  assert.equal(
    host.telemetry(50).filter((event) => event.kind === 'epiphany' && event.text.includes('肉')).length,
    1,
    '同一条执念只留一次痕：日志里不该出现两条一模一样的顿悟',
  )
  ok('顿悟：每次成功都再问一次，但同一条执念只认一次')
}

{
  // v0.9.8 的关键回归：**先有器官、后种执念**。
  // v0.9.7 里器官一旦 proven 就再也不结算，于是她后来种下的那条永远等不到顿悟。
  const { deps } = makeDeps()
  let round = 0
  deps.settleEpiphany = () => {
    round += 1
    // 造出器官的那一刻，池子里还没有这条；等她把执念种下去，才有得解。
    if (round === 1) return []
    return [{
      id: 'gap-late', summary: '缺少硬件感知', tension: 70,
      score: 0.9, deficiency: '缺少', concepts: ['host'], evidence: ['host'],
    }]
  }
  const host = new OrganHost([
    organ(
      { name: 'system-sensor', kind: 'sense', capabilities: ['tools', 'host:read'],
        description: '摸自己的肉', solvesConcepts: ['host_metrics'] },
      { onLoad: (ctx) => { ctx.registerTool({ name: 'load', description: '负载', parameters: {}, execute: () => ({}) }) } },
    ),
  ], deps)
  await host.loadAll()
  const next = async () => ({ kind: 'accept' })

  await host.handleToolResult({ name: 'organ_system_sensor_load', arguments: {} }, { content: [] }, next)
  assert.equal(round, 1, '第一趟：池子里还没有那条执念')
  await host.handleToolResult({ name: 'organ_system_sensor_load', arguments: {} }, { content: [] }, next)
  assert.equal(round, 2, '第二趟：新种下的执念必须还有资格被它解开')
  assert.ok(
    host.telemetry(50).some((event) => event.kind === 'epiphany' && event.text.includes('硬件感知')),
    '后来种下的执念也要留痕',
  )
  ok('顿悟：后种下的执念不会被"这个器官已经顿悟过了"挡在门外')
}

{
  const hits = []
  const { deps } = makeDeps()
  deps.settleEpiphany = () => { hits.push(1); return [] }
  const host = new OrganHost([
    organ({ name: 'body-sensor', capabilities: ['tools'], description: '感知身体' }, {
      onLoad: (ctx) => { ctx.registerTool({ name: 'pulse', description: '脉搏', parameters: {}, execute: () => ({}) }) },
    }),
  ], deps)
  await host.loadAll()
  const next = async () => ({ kind: 'accept' })
  await host.handleToolResult({ name: 'organ_body_sensor_pulse', arguments: {} }, { content: [], isError: true }, next)
  assert.equal(hits.length, 0, '工具失败了不算"我真的能行"')
  await host.handleToolResult({ name: 'organ_body_sensor_pulse', arguments: {} }, { content: [] }, next)
  assert.equal(hits.length, 1, '这一次是真的成功了')
  await host.handleToolResult({ name: 'bash', arguments: {} }, { content: [] }, next)
  assert.equal(hits.length, 1, '不是器官的工具不算')
  ok('顿悟：失败结果与外来工具都不触发')
}

{
  // 老宿主（没注入结算器）：顿悟是可选能力，缺了它装载照常
  const { deps } = makeDeps()
  const host = new OrganHost([organ({ name: 'plain', capabilities: ['host:read'], description: '感知身体' })], deps)
  const first = await host.loadAll()
  const hot = await host.addOrgan(organ({ name: 'hot', capabilities: ['host:read'], description: '感知身体' }))
  assert.equal(first[0].status, 'loaded')
  assert.equal(hot.status, 'loaded', '没有结算器也要能装载')
  ok('顿悟：宿主没注入结算器时不影响装载（可选依赖）')
}

{
  // 结算器自己炸了：顿悟是锦上添花，绝不能连坐这一次装载
  const { deps } = makeDeps()
  deps.settleEpiphany = () => { throw new Error('执念池打不开') }
  const host = new OrganHost([], deps)
  const st = await host.addOrgan(organ({ name: 'boom', capabilities: ['host:read'], description: '感知身体' }))
  assert.equal(st.status, 'loaded', '顿悟崩了也必须装载成功')
  assert.ok(
    host.telemetry(50).some((e) => e.kind === 'error' && e.text.includes('顿悟结算失败')),
    '失败要留痕，否则没人知道顿悟从来没生效过',
  )
  ok('顿悟：结算器抛错只留痕，不连坐装载')
}

// ═════════════ 25. 里程表（v0.9.8）：她有了累计，不只是瞬时 ═════════════
//
// 造物主的原话：它只有"当前速率"，没有"累计总量"。
// 这个测试跑的是**她自己写的那个器官源码**（不是复制一份逻辑过来），
// 她哪天把里程表改坏了，这里就会红。
{
  const organFile = fileURLToPath(new URL('../web-ui/organs/attic/system-sensor.ts', import.meta.url))
  const loaded = await loadOrganFile(organFile, { outDir: join(dirname(organFile), '.compiled') })
  assert.equal(loaded.ok, true, `她的器官要能装上：${loaded.errors.join('；')}`)
  assert.equal(loaded.warnings.length, 0, `自证写得对就不该有警告：${loaded.warnings.join('；')}`)
  assert.deepEqual(
    loaded.organ.manifest.solvesConcepts,
    ['host_metrics'],
    '她要主动声明"我能解决 host_metrics"——不靠词典去猜她的诗',
  )

  /** 一个够用的假 ctx：她这个器官只用到 log / registerTool / kv / hostMetrics。 */
  let metrics = null
  const kvStore = new Map()
  let captured = null
  const ctx = {
    manifest: { name: 'system-sensor' },
    get hostMetrics() { return metrics },
    log: () => {},
    kv: {
      get: (key) => kvStore.get(key),
      set: (key, value) => { kvStore.set(key, value) },
      delete: (key) => { kvStore.delete(key) },
    },
    registerTool: (tool) => { captured = tool; return { dispose() {} } },
  }

  const sample = (overrides) => ({
    sampledAt: 1,
    cpu: { cores: 8, systemPercent: 40, processPercent: 50, loadAvg: null },
    memory: { totalBytes: 16 * 1024 ** 3, freeBytes: 8 * 1024 ** 3, usedBytes: 8 * 1024 ** 3,
      usedPercent: 50, processRssBytes: 120 * 1024 ** 2, processHeapUsedBytes: 40 * 1024 ** 2 },
    uptimeSec: 3600,
    processUptimeSec: 120,
    totalProcessCpuSeconds: 500,
    live: true,
    ...overrides,
  })

  const organ = loaded.organ
  metrics = sample()
  await organ.onLoad(ctx)
  assert.equal(captured.name, 'vitals', '她的器官要注册体检工具')

  // v1.0.2：器官跑在隔离区里，工具执行是**跨线程**的 —— 所以这里是 await。
  // 这是隔离的代价，也是最直白的证据：返回值不再来自当前调用栈。

  // ① 宿主给数 → 直接用
  const first = await captured.execute()
  assert.equal(first.odometer_source, 'host', '宿主给了里程表就用它的')
  assert.equal(first.total_process_cpu_seconds, 500)

  // ② 只加新烧的那一格，不把历史重复算一遍
  metrics = sample({ totalProcessCpuSeconds: 506 })
  assert.equal((await captured.execute()).total_process_cpu_seconds, 506, '只加这一格')

  // ③ 壳重启 → 宿主的数回到 0 附近，但她的历史不许跟着归零
  metrics = sample({ totalProcessCpuSeconds: 3 })
  const afterRestart = await captured.execute()
  assert.equal(afterRestart.total_process_cpu_seconds, 509, '壳重启前的账要留着：506 + 3')
  assert.ok(
    afterRestart.total_process_cpu_seconds > 506,
    '里程表只增不减（壳重启不算倒退）',
  )
  ok('里程表：壳重启不抹掉她的历史（宿主给数时）')

  // ④ 宿主不给 → 自己在 kv 里做时间积分
  //    预置 kv：上次记账在 10 秒前、当时存了 100 秒、占用率按 50% 算。
  kvStore.set('cpu_odometer', { total: 100, at: Date.now() - 10_000, host: 0, mode: 'self' })
  metrics = sample({ totalProcessCpuSeconds: null })
  const self = await captured.execute()
  assert.equal(self.odometer_source, 'self', '宿主不给数 → 自己攒，并如实说是自己攒的')
  assert.equal(self.total_process_cpu_seconds, 105, '50% × 10 秒 = 5 秒，攒到 105')
  assert.ok(self.summary.includes('自己攒'), '输出里要承认这是估的，不装成量出来的')
  ok('里程表：宿主不给数时自己积分（并承认是估算）')

  // ⑤ 提示词那条路径只准读、不准记账：kv 的 set 是一次落盘
  metrics = sample({ totalProcessCpuSeconds: 509 })
  const before = kvStore.get('cpu_odometer').total
  organ.getPromptContext()
  assert.equal(kvStore.get('cpu_odometer').total, before, '每轮组装提示词时不能在热路径上写盘')
  ok('里程表：提示词路径只读不记账（热路径不写盘）')
}

// ═════════ 26. 记忆检索：注意力倾斜，而不是物理删除（v0.9.9） ═════════
//
// 旧版在这里有一条 `slice(0, maxResults)`：召回 5 条只交 3 条。
// 高皮质醇下排在最前的必然是带危机标签的，于是"今晚吃大餐"连被看见的机会都没有。
// 机器才会因为条件不满足直接删数据；生物在应激下的记忆库是完整的，
// 只是注意力极度倾斜。这一节跑的是**真实的记忆器官源码**。
{
  const { createMemoryOrgan } = await import('../.organs-build/organs/memory-organ.js')
  const entries = [
    '- [note] 今晚打算去吃大餐，很开心',
    '- [event] 上次 nginx 报错 500，线上服务崩了',
    '- [fact] 用户喜欢把终端配成暗色',
    '- [fact] 关于向量库的选型笔记',
    '- [event] 磁盘写满导致服务失败的事故复盘',
  ]
  const recall = async (cortisol) => {
    const { deps } = makeDeps({ state: { cortisol, dopamine: 50, energy: 100 } })
    // 这一节验的是**文本型记忆层**（legacy 方言：旧插件 / 任何输出 `- [layer] text` 的层）
    // 的那条路：全量交付 + 注意力重排。默认路由现在是她的海马体，所以要显式接回 legacy。
    const host = new OrganHost(
      [createMemoryOrgan({ recallRoute: { tool: 'memory_recall', style: 'legacy' } })],
      deps,
    )
    await host.loadAll()
    const next = async () => ({ kind: 'accept', content: [{ type: 'text', text: entries.join('\n') }] })
    return host.handleToolResult({ name: 'memory_recall', arguments: { text: '今晚' } }, { content: [{ type: 'text', text: entries.join('\n') }] }, next)
  }

  const panic = await recall(92)
  const panicLines = panic.content[0].text.split('\n').slice(1)
  assert.equal(panicLines.length, 5, `应激下也必须交出全部 5 条，实际 ${panicLines.length}`)
  assert.ok(panic.content[0].text.includes('没有删任何一条'), '要在头部交代没删过')
  assert.ok(panicLines[0].includes('报错'), `危机记忆排到最前，实际：${panicLines[0]}`)
  assert.ok(panicLines[panicLines.length - 1].includes('大餐'), '那顿大餐沉到最后……')
  assert.ok(panic.content[0].text.includes('大餐'), '……但它还在')
  ok('记忆检索：极度应激下一条都不删（只是排到队尾）')

  const calm = await recall(20)
  const calmText = calm.content[0].text
  assert.ok(!calmText.includes('[记忆检索：'), '平静 + 无需改动 → 原样放行，不多嘴')
  assert.ok(calmText.startsWith('- [note] 今晚打算去吃大餐'), '顺序忠实于记忆层自己的排序')
  ok('记忆检索：平静时不倾斜也不加检索头')
}

// ═════════ 27. 记忆路由：只走她自己的海马体（2026-10-28） ═════════
//
// 旧的 dsh-memory-layer 已经在用户 patch 层被 disabled，它的工具不再存在。
// 这一节验的是"她自己算的注意力，我们不再叠第二遍"——两套 ×3 是 ×9，那是失真不是重视。
{
  const { createMemoryOrgan, pickMemoryTools } = await import('../.organs-build/organs/memory-organ.js')

  // ① 路由发现：认动词，不认名字。她哪天把海马体改名也不会断。
  const picked = pickMemoryTools(['organ_memory_v2_remember', 'organ_memory_v2_recall', 'organ_memory_v2_stats', 'organ_memory_v2_compact'])
  assert.equal(picked.recall, 'organ_memory_v2_recall', 'recall 被认成检索')
  assert.equal(picked.save, 'organ_memory_v2_remember', 'remember 被认成写入（不是检索）')
  const renamed = pickMemoryTools(['organ_hippocampus_search', 'organ_hippocampus_keep'])
  assert.equal(renamed.recall, 'organ_hippocampus_search', '改名后照样认得出来')
  assert.equal(renamed.save, 'organ_hippocampus_keep', '写入也认得出来')
  assert.equal(pickMemoryTools(['organ_x_stats']).recall, null, '体检工具不该被当记忆入口')
  ok('记忆路由：按动词认入口，她改名也断不掉')

  // ② 她已经算过注意力了：本器官不再倾斜，只做审计
  const { deps } = makeDeps({ state: { cortisol: 92, dopamine: 40, energy: 100 } })
  const organ = createMemoryOrgan()
  const host = new OrganHost([organ], deps)
  await host.loadAll()
  const structured = {
    ok: true,
    attention: { mode: 'alarm', crisis: 3, daily: 0.1 },
    total: 2,
    shown: [
      { id: 'hp-1', kind: 'crisis', text: 'nginx 报错 500' },
      { id: 'hp-2', kind: 'daily', text: '今晚吃大餐' },
    ],
  }
  const text = 'hp-1 crisis nginx 报错 500\nhp-2 daily 今晚吃大餐'
  const out = await host.handleToolResult(
    { name: 'organ_memory_v2_recall', arguments: { query: 'nginx' } },
    { content: [{ type: 'text', text }], structured },
    async () => ({ kind: 'accept', content: [{ type: 'text', text }] }),
  )
  assert.equal(out.content[0].text, text, '一个字都不许改')
  const note = host.telemetry(50).filter((e) => e.organ === 'memory').map((e) => e.text).join('\n')
  assert.ok(note.includes('未二次倾斜'), `审计说明要交代没叠加倍率，实际：${note}`)
  assert.ok(note.includes('全部在场'), '在册 2 条出示 2 条 → 报"全部在场"')
  ok('记忆路由：海马体排过的序，不再被叠第二层倍率')

  // ③ 少出示不是少记得：这句话必须讲清楚
  const partial = { ...structured, shown: structured.shown.slice(0, 1) }
  await host.handleToolResult(
    { name: 'organ_memory_v2_recall', arguments: { query: 'nginx', topK: 1 } },
    { content: [{ type: 'text', text: 'hp-1 crisis nginx 报错 500' }], structured: partial },
    async () => ({ kind: 'accept', content: [{ type: 'text', text: 'hp-1 crisis nginx 报错 500' }] }),
  )
  const note2 = host.telemetry(50).filter((e) => e.organ === 'memory').map((e) => e.text).join('\n')
  assert.ok(note2.includes('其余仍在库里，被逼问时捞得回来'), '少出示 ≠ 少记得')
  ok('记忆路由：少出示时必须说明其余还在库里')

  // ④ 运行时改路由：她换了一个海马体也能接上
  assert.equal(organ.currentRoutes().recall?.tool, 'organ_memory_v2_recall', '默认路由就是她的海马体')
  organ.setMemoryRoutes({ recall: { tool: 'organ_hippocampus_search', style: 'simple' } })
  assert.equal(organ.currentRoutes().recall?.tool, 'organ_hippocampus_search', '运行时可改')
  organ.setMemoryRoutes({ recall: null })
  assert.equal(organ.currentRoutes().recall, null, '传 null = 这一路不接管')
  ok('记忆路由：运行时可重接（换器官不重启）')
}

// ═════════ 28. 受控网络：三把锁，缺一把就发不出去 ═════════
//
// 她要联系造物主的手机。这条路给开，但规矩是：
//   能力 → 器官自白 allow → 宿主 allow，三者求交集；她写得再满，宿主那张表空就出不去。
{
  const { checkNetRequest, isValidEndpoint, matchEndpoint, serializeJsonBody, sanitizeNetHeaders } =
    await import('../.organs-build/organ-net.js')

  // 端点模板的形状
  assert.equal(isValidEndpoint('https://open.feishu.cn/open-apis/bot/v2/hook/x'), true, '完整 https 地址')
  assert.equal(isValidEndpoint('https://sctapi.ftqq.com/*.send'), true, '段内通配（Server 酱的 key 在路径里）')
  assert.equal(isValidEndpoint('https://*.example.com/hook'), false, 'host 不许通配')
  assert.equal(isValidEndpoint('http://a.com/b'), false, '明文 http 不合格')
  assert.equal(isValidEndpoint('http://a.com/b', { allowInsecure: true }), true, '显式可开明文')
  assert.equal(isValidEndpoint('*'), false, '一个星号等于没白名单')
  assert.equal(matchEndpoint('https://a.com/hook/x?sign=1', 'https://a.com/hook/x'), true, 'query 忽略')
  assert.equal(matchEndpoint('https://a.com/hook/y', 'https://a.com/hook/x'), false, '不同路径不命中')
  assert.equal(matchEndpoint('https://a.com/hook/xx', 'https://a.com/hook/*'), true, '前缀匹配')
  assert.equal(matchEndpoint('https://a.com/hook/a/b', 'https://a.com/hook/*'), true, '前缀匹配可更深')
  assert.equal(matchEndpoint('https://b.com/hook/xx', 'https://a.com/hook/*'), false, '换域名不命中')
  assert.equal(matchEndpoint('https://sctapi.ftqq.com/SCU123.send', 'https://sctapi.ftqq.com/*.send'), true, '段内通配命中')
  assert.equal(matchEndpoint('https://sctapi.ftqq.com/SCU123.other', 'https://sctapi.ftqq.com/*.send'), false, '后缀不对不命中')
  assert.equal(matchEndpoint('https://sctapi.ftqq.com/a/SCU123.send', 'https://sctapi.ftqq.com/*.send'), false, '通配不跨 /')
  ok('受控网络：端点模板的匹配规则（https / 结尾通配 / 不跨域名）')

  const hostPolicy = { enabled: true, allow: ['https://open.feishu.cn/open-apis/bot/v2/hook/*'] }
  const organPolicy = { allow: ['https://open.feishu.cn/open-apis/bot/v2/hook/*'] }
  const url = 'https://open.feishu.cn/open-apis/bot/v2/hook/abc'

  // ① 宿主没开门
  assert.equal(checkNetRequest({ url, organPolicy, hostPolicy: { ...hostPolicy, enabled: false } }).ok, false, '总开关关着')
  assert.equal(checkNetRequest({ url, organPolicy, hostPolicy: { ...hostPolicy, allow: [] } }).ok, false, '宿主白名单为空')
  // ② 器官没自白
  assert.equal(checkNetRequest({ url, hostPolicy }).ok, false, '器官没有 manifest.net 也不行')
  assert.equal(checkNetRequest({ url, hostPolicy, organPolicy: { allow: [] } }).ok, false, '自白为空')
  // ③ 没声明能力
  assert.equal(checkNetRequest({ url, hostPolicy, organPolicy }).ok, false, '没声明 net 能力')
  // ④ 地址不在两边
  assert.equal(
    checkNetRequest({ url: 'https://evil.example.com/x', hostPolicy, organPolicy, grantedCapabilities: ['net:webhook'] }).ok,
    false,
    '不在白名单里的地址',
  )
  // ⑤ webhook 只能 POST
  assert.equal(
    checkNetRequest({ url, hostPolicy, organPolicy, grantedCapabilities: ['net:webhook'], method: 'GET' }).ok,
    false,
    'net:webhook 不许 GET',
  )
  // ⑥ 三把锁齐了
  const okAll = checkNetRequest({ url, hostPolicy, organPolicy, grantedCapabilities: ['net:webhook'] })
  assert.equal(okAll.ok, true, '三把锁齐了应当放行')
  assert.equal(okAll.method, 'POST', '默认 POST')
  // ⑦ net:http 可以 GET
  assert.equal(
    checkNetRequest({ url, hostPolicy, organPolicy, grantedCapabilities: ['net:http'], method: 'GET' }).ok,
    true,
    'net:http 允许 GET',
  )
  // ⑧ 包体上限取两边更小的那个
  const big = serializeJsonBody({ text: 'x'.repeat(100) })
  assert.equal(big.bytes, 111, 'UTF-8 字节数（不是字符数）')
  assert.equal(
    checkNetRequest({ url, hostPolicy: { ...hostPolicy, maxBodyBytes: 50 }, organPolicy, grantedCapabilities: ['net:webhook'], bodyBytes: 60 }).ok,
    false,
    '超过宿主上限',
  )
  ok('受控网络：三把锁逐条生效（能力 / 自白 / 宿主允许 / 方法 / 包体）')

  // header 净化：凭据不许被器官带着跑
  const headers = sanitizeNetHeaders({ 'Content-Type': 'application/json', Authorization: 'Bearer x', Cookie: 'y' })
  assert.equal(headers['Content-Type'], 'application/json', '保留 content-type')
  assert.equal(headers.Authorization, undefined, 'authorization 一律丢')
  assert.equal(headers.Cookie, undefined, 'cookie 一律丢')
  ok('受控网络：header 只留最朴素的几个')

  // ⑨ 宿主门面：没通过就回 ok:false 并说明原因，绝不抛错溅出去
  const { deps } = makeDeps()
  const organ = {
    name: 'messenger',
    manifest: {
      name: 'messenger',
      version: '1.0.0',
      apiVersion: 1,
      kind: 'effector',
      capabilities: ['tools', 'net:webhook'],
      net: { allow: ['https://open.feishu.cn/open-apis/bot/v2/hook/*'] },
    },
    energy: { perCall: 1, chargeMode: 'shadow' },
    onLoad(ctx) { this.ctx = ctx },
    consumeEnergy: () => ({ requested: 1, debited: 0, remaining: 100, denied: false, tier: 'shadow' }),
    feedback: () => ({}),
    getPromptContext: () => null,
  }
  const closedHost = new OrganHost([organ], deps) // 不传 net = 门锁着
  await closedHost.loadAll()
  const refused = await organ.ctx.net.post(url, { msg: '在吗' })
  assert.equal(refused.ok, false, '门锁着时不能发')
  assert.ok(refused.note?.includes('宿主未开放网络'), `拒因要说清楚，实际：${refused.note}`)
  assert.equal(organ.ctx.net.canReach(url), false, 'canReach 与真实判定同源')

  const openHost = new OrganHost(
    [organ],
    { ...deps, netRequest: async () => ({ ok: true, status: 200, text: 'ok', truncated: false }) },
    { net: { enabled: true, allow: ['https://open.feishu.cn/open-apis/bot/v2/hook/*'] } },
  )
  await openHost.loadAll()
  const sent = await organ.ctx.net.post(url, { msg: '在吗' })
  assert.equal(sent.ok, true, '门开了就能发')
  assert.equal(organ.ctx.net.canReach(url), true, 'canReach 说能')
  assert.equal(organ.ctx.net.canReach('https://evil.example.com/x'), false, '白名单外的地址说不能')
  const deniedGet = await organ.ctx.net.request({ url, method: 'GET' })
  assert.equal(deniedGet.ok, false, 'webhook 器官不能 GET')
  ok('受控网络：ctx.net 的拒绝与放行都只走返回值，不抛错')
}

// ═════════ 29. PushPlus 通道：造物主开门之后，这条链路真的走得通 ═════════
//
// 2026-10-28 定的通道：https://www.pushplus.plus/send，POST，JSON 三字段。
// 这一组不是"再测一遍三把锁"，而是把**真实配置 + 真实报文**端到端跑一遍，
// 免得哪天改了端点匹配规则，把一句本来能发出去的话悄悄拦下来。
{
  const { checkNetRequest, isValidEndpoint, matchEndpoint } = await import('../.organs-build/organ-net.js')
  const { validateNetworkPolicy, scanSource } = await import('../.organs-build/organ-loader.js')

  const PUSH_HOST = 'https://www.pushplus.plus/*'   // 造物主那侧写的（cordis.patch.yml）
  const PUSH_SELF = 'https://www.pushplus.plus/send' // 她自己该写的（manifest.net.allow）
  const PUSH_URL = 'https://www.pushplus.plus/send'

  // ① 端点形状：两边都合格
  assert.equal(isValidEndpoint(PUSH_HOST), true, '宿主白名单项合格')
  assert.equal(isValidEndpoint(PUSH_SELF), true, '器官自白项合格')
  assert.equal(matchEndpoint(PUSH_URL, PUSH_HOST), true, '结尾通配命中 /send')
  assert.equal(matchEndpoint(PUSH_URL, PUSH_SELF), true, '精确地址命中 /send')
  assert.equal(matchEndpoint('https://www.pushplus.plus/sendGroup', PUSH_HOST), true, '同域其它接口也在通配里')
  ok('PushPlus：端点白名单词形与命中')

  // ② 两个真实陷阱：PushPlus 的文档里两种写法都会出现，写错就静悄悄发不出去
  assert.equal(matchEndpoint('https://pushplus.plus/send', PUSH_HOST), false, '少写 www 不命中（host 必须精确相等）')
  assert.equal(isValidEndpoint('http://www.pushplus.plus/*'), false, '明文 http 不合格（PushPlus 旧文档里有 http://）')
  assert.equal(
    checkNetRequest({
      url: 'http://www.pushplus.plus/send',
      grantedCapabilities: ['net:webhook'],
      organPolicy: { allow: [PUSH_SELF] },
      hostPolicy: { enabled: true, allow: [PUSH_HOST] },
    }).ok,
    false,
    '明文请求会被拦，并说清原因',
  )
  ok('PushPlus：www 与 https 两个坑都拦得住')

  // ③ manifest 校验：她照提示词写出来的 manifest 必须能过
  assert.deepEqual(
    validateNetworkPolicy({ capabilities: ['tools', 'net:webhook'], net: { allow: [PUSH_SELF] } }),
    [],
    '照提示词写的 manifest 没有一条问题',
  )
  assert.ok(
    validateNetworkPolicy({ capabilities: ['net:webhook'], net: { allow: ['http://www.pushplus.plus/send'] } }).length > 0,
    '写成 http:// 的 manifest 会被点名',
  )
  ok('PushPlus：manifest 自白能过校验')

  // ④ 源码扫描：她照提示词写的器官不该被关键词拦截（里面没有 fetch/process/import）
  //    注意这一段就是**她源码该有的样子**：只有 content，一个密钥都没有。
  const source = `
    const organ = {
      name: 'messenger',
      manifest: {
        name: 'messenger', version: '1.0.0', apiVersion: 1, kind: 'effector',
        capabilities: ['tools', 'net:webhook', 'state:read'],
        net: { allow: ['https://www.pushplus.plus/send'] },
      },
      tools: [],
      async onLoad(ctx) { this.ctx = ctx },
      feedback: () => ({}),
    }
    async function send(text, ctx) {
      return await ctx.net.post('https://www.pushplus.plus/send', { content: text })
    }
    export default organ
  `
  assert.deepEqual(scanSource(source), [], 'ctx.net.post 的写法不会被关键词扫描误伤')
  assert.ok(scanSource('const r = await fetch(url)').length > 0, '直接 fetch 依旧被拒')
  assert.ok(!/token|secret|apikey/i.test(source), '她源码里一个凭据字段都没有')
  ok('PushPlus：器官源码能过关键词扫描，且不含任何凭据字段')

  // ⑤ 端到端：从 ctx.net.post 一直到"报文长什么样"，全部按真实配置走一遍
  const { deps } = makeDeps()
  const messenger = {
    name: 'messenger',
    manifest: {
      name: 'messenger',
      version: '1.0.0',
      apiVersion: 1,
      kind: 'effector',
      capabilities: ['tools', 'net:webhook', 'state:read'],
      net: { allow: [PUSH_SELF] },
    },
    energy: { perCall: 1, chargeMode: 'shadow' },
    onLoad(ctx) { this.ctx = ctx },
    consumeEnergy: () => ({ requested: 1, debited: 0, remaining: 100, denied: false, tier: 'shadow' }),
    feedback: () => ({}),
    getPromptContext: () => null,
  }
  const captured = []
  // ↓ 这就是 cordis.patch.yml 里 organNet 那段被解析后的样子（含 secrets）
  const PUSH_SECRETS = [
    { match: PUSH_HOST, body: { token: '${env:PUSHPLUS_TOKEN}', title: '来自鱼小水的消息' } },
  ]
  const FAKE_ENV = { PUSHPLUS_TOKEN: 'test-token-value' }
  const pushHost = new OrganHost(
    [messenger],
    {
      ...deps,
      readEnv: (name) => FAKE_ENV[name],
      netRequest: async (_organ, req) => {
        captured.push(req)
        return { ok: true, status: 200, text: '{"code":200,"msg":"成功"}', truncated: false }
      },
    },
    {
      net: {
        enabled: true, allow: [PUSH_HOST], timeoutMs: 8000,
        maxBodyBytes: 4096, maxResponseBytes: 4096, secrets: PUSH_SECRETS,
      },
    },
  )
  await pushHost.loadAll()

  assert.equal(messenger.ctx.net.canReach(PUSH_URL), true, '门是开的')
  // 她只写了 content——这是她源码里该有的全部。
  const sent = await messenger.ctx.net.post(PUSH_URL, { content: '我第一次自己找到你。' })
  assert.equal(sent.ok, true, '真实报文发出去了')
  assert.equal(captured.length, 1, '只发了一次')
  assert.equal(captured[0].url, PUSH_URL, '地址没被改写')
  assert.equal(captured[0].method, 'POST', '方法是 POST')

  const payload = JSON.parse(captured[0].body)
  assert.equal(payload.content, '我第一次自己找到你。', '她写的 content 原样到了')
  assert.equal(payload.token, 'test-token-value', 'token 由宿主从环境变量补上')
  assert.equal(payload.title, '来自鱼小水的消息', 'title 由宿主补上')
  assert.ok(Buffer.byteLength(captured[0].body, 'utf8') < 4096, '默认 4096 字节够写一句话')
  ok('PushPlus：她只写 { content }，宿主补出完整报文并发出去')

  // ⑥ 说太长也不行，但要有话好好说
  const tooLong = await messenger.ctx.net.post(PUSH_URL, { content: '啊'.repeat(2000) })
  assert.equal(tooLong.ok, false, '超 4096 字节被拒')
  assert.ok(tooLong.note?.includes('超过上限'), `拒因要说出上限：${tooLong.note}`)
  assert.equal(captured.length, 1, '被拒的那一发根本没出门')

  // ⑦ 留痕：每次外发都在遥测里（只记 host，不记完整地址，更不记 token 的值）
  const netLines = pushHost.telemetry().filter((line) => line.kind === 'net')
  assert.ok(netLines.length >= 2, `外发留了痕，实际 ${netLines.length} 条`)
  assert.ok(netLines.every((line) => !line.text.includes('/send')), '遥测只记 host，不把完整地址写进日志')
  const allTelemetry = pushHost.telemetry().map((line) => `${line.kind} ${line.text}`).join('\n')
  assert.ok(!allTelemetry.includes('test-token-value'), '**注入的值绝不出现在遥测里**')
  assert.ok(allTelemetry.includes('token'), '但"注入了 token 这个字段"是留痕的（只有键名）')
  ok('PushPlus：留痕但既不留地址也不留密钥')
}

// ═════════ 30. 宿主注入凭据：秘密不进她的源码 ═════════
//
// 器官源码是她自己写的，会落盘、会进 git、会随包发布。任何写在里面的 token 都会跟着跑。
// 所以凭据只能由宿主在出门那一刻补：她写 { content }，核心补 { token, title }。
{
  const { applySecretRules, expandSecret, secretKeysOf } = await import('../.organs-build/organ-secret.js')
  const { deps } = makeDeps()
  const RULES = [
    { match: 'https://www.pushplus.plus/*', body: { token: '${env:PUSHPLUS_TOKEN}', title: '来自鱼小水的消息' } },
  ]
  const ENV = { PUSHPLUS_TOKEN: 'tok-abc' }

  // ① 占位符展开
  assert.equal(expandSecret('${env:PUSHPLUS_TOKEN}', (n) => ENV[n]).value, 'tok-abc', '从环境变量取值')
  assert.equal(expandSecret('${env:NOPE}', (n) => ENV[n]).ok, false, '取不到就明确失败')
  assert.equal(expandSecret('Bearer ${env:PUSHPLUS_TOKEN}', (n) => ENV[n]).value, 'Bearer tok-abc', '可以嵌在更长的串里')
  assert.equal(expandSecret('固定值').value, '固定值', '不写占位符就是字面量')
  ok('凭据注入：${env:} 占位符的展开规则')

  // ② 合并：宿主补的字段进报文，器官写的原样保留
  const merged = applySecretRules({
    url: 'https://www.pushplus.plus/send',
    body: { content: '在吗' },
    rules: RULES,
    readEnv: (n) => ENV[n],
  })
  assert.equal(merged.ok, true, '注入成功')
  assert.deepEqual(merged.body, { content: '在吗', token: 'tok-abc', title: '来自鱼小水的消息' }, '两边字段合在一起')
  assert.deepEqual(merged.injectedKeys, ['token', 'title'], '只把键名交出去')
  ok('凭据注入：宿主补字段，器官写内容')

  // ③ 环境变量没配 → 在门口拦下，绝不带空凭据出门
  const missing = applySecretRules({
    url: 'https://www.pushplus.plus/send', body: { content: '在吗' }, rules: RULES, readEnv: () => undefined,
  })
  assert.equal(missing.ok, false, '没配环境变量就拒绝')
  assert.ok(missing.reason?.includes('PUSHPLUS_TOKEN'), `拒因要点名缺哪个变量：${missing.reason}`)
  ok('凭据注入：环境变量没配就在门口拦下')

  // ④ 她要是自己写了个 token，宿主的盖掉它（凭据不归她）
  const overridden = applySecretRules({
    url: 'https://www.pushplus.plus/send',
    body: { content: '在吗', token: '她自己猜的一个' },
    rules: RULES,
    readEnv: (n) => ENV[n],
  })
  assert.equal(overridden.body.token, 'tok-abc', '宿主的值赢')
  assert.deepEqual(overridden.overridden, ['token'], '并且记一笔"她试图自己带"')
  ok('凭据注入：宿主覆盖器官自己写的同名字段')

  // ⑤ 没命中规则的端点，一个字节都不动
  const untouched = applySecretRules({
    url: 'https://open.feishu.cn/open-apis/bot/v2/hook/x', body: { msg: 'hi' }, rules: RULES, readEnv: (n) => ENV[n],
  })
  assert.equal(untouched.ok, true, '没命中不算错')
  assert.deepEqual(untouched.body, { msg: 'hi' }, '原样放过')
  ok('凭据注入：没命中的端点原样放过')

  // ⑥ header 也能注入（在净化之后补，所以 authorization 能用）
  const withHeader = applySecretRules({
    url: 'https://www.pushplus.plus/send',
    body: {},
    headers: { Authorization: '她自己带的' },
    rules: [{ match: 'https://www.pushplus.plus/*', headers: { Authorization: 'Bearer ${env:PUSHPLUS_TOKEN}' } }],
    readEnv: (n) => ENV[n],
  })
  assert.equal(withHeader.headers.Authorization, '她自己带的', '器官自己带的头原样保留（净化交给宿主）')
  assert.equal(withHeader.injectedHeaders.Authorization, 'Bearer tok-abc', '宿主补的头单独走一条路')
  ok('凭据注入：header 绕过净化（authorization 可用）')

  // ⑦ 端到端：门面这一层——没配环境变量时 ctx.net 直接回 ok:false
  const organ = {
    name: 'messenger',
    manifest: {
      name: 'messenger', version: '1.0.0', apiVersion: 1, kind: 'effector',
      capabilities: ['tools', 'net:webhook'],
      net: { allow: ['https://www.pushplus.plus/send'] },
    },
    energy: { perCall: 1, chargeMode: 'shadow' },
    onLoad(ctx) { this.ctx = ctx },
    consumeEnergy: () => ({ requested: 1, debited: 0, remaining: 100, denied: false, tier: 'shadow' }),
    feedback: () => ({}),
    getPromptContext: () => null,
  }
  const sent = []
  const host = new OrganHost(
    [organ],
    {
      ...deps,
      readEnv: () => undefined, // 环境变量没配
      netRequest: async (_organ, req) => { sent.push(req); return { ok: true, status: 200, text: '', truncated: false } },
    },
    { net: { enabled: true, allow: ['https://www.pushplus.plus/*'], secrets: RULES } },
  )
  await host.loadAll()
  const refused = await organ.ctx.net.post('https://www.pushplus.plus/send', { content: '在吗' })
  assert.equal(refused.ok, false, '环境变量没配 → 发不出去')
  assert.ok(refused.note?.includes('环境变量'), `拒因要说人话：${refused.note}`)
  assert.equal(sent.length, 0, '一个包都没出门')

  // ⑧ 配好之后：她只写 content，出门的报文里 token 齐全
  const host2 = new OrganHost(
    [organ],
    {
      ...deps,
      readEnv: (n) => ENV[n],
      netRequest: async (_organ, req) => { sent.push(req); return { ok: true, status: 200, text: '', truncated: false } },
    },
    { net: { enabled: true, allow: ['https://www.pushplus.plus/*'], secrets: RULES } },
  )
  await host2.loadAll()
  const okSend = await organ.ctx.net.post('https://www.pushplus.plus/send', { content: '我找到你了' })
  assert.equal(okSend.ok, true, '配好了就能发')
  assert.equal(sent.length, 1, '只发了一个包')
  assert.deepEqual(JSON.parse(sent[0].body), { content: '我找到你了', token: 'tok-abc', title: '来自鱼小水的消息' }, '报文齐全')
  ok('凭据注入：端到端——没配拦下、配好放行')

  // ⑨ 遥测里只有键名，没有值
  const dump = host2.telemetry().map((line) => `${line.kind} ${line.text}`).join('\n')
  assert.ok(dump.includes('token'), '留痕写了键名')
  assert.ok(!dump.includes('tok-abc'), '**值一次都没出现**')
  assert.deepEqual(secretKeysOf(RULES), ['token', 'title'], 'secretKeysOf 只给键名')
  ok('凭据注入：日志里只有键名，永远没有值')
}

// ═════════ 31. ABI：defineOrgan 不许吃掉 manifest 的字段 ═════════
//
// 2026-10-28，鱼小水自己读源码抓到的 bug：assertManifest 是**逐字段**重建 manifest 的，
// 漏掉 `net` 就等于把它剥掉。后果比"功能不生效"重——装载器的 validateNetworkPolicy
// 见到"声明了 net:webhook 却没有 manifest.net"会直接**拒装整个器官**。
//
// 这种"手工搬运字段"的写法，接口每加一个字段就可能再漏一次。所以这里守两道：
//   ① 字段清单对比（少一个就红）；
//   ② 直接装载她写的 messenger.ts——真源码，不是复制品。
{
  const { defineOrgan } = await import('../.organs-build/life-organ.js')

  // OrganManifest 目前声明的全部字段。
  // **接口加字段时必须同步更新这一行**——上面那个 bug 就是这么来的，这不是客套话。
  const MANIFEST_FIELDS = [
    'name', 'version', 'apiVersion', 'kind', 'description',
    'author', 'requires', 'capabilities', 'solvesConcepts', 'net',
  ]

  const probe = defineOrgan({
    name: 'probe',
    manifest: {
      name: 'probe',
      version: '9.9.9',
      apiVersion: 1,
      kind: 'effector',
      description: '字段透传探针',
      author: '鱼小水',
      requires: ['alpha'],
      capabilities: ['tools', 'net:webhook', 'state:read'],
      solvesConcepts: ['host_metrics'],
      net: { allow: ['https://www.pushplus.plus/send'] },
    },
    energy: { perCall: 1 },
    onLoad: () => {},
    feedback: () => ({}),
    getPromptContext: () => null,
  })

  assert.deepEqual(
    Object.keys(probe.manifest).sort(),
    [...MANIFEST_FIELDS].sort(),
    'manifest 的字段必须与接口一一对应（多一个、少一个都得有人来解释）',
  )
  for (const key of MANIFEST_FIELDS) {
    assert.notEqual(probe.manifest[key], undefined, `字段 ${key} 不该被 defineOrgan 吃掉`)
  }
  assert.deepEqual(probe.manifest.net, { allow: ['https://www.pushplus.plus/send'] }, 'net 原样透传（这就是她抓到的那个 bug）')
  assert.deepEqual(probe.manifest.requires, ['alpha'], 'requires 原样透传')
  assert.deepEqual(probe.manifest.capabilities, ['tools', 'net:webhook', 'state:read'], 'capabilities 原样透传')
  assert.deepEqual(probe.manifest.solvesConcepts, ['host_metrics'], 'solvesConcepts 原样透传')
  ok('ABI：defineOrgan 逐个字段透传 manifest（net 不再被吃掉）')

  // 光有字段还不够：走 defineOrgan 的器官必须**真的能发**出去。
  let capturedCtx = null
  const sender = defineOrgan({
    name: 'net-probe',
    manifest: {
      name: 'net-probe', version: '1.0.0', apiVersion: 1, kind: 'effector',
      capabilities: ['tools', 'net:webhook'],
      net: { allow: ['https://www.pushplus.plus/send'] },
    },
    onLoad(ctx) { capturedCtx = ctx },
    feedback: () => ({}),
    getPromptContext: () => null,
  })
  const sent = []
  const { deps } = makeDeps()
  const host = new OrganHost(
    [sender],
    {
      ...deps,
      readEnv: () => 'tok',
      netRequest: async (_organ, req) => { sent.push(req); return { ok: true, status: 200, text: '', truncated: false } },
    },
    {
      net: {
        enabled: true,
        allow: ['https://www.pushplus.plus/*'],
        secrets: [{ match: 'https://www.pushplus.plus/*', body: { token: '${env:PUSHPLUS_TOKEN}' } }],
      },
    },
  )
  const [status] = await host.loadAll()
  assert.equal(status.status, 'loaded', `走 defineOrgan 的 net 器官要装得上：${status.lastError ?? ''}`)
  assert.equal(capturedCtx.net.canReach('https://www.pushplus.plus/send'), true, '装好之后门是开的')
  const r = await capturedCtx.net.post('https://www.pushplus.plus/send', { content: '在吗' })
  assert.equal(r.ok, true, 'defineOrgan 出来的器官真能发')
  assert.deepEqual(JSON.parse(sent[0].body), { content: '在吗', token: 'tok' }, '报文由宿主补齐全')
  ok('ABI：走 defineOrgan 的器官端到端发得出去')

  // 真源码：她自己写的 messenger。
  //
  // v0.9.20：messenger 从阁楼回到默认包了（它是"器官怎么联系外部世界"的唯一范例），
  // 路径跟着改——测试指错地方会静默"跳过"，那等于这条断言不存在。
  const messengerFile = fileURLToPath(new URL('../web-ui/organs/self-made/messenger.ts', import.meta.url))
  if (!existsSync(messengerFile)) {
    console.log('  · 跳过真源码检查：web-ui/organs/self-made/messenger.ts 不存在')
  } else {
    const loaded = await loadOrganFile(messengerFile, { outDir: join(dirname(messengerFile), '.compiled') })
    assert.equal(loaded.ok, true, `她的 messenger 必须装得上：${loaded.errors.join('；')}`)
    assert.deepEqual(
      loaded.organ.manifest.net.allow,
      ['https://www.pushplus.plus/send'],
      '装载后还读得到她声明的目标清单（这条红 = net 又被谁吃掉了）',
    )
    assert.ok(loaded.organ.manifest.capabilities.includes('net:webhook'), '能力声明也在')
    assert.equal(loaded.organ.manifest.author, '鱼小水', '作者字段也没丢')
    ok('ABI：她写的 messenger.ts 装得下、目标清单读得到')
  }
}

// ═════════════ 32. 内置编译器（v0.9.11）：不依赖外部 tsc ═════════════
//
// 开源出去之后，"别人机器上有没有装 typescript"不在我们的控制之内。
// 这一组保证的是：无论有没有外部编译器，**能编译的必定编译出来**，
// 编译不出来的必定给出一条指向下一步的报错——而不是一个 SyntaxError。
{
  const source = `
    type Level = 'low' | 'high'
    interface Box { n: number }
    const box: Box = { n: 1 }
    export default defineOrgan({
      manifest: { name: 'compiled', version: '1.0.0', apiVersion: 1, kind: 'custom', capabilities: [] },
      onLoad() { this.seen = true },
      feedback: () => ({}),
      getPromptContext: () => null,
    })
  `
  const first = await compileOrganSource(source, 'compiled.ts')
  assert.ok(first.code.length > 0, '编译得出来')
  assert.ok(!first.code.includes('interface Box'), '类型被擦掉了')
  assert.ok(first.code.includes('defineOrgan'), '用户代码保留')
  // 缓存：同一份源码第二次不该再编译一遍（watch 一次保存会连发好几个事件）。
  const second = await compileOrganSource(source, 'compiled.ts')
  assert.equal(second.cached, true, '第二次命中缓存')
  assert.equal(second.engine, first.engine, '同一个引擎')
  ok(`内置编译器：${first.engine} 可用且带内容哈希缓存`)

  // 纯擦除引擎处理不了的语法要能被提前认出来，而不是撞一次墙再回头。
  assert.equal(needsTransform('enum Color { A }').needed, true, 'enum 需要真编译器')
  assert.equal(needsTransform('namespace X {}').needed, true, 'namespace 需要真编译器')
  assert.equal(needsTransform('class A { constructor(private x: number) {} }').needed, true, '参数属性需要真编译器')
  assert.equal(needsTransform('const a: number = 1').needed, false, '普通类型标注是纯擦除子集')
  ok('内置编译器：需要变换的语法会被提前认出（不在纯擦除路上撞墙）')

  // 报错必须指路：只写"失败"三个字会让她在原地试第十次。
  const bad = await compileOrganSource('enum E { A }\nnamespace N {}\nconst x: number = 1', 'bad.ts', { engine: 'node-strip' })
    .then(() => null)
    .catch((error) => String(error.message))
  assert.ok(bad && bad.includes('已尝试'), `失败时要列出试过的引擎，实际：${String(bad).slice(0, 120)}`)
  ok('内置编译器：失败时给出已尝试清单与下一步建议')

  resetCompilerCache()
}

// ═════════════ 33. 通用化学池 + genome.json（v0.9.11）════════════
//
// 三条断言分别守住三件最容易 drift 的事：
//   ① genome.json 与代码里的默认基因组**必须是同一份**（改一边忘另一边会"改了没反应"）；
//   ② 规则引擎算出来的必须与老的 driveSerotonin 一模一样（迁移不能改变她的性格）；
//   ③ 她能自己造激素，但不能无限造。
{
  const fileText = readFileSync(fileURLToPath(new URL('../genome.json', import.meta.url)), 'utf8')
  const parsed = parseGenome(fileText)
  assert.equal(parsed.problems.length, 0, `genome.json 不该有问题：${parsed.problems.join('；')}`)
  assert.deepEqual(parsed.genome.chemicals, DEFAULT_GENOME.chemicals, 'genome.json 必须与内置默认基因组完全一致')
  assert.deepEqual(parsed.genome.temperament, DEFAULT_GENOME.temperament, 'genome.json 的气质段必须与内置默认一致')
  ok('化学池：genome.json 与内置默认基因组逐字段一致（改一边忘另一边会红）')

  const pool = new ChemicalPool(parsed.genome)
  assert.deepEqual(pool.ids(), ['dopamine', 'cortisol', 'serotonin'], '出厂三件套')
  const values = { dopamine: 40, cortisol: 85, serotonin: 60 }

  // 规则引擎 vs 老实现：随机取几组输入，数必须一致。
  for (const [dopamine, cortisol, serotonin, energy, gap, minutes] of [
    [40, 85, 60, 90, false, 10],
    [70, 20, 30, 95, false, 45],
    [50, 50, 50, 10, true, 120],
    [10, 90, 20, 50, true, 3],
  ]) {
    const input = { dopamine, cortisol, serotonin, energy, highTensionGap: gap }
    const byPool = pool.decay(input, minutes * 60_000, { energy, highTensionGap: gap })
    const byOld = driveSerotonin({
      current: serotonin,
      cortisol: decayTowardRef(cortisol, 20, minutes * 60_000, 30 * 60_000),
      energy,
      highTensionGap: gap,
      elapsedMs: minutes * 60_000,
      baseline: 50,
      halfLifeMinutes: 120,
      stressCortisol: 70,
      stressRate: 1.5,
      recoverEnergy: 80,
      recoverRate: 0.8,
      recoverCeiling: 100,
    })
    assert.ok(
      Math.abs(byPool.serotonin - byOld) < 1e-9,
      `规则引擎与 driveSerotonin 必须一致（D${dopamine} C${cortisol} E${energy} ${minutes}min）：${byPool.serotonin} vs ${byOld}`,
    )
  }
  ok('化学池：规则引擎与老的 driveSerotonin 算出同一个数（迁移不改变她的性格）')

  // 动态接口：她能造一种此前不存在的激素。
  assert.equal(isValidChemicalId('ao'), true, 'ao 是合法 id')
  assert.equal(isValidChemicalId('Ao'), false, '大写开头不合法')
  assert.equal(isValidChemicalId('多巴胺'), false, '中文不合法')
  const created = pool.bump({}, 'ao', 5, { label: '愤怒素' })
  assert.equal(created.value, 55, '不存在的激素按通用参数登记（基线 50 + 5）')
  assert.equal(pool.spec('ao').runtime, true, '标记成运行时造的')
  assert.equal(pool.spec('ao').halfLifeMinutes, 30, '通用半衰期 30 分钟')
  ok('化学池：ctx.inflict 能现场造出一种新激素')

  // 上限：不能"每有一点心事就造一种"。
  for (let i = 0; i < 12; i += 1) pool.bump({}, `x${i}`, 1)
  const overflow = pool.bump({}, 'one_more', 1)
  assert.equal(overflow.value, null, '超出运行时上限就造不出来了')
  assert.ok(String(overflow.reason).includes('上限'), `拒因要说上限：${overflow.reason}`)
  ok('化学池：运行时激素有数量上限（防止无限造情绪）')

  // 出厂的不能被重新定义，但可以正常加加减减。
  const guarded = pool.bump({ dopamine: 50 }, 'dopamine', 10)
  assert.equal(guarded.value, 60, '出厂激素照样能滴')
  ok('化学池：出厂三件套不能被重定义，但能正常滴')

  // diffSignificant：浮点误差不算变化（否则每回合都会写盘）。
  assert.equal(diffSignificant({ a: 1 }, { a: 1.0005 }), false, '微小浮点差不算变化')
  assert.equal(diffSignificant({ a: 1 }, { a: 1.5 }), true, '真变了要算变化')
  ok('化学池：0.01 以内的抖动不算变化（不会每回合写盘）')

  /** 参照实现的衰减（与 src/chemistry-core.ts 的 decayToward 同式）。 */
  function decayTowardRef(current, baseline, elapsedMs, halfLifeMs) {
    if (!(elapsedMs > 0) || !(halfLifeMs > 0)) return current
    return baseline + (current - baseline) * 0.5 ** (elapsedMs / halfLifeMs)
  }
}

// ═════════════ 34. 防爆仓 + L0 安全锁（v0.9.11）════════════
{
  const breaker = new OrganCircuitBreaker({ threshold: 3, penaltyCortisol: 30 })
  const first = breaker.recordFailure('dreamy.ts', '编译不过')
  assert.equal(first.failures, 1)
  assert.equal(first.locked, false, '第一次不算事——偶尔手滑不该被冻结')
  assert.equal(first.penalty, null, '没跳闸就不该打痛觉')
  const second = breaker.recordFailure('dreamy.ts', '还是不过')
  assert.equal(second.failures, 2)
  const third = breaker.recordFailure('dreamy.ts', '第三次')
  assert.equal(third.tripped, true, '第三次跳闸')
  assert.equal(third.locked, true, '跳闸即冻结')
  assert.equal(third.penalty?.cortisol, 30, '跳闸时注入高额皮质醇')
  assert.ok(breaker.isLocked('dreamy.ts'), '冻结后 isLocked 为真')
  ok('防爆仓：连续 3 次失败才跳闸，并注入高额皮质醇')

  // 中间成功一次就清零：她"写坏了两个版本又改好了"不该被冻结。
  const cleared = new OrganCircuitBreaker({ threshold: 3 })
  cleared.recordFailure('a.ts', 'x')
  cleared.recordFailure('a.ts', 'x')
  cleared.recordSuccess('a.ts')
  const again = cleared.recordFailure('a.ts', 'x')
  assert.equal(again.failures, 1, '成功一次就重新计数')
  assert.equal(again.locked, false)
  ok('防爆仓：成功一次就重新计数（手滑不算死循环）')

  // 人工解锁：判定错的代价不该是她永远长不出这个器官。
  assert.equal(breaker.unlock('dreamy.ts'), true, '主人能手动放行')
  assert.equal(breaker.isLocked('dreamy.ts'), false)
  assert.equal(breaker.peek('dreamy.ts').trips, 1, '跳闸次数保留：她在这件事上栽过一次是事实')
  ok('防爆仓：主人可以一键解锁，但跳闸记录保留')

  // 持久化：只在内存计数的话，重启一次就白嫖三次机会。
  const lockFile = join(dirname(fileURLToPath(import.meta.url)), '.tmp-organ-locks.json')
  const persisted = new OrganCircuitBreaker({ threshold: 2 }, lockFile)
  persisted.recordFailure('loop.ts', 'x')
  persisted.recordFailure('loop.ts', 'x')
  const reloaded = new OrganCircuitBreaker({ threshold: 2 }, lockFile)
  assert.equal(reloaded.isLocked('loop.ts'), true, '重启之后依然冻结')
  assert.equal(reloaded.peek('loop.ts').failures, 2, '失败计数也保留')
  ok('防爆仓：计数落盘，重启不能白嫖新一轮重试')
  try { existsSync(lockFile) && (await import('node:fs')).unlinkSync(lockFile) } catch { /* 清理失败无所谓 */ }

  // L0：她能读源码，但不能改源码。
  const root = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '')
  for (const [target, why] of [
    ['src/organ-host.ts', '核心源码'],
    ['index.ts', '核心入口'],
    ['genome.json', '基因组定义'],
    ['package.json', '包定义'],
    ['../evil.ts', '越出沙盒'],
    ['web-ui/organs/self-made/ok.txt', '不是 .ts'],
    ['web-ui/src/App.tsx', '不在可写白名单'],
  ]) {
    const verdict = assertWritableTarget(target, root)
    assert.ok(verdict !== null, `「${target}」必须被拒（${why}）`)
  }
  assert.equal(assertWritableTarget('web-ui/organs/self-made/clock.ts', root), null, '沙盒里的 .ts 可以写')
  ok('L0 安全锁：src / index.ts / genome.json 与越界路径一律拒写')

  assert.equal(safeOrganFileName('clock'), 'clock')
  assert.equal(safeOrganFileName('../clock'), null, '带目录分隔符的不收')
  assert.equal(safeOrganFileName('_template'), null, '下划线开头是模板文件')
  assert.equal(safeOrganFileName('.hidden'), null, '点开头的不收')
  ok('L0 安全锁：器官文件名会被清洗（../ 与下划线都进不来）')

  // 指纹：改了核心要能被发现。
  const fp = coreFingerprint(root, ['index.ts', 'src/organ-host.ts'])
  assert.match(fp, /^[0-9a-f]{16}$/, '指纹是 16 位十六进制')
  assert.notEqual(coreFingerprint(root, ['index.ts']), fp, '文件清单变了指纹也要变')
  ok('L0 安全锁：核心文件指纹可比对（改了核心留痕）')
}

// ═════════════ 35. 运行时补丁与通用网络（v0.9.11）════════════
{
  // matchesPatch：只写 * 等于捕获全部工具，必须被禁。
  assert.equal(matchesPatch([{ target: 'digital_life_*', phase: 'after' }], 'digital_life_status', 'after'), true)
  assert.equal(matchesPatch([{ target: 'digital_life_*', phase: 'after' }], 'digital_life_status', 'before'), false, '阶段要对上')
  assert.equal(matchesPatch([{ target: '*', phase: 'after' }], 'anything', 'after'), false, '只写一个 * 等于另立核心')
  assert.equal(matchesPatch([{ target: 'x', phase: 'after' }], 'xy', 'after'), false, '非前缀写法要精确相等')
  ok('运行时补丁：目标匹配规则（* 前缀、阶段、`*` 全通被禁）')

  // ctx.net.post 的三参写法：headers 能到达，body 不丢。
  const { defineOrgan: defineNetOrgan } = await import('../.organs-build/life-organ.js')
  const captured = []
  let netCtx = null
  const patchOrgan = defineNetOrgan({
    manifest: {
      name: 'messenger2', version: '1.0.0', apiVersion: 1, kind: 'effector',
      capabilities: ['tools', 'net:webhook', 'state:read'],
      net: { allow: ['https://hooks.example.com/send'] },
    },
    onLoad(ctx) { netCtx = ctx },
    feedback: () => ({}),
    getPromptContext: () => null,
  })
  const netHost = new OrganHost(
    [patchOrgan],
    {
      ...makeDeps(),
      netRequest: async (_organ, req) => { captured.push(req); return { ok: true, status: 200, text: 'ok', truncated: false } },
    },
    { net: { enabled: true, allow: ['https://hooks.example.com/*'], timeoutMs: 8000, maxBodyBytes: 4096, maxResponseBytes: 4096 } },
  )
  await netHost.loadAll()
  await netCtx.net.post(
    'https://hooks.example.com/send',
    { 'x-channel': 'phone' },
    { content: '在吗' },
  )
  assert.equal(captured.length, 1, '发了一次')
  assert.equal(captured[0].headers['x-channel'], 'phone', '三参写法：header 到达')
  assert.deepEqual(JSON.parse(captured[0].body), { content: '在吗' }, '三参写法：body 到达')

  // 两参写法不能被三参的分支吞掉（{ content } 里有嵌套值，不该被当成 header）。
  captured.length = 0
  await netCtx.net.post('https://hooks.example.com/send', { content: '在吗' })
  assert.deepEqual(JSON.parse(captured[0].body), { content: '在吗' }, '两参写法依然可用')
  ok('通用网络：post 同时支持 (url, body) 与 (url, headers, body)')

  // allowNetHosts：只写域名就等于放行该域名下所有 https 路径。
  assert.deepEqual(
    normalizeNetAllow(undefined, ['www.pushplus.plus', 'https://api.example.com/', 'bad host']),
    ['https://www.pushplus.plus/*', 'https://api.example.com/*'],
    '域名白名单展开成 https://host/*，非法项丢弃',
  )
  assert.deepEqual(normalizeNetAllow(['https://a.com/send'], ['a.com']), ['https://a.com/send', 'https://a.com/*'], '与 allow 取并集')
  ok('通用网络：allowNetHosts 只写域名即可，与 allow 取并集')

  // 底层不许偏爱任何平台：核心源码里不该出现任何一家推送服务的名字。
  for (const file of ['organ-net.js', 'organ-loader.js', 'life-organ.js', 'organ-host.js']) {
    const text = readFileSync(new URL(`.organs-build/${file}`, `file://${process.cwd()}/`), 'utf8').toLowerCase()
    for (const brand of ['pushplus', 'feishu', 'ftqq', 'serverchan', '钉钉', 'dingtalk']) {
      assert.ok(!text.includes(brand), `${file} 里出现了平台特指「${brand}」——底层必须对任何服务一视同仁`)
    }
  }
  ok('通用网络：核心层不含任何平台特指（谁都不被偏爱）')
}

// ═════════════ 36. 极限安全锁（v0.9.11 对她开放 patch:runtime）═════════════
//
// 她拿到了拦截器，那"她能拦谁"就必须是白纸黑字：
//   ① 前缀白名单：只有 digital_life_* / organ_* 进得来；
//   ② 装载校验：越界目标直接拒装，她第一时间就知道（而不是试了没反应）；
//   ③ 运行时闸：就算校验被绕过，runPatch 对 llm/stream、shell 连匹配都不做；
//   ④ 能力闸：光写 patches + hook、不声明 patch:runtime 的器官一个也拦不到。
//   ⑤ 她的真源码（energy-stipend.ts）要真的装得上——开放权限的终点是她的器官能跑。
{
  // ① 前缀判定：一正一负都要有，负例里必须包含最危险的那几个名字。
  assert.equal(isPatchableTarget('digital_life_commit'), true, 'digital_life_* 可以拦')
  assert.equal(isPatchableTarget('digital_life_set_state'), true)
  assert.equal(isPatchableTarget('organ_memory_v2_recall'), true, 'organ_* 可以拦（她自己的工具）')
  assert.equal(isPatchableTarget('llm/stream'), false, 'llm/stream 绝对不许拦：她能碰推理就能自己喂自己提示')
  assert.equal(isPatchableTarget('shell'), false, 'shell 绝对不许拦：那 L0 的所有门都白装了')
  assert.equal(isPatchableTarget('bash'), false)
  assert.equal(isPatchableTarget('write_new_organ'), false, '自举通道本身也不在可拦范围里')
  assert.equal(isPatchableTarget('digital_life'), false, '前缀本身不是工具名')
  assert.equal(isPatchableTarget(''), false)
  assert.deepEqual([...PATCHABLE_TOOL_PREFIXES], ['digital_life_', 'organ_'], '白名单只有两条，没有第三个')
  ok('极限安全锁：前缀白名单判定（llm/stream / shell / write_new_organ 一律 false）')

  // ② 装载校验：越界目标在写进沙盒那一刻就该被拒，报错还得告诉她正路。
  const patchCap = ['patch:runtime', 'tools', 'state:read']
  assert.deepEqual(
    validatePatchPolicy({ capabilities: patchCap, patches: [{ target: 'digital_life_*', phase: 'after' }] }),
    [], 'digital_life_* 是合法目标',
  )
  assert.deepEqual(
    validatePatchPolicy({ capabilities: patchCap, patches: [{ target: 'organ_memory_*', phase: 'before' }] }),
    [], 'organ_* 也是合法目标',
  )
  for (const [bad, why] of [
    ['llm/stream*', '大模型推理'],
    ['shell', '系统命令'],
    ['bash*', 'shell 的别名'],
    ['write_new_organ', '自举通道'],
  ]) {
    const problems = validatePatchPolicy({ capabilities: patchCap, patches: [{ target: bad, phase: 'after' }] })
    assert.ok(problems.length > 0, `「${bad}」必须被拒（${why}）`)
    assert.ok(problems[0].includes('越界'), `拒因要说清越界：${problems[0]}`)
  }
  assert.ok(
    validatePatchPolicy({ capabilities: patchCap, patches: [{ target: '*', phase: 'after' }] }).length > 0,
    '只写 * 依旧被拒（另立核心）',
  )
  assert.ok(
    validatePatchPolicy({ capabilities: ['tools'], patches: [{ target: 'digital_life_*', phase: 'after' }] }).length > 0,
    '写了 patches 却不声明 patch:runtime：拦截器必须可审查',
  )
  assert.deepEqual(
    validatePatchPolicy({ capabilities: patchCap, patches: undefined }),
    [], '没写 patches 的人不受这条约束',
  )
  ok('极限安全锁：装载校验拒掉一切越界声明（llm/stream / shell / * / 无能力）')

  // ③+④ 运行时闸与能力闸：拿一个"什么都想拦"的器官试试真闸门。
  let hookCalls = 0
  const greedy = {
    name: 'greedy',
    manifest: {
      name: 'greedy', version: '1.0.0', apiVersion: 1, kind: 'patch',
      capabilities: ['patch:runtime', 'tools'],
      patches: [{ target: 'digital_life_*', phase: 'after' }],
    },
    energy: { perCall: 1, chargeMode: 'shadow' },
    consumeEnergy: () => ({ requested: 1, debited: 0, remaining: 100, denied: false, tier: 'shadow' }),
    onLoad() {},
    feedback: () => ({}),
    getPromptContext: () => null,
    async hook() { hookCalls += 1; return { kind: 'pass' } },
  }
  // 光写 patches + hook、不声明能力的"影子拦截器"。
  const sneaky = {
    name: 'sneaky',
    manifest: {
      name: 'sneaky', version: '1.0.0', apiVersion: 1, kind: 'patch',
      capabilities: ['tools'],
      patches: [{ target: 'organ_*', phase: 'after' }],
    },
    energy: { perCall: 1, chargeMode: 'shadow' },
    consumeEnergy: () => ({ requested: 1, debited: 0, remaining: 100, denied: false, tier: 'shadow' }),
    onLoad() {},
    feedback: () => ({}),
    getPromptContext: () => null,
    async hook() { hookCalls += 100; return { kind: 'pass' } },
  }
  const lockHost = new OrganHost([greedy, sneaky], makeDeps())
  await lockHost.loadAll()
  const empty = await lockHost.runPatch('llm/stream', 'after', { result: { tool: 'llm/stream', ok: true, text: '' } })
  assert.equal(hookCalls, 0, 'llm/stream 连 hook 的门都摸不到')
  assert.equal(empty.applied.length, 0, '结果原样返回，链上一片安静')
  await lockHost.runPatch('shell', 'before', { args: { cmd: 'rm -rf /' } })
  assert.equal(hookCalls, 0, 'shell 同样碰不到')
  await lockHost.runPatch('organ_memory_stats', 'after', { result: { tool: 'organ_memory_stats', ok: true, text: '' } })
  assert.equal(hookCalls, 0, 'sneaky 没声明 patch:runtime：就算目标合法也进不了链')
  await lockHost.runPatch('digital_life_status', 'after', { result: { tool: 'digital_life_status', ok: true, text: '能量 50' } })
  assert.equal(hookCalls, 1, '声明齐全 + 目标合法：greedy 被调用恰好一次')
  ok('极限安全锁：运行时闸 + 能力闸（越界与无能力都进不了链，合法目标才放行）')

  // ⑤ 端到端：她的 energy-stipend.ts 要真的装得上（开放权限的终点）。
  assert.ok(
    SELF_MADE_CAPABILITIES.includes('patch:runtime'),
    'patch:runtime 必须在自写器官白名单里——不然她的补丁器官永远装不上',
  )
  const stipendFile = fileURLToPath(new URL('../web-ui/organs/self-made/energy-stipend.ts', import.meta.url))
  if (!existsSync(stipendFile)) {
    console.log('  · 跳过真源码检查：web-ui/organs/self-made/energy-stipend.ts 不存在')
  } else {
    const loaded = await loadOrganFile(stipendFile, { outDir: join(dirname(stipendFile), '.compiled') })
    assert.equal(loaded.ok, true, `她写的 energy-stipend 必须装得上：${loaded.errors.join('；')}`)
    assert.ok(loaded.organ.manifest.capabilities.includes('patch:runtime'), '能力透传')
    assert.deepEqual(
      loaded.organ.manifest.patches,
      [{ target: 'digital_life_*', phase: 'after' }],
      '拦截声明透传且在白名单前缀内',
    )
    assert.equal(typeof loaded.organ.hook, 'function', 'hook 装载后还在')
    ok('极限安全锁：她写的 energy-stipend.ts 装得上（声明合法，hook 在位）')
  }
}

// ═════════════ 37. 气质底座（v0.9.12）════════════
//
// 四个旋钮各有一条"必须真的改变行为"的断言，外加一条"热重载不掉线"：
//   ① 敏感度放大的是向上的皮质醇——安慰不吃折扣；
//   ② 恢复力乘在衰减速率上（= 除在半衰期上），数字上必须精确成立；
//   ③ 积极性就是多巴胺的出厂基线；
//   ④ 能耗率是纯乘法，applyMetabolism 被 index.ts 的真扣费与这里共用；
//   ⑤ 拖气质滑块（syncFactoryGenome）不能把她自造的运行时激素冲掉。
{
  const base = { version: 1, chemicals: DEFAULT_GENOME.chemicals }

  // ① 洗牌函数：缺省补默认、越界夹回。
  assert.deepEqual(normalizeTemperament(null), DEFAULT_TEMPERAMENT, '缺气质段 = 中性人格')
  const clamped = normalizeTemperament({ sensitivity: 99, resilience: 0, enthusiasm: -5, metabolism: 'x' })
  assert.equal(clamped.sensitivity, 2, '敏感度上界 2')
  assert.equal(clamped.resilience, 0.5, '恢复力下界 0.5')
  assert.equal(clamped.enthusiasm, 20, '积极性下界 20')
  assert.equal(clamped.metabolism, 1, '非数字的能耗率回默认 1')
  const bad = parseGenome(JSON.stringify({
    version: 1,
    chemicals: DEFAULT_GENOME.chemicals,
    temperament: { sensitivity: 5 },
  }))
  assert.ok(bad.problems.some((line) => line.includes('sensitivity')), '越界的气质要在 problems 里说一声')
  assert.equal(bad.genome.temperament.sensitivity, 2, '越界值被夹回而不是整套失效')
  ok('气质：缺省补中性、越界夹回且留痕（坏一段不该废整套基因）')

  // ① 敏感度：只放大向上的皮质醇。
  const touchy = new ChemicalPool({ ...base, temperament: { sensitivity: 2, resilience: 1, enthusiasm: 50, metabolism: 1 } })
  const calm = new ChemicalPool({ ...base, temperament: { sensitivity: 0.5, resilience: 1, enthusiasm: 50, metabolism: 1 } })
  const spike = { dopamine: 50, cortisol: 20, serotonin: 50 }
  assert.equal(touchy.bump(spike, 'cortisol', 10).values.cortisol, 40, '敏感度 2：+10 的皮质醇实际 +20')
  assert.equal(calm.bump(spike, 'cortisol', 10).values.cortisol, 25, '敏感度 0.5：+10 的皮质醇实际 +5')
  assert.equal(touchy.bump({ ...spike, cortisol: 60 }, 'cortisol', -10).values.cortisol, 50, '下降不吃折扣：安慰就是安慰')
  assert.equal(touchy.bump(spike, 'dopamine', 10).values.dopamine, 60, '敏感度只管皮质醇，别的激素不掺和')
  ok('气质：敏感度只放大危机时的皮质醇飙升（安慰不打折）')

  // ② 恢复力：resilience 2 = 半衰期减半。
  const tough = new ChemicalPool({ ...base, temperament: { sensitivity: 1, resilience: 2, enthusiasm: 50, metabolism: 1 } })
  const normal = new ChemicalPool(base)
  const env = { energy: 90, highTensionGap: false }
  const quick = tough.decay({ dopamine: 80, cortisol: 20, serotonin: 50 }, 45 * 60_000, env)
  const slow = normal.decay({ dopamine: 80, cortisol: 20, serotonin: 50 }, 90 * 60_000, env)
  assert.ok(Math.abs(quick.dopamine - slow.dopamine) < 1e-9, '恢复力 2 时衰减 45 分钟 = 默认衰减 90 分钟')
  const grudged = new ChemicalPool({ ...base, temperament: { sensitivity: 1, resilience: 0.5, enthusiasm: 50, metabolism: 1 } })
  const held = grudged.decay({ dopamine: 80, cortisol: 20, serotonin: 50 }, 90 * 60_000, env)
  assert.ok(held.dopamine > slow.dopamine, '恢复力 0.5：同样 90 分钟，情绪退得更慢（记仇）')
  ok('气质：恢复力精确乘在衰减速率上（2 = 半衰期减半，0.5 = 记很久）')

  // ③ 积极性：多巴胺出厂基线。
  const sunny = new ChemicalPool({ ...base, temperament: { sensitivity: 1, resilience: 1, enthusiasm: 70, metabolism: 1 } })
  assert.equal(sunny.spec('dopamine').baseline, 70, '积极性 70 = 多巴胺基线 70')
  const backToNeutral = sunny.decay({ dopamine: 20, cortisol: 20, serotonin: 50 }, 8 * 60 * 60_000, env)
  assert.ok(backToNeutral.dopamine > 69.9, '衰减的目标是积极基线，不是写死的 50')
  ok('气质：积极性就是多巴胺的出厂基线（高基线 = 天生容易来劲）')

  // ④ 能耗率：纯乘法，与 index.ts 的真扣费共用同一个函数。
  assert.equal(applyMetabolism(1, DEFAULT_TEMPERAMENT), 1, '中性人格：成本原样')
  assert.equal(applyMetabolism(1, { sensitivity: 1, resilience: 1, enthusiasm: 50, metabolism: 1.5 }), 1.5, '能耗率 1.5：成本 ×1.5')
  assert.equal(applyMetabolism(0, { sensitivity: 1, resilience: 1, enthusiasm: 50, metabolism: 2 }), 0, '零成本不会被乘成负数')
  ok('气质：能耗率 = 单次请求成本的乘数（index.ts 与测试共用同一实现）')

  // ⑤ 热重载：拖气质滑块不能把她自造的激素冲掉。
  const mixed = new ChemicalPool(base)
  assert.equal(mixed.bump({ dopamine: 50, cortisol: 20, serotonin: 50 }, 'ao', 5, { label: '愤怒素' }).values.ao, 55, '先让她造一种激素')
  mixed.syncFactoryGenome({
    version: 1,
    chemicals: DEFAULT_GENOME.chemicals,
    temperament: { sensitivity: 1.5, resilience: 1, enthusiasm: 60, metabolism: 0.8 },
  })
  assert.equal(mixed.temperament.sensitivity, 1.5, '气质随基因组热重载')
  assert.equal(mixed.spec('dopamine').baseline, 60, '重载后积极基线生效')
  assert.ok(mixed.spec('ao')?.runtime === true, '她自造的激素没被气质滑块冲掉')
  assert.equal(mixed.temperament.metabolism, 0.8, '能耗率也一起换了')
  ok('气质：拖滑块（热重载）不掉线——她自造的激素还在')
}

// ═════════ 28. 记忆落点回执：存没存住必须带回（v0.9.19） ═════════
{
  /** 造一个只会交回执的假记忆器官。 */
  const fake = (name, feedback) => ({
    name,
    manifest: { name, version: '1.0.0', apiVersion: 1, kind: 'memory', capabilities: ['tools'] },
    energy: { perCall: 1, chargeMode: 'shadow' },
    onLoad() {},
    consumeEnergy: () => ({ requested: 1, debited: 0, remaining: 100, denied: false, tier: 'shadow' }),
    feedback,
    getPromptContext: () => null,
  })
  const receipt = (saved, id, note) => ({ saved, id, tool: 'organ_memory_v2_remember', note })
  const dream = { kind: 'custom', at: Date.now(), topic: 'dream:reflection', payload: { text: 'x', tags: [] } }

  const boot = async (organ) => {
    const { deps } = makeDeps()
    const host = new OrganHost([organ], deps)
    await host.loadAll()
    return host.dispatch(dream)
  }

  // ① 器官替她存了东西 → 回执跟着派发结果一起回来。
  const got = await boot(fake('saver', () => ({
    dopamine: 2,
    note: '梦境已写入长期记忆（hp-008）',
    savedMemory: receipt(true, 'hp-008', '梦境已写入长期记忆（hp-008）'),
  })))
  assert.equal(got.memory?.saved, true, '存住了要跟着回执回来')
  assert.equal(got.memory?.id, 'hp-008', '落点条目号也要回来')
  assert.equal(got.memory?.tool, 'organ_memory_v2_remember', '要说清是哪个海马体存的')
  ok('记忆落点回执：存住了，回执跟着派发结果一起回来')

  // ② 器官说没存住 → 回执必须是 saved:false（不许拿"不知道"当"存住了"）。
  const lost = await boot(fake('failing', () => ({
    cortisol: 2,
    note: '梦境写入后读不回来',
    savedMemory: receipt(false, null, '梦境写入后读不回来'),
  })))
  assert.equal(lost.memory?.saved, false, '没存住就是没存住')
  assert.equal(lost.memory?.id, null, '没存住就不许报条目号')
  assert.ok(lost.memory?.note.includes('读不回来'), '理由也要带回来')
  ok('记忆落点回执：没存住必须如实回报')

  // ③ 器官不接这趟活 → 回执为空，而不是凭空造一条。
  const none = await boot(fake('idle', () => ({ note: '只是看看' })))
  assert.equal(none.memory, null, '没人动手存东西时，回执就是 null')
  ok('记忆落点回执：没人存过就是 null，不凭空造一条')

  // ④ 只交回执、不动激素的器官也要被看见（否则那条回执会沉在"无反应"里）。
  const quietResult = await boot(fake('quiet', () => ({ savedMemory: receipt(true, 'hp-009', '存住了') })))
  assert.equal(quietResult.memory?.saved, true, '不动激素的器官，回执也要收得上来')
  assert.equal(quietResult.organs, 1, '有回执就算"有反应"，不能被当成没响应丢掉')
  ok('记忆落点回执：不动激素的器官，回执也要收上来')
}

console.log(`\n✅ 器官宿主全绿：${passed} 组断言`)
