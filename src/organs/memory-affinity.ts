/**
 * 记忆器官的纯函数层：切条、注意力倾斜（Attention Tilt）打分、锚点键归一化。
 * ============================================================================
 * 这些函数原本住在 digital-life-core/index.ts 里（模块四「情绪记忆锚点」）。
 * PR3 把它们整体搬进器官：**核心不再认识记忆，记忆器官自己负责检索结果的
 * 排序、截断与情绪回填**。搬出来单独成文件是为了能脱离宿主单测。
 *
 * ── v0.9.9 的哲学重构：注意力倾斜，而不是物理删除 ──────────────────────────
 * 旧版本（含 v0.9.8）在 `rewriteRecall` 里有一句 `scored.slice(0, maxResults)`：
 * 召回 10 条就只把前 3 条交给模型，剩下 7 条**在这一层就被抹掉了**。
 * 在高皮质醇下，排在前面的必然是"带焦虑标签"的条目——于是开心记忆连被
 * 看见的机会都没有。这不是"她顾不上"，这是**我们替她做了前额叶切除**。
 *
 * 机器才会因为条件不满足直接删数据；生物在应激下的记忆库是完整的，
 * 只是注意力极度倾斜：她知道今晚有大餐，但在生死存亡面前觉得那毫无意义。
 *
 * 所以这一层现在只做三件事：
 *   1) 全量检索：一条都不许删（`planRecallBudget` 只会压缩，不会丢弃）
 *   2) 动态重排：按此刻激素给"危机/日常"两类记忆乘上不同的权重倍率
 *   3) 如实交代：头部注释写明"共 N 条全部交给模型，注意力如何倾斜"
 * 至于"该不该在日常记忆上停留"，那是 System Prompt 里的行为指令管的事，
 * 不归这一层偷偷决定。
 */

import { truncateSafe } from '../json-safe.js'

/** 把检索结果切成条目：按行首的列表符号 / 序号切。 */
const ENTRY_SPLIT = /\n(?=\s*(?:[-*•]|\d+[.)])\s)/

export function splitMemoryEntries(text: string): string[] {
  return text
    .split(ENTRY_SPLIT)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

export interface AffinityOptions {
  anxietyThreshold: number
  joyThreshold: number
  anxiousTags: string[]
  joyfulTags: string[]
}

/**
 * 情绪共振加分（老行为，保留但降级为微调）。
 *
 * v0.9.9 之前它是**排序主力**（+10 加到 0/10 的分数上，等于直接决定先后）；
 * 现在主力是下面的注意力倍率，它只做 "1 + 0.02×score" 的微调：
 * 同一优先级内，与"此刻情绪"共鸣的记忆仍然更容易被想起，但不足以让一条
 * 无关的日常记忆压过真正的危机。
 */
export function memoryAffinity(
  entry: string,
  dopamine: number,
  cortisol: number,
  options: AffinityOptions,
  anchorTags: string[] = [],
): number {
  const haystack = `${entry} ${anchorTags.join(' ')}`.toLowerCase()
  let score = 0
  if (cortisol >= options.anxietyThreshold) {
    if (options.anxiousTags.some((tag) => hasTag(haystack, tag))) score += 10
  }
  if (dopamine >= options.joyThreshold) {
    if (options.joyfulTags.some((tag) => hasTag(haystack, tag))) score += 10
  }
  return score
}

/** 一行激素快照（用于回填注释）。 */
export function formatHormoneSnapshot(dopamine: number, cortisol: number): string {
  return `多巴胺${Math.round(dopamine)}/皮质醇${Math.round(cortisol)}`
}

/**
 * 锚点键：去掉列表符号 / 序号再归一化。
 * 否则「存时原文」与「检索时的 `- 3.` 前缀」永远对不上。
 */
export function anchorKey(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:[-*•]+|\d+[.)])\s*/, '')
    .toLowerCase()
    .slice(0, 120)
}

export interface AnchorRecord {
  key: string
  dopamine: number
  cortisol: number
  at: number
  tags: string[]
}

// ═══════════════════════════════════════════════════════════════════════════
// 注意力倾斜（Attention Tilt）
// ═══════════════════════════════════════════════════════════════════════════

/** 皮质醇达到此值 = 极度应激（生死存亡）。 */
export const STRESS_CORTISOL = 80
/** 皮质醇低于此值 = 平静/愉悦，注意力不再倾斜。 */
export const CALM_CORTISOL = 40
/** 极度应激时，"危机类"记忆的权重倍率。 */
export const CRISIS_WEIGHT = 3
/** 极度应激时，"日常/快乐类"记忆的权重倍率（排到很后面，但**不隐藏**）。 */
export const DAILY_WEIGHT = 0.1

