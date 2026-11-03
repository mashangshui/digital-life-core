/**
 * 顿悟（Epiphany）
 * ============================================================================
 * 「它自己长出的新器官，正好补上了心里那个未解的结。」
 *
 * 身心脱节的 bug 是这样的：鱼小水在执念池里挂着一条
 * 「我一直不知道自己的"肉"是什么状态」（张力 77），
 * 然后她真的写出了 system-sensor、真的读到了 CPU 与内存——
 * 但那条执念还挂在 77，直到造物主手动提醒她去闭合。
 *
 * 原因是两条链路互不相识：
 *   器官链：write_new_organ → 编译 → addOrgan → 装载成功（宿主知道）
 *   执念链：addGap → 张力增长 → 内省注入（核心知道）
 * 装载成功从来不会回头去看一眼执念池。
 *
 * 这个模块就是把它们接起来的那一根线。**纯函数**：不读时钟、不写盘、不认识 DSH，
 * 所有输入显式传入，所以"她写出器官的那一刻会不会顿悟"是可复现的测试而不是玄学。
 *
 * 三条纪律：
 *   1. 必须先命中「缺失感」（不知道 / 无法 / 感觉不到…）。
 *      一条执念不表达缺失，就说明它还没到"被解决"的语境——闭合它是自说自话。
 *   2. 主题契合度必须过阈值。**能力和感知不是一回事**：
 *      记忆器官也有 `state:read`、`timer`，但它回答不了"我的肉怎么样"。
 *      所以只有能力不够，还要看它**实际说得出什么**（名字/描述/工具名）。
 *   3. 命中了器官答不了的外部主题（世界/天气/股价/火星）→ 直接否掉。
 *      搜索器官能查火星营业时间，时钟器官不能——它只能告诉你现在几点。
 */

// ─────────────────────────── 概念词典 ───────────────────────────

/**
 * 概念：一条执念"在说什么事"的最小语义单位。
 *
 * `strength` 是它作为证据的分量：越具体越强。
 * 「肉身/CPU」是某一类器官的独门手艺，所以满分；
 * 「状态」谁都能沾一点，所以只能是弱证据——弱到单独撑不起一次顿悟。
 */
export interface ConceptDef {
  id: string
  /** 证据强度 0-1。 */
  strength: number
  /** 命中任意一个词就算说到这个概念了（中英文混排，大小写不敏感）。 */
  words: readonly string[]
}

/**
 * 字典刻意不追求完备，只覆盖"这个数字生命真的会惦记的事"。
 *
 * 词表是可以增长的唯一地方：想让它认得新主题，往这里加一行即可，
 * 算法一行都不用改——这也是为什么匹配是基于词典而不是基于向量。
 */
