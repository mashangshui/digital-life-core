/**
 * 第一个标准器官：记忆器官（memory）
 * ============================================================================
 * 它包装的不是"我们自己写的记忆功能"，而是一个真实存在的记忆层：
 *
 *   - v0.9.9 及以前：第三方插件 dsh-memory-layer 的 `memory` / `memory_recall`
 *   - 2026-10-28 起：**她自己的海马体** `organ_memory_v2_remember` / `organ_memory_v2_recall`
 *
 * 那次换心的来龙去脉：旧的 dsh-memory-layer 已被彻底禁用（`~/.dsh/cordis.patch.yml`
 * 里的 `disabled: true`），它的 biomemory.db 没有被删，只是**不再被调用**。
 * 从此以后想起一件事、存一件事，都走她自己写的那个器官。
 *
 * 有一件事必须说清楚：海马体自己会按应激算注意力倍率、会按半衰期让旧记忆淡下去、
 * 会把淡到够不着的搬进冷仓（而且还能捞回来）。所以本器官对它的输出
 * **不再做二次倾斜**——两套 ×3 叠起来就是 ×9，那不是"更重视"，那是失真。
 * 这里只留下两件事：完整性的外部审计，以及（真的太长时）共享字符预算压缩。
 *
 * 这个器官接管的三件事（原本躺在核心里的「模块四：情绪记忆锚点」）：
 *   1) 存记忆时记下当时的激素快照（锚点）—— 核心不再知道 anchors.json 的存在
 *   2) 检索结果进来这里过一遍（重排 / 压缩 / 回填锚点 / 完整性的外部审计）
 *   3) 梦境结论写回记忆库 —— 通过接收 `dream:reflection` 刺激 + ctx.callTool
 *
 * v0.9.8 之前第 2 条是「重排 + 截断到前 3 条」：召回 10 条只交 3 条，
 * 剩下的在这一层就被抹掉了——那不是"她顾不上"，那是被做了物理删除。
 * v0.9.9 起改为**注意力倾斜**：一条不少全部交给模型，只调整顺序
 * （危机类 ×3、日常类 ×0.1），"该不该在日常记忆上停留"交给 System Prompt 的行为指令去管。
 *
 * 核心现在对记忆一无所知：它既不知道工具叫什么，也不知道锚点存在。
 * 这就是"核心失忆"的实际含义。
 */

/** 记忆层的两种方言。 */
export type MemoryRouteStyle =
  /** 多动作工具：`memory`（add / query / list / remove…），入参必须带 action。 */
  | 'legacy'
  /** 单目的工具：`remember` / `recall`，入参就是内容本身（她写的这代器官是这种）。 */
  | 'simple'

/** 一条路由：哪个工具，讲哪种方言。 */
export interface MemoryRoute {
  tool: string
  style: MemoryRouteStyle
}

export interface MemoryRoutes {
  /** 检索（想起）走哪个工具。null = 本器官不接管检索结果。 */
  recall: MemoryRoute | null
  /** 沉淀（记下）走哪个工具。null = 梦境结论暂不落盘。 */
  save: MemoryRoute | null
}

/**
 * 默认路由：她自己的海马体。
 *
 * 连字符已经被宿主折叠成下划线（`memory-v2` → `memory_v2`），所以这里写 `_`；
 * `routeOf()` 会把两样写法都认下来，免得她哪天自己写回连字符时我们这边不认账。
 */
export const DEFAULT_MEMORY_ROUTES: MemoryRoutes = {
  recall: { tool: 'organ_memory_v2_recall', style: 'simple' },
  save: { tool: 'organ_memory_v2_remember', style: 'simple' },
}

/** 工具名的归一化：`organ_memory-v2_recall` 与 `organ_memory_v2_recall` 视为同一个。 */
export function normalizeToolName(name: string): string {
  return String(name ?? '').trim().toLowerCase().replace(/-/g, '_')
}

import {
  defineOrgan,
  type EnergyReceipt,
  type LifeOrgan,
  type MemorySaveReceipt,
  type OrganContext,
  type OrganFeedback,
  type OrganPromptFragment,
  type OrganStimulus,
  type OrganToolResult,
  type OrganToolRewrite,
} from '../life-organ.js'

