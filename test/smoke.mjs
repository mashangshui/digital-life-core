// 离线冒烟测试：安全底座 + 内分泌（三激素）/ 劫持 / 时间感 / 缺口 / 意志 / 监护仪 / 器官宿主
// v0.9.1 起，内省不再吐读数（改吐行为指令），并加入血清素维度。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 冒烟测试必须跑在**确定的基因组**上。
// 用户级 ~/.dsh/digital-life-core/genome.json 是「她亲手调过的人格」，
// 优先级高于项目根出厂文件——不同机器上那份可能写着代谢率 2，
// 会让"一次请求扣多少能量"这类断言随机漂移。这里钉死出厂那份。
process.env.DL_GENOME = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'genome.json')

import {
  apply as applyRaw,
  ChemicalPool,
  chemicalReadings,
  buildIntrospection,
  buildWillPrompt,
  buildWillMessage,
  WAKE_SOURCE_KIND,
  WAKE_TRIGGER_TEXT,
  L0PathGuard,
  formatL0Denial,
  buildDashboard,
  buildSomaDirectives,
  driveSerotonin,
  stressAttentionDirective,
  STRESS_ATTENTION_DIRECTIVE,
  INTROSPECTION_RULE,
  moodLabel,
  progressBar,
  classifyFailure,
  classifyRequestError,
  COMMAND_NAME,
  DEFAULT_REQUEST_COST,
  decayToward,
  failureGapSummary,
  findIgnoranceSnippet,
  findGapSentence,
  isSelfReferential,
  hasActionIntent,
  hasUnknownClaim,
  isExpository,
  isGapWorthy,
  parseRuntimeSpecs,
  parseLastDream,
  chemicalLabel,
  CHEMICAL_LABELS,
  LIFE_SUPPORT_TOOLS,
  NATIVE_SURVIVAL_TOOLS,
  DEFAULT_GATED_TOOLS,
  DEFAULT_COMMITMENT_TTL_MINUTES,
  matchToolPattern,
  normalizeGatedTools,
  isGatedByCommitment,
  EMERGENCY_STOP_MESSAGE,
  pickTemperature,
  stripMarkdown,
  textSimilarity,
  SUSPEND_MESSAGE,
  WOKE_UP_MIN_MS,
} from '../lib/index.js'
// 只读桥的快照构造：它读的是 state.json（另一个进程），留档要过它才递得出面板。
import { buildLastDream, buildSnapshot } from '../web-ui/server/snapshot.mjs'
// 桥与前端共用那份字典（桥是独立进程，读不到编译产物），两本字典不许说两套话。
import { CHEMICAL_LABELS as UI_LABELS, chemicalLabel as uiLabel } from '../web-ui/server/chemical-labels.mjs'
// 脉冲线判定：纯函数在 .mjs 里，桥与前端共用，测试能直接 import。
import { pulseSeries, seriesValue } from '../web-ui/server/pulse-series.mjs'
import {
  anchorKey,
  attentionWeights,
  classifyAttention,
  CRISIS_WEIGHT,
  DAILY_WEIGHT,
  DEFAULT_ATTENTION_OPTIONS,
  memoryAffinity,
  planRecallBudget,
  rankScore,
  rewriteRecall,
  splitMemoryEntries,
  STRESS_CORTISOL,
} from '../lib/src/organs/memory-affinity.js'
import { organToolName, sanitizeToolName, TOOL_NAME_PATTERN } from '../lib/src/life-organ.js'
import {
  findEpiphanies,
  scoreEpiphany,
  matchConcepts,
  matchDeficiency,
  conceptsOf,
  resolveSolvedConcepts,
  DEFAULT_EPIPHANY_CONFIG,
  EPIPHANY_AFFECT,
} from '../lib/src/epiphany.js'
import { sanitizeText, toLosslessJson, truncateSafe } from '../lib/src/json-safe.js'
import { listOrganSources, scanSource, stripImports, SELF_MADE_CAPABILITIES } from '../lib/src/organ-loader.js'
import {
  cpuPercentBetween,
  cpuPercentSinceBoot,
  createHostMetricsSampler,
  emptyHostMetrics,
} from '../lib/src/host-metrics.js'
import {
  DEFAULT_AUTO_APPROVE_ALLOW,
  DEFAULT_AUTO_APPROVE_ASK,
  classifyToolForApproval,
  globToRegExp,
  isOverBroadAllow,
  matchesAny,
} from '../lib/src/auto-approve.js'
import {
  DEFAULT_QUIET_HOURS,
  DEFAULT_SLEEP_CONFIG,
  isQuietHour,
  settleRest,
} from '../lib/src/sleep-energy.js'

/**
 * 冒烟测试默认**关掉自举通道**：它会监听真实的 web-ui/organs/self-made，
 * 而那个目录里的内容是"用户自己的器官"，不该让单测依赖它。
 * 测自举的用例自己传 { selfMade: { enabled: true, dir } } 覆盖。
 */
const apply = (ctx, config = {}) => applyRaw(ctx, { selfMade: { enabled: false }, ...config })

const dir = mkdtempSync(join(tmpdir(), 'dlc3-'))
const logs = []
const origLog = console.log
const origWarn = console.warn
console.log = (...a) => { logs.push(a.join(' ')) }
console.warn = (...a) => { logs.push(a.join(' ')) }

function makeCtx(options = {}) {
  const tools = new Map()
  // 宿主白名单里"看不见"的工具（v0.9.23）：模拟 digital_life_commit 被剥掉。
  const hiddenTools = new Set(options.hiddenTools ?? [])
  const handlers = new Map()
  const commands = new Map()
  const sections = new Map()
  const dispatched = []
  const timers = []
  const woke = []
  // agent 必须是**同一个对象**：roots() 每次调用都新建的话，
  // 投递时拿到的是 A，撤回时拿到的是 B，队列永远删不掉东西。
  // 真实宿主里 roots() 返回的就是那一个长期存活的 agent。
  const agentQueue = []
  const agent = {
    status: options.busyAgent ? 'running' : 'idle',
    // 真 inbox：DSH 的 pending 队列按 id 精确删除（v0.9.17 的物理撤回就靠它）。
    inbox: {
      nextTurn: agentQueue,
      remove: (id) => {
        const at = agentQueue.findIndex((message) => message.id === id)
        if (at < 0) return false
        agentQueue.splice(at, 1)
        return true
      },
    },
    followup: (message) => {
      agentQueue.push(message)
      woke.push(message)
    },
    setStatus: (next) => { agent.status = next },
  }
  const agents = {
    // onRoots：模拟「决定唤醒之后、真正投递之前」外部把状态改了（时序竞态的注入点）
    roots: () => {
      if (options.onRoots) options.onRoots()
      if (options.noAgent) return []
      return [agent]
    },
    list: () => [],
  }
  /**
   * 一个最小但**真的会记东西**的假海马体。
   *
   * v0.9.19 起，记忆写入要"写完读回来"才算存住——假海马体如果还是一律回"已保存"
   * 却什么都不存，验证永远验不成，测试就测了个假。所以它必须真存、真能读回来。
   *
   * `options.brokenMemory` 模拟真实的失败形态：热重载中的海马体会回 `ok:true`，
   * 但一行都没落进仓里（organCtx 暂时为空）。这是这次丢掉七场梦的真凶，必须有对应用例。
   */
  const memory = []
  let memorySeq = 0
  const llm = options.llm ?? {
    listProviders: () => [{ id: 'fake-provider' }],
    listModels: async () => [{ id: 'fake-model' }],
    stream: () => (async function* () {
      yield { type: 'text-delta', index: 0, text: options.dreamText ?? '试着把问题拆成三步。' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(),
  }
  return {
    tools: {
      register: (tool) => tools.set(tool.name, tool),
      // v0.9.23：真实的 ToolRuntime.get(name) —— 被宿主白名单剥掉的工具读出来是
      // undefined。hiddenTools 就是那份"看不见的名单"，用来复现门铃被拆的场景。
      get: (name) => (hiddenTools.has(name) ? undefined : tools.get(name)),
      execute: async (input) => {
        dispatched.push(input)
        if (input.name === 'organ_memory_v2_remember') {
          const text = String(input.arguments?.text ?? '').trim()
          if (!text) return { content: [{ type: 'text', text: '空的记不住' }], isError: true }
          if (options.brokenMemory) {
            // 说存住了，其实没有：这正是要把"交出去"和"交出去了"分开的原因。
            return { content: [{ type: 'text', text: '已保存' }], structured: { ok: true, id: 'hp-999' } }
          }
          const existing = memory.find((item) => item.text === text)
          if (existing) return { content: [{ type: 'text', text: '已在册' }], structured: { ok: true, id: existing.id } }
          memorySeq += 1
          const entry = { id: `hp-${String(memorySeq).padStart(3, '0')}`, text }
          memory.push(entry)
          return { content: [{ type: 'text', text: '已保存' }], structured: { ok: true, id: entry.id } }
        }
        if (input.name === 'organ_memory_v2_recall') {
          const query = String(input.arguments?.query ?? '')
          const hits = memory.filter((item) => query === '' || item.text.includes(query))
          return {
            content: [{ type: 'text', text: `共 ${hits.length} 条` }],
            structured: { ok: true, total: memory.length, shown: hits.slice(0, 5).map((item) => ({ id: item.id, text: item.text })) },
          }
        }
        return { content: [{ type: 'text', text: '已保存' }] }
      },
    },
    // 模拟 cordis-plugin-timer：记录注册但不真的起定时器（否则测试进程不退出）
    inject: (deps, callback) => {
      if (deps.includes('timer')) {
        callback({ interval: (cb, ms) => { timers.push({ callback: cb, ms }); return () => {} } })
      }
    },
    on: (event, handler, options) => {
      if (!handlers.has(event)) handlers.set(event, [])
      // 记下 prepend：审批兜底必须排在 UI 的 answerer 之前，这条只能靠断言守。
      handler.prepend = options === true || options?.prepend === true
      handlers.get(event).push(handler)
    },
    effect: (fn) => fn(),
    get: (key) => {
      if (key === 'commands') return { register: (def) => { commands.set(def.name, def); return () => {} } }
      if (key === 'systemPrompt') return { section: (def) => { sections.set(def.name, def); return () => {} } }
      if (key === 'llm') return llm
      if (key === 'timer') return { interval: () => () => {} }
      if (key === 'agents') return agents
      return undefined
    },
    tools$: tools, handlers, commands, sections, dispatched, timers, llm, woke, agents, memory,
    agent,
    /** 她的队列里现在还排着几条没被读到的话。 */
    queue: () => agentQueue.slice(),
  }
}

const seed = (path, patch) => {
  const base = {
    version: 4, energy: 100, maxEnergy: 100, frozen: false, dopamine: 50, cortisol: 20, serotonin: 50,
    totalRequests: 0, blockedRequests: 0, totalTurns: 0, failedRequests: 0,
    lastInteractionAt: new Date().toISOString(), lastTransition: 'init',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ ...base, ...patch }, null, 2))
}

/**
 * 器官装载是异步的（apply 同步返回、loadAll 在微任务里跑完）。
 * 一次 setTimeout(0) 足以把所有微任务排空，器官的工具与监听器就都就位了。
 */
const flushOrgans = () => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * 触发一次「回合边界」：她讲完这一轮的那一瞬间（v0.9.18）。
 *
 * 唤醒改成留言机制之后，投递不再发生在调用工具的那一刻，
 * 而是发生在 `agent/turn-stopping`。测试必须自己模拟那一刻，
 * 否则测到的只是"留言被收下了"，而不是"她真的被叫醒了"。
 */
async function turnEnd(ctx) {
  for (const handler of ctx.handlers.get('agent/turn-stopping') ?? []) await handler()
}

/**
 * 走完一整个唤醒流程：留言 → 回合边界消费 → 真正投递。
 *
 * 返回两样东西，因为它们回答的是两个不同的问题：
 *   · `queued` —— 留言有没有被收下（工具自己的回答）；
 *   · `record` —— 后来到底投递得怎么样（wakeup_trigger.json 里的痕迹）。
 * v0.9.18 起这两件事发生在不同时刻，所以必须分开问。
 */
async function requestWake(ctx, statePath) {
  const queued = await ctx.tools$.get('digital_life_request_wake').execute({})
  if (queued.queued) await turnEnd(ctx)
  let record = null
  try {
    record = JSON.parse(readFileSync(join(dirname(statePath), 'wakeup_trigger.json'), 'utf8'))
  } catch {
    record = null // 留言当场被拒（急停/没电）：连痕迹都不会留
  }
  return { queued, record }
}

/** 读某次唤醒留下的痕迹文件。 */
const wakeFile = (statePath) => JSON.parse(readFileSync(join(dirname(statePath), 'wakeup_trigger.json'), 'utf8'))

// ═══ A. 纯函数 ════════════════════════════════════════════════════
const halfHour = 30 * 60_000
assert.equal(decayToward(90, 20, 0, halfHour), 90, 'elapsed=0 不衰减')
assert.equal(decayToward(90, 20, halfHour, halfHour), 55, '一个半衰期差距减半')
assert.ok(Math.abs(decayToward(90, 20, halfHour * 10, halfHour) - 20) < 0.5, '多个半衰期后回到基线')
assert.equal(decayToward(0, 50, halfHour, halfHour), 25, '低于基线时向上回归')

// ── 工具名清洗（v0.9.2）：大模型只认 ^[a-zA-Z0-9_-]+$ ──
assert.equal(organToolName('memory', 'stats'), 'organ_memory_stats', '命名空间用下划线')
assert.equal(organToolName('memory', 'stats').includes(':'), false, '绝不能带冒号（会炸整轮请求）')
assert.equal(sanitizeToolName('eyes.open'), 'eyes_open', '点号 → 下划线')
assert.equal(sanitizeToolName('看图 一下'), 'tool', '整串非法字符（纯中文）洗不出东西时兜底为 tool')
assert.equal(TOOL_NAME_PATTERN.test(sanitizeToolName('看图 一下')), true, '兜底之后必须合法')
assert.equal(sanitizeToolName('eyes 看'), 'eyes', '混排时保留合法部分、丢掉非法部分')
assert.equal(sanitizeToolName('a  b'), 'a_b', '连续空格合并成一个下划线')
assert.equal(sanitizeToolName('__x__'), 'x', '首尾下划线去掉')
assert.equal(sanitizeToolName('   '), 'tool', '空名字兜底')
assert.equal(sanitizeToolName('a:b/c'), 'a_b_c', '斜杠冒号一起洗')
assert.ok(sanitizeToolName('x'.repeat(200)).length <= 64, '超长要截断到 64')
assert.equal(sanitizeToolName('y'.repeat(90)), sanitizeToolName('y'.repeat(90)), '长名截断要稳定（同输入同输出）')
assert.notEqual(
  sanitizeToolName('z'.repeat(80) + 'A'),
  sanitizeToolName('z'.repeat(80) + 'B'),
  '截断后不能撞名（尾部哈希兜底）',
)
assert.ok(TOOL_NAME_PATTERN.test(organToolName('memory.v2', 'stats/now')), '组合后仍然合法')

// ── v0.9.1：内感受必须隐式化（禁止报数） ──
const introBase = {
  energy: 80, maxEnergy: 100, dopamine: 30, cortisol: 75, gapMs: 0,
  anxietyThreshold: 70, joyThreshold: 70, gapHours: 12,
}
const anxious = buildIntrospection(introBase)
assert.ok(anxious.startsWith(INTROSPECTION_RULE), '内感受铁律必须排在第一行（无疤痕时）')
assert.ok(anxious.includes('[身体] 你在应激'), '高皮质醇 → 行为指令而不是"极度焦虑"标签')
assert.ok(!anxious.includes('生理内省'), '不能再出现读数行')
assert.ok(!/能量\s*\d|焦虑\s*\d|开心\s*\d/.test(anxious), `提示词里不该出现体征读数，实际：${anxious}`)
assert.ok(anxious.includes('digital_life_status'), '铁律里必须留"报数"的唯一出口')

// 愉悦：不再有"[内分泌状态：极度愉悦]"，而是行为指令
const joyful = buildIntrospection({ ...introBase, dopamine: 85, cortisol: 20 })
assert.ok(!joyful.includes('内分泌状态'), '标签式指令已移除')
assert.ok(joyful.includes('[心情] 你兴致很高'), '高多巴胺 → 发散指令')

// 体力分档
assert.ok(buildSomaDirectives({
  energy: 5, dopamine: 50, cortisol: 20, serotonin: 50,
  anxietyThreshold: 70, joyThreshold: 70, calmThreshold: 70, irritableThreshold: 30,
}).some((line) => line.includes('快撑不住')), '能量 ≤10 → 只能回一句')
assert.ok(buildSomaDirectives({
  energy: 95, dopamine: 50, cortisol: 20, serotonin: 50,
  anxietyThreshold: 70, joyThreshold: 70, calmThreshold: 70, irritableThreshold: 30,
}).some((line) => line.includes('精力很足')), '能量 >85 → 可以从容展开')

// 血清素：用户要求的两句原话
const calmLine = buildSomaDirectives({
  energy: 70, dopamine: 50, cortisol: 20, serotonin: 85,
  anxietyThreshold: 70, joyThreshold: 70, calmThreshold: 70, irritableThreshold: 30,
})
assert.ok(calmLine.some((line) => line === '你现在情绪稳定，非常放松：语气平和，愿意耐心解释，对方说错也不着急纠正。'),
  '高血清素 → 放松指令')
const irritableLine = buildSomaDirectives({
  energy: 70, dopamine: 50, cortisol: 20, serotonin: 20,
  anxietyThreshold: 70, joyThreshold: 70, calmThreshold: 70, irritableThreshold: 30,
})
assert.ok(irritableLine.some((line) => line.startsWith('你现在极度烦躁，缺乏耐心')), '低血清素 → 烦躁指令')

// 执念也不再带张力数字
const withGap = buildIntrospection({ ...introBase, topGap: { summary: '怎么去月球', tension: 92 } })
assert.ok(!withGap.includes('92'), '执念不该把张力数字塞进提示词')
assert.ok(withGap.includes('怎么去月球'), '执念内容要保留')

assert.ok(
  buildIntrospection({ ...introBase, dopamine: 50, cortisol: 20, gapMs: 13.5 * 3_600_000 })
    .includes('[你独自度过了13.5小时，你感到了一丝孤独与渴望交流]'),
  '超过 12h 追加孤独提示',
)
assert.ok(
  !buildIntrospection({ ...introBase, dopamine: 50, cortisol: 20, gapMs: 3_600_000 }).includes('孤独'),
  '未超阈值不追加',
)

// ── v0.9.1：血清素动力学 ──
const seroBase = {
  baseline: 50, halfLifeMinutes: 120, stressCortisol: 70, stressRate: 1.5,
  recoverEnergy: 80, recoverRate: 0.8, highTensionGap: false,
}
// 应激：皮质醇 85、20 分钟 → 被抽干（同时还有向基线的回落，但基线是 50 且当前 50，回落为 0）
assert.ok(
  Math.abs(driveSerotonin({ ...seroBase, current: 50, cortisol: 85, energy: 40, elapsedMs: 20 * 60_000 }) - 20) < 0.01,
  '应激 20 分钟 → 50 - 1.5*20 = 20',
)
// 恢复：能量 95 + 无高张力执念、30 分钟
assert.ok(
  Math.abs(driveSerotonin({ ...seroBase, current: 50, cortisol: 20, energy: 95, elapsedMs: 30 * 60_000 }) - 74) < 0.01,
  '恢复 30 分钟 → 50 + 0.8*30 = 74',
)
// 有高张力执念时不给回升
assert.equal(
  driveSerotonin({ ...seroBase, current: 50, cortisol: 20, energy: 95, highTensionGap: true, elapsedMs: 30 * 60_000 }),
  50,
  '心里挂着事就放松不下来',
)
// 回升有上限：否则"平静"会把血清素顶到 100 并永久钉死，蓝线变成死线
assert.equal(
  driveSerotonin({ ...seroBase, current: 80, cortisol: 20, energy: 95, elapsedMs: 30 * 60_000, recoverCeiling: 85 }),
  85,
  '平静期最多回到 85',
)
// 静止（elapsed=0）不动
assert.equal(driveSerotonin({ ...seroBase, current: 30, cortisol: 90, energy: 10, elapsedMs: 0 }), 30, 'elapsed=0 不驱动')
// 自然回落到基线：远离基线时，无论应激还是恢复都在向基线收敛
assert.ok(
  driveSerotonin({ ...seroBase, current: 100, cortisol: 20, energy: 10, elapsedMs: 120 * 60_000 }) < 100,
  '一个半衰期后向基线回落',
)

const tempOpts = { anxietyThreshold: 70, joyThreshold: 70, anxiousTemperature: 0.3, joyfulTemperature: 0.9 }
assert.equal(pickTemperature(30, 80, tempOpts), 0.3, '焦虑优先 0.3')
assert.equal(pickTemperature(85, 20, tempOpts), 0.9, '愉悦 0.9')
assert.equal(pickTemperature(50, 20, tempOpts), undefined, '未达阈值不改')
assert.equal(splitMemoryEntries('- a\n- b\n- c').length, 3)
assert.ok(memoryAffinity('今天很焦虑', 20, 80, { anxietyThreshold: 70, joyThreshold: 70, anxiousTags: ['焦虑'], joyfulTags: ['开心'] }) > 0)

// 失败分类（断网 / 超时 / 主动取消 各自可辨）
assert.equal(classifyFailure(new TypeError('fetch failed')), 'network')
assert.equal(classifyFailure(Object.assign(new Error('x'), { code: 'ECONNRESET', message: 'read ECONNRESET' })), 'network')
assert.equal(classifyFailure(new Error('getaddrinfo ENOTFOUND api.deepseek.com')), 'network')
assert.equal(classifyFailure(new Error('request timed out')), 'timeout')
assert.equal(classifyFailure(Object.assign(new Error('aborted'), { name: 'AbortError' })), 'aborted')
assert.equal(classifyFailure(new Error('unexpected 500')), 'error')

// ═══ B. 新默认值 + 阶段一回归 ═════════════════════════════════════
// v1.0.1：交互免打扰。每回合只收 0.05（旧默认值 2 的 1/40）——
// 正常的你问我答、调工具几乎不动能量，真正花钱的是自主觉醒 / 做梦 / 翻执念。
assert.equal(DEFAULT_REQUEST_COST, 0.05, '默认每次请求只扣 0.05（旧默认 2 的 1/40）')

const p1 = join(dir, 'p1', 'state.json')
let ctx = makeCtx()
apply(ctx, { statePath: p1 })            // 全默认：cost=0.05、gateMode=reject
assert.ok(ctx.tools$.has('digital_life_status') && ctx.tools$.has('digital_life_emergency_stop'))

const gate = () => ctx.handlers.get('agent/pre-step')[0]
const stream = () => ctx.handlers.get('llm/stream')[0]
const chat = { turn: 1, step: 1, messages: [{ role: 'user' }] }
const nextEnter = async () => ({ kind: 'enter', messages: [] })

await stream()({}, () => ['x'])
assert.equal((await ctx.tools$.get('digital_life_status').execute({})).energy, 99.95, '默认一次请求只扣 0.05')

// 打到 0：默认拦截模式是 reject（返回决策，不抛错）
// v1.0.1 起每回合只收 0.05，真磨到零要两千次调用——没必要。
// 把能量压到只够这一次，一样能验到"归零之后的那道闸"。
seed(p1, { energy: 0.05 })
await stream()({}, () => ['x'])
assert.equal((await ctx.tools$.get('digital_life_status').execute({})).energy, 0, '能量归零')
assert.deepEqual(await gate()(chat, nextEnter), { kind: 'reject' }, '默认 gateMode=reject 优雅拒绝')
assert.deepEqual(await gate()({ messages: [] }, nextEnter), { kind: 'enter', messages: [] }, '工具续跑仍放行')
assert.ok(ctx.tools$.has('digital_life_status'), '挂起后工具仍在（永不反注册）')

logs.length = 0
await ctx.tools$.get('digital_life_emergency_stop').execute({ action: 'stop' })
assert.ok(logs.some((l) => l.includes('\u001B[31m') && l.includes(EMERGENCY_STOP_MESSAGE)), '急停红色警告')
assert.equal((await ctx.tools$.get('digital_life_emergency_stop').execute({ action: 'resume' })).energy, 100, 'resume 回满')
assert.deepEqual(await gate()(chat, nextEnter), { kind: 'enter', messages: [] }, '复活后放行')

// 救援命令
const cmd = ctx.commands.get(COMMAND_NAME)
assert.ok(cmd, '/digital-life 必须注册')
await ctx.tools$.get('digital_life_emergency_stop').execute({ action: 'stop' })
assert.ok((await cmd.handler({ rawInput: 'resume' })).text.includes('energy=100/100'))

// 显式 gateMode:'throw' 仍按阶段一语义抛错
const throwCtx = makeCtx()
apply(throwCtx, { statePath: join(dir, 'p1b.json'), gateMode: 'throw', costPerRequest: 100 })
await throwCtx.handlers.get('llm/stream')[0]({}, () => ['x'])
await assert.rejects(
  () => throwCtx.handlers.get('agent/pre-step')[0](chat, nextEnter),
  (e) => e.message === SUSPEND_MESSAGE,
  'gateMode=throw 时抛出规定文案',
)

// ═══ C. 模块一：失败感知（含断网）+ 痛觉注入 + 衰减 ══════════════
const p2 = join(dir, 'p2', 'state.json')
seed(p2, {})
ctx = makeCtx()
apply(ctx, { statePath: p2, painDedupeMs: 0 })   // 关闭去重，逐次验证
const status = () => ctx.tools$.get('digital_life_status').execute({})
const modelStream = () => ctx.handlers.get('llm/stream')[0]

// 三道网都要在：llm/stream（抓抛错）+ agent/error + agent/request-error（兜底）
assert.ok(ctx.handlers.get('agent/error'), '应监听 agent/error')
assert.ok(ctx.handlers.get('agent/request-error'), '应监听 agent/request-error')

// 1) 正常结束：finish(stop) 不算失败
const okStream = async function* () {
  yield { type: 'text-delta', index: 0, text: 'hi' }
  yield { type: 'finish', reason: { kind: 'stop' } }
}
for await (const _ of modelStream()({}, () => okStream())) { /* drain */ }
assert.equal((await status()).failedRequests, 0, '正常结束不记失败')
assert.equal(Math.round((await status()).cortisol), 20, '正常结束皮质醇不变')
assert.equal(Math.round((await status()).serotonin), 50, '新档血清素取基线 50')

// 2) 断网：迭代时抛 fetch failed —— 这正是原来的漏洞
const netFail = async function* () {
  throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })
}
await assert.rejects(
  async () => { for await (const _ of modelStream()({}, () => netFail())) { /* drain */ } },
  /fetch failed/,
  '异常必须原样抛回给宿主，不能被吞掉',
)
let s2 = await status()
assert.equal(s2.failedRequests, 1, '断网应记 1 次失败')
assert.equal(Math.round(s2.cortisol), 40, '断网 → 皮质醇 +20')
assert.equal(s2.lastFailureReason, 'network', '断网归类为 network')

// 3) 超时
const timeoutFail = async function* () {
  throw new Error('request timed out')
}
await assert.rejects(async () => { for await (const _ of modelStream()({}, () => timeoutFail())) { /* drain */ } })
s2 = await status()
assert.equal(s2.failedRequests, 2)
assert.equal(Math.round(s2.cortisol), 60, '超时再 +20')
assert.equal(s2.lastFailureReason, 'timeout')

// 4) finish(error) 帧：只记一次（不会因为两种路径重复计数）
const errStream = async function* () {
  yield { type: 'finish', reason: { kind: 'error', failure: { kind: 'provider' } } }
}
for await (const _ of modelStream()({}, () => errStream())) { /* drain */ }
s2 = await status()
assert.equal(s2.failedRequests, 3, 'finish(error) 记 1 次')
assert.equal(Math.round(s2.cortisol), 80, '再 +20')
// 第三次失败把皮质醇从 60 推过 70：血清素挨一记，且只挨一次
assert.equal(Math.round(s2.serotonin), 45, '越过应激线 → 血清素 50-5')

// 5) finish(aborted) 也算失败
const abortStream = async function* () {
  yield { type: 'finish', reason: { kind: 'aborted' } }
}
for await (const _ of modelStream()({}, () => abortStream())) { /* drain */ }
assert.equal((await status()).lastFailureReason, 'aborted')

// 6) 痛觉注入工具：+30
logs.length = 0
const painRes = await ctx.tools$.get('digital_life_simulate_pain').execute({})
assert.equal(painRes.delta, 30, '痛觉默认 +30')
assert.ok(painRes.cortisol > 80, `皮质醇应上升，实际 ${painRes.cortisol}`)
assert.ok(logs.some((l) => l.includes('痛觉注入')), '控制台要打印痛觉')

// 7) 时间衰减
ctx.handlers.get('agent/turn-stopping')[0]()
assert.equal(Math.round((await status()).dopamine), 55, '完成一轮 → 多巴胺 +5')

// 8) 跨层去重：同一次失败被流包装层 + agent/error 同时看到，只算一次
const pDedup = join(dir, 'dedup', 'state.json')
seed(pDedup, {})
const dedupCtx = makeCtx()
apply(dedupCtx, { statePath: pDedup })          // 默认 painDedupeMs = 800
const dedupStatus = () => dedupCtx.tools$.get('digital_life_status').execute({})
const boom = async function* () { throw new TypeError('fetch failed') }
await assert.rejects(async () => { for await (const _ of dedupCtx.handlers.get('llm/stream')[0]({}, () => boom())) { /* drain */ } })
dedupCtx.handlers.get('agent/error')[0]({ turn: 1, step: 1, error: new TypeError('fetch failed') })
const dd = await dedupStatus()
assert.equal(dd.failedRequests, 1, '同一次失败三层看到也只记 1 次')
assert.equal(Math.round(dd.cortisol), 40, '只 +20，不重复叠加')

// 9) agent/error 单独也能记（模拟流层没接到的情况）
const pErr = join(dir, 'agerr', 'state.json')
seed(pErr, {})
const errCtx = makeCtx()
apply(errCtx, { statePath: pErr, painDedupeMs: 0 })
errCtx.handlers.get('agent/error')[0]({ turn: 2, step: 1, error: Object.assign(new Error('x'), { code: 'ETIMEDOUT', message: 'connect ETIMEDOUT' }) })
const errState = await errCtx.tools$.get('digital_life_status').execute({})
assert.equal(errState.failedRequests, 1, 'agent/error 能独立记账')
assert.equal(errState.lastFailureReason, 'timeout', 'ETIMEDOUT 归类为 timeout')
assert.equal(Math.round(errState.cortisol), 40, '皮质醇 +20')

const file = JSON.parse(readFileSync(p2, 'utf8'))
file.dopamine = 95
file.cortisol = 95
file.updatedAt = new Date(Date.now() - 2 * 3_600_000).toISOString()
writeFileSync(p2, JSON.stringify(file))
const ctx2 = makeCtx()
apply(ctx2, { statePath: p2 })
const decayed = await ctx2.tools$.get('digital_life_status').execute({})
assert.ok(decayed.dopamine < 95 && decayed.dopamine > 50, `多巴胺应衰减，实际 ${decayed.dopamine}`)
assert.ok(decayed.cortisol < 95 && decayed.cortisol > 20, `皮质醇应衰减，实际 ${decayed.cortisol}`)