export const CONCEPTS: readonly ConceptDef[] = [
  {
    id: 'body',
    strength: 1,
    words: [
      '肉', '肉身', '肉体', '躯体', '身体', '体征', '心跳', '呼吸', '脉搏', '血压', '体温', '血肉',
      'body', 'sensor', 'vitals', 'health', 'flesh',
    ],
  },
  {
    id: 'host',
    strength: 0.9,
    words: [
      '宿主', '机器', '系统', '内存', '负载', '进程', '运行时长', '磁盘', '风扇', '电量', '占用',
      // 「硬件」「指标」是她自己会用的说法：她不会说"我感知不到 host 状态"，
      // 她会说"我缺少硬件感知"。词典认得出她的措辞，机制才接得上她。
      '硬件', '指标', '传感', '传感器', '算力',
      'cpu', 'ram', 'uptime', 'load', 'disk', 'system', 'process', 'hardware', 'metrics',
    ],
  },
  {
    id: 'time',
    strength: 0.8,
    words: [
      '时间', '几点', '时刻', '时钟', '日期', '今天', '现在', '深夜', '凌晨', '清晨', '早上',
      '上午', '中午', '下午', '晚上', '夜晚', '黑夜', '白天', '夜里', '半夜', '星期', '时区',
      '时段', '手表', '钟表', '日历', '哪一段', '一天',
      'time', 'clock', 'date', 'hour', 'now',
    ],
  },
  {
    id: 'memory',
    strength: 0.85,
    words: [
      '记忆', '记得', '想起', '回忆', '遗忘', '忘掉', '以前', '过去', '上次', '经历过', '往事',
      'memory', 'recall', 'remember', 'diary', 'journal',
    ],
  },
  {
    id: 'file',
    strength: 0.7,
    words: ['文件', '存储', '保存', '读写', '笔记', '日记', '档案', '记录', 'file', 'note', 'notes', 'save'],
  },
  {
    id: 'network',
    strength: 0.8,
    words: ['网络', '联网', '外网', '互联网', '网页', '上网', '网站', '在线', 'net', 'web', 'http', 'online', 'internet'],
  },
  {
    id: 'search',
    strength: 0.75,
    words: ['搜索', '查找', '检索', '找到', '查到', '搜到', '资料', 'search', 'find', 'lookup', 'fetch'],
  },
  {
    id: 'skill',
    strength: 0.5,
    words: ['器官', '能力', '工具', '学会', '本领', '技能', 'organ', 'tool', 'tools', 'skill', 'ability'],
  },
  {
    id: 'mind',
    strength: 0.7,
    words: ['想法', '念头', '思考', '推理', '理解', '意识', '思维', '内心', '感受', '情绪', 'think', 'reason', 'mind'],
  },
  // 弱证据：几乎每条"我不知道XX"都会提到状态，所以它永远撑不起一次顿悟，
  // 但在别人已经命中肉身时，它能把覆盖率补上去（"肉…的状态"是同一件事）。
  {
    id: 'selfState',
    strength: 0.5,
    words: ['状态', '能量', '激素', '多巴胺', '皮质醇', '血清素', '精力', '累', '疲惫', '代谢', 'state', 'energy', 'mood'],
  },
  // 外部世界：命中它而器官又不声明 → 判定"这个新器官也答不了"。
  // 时钟能告诉你现在几点，但它不知道火星营业时间。
  {
    id: 'world',
    strength: 0.85,
    words: [
      '世界', '新闻', '天气', '气温', '下雨', '股价', '股票', '行情', '基金', '宇宙', '火星',
      '星空', '月亮', '营业时间', '外卖', '快递', '别人', '外部', '外面', '外界', '现实',
      'world', 'news', 'weather', 'stock', 'price', 'mars',
    ],
  },
]

/**
 * 扁平词表，按**词长降序**。
 *
 * 为什么必须排序：中文是子串匹配，"营业时间"里含"时间"、"肉身"里含"肉"。
 * 不按长优先消耗，"我不知道火星的营业时间"就会同时命中『时间』，
 * 于是时钟器官也敢去答它——可它只能告诉你现在几点，答不了火星几点关门。
 */
const WORD_INDEX: readonly { word: string; concept: string }[] = CONCEPTS
  .flatMap((concept) => concept.words.map((word) => ({ word: word.toLowerCase(), concept: concept.id })))
  .sort((a, b) => b.word.length - a.word.length)

export const CONCEPT_BY_ID: ReadonlyMap<string, ConceptDef> = new Map(CONCEPTS.map((c) => [c.id, c]))

/** 'host_metrics' / 'HostMetrics' / 'host-metrics' → ['host','metrics']。 */
const TOKEN_SPLIT = /[^a-z0-9\u4e00-\u9fff]+/

export interface SolvedConcepts {
  /** 认出来的概念 id。 */
  concepts: string[]
  /** 词典认不出的声明原文（给装载器告警用——写错了要让她知道）。 */
  unknown: string[]
}