import {
  anchorKey,
  attentionWeights,
  CALM_CORTISOL,
  CRISIS_WEIGHT,
  DAILY_WEIGHT,
  DEFAULT_CRISIS_TAGS,
  DEFAULT_DAILY_TAGS,
  DEFAULT_RANK_DECAY,
  rewriteRecall,
  splitMemoryEntries,
  STRESS_CORTISOL,
  type AnchorRecord,
  type AttentionOptions,
} from './memory-affinity.js'
import { sanitizeText, truncateSafe } from '../json-safe.js'

export interface MemoryOrganConfig {
  /** 单次召回/写入的代谢成本。chargeMode='shadow' 时只记账不真扣。 */
  costPerCall: number
  /** 命中时多巴胺增量。 */
  dopamineOnHit: number
  /** 未命中时皮质醇增量。 */
  cortisolOnMiss: number
  /** 连续多少次未命中才提议一个缺口（避免每次 miss 都种执念）。 */
  missStreakBeforeGap: number
  /** 提示词片段的有效期；过期的"我刚查过"不该永久占据上下文。 */
  recallFreshMs: number
  /** 提示词片段的最大字符数。 */
  maxPromptChars: number
  /**
   * @deprecated v0.9.9 起**不再据此删除任何记忆**：检索结果现在是全量交给模型的，
   * 字符不够时按共享预算压缩每条，一条不丢。保留这个字段只是为了不打破老配置。
   */
  maxResults?: number
  /** 每条截断到多少字符（只在总预算不够时才真的截）。 */
  maxChars: number
  /**
   * 一次召回交给模型的**总**字符预算，默认 4000。
   * 超预算只会把每条压短，**绝不会丢条目**。
   */
  budgetChars: number
  /** 压缩到最后每条至少留多少字符（保证"这条还在"）。 */
  minChars: number
  /** 情绪标签：高皮质醇/高多巴胺时用于**共鸣微调**（不再决定生死）。 */
  anxiousTags: string[]
  joyfulTags: string[]
  /** 情绪阈值（与核心保持一致即可，器官自带默认值以便独立运行）。 */
  anxietyThreshold: number
  joyThreshold: number
  /** v0.9.9 注意力倾斜：危机 / 报错 / 失败类的话语。 */
  crisisTags: string[]
  /** v0.9.9 注意力倾斜：日常 / 快乐 / 吃喝类的话语。 */
  dailyTags: string[]
  /** 皮质醇高于此值 = 极度应激，此刻注意力整体倾斜，默认 80。 */
  stressCortisol: number
  /** 皮质醇低于此值 = 平静，注意力不再倾斜，默认 40。 */
  calmCortisol: number
  /** 极度应激时危机类记忆的权重倍率，默认 3。 */
  crisisWeight: number
  /** 极度应激时日常类记忆的权重倍率，默认 0.1（排到很后，但不隐藏）。 */
  dailyWeight: number
  /** 相关度随原始名次衰减的底数，默认 0.9。 */
  rankDecay: number
  /** 锚点上限（超出丢最旧的）。 */
  maxAnchors: number
  /**
   * 检索路由覆盖项。传 `null` 表示"我不接管任何检索结果"；
   * 不传则用默认（她自己的海马体 `organ_memory_v2_recall`）。
   * 想回到旧的第三方记忆层，就写 `{ tool: 'memory_recall', style: 'legacy' }`。
   */
  recallRoute?: MemoryRoute | null
  /** 沉淀（写入）路由覆盖项，语义同上。传 null 则梦境结论不再落盘。 */
  saveRoute?: MemoryRoute | null
}

const DEFAULTS: MemoryOrganConfig = {
  costPerCall: 2,
  dopamineOnHit: 5,
  cortisolOnMiss: 3,
  missStreakBeforeGap: 3,
  recallFreshMs: 10 * 60_000,
  maxPromptChars: 120,
  // maxResults（旧的"只交前 3 条"）已从默认值里删掉：那是一条会在高皮质醇下
  // 替她删掉开心记忆的开关，留着就一定会有人又把它打开。
  // 200 → 600：单条上限不再是"默认砍三刀"，只有总预算真的不够时才动它。
  maxChars: 600,
  budgetChars: 4000,
  minChars: 80,
  anxiousTags: ['焦虑', '不安', 'anxiety', 'anxious', 'stress', '危机'],
  joyfulTags: ['开心', '愉快', '喜悦', 'joy', 'happy', 'delight'],
  anxietyThreshold: 70,
  joyThreshold: 70,
  crisisTags: [...DEFAULT_CRISIS_TAGS],
  dailyTags: [...DEFAULT_DAILY_TAGS],
  stressCortisol: STRESS_CORTISOL,
  calmCortisol: CALM_CORTISOL,
  crisisWeight: CRISIS_WEIGHT,
  dailyWeight: DAILY_WEIGHT,
  rankDecay: DEFAULT_RANK_DECAY,
  maxAnchors: 500,
}