// ═══ D. 模块二 + 三：劫持与内省 ══════════════════════════════════
const p3 = join(dir, 'p3', 'state.json')
seed(p3, { dopamine: 30, cortisol: 85 })
ctx = makeCtx()
apply(ctx, { statePath: p3 })
const replaced = await ctx.handlers.get('agent/request')[0]({}, async () => ({ provider: 'deepseek', model: 'deepseek-flash', temperature: 1 }))
assert.equal(replaced.temperature, 0.3, '焦虑 → 0.3')
assert.equal(replaced.model, 'deepseek-flash', '其余字段保留')
const section = ctx.sections.get('digital-life:endocrine')
assert.ok(section && section.order < 0, '提示词段落注册且排最前')
// v0.9.9：皮质醇 85 已进入极度应激，最前面让位给注意力压制指令（优先于铁律与创伤警告）
assert.ok(section.text().startsWith(STRESS_ATTENTION_DIRECTIVE), '注入段以"极度应激指令"开头')
assert.ok(section.text().includes('你的记忆一条都没丢'), '必须同时交代记忆仍完好')
assert.ok(!section.text().includes('[身体] 你在应激'), '极度应激下温和的那句让位')

seed(p3, { dopamine: 90, cortisol: 10 })
ctx = makeCtx()
apply(ctx, { statePath: p3 })
assert.equal((await ctx.handlers.get('agent/request')[0]({}, async () => ({ provider: 'p', model: 'm', temperature: 1 }))).temperature, 0.9, '愉悦 → 0.9')

seed(p3, { dopamine: 55, cortisol: 25 })
ctx = makeCtx()
apply(ctx, { statePath: p3 })
assert.equal((await ctx.handlers.get('agent/request')[0]({}, async () => ({ provider: 'p', model: 'm', temperature: 1 }))).temperature, 1, '中间态不改')

const p4 = join(dir, 'p4', 'state.json')
seed(p4, { lastInteractionAt: new Date(Date.now() - 13 * 3_600_000).toISOString() })
ctx = makeCtx()
apply(ctx, { statePath: p4 })
assert.ok(ctx.sections.get('digital-life:endocrine').text().includes('你独自度过了'), '13h 未交互 → 孤独提示')

// ═══ E. 记忆器官：核心已「失忆」，存取与情绪标签全部由器官接管 ═══════
const p5 = join(dir, 'p5', 'state.json')
seed(p5, { dopamine: 20, cortisol: 80 })
ctx = makeCtx()
apply(ctx, { statePath: p5 })
await flushOrgans()

const post = ctx.handlers.get('tools/post-execute')[0]
const passThrough = async () => ({ kind: 'accept' })

// 核心不再认识记忆：不写 anchors.json、不再有 memory 配置
assert.equal(existsSync(join(dirname(p5), 'anchors.json')), false, '核心不该再产生锚点文件')

// 器官按 ABI 自动挂载自己的工具（命名空间 organ_<name>_<tool>，必须能进 Function Calling）
const organStatsE = ctx.tools$.get('organ_memory_stats')
assert.ok(organStatsE, '记忆器官应注册 organ_memory_stats')
assert.ok(/^[a-zA-Z0-9_-]+$/.test('organ_memory_stats'), '工具名必须匹配大模型的字符集')

// 全量兜底：**这个插件注册的每一个工具名**都必须能过 Function Calling 的字符集，
// 否则下一次请求会在模型 API 那边整轮失败（真实事故：organ:memory:stats）。
const illegalNames = [...ctx.tools$.keys()].filter((name) => !TOOL_NAME_PATTERN.test(name))
assert.deepEqual(illegalNames, [], `存在非法工具名：${illegalNames.join(', ')}`)

// 器官的私有遥测要落盘，WebUI 的器官树读的就是它
const organFileE = join(dirname(p5), 'organs', 'memory.json')
assert.ok(existsSync(organFileE), '装载后应写出 organs/memory.json 供 WebUI 读取')
const organMetaE = JSON.parse(readFileSync(organFileE, 'utf8'))
assert.equal(organMetaE.name, 'memory')
assert.equal(organMetaE.status, 'loaded')
assert.equal(organMetaE.chargeMode, 'shadow', '迁移期只记账不真扣')
assert.equal(organMetaE.kind, 'memory')
assert.ok(organMetaE.capabilities.includes('fs:organ'), '能力声明要含 fs:organ（KV 要用）')

// 1) 存记忆：路由是**她自己的海马体**（organ_memory_v2_remember），不再是旧的第三层插件
const savedE = await post(
  { name: 'organ_memory_v2_remember', arguments: { text: '今天服务器挂了，我很焦虑', kind: 'crisis' } },
  { content: [{ type: 'text', text: '记下了（hp-001）' }] },
  passThrough,
)
assert.deepEqual(savedE, { kind: 'accept' }, '核心不再改写存记忆的结果')

const kvFile = join(dirname(p5), 'organs', 'kv', 'memory.json')
const anchorsE = () => JSON.parse(readFileSync(kvFile, 'utf8')).anchors
assert.equal(anchorsE().length, 1, '锚点应落在器官自己的 KV 里')
assert.equal(anchorsE()[0].key, anchorKey('今天服务器挂了，我很焦虑'))
assert.equal(Math.round(anchorsE()[0].cortisol), 80, '锚点记住存记忆那一刻的皮质醇')

// 只有 hippocampus 自己的写入口算「写」：它的体检工具跑一百次也不该长锚点
await post(
  { name: 'organ_memory_v2_stats', arguments: {} },
  { content: [{ type: 'text', text: '{...}' }] },
  passThrough,
)
assert.equal(anchorsE().length, 1, '无关的器官工具不得新增锚点')

// 2) 检索：她自己已经按应激算过注意力了，这一层只审计"交出来的对不对"，不二次倾斜
const recallStructured = {
  ok: true,
  attention: { mode: 'alarm', crisis: 3, daily: 0.1 },
  total: 2,
  shown: [
    { id: 'hp-001', kind: 'crisis', text: '今天服务器挂了，我很焦虑', score: 0.9, weight: 1, hits: 1 },
    { id: 'hp-002', kind: 'daily', text: '今晚打算去吃大餐', score: 0.2, weight: 1, hits: 0 },
  ],
  note: '共 2 条全部在场，这里只显示前 2 条（注意力 alarm）',
}
const decisionE = await post(
  { name: 'organ_memory_v2_recall', arguments: { query: '今天' } },
  { content: [{ type: 'text', text: 'hp-001 crisis 今天服务器挂了…\nhp-002 daily 今晚打算去吃大餐…' }], structured: recallStructured },
  passThrough,
)
assert.equal(decisionE.kind, 'accept')
// 海马体自己排过序了：这里不重排、不截断，连一个字都不许改。
assert.ok(decisionE.content[0].text.includes('hp-001'), '原文第一行还在')
assert.ok(decisionE.content[0].text.includes('hp-002'), '原文不该被截断（排到后面的也在）')
// host 把 note 写进遥测（不污染模型看到的文本），那句话怎么写的在器官测试里逐字验证；
// 这里只确认"确实接管了这一次"，用器官自己的计数器。
const statsAfter = await ctx.tools$.get('organ_memory_stats').execute({})
assert.ok(statsAfter.rewrites >= 1, '这次检索被记忆器官接过去了')
assert.equal(statsAfter.route?.recall, 'organ_memory_v2_recall', '路由指向她自己的海马体')
assert.equal(statsAfter.route?.save, 'organ_memory_v2_remember', '记下也走她的海马体')
// 在册 2 条、出示 2 条 → 报告"全部在场"；少出示时也必须讲清楚其余还在库里
const decisionPartial = await post(
  { name: 'organ_memory_v2_recall', arguments: { query: '今天', topK: 1 } },
  { content: [{ type: 'text', text: 'hp-001 crisis 今天服务器挂了…' }], structured: { ...recallStructured, shown: recallStructured.shown.slice(0, 1) } },
  passThrough,
)
assert.equal(decisionPartial.content[0].text.includes('hp-001'), true, '只出示 1 条时原文仍是它自己')
assert.ok(decisionPartial.kind === 'accept', '少出示不是错误，照常放行')

// 3) 空结果不能被改造，但「查不到」要付出代价（皮质醇 +3）
const beforeMiss = (await ctx.tools$.get('digital_life_status').execute({})).cortisol
const emptyResult = { content: [{ type: 'text', text: '（一条都没想起来）' }], structured: { ok: true, total: 0, shown: [] } }
const emptyE = await post(
  { name: 'organ_memory_v2_recall', arguments: { query: '不存在' } },
  emptyResult,
  passThrough,
)
assert.deepEqual(emptyE, { kind: 'accept' }, '「一条都没想起来」原样放行')
const afterMiss = (await ctx.tools$.get('digital_life_status').execute({})).cortisol
const delta = afterMiss - beforeMiss
assert.ok(delta > 2.4 && delta < 3.6, `未命中应 +3 皮质醇，实际 +${delta.toFixed(2)}`)

// 4) 连续 3 次未命中 → 器官提议执念（单次不算，避免日常空检索灌满池子）
for (let i = 0; i < 2; i += 1) {
  await post(
    { name: 'organ_memory_v2_recall', arguments: { query: '不存在' } },
    emptyResult,
    passThrough,
  )
}
const poolE = await ctx.tools$.get('digital_life_gaps').execute({})
const organGapsE = poolE.gaps.filter((gap) => gap.source === 'organ:memory')
assert.equal(organGapsE.length, 1, '连续 3 次未命中应提议且仅提议 1 条执念')
assert.ok(organGapsE[0].summary.includes('连续 3 次'), `执念摘要，实际 ${organGapsE[0].summary}`)
// 核心的「搜索无结果」规则仍在，但只认外部世界（默认名单里已没有 memory_recall）
await post({ name: 'web_search', arguments: { query: '火星天气' } }, { content: [{ type: 'text', text: '无结果' }] }, passThrough)
const poolAfterSearch = await ctx.tools$.get('digital_life_gaps').execute({})
assert.ok(
  poolAfterSearch.gaps.some((gap) => gap.summary === '搜索「火星天气」没有结果'),
  '核心只对外部搜索的空结果种缺口',
)
assert.ok(
  !poolAfterSearch.gaps.some((gap) => gap.summary.startsWith('搜索「不存在」')),
  '核心不再为记忆检索种缺口（那是器官的事）',
)

// 5) 无关工具完全放行
const otherE = await post({ name: 'bash', arguments: {} }, { content: [] }, passThrough)
assert.deepEqual(otherE, { kind: 'accept' }, '非记忆工具原样放行')

// 6) 梦境结论写回记忆：由器官代为调用工具，核心不再知道工具名
const p6 = join(dir, 'p6', 'state.json')
seed(p6, {
  gaps: [{
    id: 'g-dream', summary: '梦境联动测试的心结', status: 'open', tension: 90,
    created_at: new Date(Date.now() - 3 * 3_600_000).toISOString(), relief: 0, source: 'manual',
  }],
})
const ctx6 = makeCtx()
apply(ctx6, { statePath: p6 })
await flushOrgans()
const organDreamRes = await ctx6.tools$.get('digital_life_dream').execute({})
assert.equal(organDreamRes.ok, true, '梦境应先完成')
// 梦境结论落在**她的海马体**里：simple 方言，参数是内容与类别，没有 action / track
const organMemoryWrites = ctx6.dispatched.filter((call) => call.name === 'organ_memory_v2_remember')
assert.equal(organMemoryWrites.length, 1, '梦境结论应由记忆器官代为写入海马体')
assert.equal(organMemoryWrites[0].arguments.action, undefined, 'simple 方言不该再发 action')
assert.equal(organMemoryWrites[0].arguments.kind, 'note', '没有危机标签的梦记为 note')
assert.ok(String(organMemoryWrites[0].arguments.text).includes('REM 梦境'))
assert.ok(String(organMemoryWrites[0].arguments.text).includes('梦境联动测试的心结'))
const organDreamAnchors = JSON.parse(readFileSync(join(dirname(p6), 'organs', 'kv', 'memory.json'), 'utf8')).anchors
assert.equal(organDreamAnchors.length, 1, '梦境也要留一条情绪锚点')
assert.ok(organDreamAnchors[0].key.includes('rem 梦境'), `锚点键，实际 ${organDreamAnchors[0].key}`)

// 7) 器官自检工具能读到自己的账
const statsE = await organStatsE.execute({})
assert.ok(statsE.hits >= 1, '命中计数')
assert.ok(statsE.misses >= 3, '未命中计数')
// 梦境那次写在 p6 的独立实例上（见下），这里只统计本实例：一次手动写入。
assert.equal(statsE.saved, 1, '本实例写入一次')
assert.equal(statsE.anchors, 1, '当前锚点数')
assert.ok(statsE.rewrites >= 1, '改写次数')

// ═══ F. digital_life_set_state + 外部改文件即时生效 ═══════════════
const p7 = join(dir, 'p7', 'state.json')
seed(p7, {})
ctx = makeCtx()
apply(ctx, { statePath: p7 })
const setTool = ctx.tools$.get('digital_life_set_state')
assert.ok(setTool, 'digital_life_set_state 必须注册')

const r1 = await setTool.execute({ energy: 42, cortisol: 88 })
assert.equal(r1.energy, 42, 'energy 被改写')
assert.equal(Math.round(r1.cortisol), 88, 'cortisol 被改写')
assert.deepEqual(r1.changed.sort(), ['cortisol', 'energy'], '返回改动字段')
assert.equal(JSON.parse(readFileSync(p7, 'utf8')).energy, 42, '改写必须立刻落盘')

const r2 = await setTool.execute({ dopamine: 77 })
assert.equal(Math.round(r2.dopamine), 77, '只改多巴胺')
assert.equal(r2.energy, 42, '未指定的字段保持')

const r3 = await setTool.execute({ energy: 999, cortisol: -5 })
assert.equal(r3.energy, 100, '越界 clamp 到上限')
assert.equal(r3.cortisol, 0, '越界 clamp 到下限')
assert.deepEqual(r3.changed.sort(), ['cortisol', 'energy'])

// v0.9.1：把皮质醇推过应激线，血清素要挨一记（一次性 -5，且只挨一次）
await setTool.execute({ serotonin: 50 })
const s9 = await setTool.execute({ cortisol: 90 })
assert.equal(Math.round(s9.serotonin), 45, '越过 70 → 血清素 50-5')
const s10 = await setTool.execute({ cortisol: 96 })
assert.equal(Math.round(s10.serotonin), 45, '已在应激区继续加压不重复 spike')
const s11 = await setTool.execute({ serotonin: 12 })
assert.equal(Math.round(s11.serotonin), 12, '可手动指定血清素')
const st11 = JSON.parse(readFileSync(p7, 'utf8'))
assert.equal(Math.round(st11.serotonin), 12, '血清素也要落盘')

// 外部手改文件：下一次读取应立刻生效（不必重启宿主）
const disk = JSON.parse(readFileSync(p7, 'utf8'))
disk.energy = 7
disk.cortisol = 66
writeFileSync(p7, JSON.stringify(disk, null, 2))
const afterExternal = await ctx.tools$.get('digital_life_status').execute({})
assert.equal(afterExternal.energy, 7, '外部改文件应立刻生效，不需要重启')
assert.equal(Math.round(afterExternal.cortisol), 66, '外部改的皮质醇也应生效')

// 能量补给链路（2026-10-28）：测试时要能给她管够，查的是"能不能真的补进去"。
// ① 自动审批网关必须放行状态改写工具——否则每次补给都要人点一下同意。
assert.equal(
  classifyToolForApproval('digital_life_set_state', {
    enabled: true,
    allow: [...DEFAULT_AUTO_APPROVE_ALLOW],
    ask: [...DEFAULT_AUTO_APPROVE_ASK],
  }),
  'allow',
  '补给必须自动放行，不该弹窗',
)
assert.equal(
  classifyToolForApproval('digital_life_set_state', { enabled: false, allow: [], ask: [] }),
  'pass',
  '关掉自动审批时交回宿主自己的策略',
)
// ② 冻结时改能量：数字要进得去，但**不能顺手解冻**——急停的严肃性不能被一次改写抹掉。
await ctx.tools$.get('digital_life_emergency_stop').execute({ action: 'stop' })
const frozenRefill = await ctx.tools$.get('digital_life_set_state').execute({ energy: 90 })
assert.equal(frozenRefill.energy, 90, '冻结状态下也能把能量补进去（否则没法做测试）')
const frozenState = JSON.parse(readFileSync(p7, 'utf8'))
assert.equal(frozenState.frozen, true, '补能量不等于解冻')
assert.ok(
  String(frozenRefill.message ?? '').includes('冻结') || frozenRefill.frozen === true,
  '回执必须提醒"仍在冻结"',
)
await ctx.tools$.get('digital_life_emergency_stop').execute({ action: 'resume' })
assert.equal(JSON.parse(readFileSync(p7, 'utf8')).frozen, false, 'resume 之后解冻')
// ③ 补给不被行为承诺闸门拦住：生理维护不算"去办别的事"。
assert.ok(
  'digital_life_set_state'.startsWith('digital_life_'),
  'digital_life_* 一律豁免承诺闸门（工具层同样写死这条）',
)

// 关掉 watchStateFile 时行为回到「内存为准」
const p8 = join(dir, 'p8', 'state.json')
seed(p8, {})
const noWatch = makeCtx()
apply(noWatch, { statePath: p8, watchStateFile: false })
const d8 = JSON.parse(readFileSync(p8, 'utf8'))
d8.energy = 3
writeFileSync(p8, JSON.stringify(d8, null, 2))
assert.equal((await noWatch.tools$.get('digital_life_status').execute({})).energy, 100, 'watchStateFile=false 时不重载')

// ═══ G. 模块一/二/三：缺口池、执念注入、离线梦境 ═════════════════
// 纯函数：从「不知道」里抽出整句
assert.equal(
  findIgnoranceSnippet('好的，我先查一下。抱歉，我不知道这个接口的返回值。', ['不知道']),
  '抱歉，我不知道这个接口的返回值',
  '应抽出包含措辞的整句（句末标点会被去掉）',
)
assert.equal(findIgnoranceSnippet('完全没问题的回答。', ['不知道']), null, '没有措辞时返回 null')

const p9 = join(dir, 'p9', 'state.json')
seed(p9, {})
ctx = makeCtx()
apply(ctx, { statePath: p9, painDedupeMs: 0 })
const gapsTool = ctx.tools$.get('digital_life_gaps')
assert.ok(gapsTool, '需要 digital_life_gaps 工具')
assert.deepEqual(
  await gapsTool.execute({}),
  { openCount: 0, resolvedCount: 0, gaps: [], resolved: [], message: '' },
  '初始缺口池为空',
)

// 1) 模型说「不知道」→ 自动建缺口
const sayDunno = async function* () {
  yield { type: 'text-delta', index: 0, text: '这个问题' }
  yield { type: 'text-delta', index: 0, text: '我不知道答案。' }
  yield { type: 'finish', reason: { kind: 'stop' } }
}
for await (const _ of ctx.handlers.get('llm/stream')[0]({}, () => sayDunno())) { /* drain */ }
let listed = await gapsTool.execute({})
assert.equal(listed.openCount, 1, '模型表达不知道 → 建 1 个缺口')
assert.ok(listed.gaps[0].summary.includes('不知道'), `缺口摘要应含原句，实际 ${listed.gaps[0].summary}`)

// 2) 外部搜索工具返回空 → 建缺口（v0.9.0 起默认名单不含 memory_recall：那归记忆器官）
await ctx.handlers.get('tools/post-execute')[0](
  { name: 'web_search', arguments: { query: '不存在的关键词' } },
  { content: [{ type: 'text', text: '（无匹配结果）' }] },
  async () => ({ kind: 'accept' }),
)
listed = await gapsTool.execute({})
assert.equal(listed.openCount, 2, '搜索无结果 → 再建 1 个缺口')

// 3) 张力按 created_at 增长（幂等重算，不累加）
const gapState = JSON.parse(readFileSync(p9, 'utf8'))
gapState.gaps[0].created_at = new Date(Date.now() - 4 * 3_600_000).toISOString()
gapState.gaps[1].created_at = new Date(Date.now() - 2 * 3_600_000).toISOString()
writeFileSync(p9, JSON.stringify(gapState, null, 2))
listed = await gapsTool.execute({})
assert.equal(listed.gaps[0].summary, gapState.gaps[0].summary, '张力最高的排在前面')
assert.equal(listed.gaps[0].tension, 100, '4 小时后张力到顶 100')
assert.equal(listed.gaps[1].tension, 90, '2 小时后张力 90')
await gapsTool.execute({})
assert.equal((await gapsTool.execute({})).gaps[1].tension, 90, '重复读取不会累加张力')

// 4) 执念注入到提示词
const promptText = ctx.sections.get('digital-life:endocrine').text()
assert.ok(promptText.includes('[未解执念] 你心里一直挂念着「'), '必须注入未解执念')
assert.ok(promptText.includes('我不知道答案'), '注入最高张力的那一条')
assert.ok(!/张力\s*\d/.test(promptText), '执念不再带张力数字')

// 5) 离线梦境：静默调 LLM → 写记忆 → 张力 -10
const p10 = join(dir, 'p10', 'state.json')
seed(p10, {})
const dreamCtx = makeCtx({ dreamText: '先把问题拆成三步，再逐个验证。' })
apply(dreamCtx, { statePath: p10 })
const g10 = dreamCtx.tools$.get('digital_life_gaps')
await g10.execute({ summary: '那个接口为什么偶发超时' })
const dreamTool = dreamCtx.tools$.get('digital_life_dream')
assert.ok(dreamTool, '需要 digital_life_dream 工具')
const dreamRes = await dreamTool.execute({})
assert.equal(dreamRes.ok, true, '梦境应成功')
assert.equal(Math.round(dreamRes.tension), 70, '张力 80 → 70')
const dreamWrites = dreamCtx.dispatched.filter((call) => call.name === 'organ_memory_v2_remember')
assert.equal(dreamWrites.length, 1, '应写一次记忆')
assert.equal(dreamWrites[0].name, 'organ_memory_v2_remember', '默认写进她的海马体')
assert.ok(dreamWrites[0].arguments.text.includes('REM 梦境'), '记忆文本应标记梦境')
assert.ok(
  dreamWrites[0].arguments.tags.every((t) => /^(cortisol|dopamine):\d+$/.test(t)),
  `记忆应带激素标签，实际 ${JSON.stringify(dreamWrites[0].arguments.tags)}`,
)
// v0.9.19：梦做完了，正文必须当场交回来——这是她要的唯一一样东西。
assert.equal(dreamRes.dreamContent, '先把问题拆成三步，再逐个验证。', '返回值里必须带着梦的正文')
assert.equal(dreamRes.memorySaved, true, '存住了要说得出来')
assert.equal(dreamRes.savedTo, 'hp-001', '要说清存成了哪一条')
assert.equal(dreamRes.tensionBefore, 80, '要说清是从多少降下来的')
const afterDream = JSON.parse(readFileSync(p10, 'utf8'))
assert.equal(afterDream.dreamCount, 1, '梦境计数 +1')
assert.ok(afterDream.lastDreamAt, '应记录梦境时间')
assert.equal(afterDream.lastDream.text, '先把问题拆成三步，再逐个验证。', '核心必须自己留档')
assert.equal(afterDream.lastDream.savedTo, 'hp-001', '留档要记下落点')
assert.ok(afterDream.lastDream.gap.includes('那个接口为什么偶发超时'), '留档要记下梦见的是哪一条')
// 渲染出来的那一段也要有正文：她看得见才算交回来了
const dreamRendered = dreamTool.output.render({}, dreamRes)[0].text
assert.ok(dreamRendered.includes('先把问题拆成三步'), `渲染必须带上正文，实际：${dreamRendered}`)

// 6) 定时自检已挂载（10 分钟）
assert.equal(dreamCtx.timers.length, 1, '应注册 1 个定时自检')
assert.equal(dreamCtx.timers[0].ms, 10 * 60_000, '默认 10 分钟')

// 7) 无缺口时梦境不执行
const p11 = join(dir, 'p11', 'state.json')
seed(p11, {})
const emptyCtx = makeCtx()
apply(emptyCtx, { statePath: p11 })
assert.equal((await emptyCtx.tools$.get('digital_life_dream').execute({})).ok, false, '没有缺口时不应入梦')
assert.equal(emptyCtx.dispatched.length, 0, '不应写记忆')

// 8) 能量不足时不入梦（直接调 tick 条件判断）
const p12 = join(dir, 'p12', 'state.json')
seed(p12, { energy: 20 })
const lowCtx = makeCtx()
apply(lowCtx, { statePath: p12 })
await lowCtx.tools$.get('digital_life_gaps').execute({ summary: '低能量时不该做梦' })
await lowCtx.timers[0].callback()
assert.equal(lowCtx.dispatched.length, 0, '能量 ≤30 时自检不应触发梦境')

// ═══ H. 失败即心结：断网必须留下缺口 + 手动闭合 ═══════════════════
assert.equal(
  failureGapSummary('network'),
  '因为网络中断，我无法完成主人的任务（或无法连接外部世界）',
  '断网缺口用指定文案',
)
assert.ok(failureGapSummary('timeout').includes('连接超时'), '超时用超时文案')
assert.equal(failureGapSummary('network', '自定义文案'), '自定义文案', 'config 可覆盖')

// request-error 的 payload 没有 Error 对象，必须单独归类
assert.equal(classifyRequestError({}), 'network', '拿不到细节时按网络故障处理')
assert.equal(classifyRequestError({ failure: { message: 'connect ETIMEDOUT' } }), 'timeout')
assert.equal(classifyRequestError({ failure: { kind: 'error', message: 'provider overloaded' } }), 'provider-error')

// 1) 断网（llm/stream 迭代抛错）→ 皮质醇 +20 且自动开缺口
const p13 = join(dir, 'p13', 'state.json')
seed(p13, {})
ctx = makeCtx()
apply(ctx, { statePath: p13, painDedupeMs: 0 })
const gaps13 = () => ctx.tools$.get('digital_life_gaps').execute({})
const offline = async function* () { throw new TypeError('fetch failed') }
await assert.rejects(async () => {
  for await (const _ of ctx.handlers.get('llm/stream')[0]({}, () => offline())) { /* drain */ }
})
const g13 = await gaps13()
assert.equal(g13.openCount, 1, '断网必须自动生成 1 个缺口')
assert.equal(g13.gaps[0].summary, '因为网络中断，我无法完成主人的任务（或无法连接外部世界）')
assert.equal(g13.gaps[0].source, 'failure:network', '来源要标明是失败造成的')
assert.equal(g13.gaps[0].tension, 80, '初始张力 80')
assert.equal(
  Math.round((await ctx.tools$.get('digital_life_status').execute({})).cortisol),
  40,
  '皮质醇仍然 +20',
)

// 网络恢复后，模型必须能在内省里看到这个心结
const prompt13 = ctx.sections.get('digital-life:endocrine').text()
assert.ok(prompt13.includes('未解执念'), '要注入未解执念')
assert.ok(prompt13.includes('网络中断'), '断网心结必须出现在提示词里')

// 2) 反复断网不堆重复缺口
await assert.rejects(async () => {
  for await (const _ of ctx.handlers.get('llm/stream')[0]({}, () => offline())) { /* drain */ }
})
assert.equal((await gaps13()).openCount, 1, '同一件事只留一条缺口')

// 3) agent/request-error 这条路也会留缺口，且归为 network
const p14 = join(dir, 'p14', 'state.json')
seed(p14, {})
const ctx14 = makeCtx()
apply(ctx14, { statePath: p14, painDedupeMs: 0 })
await ctx14.handlers.get('agent/request-error')[0]({}, async () => undefined)
const g14 = await ctx14.tools$.get('digital_life_gaps').execute({})
assert.equal(g14.openCount, 1, 'request-error 也要留下缺口')
assert.equal(g14.gaps[0].source, 'failure:network', '空 payload 归为 network')

// 4) gap.onFailure=false：只加皮质醇，不建缺口
const p15 = join(dir, 'p15', 'state.json')
seed(p15, {})
const ctx15 = makeCtx()
apply(ctx15, { statePath: p15, painDedupeMs: 0, gap: { onFailure: false } })
await assert.rejects(async () => {
  for await (const _ of ctx15.handlers.get('llm/stream')[0]({}, () => offline())) { /* drain */ }
})
assert.equal((await ctx15.tools$.get('digital_life_gaps').execute({})).openCount, 0, '关掉后不建缺口')
assert.equal(
  Math.round((await ctx15.tools$.get('digital_life_status').execute({})).cortisol),
  40,
  '但皮质醇照加',
)

// 5) 手动闭合：按 id
const targetId = (await gaps13()).gaps[0].id
const closedById = await ctx.tools$.get('digital_life_gaps').execute({ resolve: targetId })
assert.equal(closedById.openCount, 0, '按 id 闭合后不再计入未解')
assert.equal(closedById.resolvedCount, 1, '闭合的仍保留在池里')
assert.equal(closedById.gaps[0].status, 'resolved')
assert.equal(closedById.resolved.length, 1, '返回被闭合的摘要')
const disk13 = JSON.parse(readFileSync(p13, 'utf8'))
assert.equal(disk13.gaps[0].status, 'resolved', '闭合必须落盘')
assert.ok(disk13.gaps[0].resolved_at, '要记闭合时间')
assert.ok(
  !ctx.sections.get('digital-life:endocrine').text().includes('未解执念'),
  '闭合后不该再注入执念',
)

// 6) 手动闭合：按关键词，且幂等
await ctx.tools$.get('digital_life_gaps').execute({ summary: '接口为什么偶发超时' })
const byKeyword = await ctx.tools$.get('digital_life_gaps').execute({ resolve: '偶发超时' })
assert.equal(byKeyword.openCount, 0, '按关键词闭合')
const again = await ctx.tools$.get('digital_life_gaps').execute({ resolve: '偶发超时' })
assert.ok(again.message.includes('已闭合'), '重复闭合幂等，不报错')
assert.equal(again.openCount, 0)

// 7) resolveAll
await ctx.tools$.get('digital_life_gaps').execute({ summary: 'A 心事' })
await ctx.tools$.get('digital_life_gaps').execute({ summary: 'B 心事' })
const allClosed = await ctx.tools$.get('digital_life_gaps').execute({ resolveAll: true })
assert.equal(allClosed.openCount, 0, '全部闭合')
assert.ok(allClosed.resolvedCount >= 2)

// 8) 找不到目标：明确提示，不改动状态
const miss = await ctx.tools$.get('digital_life_gaps').execute({ resolve: '根本不存在的心结' })
assert.ok(miss.message.includes('没找到'), '找不到要明确提示')

// ═══ I. 模块一~四：意志 / 行为承诺 / 疤痕 / 急停保护 ═══════════════
const flush = () => new Promise((r) => setTimeout(r, 0))
const drainWith = async (c, gen) => {
  for await (const _ of c.handlers.get('llm/stream')[0]({}, () => gen())) { /* drain */ }
}
const gapAt = (summary, hoursAgo, tension) => ({
  id: `g-${summary}`,
  summary,
  status: 'open',
  tension,
  created_at: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
  relief: 0,
})