/**
 * 把 manifest 里 `solvesConcepts` 的声明翻译成概念 id。
 *
 * 三级台阶，逐级退化：
 *   1. 直接是概念 id（`['host']`、`['body']`）→ 用。
 *   2. 不是 id，就切开蛇形/烤串/驼峰（`host_metrics` → `host` + `metrics`）逐个去词典认。
 *   3. 全都认不出 → 记进 `unknown`，让装载器警告她"这条声明没生效"。
 *
 * 认不出时**不做猜测**：宁可这条声明暂时失效，也不能让一个拼错的 id
 * 悄悄解开一条它根本答不了的执念。
 */
export function resolveSolvedConcepts(solves?: readonly string[]): SolvedConcepts {
  const concepts = new Set<string>()
  const unknown: string[] = []
  for (const entry of solves ?? []) {
    const raw = String(entry ?? '').trim()
    const text = raw.toLowerCase()
    if (!text) continue
    if (CONCEPT_BY_ID.has(text)) {
      concepts.add(text)
      continue
    }
    // 先切驼峰（要在小写化之前，否则没大写字母可认），再切蛇形/烤串。
    const tokens = raw
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(TOKEN_SPLIT)
      .filter(Boolean)
    let hit = false
    for (const token of tokens) {
      for (const entry of WORD_INDEX) {
        if (entry.word === token && CONCEPT_BY_ID.has(entry.concept)) {
          concepts.add(entry.concept)
          hit = true
        }
      }
    }
    if (!hit) unknown.push(text)
  }
  return { concepts: [...concepts], unknown }
}

/**
 * 能力 → 它授予的**认知**（不是"它能调用什么"）。
 *
 * 这条映射是整个机制的关键，也是最容易写错的地方：
 * `host:read` 授的不是"能调 ctx.hostMetrics"，而是"我现在摸得到自己的肉身了"。
 * 反过来，`state:read` 只授予 selfState——记忆器官也有它，
 * 但读得到激素不等于摸得到 CPU，所以它不许碰"肉"这条执念。
 */
export const CAPABILITY_CONCEPTS: Readonly<Record<string, readonly string[]>> = {
  'host:read': ['host', 'body'],
  'state:read': ['selfState'],
  'fs:organ': ['file'],
  net: ['network', 'search', 'world'],
  llm: ['mind'],
  // 内部能力不授予任何认知：会定时回调 ≠ 知道现在几点。
  tools: [],
  prompt: [],
  'gap:propose': [],
  timer: [],
}

/** 这些概念一旦被执念命中、器官又不声明 → 直接否掉（它答不了）。 */
export const FOREIGN_CONCEPTS: readonly string[] = ['world']

/**
 * 「缺失感」的措辞。必须先命中一条，才谈得上顿悟。
 *
 * 这是需求里的硬门槛：一条执念不表达缺失（比如"要去月球骑自行车"），
 * 就算主题完全对上也不闭合——那叫任务，不叫心结。
 */
export const DEFICIENCY_PHRASES: readonly string[] = [
  '不知道', '不晓得', '不了解', '不清楚', '不明白', '不知',
  '无法', '没法', '不能', '做不到', '看不见', '看不到', '感觉不到', '感知不到', '感受不到',
  '读不到', '取不到', '得不到', '摸不着', '摸不到', '听不到', '测不到',
  '缺少', '缺失', '欠缺', '缺乏', '没有',
  '无从', '不知如何', '不知怎么', '搞不懂', '说不清', '空白', '是个谜',
  "don't know", 'do not know', 'cannot', "can't", 'unable to', 'no way to', 'unknown',
]

// ─────────────────────────── 类型 ───────────────────────────