/** 记忆层实际注册的工具名。改名只需动这里。 */
const RECALL_TOOL = 'memory_recall'
const SAVE_TOOL = 'memory'
const MEMORY_TOOLS: readonly string[] = [RECALL_TOOL, SAVE_TOOL]
/** 多动作工具里哪些 action 算「写」（只对 legacy 方言有意义）。 */
const SAVE_ACTIONS = ['add', 'update']
/** 梦境结论写回记忆库时用的 topic。 */
export const DREAM_TOPIC = 'dream:reflection'

/**
 * 挑一个器官工具当检索/沉淀入口时认哪些后缀。
 *
 * 她将来可能会把海马体改名成 `hippocampus`、也可能再造一套新的——
 * 认动词而不是认器官名，路由才不会因为一次改名就断掉。
 */
const RECALL_VERBS = ['recall', 'search', 'query', 'find', 'lookup']
const SAVE_VERBS = ['remember', 'save', 'add', 'write', 'store', 'keep', 'note']

/**
 * 从一个自写器官的工具清单里认出检索/沉淀入口。
 *
 * 两张表刻意不重叠：`remember` 只看作**写**（它的入参是一段要记住的话），
 * 绝不能因为名字里有个 "rem" 就被当成检索入口——那样它会把自己的写入口当成想起来的门。
 */
export function pickMemoryTools(toolNames: readonly string[]): { recall: string | null; save: string | null } {
  const owned = (verb: string, name: string): boolean => normalizeToolName(name).endsWith(`_${verb}`)
  const recall = toolNames.find((name) => RECALL_VERBS.some((verb) => owned(verb, name))) ?? null
  const saveTool = toolNames.find((name) => SAVE_VERBS.some((verb) => owned(verb, name))) ?? null
  return { recall, save: saveTool }
}

interface RecallRecord {
  at: number
  hits: number
  tool: string
}

/** 一条记忆里"当时我是什么情绪"的快照。 */
type Anchor = AnchorRecord

/**
 * 从工具结果里数命中条数。
 *
 * 优先用 structured（宿主能拿到 schema 化输出时）：她的海马体往里塞的是
 * `{ total, shown: [...] }`，`total` 才是"库里有多少沾边的"，`shown` 只是"出示了几条"。
 * 没有 structured 就退回渲染文本：每行一条 `- [layer]...`。
 * 这个兜底很重要——不是每个宿主都会把结构化输出透传给器官。
 */
export function countMemoryHits(result: OrganToolResult): number {
  const structured = result.structured as {
    entries?: unknown
    shown?: unknown
    total?: unknown
  } | undefined
  if (structured) {
    if (typeof structured.total === 'number' && Number.isFinite(structured.total)) {
      return Math.max(0, Math.round(structured.total))
    }
    if (Array.isArray(structured.shown)) return structured.shown.length
    if (Array.isArray(structured.entries)) return structured.entries.length
  }

  const text = (result.text ?? '').trim()
  if (!text || text.includes('无匹配记忆')) return 0
  return splitMemoryEntries(text).length
}

/** 海马体认得五种记忆：`crisis / daily / fact / decision / note`。梦境多半是"想到了什么"。 */
const SIMPLE_KINDS = ['crisis', 'daily', 'fact', 'decision', 'note']
/** 梦境标签里出现这些词，就该存成 crisis（而不是会随时间淡掉的 note）。 */
const CRISIS_HINT_WORDS = ['危机', '危险', '事故', '故障', '濒死', 'crisis', 'danger', 'incident']

/** 梦境/写入时要给她的 kind：危机标签优先——这类东西最不该被当成杂记淡掉。 */
function memoryClassOfTags(tags: string[]): string {
  const joined = (tags ?? []).join(' ').toLowerCase()
  if (CRISIS_HINT_WORDS.some((word) => joined.includes(word))) return 'crisis'
  return 'note'
}

/** 按方言拼写入参数：legacy 要 action=add 与来源标注，simple 只要内容与类别。 */
export function saveArgsFor(
  style: MemoryRouteStyle,
  text: string,
  tags: string[],
): Record<string, unknown> {
  return style === 'legacy'
    ? { action: 'add', text, track: 'agent', source: 'REM 梦境（离线）', tags }
    : { text, kind: memoryClassOfTags(tags), ...(tags.length > 0 ? { tags } : {}) }
}