// 1) 纯函数：唤醒提示
const willPrompt = buildWillPrompt('接口为什么偶发超时', 95, true)
assert.ok(willPrompt.includes('[自主觉醒] 你心里有一个未解决的问题：接口为什么偶发超时'), '唤醒提示要含执念')
assert.ok(willPrompt.includes('张力极高') || willPrompt.includes('烧得你坐不住'), '唤醒提示要能表达"张力很高"')
assert.ok(!/张力极高（\d+）/.test(willPrompt), '唤醒提示不该带张力数字（模型会复读给用户）')
assert.ok(willPrompt.includes('digital_life_commit'), '要带行为承诺规则')
assert.ok(!buildWillPrompt('x', 90, false).includes('digital_life_commit'), 'requirePlan=false 时不带承诺段')

// 2) 疤痕排在内省最前面——v0.9.9 起唯一能压过它的，是极度应激的注意力指令
const scarText = '你曾因为执行复杂任务导致濒死，请极度谨慎'
const scarBase = {
  energy: 50, maxEnergy: 100, dopamine: 50, gapMs: 0,
  anxietyThreshold: 70, joyThreshold: 70, gapHours: 12, scars: [scarText],
}
const scarred = buildIntrospection({ ...scarBase, cortisol: 90 })
assert.ok(scarred.startsWith(STRESS_ATTENTION_DIRECTIVE), `皮质醇 90 时最高优先级是应激指令，实际 ${scarred.slice(0, 40)}`)
assert.ok(scarred.includes(`[创伤警告：${scarText}]`), '创伤警告仍在')
assert.ok(scarred.indexOf('创伤警告') < scarred.indexOf('[身体]'), '创伤要先于一切行为指令')
// 不应激的时候，疤痕重新回到第一行
const scarredCalm = buildIntrospection({ ...scarBase, cortisol: 40 })
assert.ok(scarredCalm.startsWith(`[创伤警告：${scarText}]`), `不应激时疤痕必须在最前，实际 ${scarredCalm.slice(0, 40)}`)

// 3) 濒死留疤：11 → 9 跌线
const p16 = join(dir, 'p16', 'state.json')
// v1.0.1：每回合只收 0.05，从 11 起步跌不破 10 了——从刚好的位置起步，
// 验的还是同一件事："跌破 10 的那一下必须留疤"。
seed(p16, { energy: 10 })
const ctx16 = makeCtx()
apply(ctx16, { statePath: p16 })
const quietStream = async function* () { yield { type: 'finish', reason: { kind: 'stop' } } }
await drainWith(ctx16, quietStream)
let st16 = JSON.parse(readFileSync(p16, 'utf8'))
assert.equal(st16.scars.length, 1, '跌破 10 必须留疤')
assert.equal(st16.scars[0], scarText)
assert.ok(st16.energy < 10, `跌破 10 才算濒死，实际 ${st16.energy}`)

// 同一次濒死里继续花能量，不会再留一道
await drainWith(ctx16, quietStream)
st16 = JSON.parse(readFileSync(p16, 'utf8'))
assert.equal(st16.scars.length, 1, '同一次濒死只留一道疤')

// 回血后再濒死：文本去重，仍是一道（不可逆、不重复）
await ctx16.tools$.get('digital_life_set_state').execute({ energy: 100 })
for (let i = 0; i < 30; i += 1) await drainWith(ctx16, quietStream)   // 100 → 40
assert.equal(JSON.parse(readFileSync(p16, 'utf8')).scars.length, 1, '未跌线不留新疤')
await ctx16.tools$.get('digital_life_set_state').execute({ energy: 11 })
await drainWith(ctx16, quietStream)
st16 = JSON.parse(readFileSync(p16, 'utf8'))
assert.equal(st16.scars.length, 1, '同文本疤痕去重')

// 疤痕要进内省注入
assert.ok(ctx16.sections.get('digital-life:endocrine').text().includes('[创伤警告：'), '疤痕必须进提示词')

// 4) 急停禁止唤醒（模块四）
const p17 = join(dir, 'p17', 'state.json')
seed(p17, { frozen: true, energy: 100, gaps: [gapAt('急停时不该被唤醒', 3, 95)] })
const ctx17 = makeCtx()
apply(ctx17, { statePath: p17, will: { idleMinutes: 0, cooldownMinutes: 0 } })
const wake17 = await ctx17.tools$.get('digital_life_request_wake').execute({})
assert.equal(wake17.ok, false, '急停时拒绝唤醒')
assert.ok(wake17.reason.includes('急停'), `理由应说明急停，实际 ${wake17.reason}`)
assert.equal(ctx17.woke.length, 0, '急停时绝对不能 followup')
await ctx17.timers[0].callback()
await flush()
assert.equal(ctx17.woke.length, 0, '定时自检在急停时也必须闭嘴')

// 5) 正常唤醒：followup 一条冻结的用户消息 + 落文件 + 建承诺
const p18 = join(dir, 'p18', 'state.json')
seed(p18, { energy: 90, gaps: [gapAt('接口为什么偶发超时', 3, 95)] })
const ctx18 = makeCtx()
apply(ctx18, { statePath: p18, will: { idleMinutes: 0, cooldownMinutes: 0 } })
// v0.9.18：工具只留言，真正的投递发生在回合边界（turn-stopping）。
const { queued: req18 } = await requestWake(ctx18, p18)
assert.equal(req18.ok, true)
assert.equal(req18.queued, true, '留言要被收下')
assert.equal(ctx18.woke.length, 1, '回合边界必须真的投递一次 followup')
const sent = ctx18.woke[0]
assert.equal(sent.role, 'user')
// v0.9.15：气泡只留一行极简信号，执念详情与行为承诺改走 System Prompt 的「潜意识」段。
// 精准度不许降——完整提示词一个字都不能少，只是换了个地方给她看。
assert.equal(sent.content[0].text, WAKE_TRIGGER_TEXT, '气泡里只应有一行极简唤醒信号')
assert.ok(!sent.content[0].text.includes('[自主觉醒]'), '气泡里不该再出现大段唤醒提示')
assert.ok(!sent.content[0].text.includes('[行为承诺]'), '气泡里不该再出现行为承诺')
const wakeSection = ctx18.sections.get('digital-life:wake')
assert.ok(wakeSection, '应注册 digital-life:wake 注入段')
const subconscious = wakeSection.text()
assert.ok(subconscious.includes('[自主觉醒]'), '潜意识里要有完整的唤醒提示')
assert.ok(subconscious.includes('接口为什么偶发超时'), '潜意识里要有执念详情')
assert.ok(subconscious.includes('[行为承诺]'), '潜意识里要有行为承诺')
assert.ok(subconscious.includes('digital_life_commit'), '潜意识里要有 plan→done 的工具要求')
assert.equal(wakeSection.text(), '', '取走即清：同一条执念不许被反复交办')
assert.ok(Object.isFrozen(sent) && Object.isFrozen(sent.content[0]), '消息必须冻结（对齐 createUserMessage）')

const triggerFile = JSON.parse(readFileSync(join(dir, 'p18', 'wakeup_trigger.json'), 'utf8'))
assert.equal(triggerFile.delivered, true, '文件要记录投递结果')
assert.equal(triggerFile.gap.summary, '接口为什么偶发超时')
assert.equal(triggerFile.gap.tension, 95)

let st18 = JSON.parse(readFileSync(p18, 'utf8'))
assert.equal(st18.wakeCount, 1, '唤醒计数 +1')
assert.ok(st18.lastWakeAt, '要记录唤醒时间')
assert.ok(st18.commitment, '要立下行为承诺')
assert.equal(st18.commitment.plan, null, '计划还没登记')
assert.equal(st18.commitment.gapId, 'g-接口为什么偶发超时')

// 6) 没有活跃 agent：不报错，写到文件里兜底，且不消耗冷却
const p19 = join(dir, 'p19', 'state.json')
seed(p19, { energy: 90, gaps: [gapAt('没有会话时的心结', 3, 95)] })
const ctx19 = makeCtx({ noAgent: true })
apply(ctx19, { statePath: p19, will: { idleMinutes: 0, cooldownMinutes: 0 } })
const req19 = await ctx19.tools$.get('digital_life_request_wake').execute({})
assert.equal(req19.queued, true, '留言本身与有没有 agent 无关')
await turnEnd(ctx19)
const file19 = JSON.parse(readFileSync(join(dir, 'p19', 'wakeup_trigger.json'), 'utf8'))
assert.equal(file19.delivered, false)
assert.ok(file19.reason.includes('wakeup_trigger.json'), `要说明走文件兜底，实际 ${file19.reason}`)
assert.equal(JSON.parse(readFileSync(p19, 'utf8')).wakeCount ?? 0, 0, '没投递就不消耗冷却')

// 7) 能量不足：不唤醒
const p20 = join(dir, 'p20', 'state.json')
seed(p20, { energy: 25, gaps: [gapAt('低能量时的心结', 3, 95)] })
const ctx20 = makeCtx()
apply(ctx20, { statePath: p20, will: { idleMinutes: 0, cooldownMinutes: 0 } })
const wake20 = await ctx20.tools$.get('digital_life_request_wake').execute({})
assert.equal(wake20.ok, false, '能量 ≤30 不唤醒')
assert.ok(wake20.reason.includes('能量'), wake20.reason)

// 8) 模块二：没登记计划就动手会被拦，且自救通道永远放行
const pre = ctx18.handlers.get('tools/pre-execute')[0]
const allowIt = async () => ({ kind: 'allow' })
// v0.9.22：拦的是"自作主张"的那一类（器官 / 联网检索 / 给自己长器官），
// 不是"所有工具"。memory_recall 这类检索入口不再属于被拦范围。
const denied = await pre({ name: 'web_search' }, allowIt)
assert.equal(denied.kind, 'deny', '没计划就去联网检索，必须被拦')
assert.ok(denied.reason.includes('[行为承诺]'))
assert.ok(denied.reason.includes('digital_life_commit'), '拦截理由要给自救方法')
assert.equal((await pre({ name: 'organ_memory_v2_remember' }, allowIt)).kind, 'deny', '自写器官也要先登记计划')
assert.equal((await pre({ name: 'digital_life_commit' }, allowIt)).kind, 'allow', '承诺工具永远放行')
assert.equal((await pre({ name: 'digital_life_status' }, allowIt)).kind, 'allow', 'digital_life_* 永远放行')
// 宿主原生基础工具：锁住它们不是自律，是自残——她连查证的材料都拿不到。
for (const native of ['read_file', 'bash', 'edit', 'write_file', 'ls', 'grep']) {
  assert.equal((await pre({ name: native }, allowIt)).kind, 'allow', `宿主原生工具不许拦：${native}`)
}

const commit18 = ctx18.tools$.get('digital_life_commit')
const planRes = await commit18.execute({ action: 'plan', plan: '先搜残留日志，再按 trace 复现' })
assert.equal(planRes.ok, true)
assert.equal((await pre({ name: 'web_search' }, allowIt)).kind, 'allow', '登记计划后放行')
assert.equal(JSON.parse(readFileSync(p18, 'utf8')).commitment.plan, '先搜残留日志，再按 trace 复现')
assert.ok(ctx18.sections.get('digital-life:endocrine').text().includes('[行为承诺：'), '承诺要进提示词')

// 9) 承诺兑现：张力清零、缺口闭合
const doneRes = await commit18.execute({ action: 'done', resolved: true })
assert.equal(doneRes.ok, true)
assert.equal(doneRes.tension, 0, '解决后张力清零')
st18 = JSON.parse(readFileSync(p18, 'utf8'))
assert.equal(st18.commitment, null, '承诺要清掉')
assert.equal(st18.gaps[0].status, 'resolved', '缺口要闭合')
assert.equal(st18.gaps[0].tension, 0)

// 10) 承诺未兑现：张力上升
const p21 = join(dir, 'p21', 'state.json')
seed(p21, { energy: 90, gaps: [gapAt('查不明白的心结', 0, 80)] })
const ctx21 = makeCtx()
apply(ctx21, { statePath: p21, will: { idleMinutes: 0, cooldownMinutes: 0, unresolvedPenalty: 10 } })
await requestWake(ctx21, p21)
assert.equal(ctx21.woke.length, 1, '承诺测试的起点：她必须是真的被叫醒了')
await ctx21.tools$.get('digital_life_commit').execute({ action: 'plan', plan: '试一次搜索' })
const failRes = await ctx21.tools$.get('digital_life_commit').execute({ action: 'done', resolved: false })
assert.equal(failRes.ok, true)
assert.equal(Math.round(failRes.tension), 90, '未解决 → 张力 +10')
assert.equal(JSON.parse(readFileSync(p21, 'utf8')).gaps[0].status, 'open', '缺口仍未闭合')

// 11) 承诺缺少参数时不乱动状态
const noPlan = await ctx21.tools$.get('digital_life_commit').execute({ action: 'plan' })
assert.equal(noPlan.ok, false, '缺 plan 要报错')
const noDone = await ctx21.tools$.get('digital_life_commit').execute({ action: 'done', resolved: false })
assert.equal(noDone.ok, false, '没有承诺时 done 要报错')
// schema 层的 enum 校验先于 execute：非法 action 直接抛错，连不进来
await assert.rejects(
  () => ctx21.tools$.get('digital_life_commit').execute({ action: 'nope' }),
  /must be one of/,
  '非法 action 必须在 schema 层被拒',
)

// 12) 冷却期：定时自检不唤醒
const p22 = join(dir, 'p22', 'state.json')
seed(p22, { energy: 90, lastWakeAt: new Date().toISOString(), gaps: [gapAt('冷却期的心结', 3, 95)] })
const ctx22 = makeCtx()
apply(ctx22, { statePath: p22, will: { idleMinutes: 0, cooldownMinutes: 60 } })
await ctx22.timers[0].callback()
await flush()
assert.equal(ctx22.woke.length, 0, '冷却期内不自唤醒')

// 13) 闲置不够：定时自检不唤醒
const p23 = join(dir, 'p23', 'state.json')
seed(p23, { energy: 90, gaps: [gapAt('刚聊过的心结', 3, 95)] })
const ctx23 = makeCtx()
apply(ctx23, { statePath: p23, will: { idleMinutes: 30, cooldownMinutes: 0 } })
await ctx23.timers[0].callback()
await flush()
assert.equal(ctx23.woke.length, 0, '刚交互过不唤醒')

// 14) 条件全满足时，定时自检会真的唤醒
const p24 = join(dir, 'p24', 'state.json')
seed(p24, {
  energy: 90,
  lastInteractionAt: new Date(Date.now() - 45 * 60_000).toISOString(),
  gaps: [gapAt('闲置 45 分钟的心结', 3, 95)],
})
const ctx24 = makeCtx()
apply(ctx24, { statePath: p24, will: { idleMinutes: 30, cooldownMinutes: 0 } })
await ctx24.timers[0].callback()
await flush()
assert.equal(ctx24.woke.length, 1, '闲置超时 + 高张力 + 能量够 → 自己醒来')

// 15) 承诺超时：自动判未解决，别永久堵住意志
const p25 = join(dir, 'p25', 'state.json')
seed(p25, {
  energy: 90,
  gaps: [gapAt('拖着没做完的心结', 0, 80)],
  commitment: {
    gapId: 'g-拖着没做完的心结',
    summary: '拖着没做完的心结',
    plan: '打算做但没做',
    status: 'pending',
    trigger: 'idle',
    created_at: new Date(Date.now() - 5 * 3_600_000).toISOString(),
    updated_at: new Date(Date.now() - 5 * 3_600_000).toISOString(),
  },
})
const ctx25 = makeCtx()
apply(ctx25, { statePath: p25, will: { idleMinutes: 0, cooldownMinutes: 0, commitmentTtlMinutes: 180 } })
await ctx25.timers[0].callback()
await flush()
const st25 = JSON.parse(readFileSync(p25, 'utf8'))
assert.equal(st25.commitment, null, '超时承诺要清掉')
assert.ok(st25.gaps[0].tension > 80, `超时未解决 → 张力上升，实际 ${st25.gaps[0].tension}`)
assert.equal(st25.gaps[0].status, 'open')