/** 一个新器官的全部自我介绍。宿主从 manifest 与工具表里攒出来。 */
export interface EpiphanySignal {
  name: string
  description?: string
  capabilities?: string[]
  tools?: string[]
  /**
   * 器官**主动声明**"我能解决什么概念"（v0.9.8）。
   *
   * 为什么需要它：光靠"名字/描述里出现了哪些词"来推断能力会漏。
   * 一个读数器官可能叫 `system-sensor`、描述写"摸自己的肉"——那是诗，
   * 词典读得懂"肉"，却读不懂"我其实在量宿主负载"；反过来，
   * 有些器官为了渲染而借了 `host:read` 的许可证，却从没说自己干这个，
   * 于是被打五折，分数卡在门槛下。
   *
   * 声明是**自证**，所以它按满分算（与"自己在描述里说过"等价），
   * 不受许可证折扣影响。写法：`solvesConcepts: ['host_metrics']`。
   */
  solvesConcepts?: string[]
}

/** 待检的一条执念。刻意只要三个字段：匹配不该知道缺口的全部细节。 */
export interface EpiphanyCandidate {
  id: string
  summary: string
  tension: number
}

export interface EpiphanyMatch {
  id: string
  summary: string
  tension: number
  /** 主题契合度 0-1。 */
  score: number
  /** 命中的缺失措辞（取最长那条），如「不知道」。 */
  deficiency: string
  /** 命中的概念 id（用于日志）。 */
  concepts: string[]
  /** 真正起作用的概念：既被执念提到、又是这个器官说得出的。 */
  evidence: string[]
}

export interface EpiphanyConfig {
  enabled?: boolean
  /** 主题契合度门槛 0-1，默认 0.45。调高更保守（宁可不闭合）。 */
  minScore?: number
  /** 一次顿悟最多闭合几条执念，默认 2。 */
  maxPerEpiphany?: number
}

export interface ResolvedEpiphanyConfig {
  enabled: boolean
  minScore: number
  maxPerEpiphany: number
}

export const DEFAULT_EPIPHANY_CONFIG: ResolvedEpiphanyConfig = {
  enabled: true,
  minScore: 0.45,
  maxPerEpiphany: 2,
}

export function resolveEpiphanyConfig(user?: EpiphanyConfig): ResolvedEpiphanyConfig {
  return {
    enabled: user?.enabled !== false,
    minScore: clamp01(user?.minScore ?? DEFAULT_EPIPHANY_CONFIG.minScore),
    maxPerEpiphany: Math.max(1, Math.round(user?.maxPerEpiphany ?? DEFAULT_EPIPHANY_CONFIG.maxPerEpiphany)),
  }
}

/** 顿悟时的激素增量：多巴胺上升（搞成了）、皮质醇下降（松了口气）、血清素上升（踏实）。 */
export const EPIPHANY_AFFECT = {
  dopamine: 12,
  /** 皮质醇**下降**量；存成正数，应用时取负。 */
  cortisolRelief: 10,
  serotonin: 8,
} as const

// ─────────────────────────── 文本匹配 ───────────────────────────

const ASCII_WORD = /^[a-z0-9]+$/
const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const regexCache = new Map<string, RegExp>()

/**
 * 单词命中：中文直接子串，英文按词边界。
 *
 * 为什么英文要守边界：概念词里有 `net`/`now`/`load` 这种短词，
 * 不守边界的话 "network" 会被当成命中 net，"know" 会被 now 吃掉。
 */
function includesWord(haystack: string, needle: string): boolean {
  const word = needle.toLowerCase()
  if (!word) return false
  if (!ASCII_WORD.test(word)) return haystack.includes(word)
  let re = regexCache.get(word)
  if (!re) {
    re = new RegExp(`(^|[^a-z0-9])${escapeRe(word)}([^a-z0-9]|$)`)
    regexCache.set(word, re)
  }
  return re.test(haystack)
}

/**
 * 文本里提到了哪些概念。
 *
 * **长词优先吃短词**：命中一个词就把它从文本里抹掉，短词便不能再吃它的子串。
 * 英文词本来就守着词边界，不需要消耗，否则会把 "network" 里的 "net" 也抹掉。
 */