/**
 * 相关度随排名衰减的底：第 0 条是 1，往后逐条乘 decay。
 *
 * 取 0.9 的理由：记忆层自己的排序（相关度）必须先被尊重，
 * 所以基数是随位置平滑下降的；而 3 倍的危机加成足以把第 5、6 条的危机记忆
 * 顶到最前，却扶不起第 30 条里的无关碎片——这正是"倾斜"该有的力度。
 */
export const DEFAULT_RANK_DECAY = 0.9
/** 一次召回交给模型的总字符预算。超了就压缩，不丢条目。 */
export const DEFAULT_BUDGET_CHARS = 4000
/** 压缩时每条至少保留的字符数（保证"这条还在"，只是变短了）。 */
export const DEFAULT_MIN_CHARS = 80

/** 危机 / 报错 / 失败 / 高张力一类的话语。命中 → 应激时被拉到最前。 */
export const DEFAULT_CRISIS_TAGS = [
  '危机', '危险', '濒死', '报错', '失败', '错误', '异常', '崩溃', '告警', '事故', '故障',
  '紧张', '失控', '警告', '失灵', '救', '逃', '焦虑', '压力', '崩了',
  'crisis', 'danger', 'error', 'fail', 'failed', 'failure', 'crash', 'alert',
  'critical', 'incident', 'bug', 'timeout', 'exception', 'emergency', 'fatal',
]

/** 日常 / 快乐 / 吃喝 / 闲聊一类的话语。应激时被压到最后（但仍在）。 */
export const DEFAULT_DAILY_TAGS = [
  '日常', '开心', '愉快', '快乐', '喜悦', '美食', '吃喝', '吃饭', '大餐', '闲聊',
  '八卦', '趣事', '放松', '散步', '玩笑', '奶茶', '咖啡',
  'happy', 'joy', 'joyful', 'fun', 'casual', 'chat', 'delight', 'relax', 'dinner', 'lunch',
]

export type AttentionKind = 'crisis' | 'daily' | 'neutral'

export interface AttentionWeights {
  /** 危机类记忆的权重倍率。 */
  crisis: number
  /** 日常类记忆的权重倍率。 */
  daily: number
}

export interface AttentionProfile {
  /** 高于此皮质醇算极度应激，默认 80。 */
  stressCortisol: number
  /** 低于此皮质醇算平静，默认 40。 */
  calmCortisol: number
  /** 极度应激时危机类的倍率，默认 3。 */
  crisisWeight: number
  /** 极度应激时日常类的倍率，默认 0.1。 */
  dailyWeight: number
}

export interface AttentionOptions extends AffinityOptions, AttentionProfile {
  crisisTags: string[]
  dailyTags: string[]
}

