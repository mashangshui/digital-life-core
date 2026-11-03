/**
 * 前后端共享的数据契约（唯一真源）。
 * 对应 server/snapshot.mjs 的输出；任何字段改名只需要同步这两处。
 */

/**
 * 作息状态（v0.9.6）。取值与核心 `SleepEnergyResult['mode']` 一一对应。
 * `sated` = 已到自然恢复上限；`frozen` = 急停冻结（不回血也不衰减）。
 */
export type RestMode = 'awake' | 'deep-sleep' | 'night-rest' | 'sated' | 'frozen'

export interface RestInfo {
  mode: RestMode
  /** 当前每分钟回血速率（点/分钟）。负数 = 高于自然上限，正在回落。 */
  rate: number
  /** 自然恢复上限：躺着不动最多回到这里。 */
  cap: number
}

export interface Soma {
  energy: number
  maxEnergy: number
  dopamine: number
  cortisol: number
  /** 血清素：情绪底色。低 → 烦躁没耐心；高 → 稳定放松。（v0.9.1） */
  serotonin: number
  frozen: boolean
  scars: string[]
  idleMs: number
  /** 作息状态（v0.9.6）。老桥可能还没这个字段，前端要有兜底。 */
  rest?: RestInfo
}

export interface Counters {
  totalRequests: number
  totalTurns: number
  failedRequests: number
  blockedRequests: number
  wakeCount: number
  dreamCount: number
}

export type GapStatus = 'open' | 'resolved'

export interface GapView {
  id: string
  summary: string
  tension: number
  status: GapStatus
  source: string
  ageHours: number
}

export type OrganStatus = 'loaded' | 'degraded' | 'failed' | 'unloaded'

export interface OrganView {
  name: string
  version: string
  kind: string
  status: OrganStatus
  calls: number
  energySpent: number
  chargeMode: 'additive' | 'shadow'
  capabilities: string[]
  /** 这个器官实际挂在工具表里的名字（v0.9.3 起写入遥测）。 */
  tools: string[]
  lastCallAt: number | null
  /** true = 已禁用（幽灵）。服务端已滤掉，这里只是给类型留个口子。 */
  disabled?: boolean
}

/** 她体内的一条化学物质（v0.9.11，v0.9.18 起含她自己造的）。 */
export interface ChemicalView {
  id: string
  label: string
  /** 当前浓度。 */
  value: number
  /** 时间衰减的回归目标。 */
  baseline: number
  min: number
  max: number
  halfLifeMinutes: number
  description: string
  /** true = AI 自己在运行时造出来的，不在出厂基因组里。 */
  runtime: boolean
  /** 面板配色。来自 genome.json 的 ui.color，自造激素则由桥按 id 推一个。 */
  color: string
  /** 排序位。没有 ui.order 的自造激素排在最后。 */
  order: number | null
  group: string
  step: number
  ui: { group?: string; color?: string; order?: number; step?: number }
}

/** 出厂气质四旋钮（v0.9.12）。缺省值 = 中性人格。 */
export interface TemperamentView {
  sensitivity: number
  resilience: number
  enthusiasm: number
  metabolism: number
}

export interface GenomeView {
  /** 'file' = 读到了 genome.json；'default' = 用内置默认人格。 */
  source: 'file' | 'default'
  chemicals: ChemicalView[]
  /** v0.9.12：气质面板的数据源；老桥没有时前端用中性默认。 */
  temperament?: TemperamentView
}

export interface Snapshot {
  t: number
  soma: Soma
  counters: Counters
  gaps: GapView[]
  organs: OrganView[]
  /**
   * 化学池全景（v0.9.18）：出厂的 + 她自己造的，一条不落。
   *
   * 这是"她体内有什么"的**单一真源**——顶部体征条和基因面板都读它。
   * 老桥没有这个字段，前端要能退回三条硬编码的兜底。
   */
  chemicals?: ChemicalView[]
  /** v0.9.11：基因面板的数据源。老桥没有这个字段，前端要有兜底。 */
  genome?: GenomeView
  /** 被过滤掉的 disabled 器官数量（幽灵）。 */
  organsHidden?: number
  /**
   * 上一场梦的留档（v0.9.19）。
   *
   * 存在这里的理由：桥是**另一个进程**，它读不到记忆器官的内存，
   * 只能读 state.json。核心不留档，面板上"她梦见了什么"就永远是空的。
   */
  lastDream?: LastDreamView | null
}

export interface LastDreamView {
  /** 做梦的时刻（ISO）。 */
  at: string
  /** 梦见的是哪条执念。 */
  gap: string
  /** 梦的正文。 */
  text: string
  /** 真的落进记忆仓了（写完读回验证通过）。 */
  saved: boolean
  /** 落进记忆的条目 id；null = 没能进去。 */
  savedTo: string | null
}

/** 一次采样。t 是桥接收时刻，不是生理时刻——生理时刻在文件里没有秒级精度。 */
export interface PulseSample {
  t: number
  energy: number
  dopamine: number
  cortisol: number
  serotonin: number
  frozen: boolean
  /**
   * 全部激素的瞬时值，按 id（v0.9.19）。
   *
   * 老桥只有上面三个具名字段；有了这个，她自造的激素才画得出线。
   * 缺了它（老桥）时前端退回具名字段，三件套照样画得出来。
   */
  chemicals?: Record<string, number>
}

export type ServerMessage =
  | ({ type: 'snapshot'; pulseHistory: PulseSample[] } & Snapshot)
  | ({ type: 'state' } & Snapshot)
  | ({ type: 'pulse' } & PulseSample)
  | { type: 'heartbeat'; t: number }
  | { type: 'error'; text: string }

export type ConnStatus = 'connecting' | 'live' | 'polling' | 'offline'