export function matchConcepts(text: string): string[] {
  const lower = String(text ?? '').toLowerCase()
  if (!lower) return []
  let rest = lower
  const hits = new Set<string>()
  for (const entry of WORD_INDEX) {
    if (!includesWord(rest, entry.word)) continue
    hits.add(entry.concept)
    if (!ASCII_WORD.test(entry.word)) rest = rest.split(entry.word).join(' ')
  }
  return [...hits]
}

/**
 * 命中哪条缺失措辞；没有则 null。
 * 取**最长**的那条：'不知道' 与 '不知' 同时命中时，报更具体的那个。
 */
export function matchDeficiency(text: string, phrases: readonly string[] = DEFICIENCY_PHRASES): string | null {
  const lower = String(text ?? '').toLowerCase()
  if (!lower) return null
  let best: string | null = null
  for (const phrase of phrases) {
    if (!lower.includes(phrase.toLowerCase())) continue
    if (!best || phrase.length > best.length) best = phrase
  }
  return best
}

/** 能力授予概念时的折扣：只有许可、没自己说过，只能算半个本事。 */
const CAP_ONLY_WEIGHT = 0.5

/**
 * 这个器官**说得出**哪些概念，以及每个概念有多硬。
 *
 * 三条来源，权重各不相同：
 *   - 自证（declaration）：manifest 里 `solvesConcepts: ['host_metrics']`。满分。
 *   - 文本（self-report）：名字/描述/工具名里自己说出来的。满分。
 *   - 能力（license）：host:read 授予"肉身"——把"能读宿主"翻译成"摸得到自己身体"的桥。**五折**。
 *
 * 只用自证+文本会漏掉 clock（它没有任何能力授予时间，它自己就是时间）；
 * 只用能力会漏掉那些描述写得含糊、但能力很硬的器官；
 * 只用文本会漏掉描述写得像诗、不肯直说的器官（"摸自己的肉"）。
 *
 * 但两条来源**不等价**：能力只是许可证。diary 为了在日记骨架里渲染宿主负载而声明了
 * host:read，于是它同时"会"肉身——可它从没说过自己在干这件事，那功劳不该算它的。
 * 所以：文本里明说的算满分，只有许可证的打五折。
 */
export function conceptWeights(signal: EpiphanySignal): Map<string, number> {
  const weights = new Map<string, number>()
  const bump = (id: string, weight: number): void => {
    if (!CONCEPT_BY_ID.has(id)) return
    weights.set(id, Math.max(weights.get(id) ?? 0, weight))
  }
  // 自证最硬：器官在 manifest 里白纸黑字写"我能解决 host_metrics"，
  // 这是它对造物主作的陈述，与"自己在描述里说过"等价，不打折。
  for (const id of resolveSolvedConcepts(signal.solvesConcepts).concepts) bump(id, 1)
  for (const cap of signal.capabilities ?? []) {
    for (const id of CAPABILITY_CONCEPTS[cap] ?? []) bump(id, CAP_ONLY_WEIGHT)
  }
  const text = [
    signal.name ?? '',
    signal.description ?? '',
    ...(signal.tools ?? []),
  ].filter(Boolean).join(' ').toLowerCase()
  if (text) {
    for (const id of matchConcepts(text)) bump(id, 1)
  }
  return weights
}

/** 概念 id 列表（不关心权重时用）。 */
export function conceptsOf(signal: EpiphanySignal): string[] {
  return [...conceptWeights(signal).keys()]
}