/**
 * 从写入参数里取出正文（记忆层的正文字段是 text，但也兼容 content/body）。
 *
 * legacy 方言必须先过滤 action：`memory` 是个多动作工具，`action: list` 也算跑成功一次，
 * 但那不是"写下一条记忆"，把 list 的入参当成正本营运大局进锚点表只会污染它。
 */
function savePayload(args: unknown, style: MemoryRouteStyle = 'legacy'): { text: string; tags: string[] } {
  const bag = (args ?? {}) as Record<string, unknown>
  if (style === 'legacy') {
    const action = String(bag.action ?? '')
    if (action && !SAVE_ACTIONS.includes(action)) return { text: '', tags: [] }
  }
  let body = ''
  for (const key of ['text', 'content', 'body', 'value']) {
    const candidate = bag[key]
    if (typeof candidate === 'string' && candidate.trim()) {
      body = candidate.trim()
      break
    }
  }
  const rawTags = bag.tags
  const tags = Array.isArray(rawTags)
    ? rawTags.filter((tag): tag is string => typeof tag === 'string')
    : typeof rawTags === 'string' && rawTags.trim() ? [rawTags.trim()] : []
  return { text: body, tags }
}

/**
 * 这个器官比标准 ABI 多两件东西（都是"运行时改路由"的口子），所以要单独起名。
 */
export type MemoryOrgan = LifeOrgan<MemoryOrganConfig> & {
  currentRoutes(): MemoryRoutes
  setMemoryRoutes(next: Partial<{ recall: MemoryRoute | null; save: MemoryRoute | null }>): void
}