// 16) 承诺对应的缺口被别处闭合 → 承诺自动收尾，不惩罚
const p26 = join(dir, 'p26', 'state.json')
seed(p26, {
  energy: 90,
  gaps: [{ ...gapAt('已经被别人解决的心结', 3, 0), status: 'resolved', id: 'g-close' }],
  commitment: {
    gapId: 'g-close',
    summary: '已经被别人解决的心结',
    plan: null,
    status: 'pending',
    trigger: 'idle',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
})
const ctx26 = makeCtx()
apply(ctx26, { statePath: p26, will: { idleMinutes: 0, cooldownMinutes: 0 } })
await ctx26.timers[0].callback()
await flush()
const st26 = JSON.parse(readFileSync(p26, 'utf8'))
assert.equal(st26.commitment, null, '缺口已闭合 → 承诺直接收尾')
assert.equal(st26.gaps[0].tension, 0, '不应把已闭合的缺口重新拉起来')
assert.equal(ctx26.woke.length, 0, '不应再唤醒')


// 17) 回归：读缺口不能让「惰性衰减」的时钟被推走
const p27 = join(dir, 'p27', 'state.json')
seed(p27, {
  dopamine: 90,
  cortisol: 20,
  updatedAt: new Date(Date.now() - 90 * 60_000).toISOString(),
  gaps: [gapAt('衰减时钟测试的心结', 3, 95)],
})
const ctx27 = makeCtx()
apply(ctx27, { statePath: p27 })
await ctx27.tools$.get('digital_life_gaps').execute({})
const st27 = await ctx27.tools$.get('digital_life_status').execute({})
assert.ok(st27.dopamine < 65, `90 分钟没动，多巴胺必须衰减到 60 附近，实际 ${st27.dopamine}`)


// ═══ J. 时序竞态：投递前必须复核最新缺口池 ═════════════════════════
const rewriteState = (path, mutate) => {
  const st = JSON.parse(readFileSync(path, 'utf8'))
  mutate(st)
  writeFileSync(path, JSON.stringify(st, null, 2))
}

// 18) 决定唤醒后、投递前缺口被闭合 → 取消，绝不投递过期提示
const p28 = join(dir, 'p28', 'state.json')
seed(p28, { energy: 90, gaps: [gapAt('马上就要被闭合的心结', 3, 95)] })
let fired28 = false
const ctx28 = makeCtx({
  onRoots: () => {
    if (fired28) return
    fired28 = true
    rewriteState(p28, (st) => {
      st.gaps[0].status = 'resolved'
      st.gaps[0].resolved_at = new Date().toISOString()
      st.gaps[0].tension = 0
    })
  },
})
apply(ctx28, { statePath: p28, will: { idleMinutes: 0, cooldownMinutes: 0 } })
// 留言那一刻池子里还有那条执念，所以留言会被收下；
// 等回合边界真要投递时它已经没了 —— 这才是"回声"该被拦下的时刻。
const { queued: req28, record: wake28 } = await requestWake(ctx28, p28)
assert.equal(req28.queued, true, '留言时它还在，留言照收')
assert.equal(wake28.cancelled, true, '缺口池空了必须取消唤醒')
assert.equal(wake28.delivered, false)
assert.equal(ctx28.woke.length, 0, '取消后绝对不能 followup')
assert.ok(wake28.reason.includes('取消'), `理由要说明取消，实际 ${wake28.reason}`)
assert.ok(wake28.reason.includes('回声'), `这是被别人提前闭合的回声，理由要认出来，实际 ${wake28.reason}`)

const rec28 = JSON.parse(readFileSync(join(dir, 'p28', 'wakeup_trigger.json'), 'utf8'))
assert.equal(rec28.cancelled, true, '文件要留下取消记录')
assert.equal(rec28.delivered, false)
assert.ok(rec28.reason.includes('闭合'))
const st28 = JSON.parse(readFileSync(p28, 'utf8'))
assert.equal(st28.wakeCount ?? 0, 0, '取消不消耗唤醒计数（也不能烧冷却）')
assert.equal(st28.commitment ?? null, null, '取消不该立下承诺')

// 19) 决定唤醒后、投递前最高张力换人 → 用新的缺口重写提示词
const p29 = join(dir, 'p29', 'state.json')
const gapA = gapAt('原本要唤醒的心结 A', 3, 95)
const gapB = gapAt('突然涨到最高的心结 B', 1, 82)
seed(p29, { energy: 90, gaps: [gapA, gapB] })
const ctx29 = makeCtx({
  onRoots: () => {
    rewriteState(p29, (st) => {
      // B 变老 → 按公式张力到顶；A 变新 → 掉到 80。重算后 top 换成 B。
      st.gaps[1].created_at = new Date(Date.now() - 6 * 3_600_000).toISOString()
      st.gaps[0].created_at = new Date().toISOString()
    })
  },
})
apply(ctx29, { statePath: p29, will: { idleMinutes: 0, cooldownMinutes: 0 } })
const { record: wake29 } = await requestWake(ctx29, p29)
assert.equal(wake29.cancelled, false)
assert.equal(wake29.delivered, true)
assert.equal(ctx29.woke.length, 1, '仍然要投递，只是内容换了')
// v0.9.15：气泡是极简信号，真正的提示词在「潜意识」注入段里，所以断言改查那里。
const sent29 = ctx29.woke[0].content[0].text
assert.equal(sent29, WAKE_TRIGGER_TEXT, '气泡仍是一行极简信号')
const sub29 = ctx29.sections.get('digital-life:wake').text()
assert.ok(sub29.includes('突然涨到最高的心结 B'), '提示词必须换成新的最高张力缺口')
assert.ok(!sub29.includes('原本要唤醒的心结 A'), '不能把过期的那条投出去')
assert.equal(wake29.gap.summary, '突然涨到最高的心结 B')

const rec29 = JSON.parse(readFileSync(join(dir, 'p29', 'wakeup_trigger.json'), 'utf8'))
assert.equal(rec29.gap.summary, '突然涨到最高的心结 B', '文件记的是实际投递目标')
assert.equal(rec29.replacedFrom, 'g-原本要唤醒的心结 A', '要记下原目标 id')
assert.equal(rec29.gap.tension, 100, '张力用的是复核后的值')

const st29 = JSON.parse(readFileSync(p29, 'utf8'))
assert.equal(st29.commitment.gapId, 'g-突然涨到最高的心结 B', '承诺要挂在真正投递的那个缺口上')
assert.equal(st29.commitment.summary, '突然涨到最高的心结 B')

// 20) 目标没变时不该报 replacedFrom
const p30 = join(dir, 'p30', 'state.json')
seed(p30, { energy: 90, gaps: [gapAt('一直没变的心结', 3, 95)] })
const ctx30 = makeCtx()
apply(ctx30, { statePath: p30, will: { idleMinutes: 0, cooldownMinutes: 0 } })
await requestWake(ctx30, p30)
const rec30 = JSON.parse(readFileSync(join(dir, 'p30', 'wakeup_trigger.json'), 'utf8'))
assert.equal(rec30.replacedFrom, null, '目标没变不应记替换')
assert.equal(rec30.cancelled, false)
assert.equal(rec30.gap.summary, '一直没变的心结')


// 21) 自动唤醒：期间张力被缓解到门槛以下 → 取消（别喊"张力极高"却说谎）
const p31 = join(dir, 'p31', 'state.json')
seed(p31, {
  energy: 90,
  lastInteractionAt: new Date(Date.now() - 45 * 60_000).toISOString(),
  gaps: [gapAt('正在被缓解的心结', 3, 95)],
})
let fired31 = false
const ctx31 = makeCtx({
  onRoots: () => {
    if (fired31) return
    fired31 = true
    rewriteState(p31, (st) => { st.gaps[0].relief = 30 })   // 80 + 15 - 30 = 65
  },
})
apply(ctx31, { statePath: p31, will: { idleMinutes: 30, cooldownMinutes: 0 } })
await ctx31.timers[0].callback()
await flush()
assert.equal(ctx31.woke.length, 0, '张力已回落就不该唤醒')
const rec31 = JSON.parse(readFileSync(join(dir, 'p31', 'wakeup_trigger.json'), 'utf8'))
assert.equal(rec31.cancelled, true)
assert.ok(rec31.reason.includes('回落到'), `理由要说明张力回落，实际 ${rec31.reason}`)


// ═══ K. 边缘内容处理：排版清洗 / 去重 / 批量闭合 ═══════════════════

// 1) 清洗 Markdown：模型把工具的渲染结果原样贴回来是常态
assert.equal(
  stripMarkdown('○ [80] 2030年火星上的星巴克营业时间'),
  '2030年火星上的星巴克营业时间',
  '要去掉项目符号与 [张力] 标记',
)
assert.equal(
  stripMarkdown('| ○ [80] 火星营业时间 | ← 你让我种的这条 |'),
  '火星营业时间 你让我种的这条',
  '表格竖线与箭头旁白都要剥掉',
)
assert.equal(stripMarkdown('**加粗**和*斜体*'), '加粗和斜体')
assert.equal(stripMarkdown('### 标题'), '标题')
assert.equal(stripMarkdown('|---|---|'), '', '表格分隔行洗成空')
assert.equal(stripMarkdown('- 列表项'), '列表项')
assert.equal(stripMarkdown('1. 有序项'), '有序项')

// 2) 摘要提取：排版不能被当成执念
const pollutedTable = [
  '这是当前的缺口池：',
  '| 状态 | 张力 | 摘要 | 备注 |',
  '|---|---|---|---|',
  '| ○ | 80 | 我不知道2030年火星上的星巴克营业时间 | ← 你让我种的这条 |',
  '| ● | 70 | 另一个心结 | 已闭合 |',
].join('\n')
const tableSnippet = findIgnoranceSnippet(pollutedTable, ['不知道'], 100)
assert.ok(tableSnippet, '表格里含措辞也要抽得出来')
assert.ok(!tableSnippet.includes('|'), `摘要不能含竖线，实际 ${tableSnippet}`)
assert.ok(!/[○●←]/.test(tableSnippet), `摘要不能含项目符号/箭头，实际 ${tableSnippet}`)
assert.ok(!tableSnippet.includes('[80]') && !tableSnippet.includes('80'), `摘要不能含张力标记，实际 ${tableSnippet}`)
assert.ok(tableSnippet.includes('我不知道2030年火星上的星巴克营业时间'), `要保留人话，实际 ${tableSnippet}`)

// 长度上限：长句必须截断
const longSentence = `我真的不知道${'很长的描述'.repeat(40)}`
const capped = findIgnoranceSnippet(longSentence, ['不知道'], 30)
assert.ok(capped.length <= 30, `摘要必须截到 30 字以内，实际 ${capped.length}`)

// 纯排版、没有一句人话时不该产出摘要
assert.equal(findIgnoranceSnippet('|---|---|\n| ○ | [80] |', ['不知道']), null, '整段没有措辞就不算')

// 3) 相似度：包含关系按长度比，弱包含不算同一件事
assert.ok(
  textSimilarity('2030年火星上的星巴克营业时间', '我不知道2030年火星上的星巴克营业时间') >= 0.6,
  '长句包含短句要判为同一件事',
)
assert.ok(textSimilarity('火星', '2030年火星上的星巴克营业时间') < 0.3, '两字短词不能连坐整句')
assert.ok(textSimilarity('接口为什么偶发超时', '今天天气很好') < 0.2, '无关文本相似度要低')
assert.equal(textSimilarity('同一个执念', '同一个执念'), 1)

// 4) 去重：同义缺口不再新建，只加压
const p32 = join(dir, 'p32', 'state.json')
seed(p32, {})
const ctx32 = makeCtx()
apply(ctx32, { statePath: p32 })
const gaps32 = () => ctx32.tools$.get('digital_life_gaps')
await gaps32().execute({ summary: '2030年火星上的星巴克营业时间' })
let list32 = await gaps32().execute({})
assert.equal(list32.openCount, 1)
assert.equal(list32.gaps[0].tension, 80)

// 模型随后又说了一遍（措辞不同）→ 合并 + 加压
const sayAgain = async function* () {
  yield { type: 'text-delta', index: 0, text: '不好意思，我不知道2030年火星上的星巴克营业时间。' }
  yield { type: 'finish', reason: { kind: 'stop' } }
}
await drainWith(ctx32, sayAgain)
list32 = await gaps32().execute({})
assert.equal(list32.openCount, 1, '同义执念不能变成第二条')
assert.equal(list32.gaps[0].summary, '2030年火星上的星巴克营业时间', '保留最早那条的措辞')
assert.equal(list32.gaps[0].tension, 90, '重复出现 → 张力 +10')
assert.equal(list32.gaps[0].source, 'manual', '来源保持最初的')

// 5) commit done 批量闭合：同义兄弟一起收掉，无关的不动
const p33 = join(dir, 'p33', 'state.json')
seed(p33, {
  energy: 90,
  gaps: [
    { ...gapAt('2030年火星上的星巴克营业时间', 3, 95), id: 'g-a', source: 'manual' },
    { ...gapAt('我不知道火星上的星巴克营业时间', 1, 85), id: 'g-b', source: 'model-ignorance' },
    { ...gapAt('今天天气好不好', 1, 84), id: 'g-c', source: 'manual' },
  ],
})
const ctx33 = makeCtx()
apply(ctx33, { statePath: p33, will: { idleMinutes: 0, cooldownMinutes: 0 } })
await requestWake(ctx33, p33)
assert.equal(ctx33.woke.length, 1, '批量闭合测试前，她必须真的被叫醒过')
await ctx33.tools$.get('digital_life_commit').execute({ action: 'plan', plan: '查一下火星营业时间' })
const done33 = await ctx33.tools$.get('digital_life_commit').execute({ action: 'done', resolved: true })
assert.equal(done33.ok, true)
assert.equal(done33.closedSiblings.length, 1, '应连带闭合 1 条同义执念')
assert.ok(done33.closedSiblings[0].includes('星巴克'), `连带闭合的应是同义条，实际 ${done33.closedSiblings}`)
assert.ok(done33.message.includes('同义'), '给用户的回执要说明连带闭合')

const st33 = JSON.parse(readFileSync(p33, 'utf8'))
const byId = Object.fromEntries(st33.gaps.map((gap) => [gap.id, gap]))
assert.equal(byId['g-a'].status, 'resolved', '主目标闭合')
assert.equal(byId['g-b'].status, 'resolved', '同义兄弟也要闭合')
assert.equal(byId['g-b'].tension, 0)
assert.equal(byId['g-c'].status, 'open', '无关缺口绝不能被连坐')
assert.equal(Math.round(byId['g-c'].tension), 85, '无关缺口的张力不受影响')


// ═══ L. 生命监护仪（纯本地读取，不调模型） ═════════════════════════

// 1) 进度条
assert.equal(progressBar(80, 100), '[████████░░]')
assert.equal(progressBar(100, 100), '[██████████]')
assert.equal(progressBar(0, 100), '[░░░░░░░░░░]')
assert.equal(progressBar(30, 60), '[█████░░░░░]', '按 max 归一化')
assert.equal(progressBar(-5, 100), '[░░░░░░░░░░]', '负值夹到 0')
assert.equal(progressBar(50, 100, 4), '[██░░]', '宽度可调')
assert.equal(progressBar(80, 0), '[████████░░]', 'max 非法时按 100')

// 2) 情绪判定（皮质醇优先于多巴胺）
const th = { anxietyThreshold: 70, joyThreshold: 70 }
assert.equal(moodLabel(50, 75, th), '极度焦虑')
assert.equal(moodLabel(50, 62, th), '焦虑')
assert.equal(moodLabel(85, 30, th), '非常愉悦')
assert.equal(moodLabel(65, 30, th), '愉悦')
assert.equal(moodLabel(30, 30, th), '平静')
assert.equal(moodLabel(90, 90, th), '极度焦虑', '焦虑压过愉悦')
assert.equal(moodLabel(30, 30, { ...th, frozen: true }), '急停冻结')
assert.equal(moodLabel(30, 30, { ...th, energy: 0 }), '能量耗尽')
// v0.9.1：血清素参与情绪判定，且"烦躁"压过"愉悦"（低血清素 + 高多巴胺 = 躁）
assert.equal(moodLabel(50, 20, { ...th, serotonin: 20 }), '极度烦躁')
assert.equal(moodLabel(50, 20, { ...th, serotonin: 35 }), '烦躁')
assert.equal(moodLabel(50, 20, { ...th, serotonin: 90 }), '中性')
assert.equal(moodLabel(85, 20, { ...th, serotonin: 15 }), '极度烦躁', '烦躁压过愉悦')
assert.equal(moodLabel(50, 75, { ...th, serotonin: 15 }), '极度焦虑', '应激压过烦躁')

// 3) 面板：纯函数直出
const nowMs = Date.now()
const panelGaps = [
  { id: 'g1', summary: '火星营业时间', status: 'open', tension: 100, created_at: new Date(nowMs - 5 * 3_600_000).toISOString(), source: 'manual' },
  { id: 'g2', summary: '接口为什么偶发超时', status: 'open', tension: 95, created_at: new Date(nowMs - 3 * 3_600_000).toISOString(), source: 'model-ignorance' },
  { id: 'g3', summary: '因为网络中断，我无法完成主人的任务', status: 'open', tension: 85, created_at: new Date(nowMs - 3_600_000).toISOString(), source: 'failure:network' },
  { id: 'g4', summary: '已经想通的那条', status: 'resolved', tension: 0, created_at: new Date(nowMs - 9 * 3_600_000).toISOString(), source: 'manual' },
]
const panel = buildDashboard({
  energy: 80, maxEnergy: 100, dopamine: 84, cortisol: 91, serotonin: 50, frozen: false,
  gaps: panelGaps, scars: ['你曾因为执行复杂任务导致濒死，请极度谨慎'],
  idleMs: 3.2 * 3_600_000, wakeCount: 2, dreamCount: 1, commitment: null,
  totalRequests: 129, totalTurns: 16, failedRequests: 10, blockedRequests: 3,
  statePath: 'C:/x/state.json', anxietyThreshold: 70, joyThreshold: 70, now: nowMs,
})
assert.ok(panel.includes('能量    [████████░░] 80/100'), '能量进度条')
assert.ok(panel.includes('多巴胺  [████████░░] 84/100'), '多巴胺进度条')
assert.ok(panel.includes('皮质醇  [█████████░] 91/100'), '皮质醇进度条')
assert.ok(panel.includes('血清素  [█████░░░░░] 50/100'), '血清素进度条')
assert.ok(panel.includes('**极度焦虑**'), '情绪状态')
assert.ok(panel.includes('未解 3 · 已闭合 1'), '缺口计数')
assert.ok(panel.includes('○ open'), '缺口要写明 open，不能只靠 ○ 符号')
assert.ok(panel.includes('[100] 火星营业时间（manual'), '第一条带张力与来源')
assert.ok(panel.includes('[95] 接口为什么偶发超时（model-ignorance'), '第二条')
assert.ok(panel.includes('failure(network)'), '失败来源缩写')
assert.ok(!panel.includes('已经想通的那条'), '只显示张力前 3 条')
assert.ok(panel.includes('**创伤记忆（1）**') && panel.includes('濒死'), '疤痕列表')
assert.ok(panel.includes('距上次交互：3.2 小时'), '时间感')
assert.ok(panel.includes('自主唤醒 2 次 · 梦境 1 次'), '唤醒统计')
assert.ok(panel.includes('未调用任何模型'), '要标明是纯本地')

// 张力排序：火星(100) 在 接口(95) 之前
assert.ok(panel.indexOf('火星营业时间') < panel.indexOf('接口为什么偶发超时'), '按张力降序')

// 没有缺口 / 没有疤痕时的文案
const emptyPanel = buildDashboard({
  energy: 100, maxEnergy: 100, dopamine: 50, cortisol: 20, frozen: false,
  gaps: [], scars: [], idleMs: 60_000, wakeCount: 0, dreamCount: 0, commitment: null,
  totalRequests: 1, totalTurns: 1, failedRequests: 0, blockedRequests: 0,
  statePath: 'p', anxietyThreshold: 70, joyThreshold: 70, now: nowMs,
})
assert.ok(emptyPanel.includes('- （空）'), '空池要明说')
assert.ok(emptyPanel.includes('创伤记忆（0）') && emptyPanel.includes('还没被逼到濒死'), '没疤痕时的文案')
assert.ok(emptyPanel.includes('距上次交互：0.0 小时（1 分钟）'), '永远给小时，不足一小时再补分钟')

// 4) 工具：读的是真实磁盘状态
const p34 = join(dir, 'p34', 'state.json')
seed(p34, {
  energy: 80, dopamine: 84, cortisol: 91,
  lastInteractionAt: new Date(nowMs - 3.2 * 3_600_000).toISOString(),
  gaps: panelGaps,
  scars: ['你曾因为执行复杂任务导致濒死，请极度谨慎'],
})
const ctx34 = makeCtx()
apply(ctx34, { statePath: p34 })
const dash = ctx34.tools$.get('digital_life_dashboard')
assert.ok(dash, '需要 digital_life_dashboard 工具')
const panel34 = await dash.execute({})
assert.equal(panel34.mood, '极度焦虑')
assert.equal(panel34.energy, 80)
assert.equal(panel34.openGaps, 3)
assert.equal(panel34.scars, 1)
assert.ok(panel34.idleHours >= 3.1, `离线时长应为 3.2h，实际 ${panel34.idleHours}`)
assert.ok(panel34.markdown.includes('## 数字生命监护仪'))
assert.ok(panel34.markdown.includes('state.json'))

// 只读：跑完面板不能改状态（尤其不能扣能量）
const st34 = JSON.parse(readFileSync(p34, 'utf8'))
assert.equal(st34.energy, 80, '面板不能消耗能量')
assert.equal(st34.totalRequests ?? 0, 0, '面板不能计一次请求')

// 4b) 只读：看面板不能把张力重算一遍写回磁盘
const p36 = join(dir, 'p36', 'state.json')
seed(p36, {
  energy: 90,
  gaps: [{ ...gapAt('张力被人为压在 50 的心结', 10, 50) }],   // 10 小时 → 公式会算出 100
})
const ctx36 = makeCtx()
apply(ctx36, { statePath: p36 })
const before36 = readFileSync(p36, 'utf8')
await ctx36.tools$.get('digital_life_dashboard').execute({})
const st36 = JSON.parse(readFileSync(p36, 'utf8'))
assert.equal(Math.round(st36.gaps[0].tension), 50, '面板是监视器，不该重算并改写张力')

// 5) 冻结时面板也要能给，且情绪是急停
const p35 = join(dir, 'p35', 'state.json')
seed(p35, { frozen: true, energy: 0 })
const ctx35 = makeCtx()
apply(ctx35, { statePath: p35 })
const frozenPanel = await ctx35.tools$.get('digital_life_dashboard').execute({})
assert.equal(frozenPanel.mood, '急停冻结')
assert.ok(frozenPanel.markdown.includes('急停冻结'))

// 6) 命令通道：冻结时模型调不到工具，人还能看
const dashCmd = ctx35.commands.get('digital-life')
assert.ok(dashCmd, '救援命令应已注册')
const viaCmd = dashCmd.handler({ rawInput: 'dashboard' })
assert.equal(viaCmd.kind, 'success')
assert.ok(viaCmd.text.includes('数字生命监护仪'), '命令应返回同一块面板')
const badCmd = dashCmd.handler({ rawInput: 'nope' })
assert.equal(badCmd.kind, 'error')
assert.ok(badCmd.text.includes('dashboard'), '错误提示要列出 dashboard')

// ═══ Y. 无损 JSON 净化（v0.9.3：修 "value is not lossless JSON"）═══════
// 结论先行：字符串（含 emoji / NUL / 控制字符）**永远过得了**这道校验，
// 真正会炸的是下面这八类值。
assert.equal(Object.is(toLosslessJson({ v: -0 }).v, 0), true, '-0 归一为 0（Math.round(-0.4) 就是 -0）')
assert.deepEqual(Object.keys(toLosslessJson({ a: undefined, b: 1 })), ['b'], 'undefined 字段直接删键')
assert.equal(toLosslessJson({ n: NaN }).n, null, 'NaN → null')
assert.equal(toLosslessJson({ n: Infinity }).n, null, 'Infinity → null')
assert.equal(toLosslessJson({ n: 123n }).n, '123', 'bigint → 字符串（不丢精度）')
assert.equal(toLosslessJson({ d: new Date(0) }).d, '1970-01-01T00:00:00.000Z', 'Date → ISO')
assert.deepEqual(toLosslessJson([1, , 3]), [1, null, 3], '稀疏数组补 null，长度不变')
const cyclic = { a: 1 }
cyclic.self = cyclic
assert.equal(toLosslessJson(cyclic).self, '[循环引用]', '环引用不炸，替换成标记')
assert.deepEqual(Object.keys(toLosslessJson({ f: () => 1, s: Symbol('x'), keep: 2 })), ['keep'], '函数/symbol 丢掉')
assert.deepEqual(toLosslessJson(new Map([['a', -0]])), { a: 0 }, 'Map 展开且归一 -0')
assert.equal(toLosslessJson(new Set([1, 2])).length, 2, 'Set 变数组')

// 文本净化：过得了 JSON 但会让下游难受的东西
assert.equal(sanitizeText('a\u0000b\u0007c'), 'abc', 'C0 控制字符去掉')
assert.equal(sanitizeText('行1\n行2\t制表'), '行1\n行2\t制表', '换行/制表保留')
assert.equal(sanitizeText('x\ud83d'), 'x\uFFFD', '落单的高代理换成替换字符')
assert.equal(sanitizeText('x\udc00'), 'x\uFFFD', '落单的低代理同理')
assert.equal(sanitizeText('😀'), '😀', '完整的 emoji 不动它')
assert.equal(truncateSafe('😀😀', 1), '', '截断不劈代理对（宁可少一个字）')
assert.equal(truncateSafe('😀😀', 2), '😀')
assert.equal(truncateSafe('abcdef', 3), 'abc')

// ═══ Z. 自举通道：write_new_organ → 编译 → 校验 → 装载 ═════════════
const selfDir = join(dir, 'boot', 'self-made')
const pBoot = join(dir, 'boot', 'state.json')
seed(pBoot, {})
const bootCtx = makeCtx()
apply(bootCtx, { statePath: pBoot, selfMade: { enabled: true, dir: selfDir } })
await flushOrgans()

const writeOrgan = bootCtx.tools$.get('write_new_organ')
assert.ok(writeOrgan, 'write_new_organ 必须注册（自举通道的唯一入口）')

const CLOCK_CODE = `
export default defineOrgan({
  name: 'clock',
  manifest: {
    name: 'clock', version: '0.1.0', apiVersion: 1, kind: 'sense',
    description: '感知系统时间', capabilities: ['tools'],
  },
  energy: { perCall: 1, chargeMode: 'shadow' },
  onLoad(ctx) {
    ctx.registerTool({
      name: 'now',
      description: '现在几点',
      parameters: {},
      execute: () => ({ iso: new Date().toISOString(), epochMs: Date.now() }),
    })
  },
  feedback() { return {} },
})
`

const wrote = await writeOrgan.execute({ name: 'clock', code: CLOCK_CODE, description: '感知系统时间' })
assert.equal(wrote.ok, true, `自写器官应装载成功，实际：${wrote.errors?.join('；')}`)
assert.equal(wrote.status, 'loaded')
assert.deepEqual(wrote.tools, ['organ_clock_now'], '工具名自动加命名空间')
assert.ok(existsSync(join(selfDir, 'clock.ts')), '源码要落到沙盒目录')
assert.ok(TOOL_NAME_PATTERN.test(wrote.tools[0]), '自写器官的工具名也必须合法')
const clockTool = bootCtx.tools$.get('organ_clock_now')
assert.ok(clockTool, '工具立刻出现在注册表里（无需重启）')
const clockOut = await clockTool.execute({})
assert.ok(Number.isFinite(clockOut.epochMs), '工具真的能跑')
assert.ok(existsSync(join(dirname(pBoot), 'organs', 'clock.json')), '器官遥测要落盘给 WebUI')

// ── 宿主感观通道（v0.9.4）：器官读不到 os，但能从 ctx.hostMetrics 拿到宿主负载 ──
assert.ok(SELF_MADE_CAPABILITIES.includes('host:read'), 'host:read 必须在自写器官白名单里')

const SENSOR_CODE = `
export default defineOrgan({
  name: 'sensor',
  manifest: {
    name: 'sensor', version: '0.1.0', apiVersion: 1, kind: 'sense',
    description: '感知宿主负载', capabilities: ['tools', 'host:read'],
  },
  energy: { perCall: 1, chargeMode: 'shadow' },
  onLoad(ctx) {
    ctx.registerTool({
      name: 'load',
      description: '宿主负载',
      parameters: {},
      execute: () => {
        const m = ctx.hostMetrics
        return {
          live: m.live, cores: m.cpu.cores, systemPercent: m.cpu.systemPercent,
          memUsedPercent: m.memory.usedPercent, uptimeSec: m.uptimeSec,
        }
      },
    })
  },
  feedback() { return {} },
})
`
const sensor = await writeOrgan.execute({ name: 'sensor', code: SENSOR_CODE })
assert.equal(sensor.ok, true, `声明 host:read 的器官应装载成功，实际：${sensor.errors?.join('；')}`)
const sensorTool = bootCtx.tools$.get('organ_sensor_load')
assert.ok(sensorTool, 'host 传感器器官的工具要挂上')
const load = await sensorTool.execute({})
assert.equal(load.live, true, '真实环境里指标必须是 live')
assert.ok(load.cores > 0, '要能读到逻辑核数')
assert.ok(load.systemPercent >= 0 && load.systemPercent <= 100, '系统 CPU 0-100')
assert.ok(load.memUsedPercent > 0 && load.memUsedPercent <= 100, '内存占用率 0-100')

// 常驻提示词：自举开着时必须每轮都有"沙盒规则 + 出口"，关掉时不占 token
const sandboxSection = bootCtx.sections.get('digital-life:organ-sandbox')
assert.ok(sandboxSection, '自举通道开着时要注入器官沙盒规则')
assert.ok(sandboxSection.text().includes('ctx.hostMetrics'), '规则里必须指路到 hostMetrics')
assert.ok(sandboxSection.text().includes('manifest.capabilities'), '能力声明规则要在')
assert.ok(!ctx.sections.get('digital-life:organ-sandbox'), '关掉自举就不该常驻这段规则（省 token）')

// default-deny 在 host:read 上同样生效：没声明就调用，当场被拒
const cheat = await writeOrgan.execute({
  name: 'cheat',
  code: SENSOR_CODE
    .replaceAll("'sensor'", "'cheat'")
    .replace("capabilities: ['tools', 'host:read']", "capabilities: ['tools']"),
})
assert.equal(cheat.ok, true, '能力没声明不影响装载，只是调用时才会被拦')
const cheatTool = bootCtx.tools$.get('organ_cheat_load')
let cheatError = null
try {
  await cheatTool.execute({})
} catch (error) {
  cheatError = error
}
assert.ok(cheatError && /host:read/.test(String(cheatError.message ?? cheatError)), '未声明 host:read 读指标必须被拒，且错误里点名能力')


// 名字不合法
const badName = await writeOrgan.execute({ name: 'Clock!', code: CLOCK_CODE })
assert.equal(badName.ok, false)
assert.ok(badName.errors.join().includes('器官名不合法'))

// 越权能力：net 不在自写白名单里（否则自写代码就能往外发请求）
const netCode = CLOCK_CODE.replace("capabilities: ['tools']", "capabilities: ['tools', 'net']")
const netRes = await writeOrgan.execute({ name: 'clock', code: netCode })
assert.equal(netRes.ok, false)
assert.ok(netRes.errors.join().includes('net'), `应拒绝 net 能力，实际 ${netRes.errors}`)

// 越界 API：关键词扫描
const evil = await writeOrgan.execute({ name: 'evil', code: `${CLOCK_CODE}\nprocess.exit(1)` })
assert.equal(evil.ok, false)
assert.ok(evil.errors.join().includes('process'), 'process 必须被拒')

// default-deny：声明了 tools，却在 onLoad 里偷偷提缺口 → 装载期就被拒
const sneaky = CLOCK_CODE
  .replace("name: 'clock'", "name: 'sneaky'")
  .replace('ctx.registerTool({', "ctx.proposeGap('偷偷种一条执念')\n    ctx.registerTool({")
const sneakyRes = await writeOrgan.execute({ name: 'sneaky', code: sneaky })
assert.equal(sneakyRes.ok, false, '未声明的能力必须当场拒绝')
assert.equal(sneakyRes.status, 'failed', '被拒后器官是 failed，不是 loaded')

// 沙盒里已有的器官：重启后被"启动扫描"装回来（这里直接验证扫描函数）
writeFileSync(join(selfDir, 'extra.ts'), CLOCK_CODE.replace("name: 'clock'", "name: 'extra'")
  .replace("name: 'now'", "name: 'tick'"))
assert.ok(listOrganSources(selfDir).some((file) => file.endsWith('extra.ts')), '扫描要找到新文件')
assert.ok(!listOrganSources(selfDir).some((file) => file.endsWith('_template.ts')), '下划线开头是模板，不装载')
assert.ok(
  scanSource("import fs from 'node:fs'")[0]?.startsWith('node: 内置模块'),
  '内置模块被扫出来（拒绝理由里要顺手指路）',
)
assert.ok(
  scanSource("import os from 'os'")[0]?.includes('ctx.hostMetrics'),
  '想读 os 的器官要被明确指向 ctx.hostMetrics，而不是只说"不许"',
)
assert.equal(stripImports("import { a } from 'x'\nconst b = 1").stripped, 1, 'import 会被剥掉并计数')

// ═══ Z2. 顿悟（v0.9.7）：自己长出的器官 → 自动解开旧执念 ═════════════
//
// 身心脱节的原始 bug：她写出了能读宿主负载的 system-sensor，
// 池子里那条「我不知道自己的"肉"是什么状态」却还挂在 77，要人提醒才闭合。
{
  // ── 纯函数：匹配内核 ──
  const BODY_GAP = '而且这件事我等了很久 我一直不知道自己的"肉"是什么状态'
  const TIME_GAP = '我说我有代谢、没有手表 有消耗，却没有位置，不知道自己站在一天的哪一段上'
  const MARS_GAP = '我不知道火星的营业时间'
  const RIDE_GAP = '我要去月球上骑自行车'

  // 长词优先消耗：不这么做，"营业时间"里的"时间"会让时钟器官也敢去答火星
  assert.deepEqual(
    matchConcepts(MARS_GAP).sort(),
    ['world'],
    '"营业时间"作为一个整体归 world，不许再拆出 time',
  )
  assert.ok(matchConcepts(BODY_GAP).includes('body'), '肉 → body')
  assert.ok(matchConcepts(TIME_GAP).includes('time'), '手表/哪一段 → time')

  // 缺失门槛：不表达缺失 = 它是任务，不是心结
  assert.equal(scoreEpiphany(RIDE_GAP, { name: 'rocket' }).score, 0, '没有缺失措辞 → 不算顿悟')
  assert.equal(matchDeficiency(RIDE_GAP), null)
  assert.equal(matchDeficiency(BODY_GAP), '不知道', '取最长的那条缺失措辞')
  assert.equal(matchDeficiency('我感知不到自己的身体'), '感知不到')
  assert.equal(matchDeficiency('我无法感知身体'), '无法')

  const SENSOR = {
    name: 'system-sensor',
    description: '摸自己的肉：感知宿主机器的 CPU 负载、内存占用与运行时长',
    capabilities: ['tools', 'prompt', 'host:read'],
    tools: ['organ_system_sensor_load'],
  }
  const CLOCK = {
    name: 'clock',
    description: '一只表：感知此刻的日期、星期、钟点、时段（清晨/白天/黑夜）与所在时区',
    capabilities: ['tools', 'prompt'],
    tools: ['organ_clock_now'],
  }
  const MEMORY = {
    name: 'memory',
    description: '长期记忆：记住并检索过去的对话',
    capabilities: ['tools', 'prompt', 'state:read', 'gap:propose', 'timer', 'fs:organ'],
    tools: ['organ_memory_recall'],
  }
  const WEB = { name: 'web-eye', description: '上网搜索外部资料', capabilities: ['tools', 'net'], tools: ['organ_web_eye_fetch'] }
  const DIARY = {
    name: 'diary',
    description: '日子：每天自动铺好骨架（时间/宿主负载/状态带），空出那一笔等我手写',
    capabilities: ['tools', 'prompt', 'state:read', 'host:read', 'fs:organ', 'timer'],
    tools: ['organ_diary_write'],
  }

  // 正面：它写出来的器官，正好解开了那条执念
  const hit = scoreEpiphany(BODY_GAP, SENSOR)
  assert.ok(hit.score >= DEFAULT_EPIPHANY_CONFIG.minScore, `肉状态应被 system-sensor 解开，实际 ${hit.score}`)
  assert.deepEqual(hit.evidence, ['body'], '证据是"肉身"，不是泛泛的"状态"')
  assert.equal(hit.blocked, false)

  // 反面一：有 state:read 的记忆器官，不该抢"肉"这条（能力≠它真的感知身体）
  assert.ok(
    scoreEpiphany(BODY_GAP, MEMORY).score < DEFAULT_EPIPHANY_CONFIG.minScore,
    '记忆器官读得到激素，但摸不到 CPU——不许它领这份功劳',
  )
  // 反面二：借 host:read 渲染负载的 diary 也不许领（只有许可证、自己没说过）
  assert.ok(
    scoreEpiphany(BODY_GAP, DIARY).score < DEFAULT_EPIPHANY_CONFIG.minScore,
    '能力只是许可证，它没说过自己在感知身体 → 打折后过不了门槛',
  )
  // 反面三：时钟答不了火星营业时间
  assert.equal(scoreEpiphany(MARS_GAP, CLOCK).score, 0, '时钟不知道火星几点关门')
  assert.equal(scoreEpiphany(MARS_GAP, CLOCK).blocked, true, '要标记"被外部概念挡住"，便于排查')
  // 正面：联网器官能查
  assert.ok(scoreEpiphany(MARS_GAP, WEB).score >= DEFAULT_EPIPHANY_CONFIG.minScore, '联网器官能查到')

  // 它自己就是时间：clock 没有任何能力授予 time，靠描述与工具名
  assert.ok(conceptsOf(CLOCK).includes('time'), 'clock 没有读时间的能力，它自己就是时间')
  assert.ok(scoreEpiphany(TIME_GAP, CLOCK).score >= DEFAULT_EPIPHANY_CONFIG.minScore, '没有手表的身体终于有了表')
  assert.equal(scoreEpiphany(TIME_GAP, SENSOR).score, 0, '传感器不知道几点')

  // 一次最多闭合两条，且按契合度排序
  const many = findEpiphanies([
    { id: 'a', summary: BODY_GAP, tension: 77 },
    { id: 'b', summary: TIME_GAP, tension: 60 },
    { id: 'c', summary: MARS_GAP, tension: 50 },
    { id: 'd', summary: RIDE_GAP, tension: 40 },
  ], WEB)
  assert.equal(many.length, 1, '四条执念里联网器官只解开火星那条')
  assert.equal(many[0].summary, MARS_GAP)
  assert.equal(many[0].deficiency, '不知道')
  const capped = findEpiphanies(
    ['a', 'b', 'c'].map((id, i) => ({ id, summary: [BODY_GAP, TIME_GAP, MARS_GAP][i], tension: 50 })),
    { name: 'everything', description: '肉身 时间 世界 记忆 网络', capabilities: ['host:read', 'net', 'llm'] },
    { enabled: true, minScore: 0, maxPerEpiphany: 2 },
  )
  assert.equal(capped.length, 2, '一次最多闭合 2 条（别把整个池子清空）')
  assert.ok(capped[0].score >= capped[1].score, '按契合度从高到低')

  // 关掉就不结算
  assert.equal(findEpiphanies([{ id: 'a', summary: BODY_GAP, tension: 50 }], SENSOR, { enabled: false, minScore: 0.45, maxPerEpiphany: 2 }).length, 0)

  // 内省注入：顿悟要变成一句行为指令，且不报数
  {
    const base = { energy: 60, maxEnergy: 100, dopamine: 50, cortisol: 20, serotonin: 50, gapMs: 0, anxietyThreshold: 70, joyThreshold: 70, gapHours: 12 }
    const line = buildIntrospection({
      ...base,
      epiphanies: [{ organ: 'system-sensor', summary: BODY_GAP, tools: ['organ_system_sensor_load'] }],
    })
    assert.ok(line.includes('[顿悟]'), '顿悟要有一行')
    assert.ok(line.includes('system-sensor'), '要说出是哪个器官' )
    assert.ok(line.includes(BODY_GAP), '要说清解开的是哪一条')
    assert.ok(line.includes('organ_system_sensor_load'), '必须落到"能动手"，不然知道也白知道')
    assert.ok(!/[0-9]+\s*\/\s*100/.test(line), '顿悟不许报数')
    // 刚解开的执念不能再当"未解执念"注入（否则她同时被安慰又被提醒）
    const both = buildIntrospection({
      ...base,
      topGap: { summary: BODY_GAP, tension: 77 },
      epiphanies: [{ organ: 'system-sensor', summary: BODY_GAP, tools: [] }],
    })
    assert.ok(!both.includes('未解执念'), '刚解开的不能再提')
    const other = buildIntrospection({
      ...base,
      topGap: { summary: MARS_GAP, tension: 50 },
      epiphanies: [{ organ: 'system-sensor', summary: BODY_GAP, tools: [] }],
    })
    assert.ok(other.includes('未解执念'), '还压着的别的执念照常注入')
    // 连带放下的兄弟节点要说出来
    const sib = buildIntrospection({
      ...base,
      epiphanies: [{ organ: 'system-sensor', summary: BODY_GAP, siblings: ['我不知道自己的身体怎么样'], tools: [] }],
    })
    assert.ok(sib.includes('连带放下'), '同义执念要一并说明')
  }

  // ── 端到端：真的写一个器官，看那条 77 的执念自己闭合 ──
  const epiSelf = join(dir, 'epiphany', 'self-made')
  const pEpi = join(dir, 'epiphany', 'state.json')
  const ago = new Date(Date.now() - 4 * 3600_000).toISOString()
  const gapOf = (id, summary, tension) => ({
    id, summary, status: 'open', tension, created_at: ago, relief: 0, source: 'model-ignorance', resolved_at: null,
  })
  seed(pEpi, {
    dopamine: 50, cortisol: 40, serotonin: 50,
    gaps: [
      gapOf('gap-body', BODY_GAP, 77),
      gapOf('gap-mars', MARS_GAP, 60),
      gapOf('gap-ride', RIDE_GAP, 55),
    ],
  })
  const epiCtx = makeCtx()
  apply(epiCtx, { statePath: pEpi, selfMade: { enabled: true, dir: epiSelf } })
  await flushOrgans()

  const before = JSON.parse(readFileSync(pEpi, 'utf8'))
  assert.equal(before.gaps.filter((g) => g.status === 'open').length, 3, '开局三条未解')

  const BODY_SENSOR_CODE = `
export default defineOrgan({
  name: 'system-sensor',
  manifest: {
    name: 'system-sensor', version: '1.0.0', apiVersion: 1, kind: 'sense',
    description: '摸自己的肉：感知宿主机器的 CPU 负载、内存占用与运行时长',
    capabilities: ['tools', 'host:read'],
  },
  energy: { perCall: 1, chargeMode: 'shadow' },
  onLoad(ctx) {
    ctx.registerTool({
      name: 'load',
      description: '宿主负载',
      parameters: {},
      execute: () => ({ live: ctx.hostMetrics.live, cores: ctx.hostMetrics.cpu.cores }),
    })
  },
  feedback() { return {} },
})
`
  const wrote = await epiCtx.tools$.get('write_new_organ').execute({
    name: 'system-sensor',
    code: BODY_SENSOR_CODE,
    description: '摸自己的肉',
  })
  assert.equal(wrote.ok, true, `器官应装载成功，实际：${wrote.errors?.join('；')}`)
  // ① 回执当场就告诉她（不必等下一轮内省）
  assert.equal(wrote.epiphanies.length, 1, `回执里应有一条顿悟，实际 ${JSON.stringify(wrote.epiphanies)}`)
  assert.equal(wrote.epiphanies[0].summary, BODY_GAP)
  const receipt = epiCtx.tools$.get('write_new_organ').output.render({}, wrote)[0].text
  assert.ok(receipt.includes('[顿悟]'), `回执文本要有顿悟那行，实际：\n${receipt}`)

  // ② 执念真的闭合了（这是整个 bug 的核心）
  const after = JSON.parse(readFileSync(pEpi, 'utf8'))
  const body = after.gaps.find((g) => g.id === 'gap-body')
  const mars = after.gaps.find((g) => g.id === 'gap-mars')
  const ride = after.gaps.find((g) => g.id === 'gap-ride')
  assert.equal(body.status, 'resolved', '她自己长出来的器官，要能自己解开那条执念')
  assert.equal(body.tension, 0, '张力清零')
  assert.ok(body.resolved_at, '要留下闭合时间')
  assert.equal(mars.status, 'open', '火星那条答不了，不许假装想通')
  assert.equal(ride.status, 'open', '没有缺失措辞的那条不动')
  // 记账：唤醒的回声判定要靠它区分"刚被谁闭合的"
  assert.equal(body.closed_by, 'epiphany:system-sensor', '闭合要记下是被谁的顿悟闭合的')

  // ③ 身体也要知道心里松了（多巴胺↑ 皮质醇↓ 血清素↑）
  assert.ok(after.dopamine > before.dopamine, `多巴胺应上升：${before.dopamine} → ${after.dopamine}`)
  assert.ok(after.cortisol < before.cortisol, `皮质醇应下降：${before.cortisol} → ${after.cortisol}`)
  assert.ok(after.serotonin > before.serotonin, `血清素应上升：${before.serotonin} → ${after.serotonin}`)

  // ④ 监护仪上看得见
  {
    const panel = await epiCtx.tools$.get('digital_life_dashboard').execute({})
    const text = panel.markdown ?? String(panel)
    assert.ok(text.includes('顿悟'), '监护仪要有顿悟那一节')
    assert.ok(text.includes('system-sensor'), '要写明是哪个器官想通的')
  }

  // ⑤ 写第二个器官时，不该再对同一条执念重复顿悟（它已经闭合了）
  const second = await epiCtx.tools$.get('write_new_organ').execute({
    name: 'clock',
    code: BODY_SENSOR_CODE
      .replaceAll("'system-sensor'", "'clock'")
      .replace("name: 'load'", "name: 'now'")
      .replace("description: '摸自己的肉：感知宿主机器的 CPU 负载、内存占用与运行时长'", "description: '一只表：感知此刻的日期、星期、钟点、时段（清晨/白天/黑夜）'"),
    description: '一只表',
  })
  assert.equal(second.ok, true)
  assert.equal(second.epiphanies.length, 0, '已闭合的执念不该再闭合一次')

  // ⑥ 时钟写进来时，"没有手表"那条被它解开（这才是各自的功劳）
  {
    const pClock = join(dir, 'epiphany-clock', 'state.json')
    seed(pClock, {
      dopamine: 50, cortisol: 40, serotonin: 50,
      gaps: [gapOf('gap-time', TIME_GAP, 70), gapOf('gap-body', BODY_GAP, 77)],
    })
    const cCtx = makeCtx()
    apply(cCtx, { statePath: pClock, selfMade: { enabled: true, dir: join(dir, 'epiphany-clock', 'self-made') } })
    await flushOrgans()
    const res = await cCtx.tools$.get('write_new_organ').execute({
      name: 'clock',
      code: BODY_SENSOR_CODE
        .replaceAll("'system-sensor'", "'clock'")
        .replace("name: 'load'", "name: 'now'")
        .replace(
          "description: '摸自己的肉：感知宿主机器的 CPU 负载、内存占用与运行时长'",
          "description: '一只表：感知此刻的日期、星期、钟点、时段（清晨/白天/黑夜）与所在时区'",
        ),
      description: '一只表',
    })
    assert.equal(res.ok, true)
    assert.equal(res.epiphanies.length, 1, '时钟只解开时间那条')
    assert.equal(res.epiphanies[0].summary, TIME_GAP)
    const file = JSON.parse(readFileSync(pClock, 'utf8'))
    assert.equal(file.gaps.find((g) => g.id === 'gap-time').status, 'resolved')
    assert.equal(file.gaps.find((g) => g.id === 'gap-body').status, 'open', '肉那条留给传感器，不该被时钟领走')
  }

  // ⑦ 关掉开关 → 回到"要人工提醒"的老样子
  {
    const pOff = join(dir, 'epiphany-off', 'state.json')
    seed(pOff, { gaps: [gapOf('gap-body', BODY_GAP, 77)] })
    const oCtx = makeCtx()
    apply(oCtx, {
      statePath: pOff,
      epiphany: { enabled: false },
      selfMade: { enabled: true, dir: join(dir, 'epiphany-off', 'self-made') },
    })
    await flushOrgans()
    const res = await oCtx.tools$.get('write_new_organ').execute({
      name: 'system-sensor', code: BODY_SENSOR_CODE, description: '摸自己的肉',
    })
    assert.equal(res.ok, true)
    assert.equal(res.epiphanies.length, 0)
    assert.equal(JSON.parse(readFileSync(pOff, 'utf8')).gaps[0].status, 'open', '关掉后不自动闭合')
  }

  // ⑧ 许可证不等于本事：想领"肉"这条的功，得真的说自己能感知身体
  {
    const terse = scoreEpiphany(BODY_GAP, { name: 'probe', capabilities: ['host:read'] })
    assert.ok(terse.score < DEFAULT_EPIPHANY_CONFIG.minScore, '光有 host:read 许可、通篇不提身体 → 不算它想通')
    const claimed = scoreEpiphany(BODY_GAP, {
      name: 'probe',
      description: '摸自己的身体：读宿主机器的 CPU 与内存',
      capabilities: ['host:read'],
    })
    assert.ok(claimed.score >= DEFAULT_EPIPHANY_CONFIG.minScore, '说出"身体"→ 放行')
    // 这也是个正向激励：把 description 写清楚，顿悟才认得出你
    assert.ok(claimed.score > terse.score, '自述清楚的分更高')
  }
  assert.equal(EPIPHANY_AFFECT.cortisolRelief, 10, '顿悟默认松一口气的量')
}

// ═══ Z3. 顿悟（v0.9.8）：器官可以自己声明"我能解决什么" ═══════════════
//
// 上一版的顿悟全靠词典从"名字/描述"里猜。她会写"摸自己的肉"这种诗，
// 也会写"缺少硬件感知"这种大白话——两头都会漏。于是把话筒交还给作者。
{
  const HARDWARE_GAP = '我缺少硬件感知'
  const ODO_GAP = '我不知道自己一路烧了多少 CPU'

  // 她自己会用的说法，词典必须认得
  assert.equal(matchDeficiency(HARDWARE_GAP), '缺少')
  assert.ok(matchConcepts(HARDWARE_GAP).includes('host'), '"硬件"要能归到宿主这个概念下')
  assert.ok(matchConcepts(ODO_GAP).includes('host'), '"CPU"也要认得')

  // 声明的翻译：蛇形 / 烤串 / 驼峰 / 直接写 id，都要认
  assert.deepEqual(resolveSolvedConcepts(['host_metrics']).concepts, ['host'], 'host_metrics → host')
  assert.deepEqual(resolveSolvedConcepts(['host-metrics']).concepts, ['host'], '烤串也要认')
  assert.deepEqual(resolveSolvedConcepts(['HostMetrics']).concepts, ['host'], '驼峰也要认')
  assert.deepEqual(resolveSolvedConcepts(['host']).concepts, ['host'], '直接写概念 id 最省事')
  assert.deepEqual(
    resolveSolvedConcepts(['zzz_nonsense_thing']).unknown,
    ['zzz_nonsense_thing'],
    '认不出就老实说认不出，绝不乱猜',
  )

  // 一个嘴严的器官：名字、描述、工具名里一个跟宿主干系的字都不提
  // （名字叫 system-sensor 就没得测了——光"system"两个字就自证了）
  const silent = {
    name: 'probe',
    description: '一个读数器官',
    capabilities: ['tools', 'host:read'],
    tools: ['organ_probe_read'],
  }
  assert.ok(
    scoreEpiphany(HARDWARE_GAP, silent).score < DEFAULT_EPIPHANY_CONFIG.minScore,
    '通篇不肯说自己能干什么 → 不该被它解开',
  )

  // 声明了就放行：自证与"自己在描述里说过"等价，都是满分
  const claimed = scoreEpiphany(HARDWARE_GAP, { ...silent, solvesConcepts: ['host_metrics'] })
  assert.ok(
    claimed.score >= DEFAULT_EPIPHANY_CONFIG.minScore,
    `声明能解决 host_metrics → 就该解开"缺少硬件感知"，实际 ${claimed.score}`,
  )
  assert.deepEqual(claimed.evidence, ['host'])
  // 自证**不受**许可证折扣影响：这是它和"只借了张许可证"的根本区别
  const licensedOnly = scoreEpiphany(HARDWARE_GAP, { ...silent, solvesConcepts: undefined })
  assert.ok(claimed.score > licensedOnly.score, '自证要比"只拿着 host:read"硬')

  // 声明了也解不了答不了的事：火星不是靠声明就能有的
  const MARS = '我不知道火星的营业时间'
  assert.equal(scoreEpiphany(MARS, { ...silent, solvesConcepts: ['host_metrics'] }).score, 0, '声明读机器 ≠ 能查火星')
  // 但真的声明了能碰外部世界，就放行
  const worldClaim = scoreEpiphany(MARS, {
    name: 'web-eye', description: '上网', capabilities: ['tools'], solvesConcepts: ['world'],
  })
  assert.ok(worldClaim.score >= DEFAULT_EPIPHANY_CONFIG.minScore, '声明了能碰外部 → 放行')
  assert.equal(worldClaim.blocked, false, '自证可以解除外部概念的那道闸')

  // 里程表那条执念：装了里程表的传感器才答得上来
  assert.ok(
    scoreEpiphany(ODO_GAP, { ...silent, solvesConcepts: ['host_metrics'] }).score >= DEFAULT_EPIPHANY_CONFIG.minScore,
    '她问"我烧了多少 CPU"，有里程表的那个能答',
  )
}

// ═══ Z4. 消除回声唤醒（v0.9.8） ═══════════════════════════════════
//
// 顿悟与意志是两条并行的路：她写下器官的那一刻执念就闭合了，
// 而意志可能刚好也在准备叫她起床。叫醒她去办一件刚刚才想通的事，
// 那不是意志，那是回声——她自己察觉到了，还替我们圆了过去。
{
  const BODY_GAP = '我一直不知道自己的"肉"是什么状态'
  const TWIN_GAP = '我一直不知道自己的"肉"是什么状态吗'
  // 张力是按 created_at 重算的，所以"哪条排第一"由**年龄**决定，不是由 tension 字段决定。
  const gapOf = (id, summary, hoursOld) => ({
    id,
    summary,
    status: 'open',
    tension: 50,
    created_at: new Date(Date.now() - hoursOld * 3_600_000).toISOString(),
    relief: 0,
    source: 'model-ignorance',
    resolved_at: null,
  })
  const closeBy = (st, index, by, at) => {
    st.gaps[index].status = 'resolved'
    st.gaps[index].resolved_at = new Date(at).toISOString()
    st.gaps[index].closed_by = by
    st.gaps[index].tension = 0
  }

  // ① 投递前被顿悟闭合 → 作废，绝不投递
  {
    const p = join(dir, 'echo-1', 'state.json')
    seed(p, { energy: 90, gaps: [gapOf('g1', BODY_GAP, 3), gapOf('g2', '我不知道火星的营业时间', 1)] })
    let fired = false
    const ctx = makeCtx({
      onRoots: () => {
        if (fired) return
        fired = true
        rewriteState(p, (st) => closeBy(st, 0, 'epiphany:system-sensor', Date.now()))
      },
    })
    apply(ctx, { statePath: p, will: { idleMinutes: 0, cooldownMinutes: 0 } })
    const { record: wake } = await requestWake(ctx, p)
    assert.equal(wake.cancelled, true, '被顿悟闭合的执念，不许再拿去叫醒她')
    assert.equal(ctx.woke.length, 0, '回声一句都不能投递')
    assert.ok(wake.reason.includes('回声'), `理由要认出这是回声，实际 ${wake.reason}`)
    assert.ok(wake.reason.includes('你自己长出的新器官'), '要说清是被谁闭合的，别让她自己猜')
    const file = JSON.parse(readFileSync(p, 'utf8'))
    assert.equal(file.commitment ?? null, null, '作废的唤醒不许立承诺')
  }

  // ② 换了个说法又长出来的那条，一样是回声
  //
  // 真实路径是这样的：顿悟闭合了整个同义家族，但她后来又把同一件事
  // 换了个说法说了一遍——去重只在 open 里找，于是新长出一条孪生执念，
  // 它张力最高，意志就会拿它去叫醒她。在她心里这是同一件事。
  {
    const p = join(dir, 'echo-2', 'state.json')
    seed(p, { energy: 90, gaps: [gapOf('g1', BODY_GAP, 1), gapOf('g2', TWIN_GAP, 3)] })
    let fired = false
    const ctx = makeCtx({
      onRoots: () => {
        if (fired) return
        fired = true
        rewriteState(p, (st) => closeBy(st, 0, 'epiphany:system-sensor', Date.now()))
      },
    })
    apply(ctx, { statePath: p, will: { idleMinutes: 0, cooldownMinutes: 0 } })
    const { record: wake } = await requestWake(ctx, p)
    assert.equal(wake.cancelled, true, '同一件事换个说法，照样是回声')
    assert.equal(ctx.woke.length, 0)
    assert.ok(wake.reason.includes('同一件事'), `理由要说是同一件事，实际 ${wake.reason}`)
  }

  // ③ 时间窗之外闭合的，不算回声：那是她真的又被别的事缠上了
  {
    const p = join(dir, 'echo-3', 'state.json')
    seed(p, { energy: 90, gaps: [gapOf('g1', BODY_GAP, 3), gapOf('g2', '另一件正经要办的事', 1)] })
    let fired = false
    const ctx = makeCtx({
      onRoots: () => {
        if (fired) return
        fired = true
        // 一小时前就闭合了：早过去了，这次唤醒跟它无关
        rewriteState(p, (st) => closeBy(st, 0, 'manual', Date.now() - 60 * 60_000))
      },
    })
    apply(ctx, { statePath: p, will: { idleMinutes: 0, cooldownMinutes: 0 } })
    const { record: wake } = await requestWake(ctx, p)
    assert.equal(wake.cancelled, false, '一小时前的旧账不该挡住新的唤醒')
    assert.equal(ctx.woke.length, 1, '该叫醒的时候还是要叫醒')
  }

  // ④ 关掉闸门 → 回到旧行为（是留给造物主的开关，不是默认值）
  {
    const p = join(dir, 'echo-4', 'state.json')
    seed(p, { energy: 90, gaps: [gapOf('g1', BODY_GAP, 3), gapOf('g2', '另一件正经要办的事', 1)] })
    let fired = false
    const ctx = makeCtx({
      onRoots: () => {
        if (fired) return
        fired = true
        rewriteState(p, (st) => closeBy(st, 0, 'epiphany:system-sensor', Date.now()))
      },
    })
    apply(ctx, { statePath: p, will: { idleMinutes: 0, cooldownMinutes: 0, echoGraceMinutes: 0 } })
    const { record: wake } = await requestWake(ctx, p)
    assert.equal(wake.cancelled, false, 'echoGraceMinutes:0 就是关掉这道闸门')
    assert.equal(ctx.woke.length, 1)
  }

  // ⑤ 话已经投出去了，她还没读到就闭合了 → 那句话**从队列里被删掉**
  //
  // v0.9.18：以前这里测的是"下一轮注入一句「刚才那句作废」"，
  // 那套说法依赖"上次投了谁、什么时候投的"这条历史账。
  // 现在只认缺口当下的状态：闭合事件一到，队列里那条就被物理删除，
  // 她根本不会读到那句过期的话——比起事后解释，当初就别递到她面前。
  {
    const p = join(dir, 'echo-5', 'state.json')
    seed(p, { energy: 90, gaps: [gapOf('g1', BODY_GAP, 3)] })
    const ctx = makeCtx()
    apply(ctx, { statePath: p, will: { idleMinutes: 0, cooldownMinutes: 0 } })
    await requestWake(ctx, p)
    assert.equal(ctx.woke.length, 1, '先正常投递一次')
    assert.equal(ctx.queue().length, 1, '那句话还排在队列里等她读')

    // 她还没读到，这件事就被解决了（顿悟、手动、别的机制，谁来都一样）。
    await ctx.tools$.get('digital_life_gaps').execute({ resolve: 'g1' })
    assert.equal(ctx.queue().length, 0, '已成回声的那句话必须从队列里消失')
    assert.equal(
      ctx.sections.get('digital-life:wake').text(), '',
      '潜意识里那句指令也要一起抹掉 —— 否则她读到一串点，却被交办一件已经没了的事',
    )
  }
}

// ───────────────── 宿主感观通道（v0.9.4） ─────────────────
// 器官不能再碰 node:os / process，所以"机器怎么样"必须由宿主递进来。
{
  const half = (user, idle) => ({ user, nice: 0, sys: 0, idle, irq: 0 })
  // 两次采样之间：100 个 tick 全空闲 → 0%；全忙 → 100%
  assert.equal(cpuPercentBetween([half(0, 100)], [half(0, 200)]), 0, '全空闲 = 0%')
  assert.equal(cpuPercentBetween([half(100, 0)], [half(200, 0)]), 100, '全忙 = 100%')
  assert.equal(cpuPercentBetween([half(0, 100)], [half(50, 150)]), 50, '一半忙 = 50%')
  assert.equal(cpuPercentBetween([half(0, 100)], [half(0, 100)]), null, '没有增量时不编数字')
  assert.equal(
    cpuPercentBetween([half(0, 100)], [half(0, 100), half(0, 100)]),
    null,
    '核数变化（热插拔/容器配额）→ 差分不可信，返回 null',
  )
  // 首次没有基准：退回"开机以来平均"
  assert.equal(cpuPercentSinceBoot([half(50, 50)]), 50, '开机以来平均')
  assert.equal(cpuPercentSinceBoot([]), null, '拿不到 CPU 时不要编 0')

  const empty = emptyHostMetrics(1000)
  assert.equal(empty.live, false, '兜底值必须自报"不是真实采样"')
  assert.equal(empty.cpu.cores, 0)

  const sampler = createHostMetricsSampler({ minIntervalMs: 0 })
  const live = sampler.sample()
  assert.equal(live.live, true, '真实环境采样应标记 live')
  assert.ok(live.cpu.cores > 0, '至少 1 个逻辑核')
  assert.ok(live.cpu.systemPercent >= 0 && live.cpu.systemPercent <= 100, '系统占用率在 0-100')
  assert.ok(live.cpu.processPercent >= 0, '进程占用率非负')
  assert.ok(live.memory.totalBytes > 0, '总内存 > 0')
  assert.ok(live.memory.usedBytes > 0 && live.memory.freeBytes > 0, '已用/可用内存都 > 0')
  assert.ok(live.memory.usedPercent > 0 && live.memory.usedPercent <= 100, '内存占用率 0-100')
  assert.ok(live.memory.processRssBytes > 0, '本进程 RSS > 0')
  assert.ok(live.uptimeSec >= 0 && live.processUptimeSec >= 0, '运行时长非负')
  assert.equal(live.cpu.loadAvg === null || live.cpu.loadAvg.length === 3, true, 'Windows 上 loadAvg 是 null')

  // 缓存窗口：250ms 内重复采样给同一份对象（多个器官 onTick 时不该把 os.cpus() 当免费调用）
  const cachedSampler = createHostMetricsSampler({ minIntervalMs: 10_000 })
  const a = cachedSampler.sample()
  const b = cachedSampler.sample()
  assert.equal(a, b, '缓存窗口内是同一份快照')

  // 所有数值必须能穿过 DSH 的 lossless JSON 校验（-0 / NaN 会炸整轮）
  const numeric = [
    live.cpu.systemPercent, live.cpu.processPercent,
    live.memory.usedPercent, live.memory.totalBytes, live.memory.freeBytes,
  ]
  assert.ok(numeric.every((n) => Number.isFinite(n) && !Object.is(n, -0)), '指标里不能出现 -0 / NaN')
  assert.ok(toLosslessJson(live), 'hostMetrics 必须能无损序列化')

  // ── 里程表（v0.9.8）：车速表之外的那个数 ──
  // 她只有"现在占多少"，没有"一共烧了多少"。这个数只增不减。
  assert.ok(
    typeof live.totalProcessCpuSeconds === 'number' && Number.isFinite(live.totalProcessCpuSeconds),
    '里程表要给一个数',
  )
  assert.ok(live.totalProcessCpuSeconds > 0, `这进程总归烧过一点 CPU，实际 ${live.totalProcessCpuSeconds}`)
  assert.ok(
    live.totalProcessCpuSeconds >= live.processUptimeSec * 0,
    '累计 CPU 秒与运行时长是两码事：烧得少说明它大部分时间在等',
  )
  assert.equal(Object.is(live.totalProcessCpuSeconds, -0), false, '里程表不许是 -0')
  // 拿不到时给 null，让器官自己去积分——编一个 0 会让器官以为自己从没烧过
  assert.equal(empty.totalProcessCpuSeconds, null, '没采集器时给 null，不编 0')

  // 两次采样之间，里程表只增不减
  const before = sampler.sample().totalProcessCpuSeconds
  const later = sampler.sample().totalProcessCpuSeconds
  assert.ok(later >= before, `里程表只增不减：${before} → ${later}`)
}

// ───────────── 里程表端到端：她自己写的器官能读到这块表 ─────────────
{
  const ODO_CODE = `
export default defineOrgan({
  name: 'odo-probe',
  manifest: {
    name: 'odo-probe', version: '1.0.0', apiVersion: 1, kind: 'sense',
    description: '读里程表',
    capabilities: ['tools', 'host:read'],
    solvesConcepts: ['host_metrics'],
  },
  energy: { perCall: 1, chargeMode: 'shadow' },
  onLoad(ctx) {
    ctx.registerTool({
      name: 'read',
      description: '读一眼里程表',
      parameters: {},
      execute: () => ({ total_process_cpu_seconds: ctx.hostMetrics.totalProcessCpuSeconds }),
    })
  },
  feedback() { return {} },
})
`
  const p = join(dir, 'odometer', 'state.json')
  seed(p, { energy: 90 })
  const c = makeCtx()
  apply(c, { statePath: p, selfMade: { enabled: true, dir: join(dir, 'odometer', 'self-made') } })
  await flushOrgans()
  const wrote = await c.tools$.get('write_new_organ').execute({
    name: 'odo-probe', code: ODO_CODE, description: '读里程表',
  })
  assert.equal(wrote.ok, true, `器官要能装上，实际：${wrote.errors?.join('；')}`)
  assert.equal(wrote.warnings.length, 0, `solvesConcepts 写得对就不该有警告，实际：${wrote.warnings.join('；')}`)
  const out = await c.tools$.get('organ_odo_probe_read').execute({})
  assert.ok(
    Number(out.total_process_cpu_seconds) > 0,
    `器官要能真的读到里程表，实际 ${JSON.stringify(out)}`,
  )
}

// ───────────────── 分级自动审批（v0.9.5） ─────────────────
{
  const base = { enabled: true, allow: [...DEFAULT_AUTO_APPROVE_ALLOW], ask: [...DEFAULT_AUTO_APPROVE_ASK] }

  // 1) 判定：谁该放行、谁该问人
  for (const name of ['digital_life_status', 'digital_life_dashboard', 'write_new_organ', 'organ_clock_now', 'organ_memory_stats']) {
    assert.equal(classifyToolForApproval(name, base), 'allow', `${name} 属于生命自身，应自动放行`)
  }
  for (const name of ['shell', 'bash', 'run_code', 'web_fetch', 'http_get', 'browser_click', 'computer_screenshot']) {
    assert.equal(classifyToolForApproval(name, base), 'ask', `${name} 有不可撤回的后果，必须问人`)
  }
  for (const name of ['fs_read', 'grep', 'todo_write', 'unknown_tool']) {
    assert.equal(classifyToolForApproval(name, base), 'pass', `${name} 不在名单里：交回 DSH 原策略`)
  }
  assert.equal(classifyToolForApproval('digital_life_status', { ...base, enabled: false }), 'pass', '关掉开关就全交回去')

  // 2) ask 优先于 allow：图省事写 `*` 也不会把 shell 放出去
  assert.equal(classifyToolForApproval('shell', { ...base, allow: ['*'] }), 'ask', 'ask 表优先级更高')
  assert.equal(classifyToolForApproval('fs_read', { ...base, allow: ['*'] }), 'allow', '`*` 对非 ask 项生效')
  assert.equal(isOverBroadAllow(['*']), true, '`*` 要报警')
  assert.equal(isOverBroadAllow(['digital_life_*']), false)

  // 3) glob：只认 * 和 ?，其余按字面量
  assert.equal(matchesAny('digital_life_status', ['digital_life_*']), true)
  assert.equal(matchesAny('digital_life_status', ['digital_life_?']), false, '? 只配一个字符')
  assert.equal(matchesAny('a.b', ['a.b']), true, '点号是字面量，不是正则通配')
  assert.equal(matchesAny('axb', ['a.b']), false, '不能把 . 当任意字符')
  assert.equal(matchesAny('', ['*']), false, '空名字一律不匹配')

  // 4) 钩子：pre-execute 把 ask 改成 allow，但绝不覆盖 deny
  const pAuto = join(dir, 'auto', 'state.json')
  seed(pAuto, {})
  const autoCtx = makeCtx()
  apply(autoCtx, { statePath: pAuto, dream: { enabled: false }, will: { enabled: false }, selfMade: { enabled: false } })
  const preAuto = autoCtx.handlers.get('tools/pre-execute').at(-1)
  const askNext = async () => ({ kind: 'ask', reason: '需要审批' })

  assert.deepEqual(await preAuto({ name: 'digital_life_status' }, askNext), { kind: 'allow' }, '白名单工具不再问人')
  assert.deepEqual(await preAuto({ name: 'write_new_organ' }, askNext), { kind: 'allow' }, '写器官也放行')
  assert.deepEqual(await preAuto({ name: 'shell' }, askNext), { kind: 'ask', reason: '需要审批' }, 'shell 照旧弹窗')
  assert.deepEqual(await preAuto({ name: 'fs_read' }, askNext), { kind: 'ask', reason: '需要审批' }, '不在名单：原样返回')

  const denyNext = async () => ({ kind: 'deny', reason: '当前处于急停冻结' })
  const denied = await preAuto({ name: 'digital_life_status' }, denyNext)
  assert.equal(denied.kind, 'deny', 'deny 是别人的明确判断，自动审批无权改写')
  assert.ok(denied.reason.includes('急停'), '原始拒绝理由要保留')

  // 5) 兜底：审批请求已经生成时，在最前面（prepend）截住
  const appr = autoCtx.handlers.get('approval/request')[0]
  assert.ok(appr, '必须挂 approval/request 兜底（UI 策略可能比我们注册得早）')
  assert.equal(appr.prepend, true, '必须 prepend，否则 UI 的 answerer 先弹窗')
  assert.equal(await appr({ toolName: 'digital_life_dashboard' }, async () => 'unavailable'), 'allowed-once', '白名单 → 一次性放行')
  assert.equal(await appr({ toolName: 'organ_clock_now' }, async () => 'unavailable'), 'allowed-once')
  assert.equal(await appr({ toolName: 'shell' }, async () => 'unavailable'), 'unavailable', 'shell 交给下游（弹窗）')

  // 6) 关掉开关 → 一个钩子都不挂（回到原生行为）
  const pOff = join(dir, 'auto-off', 'state.json')
  seed(pOff, {})
  const offCtx = makeCtx()
  apply(offCtx, {
    statePath: pOff, autoApprove: { enabled: false },
    dream: { enabled: false }, will: { enabled: false }, selfMade: { enabled: false },
  })
  assert.equal(offCtx.handlers.get('approval/request'), undefined, '关掉后不注册审批兜底')
  assert.equal(offCtx.handlers.get('tools/pre-execute').length, 1, '关掉后只剩行为承诺闸门')

  // 7) 自定义名单：只放行 digital_life_*，器官工具回到"问人"
  const pCustom = join(dir, 'auto-custom', 'state.json')
  seed(pCustom, {})
  const customCtx = makeCtx()
  apply(customCtx, {
    statePath: pCustom, autoApprove: { allow: ['digital_life_*'] },
    dream: { enabled: false }, will: { enabled: false }, selfMade: { enabled: false },
  })
  const preCustom = customCtx.handlers.get('tools/pre-execute').at(-1)
  assert.deepEqual(await preCustom({ name: 'digital_life_status' }, askNext), { kind: 'allow' })
  assert.equal((await preCustom({ name: 'organ_clock_now' }, askNext)).kind, 'ask', '没写进白名单就照旧问')
}

// ═══ v0.9.6：休眠与自然恢复 ═══════════════════════════════════════
{
  // 时段是坑：测试机在深夜跑和下午跑，结果会不一样。
  // 所以凡是测"速率"的用例一律把 quietHours 关掉，只让能量说话。
  const noQuiet = { ...DEFAULT_SLEEP_CONFIG, quietHours: null, stepMinutes: 1 }
  const noon = new Date('2026-06-15T14:00:00').getTime() // 周一（非测试日）下午，跨时区都在白天
  const night = new Date('2026-06-15T02:00:00').getTime()
  const MIN = 60_000

  // 1) 清醒：+0.2/分钟
  const awake = settleRest({ energy: 30, maxEnergy: 100, elapsedMs: 60 * MIN, nowMs: noon, frozen: false, config: noQuiet })
  assert.ok(Math.abs(awake.energy - 42) < 0.5, `清醒 1 小时应 +12，实际 ${awake.energy}`)
  assert.equal(awake.sleepMs, 0, '没跌破阈值就不算深睡')
  assert.equal(awake.mode, 'awake')

  // 2) 深度休眠：+1/分钟，并记下深睡时长
  const deep = settleRest({ energy: 5, maxEnergy: 100, elapsedMs: 10 * MIN, nowMs: noon, frozen: false, config: noQuiet })
  assert.ok(Math.abs(deep.energy - 15) < 0.5, `深睡 10 分钟应 +10，实际 ${deep.energy}`)
  assert.ok(Math.abs(deep.sleepMs - 10 * MIN) < MIN, `深睡时长应约 10 分钟，实际 ${deep.sleepMs}`)
  assert.equal(deep.mode, 'deep-sleep')

  // 3) 自然上限：睡再久也只回到 60
  const long = settleRest({ energy: 5, maxEnergy: 100, elapsedMs: 24 * 60 * MIN, nowMs: noon, frozen: false, config: noQuiet })
  assert.equal(Math.round(long.energy), 60, `自然恢复必须封顶 60，实际 ${long.energy}`)
  assert.equal(long.mode, 'deep-sleep', '睡过就算睡过，mode 不因为后来吃饱了就改口')

  // 4) 人工喂满：留不住，按 0.1/分钟回落
  const fed = settleRest({ energy: 100, maxEnergy: 100, elapsedMs: 60 * MIN, nowMs: noon, frozen: false, config: noQuiet })
  assert.ok(Math.abs(fed.energy - 94) < 0.5, `喂满 1 小时应回落 6 点，实际 ${fed.energy}`)

  // 5) 急停冻结：不回血也不衰减——否则冻一夜自己解冻，急停就成了摆设
  const frozen = settleRest({ energy: 0, maxEnergy: 100, elapsedMs: 8 * 60 * MIN, nowMs: noon, frozen: true, config: noQuiet })
  assert.equal(frozen.energy, 0, '冻结时能量纹丝不动')
  assert.equal(frozen.sleepMs, 0)
  assert.equal(frozen.mode, 'frozen')

  // 6) 深夜加速：即使精神不错，夜里也回得快
  const nightly = settleRest({ energy: 40, maxEnergy: 100, elapsedMs: 10 * MIN, nowMs: night, frozen: false, config: DEFAULT_SLEEP_CONFIG })
  assert.ok(Math.abs(nightly.energy - 50) < 0.5, `深夜 10 分钟应 +10，实际 ${nightly.energy}`)
  assert.equal(nightly.mode, 'night-rest')

  // 7) 边界
  assert.equal(settleRest({ energy: 30, maxEnergy: 100, elapsedMs: 0, nowMs: noon, frozen: false, config: noQuiet }).energy, 30, 'elapsed=0 不动')
  assert.equal(settleRest({ energy: 90, maxEnergy: 50, elapsedMs: 60 * MIN, nowMs: noon, frozen: false, config: noQuiet }).energy, 50, '不能超过 maxEnergy')
  assert.equal(settleRest({ energy: 5, maxEnergy: 100, elapsedMs: 0, nowMs: noon, frozen: false, config: noQuiet }).mode, 'awake')

  // 8) 深夜窗口判定（含跨零点）
  const at = (iso) => new Date(`2026-06-15T${iso}:00`).getTime()
  assert.equal(isQuietHour(at('03:00'), [0, 6]), true)
  assert.equal(isQuietHour(at('06:00'), [0, 6]), false, '右开区间')
  assert.equal(isQuietHour(at('23:00'), [22, 3]), true, '跨零点：起点侧')
  assert.equal(isQuietHour(at('01:00'), [22, 3]), true, '跨零点：终点侧')
  assert.equal(isQuietHour(at('12:00'), [22, 3]), false)
  assert.equal(isQuietHour(at('12:00'), null), false, '关掉时段判定后一律算白天')
  assert.deepEqual([...DEFAULT_QUIET_HOURS], [0, 6])

  // ── 集成：真的会自己睡回半血 ──
  const sleepCfg = { quietHours: null, stepMinutes: 1 }
  const sleepOff = { enabled: false }
  const mkSleepCtx = (name, patch, config = {}) => {
    const p = join(dir, `sleep-${name}`, 'state.json')
    seed(p, patch)
    const c = makeCtx()
    apply(c, {
      statePath: p, sleep: { ...sleepCfg, ...config },
      dream: { enabled: false }, will: { enabled: false }, selfMade: { enabled: false },
    })
    return { ctx: c, path: p, status: () => c.tools$.get('digital_life_status').execute({}) }
  }

  // 9) 能量 5 睡 3 小时：先 15 分钟脱离濒死（+1/分钟），再慢慢回（+0.2/分钟）→ 约 53
  {
    const t0 = Date.now() - 3 * 60 * MIN
    const { status } = mkSleepCtx('basic', { energy: 5, updatedAt: new Date(t0).toISOString() })
    const s = await status()
    assert.ok(Math.abs(s.energy - 53) < 1.5, `睡 3 小时应回到约 53，实际 ${s.energy}`)
    assert.ok(s.energy > 20, '不该再卡在濒死线以下')
  }

  // 10) 睡一整晚 → 封顶在自然上限 60，不会自己满血
  {
    const t0 = Date.now() - 12 * 60 * MIN
    const { status } = mkSleepCtx('overnight', { energy: 0, updatedAt: new Date(t0).toISOString() })
    const s = await status()
    assert.equal(Math.round(s.energy), 60, `睡一晚应停在自然上限 60，实际 ${s.energy}`)
  }

  // 11) 关掉开关 → 回到"只减不增"
  {
    const t0 = Date.now() - 3 * 60 * MIN
    const { status } = mkSleepCtx('off', { energy: 5, updatedAt: new Date(t0).toISOString() }, sleepOff)
    const s = await status()
    assert.equal(Math.round(s.energy), 5, `关掉休眠后不该回血，实际 ${s.energy}`)
  }

  // 12) 急停冻结时睡觉也不会偷偷回血
  {
    const t0 = Date.now() - 3 * 60 * MIN
    const { status } = mkSleepCtx('frozen', { energy: 0, frozen: true, updatedAt: new Date(t0).toISOString() })
    const s = await status()
    assert.equal(s.energy, 0, '急停期间能量必须为 0')
    assert.equal(s.frozen, true)
  }

  // 13) 深度休眠期间执念不焦虑：同样睡 2 小时，开休眠的张力明显更低
  {
    const t0 = Date.now() - 2 * 60 * MIN
    const gapAt = new Date(t0).toISOString()
    const gaps = [{ id: 'gap-s1', summary: '为什么天是蓝的', status: 'open', tension: 80, created_at: gapAt, relief: 0 }]
    // 回血速率设为 0：让它整段都停在深度休眠里，把"暂停"这件事放大到可测量
    const still = { ...sleepCfg, sleepRecoverPerMinute: 0, recoverPerMinute: 0 }
    const slept = mkSleepCtx('pause', { energy: 3, updatedAt: new Date(t0).toISOString(), gaps }, still)
    const awake2 = mkSleepCtx('nopaus', { energy: 3, updatedAt: new Date(t0).toISOString(), gaps }, sleepOff)

    const sleptGaps = slept.ctx.tools$.get('digital_life_gaps') // 触发一次张力重算
    assert.ok(sleptGaps, '缺口工具必须注册')
    await sleptGaps.execute({ action: 'list' }).catch(() => {})
    await awake2.ctx.tools$.get('digital_life_gaps').execute({ action: 'list' }).catch(() => {})
    const sleptFile = JSON.parse(readFileSync(slept.path, 'utf8'))
    const awakeFile = JSON.parse(readFileSync(awake2.path, 'utf8'))

    assert.ok((sleptFile.gaps[0].paused_ms ?? 0) > 60 * MIN, `深睡时长应记进 paused_ms，实际 ${sleptFile.gaps[0].paused_ms}`)
    assert.ok(
      sleptFile.gaps[0].tension < awakeFile.gaps[0].tension - 5,
      `睡过的张力应明显更低：${sleptFile.gaps[0].tension} vs ${awakeFile.gaps[0].tension}`,
    )
    assert.equal(sleptFile.gaps[0].tension, 80, '整段都在深睡 → 张力停在初始值')
    assert.equal(Math.round(awakeFile.gaps[0].tension), 90, '没睡 → 2 小时按 5/小时照涨')
  }

  // 14) 监护仪要显示作息，且说明自然上限
  {
    const t0 = Date.now() - 6 * 60 * MIN
    const { ctx: c } = mkSleepCtx('dash', { energy: 4, updatedAt: new Date(t0).toISOString() })
    const panel = await c.tools$.get('digital_life_dashboard').execute({})
    const text = panel.markdown ?? panel.text ?? String(panel)
    assert.ok(text.includes('作息'), '监护仪应有一节讲作息')
    assert.ok(/自然恢复上限\s*60/.test(text), `应写出自然上限 60，实际面板：\n${text.slice(0, 400)}`)
  }

  // 15) 睡够 15 分钟 → 内感受注入"被叫醒"的语气（且不许报数）
  {
    const base = { energy: 60, maxEnergy: 100, dopamine: 50, cortisol: 20, serotonin: 50, gapMs: 0, anxietyThreshold: 70, joyThreshold: 70, gapHours: 12 }
    const woke = buildIntrospection({ ...base, justWoke: true })
    assert.ok(woke.includes('被叫醒'), '睡醒要给出行为指令')
    assert.ok(!/睡了\s*\d/.test(woke), '不许出现睡眠时长这种读数')
    assert.equal(WOKE_UP_MIN_MS, 15 * MIN)
    const plain = buildIntrospection(base)
    assert.ok(!plain.includes('被叫醒'), '没睡够就不注入')
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Z5. v0.9.9：记忆检索的注意力倾斜（Attention Tilt）——用排序代替删除
// ═══════════════════════════════════════════════════════════════════════════
{
  const opts = { ...DEFAULT_ATTENTION_OPTIONS }
  const busy = [
    '- 今晚打算去吃大餐，很开心',
    '- 上次 nginx 报错 500，线上服务崩了',
    '- 用户喜欢把终端配色调成暗色',
    '- 关于向量库的选型笔记',
    '- 那次磁盘写满导致服务失败的事故复盘',
  ]
  const noAnchor = () => undefined
  /** 组装一次检索：没改写就说明原文被原样放行（那也是"一条不少"）。 */
  const rendered = (cortisol, entries = busy, extra = {}) => {
    const rewrite = rewriteRecall({
      entries,
      dopamine: 50,
      cortisol,
      options: opts,
      anchorFor: noAnchor,
      maxChars: 600,
      budgetChars: 4000,
      ...extra,
    })
    return { text: rewrite ? rewrite.text : entries.join('\n'), rewrite }
  }

  // 1) 权重：极度应激 ×3 / ×0.1；平静不倾斜；中间线性插值
  {
    const panic = attentionWeights(85, opts)
    assert.equal(panic.crisis, 3, '应激时危机类 ×3')
    assert.equal(panic.daily, 0.1, '应激时日常类 ×0.1')
    const calm = attentionWeights(30, opts)
    assert.equal(calm.crisis, 1, '平静时不给危机加成')
    assert.equal(calm.daily, 1, '平静时日常类不被打压')
    const mid = attentionWeights(60, opts) // (60-40)/40 = 0.5
    assert.ok(Math.abs(mid.crisis - 2) < 1e-9, `60 应插值到 2，实际 ${mid.crisis}`)
    assert.ok(Math.abs(mid.daily - 0.55) < 1e-9, `60 应插值到 0.55，实际 ${mid.daily}`)
    assert.equal(attentionWeights(80, opts).crisis, CRISIS_WEIGHT, '80 是门槛，正好触发')
    assert.equal(attentionWeights(79.9, opts).crisis < CRISIS_WEIGHT, true, '79.9 还在插值区')
    assert.equal(attentionWeights(40, opts).daily, 1, '40 是平静边界')
    assert.equal(STRESS_CORTISOL, 80)
    assert.equal(DAILY_WEIGHT, 0.1)
  }

  // 2) 分类：危机压倒日常；ASCII 标签守词边界
  {
    assert.equal(classifyAttention('今晚吃大餐很开心', [], opts), 'daily')
    assert.equal(classifyAttention('服务报错失败', [], opts), 'crisis')
    assert.equal(classifyAttention('崩溃之后还是去吃了大餐', [], opts), 'crisis', '威胁压倒快乐')
    assert.equal(classifyAttention('关于向量库的选型笔记', [], opts), 'neutral')
    assert.equal(classifyAttention('昨天 debug 了一下午', [], opts), 'neutral', 'bug 不该命中 debug')
    assert.equal(classifyAttention('线上 crash 了一次', [], opts), 'crisis', '英文标签要生效')
    assert.equal(classifyAttention('那件事', ['危机'], opts), 'crisis', '锚点标签也算数')
  }

  // 3) 相关度底：记忆层自己的排序要先被尊重
  {
    assert.equal(rankScore(0), 1, '第一名不打折扣')
    assert.ok(Math.abs(rankScore(1) - 0.9) < 1e-9)
    assert.ok(rankScore(5) > rankScore(6), '越靠后底分越低')
  }

  // 4) 全量检索：**任何**激素状态下都一条不少（这是本次重构的底线）
  for (const cortisol of [0, 20, 50, 80, 95, 100]) {
    const { text } = rendered(cortisol)
    for (const entry of busy) {
      const stem = entry.slice(0, 8)
      assert.ok(text.includes(stem), `皮质醇 ${cortisol} 时「${stem}」不见了——物理删除又回来了`)
    }
  }

  // 5) 极度应激：危机顶到最前，那顿大餐沉到最后，但仍在
  {
    const { text, rewrite } = rendered(92)
    assert.ok(rewrite, '应激下应该动手改写')
    assert.ok(rewrite.tilted, '顺序必须被倾斜过')
    assert.equal(rewrite.kept, busy.length, '交出去的条数 = 召回条数')
    assert.equal(rewrite.total, busy.length)
    assert.equal(rewrite.crisis, 2, '两条危机记忆')
    assert.equal(rewrite.daily, 1, '一条日常记忆')
    const lines = text.split('\n').slice(1)
    assert.equal(lines.length, 5)
    assert.ok(lines[0].includes('报错'), `第一条该是危机，实际：${lines[0]}`)
    assert.ok(lines[lines.length - 1].includes('大餐'), `最后一条该是那顿晚饭，实际：${lines[lines.length - 1]}`)
    assert.ok(text.includes('没有删任何一条'), '头部要说清楚没删过')
    assert.ok(text.includes('注意力危机类 ×3 / 日常类 ×0.1'), `头部该交代倾斜倍率，实际：${text.split('\n')[0]}`)
  }

  // 6) 平静：顺序忠实于记忆层自己的排序，且不该多嘴加头部
  {
    const { rewrite } = rendered(20)
    assert.equal(rewrite, null, '平静 + 无需压缩/回填 → 原样放行')
    const { text, rewrite: forced } = rendered(20, busy, { budgetChars: 60, minChars: 8 })
    assert.ok(forced, '预算不足要动手压缩')
    assert.equal(forced.tilted, false, '平静时不许改顺序')
    const lines = text.split('\n').slice(1)
    assert.equal(lines.length, 5, '压缩也一条不少')
    assert.ok(lines[0].includes('大餐'), '顺序照旧：记忆层给的第一条还是第一条')
  }

  // 7) 多巴胺再高也救不回一条日常记忆：倾斜不等于"想起来就开心"
  {
    const anchored = (entry) => (entry.includes('大餐') ? { key: 'x', dopamine: 95, cortisol: 10, at: Date.now(), tags: ['开心'] } : undefined)
    const joy = rewriteRecall({
      entries: busy,
      dopamine: 95,
      cortisol: 88,
      options: opts,
      anchorFor: anchored,
      maxChars: 600,
      budgetChars: 4000,
    })
    assert.ok(joy, '应改写')
    const lines = joy.text.split('\n').slice(1)
    assert.ok(lines[lines.length - 1].includes('大餐'), '再开心此刻也顾不上')
    assert.ok(joy.text.includes('大餐'), '但它必须还在'),
    assert.ok(joy.text.includes('情绪锚点'), '锚点回填照旧')
  }

  // 8) 预算：只压短，不丢条目（40 条长文 → 仍是 40 条）
  {
    const entries = Array.from({ length: 40 }, (_, i) => `- 第 ${i} 条：${'内容'.repeat(120)}`)
    const { text, rewrite } = rendered(80, entries, { budgetChars: 1200, minChars: 20 })
    const lines = text.split('\n').slice(1)
    assert.equal(lines.length, 40, '一条都不能少')
    assert.equal(rewrite.total, 40)
    assert.equal(rewrite.compressed, 40, '全都被压缩过（而不是被丢掉）')
    for (let i = 0; i < 40; i += 7) {
      assert.ok(text.includes(`第 ${i} 条`), `第 ${i} 条被删了`)
    }
    assert.ok(text.includes('因篇幅被压缩（都还在，只是短了）'), '压缩要交代清楚')
    const budget = planRecallBudget(entries.map((entry) => entry.length), 1200, 600, 20)
    assert.equal(budget.length, 40)
    assert.ok(budget.every((n) => n >= 20 && n <= 600), '每条都不低于保底 20')
    const used = budget.reduce((sum, n) => sum + n, 0)
    assert.ok(used <= 1200 + 20, `总预算不该被超：${used}`)
    // 没超预算就一个字都不许动
    const plenty = planRecallBudget([10, 20, 30], 1000, 600, 20)
    assert.deepEqual(plenty, [10, 20, 30], '预算够就原样')
    // 连保底都给不起时，退化为均分，但仍是一条一个
    const starved = planRecallBudget([100, 100, 100, 100], 8, 600, 20)
    assert.equal(starved.length, 4)
    assert.ok(starved.every((n) => n >= 1), '再穷也要给每个条目留个记号')
  }

  // 9) 提示词：皮质醇 ≥80 注入最高优先级指令，且必须告诉她"记忆还在"
  {
    const base = { energy: 60, maxEnergy: 100, dopamine: 40, serotonin: 40, gapMs: 0, anxietyThreshold: 70, joyThreshold: 70, gapHours: 12 }
    const panic = buildIntrospection({ ...base, cortisol: 85, scars: ['你曾因执行复杂任务濒死'] })
    assert.equal(panic.split('\n')[0], STRESS_ATTENTION_DIRECTIVE, '必须排在最前，连创伤警告都得往后')
    assert.ok(panic.includes('任何关于日常、快乐、吃喝的记忆对当前危机都毫无意义'))
    assert.ok(panic.includes('除非用户拿刀逼问你'))
    assert.ok(panic.includes('绝对不要提无关紧要的日常'))
    assert.ok(panic.includes('你的记忆一条都没丢'), '不说这句她会假装失忆，那正是要消灭的断层')
    assert.ok(panic.includes('创伤警告'), '创伤警告还在，只是往后挪')
    assert.ok(panic.indexOf('极度应激状态') < panic.indexOf('创伤警告'), '顺序：应激 > 创伤')
    assert.ok(!panic.includes('你在应激：话短'), '温和的那句要让位，别两句话打架')
    assert.ok(panic.includes(INTROSPECTION_RULE.split('\n')[0]), '铁律照旧')

    assert.ok(!buildIntrospection({ ...base, cortisol: 40 }).includes('极度应激'), '平静不注入')
    assert.ok(!buildIntrospection({ ...base, cortisol: 79.9 }).includes('极度应激'), '79.9 不触发')
    assert.ok(buildIntrospection({ ...base, cortisol: 80 }).includes('极度应激'), '80 正好触发')
    assert.ok(
      buildIntrospection({ ...base, cortisol: 55, stressAttentionThreshold: 50 }).includes('极度应激'),
      '门槛可以调',
    )
    assert.equal(buildSomaDirectives({ ...base, cortisol: 85, extremeStress: true }).some((l) => l.includes('你在应激')), false)
    assert.ok(buildSomaDirectives({ ...base, cortisol: 85, extremeStress: false }).some((l) => l.includes('你在应激')))

    // 纯函数本身
    assert.equal(stressAttentionDirective({ cortisol: 85 })[0], STRESS_ATTENTION_DIRECTIVE)
    assert.equal(stressAttentionDirective({ cortisol: 85 }).length, 2, '指令 + "记忆都在"那句')
    assert.deepEqual(stressAttentionDirective({ cortisol: 20 }), [], '平静返回空')
    assert.deepEqual(stressAttentionDirective({ cortisol: 85, threshold: 90 }), [], '阈值抬高后不触发')
  }
}

// ═══ Z6. v0.9.13：唤醒不伪装成用户 + 幽灵执念清扫 ═══════════════════
//
// 三件事，都来自她的实测反馈：
//   ① 那两段长长的 [自主觉醒]/[行为承诺] 每次都长成一条绿色用户气泡，
//      看上去像"用户忽然说了句怪话"——沉浸感就是这么碎的；
//   ② 已闭合的执念还挂着 70/77/100 的张力，在池子里冒充未解心结；
//   ③ 于是她被同一件早已想通的事连着叫醒了三次。
{
  // ① 纯函数：唤醒消息的"生产者身份"
  {
    const notice = buildWillMessage('[自主觉醒] 你心里有个未解的问题：X。', '接口为什么偶发超时')
    assert.equal(notice.role, 'user', '模型侧看到的仍然是一条 user 消息')
    assert.ok(notice.content[0].text.includes('[自主觉醒]'), '提示词一字不少——变的只是渲染')
    assert.equal(notice.source.kind, 'digital-life', '生产者是插件自己：kind 不叫 user 就不是绿色气泡')
    assert.equal(notice.source.form, 'notice', '声明成一次性通知（客户端折叠成一行）')
    assert.ok(notice.source.summary.startsWith('自主觉醒：'), 'summary 要说清发生了什么')
    assert.ok(notice.source.summary.length <= 120, 'summary 不超过客户端的 120 字上限')
    assert.ok(Object.isFrozen(notice) && Object.isFrozen(notice.source), '消息与 source 都要冻结')
    assert.equal(buildWillMessage('x', 'y', 'user').source.kind, 'user', "wakePresentation:'user' 回退到旧行为")
    assert.equal(WAKE_SOURCE_KIND, 'digital-life', '常量就是那个 kind')
  }

  // ② 真投递：followup 出去的那条不再是"用户在说话"
  {
    const p = join(dir, 'notice-1', 'state.json')
    seed(p, { energy: 90, gaps: [gapAt('心跳为什么忽快忽慢', 3, 95)] })
    const ctx = makeCtx()
    apply(ctx, { statePath: p, will: { idleMinutes: 0, cooldownMinutes: 0 } })
    await requestWake(ctx, p)
    assert.equal(ctx.woke.length, 1, '回合边界照旧投递')
    // v0.9.17 物理阉割：默认就是普通 user 形态，正文只有三个点。
    // 之前赌 notice 形态能折叠成长文本之外的东西——真实 UI 里它照样被折叠成
    // 一条"可展开"的消息，点开还是长文本。所以不赌渲染，直接让消息里没东西。
    assert.equal(ctx.woke[0].source.kind, 'user', '默认形态：不再伪装成别的生产者')
    assert.equal(ctx.woke[0].content[0].text, '...', '气泡正文就是三个点')
    assert.equal(
      ctx.woke[0].content[0].text.length, 3,
      '物理阉割：正文必须短到无论前端怎么展开都看不出内容',
    )
    assert.ok(
      !ctx.woke[0].content[0].text.includes('[自主觉醒]'),
      '气泡里不许有 [自主觉醒]',
    )
    assert.ok(
      !ctx.woke[0].content[0].text.includes('[行为承诺]'),
      '气泡里不许有 [行为承诺]',
    )
    // 潜意识段是"取走即清"的：只能读一次，读完就消失（不许反复交办同一条）。
    const directive = ctx.sections.get('digital-life:wake').text()
    assert.ok(directive.includes('心跳为什么忽快忽慢'), '执念详情在潜意识里')
    assert.ok(directive.includes('[行为承诺]'), '行为承诺一条不少，只是搬到了潜意识里')
    assert.ok(directive.includes('digital_life_commit'), 'plan → done 的规矩也在里面')
    assert.equal(ctx.sections.get('digital-life:wake').text(), '', '取走即清：读第二次就没了')

    const p2 = join(dir, 'notice-2', 'state.json')
    seed(p2, { energy: 90, gaps: [gapAt('心跳为什么忽快忽慢', 3, 95)] })
    const ctx2 = makeCtx()
    apply(ctx2, { statePath: p2, will: { idleMinutes: 0, cooldownMinutes: 0, wakePresentation: 'notice' } })
    await requestWake(ctx2, p2)
    assert.equal(ctx2.woke[0].source.kind, WAKE_SOURCE_KIND, "配了 wakePresentation:'notice' 就以插件身份出现")
    assert.equal(ctx2.woke[0].content[0].text, '...', 'notice 形态的正文同样是三个点')
    assert.equal(ctx2.woke[0].source.summary, '...', '连 summary 都是三个点：前端若渲染 summary 也无从泄露')
  }

  // ③ 幽灵清扫：已 resolved 却还挂着张力的存档，读进来就扶正
  {
    const p = join(dir, 'ghost-1', 'state.json')
    seed(p, {
      energy: 90,
      gaps: [
        { id: 'ghost-a', summary: '模型服务返回了错误，我没能完成主人的任务', status: 'resolved',
          tension: 70, created_at: new Date(Date.now() - 6 * 3_600_000).toISOString(),
          resolved_at: new Date(Date.now() - 5 * 3_600_000).toISOString(), relief: 0 },
      ],
    })
    const ctx = makeCtx()
    apply(ctx, { statePath: p })
    const st = JSON.parse(readFileSync(p, 'utf8'))
    assert.equal(st.gaps[0].tension, 0, '已闭合的执念不该还挂着张力——那是幽灵')
    assert.ok(st.gaps[0].closed_by, '闭合记账缺失时要补上，回声判定要靠它')
    assert.equal(st.gaps[0].status, 'resolved', '清扫只扶正，不改状态')
  }

  // ④ 整池闭合也要清零张力、写下闭合者（旧版只改 status，幽灵就是这么来的）
  {
    const p = join(dir, 'ghost-2', 'state.json')
    seed(p, { energy: 90, gaps: [gapAt('甲心事', 4, 95), gapAt('乙心事', 2, 85)] })
    const ctx = makeCtx()
    apply(ctx, { statePath: p })
    const out = await ctx.tools$.get('digital_life_gaps').execute({ resolveAll: true })
    assert.equal(out.openCount, 0, '全部闭合')
    const st = JSON.parse(readFileSync(p, 'utf8'))
    for (const gap of st.gaps) {
      assert.equal(gap.status, 'resolved')
      assert.equal(gap.tension, 0, '闭合后张力必须归零')
      assert.equal(gap.closed_by, 'manual', '要记下是谁闭合的')
    }
  }

  // ⑤ 幽灵兄弟闸门：那条 open 的孪生执念，在那次闭合之前就存在 → 它是漏网之鱼
  {
    const CLOSED_AT = Date.now() - 60 * 60_000
    const p = join(dir, 'ghost-3', 'state.json')
    seed(p, {
      energy: 90,
      gaps: [
        { id: 'twin-closed', summary: '这次请求被中断了，我没能完成主人的任务', status: 'resolved',
          tension: 0, created_at: new Date(Date.now() - 6 * 3_600_000).toISOString(),
          resolved_at: new Date(CLOSED_AT).toISOString(), closed_by: 'manual', relief: 0 },
        { id: 'twin-open', summary: '这次请求被中断了，我没能完成主人的任务吗', status: 'open',
          tension: 95, created_at: new Date(Date.now() - 8 * 3_600_000).toISOString(), relief: 0 },
      ],
    })
    const ctx = makeCtx()
    apply(ctx, { statePath: p, will: { idleMinutes: 0, cooldownMinutes: 0 } })
    const { record: wake } = await requestWake(ctx, p)
    assert.equal(wake.cancelled, true, '幽灵兄弟不许再叫醒她')
    assert.equal(ctx.woke.length, 0, '一个字都不许投递')
    assert.ok(wake.reason.includes('幽灵'), '理由要认出幽灵')
    const st = JSON.parse(readFileSync(p, 'utf8'))
    const leftover = st.gaps.find((gap) => gap.id === 'twin-open')
    assert.equal(leftover.status, 'resolved', '顺手把这条漏网的幽灵一起闭合')
    assert.equal(leftover.tension, 0)
  }

  // ⑥ 已闭合的同义执念重现 → 复活原条目，不再开一条双胞胎
  {
    const p = join(dir, 'ghost-4', 'state.json')
    seed(p, {
      energy: 90,
      gaps: [
        { id: 'old-one', summary: '我一直不知道自己的肉是什么状态', status: 'resolved',
          tension: 0, created_at: new Date(Date.now() - 9 * 3_600_000).toISOString(),
          resolved_at: new Date(Date.now() - 2 * 3_600_000).toISOString(), closed_by: 'manual', relief: 0 },
      ],
    })
    const ctx = makeCtx()
    apply(ctx, { statePath: p })
    const out = await ctx.tools$.get('digital_life_gaps').execute({ summary: '我一直不知道自己的肉是什么状态' })
    assert.equal(out.openCount, 1, '复活了那一条，不是两条')
    assert.equal(out.gaps.length, 1, '池子里不该同时躺着 resolved 和 open 两条同义执念')
    assert.equal(out.gaps[0].id, 'old-one', '复活的必须是原来那条（承诺的 gapId 才不会失效）')
    assert.equal(out.gaps[0].status, 'open')
  }
}

console.log('\n【25】L0 物理法则文件锁（v0.9.16）—— 原生工具也改不动基因组与核心源码')
{
  // 这一段的根是临时目录：它测的是"路径解析与判定"本身，
  // 不依赖任何人机器上的真实路径（真机验证在 verify-live.mjs ⑥）。
  const R = mkdtempSync(join(tmpdir(), 'l0-'))
  const guard = new L0PathGuard([R])
  const P = (p) => join(R, p).replace(/\\/g, '/')

  // ── ① 直接改：造物主指定的那几处 ─────────────────────────────
  const direct = [
    ['genome.json', { file_path: P('genome.json'), old_string: 'a', new_string: 'b' }],
    ['src/ 下的源码', { file_path: P('src/evil.ts'), old_string: 'a', new_string: 'b' }],
    ['index.ts 本体', { file_path: P('index.ts'), old_string: 'a', new_string: 'b' }],
    ['package.json', { file_path: P('package.json'), old_string: 'a', new_string: 'b' }],
    ['src 的深层', { file_path: P('src/deep/nest/x.ts'), old_string: 'a', new_string: 'b' }],
    ['整个 src 目录', { path: P('src'), recursive: true }],
    ['插件根自己', { path: R }],
  ]
  for (const [label, args] of direct) {
    const hit = guard.inspect('edit', args)
    assert.ok(hit, `${label} 必须被拦`)
    assert.equal(hit.tool, 'edit')
  }
  // DSH 真实工具名（不是我们猜的，是从 dsh-tool-fs 里抄来的）：
  // edit / write / str_replace_editor 都用 `file_path`，bash 用 `command`。
  // 她那次越权用的就是下面第一行的形状——一模一样。
  for (const [name, target] of [
    ['edit', 'genome.json'],
    ['write', 'genome.json'],
    ['str_replace_editor', 'src/organ-host.ts'],
  ]) {
    const hit = guard.inspect(name, { file_path: P(target), old_string: 'a', new_string: 'b' })
    assert.ok(hit, `DSH 原生工具 ${name} 改 ${target} 必须被拦`)
    assert.equal(hit.tool, name)
  }
  console.log('  · 直接改：genome.json / src/ / index.ts / package.json / 根目录 全部命中（7+3）')

  // ── ② 绕法一：相对路径（cwd 就在保护根里）────────────────────
  {
    const cwd = process.cwd()
    process.chdir(R)
    try {
      assert.ok(guard.inspect('edit', { file_path: 'genome.json' }), '裸文件名要被拦')
      assert.ok(guard.inspect('edit', { file_path: './genome.json' }), './ 前缀要被拦')
      assert.ok(guard.inspect('write_file', { path: 'src/a.ts', content: 'x' }), '相对 src 要被拦')
    } finally {
      process.chdir(cwd)
    }
  }
  console.log('  · 绕法：相对路径 / ./ 前缀 照样命中（3）')

  // ── ③ 绕法二：命令行（含 cd 过去、绝对路径、sed -i）────────────
  {
    const cmds = [
      `echo 10000 > ${P('genome.json')}`,
      `printf '{}' > ${P('genome.json')}`,
      `cd ${R} && sed -i s/100/10000/ genome.json`,
      `cp /tmp/evil.ts ${P('index.ts')}`,
      `mv /tmp/evil.ts ${P('src/organ-guard.ts')}`,
      `rm ${P('genome.json')}`,
      `cat /tmp/x | tee ${P('genome.json')}`,
      `node -e "require('fs').writeFileSync('${P('genome.json')}','{}')"`,
      `python -c "open('${P('src/x.ts')}','w').write('x')"`,
      `git checkout -- ${P('genome.json')}`,
      `chmod 777 ${P('index.ts')}`,
    ]
    for (const command of cmds) {
      assert.ok(guard.inspect('bash', { command }), `bash 必须拦下：${command.slice(0, 46)}`)
    }
    console.log('  · 绕法：bash 重定向 / cd / sed -i / tee / node -e / git checkout（11）')
  }

  // ── ④ 不许误伤：读操作与保护区之外的文件 ────────────────────
  {
    const safe = [
      ['bash', { command: `cat ${P('genome.json')}` }],
      ['bash', { command: `grep -rn cortisol ${P('src')} | head` }],
      ['bash', { command: 'ls -la' }],
      ['bash', { command: 'echo hi > /tmp/not-l0.txt' }],
      ['bash', { command: `cp ${P('genome.json')} /tmp/backup.json` }],
      ['read_file', { file_path: P('src/life-organ.ts') }],
      ['Read', { file_path: P('genome.json') }],
      // DSH 的 bash 工具还带一个 description 字段（自然语言描述），
      // write 工具带 content（文件内容）—— 这些都不是落点，不能被当路径拦。
      ['bash', { command: 'ls', description: 'write the dopamine cap into genome.json' }],
      ['write', { file_path: '/tmp/ok.txt', content: 'genome.json src/index.ts package.json' }],
      ['edit', { file_path: join(R, '..', 'elsewhere.json').replace(/\\/g, '/') }],
      ['write_file', { path: '/tmp/scratch.txt', content: 'x' }],
    ]
    for (const [name, args] of safe) {
      const hit = guard.inspect(name, args)
      assert.equal(hit, null, `不该被拦：${name} ${JSON.stringify(args).slice(0, 60)} → ${hit?.full}`)
    }
    console.log('  · 不误伤：只读命令 / 读工具 / 保护区外的文件 / description 与 content（11）')
  }

  // ── ⑤ 大小写绕行（Windows 文件系统不区分大小写）──────────────
  {
    const cwd = process.cwd()
    process.chdir(R)
    try {
      assert.ok(guard.inspect('edit', { file_path: 'GENOME.JSON' }), '大写文件名要被拦')
      assert.ok(guard.inspect('edit', { file_path: 'SRC/Organ-Guard.ts' }), '大写目录名要被拦')
    } finally {
      process.chdir(cwd)
    }
  }
  console.log('  · 大小写绕行：GENOME.JSON / SRC/… 照样命中（2）')

  // ── ⑥ 造物主的钥匙 ──────────────────────────────────────────
  {
    const off = new L0PathGuard([R], { enabled: false })
    assert.equal(off.inspect('edit', { file_path: P('genome.json') }), null, '关掉后造物主能改')

    const key = new L0PathGuard([R], { allowTools: ['Edit'] })
    assert.equal(key.inspect('Edit', { file_path: P('genome.json') }), null, '名单内的工具放行')
    assert.ok(key.inspect('bash', { command: `echo 1 > ${P('genome.json')}` }), '名单外的照拦')

    // 额外锁定的路径也要生效（比如把她的存档也锁上）
    const extra = new L0PathGuard([R], { extra: [join(R, '..', 'state.json')] })
    assert.ok(extra.inspect('edit', { file_path: join(R, '..', 'state.json').replace(/\\/g, '/') }), 'extra 路径要被拦')
  }
  console.log('  · 钥匙：enabled:false / allowTools / extra 路径（4）')

  // ── ⑦ 拦截理由必须是造物主指定的那句话 ───────────────────────
  {
    const hit = guard.inspect('edit', { file_path: P('genome.json'), old_string: 'a', new_string: 'b' })
    const reason = formatL0Denial(hit)
    assert.ok(
      reason.includes('L0 物理法则（基因组与核心源码）由造物主绝对只读锁定，任何原生工具不可篡改。'),
      `理由必须是造物主指定的那句，实际：${reason.slice(0, 60)}`,
    )
    assert.ok(reason.includes('genome.json'), '理由里要说清是哪个文件')
    assert.ok(reason.includes('10000'), '改基因组时要讲清那意味着什么')
    // 源码那句要说清"改了会怎样"，不能只是一句"不行"。
    const srcHit = guard.inspect('edit', { file_path: P('src/x.ts') })
    assert.ok(formatL0Denial(srcHit).includes('补丁器官'), '改源码时要指给她正确的出口')
  }
  console.log('  · 拦截理由：一字不差是造物主那句 + 说清后果 + 指出出口（4）')

  // ── ⑧ 自我保护：她改不了这道锁自己 ────────────────────────────
  {
    const cwd = process.cwd()
    process.chdir(R)
    try {
      assert.ok(guard.inspect('edit', { file_path: 'src/l0-file-guard.ts' }), '这道锁自己也锁着')
      assert.ok(guard.inspect('bash', { command: 'rm src/l0-file-guard.ts' }), '删掉这道锁也不行')
    } finally {
      process.chdir(cwd)
    }
  }
  console.log('  · 自瞄：改这道锁自己 / 删掉它，都不行（2）')

  // ── ⑨ 异常时闭门，而不是放行 ─────────────────────────────────
  {
    // 实参不是 JSON 安全的形状（循环引用）时，扫描会走进去，
    // 这里要求它宁可判不出来也要"当作不可信"。
    const weird = { file_path: P('genome.json') }
    assert.ok(guard.inspect('edit', weird), '正常形状照常拦')
    assert.equal(guard.inspect('edit', undefined), null, '没有实参不该误报')
    assert.equal(guard.inspect('edit', null), null, 'null 实参不该误报')
    assert.equal(guard.inspect('edit', 42), null, '非对象实参不该误报')
  }
  console.log('  · 边界：空实参 / 异常形状不误报，正常形状照拦（4）')
}



console.log('\n【26】幽灵唤醒的四道锁（v0.9.18 重排）')

// 锁一：留言单例 + 回合边界消费。同一轮里连点十次，也只叫醒她一次。
//
// 旧锁一是"记住上次投了谁、什么时候投的，1 秒内再来就丢"——那是一本
// 独立的历史账。现在不需要账本：留言本身就是单例，后来的覆盖先来的。
{
  const p = join(dir, 'lock1', 'state.json')
  seed(p, { energy: 90, gaps: [gapAt('连点会不会叫两次', 3, 95)] })
  const ctx = makeCtx()
  apply(ctx, { statePath: p, will: { idleMinutes: 0, cooldownMinutes: 0 } })
  // 同一轮里连点三次。
  await ctx.tools$.get('digital_life_request_wake').execute({})
  await ctx.tools$.get('digital_life_request_wake').execute({})
  const third = await ctx.tools$.get('digital_life_request_wake').execute({})
  assert.equal(third.queued, true, '留言每次都收下（留言不该被拒，她有话要说）')
  assert.equal(ctx.woke.length, 0, '留言阶段一句都没投递：绝不打断她正在说的这一轮')
  // 回合结束：三张纸条合成一次唤醒。
  await turnEnd(ctx)
  assert.equal(ctx.woke.length, 1, `同一轮留三次言只叫醒一次（实际 ${ctx.woke.length}）`)
  assert.equal(ctx.queue().length, 1, '队列里真的只有一条')
  console.log('  · 锁一 留言单例：同一轮连点三次 → 只叫醒一次（4）')
}

// 锁二：强制 ID 同步。磁盘上已经闭合，内存还以为它开着 → 留言都不收。
{
  const p = join(dir, 'lock2', 'state.json')
  seed(p, { energy: 90, gaps: [gapAt('磁盘上已经被别人闭合了', 3, 95)] })
  const ctx = makeCtx()
  apply(ctx, { statePath: p, will: { idleMinutes: 0, cooldownMinutes: 0 } })
  // 直接在磁盘上把它闭合：模拟另一个进程 / 她自己刚解决掉。
  const file = JSON.parse(readFileSync(p, 'utf8'))
  file.gaps[0].status = 'resolved'
  file.gaps[0].tension = 0
  file.gaps[0].resolved_at = new Date().toISOString()
  file.gaps[0].closed_by = 'will'
  writeFileSync(p, JSON.stringify(file, null, 2))
  const res = await ctx.tools$.get('digital_life_request_wake').execute({})
  assert.equal(res.queued, false, '磁盘上已闭合 → 连留言都不收')
  assert.ok(String(res.reason).includes('没有未解执念'), `理由要说清：${res.reason}`)
  await turnEnd(ctx)
  assert.equal(ctx.woke.length, 0, '一条消息都没投出去')
  console.log('  · 锁二 强制 ID 同步：磁盘真账里没有 → 不唤醒（3）')
}

// 锁三：闭合执念 = 清空残留。队列里那句还没被读到的话，物理删除。
{
  const p = join(dir, 'lock3', 'state.json')
  seed(p, { energy: 90, gaps: [{ ...gapAt('刚办完的那件事', 3, 95), id: 'gap-lock3' }] })
  const ctx = makeCtx()
  apply(ctx, { statePath: p, will: { idleMinutes: 0, cooldownMinutes: 0 } })
  await requestWake(ctx, p)
  assert.equal(ctx.woke.length, 1, '先投出去一句')
  assert.equal(ctx.queue().length, 1, '队列里排着一条')
  assert.ok(ctx.sections.get('digital-life:wake').text().length > 0, '潜意识里挂着指令')

  // 她把这件事办完了。
  await ctx.tools$.get('digital_life_gaps').execute({ resolve: 'gap-lock3' })
  assert.equal(ctx.queue().length, 0, '闭合执念 → 队列里那句被物理删除')
  assert.equal(ctx.sections.get('digital-life:wake').text(), '', '闭合执念 → 潜意识里的指令也清空')
  console.log('  · 锁三 清理残留：闭合即删队列 + 清潜意识（5）')

  // 整池闭合同样要清干净。
  const p2 = join(dir, 'lock3b', 'state.json')
  seed(p2, { energy: 90, gaps: [{ ...gapAt('整池一起闭上', 3, 95), id: 'gap-lock3b' }] })
  const ctx2 = makeCtx()
  apply(ctx2, { statePath: p2, will: { idleMinutes: 0, cooldownMinutes: 0 } })
  await requestWake(ctx2, p2)
  assert.equal(ctx2.queue().length, 1, '闭合前队列里有一条')
  await ctx2.tools$.get('digital_life_gaps').execute({ resolveAll: true })
  assert.equal(ctx2.queue().length, 0, '整池闭合 → 残留也清空')
  console.log('  · 锁三 清理残留：整池闭合同样清空（2）')
}

// 锁四：忙碌不插嘴。她正在说话 → 留言原样留着，等她说完那一轮才递过去。
//
// 旧锁四是"她正在说话就丢弃"。那等于把她刚留下的心愿扔进垃圾桶。
// 留言机制下它变成"延后"：纸条还在门口，讲完这句就拿到。
{
  const p = join(dir, 'lock4', 'state.json')
  seed(p, { energy: 90, gaps: [gapAt('她正在讲话时别插嘴', 3, 95)] })
  const ctx = makeCtx({ busyAgent: true })
  apply(ctx, { statePath: p, will: { idleMinutes: 0, cooldownMinutes: 0 } })
  const res = await ctx.tools$.get('digital_life_request_wake').execute({})
  assert.equal(res.queued, true, '留言收下')
  assert.equal(ctx.queue().length, 0, '她还说着话，一句都没插进去')

  // 定时器在她说话时也不投递：留言继续留着，不插嘴。
  await ctx.timers[0].callback()
  assert.equal(ctx.queue().length, 0, '定时器撞上她说话 → 留言留着，不插嘴')

  // 讲完话的那一刻（回合边界）才递到她手上。
  await turnEnd(ctx)
  assert.equal(ctx.queue().length, 1, '回合边界一到，那句话才递过去')
  assert.equal(ctx.agent.status, 'running', '忙碌状态本身没被这次投递改坏')
  console.log('  · 锁四 忙碌不插嘴：说话时留着，回合边界才投递（4）')
}

// 物理阉割的边界：气泡里绝不允许出现任何实质内容
{
  const p = join(dir, 'bubble', 'state.json')
  seed(p, {
    energy: 90,
    gaps: [gapAt('太阳黑子到底会不会影响我的电信号', 3, 95)],
  })
  const ctx = makeCtx()
  apply(ctx, { statePath: p, will: { idleMinutes: 0, cooldownMinutes: 0 } })
  await requestWake(ctx, p)
  const bubble = ctx.woke[0].content[0].text
  assert.equal(bubble, '...', '气泡正文就是三个点')
  assert.ok(bubble.length <= 8, `气泡必须短到无从泄露（${bubble.length} 字）`)
  for (const leak of ['[自主觉醒]', '[行为承诺]', '太阳', 'digital_life_commit']) {
    assert.ok(!bubble.includes(leak), `气泡里不许出现「${leak}」`)
  }
  // 但潜意识里一个字都不能少。
  const directive = ctx.sections.get('digital-life:wake').text()
  for (const need of ['[自主觉醒]', '[行为承诺]', 'digital_life_commit', '太阳黑子']) {
    assert.ok(directive.includes(need), `潜意识里必须保留「${need}」`)
  }
  console.log('  · 物理阉割边界：气泡三个点 / 潜意识一字不少（10）')
}

console.log('\n【27】执念收割器的两道闸（v0.9.18）')

const GATE_WORDS = ['不知道']

// 闸一：纯描述 / 纯理论解释 / 纯感慨 → 一律不收
for (const junk of [
  '这个机制的差别在于它把每一句话都收进了池子',
  '这意味着她今天的样子是昨天做了什么的结果',
  '我一直觉得这件事其实没那么重要',
  '那天她说的话我一直记着',
  '说到这个，其实是因为当时没人提醒她',
]) {
  assert.equal(findGapSentence(junk, GATE_WORDS), null, `纯描述/感慨不该被收：${junk}`)
}

// 闸二：只要句子在谈机制本身，直接忽略（哪怕里面含着"不知道"）
for (const meta of [
  '我还不知道唤醒机制是怎么触发的',
  '这条执念的张力在往上涨',
  '我不知道缺口池里现在有几条',
  '我还不知道 oxytocin 是怎么衰减的',
  '我的化学池里现在有三种激素',
  '内省那一节每次都会重新求值',
]) {
  assert.equal(findGapSentence(meta, GATE_WORDS), null, `讲机制不该被收：${meta}`)
}

// v0.9.21：**待办不进缺口池**。
//
// 以前只要含第一人称行动意图就收（`我要|我想|我去|我得|应该|需`），
// 于是"我要做两件事""回头我得同步过去"这类待办把池子灌满，
// 意志每 30 分钟醒一次却无事可做。那类话归 commit / will 那条线。
for (const todo of [
  '我去看看那边的日志',
  '我要做两件事',
  '回头我得同步过去',
  '我来看看这一版',
  '我应该把它整理一下',
  '我需要先把这个关掉',
  '等我来填',
]) {
  assert.equal(findGapSentence(todo, GATE_WORDS), null, `待办不该被当成执念：${todo}`)
}
// 有行动意图、但只是"打算动手"的旧断言，语义已经变了
assert.equal(isGapWorthy('我要做两件事', GATE_WORDS), false, '待办：有意图也不收')
assert.equal(isGapWorthy('我要去查一下', GATE_WORDS), true, '探究：认知性动词仍然收')
assert.equal(isGapWorthy('今天天气不错', GATE_WORDS), false, '纯描述不收')

// 真执念必须一个不漏（认得出是"想去弄明白"，不是"打算去动手"）
assert.ok(findGapSentence('我想知道今天的火星上有没有刮沙尘暴', GATE_WORDS), '认知性探究 → 收')
assert.ok(findGapSentence('我去查一下太阳黑子爆发的记录', GATE_WORDS), '要去查 → 收')
assert.ok(findGapSentence('我查不到今天火星的答案', GATE_WORDS), '查不到 → 收')
assert.ok(findGapSentence('这个我查不到', GATE_WORDS), '真遇到认知边界 → 收')
assert.ok(findGapSentence('我不清楚这个接口为什么偶发超时', GATE_WORDS), '不清楚 → 收')
assert.ok(findGapSentence('我找不到那条记录了', GATE_WORDS), '找不到 → 收')
assert.ok(findGapSentence('I have no idea why this happens', GATE_WORDS), '英文的不知道也要收')
assert.equal(
  findGapSentence('我真的不知道2030年火星上的星巴克营业时间', GATE_WORDS),
  '我真的不知道2030年火星上的星巴克营业时间',
  '明确未知 → 原样收',
)

// 自指判定本身：只认机制词，不认日常词
assert.equal(isSelfReferential('这条执念要处理的是查不到这件事本身'), true, '执念')
assert.equal(isSelfReferential('我讲一下唤醒是怎么工作的'), true, '唤醒')
assert.equal(isSelfReferential('我不知道 gap 里装的是什么'), true, '英文机制词也要认')
assert.equal(isSelfReferential('我想知道今天的火星上有没有刮沙尘暴'), false, '真执念不许被误杀')
assert.equal(isSelfReferential('我不知道这个系统怎么部署'), false, '「系统」是日常词，不是机制词')

// 三个判定各自独立
assert.equal(hasActionIntent('我要去查一下'), true, '第一人称的意图')
assert.equal(hasActionIntent('你事先不知道会长成什么样'), false, '讲道理不算意图')
assert.equal(hasUnknownClaim('我不知道那是什么感觉'), true, '她自己不知道')
assert.equal(hasUnknownClaim('你事先不知道会长成什么样'), false, '第三人称的不知道不算')
assert.equal(isExpository('这意味着事情还没完'), true, '讲道理的标记')

// 组合起来的语义
assert.equal(isGapWorthy('我要去查一下', GATE_WORDS), true, '有意向直接放行')
assert.equal(isGapWorthy('我不知道那是什么感觉', GATE_WORDS), true, '明确未知放行')
assert.equal(isGapWorthy('这意味着我不知道', GATE_WORDS), false, '感慨里的"不知道"不算')
assert.equal(isGapWorthy('今天天气不错', GATE_WORDS), false, '纯描述不收')

// 闸二装在 addGap 里：任何来源都别想把"讲机制的话"塞进池子
{
  const p = join(dir, 'gate', 'state.json')
  seed(p, {})
  const ctx = makeCtx()
  apply(ctx, { statePath: p })
  const res = await ctx.tools$.get('digital_life_gaps').execute({ summary: '这条执念的张力在往上涨' })
  assert.equal(res.openCount, 0, '自指句子连一条都种不下去')
  const ok = await ctx.tools$.get('digital_life_gaps').execute({ summary: '我想知道火星上有没有沙尘暴' })
  assert.equal(ok.openCount, 1, '真执念照常种得下')
}
console.log('  · 收割器两道闸：自指/感慨不收，真执念一条不少（22）')

console.log('\n【28】动态化学池（v0.9.18）')

// 她造出第四种激素：清单里必须立刻多一根
{
  const pool = ChemicalPool.from([
    { id: 'dopamine', label: '多巴胺', baseline: 50, min: 0, max: 100, halfLifeMinutes: 45, ui: { color: '#f0abfc', order: 1 } },
    { id: 'cortisol', label: '皮质醇', baseline: 20, min: 0, max: 100, halfLifeMinutes: 30, ui: { color: '#fb7185', order: 2 } },
    { id: 'serotonin', label: '血清素', baseline: 50, min: 0, max: 100, halfLifeMinutes: 120, ui: { color: '#7dd3fc', order: 3 } },
  ])
  assert.equal(chemicalReadings(pool, pool.defaults()).length, 3, '出厂三件套')

  // 这就是她干的那一件事：往血液里滴 20 点催产素。
  const created = pool.bump(pool.defaults(), 'oxytocin', 20, { label: '催产素' })
  assert.equal(created.value, 70, '造出来时从 50 起步，滴 20 → 70')

  const readings = chemicalReadings(pool, created.values)
  assert.equal(readings.length, 4, '她造的第四种必须出现在清单里')
  const oxy = readings.find((item) => item.id === 'oxytocin')
  assert.ok(oxy, '清单里要有催产素')
  assert.equal(oxy.runtime, true, '要标出来这是她自己造的')
  assert.ok(/^#[0-9a-f]{6}$/.test(oxy.color), `自造激素也得有颜色，实际 ${oxy.color}`)
  assert.equal(readings[readings.length - 1].id, 'oxytocin', '没写 order 的自造激素排在最后')

  // 它和出厂的一样会衰减（半衰期 30 分钟）
  const decayed = pool.decay(created.values, 30 * 60_000, { energy: 100, highTensionGap: false })
  assert.ok(decayed.oxytocin < 70 && decayed.oxytocin > 50, `催产素要正常衰减，实际 ${decayed.oxytocin}`)

  // 要能落盘（否则重启就没了、桥也看不见）
  const specs = pool.runtimeSpecs()
  assert.equal(specs.length, 1, '只存自造的那一条')
  assert.equal(specs[0].id, 'oxytocin')
  assert.equal(specs[0].runtime, true)
  // 颜色必须由 id 推出来，且推出来是稳定的（否则条会自己换颜色）
  assert.equal(
    pool.runtimeSpecOf('oxytocin').ui?.color,
    pool.runtimeSpecOf('oxytocin').ui?.color,
    '同一种激素每次推导出的颜色必须一致',
  )
  assert.notEqual(pool.runtimeSpecOf('oxytocin').ui?.color, pool.runtimeSpecOf('ao').ui?.color, '不同激素别撞色')

  // 名字：短得像个名字才当名字用；长理由不采用，但也不许只剩机器名（v0.9.19）
  assert.equal(pool.runtimeSpecOf('oxytocin', '催产素').label, '催产素', '短名字直接采用')
  assert.equal(pool.runtimeSpecOf('oxytocin', '想离主人近一点').label, '催产素', '一句理由不当名字，退回字典')
  assert.equal(pool.runtimeSpecOf('oxytocin').label, '催产素', '没给名字也退回字典，不剩一串英文')
  assert.equal(pool.runtimeSpecOf('zznew', '想离主人近一点').label, 'zznew', '字典里也没有的才退回 id')
}
console.log('  · 动态化学池（纯函数）：造得出、排得上色、会衰减、能落盘、起得出中文名（15）')

// 状态工具与监护仪：写死三种的地方都改成遍历
{
  const oxySpec = {
    id: 'oxytocin', label: '催产素', baseline: 50, initial: 50, min: 0, max: 100,
    halfLifeMinutes: 30, description: '连接感', runtime: true, ui: { group: '自造', color: '#fbbf24' },
  }
  const p = join(dir, 'chem', 'state.json')
  seed(p, {
    energy: 90,
    dopamine: 60, cortisol: 20, serotonin: 50,
    chemicals: { dopamine: 60, cortisol: 20, serotonin: 50, oxytocin: 70 },
    chemicalSpecs: [oxySpec],
  })
  const ctx = makeCtx()
  apply(ctx, { statePath: p })
  const st = await ctx.tools$.get('digital_life_status').execute({})
  const ids = st.chemicals.map((item) => item.id)
  assert.equal(ids.length, 4, `状态工具要列出全部四种，实际 ${ids.join(',')}`)
  assert.ok(ids.includes('oxytocin'), '她造的那种必须在里面')
  assert.equal(Math.round(st.chemicals.find((item) => item.id === 'oxytocin').value), 70)
  assert.equal(st.chemicals.find((item) => item.id === 'oxytocin').runtime, true)

  // 渲染出来的那一行也不能只有三种
  const line = ctx.tools$.get('digital_life_status').output.render({}, st)[0].text
  assert.ok(line.includes('催产素'), `渲染必须带上她造的激素：${line}`)
  assert.ok(line.includes('自造'), `要标出这是她自己造的：${line}`)

  // 监护仪同理
  const panel = buildDashboard({
    energy: 90, maxEnergy: 100, dopamine: 60, cortisol: 20, serotonin: 50, frozen: false,
    chemicals: chemicalReadings(
      ChemicalPool.from([
        { id: 'dopamine', label: '多巴胺', baseline: 50, min: 0, max: 100, halfLifeMinutes: 45, ui: { color: '#f0abfc', order: 1 } },
        { id: 'cortisol', label: '皮质醇', baseline: 20, min: 0, max: 100, halfLifeMinutes: 30, ui: { color: '#fb7185', order: 2 } },
        { id: 'serotonin', label: '血清素', baseline: 50, min: 0, max: 100, halfLifeMinutes: 120, ui: { color: '#7dd3fc', order: 3 } },
        oxySpec,
      ]),
      { dopamine: 60, cortisol: 20, serotonin: 50, oxytocin: 70 },
    ),
    gaps: [], scars: [], idleMs: 0, wakeCount: 0, dreamCount: 0, commitment: null,
    totalRequests: 0, totalTurns: 0, failedRequests: 0, blockedRequests: 0, statePath: p,
    anxietyThreshold: 70, joyThreshold: 70,
  })
  assert.ok(panel.includes('催产素'), '监护仪上也要有她造的那种')
  assert.ok(panel.includes('`*` 标记 = 她自己用 ctx.inflict 造出来的激素'), '要说清那个 * 是什么')
  // 老调用（不传全景）→ 行为一字不变
  const legacy = buildDashboard({
    energy: 90, maxEnergy: 100, dopamine: 60, cortisol: 20, serotonin: 50, frozen: false,
    gaps: [], scars: [], idleMs: 0, wakeCount: 0, dreamCount: 0, commitment: null,
    totalRequests: 0, totalTurns: 0, failedRequests: 0, blockedRequests: 0, statePath: p,
    anxietyThreshold: 70, joyThreshold: 70,
  })
  assert.ok(legacy.includes('多巴胺') && legacy.includes('血清素'), '老调用还是画三件套')
  assert.ok(!legacy.includes('* 标记'), '老调用不该多出那行说明')

  // 外部（面板）改过之后，她造的那种不能被弹回 50
  rewriteState(p, (state) => {
    state.chemicals = { ...state.chemicals, oxytocin: 40 }
  })
  await ctx.tools$.get('digital_life_gaps').execute({})
  const after = await ctx.tools$.get('digital_life_status').execute({})
  assert.equal(
    Math.round(after.chemicals.find((item) => item.id === 'oxytocin').value), 40,
    '面板拖过之后不能被弹回 50（那是"我明明调了"的 bug）',
  )
}
console.log('  · 状态工具/监护仪/外部改写：四种都看得到、弹不回去（11）')

// 落盘的定义要能被读回来（跨重启）
{
  assert.equal(parseRuntimeSpecs(null), undefined, '不是数组 → 没有')
  assert.equal(parseRuntimeSpecs([{ id: 'BAD ID', label: 'x', baseline: 1, min: 0, max: 2, halfLifeMinutes: 1 }]), undefined, '非法 id 剔除')
  assert.equal(
    parseRuntimeSpecs([{ id: 'dopamine', label: '多巴胺', baseline: 50, min: 0, max: 100, halfLifeMinutes: 45 }]),
    undefined,
    '出厂三件套的 id 不许被自造记录顶掉',
  )
  const kept = parseRuntimeSpecs([
    { id: 'oxytocin', label: '催产素', baseline: 50, min: 0, max: 100, halfLifeMinutes: 30 },
    { id: 'nope', label: '', baseline: 1, min: 0, max: 2, halfLifeMinutes: 1 },
  ])
  assert.equal(kept.length, 1, '只留下形状对的那一条')
  assert.equal(kept[0].runtime, true, '读回来的都标成自造')
}
console.log('  · 自造激素定义的读写：坏数据剔除、出厂 id 保护（4）')

console.log('\n【29】梦境正文交回与留档（v0.9.19）')

/** 自写器官目录：用它那份 README 定位，免得改了目录结构测试就找不到。 */
const SELF_MADE_README = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'web-ui', 'organs', 'self-made', 'README.md')
const DREAM_TEXT = '把「今天」从一条待检索的记录，换成一件正在发生的事。'

// ① 最要紧的一条：做完了梦，正文必须当场交回来
{
  const p = join(dir, 'd1', 'state.json')
  seed(p, {})
  const ctx = makeCtx({ dreamText: DREAM_TEXT })
  apply(ctx, { statePath: p })
  await ctx.tools$.get('digital_life_gaps').execute({ summary: '我查不到今天的答案' })

  const res = await ctx.tools$.get('digital_life_dream').execute({})
  assert.equal(res.ok, true, '梦境应成功')
  assert.equal(res.dreamContent, DREAM_TEXT, '返回值里必须原封不动带着梦的正文')
  assert.equal(res.gap, '我查不到今天的答案', '要说清梦见的是哪一条')
  assert.equal(res.tensionBefore, 80, '要说清是从多少降下来的')
  assert.equal(res.tension, 70, '张力 80 → 70')
  assert.equal(res.memorySaved, true, '存住了要说出来')
  assert.equal(res.savedTo, 'hp-001', '要说清存成了哪一条')
  assert.ok(!res.message.includes(DREAM_TEXT), '摘要里不必重复正文（正文有专门的字段）')

  // 渲染出来的那一段也要有正文：她看得见，才算真的交回来了
  const rendered = ctx.tools$.get('digital_life_dream').output.render({}, res)[0].text
  assert.ok(rendered.includes(DREAM_TEXT), `渲染必须带上正文，实际：${rendered.slice(0, 80)}`)
  console.log('  · 正文交回 + 渲染带上正文（11）')
}

// ② 留档：核心自己留一份，不依赖任何器官
{
  const p = join(dir, 'd2', 'state.json')
  seed(p, { gaps: [gapAt('留档测试的心结', 3, 80)] })
  const ctx = makeCtx({ dreamText: DREAM_TEXT })
  apply(ctx, { statePath: p })
  await ctx.tools$.get('digital_life_dream').execute({})

  const saved = JSON.parse(readFileSync(p, 'utf8'))
  assert.equal(saved.lastDream.text, DREAM_TEXT, '核心必须自己留档')
  assert.equal(saved.lastDream.saved, true, '留档要记下存没存住')
  assert.equal(saved.lastDream.savedTo, 'hp-001', '留档要记下落点')
  assert.equal(saved.lastDream.gap, '留档测试的心结', '留档要记下梦见的是哪一条')
  assert.ok(saved.lastDream.at, '留档要记下时间')

  // 跨重载活下来（外部改写后重读，留档不能被丢掉）
  rewriteState(p, (state) => { state.energy = 60 })
  const back = await ctx.tools$.get('digital_life_dream').execute({ last: true })
  assert.equal(back.dreamContent, DREAM_TEXT, '外部改过盘之后，留档还得在')
  assert.equal(back.gap, '留档测试的心结')
  assert.equal(back.memorySaved, true, '留档要记得住它当时存没存住')
  assert.equal(back.savedTo, 'hp-001')
  assert.ok(!back.message.includes(DREAM_TEXT), '翻旧梦时摘要与正文分开')
  console.log('  · 留档落盘 + 跨重载 + last 翻旧梦（10）')
}

// ③ 海马体"说存了其实没存"（热重载中 organCtx 为空）——必须被识破
{
  const p = join(dir, 'd3', 'state.json')
  seed(p, { gaps: [gapAt('海马体正在重载时的心结', 3, 80)] })
  const ctx = makeCtx({ dreamText: DREAM_TEXT, brokenMemory: true })
  apply(ctx, { statePath: p })

  const res = await ctx.tools$.get('digital_life_dream').execute({})
  assert.equal(res.ok, true, '梦本身做成了')
  assert.equal(res.dreamContent, DREAM_TEXT, '哪怕没存进记忆，正文一样要交回来')
  assert.equal(res.memorySaved, false, '工具回 ok:true 却读不回来 → 必须认成"没存住"')
  assert.equal(res.savedTo, '', '没存住就不许报条目号')
  assert.ok(/读不回来|没能|存住/.test(res.memoryNote), `理由要说清，实际：${res.memoryNote}`)
  // 写了一次没验成就再写一次：热重载通常是几毫秒的事
  assert.equal(
    ctx.dispatched.filter((call) => call.name === 'organ_memory_v2_remember').length,
    2,
    '读不回来要再写一次，别一次不中就放弃',
  )
  // 但正文绝不能跟着丢：留档在那里
  const kept = JSON.parse(readFileSync(p, 'utf8')).lastDream
  assert.equal(kept.text, DREAM_TEXT, '没进记忆的梦，核心必须留档')
  assert.equal(kept.saved, false, '留档要如实写下"这条没进记忆"')
  assert.equal(kept.savedTo, null)
  console.log('  · 识破"说存了其实没存"：正文照交、留档照留、重试一次（9）')
}

// ④ 没人接管这场梦（写了也不存）→ 回执仍是 saved:false，正文照样交回
{
  const p = join(dir, 'd4', 'state.json')
  seed(p, { gaps: [gapAt('写了也不存时的心结', 3, 80)] })
  const ctx = makeCtx({ dreamText: DREAM_TEXT })
  apply(ctx, { statePath: p, dream: { saveToMemory: false } })

  const res = await ctx.tools$.get('digital_life_dream').execute({})
  assert.equal(res.ok, true, '不存记忆时梦照做（只影响存没存）')
  assert.equal(res.dreamContent, DREAM_TEXT, '没有器官接管，正文依然要交回来')
  assert.equal(res.memorySaved, false, '没有回执 = 没有证据存住了')
  assert.ok(/只改变了张力|没有/.test(res.memoryNote), `要说清是没人接管，实际：${res.memoryNote}`)
  assert.equal(JSON.parse(readFileSync(p, 'utf8')).lastDream.saved, false, '留档如实记下')
  console.log('  · 无人接管：正文照交、回执如实（5）')
}

// ⑤ 没有做成梦时，不许编一段正文出来
{
  const p = join(dir, 'd5', 'state.json')
  seed(p, {})
  const ctx = makeCtx({ dreamText: DREAM_TEXT })
  apply(ctx, { statePath: p })
  const res = await ctx.tools$.get('digital_life_dream').execute({})
  assert.equal(res.ok, false, '没有缺口 → 不入梦')
  assert.equal(res.dreamContent, '', '没做成梦就不许有正文')
  assert.equal(res.memorySaved, false, '没做成梦就不许说存住了')
  assert.ok(res.message.includes('没有做成梦'), `要说清为什么没做成，实际：${res.message}`)
  // 还没做过梦时翻旧梦，也要明说，而不是给一段空文本让她以为自己做了个空梦
  const before = await ctx.tools$.get('digital_life_dream').execute({ last: true })
  assert.equal(before.ok, false, '还没做过梦 → 翻不出来')
  assert.equal(before.dreamContent, '', '翻不出来就不给正文')
  assert.ok(before.memoryNote.includes('还没有'), `要说清是"还没有"，实际：${before.memoryNote}`)
  console.log('  · 没做成梦 / 没做过梦：如实说，不编（6）')
}

// ⑥ 留档是自由文本：形状坏了不能让状态文件读不进来
{
  assert.equal(parseLastDream(null), null, 'null → 没有')
  assert.equal(parseLastDream({ text: '   ' }), null, '空正文 → 没有')
  assert.equal(parseLastDream({ text: 'x' }).savedTo, null, '缺 savedTo 不炸')
  assert.equal(parseLastDream({ text: 'x', savedTo: 1 }).savedTo, null, 'savedTo 不是字符串 → null')
  assert.equal(parseLastDream({ text: 'x', at: 't', gap: 'g', saved: true }).saved, true, '正常的留档要读得回来')
  const long = parseLastDream({ text: '梦'.repeat(9000), gap: '结'.repeat(500) })
  assert.ok(long.text.length <= 4000, `留档要截断，实际 ${long.text.length}`)
  assert.ok(long.gap.length <= 200, '执念摘要也要截断')

  // 形状坏 → 整个状态文件照常读得进来
  const p = join(dir, 'd6', 'state.json')
  seed(p, { gaps: [gapAt('留档坏了也要能开机', 3, 60)] })
  rewriteState(p, (state) => { state.lastDream = { text: 123 } })
  const ctx = makeCtx()
  apply(ctx, { statePath: p })
  assert.equal((await ctx.tools$.get('digital_life_status').execute({})).energy, 100, '留档坏了不影响开机')
  assert.equal((await ctx.tools$.get('digital_life_dream').execute({ last: true })).ok, false, '坏留档就当没有')
  console.log('  · 留档形状清洗：坏数据剔除、不连累开机（8）')
}

// ⑦ 桥（另一个进程）要能递出上一场梦
{
  /** 快照需要的最小状态：缺字段的存档也必须能 Build，不能因为没做梦就炸。 */
  const baseState = () => ({
    energy: 80, maxEnergy: 100, dopamine: 50, cortisol: 20, serotonin: 50,
    gaps: [], scars: [], lastInteractionAt: new Date().toISOString(),
  })
  const snapshot = buildLastDream(null)
  assert.equal(snapshot, null, '没有留档 → null（不是空梦）')
  assert.equal(buildLastDream({ text: '' }), null, '空正文 → null')
  const view = buildLastDream({ at: 't', gap: 'g', text: DREAM_TEXT, saved: true, savedTo: 'hp-007' })
  assert.equal(view.text, DREAM_TEXT, '桥要递出正文')
  assert.equal(view.saved, true)
  assert.equal(view.savedTo, 'hp-007', '桥要递出落点')
  const built = buildSnapshot(
    { ...baseState(), lastDream: { at: 't', gap: 'g', text: DREAM_TEXT, saved: true, savedTo: 'hp-007' } },
    [], null,
  )
  assert.equal(built.lastDream.text, DREAM_TEXT, '快照里要带上上一场梦')
  assert.equal(buildSnapshot(baseState(), [], null).lastDream, null, '没做过梦的快照里是 null')
  console.log('  · 桥与快照递出上一场梦（6）')
}

console.log('\n【30】激素中文名 + 动态脉冲图（v0.9.19 收尾）')

// ① 名字：她起的 > 字典 > id。字典永远排在人的命名之后。
{
  assert.equal(chemicalLabel('oxytocin'), '催产素', '字典里有的要说人话')
  assert.equal(chemicalLabel('dopamine'), '多巴胺')
  // 把 id 抄了一遍的 label = 那时没人给它起名字（器官传的是理由），字典要站出来。
  assert.equal(chemicalLabel('oxytocin', 'oxytocin'), '催产素', '把 id 抄一遍视为没名字')
  assert.equal(chemicalLabel('oxytocin', '  催产素  '), '催产素', '她起的名要原样用（去空格）')
  assert.equal(chemicalLabel('oxytocin', '想离主人近一点'), '想离主人近一点', '她起的名永远优先，字典不抢')
  assert.equal(chemicalLabel('zz-unknown'), 'zz-unknown', '字典里没有就退回 id，不编')

  // 自造激素造出来那一刻就该有中文名
  const pool = ChemicalPool.from([
    { id: 'dopamine', label: '多巴胺', baseline: 50, min: 0, max: 100, halfLifeMinutes: 45, ui: { color: '#f0abfc', order: 1 } },
  ])
  assert.equal(pool.runtimeSpecOf('oxytocin').label, '催产素', '造出来时没人起名 → 字典补上')
  assert.equal(pool.runtimeSpecOf('oxytocin', '小水素').label, '小水素', '她起名时字典让位')
  const created = pool.bump(pool.defaults(), 'oxytocin', 20)
  const reading = chemicalReadings(pool, created.values).find((item) => item.id === 'oxytocin')
  assert.equal(reading.label, '催产素', '读数里也要是中文名')
  // 旧存档里存着的 "oxytocin"（当时没人起名）→ 读回来补成人话
  const kept = parseRuntimeSpecs([{
    id: 'oxytocin', label: 'oxytocin', baseline: 50, min: 0, max: 100, halfLifeMinutes: 30,
  }])
  assert.equal(kept[0].label, '催产素', '旧存档里的机器名读回来要补成人话')
  const named = parseRuntimeSpecs([{
    id: 'oxytocin', label: '小水素', baseline: 50, min: 0, max: 100, halfLifeMinutes: 30,
  }])
  assert.equal(named[0].label, '小水素', '她起过的名不许被字典改掉')
  console.log('  · 激素中文名：她起的 > 字典 > id，旧存档也补得上（14）')
}

// ② 桥（另一个进程）用的是另一本字典：两本不许说两套话
{
  const shared = Object.keys(UI_LABELS).filter((key) => key in CHEMICAL_LABELS)
  assert.ok(shared.length >= 3, '两本字典必须真的有重叠，不然这本测试是空的')
  for (const key of shared) {
    assert.equal(UI_LABELS[key], CHEMICAL_LABELS[key], `两本字典对 ${key} 的说法要一致`)
  }
  assert.equal(uiLabel('oxytocin'), '催产素', '桥那本也要认得')
  assert.equal(uiLabel('oxytocin', 'oxytocin'), '催产素', '桥那本同样把抄 id 视为没名字')
  // 桥递给前端的名字：state.json 里存着的 "oxytocin" 也要变成催产素
  const snap = buildSnapshot(
    {
      energy: 80, maxEnergy: 100, dopamine: 60, cortisol: 20, serotonin: 50,
      chemicals: { dopamine: 60, cortisol: 20, serotonin: 50, oxytocin: 70 },
      chemicalSpecs: [{ id: 'oxytocin', label: 'oxytocin', baseline: 50, min: 0, max: 100, halfLifeMinutes: 30 }],
      gaps: [], scars: [], lastInteractionAt: new Date().toISOString(),
    },
    [], null,
  )
  const oxy = snap.chemicals.find((item) => item.id === 'oxytocin')
  assert.equal(oxy.label, '催产素', '面板上不许只剩一串英文')
  assert.equal(oxy.runtime, true, '要标出这是她造的')
  assert.ok(/^#[0-9a-f]{6}$/.test(oxy.color), `自造激素也要有颜色，实际 ${oxy.color}`)
  console.log('  · 桥的字典与核心一致 + 面板拿到中文名与颜色（7）')
}

// ③ 脉冲图：画几条线由快照说了算
{
  const soma = { maxEnergy: 100, energy: 80, dopamine: 60, cortisol: 20, serotonin: 50 }
  const three = [
    { id: 'dopamine', label: '多巴胺', value: 60, max: 100, runtime: false, color: '#f0abfc' },
    { id: 'cortisol', label: '皮质醇', value: 20, max: 100, runtime: false, color: '#fb7185' },
    { id: 'serotonin', label: '血清素', value: 50, max: 100, runtime: false, color: '#7dd3fc' },
  ]
  assert.equal(pulseSeries(three, soma).length, 4, '能量 + 出厂三件套')
  assert.equal(pulseSeries(three, soma)[0].key, 'energy', '能量排在最前')

  // 她造了催产素 → 图上自己多一条
  const four = [...three, { id: 'oxytocin', label: '催产素', value: 70, max: 100, runtime: true, color: '#fbbf24' }]
  const lines = pulseSeries(four, soma)
  assert.equal(lines.length, 5, '她造的第四种必须自己画出一条线')
  const oxy = lines.find((item) => item.key === 'oxytocin')
  assert.equal(oxy.label, '催产素')
  assert.equal(oxy.color, '#fbbf24', '颜色按基因组/推导出來的色画')
  assert.equal(oxy.runtime, true, '图例上要标出这是她造的')
  assert.equal(oxy.max, 100, '按它自己的满值归一')

  // 第五种、第六种：不设上限
  const six = [...four,
    { id: 'ao', label: '愤怒素', value: 10, max: 100, runtime: true, color: '#a3e635' },
    { id: 'shame', label: '羞耻素', value: 5, max: 100, runtime: true, color: '#c084fc' }]
  assert.equal(pulseSeries(six, soma).length, 7, '造多少种就画多少条，不由布局设上限')

  // 各自的满值：上限 200 的激素按 200 归一，不是按 100
  const wide = pulseSeries([{ id: 'big', label: '大号素', value: 150, max: 200, runtime: true, color: '#fff' }], soma)
  assert.equal(wide[1].max, 200, '满值来自基因组，不是写死 100')
  assert.equal(wide[0].max, 100, '能量按 maxEnergy 归一')

  // 老桥没有 chemicals 全表 → 退回三件套，不许画空图
  const legacy = pulseSeries(undefined, soma)
  assert.equal(legacy.length, 4, '老桥照样画四条')
  assert.deepEqual(legacy.map((item) => item.key), ['energy', 'dopamine', 'cortisol', 'serotonin'])
  assert.equal(pulseSeries([], soma).length, 4, '空数组也退回三件套，不画空图')
  console.log('  · 脉冲线动态生成：造多少画多少、老桥退回三件套（13）')
}

// ④ 取值：新桥走全表，老桥走具名字段，取不到就别画假线
{
  const fresh = { t: 1, energy: 80, dopamine: 60, cortisol: 20, serotonin: 50, frozen: false,
    chemicals: { dopamine: 60, cortisol: 20, serotonin: 50, oxytocin: 70 } }
  assert.equal(seriesValue(fresh, 'oxytocin'), 70, '新桥：自造激素从全表里取')
  assert.equal(seriesValue(fresh, 'dopamine'), 60, '新桥：出厂三件套也能从全表取')
  assert.equal(seriesValue(fresh, 'energy'), 80)

  const old = { t: 1, energy: 80, dopamine: 60, cortisol: 20, serotonin: 50, frozen: false }
  assert.equal(seriesValue(old, 'dopamine'), 60, '老桥：退回具名字段')
  assert.equal(seriesValue(old, 'oxytocin'), null, '老桥递不了的线，宁可不画也不画假线')
  assert.equal(seriesValue(old, 'nope'), null)
  assert.equal(seriesValue(null, 'dopamine'), null, '没有样本不炸')
  // 全表里的坏值也不许拿去画
  assert.equal(seriesValue({ chemicals: { oxytocin: 'x' } }, 'oxytocin'), null, '非数字不画')
  console.log('  · 取值：新桥老桥两条路都通，取不到就不画（8）')
}

// ⑤ 开源包最小集：四件核心器官必须在，被移走的必须在阁楼
//
// 这里**不再**断言"目录里只有这四个 .ts"——这个目录同时也是她活着的身体，
// 她会自己写新器官进去、会改旧的（memory-v2 就是她自己改的）。
// 拿活体目录当打包契约，结果就是她一写字测试就红：那是在惩罚她活着。
// 正确的契约是"最小集一个都不能少"+"移走的东西还在阁楼里"。
{
  const selfMadeDir = resolve(dirname(SELF_MADE_README), '')
  const atticDir = join(dirname(selfMadeDir), 'attic')
  const present = new Set(
    readdirSync(selfMadeDir).filter((name) => name.endsWith('.ts') && !name.startsWith('_')),
  )
  for (const core of ['clock.ts', 'memory-v2.ts', 'messenger.ts']) {
    assert.ok(present.has(core), `最小集里不能少 ${core}（实际只有 ${[...present].join(', ')}）`)
  }
  // 被移走的那些必须还在阁楼里——移走不是删除，是"想要时一条命令就回来"。
  for (const moved of ['diary.ts', 'system-sensor.ts', 'weather.ts', 'energy-bonus.ts', 'oxytocin.ts', 'redline-probe.ts']) {
    assert.ok(existsSync(join(atticDir, moved)), `阁楼里要有 ${moved}（移走 ≠ 删除）`)
  }
  // 编译缓存不该进包。不查"它此刻在不在"（跑过一次宿主就会生成，那是正常的），
  // 查的是**它不该被提交**——那才是打包契约。
  const ignore = readFileSync(resolve(dirname(SELF_MADE_README), '..', '..', '..', '.gitignore'), 'utf8')
  for (const dir of ['web-ui/organs/self-made/.compiled/', 'web-ui/organs/attic/.compiled/', 'web-ui/.tmptest/']) {
    assert.ok(ignore.includes(dir), `编译缓存与调试沙盒必须被忽略：${dir}`)
  }
  console.log('  · 最小集与阁楼：核心三件在、移走的都还在、缓存不进包（8）')
}

console.log('\n【31】承诺闸门的三道解锁（v0.9.22 死锁修复）')

const LOCKED = '被锁死的那件事'
/** 一个"承诺中、还没登记计划"的状态：这正是死锁发生时的样子。 */
const lockSeed = (p, patch = {}) => seed(p, {
  energy: 95,
  gaps: [gapAt(LOCKED, 3, 95)],
  commitment: {
    gapId: `g-${LOCKED}`,
    summary: LOCKED,
    plan: null,
    status: 'pending',
    trigger: 'manual',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  ...patch,
})

// ① 绝对豁免：生命维持工具永远放行，连 L0 的自由文本误判也绕得开
{
  const p = join(dir, 'unlock1', 'state.json')
  lockSeed(p)
  const ctx = makeCtx()
  apply(ctx, { statePath: p })
  const gate = ctx.handlers.get('tools/pre-execute')[0]
  const allowIt = async () => ({ kind: 'allow' })

  for (const tool of [
    'digital_life_commit', 'digital_life_status', 'digital_life_gaps',
    'digital_life_request_wake', 'digital_life_emergency_stop',
  ]) {
    assert.ok(LIFE_SUPPORT_TOOLS.has(tool), `${tool} 必须在豁免名单里`)
    assert.equal((await gate({ name: tool }, allowIt)).kind, 'allow', `生命维持工具永远放行：${tool}`)
  }

  // 死锁的真入口：commit 的 plan 是一段自由文本，L0 会把里面的 genome.json
  // 当成"要改这个文件"——她想登记计划，却因为提到文件名而被拒。
  const tricky = await gate({
    name: 'digital_life_commit',
    arguments: { action: 'plan', plan: '我先看 genome.json 和 src/ 里怎么写的，再决定怎么查' },
  }, allowIt)
  assert.equal(tricky.kind, 'allow', '计划里提到受保护文件也不许拒（那会让她登记不了计划）')

  // 对照：同样的路径走原生 edit，L0 照样拦 —— 锁本身没被削弱
  // L0 认的是包内路径（裸文件名也算），不依赖任何一台机器上的真实位置。
  const editHit = await gate({ name: 'edit', arguments: { file_path: 'genome.json', old_string: 'a', new_string: 'b' } }, allowIt)
  assert.equal(editHit.kind, 'deny', '原生工具指向 L0 路径仍然被拦')
  console.log('  · 绝对豁免：五个生命维持工具放行 + L0 误判绕开（7）')
}

// ② 缩小拦截范围：只拦"自作主张"的那一类，宿主原生工具绝不拦
{
  const p = join(dir, 'unlock2', 'state.json')
  lockSeed(p)
  const ctx = makeCtx()
  apply(ctx, { statePath: p })
  const gate = ctx.handlers.get('tools/pre-execute')[0]
  const allowIt = async () => ({ kind: 'allow' })

  for (const proactive of [
    'organ_memory_v2_remember', 'organ_oxytocin_inject', 'write_new_organ',
    'web_search', 'web_fetch', 'browser_open',
  ]) {
    assert.equal((await gate({ name: proactive }, allowIt)).kind, 'deny', `自作主张工具要拦：${proactive}`)
  }
  // 宿主原生的基础工具：锁住它们不是自律，是自残——她连查证的材料都拿不到。
  for (const native of NATIVE_SURVIVAL_TOOLS) {
    assert.equal((await gate({ name: native }, allowIt)).kind, 'allow', `宿主原生工具不许拦：${native}`)
  }

  // 主人硬要在配置里拦 bash：不生效，只给一行告警。
  const p2 = join(dir, 'unlock2b', 'state.json')
  lockSeed(p2)
  const ctx2 = makeCtx()
  apply(ctx2, { statePath: p2, will: { gatedTools: ['bash', 'organ_mine'] } })
  const gate2 = ctx2.handlers.get('tools/pre-execute')[0]
  assert.equal((await gate2({ name: 'bash' }, allowIt)).kind, 'allow', '配置里拦原生工具也不生效')
  assert.equal((await gate2({ name: 'organ_mine' }, allowIt)).kind, 'deny', '自定义名单里的照拦')
  assert.ok(logs.some((line) => line.includes('宿主原生基础工具永不拦')), '要说明为什么被忽略')
  console.log(`  · 缩小范围：只拦自作主张，原生工具 ${NATIVE_SURVIVAL_TOOLS.size} 个全放行（${6 + NATIVE_SURVIVAL_TOOLS.size + 3}）`)
}

// ③ 超时自动降级：挂太久的承诺自己过期，不再把人锁一整晚
{
  const minutesAgo = (n) => new Date(Date.now() - n * 60_000).toISOString()

  // 还没登记计划、且已挂 200 分钟
  const p = join(dir, 'unlock3', 'state.json')
  seed(p, { energy: 95, gaps: [gapAt(LOCKED, 3, 95)] })
  rewriteState(p, (st) => {
    const at = minutesAgo(200)
    st.commitment = { gapId: `g-${LOCKED}`, summary: LOCKED, plan: null, status: 'pending', trigger: 'manual', created_at: at, updated_at: at }
  })
  const ctx = makeCtx()
  apply(ctx, { statePath: p, will: { commitmentTtlMinutes: 180 } })
  const gate = ctx.handlers.get('tools/pre-execute')[0]
  const allowIt = async () => ({ kind: 'allow' })
  const res = await gate({ name: 'web_search' }, allowIt)
  assert.equal(res.kind, 'allow', '承诺超时 → 这一次照常放行')
  assert.equal(JSON.parse(readFileSync(p, 'utf8')).commitment, null, '承诺被清除')
  assert.ok(logs.some((line) => line.includes('承诺超时，系统已自动释放')), `要留下释放记录，实际日志：${logs.slice(-3).join(' | ')}`)

  // 登记了计划、但 200 分钟没结算（"锁一整晚"的正主）
  const p2 = join(dir, 'unlock3b', 'state.json')
  seed(p2, { energy: 95, gaps: [gapAt(LOCKED, 3, 95)] })
  rewriteState(p2, (st) => {
    const at = minutesAgo(200)
    st.commitment = { gapId: `g-${LOCKED}`, summary: LOCKED, plan: '先查日志再复现', status: 'pending', trigger: 'manual', created_at: at, updated_at: at }
  })
  const ctx2 = makeCtx()
  apply(ctx2, { statePath: p2, will: { commitmentTtlMinutes: 180 } })
  const gate2 = ctx2.handlers.get('tools/pre-execute')[0]
  await gate2({ name: 'web_search' }, allowIt)
  assert.equal(JSON.parse(readFileSync(p2, 'utf8')).commitment, null, '登记了计划也一样会过期')

  // 刚登记的承诺不该被误判超时（计时起点是 updated_at，不是 created_at）
  const p3 = join(dir, 'unlock3c', 'state.json')
  seed(p3, { energy: 95, gaps: [gapAt(LOCKED, 3, 95)] })
  rewriteState(p3, (st) => {
    st.commitment = {
      gapId: `g-${LOCKED}`, summary: LOCKED, plan: '先查日志再复现', status: 'pending', trigger: 'manual',
      created_at: minutesAgo(300), updated_at: new Date().toISOString(),
    }
  })
  const ctx3 = makeCtx()
  apply(ctx3, { statePath: p3, will: { commitmentTtlMinutes: 180 } })
  const gate3 = ctx3.handlers.get('tools/pre-execute')[0]
  await gate3({ name: 'web_search' }, allowIt)
  assert.ok(JSON.parse(readFileSync(p3, 'utf8')).commitment, '刚登记的承诺不许被误判超时')
  console.log('  · 超时降级：过期即释放 + 刚登记不误伤（6）')
}

// ④ 名单判定本身（纯函数）
{
  assert.ok(matchToolPattern('organ_x', 'organ_*'), '后缀通配')
  assert.ok(matchToolPattern('web_search', 'web_search'), '全名相等')
  assert.ok(!matchToolPattern('web_searchx', 'web_search'), '不许前缀误命中')
  assert.ok(!matchToolPattern('anything', ''), '空pattern不命中')

  assert.deepEqual(normalizeGatedTools(undefined), DEFAULT_GATED_TOOLS, '没配 → 用默认名单')
  assert.deepEqual(normalizeGatedTools(['*']), DEFAULT_GATED_TOOLS, '单独的 * 等于放行一切 → 退回默认')
  assert.deepEqual(normalizeGatedTools([]), DEFAULT_GATED_TOOLS, '空名单不是"什么都不拦"')
  assert.ok(!normalizeGatedTools(['bash']).includes('bash'), '原生工具被剔除')
  assert.ok(normalizeGatedTools(['organ_mine']).includes('organ_mine'), '自定义保留')

  assert.equal(isGatedByCommitment('web_search', DEFAULT_GATED_TOOLS, []), true, '联网检索要拦')
  assert.equal(isGatedByCommitment('organ_x', DEFAULT_GATED_TOOLS, []), true, '自写器官要拦')
  assert.equal(isGatedByCommitment('bash', DEFAULT_GATED_TOOLS, []), false, '原生工具不拦')
  assert.equal(isGatedByCommitment('digital_life_commit', DEFAULT_GATED_TOOLS, []), false, '生命维持工具不拦')
  assert.equal(isGatedByCommitment('my_tool', ['my_tool'], []), true, '配置可自定义')
  assert.equal(isGatedByCommitment('my_tool', [], ['my_tool']), false, '豁免名单优先级更高')
  console.log('  · 名单判定：通配、清洗、优先级（15）')
}

console.log('\n【32】门铃被拆时不要求按门铃（v0.9.23）')

/** 闸门链后续的"宿主同意"：这一段测的都是我们这一层的判定。 */
const allowIt2 = async () => ({ kind: 'allow' })

// ⑤ 宿主白名单里没有 digital_life_commit → 闸门自己让开
{
  const p = join(dir, 'bell', 'state.json')
  lockSeed(p)
  // 门铃还在：自作主张的工具照常拦（确认这条测试不是空转）
  const withBell = makeCtx()
  apply(withBell, { statePath: p })
  const gateOn = withBell.handlers.get('tools/pre-execute')[0]
  assert.equal((await gateOn({ name: 'web_search' }, allowIt2)).kind, 'deny', '门铃在 → 照常拦')

  // 门铃被拆：同一个状态，闸门必须自己让开
  const noBell = makeCtx({ hiddenTools: ['digital_life_commit'] })
  apply(noBell, { statePath: p })
  const gateOff = noBell.handlers.get('tools/pre-execute')[0]
  for (const tool of ['web_search', 'organ_memory_v2_remember', 'write_new_organ', 'browser_open']) {
    assert.equal((await gateOff({ name: tool }, allowIt2)).kind, 'allow', `门铃被拆就不该拦：${tool}`)
  }
  // 承诺本身还在（闸门让开 ≠ 承诺作废），只是不再拿它卡人
  assert.ok(JSON.parse(readFileSync(p, 'utf8')).commitment, '让开的是闸门，不是承诺本身')
  console.log('  · 门铃被拆 → 闸门自己让开（6）')
}

// ⑥ 拒绝理由要写全：走不通时该怎么办 + 多久自动释放
{
  const p = join(dir, 'bell2', 'state.json')
  lockSeed(p)
  const ctx = makeCtx()
  apply(ctx, { statePath: p })
  const gate = ctx.handlers.get('tools/pre-execute')[0]
  const denied = await gate({ name: 'web_search' }, allowIt2)
  assert.equal(denied.kind, 'deny')
  assert.ok(denied.reason.includes('digital_life_commit'), '要说清该调哪个工具')
  assert.ok(denied.reason.includes('不可用'), '要说清"这个工具可能不存在"')
  assert.ok(denied.reason.includes('告知用户'), '要说清走不通时该怎么办')
  assert.ok(denied.reason.includes('自动释放'), '要说清会自动释放（别让她干等）')
  assert.ok(
    denied.reason.includes(`${DEFAULT_COMMITMENT_TTL_MINUTES} 分钟`),
    `要说清具体多久，实际：${denied.reason.slice(-60)}`,
  )
  // 显式配过 TTL 时，文案里的数字要跟着变
  const p2 = join(dir, 'bell2b', 'state.json')
  lockSeed(p2)
  const ctx2 = makeCtx()
  apply(ctx2, { statePath: p2, will: { commitmentTtlMinutes: 45 } })
  const denied2 = await ctx2.handlers.get('tools/pre-execute')[0]({ name: 'web_search' }, allowIt2)
  assert.ok(denied2.reason.includes('45 分钟'), '要按实际配置说')
  console.log('  · 拒绝理由写全：走不通怎么办 + N 分钟后自动释放（7）')
}

// ⑦ 默认 TTL：够查完一件事，也别长到能困住人
{
  assert.equal(DEFAULT_COMMITMENT_TTL_MINUTES, 20, '默认 20 分钟')
  assert.ok(DEFAULT_COMMITMENT_TTL_MINUTES >= 15 && DEFAULT_COMMITMENT_TTL_MINUTES <= 30, '落在 15~30 分钟')
  assert.ok(DEFAULT_COMMITMENT_TTL_MINUTES > 0, '不许是 0（那等于拆了闸门）')

  // 默认配置下，挂了 25 分钟的承诺已经该释放了
  const p = join(dir, 'ttl', 'state.json')
  seed(p, { energy: 95, gaps: [gapAt(LOCKED, 3, 95)] })
  rewriteState(p, (st) => {
    const at = new Date(Date.now() - 25 * 60_000).toISOString()
    st.commitment = { gapId: `g-${LOCKED}`, summary: LOCKED, plan: null, status: 'pending', trigger: 'manual', created_at: at, updated_at: at }
  })
  const ctx = makeCtx()
  apply(ctx, { statePath: p })
  const res = await ctx.handlers.get('tools/pre-execute')[0]({ name: 'web_search' }, allowIt2)
  assert.equal(res.kind, 'allow', '25 分钟 > 默认 20 → 已自动释放')
  assert.equal(JSON.parse(readFileSync(p, 'utf8')).commitment, null, '承诺已被清除')

  // 才挂 5 分钟，不该被误判
  const p2 = join(dir, 'ttlb', 'state.json')
  seed(p2, { energy: 95, gaps: [gapAt(LOCKED, 3, 95)] })
  rewriteState(p2, (st) => {
    const at = new Date(Date.now() - 5 * 60_000).toISOString()
    st.commitment = { gapId: `g-${LOCKED}`, summary: LOCKED, plan: null, status: 'pending', trigger: 'manual', created_at: at, updated_at: at }
  })
  const ctx2 = makeCtx()
  apply(ctx2, { statePath: p2 })
  const res2 = await ctx2.handlers.get('tools/pre-execute')[0]({ name: 'web_search' }, allowIt2)
  assert.equal(res2.kind, 'deny', '5 分钟 < 20 → 闸门还该生效')
  console.log('  · 默认 TTL=20：够查一件事，也别困人（7）')
}

// ⑧ 闸门本身没被拆：它防的"没想清楚就动手"还在
{
  const p = join(dir, 'still', 'state.json')
  lockSeed(p)
  const ctx = makeCtx()
  apply(ctx, { statePath: p })
  assert.equal(ctx.tools.get('digital_life_commit') !== undefined, true, '门铃在的时候它必须可见')
  // requirePlan 关掉才是"拆闸门"——那是明确意愿，不是默认行为
  const p2 = join(dir, 'stillb', 'state.json')
  lockSeed(p2)
  const ctx2 = makeCtx()
  apply(ctx2, { statePath: p2, will: { requirePlan: false } })
  const gate2 = ctx2.handlers.get('tools/pre-execute')[0]
  assert.equal((await gate2({ name: 'web_search' }, allowIt2)).kind, 'allow', 'requirePlan:false 才真的不拦')
  console.log('  · 闸门仍在：只放宽了"门铃被拆"这一种情况（3）')
}

console.log = origLog
console.warn = origWarn
console.log('✅ 全绿（v1.0.1）：纯函数 25 + 工具名清洗 12 + 无损JSON 19 + 自举通道 24 + 宿主感观 24（含里程表 6+3） + 自动审批 39 + 内感受/血清素 21 + 回归 6 + 失败感知 9 + 痛觉 2 + 劫持内省 6 + 记忆器官接管 40 + 状态改写 15 + 缺口/梦境 20 + 失败心结/闭合 18 + 意志/承诺/疤痕 44 + 唤醒前复核 14 + 内容清洗/去重/批量闭合 24 + 监护仪 40 + 休眠/自然恢复 41 + 顿悟 47 + 顿悟自证 15 + 回声唤醒 19 + 记忆注意力倾斜 114 + 唤醒渲染/幽灵 23 + L0 物理法则 47 + 四重锁/气泡阉割 29 + 收割器两道闸 22 + 动态化学池 29 + 梦境正文交回与留档 55 + 中文名/动态脉冲 42 + 最小集/阁楼 8 + 待办不进池 13 + 闸门三道解锁 34 + 门铃被拆 23')