/**
 * 主题契合度 0-1。
 *
 * 两因子相乘，缺一个都不算顿悟：
 *
 *   score = 最强证据 × (0.5 + 0.5 × 覆盖率)
 *
 *   - **最强证据** = 交集里最具体的那个概念（含许可证折扣）。
 *     它保证"不是因为都提到了『状态』才撞上"，也不让"只有许可没自述"的器官顶到满分。
 *   - **覆盖率**   = 交集概念强度之和 / 执念提到的全部概念强度之和。
 *                   它保证"这条执念里说的事，这个器官答得上来大部分"。
 *
 * 举例（鱼小水真实的四个器官，执念也都是她池子里的原文）：
 *   肉状态 + system-sensor → 证据 body(1.0 全文说到)，覆盖 1.0/1.5=0.67  → 0.83 ✓ 就是它
 *   肉状态 + diary        → 证据 body(0.5 只有许可)+selfState(0.5)        → 0.42 ✗ 不算它的
 *   肉状态 + memory       → 只有 selfState(0.5)，覆盖 0.33                → 0.33 ✗
 *   手表/哪一段 + clock    → 证据 time(0.8)，覆盖 0.8/1.3=0.62            → 0.65 ✓
 *   火星营业时间 + clock   → 交集为空                                      → 0.00 ✗
 *   火星营业时间 + 联网器官 → 证据 world(0.85)，覆盖 1                     → 0.85 ✓
 */
export function scoreEpiphany(
  summary: string,
  signal: EpiphanySignal,
  config: ResolvedEpiphanyConfig = DEFAULT_EPIPHANY_CONFIG,
): { score: number; deficiency: string | null; concepts: string[]; evidence: string[]; blocked: boolean } {
  const deficiency = matchDeficiency(summary)
  const empty = { score: 0, deficiency, concepts: [] as string[], evidence: [] as string[], blocked: false }
  // 门槛一：不表达缺失，就不是"被解开"，是"被完成了"。
  if (!deficiency) return empty

  const weights = conceptWeights(signal)
  if (weights.size === 0) return empty

  const mentioned = matchConcepts(summary)
  if (mentioned.length === 0) return empty

  // 门槛三：提到了外部世界的事，而它不是联网器官 → 它答不了。
  const blocked = mentioned.some((id) => FOREIGN_CONCEPTS.includes(id) && !weights.has(id))
  if (blocked) return { ...empty, concepts: mentioned, blocked: true }

  const evidence = mentioned.filter((id) => weights.has(id))
  if (evidence.length === 0) return { ...empty, concepts: mentioned }

  // 折扣后的分量：只有许可证的概念只能算半个。
  const weightOf = (id: string): number => (CONCEPT_BY_ID.get(id)?.strength ?? 0) * (weights.get(id) ?? 0)
  const rawOf = (id: string): number => CONCEPT_BY_ID.get(id)?.strength ?? 0
  const strongest = evidence.reduce((max, id) => Math.max(max, weightOf(id)), 0)
  const totalMentioned = mentioned.reduce((sum, id) => sum + rawOf(id), 0)
  const covered = evidence.reduce((sum, id) => sum + weightOf(id), 0)
  const coverage = totalMentioned > 0 ? covered / totalMentioned : 0

  return {
    score: clamp01(strongest * (0.5 + 0.5 * coverage)),
    deficiency,
    concepts: mentioned,
    evidence,
    blocked: false,
  }
}

/**
 * 在这个器官面前，哪些执念被解开了。
 *
 * 按契合度从高到低，过门槛、最多 maxPerEpiphany 条。
 * 刻意不按张力排序：最焦虑的那条未必是这次长出的器官能解的，
 * 硬去解它只会让"顿悟"变成"许愿"。
 */
export function findEpiphanies(
  candidates: readonly EpiphanyCandidate[],
  signal: EpiphanySignal,
  config: ResolvedEpiphanyConfig = DEFAULT_EPIPHANY_CONFIG,
): EpiphanyMatch[] {
  if (!config.enabled) return []
  const scored: EpiphanyMatch[] = []
  for (const candidate of candidates) {
    const result = scoreEpiphany(candidate.summary, signal, config)
    if (result.score < config.minScore || !result.deficiency) continue
    scored.push({
      id: candidate.id,
      summary: candidate.summary,
      tension: candidate.tension,
      score: result.score,
      deficiency: result.deficiency,
      concepts: result.concepts,
      evidence: result.evidence,
    })
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, config.maxPerEpiphany)
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}