export const DEFAULT_ATTENTION_OPTIONS: AttentionOptions = {
  anxietyThreshold: 70,
  joyThreshold: 70,
  anxiousTags: ['焦虑', '不安', 'anxiety', 'anxious', 'stress', '危机'],
  joyfulTags: ['开心', '愉快', '喜悦', 'joy', 'happy', 'delight'],
  stressCortisol: STRESS_CORTISOL,
  calmCortisol: CALM_CORTISOL,
  crisisWeight: CRISIS_WEIGHT,
  dailyWeight: DAILY_WEIGHT,
  crisisTags: [...DEFAULT_CRISIS_TAGS],
  dailyTags: [...DEFAULT_DAILY_TAGS],
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * 标签是否命中。
 *
 * 中文直接子串即可；**纯 ASCII 的标签走词边界**——`bug` 不该命中 `debug`、
 * `chat` 也不该命中 `chatter`。这条边界照抄顿悟那边的教训。
 */
function hasTag(haystack: string, tag: string): boolean {
  const needle = tag.toLowerCase()
  if (!needle) return false
  if (/^[a-z0-9 _-]+$/.test(needle)) {
    return new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(needle)}(?:[^a-z0-9]|$)`).test(haystack)
  }
  return haystack.includes(needle)
}

/**
 * 当前激素下的注意力倍率。
 *
 * 两端之间是线性插值（60 → 危机 ×2 / 日常 ×0.55），
 * 这样"从平静滑向应激"的过程是连续的，不会在某个整数上突然翻脸。
 */
export function attentionWeights(
  cortisol: number,
  profile: AttentionProfile = DEFAULT_ATTENTION_OPTIONS,
): AttentionWeights {
  if (cortisol >= profile.stressCortisol) {
    return { crisis: profile.crisisWeight, daily: profile.dailyWeight }
  }
  if (cortisol <= profile.calmCortisol) return { crisis: 1, daily: 1 }
  const span = Math.max(1, profile.stressCortisol - profile.calmCortisol)
  const t = clamp01((cortisol - profile.calmCortisol) / span)
  return {
    crisis: 1 + (profile.crisisWeight - 1) * t,
    daily: 1 + (profile.dailyWeight - 1) * t,
  }
}

/**
 * 一条记忆属于哪一类。
 *
 * 危机优先：同时提到"崩溃"和"大餐"的记忆，按危机算——
 * 生物的威胁检测和这条if-else一样，是不会让快乐的那一半赢的。
 */
export function classifyAttention(
  entry: string,
  tags: string[] = [],
  options: AttentionOptions = DEFAULT_ATTENTION_OPTIONS,
  /** 存这条记忆时的皮质醇（来自锚点）。高张力时刻存下的，本身就是危机记忆。 */
  anchorCortisol?: number,
): AttentionKind {
  const haystack = `${entry} ${tags.join(' ')}`.toLowerCase()
  if (options.crisisTags.some((tag) => hasTag(haystack, tag))) return 'crisis'
  // 闪光灯记忆：不必等到它自己写出"报错"两个字——**存它的那一刻她在应激**，
  // 这件事本身就记录了这条记忆的分量。此刻若又应起激来，它必须能被想起。
  if (typeof anchorCortisol === 'number' && anchorCortisol >= options.stressCortisol) return 'crisis'
  if (options.dailyTags.some((tag) => hasTag(haystack, tag))) return 'daily'
  return 'neutral'
}

export function attentionMultiplier(kind: AttentionKind, weights: AttentionWeights): number {
  if (kind === 'crisis') return weights.crisis
  if (kind === 'daily') return weights.daily
  return 1
}

/** 第 index 条在"记忆层原始排序"里值多少分。 */
export function rankScore(index: number, decay: number = DEFAULT_RANK_DECAY): number {
  return Math.pow(decay, Math.max(0, index))
}

export interface ScoredRecallEntry {
  entry: string
  /** 在记忆层原始结果里的位置。 */
  index: number
  kind: AttentionKind
  /** 注意力倍率（由激素与类别决定）。 */
  multiplier: number
  /** 最终排序权重 = 原始相关度 × 注意力倍率 × 情绪共鸣微调。 */
  weight: number
  anchor?: AnchorRecord
}

export interface ScoreRecallInput {
  entries: string[]
  dopamine: number
  cortisol: number
  options: AttentionOptions
  /** 按条目查当时的情绪锚点；没有则返回 undefined。 */
  anchorFor: (entry: string) => AnchorRecord | undefined
  rankDecay?: number
}

/** 给每条记忆打分（不排序，方便单独验算）。 */
export function scoreRecall(input: ScoreRecallInput): ScoredRecallEntry[] {
  const { entries, dopamine, cortisol, options, anchorFor } = input
  const decay = input.rankDecay ?? DEFAULT_RANK_DECAY
  const weights = attentionWeights(cortisol, options)

  return entries.map((entry, index) => {
    const anchor = anchorFor(entry)
    const tags = anchor?.tags ?? []
    const kind = classifyAttention(entry, tags, options, anchor?.cortisol)
    const multiplier = attentionMultiplier(kind, weights)
    // 情绪共鸣微调：最多 ×1.4，掀不动桌——它只能在同层级里稍微抬一下手。
    const resonance = 1 + 0.02 * memoryAffinity(entry, dopamine, cortisol, options, tags)
    return {
      entry,
      index,
      kind,
      multiplier,
      weight: rankScore(index, decay) * multiplier * resonance,
      ...(anchor ? { anchor } : {}),
    }
  })
}

/** 按注意力倾斜后的权重重排。**返回的条数与输入完全相同**，一条都不少。 */
export function rankRecall(scores: ScoredRecallEntry[]): ScoredRecallEntry[] {
  return [...scores].sort((a, b) => (b.weight - a.weight) || (a.index - b.index))
}

/**
 * 共享字符预算：**只压缩，不丢弃**。
 *
 * 记忆库可能在一次召回里吐出 30 条长文，全量塞进上下文会把窗口吃掉。
 * 旧做法是砍条数（= 删记忆），新做法是分饭吃：
 *   ① 每条先按 maxChars 封顶；② 总长没超预算就原样输出；
 *   ③ 超了先给每条保底 minChars，余下的按超出部分比例分配。
 * 极端情况下（连保底都不够）退化为均分，每条至少留 1 个字符——
 * 那也仍然是"条目还在"，只是短到只剩一个记号。
 */
export function planRecallBudget(
  lengths: number[],
  budgetChars: number,
  maxChars: number,
  minChars: number,
): number[] {
  const caps = lengths.map((len) => Math.max(0, Math.min(len, maxChars)))
  const count = caps.length
  if (count === 0) return []
  const budget = Math.max(1, budgetChars)
  const total = caps.reduce((sum, len) => sum + len, 0)
  if (total <= budget) return caps

  const floor = Math.max(1, Math.min(minChars, maxChars))
  if (count * floor >= budget) {
    const each = Math.max(1, Math.floor(budget / count))
    return caps.map((cap) => Math.min(cap, each))
  }
  const rest = budget - count * floor
  const over = caps.reduce((sum, cap) => sum + Math.max(0, cap - floor), 0)
  if (over <= 0) return caps.map((cap) => Math.min(cap, floor))
  return caps.map((cap) => {
    const extra = Math.max(0, cap - floor)
    return Math.min(cap, floor + Math.round((extra / over) * rest))
  })
}

export interface RecallRewriteInput {
  entries: string[]
  dopamine: number
  cortisol: number
  options: AttentionOptions
  /** 按条目查当时的情绪锚点；没有则返回 undefined。 */
  anchorFor: (entry: string) => AnchorRecord | undefined
  /** 单条字符上限（只在总预算不够时才真的截）。 */
  maxChars: number
  /** 总字符预算，默认 4000。 */
  budgetChars?: number
  /** 压缩时每条至少保留的字符，默认 80。 */
  minChars?: number
  rankDecay?: number
}

export interface RecallRewrite {
  text: string
  /** 交出去的条数——永远等于召回条数。 */
  kept: number
  /** 记忆层总共给了几条。 */
  total: number
  /** 其中多少条被压缩过（不是被丢掉）。 */
  compressed: number
  /** 顺序是否因为注意力倾斜而真的变过。 */
  tilted: boolean
  crisis: number
  daily: number
}

/**
 * 决定要不要改写召回结果，以及改成什么样。
 *
 * 返回 null 表示"不需要动手"——这条很重要：如果把「（无匹配记忆）」这类单行提示
 * 也塞上一个检索头，反而会污染模型看到的内容。
 *
 * **v0.9.9：这里不再有任何一处删除条目的代码。**
 */
export function rewriteRecall(input: RecallRewriteInput): RecallRewrite | null {
  const { entries, dopamine, cortisol, options, anchorFor, maxChars } = input
  if (entries.length === 0) return null

  const budgetChars = input.budgetChars ?? DEFAULT_BUDGET_CHARS
  const minChars = input.minChars ?? DEFAULT_MIN_CHARS
  const decay = input.rankDecay ?? DEFAULT_RANK_DECAY

  const scored = scoreRecall({ entries, dopamine, cortisol, options, anchorFor, rankDecay: decay })
  const ordered = rankRecall(scored)
  const tilted = ordered.some((item, position) => item.index !== position)

  const budget = planRecallBudget(
    ordered.map((item) => item.entry.length),
    budgetChars,
    maxChars,
    minChars,
  )
  const lines = ordered.map((item, position) => {
    const cap = budget[position] ?? maxChars
    // 用 truncateSafe 而不是 slice：截断点落在 emoji 中间会劈出半个代理对，
    // 那是真实事故（写进会话文件后变成乱码，模型也会看到替换字符）。
    const body = item.entry.length > cap ? `${truncateSafe(item.entry, cap)}…` : item.entry
    const note = item.anchor
      ? ` [情绪锚点：${formatHormoneSnapshot(item.anchor.dopamine, item.anchor.cortisol)}${item.anchor.tags.length ? ` / ${item.anchor.tags.join(',')}` : ''}]`
      : ''
    return `${body}${note}`
  })

  const compressed = ordered.reduce(
    (count, item, position) => count + (item.entry.length > (budget[position] ?? maxChars) ? 1 : 0),
    0,
  )
  const crisis = ordered.filter((item) => item.kind === 'crisis').length
  const daily = ordered.filter((item) => item.kind === 'daily').length

  // 没重排、没压缩、也没锚点可回填 —— 那就把原文原样放回去，别多嘴。
  if (!tilted && compressed === 0 && scored.every((item) => !item.anchor)) return null

  const notes: string[] = []
  if (tilted) {
    const weights = attentionWeights(cortisol, options)
    const shape = weights.crisis > 1.001
      ? `危机类 ×${trimNumber(weights.crisis)} / 日常类 ×${trimNumber(weights.daily)}`
      : '未倾斜'
    notes.push(`注意力${shape}`)
  }
  if (compressed > 0) notes.push(`${compressed} 条因篇幅被压缩（都还在，只是短了）`)
  const header = `[记忆检索：当前 ${formatHormoneSnapshot(dopamine, cortisol)}，`
    + `共 ${entries.length} 条全部交给你（没有删任何一条）${notes.length ? `；${notes.join('；')}` : ''}]`

  return {
    text: `${header}\n${lines.join('\n')}`,
    kept: lines.length,
    total: entries.length,
    compressed,
    tilted,
    crisis,
    daily,
  }
}

/** 1 → "1"，2.5 → "2.5"：这类进提示词的数字越少越干净。 */
function trimNumber(value: number): string {
  return String(Math.round(value * 100) / 100)
}