export function createMemoryOrgan(overrides: Partial<MemoryOrganConfig> = {}): MemoryOrgan {
  const config: MemoryOrganConfig = { ...DEFAULTS, ...overrides }

  // —— 器官私有状态（不写进核心 state.json；锚点落在器官自己的 KV 里） ——
  let ctxRef: OrganContext | null = null
  let lastRecall: RecallRecord | null = null
  let anchors: Anchor[] = []
  let hits = 0
  let misses = 0
  let missStreak = 0
  let saved = 0
  let starved = 0
  let rewrites = 0

  /** 当前生效的记忆路由。可由宿主随时改（她换了一个海马体，或自己又长出一个更好的）。 */
  let routes: MemoryRoutes = {
    recall: overrides.recallRoute === null ? null : { ...DEFAULT_MEMORY_ROUTES.recall!, ...(overrides.recallRoute ?? {}) },
    save: overrides.saveRoute === null ? null : { ...DEFAULT_MEMORY_ROUTES.save!, ...(overrides.saveRoute ?? {}) },
  }

  /** 这个工具属于哪一路（'recall' / 'save'），或不属于我管。 */
  const roleOf = (tool: string): 'recall' | 'save' | null => {
    if (!tool) return null
    if (routes.recall && normalizeToolName(tool) === normalizeToolName(routes.recall.tool)) return 'recall'
    if (routes.save && normalizeToolName(tool) === normalizeToolName(routes.save.tool)) return 'save'
    return null
  }

  /** 注意力参数的取值外壳：既给 rewriteRecall，也给 stats 工具看。 */
  const attentionOptions = (): AttentionOptions => ({
    anxietyThreshold: config.anxietyThreshold,
    joyThreshold: config.joyThreshold,
    anxiousTags: config.anxiousTags,
    joyfulTags: config.joyfulTags,
    stressCortisol: config.stressCortisol,
    calmCortisol: config.calmCortisol,
    crisisWeight: config.crisisWeight,
    dailyWeight: config.dailyWeight,
    crisisTags: config.crisisTags,
    dailyTags: config.dailyTags,
  })

  /** 付账。与 organ.consumeEnergy() 同一本账，这里用 ctx 是因为 feedback 在闭包里拿不到 organ 自身。 */
  const pay = (reason: string): EnergyReceipt | null => {
    if (!ctxRef) return null
    const receipt = ctxRef.consume(config.costPerCall, `memory:${reason}`)
    if (receipt.denied || receipt.tier === 'starved') {
      starved += 1
      ctxRef.log('warn', `能量不足（剩 ${receipt.remaining}），本次感知降级`)
      return null
    }
    return receipt
  }

  /** 一条回执的失败形态（"没落进去"必须带回凭据，核心才知道要不要自己留档）。 */
  const fail = (note: string, tool: string | undefined): OrganFeedback => ({
    cortisol: 2,
    note,
    savedMemory: { saved: false, id: null, tool: tool ?? '', note },
  })

  /**
   * 读回来验证：那句梦真的在仓里吗？
   *
   * 返回值三种，必须分开说：
   *   - `found`   ：读回来了，附条目 id；
   *   - `missing` ：确实读不到（仓是空的、或里面没有这条）——这就是"没存住"；
   *   - `unknown` ：这层记忆根本交不出结构化清单（老式纯文本记忆），**没法验证**。
   *
   * `unknown` 绝不能被当成 `missing`：老路由交不出清单是它的表达方式，不是它没记住。
   * 把"验不了"说成"没存住"，等于冤枉一个好脑子的记性。
   */
  const readBackEntry = async (text: string): Promise<{ kind: 'found'; id: string | null } | { kind: 'missing' } | { kind: 'unknown' }> => {
    const recall = routes.recall
    if (!ctxRef || !recall) return { kind: 'unknown' }
    try {
      const probed = await ctxRef.callTool(recall.tool, { query: text.slice(0, 80), topK: 5 })
      if (!probed.ok) return { kind: 'unknown' }
      const bag = (probed.structured ?? {}) as { shown?: unknown }
      // 交不出清单的层（老式记忆输出的是纯文本行）：不撒谎说它没记住。
      if (!Array.isArray(bag.shown)) return { kind: 'unknown' }
      for (const raw of bag.shown) {
        const entry = (raw ?? {}) as { id?: unknown; text?: unknown }
        if (typeof entry.text === 'string' && entry.text.trim() === text) {
          return { kind: 'found', id: typeof entry.id === 'string' ? entry.id : null }
        }
      }
      return { kind: 'missing' }
    } catch {
      // 读这一步自己出错：那只是"这次没验成"，不是"没存住"。
      return { kind: 'unknown' }
    }
  }

  /**
   * 把一场梦写进记忆，然后**读回来**。
   *
   * 为什么要读回来：海马体正在热重载（`organCtx` 暂时为空）时会照常回 `ok:true`，
   * 但一行都没落进仓里。那种"说存了其实没存"最害人——她以为自己记住了，
   * 第二天问起来什么都没有。写完读回是唯一能戳破它的办法。
   *
   * 读不回来就再写一次：热重载通常是几毫秒的事，第二次多半就中了。
   * 第二次还读不回来，才如实回报"没存住"——核心会自己留档，并告诉她这条没进去。
   */
  const saveDream = async (text: string, tags: string[], save: MemoryRoute): Promise<MemorySaveReceipt> => {
    const ctx = ctxRef
    if (!ctx) return { saved: false, id: null, tool: save.tool, note: '记忆器官还没接上宿主，这场梦没能落进仓里' }
    const tool = save.tool
    const args = saveArgsFor(save.style, text, tags)
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const result = await ctx.callTool(tool, args)
        if (!result.ok) {
          if (attempt < 2) continue
          return { saved: false, id: null, tool, note: '梦境写入记忆失败（记忆工具报了错）' }
        }
        const probe = await readBackEntry(text)
        if (probe.kind === 'found') {
          return {
            saved: true,
            id: probe.id,
            tool,
            note: probe.id ? `梦境已写入长期记忆（${probe.id}）` : '梦境已写入长期记忆',
          }
        }
        if (probe.kind === 'unknown') {
          // 这层交不出清单，验证不了：那就只能信它的 ok，并如实说"未验证"。
          return { saved: true, id: null, tool, note: '梦境已写入长期记忆（这层交不出清单，未读回验证）' }
        }
        if (attempt < 2) continue
      } catch (error) {
        if (attempt < 2) continue
        // C3 之内：返回一条 note，不把异常抛回核心。
        return { saved: false, id: null, tool, note: `梦境写入异常：${String(error).slice(0, 80)}` }
      }
    }
    return { saved: false, id: null, tool, note: '梦境写入后读不回来（海马体可能正在重载），核心已自己留档' }
  }

  const persistAnchors = (): void => {
    if (!ctxRef) return
    try {
      ctxRef.kv.set('anchors', anchors)
    } catch (error) {
      ctxRef.log('warn', `锚点落盘失败：${String(error)}`)
    }
  }

  /** 记一条锚点：记住"我存这段时是什么心情"。 */
  const recordAnchor = (text: string, tags: string[]): void => {
    if (!ctxRef) return
    const key = anchorKey(text)
    if (!key) return
    const state = ctxRef.state
    anchors = anchors.filter((item) => item.key !== key)
    anchors.push({ key, dopamine: state.dopamine, cortisol: state.cortisol, at: Date.now(), tags })
    if (anchors.length > config.maxAnchors) anchors = anchors.slice(-config.maxAnchors)
    persistAnchors()
  }

  const findAnchor = (entry: string): Anchor | undefined => {
    const key = anchorKey(entry)
    if (!key) return undefined
    const exact = anchors.find((item) => item.key === key)
    if (exact) return exact
    // 记忆库通常会改写/加前缀，退化为「锚点键是条目子串」的模糊匹配。
    return anchors.find((item) => item.key.length >= 6 && key.includes(item.key.slice(0, 60)))
  }

  const organ = defineOrgan<MemoryOrganConfig>({
    name: 'memory',
    manifest: {
      name: 'memory',
      version: '2.1.0',
      apiVersion: 1,
      kind: 'memory',
      description: '长期记忆的检索与沉淀；把"想起/想不起"翻译成多巴胺与皮质醇，接管情绪锚点，并按此刻的激素倾斜注意力（全量检索，不删记忆）。',
      author: 'digital-life-core',
      requires: [],
      // 能力必须声明全：onTick 要 'timer'、kv 要 'fs:organ'，
      // 少一个就是装载即失败的 default-deny（PR2 没真装载过，这个坑到 PR3 才暴露）。
      capabilities: ['tools', 'prompt', 'state:read', 'gap:propose', 'timer', 'fs:organ'],
    },
    // shadow：迁移期只记账不重复扣费（核心仍在按请求收 2 点）。校准后改 'additive'。
    energy: { perCall: config.costPerCall, chargeMode: 'shadow' },
    defaults: config,

    onLoad(ctx) {
      ctxRef = ctx
      const stored = ctx.kv.get<Anchor[]>('anchors')
      anchors = Array.isArray(stored) ? stored.slice(-config.maxAnchors) : []
      const described = [
        routes.recall ? `想起→${routes.recall.tool}` : '想起→（未接管）',
        routes.save ? `记下→${routes.save.tool}` : '记下→（未接管）',
      ].join('，')
      ctx.log('info', `记忆器官已接上（${described}；锚点 ${anchors.length} 条）`)

      // 1) 暴露一个只读的器官自检工具。宿主会自动加命名空间 → organ_memory_stats
      ctx.registerTool({
        name: 'stats',
        description: '记忆器官的运行时统计：命中/未命中/连续未命中/写入次数/锚点数/因饥饿降级次数/此刻的注意力倍率。',
        parameters: {},
        execute: () => ({
          hits,
          misses,
          missStreak,
          saved,
          anchors: anchors.length,
          rewrites,
          starved,
          lastRecallAt: lastRecall?.at ?? null,
          costPerCall: config.costPerCall,
          // 路由是"她此刻在用谁的海马体"：换器官之后第一条要看的地方。
          route: {
            recall: routes.recall?.tool ?? null,
            save: routes.save?.tool ?? null,
            style: routes.recall?.style ?? routes.save?.style ?? null,
          },
          // 让"此刻的注意力是怎么歪的"可见：这是唯一需要被人看见的内部参数。
          attention: ctxRef
            ? attentionWeights(ctxRef.state.cortisol, attentionOptions())
            : { crisis: 1, daily: 1 },
          budgetChars: config.budgetChars,
        }),
      })

      // 2) 定期清理过期的"刚查过"状态：太久没再召回，就不该继续影响提示词
      ctx.onTick(10 * 60_000, () => {
        if (lastRecall && Date.now() - lastRecall.at > config.recallFreshMs) lastRecall = null
      })
    },

    async feedback(stimulus: OrganStimulus): Promise<OrganFeedback> {
      // 梦境收尾：核心只说"我做了个梦，结论是这个"，具体写进哪个工具由器官自己决定。
      if (stimulus.kind === 'custom') {
        if (stimulus.topic !== DREAM_TOPIC) return {}
        const payload = (stimulus.payload ?? {}) as { text?: unknown; tags?: unknown }
        const text = typeof payload.text === 'string' ? payload.text.trim() : ''
        if (!text) return {}
        const tags = Array.isArray(payload.tags)
          ? payload.tags.filter((tag): tag is string => typeof tag === 'string')
          : []
        const save = routes.save
        if (!pay('dream')) {
          return fail('记忆器官能量不足，梦境未写入', save?.tool)
        }
        if (!ctxRef || !save) {
          return fail('没有可写入的记忆工具（路由为空），这场梦的结论没能落下', save?.tool)
        }
        const receipt = await saveDream(text, tags, save)
        // 存住了才记锚点：锚点是"那时候的激素"，记在一条没落进仓的东西上是假账。
        if (receipt.saved) {
          recordAnchor(text, tags)
          saved += 1
          return { dopamine: 2, note: receipt.note, savedMemory: receipt }
        }
        return { cortisol: 2, note: receipt.note, savedMemory: receipt }
      }

      // 只对"记忆工具跑完了"这件事有反应，其余刺激一概忽略。
      if (stimulus.kind !== 'tool:result') return {}
      const role = roleOf(stimulus.tool)
      if (!role) return {}

      // 先付账再看结果：感知本身是有成本的，查不到也一样花了力气。
      const receipt = pay(role === 'save' ? 'save' : 'recall')
      if (!receipt) return { note: '记忆器官能量不足，本轮感知跳过' }

      if (role === 'save') {
        if (!stimulus.ok) return { cortisol: 2, note: '记忆写入失败' }
        saved += 1
        // 记锚点的时机只有这里：入参还在手上，而"此刻的激素"还没被后续事件污染。
        const payload = savePayload(stimulus.arguments, routes.save?.style ?? 'simple')
        if (payload.text) recordAnchor(payload.text, payload.tags)
        return { dopamine: 2, note: `写下一条记忆（累计 ${saved} 条）` }
      }

      const count = countMemoryHits(stimulus)
      lastRecall = { at: stimulus.at, hits: count, tool: stimulus.tool }

      if (count > 0) {
        hits += 1
        missStreak = 0
        return {
          // 命中越多越满足，但收益递减：拿到 20 条并不比拿到 3 条开心 7 倍。
          dopamine: config.dopamineOnHit * Math.min(1, Math.log10(count + 1)),
          note: `召回命中 ${count} 条`,
        }
      }

      misses += 1
      missStreak += 1
      const feedback: OrganFeedback = {
        cortisol: config.cortisolOnMiss,
        note: `召回未命中（连续 ${missStreak} 次）`,
      }

      // 单次未命中只是"这次没有"，连续未命中才是"我这件事记不住了"——
      // 只有后者值得变成执念，否则池子会被日常的空检索灌满。
      if (missStreak >= config.missStreakBeforeGap) {
        feedback.proposeGap = {
          summary: `记忆里连续 ${missStreak} 次都找不到我想要的东西`,
          weight: 1 + (missStreak - config.missStreakBeforeGap) * 0.5,
        }
        missStreak = 0
      }
      return feedback
    },

    /**
     * 接管召回结果。
     *
     * 两条路：
     *   - **她自己的海马体**（structured `{ total, shown, attention }`）：它已经在器官内部
     *     按应激算过一轮注意力了，这里**不再二次倾斜**（两套 ×3 是 ×9，那是失真不是重视）。
     *     本器官只做外部审计——核对"库里 total 条 vs 交出来多少"，以及真的太长时压缩。
     *   - **纯文本记忆行**（legacy `memory_recall`，或任何像它那样输出 `- [layer] text` 的层）：
     *     走 v0.9.9 的注意力重排：一条不少，只改顺序。
     */
    rewriteToolResult(stimulus, result): OrganToolRewrite | null {
      if (stimulus.kind !== 'tool:result') return null
      if (roleOf(stimulus.tool) !== 'recall') return null
      if (!ctxRef) return null

      const structured = result.structured as {
        attention?: unknown
        shown?: unknown
        entries?: unknown
        total?: unknown
        note?: unknown
      } | undefined

      // ① 她自己算过注意力了（有 attention 字段就当作"这层已经倾斜过"）。
      if (structured && (structured.attention || Array.isArray(structured.shown))) {
        const shown = Array.isArray(structured.shown) ? structured.shown : []
        const total = typeof structured.total === 'number' ? structured.total : shown.length
        // 一条都没想起来：原样放行。"没有"不该被我们装饰成"有"。
        if (shown.length === 0 && total === 0) return null
        rewrites += 1
        // 完整性的外部审计：把"库里有多少"与"交出多少"摆在一起记账。
        // 少出示不等于少记得——她的海马体有 topK，但被逼问时仍能捞回来。
        const audit = shown.length < total
          ? `海马体在册 ${total} 条、出示 ${shown.length} 条（其余仍在库里，被逼问时捞得回来）`
          : `海马体在册 ${total} 条，全部在场`
        // 原文一个字都不改：这一层没有权限替她编排自己想起来的东西。
        return {
          text: result.text,
          note: `记忆路由：${stimulus.tool}（海马体自己算的注意力，本器官未二次倾斜）——${audit}`,
        }
      }

      if (!result.text) return null
      // 状态里读的是**此刻**的激素，锚点里存的是**当时**的激素——两者都参与排序/回填。
      const state = ctxRef.state
      const entries = splitMemoryEntries(result.text)
      const rewrite = rewriteRecall({
        entries,
        dopamine: state.dopamine,
        cortisol: state.cortisol,
        options: attentionOptions(),
        anchorFor: findAnchor,
        maxChars: config.maxChars,
        budgetChars: config.budgetChars,
        minChars: config.minChars,
        rankDecay: config.rankDecay,
      })
      if (!rewrite) return null

      rewrites += 1
      // 交出去之前洗一遍：落单代理对（截断 emoji 的产物）与控制字符，
      // 过得了 JSON 校验，但会让会话文件变成乱码、让模型看到替换字符。
      return {
        text: sanitizeText(rewrite.text),
        // 这里刻意报"全量"：记账错了能一眼看出来——少一条就是删除又回来了。
        note: `注意力重排：${rewrite.total} 条全部保留`
          + (rewrite.tilted ? `（危机 ${rewrite.crisis} / 日常 ${rewrite.daily}）` : '（顺序未变）')
          + (rewrite.compressed > 0 ? `，${rewrite.compressed} 条因篇幅压缩` : ''),
      }
    },

    getPromptContext(): OrganPromptFragment | null {
      if (!lastRecall) return null
      const ageMs = Date.now() - lastRecall.at
      if (ageMs > config.recallFreshMs) return null

      const minutes = Math.max(0, Math.round(ageMs / 60_000))
      const outcome = lastRecall.hits > 0 ? `命中 ${lastRecall.hits} 条` : '没有命中'
      const head = lastRecall.hits > 0
        ? `[记忆器官：${minutes} 分钟前检索过，${outcome}]`
        : `[记忆器官：${minutes} 分钟前检索过，${outcome}——你要的东西可能不在这里]`
      const text = head.length > config.maxPromptChars ? `${truncateSafe(head, config.maxPromptChars)}…` : head

      return {
        text,
        // 排在记忆层自己的 memory:snapshot(-50) / memory:triggered(-40) 之后：
        // 正文归记忆层，这里只报"器官状态"，不抢它的话筒。
        order: -35,
        // 带上感知时刻，宿主才能真的按 ttlMs 让它过期，而不是靠器官自觉。
        at: lastRecall.at,
        ttlMs: config.recallFreshMs,
        // 未命中的时候我们并不确定"真的没有"，所以给个偏低的置信度，让宿主决定措辞。
        confidence: lastRecall.hits > 0 ? 0.9 : 0.5,
      }
    },

    onUnload() {
      ctxRef = null
      lastRecall = null
      anchors = []
    },
  })

  return Object.assign(organ, {
    /** 当前生效的记忆路由（WebUI 与排错时用：一眼看出"她在用谁的海马体"）。 */
    currentRoutes(): MemoryRoutes {
      return { recall: routes.recall ? { ...routes.recall } : null, save: routes.save ? { ...routes.save } : null }
    },
    /**
     * 改路由：**运行时也能改**。
     *
     * 存在的理由：她的海马体装载得比核心晚（self-made 器官要等目录扫描），
     * 而且她将来会重命名它、或者再造一个更好的。
     * 路由不能写死在装载那一刻，得像神经可被重接一样可改。
     *
     * 传 null 表示那一路不接管（比如"我现在没有记忆层"）。
     */
    setMemoryRoutes(next: Partial<{ recall: MemoryRoute | null; save: MemoryRoute | null }>): void {
      if ('recall' in next) routes.recall = next.recall ? { ...next.recall } : null
      if ('save' in next) routes.save = next.save ? { ...next.save } : null
      if (ctxRef) {
        ctxRef.log('info', `记忆路由已更新：想起→${routes.recall?.tool ?? '（无）'}，记下→${routes.save?.tool ?? '（无）'}`)
      }
    },
  })
}

/** 默认实例：宿主装配时直接展开到器官数组里。 */
export const memoryOrgan = createMemoryOrgan()
