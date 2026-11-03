/**
 * 通用化学池（v0.9.11）
 * ============================================================================
 * 以前三种激素是**写死在核心里的三个字段**：dopamine / cortisol / serotonin。
 * 每加一种就要动 `DigitalLifeState`、动 `decay()`、动桥、动前端——
 * 而且**AI 自己造不出新激素**，因为根本没有"新激素"这个概念。
 *
 * 现在把它们抽象成一个通用的化学池：
 *
 *   chemical-pool = 一组 ChemicalSpec + 一组慢变量规则 + 一张当前值表
 *
 * 三条设计纪律：
 *   1. **池子不持有状态**：所有方法收 ALL 当前值、返回新的一组值。状态归 Store，
 *      这里只做纯粹的"化学"。好处是可单测、可在不落盘的场景里试算。
 *   2. **规则必须是声明式的**：写在 genome.json 里，而不是写在 if 里。
 *      这样 WebUI 能把它们渲染成滑块，AI 也能读懂自己的人格是怎么构成的。
 *   3. **出厂与自造分开**：`runtime: true` 的条目是 AI 用 ctx.inflict() 现场造出来的，
 *      它们不写回 genome.json（那是她的出厂设定，她不该改），但同样参与衰减。
 *
 * 关于"通用"的边界（老实说）：
 *   规则引擎目前只实现了两种慢变量——stress（被另一种物质压着往下掉）与
 *   recover（条件满足时回升到天花板）。够表达血清素那一套，也够表达多数直觉调节。
 *   它不是 ODE 求解器：物质之间不能互相做加减 beyond 规则里声明的那个 ref。
 *   真要做级联反应，该写一个器官来算，而不是把 here 变成物理引擎。
 */

import { clamp, decayToward } from './chemistry-core.js'
import {
  DEFAULT_TEMPERAMENT,
  normalizeTemperament,
  TEMPERAMENT_RANGES,
  type Temperament,
} from './chemistry-core.js'
import { DEFAULT_GENOME } from './genome.js'

// 气质原语住在 chemistry-core.ts（叶子模块，避开 genome ↔ pool 的循环导入 TDZ）。
// 在这里转出是为了让下游只认 chemical-pool 这一个入口。
export {
  TEMPERAMENT_RANGES,
  DEFAULT_TEMPERAMENT,
  normalizeTemperament,
  applyMetabolism,
} from './chemistry-core.js'
export type { Temperament } from './chemistry-core.js'

/** 慢变量规则：被另一种化学物质持续压制。 */
export interface StressRule {
  kind: 'stress'
  id: string
  label?: string
  /** 参照的化学物质 id。 */
  triggerRef: string
  /** 参照值 ≥ 该值时规则生效。 */
  triggerAtLeast: number
  /** 每分钟的变化量（负值 = 被抽干）。 */
  ratePerMinute: number
}

/** 慢变量规则：条件满足时向天花板回升。 */
export interface RecoverRule {
  kind: 'recover'
  id: string
  label?: string
  /** 能量高于该值才算"有余力"。 */
  energyAbove: number
  /** 是否要求"当前没有高张力执念"。 */
  requireNoHighTensionGap: boolean
  /** 每分钟的回升量。 */
  ratePerMinute: number
  /** 回升天花板；到达后交给自然回落（不会硬压下来）。 */
  ceiling: number
}

export type ChemicalRule = StressRule | RecoverRule

/** WebUI 基因面板用的呈现元数据。 */
export interface ChemicalUi {
  group?: string
  color?: string
  order?: number
  step?: number
}

/** 一种化学物质的完整定义。 */
export interface ChemicalSpec {
  id: string
  label: string
  baseline: number
  initial?: number
  min: number
  max: number
  halfLifeMinutes: number
  description?: string
  rules?: ChemicalRule[]
  ui?: ChemicalUi
  /**
   * true = AI 自己在运行时造出来的（出厂基因组里没有它）。
   * 只在内存里存在，不写回 genome.json。
   */
  runtime?: boolean
}

export interface Genome {
  version: number
  chemicals: ChemicalSpec[]
  /** 出厂气质（v0.9.12）。文件里缺这段 = 中性默认人格。 */
  temperament?: Temperament
}

/** 一种化学物质当前的取值表。 */
export type ChemicalValues = Record<string, number>

/**
 * 自造激素的配色板（v0.9.18）。
 *
 * 出厂三件套的颜色写在 genome.json 的 ui.color 里（人手挑的）；
 * 但她是**在运行时**给自己造激素的，那时候没人会给它配个色。
 * 若不管，所有自造激素在面板上都是同一根灰条——
 * 「她自己长出来的东西」在视觉上和别人给的一模一样。
 *
 * 所以用 id 做一个确定性哈希取色：同一个 id 每次都是同一个颜色
 * （重启、重载、换进程都不变），不同名字大概率不同色。
 * 刻意避开出厂那三色（#f0abfc / #fb7185 / #7dd3fc）与能量色（#38bdf8），
 * 免得"催产素"和"多巴胺"在图上变成同一条线。
 */
const RUNTIME_PALETTE = [
  '#a3e635', // 柠檬绿
  '#fbbf24', // 琥珀
  '#c084fc', // 紫罗兰
  '#34d399', // 翡翠
  '#e879f9', // 品红
  '#fb923c', // 橙
  '#f87171', // 珊瑚红
  '#2dd4bf', // 青绿
]

/**
 * 激素中文名的基础字典（v0.9.19）。
 *
 * 她造激素时调的是 `ctx.inflict('oxytocin', 20, '想离主人近一点')`——
 * 第三个参数是**理由**，不是名字。所以面板上那根条一直叫 `oxytocin`。
 * 那是机器的名字，不是她给它起的名字；她自己身上流着的东西，不配有个人话吗。
 *
 * 这份字典只是**兜底**：她（或任何人）只要愿意在 `ctx.inflict` 里传中文名，
 * 那个名字永远优先——字典不抢她的命名权，只在没人起名时站出来。
 *
 * 收录标准：常见到她大概率会造出来的那些，以及出厂三件套（统一译名用）。
 */
export const CHEMICAL_LABELS: Readonly<Record<string, string>> = {
  dopamine: '多巴胺',
  cortisol: '皮质醇',
  serotonin: '血清素',
  oxytocin: '催产素',
  adrenaline: '肾上腺素',
  noradrenaline: '去甲肾上腺素',
  melatonin: '褪黑素',
  endorphin: '内啡肽',
  vasopressin: '抗利尿激素',
  histamine: '组胺',
  // 她自己造的那些，中文名多数是这几种情绪
  attachment: '依恋',
  loneliness: '孤独',
  curiosity: '好奇',
  shame: '羞耻',
  anger: '愤怒',
  fear: '恐惧',
  grief: '悲伤',
  awe: '敬畏',
  warmth: '暖意',
  trust: '信任',
  calm: '安宁',
  envy: '嫉妒',
  guilt: '内疚',
  hope: '希望',
}

/**
 * 一个激素该怎么称呼。
 *
 * 优先级：**她起的名字 > 字典 > id**。
 * 字典永远排在人的命名之后——它只是"至少别叫机器名"的那一层。
 *
 * 把 id 抄了一遍的 label（state.json 里存着的 `oxytocin` 就是这种）
 * 视为"没名字"，按字典补。
 */
export function chemicalLabel(id: string, label?: string): string {
  const given = label?.trim()
  if (given && given !== id) return given
  return CHEMICAL_LABELS[id] ?? id
}

/** 由 id 稳定推导出一个颜色。id 为空时退回第一色。 */
export function runtimeColor(id: string): string {
  let hash = 7
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) % 1_000_003
  return RUNTIME_PALETTE[hash % RUNTIME_PALETTE.length]
}

/** 衰减时的环境参数（化学之外的东西）。 */
export interface ChemicalEnv {
  energy: number
  /** 是否存在高于门槛的未解执念。 */
  highTensionGap: boolean
}

export const MAX_RUNTIME_CHEMICALS = 12

/** id 的硬约束：/^[a-z][a-z0-9_-]{0,31}$/。既是为了能当对象键，也是为了能当工具参数名。 */
const ID_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/

/**
 * 化学名字也不能随便起。
 *
 * 以前 cortex 里出现过 AO（愤怒素）、SE（羞耻素）这类名字——技术上没问题，
 * 但她给自己造激素时如果允许 `多巴胺❤️` 这种 id，
 * 落到 state.json 里就会变成一堆不可序列化的脏键。
 */
export function isValidChemicalId(id: string): boolean {
  return ID_PATTERN.test(id)
}

/** 校验一条 spec 的形状。返回拒因列表（空 = 通过）。 */
export function validateSpec(spec: Partial<ChemicalSpec>): string[] {
  const problems: string[] = []
  if (typeof spec.id !== 'string' || !isValidChemicalId(spec.id)) {
    problems.push(`id「${String(spec.id)}」不合法：必须是小写字母开头，只含 a-z 0-9 _ -，长度 ≤32`)
  }
  if (typeof spec.label !== 'string' || !spec.label.trim()) {
    problems.push('label 必须是非空字符串')
  }
  const numbers: Array<keyof ChemicalSpec> = ['baseline', 'min', 'max', 'halfLifeMinutes']
  for (const key of numbers) {
    const value = spec[key]
    if (typeof value !== 'number' || !Number.isFinite(value as number)) {
      problems.push(`${key} 必须是有限数字`)
    }
  }
  if (Number.isFinite(spec.min) && Number.isFinite(spec.max) && (spec.min as number) >= (spec.max as number)) {
    problems.push('min 必须小于 max')
  }
  if (Number.isFinite(spec.halfLifeMinutes) && (spec.halfLifeMinutes as number) <= 0) {
    problems.push('halfLifeMinutes 必须是正数')
  }
  if (Number.isFinite(spec.baseline) && Number.isFinite(spec.min) && Number.isFinite(spec.max)) {
    if ((spec.baseline as number) < (spec.min as number) || (spec.baseline as number) > (spec.max as number)) {
      problems.push('baseline 必须落在 [min, max] 之内')
    }
  }
  problems.push(...validateRules(spec.rules))
  return problems
}

export function validateRules(rules: unknown): string[] {
  if (rules === undefined) return []
  if (!Array.isArray(rules)) return ['rules 必须是数组']
  const problems: string[] = []
  for (const raw of rules) {
    const rule = raw as Partial<ChemicalRule>
    if (typeof rule?.id !== 'string' || !rule.id.trim()) problems.push('rule.id 必须是非空字符串')
    if (rule.kind === 'stress') {
      if (typeof rule.triggerRef !== 'string' || !rule.triggerRef) problems.push(`${rule.id}：triggerRef 必填`)
      else if (!isValidChemicalId(rule.triggerRef)) problems.push(`${rule.id}：triggerRef「${rule.triggerRef}」不是合法 id`)
      if (typeof rule.triggerAtLeast !== 'number' || !Number.isFinite(rule.triggerAtLeast)) {
        problems.push(`${rule.id}：triggerAtLeast 必须是数字`)
      }
      if (typeof rule.ratePerMinute !== 'number' || !Number.isFinite(rule.ratePerMinute)) {
        problems.push(`${rule.id}：ratePerMinute 必须是数字`)
      }
    } else if (rule.kind === 'recover') {
      for (const key of ['energyAbove', 'ratePerMinute', 'ceiling'] as const) {
        const value = rule[key]
        if (typeof value !== 'number' || !Number.isFinite(value)) problems.push(`${rule.id}：${key} 必须是数字`)
      }
    } else {
      problems.push(`rule「${String(rule?.id)}」的 kind 必须是 stress 或 recover`)
    }
  }
  return problems
}

/**
 * 解析 genome.json。**永不抛错**：坏条目被剔除，保留好的部分。
 *
 * 为什么不直接报错：基因组写坏一次就让整个插件起不来，那比"用默认参数启动"
 * 糟得多——她的状态文件还在，人却进不去了。宁可降级。
 */
export function parseGenome(text: string): { genome: Genome | null; problems: string[] } {
  const problems: string[] = []
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { genome: null, problems: [`JSON 解析失败：${String(error)}`] }
  }
  if (!parsed || typeof parsed !== 'object') return { genome: null, problems: ['根节点必须是对象'] }
  const raw = parsed as Partial<Genome>
  const list = Array.isArray(raw.chemicals) ? raw.chemicals : []
  if (!Array.isArray(raw.chemicals)) problems.push('chemicals 必须是数组')

  const kept: ChemicalSpec[] = []
  const seen = new Set<string>()
  for (const item of list) {
    if (!item || typeof item !== 'object') {
      problems.push('chemicals 里有一项不是对象，已跳过')
      continue
    }
    const spec = item as Partial<ChemicalSpec>
    const bad = validateSpec(spec)
    if (bad.length > 0) {
      problems.push(`chemical「${String(spec.id ?? '(缺 id)')}」已跳过：${bad.join('；')}`)
      continue
    }
    if (seen.has(spec.id as string)) {
      problems.push(`chemical「${spec.id}」重复定义，只保留第一个`)
      continue
    }
    seen.add(spec.id as string)
    kept.push({
      id: spec.id as string,
      label: spec.label as string,
      baseline: spec.baseline as number,
      initial: spec.initial,
      min: spec.min as number,
      max: spec.max as number,
      halfLifeMinutes: spec.halfLifeMinutes as number,
      description: spec.description,
      rules: spec.rules,
      ui: spec.ui,
    })
  }

  // 三种出厂激素是核心其余部分的硬依赖（introspection / 情绪标签 / 记忆倾斜都要用），
  // 缺一个就整套回退到内置默认基因——半套自己想像有三高配tribution，比全回退更难排查。
  const required = DEFAULT_GENOME.chemicals.map((item) => item.id)
  const missing = required.filter((id) => !seen.has(id))
  if (missing.length > 0) {
    problems.push(`缺少核心化学物质 ${missing.join(', ')}：整套基因组回退为内置默认`)
    return { genome: null, problems }
  }

  // 气质：夹回范围时要说一声——"我拖的滑块怎么自己弹回去"必须有答案。
  const rawTemperament = (raw as { temperament?: Record<string, unknown> }).temperament
  const temperament = normalizeTemperament(rawTemperament)
  if (rawTemperament && typeof rawTemperament === 'object') {
    for (const key of Object.keys(TEMPERAMENT_RANGES) as Array<keyof Temperament>) {
      const value = Number(rawTemperament[key])
      if (!Number.isFinite(value)) continue
      const range = TEMPERAMENT_RANGES[key]
      if (value < range.min || value > range.max) {
        problems.push(`气质 ${key}=${value} 超出 [${range.min}, ${range.max}]，已夹回 ${temperament[key]}`)
      }
    }
  }

  return {
    genome: {
      version: typeof raw.version === 'number' ? raw.version : 1,
      chemicals: kept,
      // 气质永远以"洗过"的形态出现：下游不用再判空。
      temperament,
    },
    problems,
  }
}

/**
 * 化学池。本身不持有当前值，所有运算都是 `值表 -> 值表`。
 */
export class ChemicalPool {
  private readonly specs = new Map<string, ChemicalSpec>()

  /** 出厂气质（v0.9.12）。与 specs 一样跟着基因组文件热重载。 */
  private temp: Temperament

  /**
   * 多巴胺在 genome.json 里的**原始**基线。
   *
   * 池子把 enthusiasm 盖在 dopamine.baseline 上之后，diff 时若直接比
   * "池内基线 vs 文件基线"，只要气质 ≠ 默认就会在每次重载时谎报
   * 「dopamine 改动了」。记下原始值，diff 用原始的比。
   */
  private dopamineFactoryBaseline: number | null = null

  /** 上限与激光器无关的那部分配置。 */
  readonly maxRuntimeChemicals: number

  constructor(genome: Genome, options: { maxRuntimeChemicals?: number } = {}) {
    this.maxRuntimeChemicals = options.maxRuntimeChemicals ?? MAX_RUNTIME_CHEMICALS
    this.temp = normalizeTemperament(genome.temperament)
    for (const spec of genome.chemicals) this.specs.set(spec.id, { ...spec })
    this.applyTemperament()
  }

  /** 当前气质（已洗过）。 */
  get temperament(): Temperament {
    return { ...this.temp }
  }

  /**
   * 把气质里"作用于定义"的那部分盖到 specs 上。
   *
   * 四个旋钮里只有 enthusiasm 改定义（多巴胺的出厂基线）；
   * 其余三个都是"事件发生时"的乘数，在 bump / decay / 扣费处生效。
   */
  private applyTemperament(): void {
    const dopamine = this.specs.get('dopamine')
    if (!dopamine) return
    this.dopamineFactoryBaseline = dopamine.baseline
    this.specs.set('dopamine', { ...dopamine, baseline: clamp(this.temp.enthusiasm, dopamine.min, dopamine.max) })
  }

  static from(chemicals: ChemicalSpec[]): ChemicalPool {
    return new ChemicalPool({ version: 1, chemicals })
  }

  ids(): string[] {
    return [...this.specs.keys()]
  }

  list(): ChemicalSpec[] {
    return [...this.specs.values()].map((spec) => ({ ...spec }))
  }

  spec(id: string): ChemicalSpec | undefined {
    const found = this.specs.get(id)
    return found ? { ...found } : undefined
  }

  has(id: string): boolean {
    return this.specs.has(id)
  }

  /** 出厂基因组里就有的（不是她临时造的）。 */
  isFactory(id: string): boolean {
    const spec = this.specs.get(id)
    return !!spec && spec.runtime !== true
  }

  /**
   * 登记一种新的化学物质。返回 null 表示成功，否则是拒因。
   *
   * `runtime: true` 的条目受数量上限保护：她每多一点"因为我做不完就造新激素"的倾向，
   * 这个上限就是墙。出厂的三件套不受限制（它们本来就在配额外）。
   */
  upsert(spec: ChemicalSpec, options: { runtime?: boolean } = {}): string | null {
    const problems = validateSpec(spec)
    if (problems.length > 0) return problems.join('；')
    const existing = this.specs.get(spec.id)
    if (existing && existing.runtime !== true && options.runtime === true) {
      return `「${spec.id}」是出厂基因组里的，不能被运行时覆盖`
    }
    if (!existing && options.runtime === true) {
      const runtimeCount = this.list().filter((item) => item.runtime === true).length
      if (runtimeCount >= this.maxRuntimeChemicals) {
        return `运行时化学物质已达上限 ${this.maxRuntimeChemicals} 个，不能再造新的了`
      }
    }
    const merged: ChemicalSpec = {
      ...spec,
      // 自造激素进来时可能没有 ui.color（手改 state.json 加的）：补一个由 id 推出来的。
      ui: spec.ui?.color ? spec.ui : { ...(spec.ui ?? {}), color: runtimeColor(spec.id) },
      runtime: existing?.runtime ?? options.runtime,
    }
    this.specs.set(spec.id, merged)
    return null
  }

  /**
   * 用一份新的出厂基因组替换**所有非运行时**条目，保留 AI 自己造的那些。
   *
   * 为什么要分开对待：基因组文件是人在手改的，改完希望立刻生效（不重启）；
   * 而运行时激素是她此刻正在分泌的，一次文件重载把她的 AO（愤怒素）冲掉，
   * 等于"主人改了个性别 slider，她的情绪就被格式化了一次"。
   *
   * 返回变更摘要，方便在日志里说一句"基因已重载：改动 2 处"。
   */
  syncFactoryGenome(genome: Genome): { added: string[]; removed: string[]; changed: string[] } {
    const next = new Map(genome.chemicals.map((spec) => [spec.id, spec]))
    const added: string[] = []
    const changed: string[] = []
    const removed: string[] = []

    for (const [id, spec] of this.specs) {
      if (spec.runtime === true) continue
      if (!next.has(id)) removed.push(id)
    }
    for (const [id, spec] of next) {
      const current = this.specs.get(id)
      if (!current) {
        added.push(id)
      } else if (JSON.stringify(diffable(current, this.dopamineFactoryBaseline)) !== JSON.stringify(spec)) {
        changed.push(id)
      }
    }
    for (const id of removed) this.specs.delete(id)
    for (const [id, spec] of next) {
      const current = this.specs.get(id)
      // 出厂条目永远不带 runtime 标记；如果某个 id 恰好被她占用了，出厂优先。
      this.specs.set(id, { ...spec, runtime: current?.runtime === true ? true : undefined })
    }
    // 气质跟着基因组一起热重载（WebUI 拖滑块 → 文件 mtime 变 → 这里被调）。
    this.temp = normalizeTemperament(genome.temperament)
    this.applyTemperament()
    void added
    return { added: [...added], removed, changed }
  }

  /**
   * 用插件配置里 legacy 的旋钮微调出厂条目。
   *
   * 以前 `serotoninHalfLifeMinutes` 这类配置是直接喂给 decay() 的。
   * 现在算出来自 genome.json，但**老配置不能悄悄失效**——
   * 有人在 yaml 里写了 200 分钟，突然不生效了最难查。
   * 所以显式给了值就覆盖基因，没给就保持基因原样。
   */
  override(id: string, patch: Partial<ChemicalSpec>): string | null {
    const current = this.specs.get(id)
    if (!current) return `没有名为「${id}」的化学物质`
    const merged: ChemicalSpec = { ...current, ...patch, id } as ChemicalSpec
    const problems = validateSpec(merged)
    if (problems.length > 0) return problems.join('；')
    this.specs.set(id, { ...merged, runtime: current.runtime })
    return null
  }

  /**
   * 为 AI 现场造激素提供一份**通用参数**。
   *
   * 三个默认值的选择：baseline 50（不好不坏）、halfLife 30 分钟（比多巴胺短、
   * 比血清素长，情感不会立刻退也不会赖着不走）、区间 0-100（和其余读数同刻度）。
   */
  runtimeSpecOf(id: string, label?: string): ChemicalSpec {
    return {
      id,
      // 名字短得像个名字才当名字用（≤6 字）。
      //
      // 器官调用的是 `ctx.inflict(id, 增量, 理由)`，第三个参数常常是一句话
      // （"想离主人近一点"）——原样当名字的话，面板上那根条会叫成一句独白。
      // 短的就当名字（"催产素"），长的……以前退化成 id，现在退化成字典里的中文名，
      // 字典里也没有才退回 id。**不许让一个活的东西在面板上只剩一串英文。**
      label: chemicalLabel(id, label?.trim() && label.trim().length <= 6 ? label.trim() : undefined),
      baseline: 50,
      initial: 50,
      min: 0,
      max: 100,
      halfLifeMinutes: 30,
      description: '由器官在运行时分泌出来的新激素',
      rules: [],
      // 不给 order：面板上自造的排在出厂的后面（缺失 order 视为最大）。
      ui: { group: '自造', color: runtimeColor(id) },
      runtime: true,
    }
  }

  /**
   * 她此刻身上**所有自造激素的定义**（v0.9.18）。
   *
   * 出厂的那些不在这里——它们的真身在 genome.json，重复存一份迟早会两边打架。
   * 这个列表是给落盘用的：她造的激素要活过重启，就得有个地方写下来。
   */
  runtimeSpecs(): ChemicalSpec[] {
    return [...this.specs.values()]
      .filter((spec) => spec.runtime === true)
      .map((spec) => ({ ...spec }))
  }

  /** 出厂默认值表（用于初始化 state）。 */
  defaults(): ChemicalValues {
    const out: ChemicalValues = {}
    for (const spec of this.specs.values()) {
      out[spec.id] = clamp(spec.initial ?? spec.baseline, spec.min, spec.max)
    }
    return out
  }

  /** 补齐缺失项、剔掉不认识的键、夹紧到 [min, max]。 */
  normalize(values: Partial<ChemicalValues>): ChemicalValues {
    const out: ChemicalValues = {}
    for (const spec of this.specs.values()) {
      const raw = values?.[spec.id]
      out[spec.id] = clamp(typeof raw === 'number' && Number.isFinite(raw) ? raw : (spec.initial ?? spec.baseline), spec.min, spec.max)
    }
    return out
  }

  /** 单次取值。未知 id 返回 null（不猜 —— 猜出来的 50 会掩盖 bug）。 */
  read(values: Partial<ChemicalValues>, id: string): number | null {
    const spec = this.specs.get(id)
    if (!spec) return null
    const raw = values?.[id]
    return clamp(typeof raw === 'number' && Number.isFinite(raw) ? raw : (spec.initial ?? spec.baseline), spec.min, spec.max)
  }

  /**
   * 增量落一次。**返回新表**，不改传入的表。
   *
   * 未知 id → 自动登记为运行时新激素（这就是 ctx.inflict 造激素的那条路），
   * 但受 `maxRuntimeChemicals` 保护。
   */
  bump(
    values: Partial<ChemicalValues>,
    id: string,
    delta: number,
    options: { label?: string; allowCreate?: boolean } = {},
  ): { values: ChemicalValues; value: number | null; reason?: string } {
    if (!isValidChemicalId(id)) {
      return { values: this.normalize(values), value: null, reason: `「${id}」不是合法的化学物质 id` }
    }
    if (!this.has(id)) {
      if (options.allowCreate === false) {
        return { values: this.normalize(values), value: null, reason: `没有名为「${id}」的化学物质` }
      }
      const problem = this.upsert(this.runtimeSpecOf(id, options.label), { runtime: true })
      if (problem) return { values: this.normalize(values), value: null, reason: problem }
    }
    const spec = this.specs.get(id) as ChemicalSpec
    const next = this.normalize(values)
    const before = next[id]
    // 敏感度（气质）：只放大**向上**的皮质醇——危机来时反应更重；
    // 下降（安慰、时间治愈）不打折，不然敏感就成了"好不了"。
    let effective = delta
    if (id === 'cortisol' && delta > 0) {
      effective = delta * this.temp.sensitivity
    }
    next[id] = clamp(before + effective, spec.min, spec.max)
    return { values: next, value: next[id] }
  }

  /**
   * 按时间衰减全部化学物质，并套用各自的慢变量规则。
   *
   * 两趟算，顺序很重要：
   *   第一趟 —— 所有物质各自向自己的基线回落；
   *   第二趟 —— 规则里参照的是**回落之后**的值。
   * 用旧值判断会让"刚缓过来"那一刻还在扣血清素，看起来像坏了。
   *
   * elapsedMs ≤ 0 时原样返回（记账还没到时间）。
   */
  decay(values: Partial<ChemicalValues>, elapsedMs: number, env: ChemicalEnv): ChemicalValues {
    const current = this.normalize(values)
    if (!(elapsedMs > 0)) return current
    const relaxed: ChemicalValues = {}
    for (const spec of this.specs.values()) {
      // 恢复力（气质）：乘在衰减速率上 = 除在半衰期上。
      // 恢复力 2 → 半衰期减半 → "好得快"；0.5 → 伤一次记很久。
      const halfLifeMinutes = Math.max(0.1, spec.halfLifeMinutes / this.temp.resilience)
      relaxed[spec.id] = decayTowardRange(
        current[spec.id],
        spec.baseline,
        elapsedMs,
        halfLifeMinutes * 60_000,
        spec.min,
        spec.max,
      )
    }
    const minutes = elapsedMs / 60_000
    const out: ChemicalValues = { ...relaxed }
    for (const spec of this.specs.values()) {
      const rule = spec.rules?.find((item) => matchesRule(item, relaxed, env))
      if (!rule) continue
      if (rule.kind === 'stress') {
        out[spec.id] = clamp(relaxed[spec.id] + rule.ratePerMinute * minutes, spec.min, spec.max)
      } else {
        const ceiling = clamp(rule.ceiling, spec.min, spec.max)
        // 已经站在天花板之上（比如被人手动调高了）：交给自然回落，别硬压下来。
        if (current[spec.id] >= ceiling) continue
        out[spec.id] = clamp(Math.min(ceiling, relaxed[spec.id] + rule.ratePerMinute * minutes), spec.min, spec.max)
      }
    }
    return out
  }

  /**
   * 慢变量规则**当前是否成立**（不看时间，只看此刻的状态）。
   *
   * 前端用它渲染"为什么血清素在往下掉"，比画一个孤零零的数字有用得多。
   */
  activeRule(id: string, values: Partial<ChemicalValues>, env: ChemicalEnv): ChemicalRule | null {
    const spec = this.specs.get(id)
    if (!spec?.rules) return null
    const current = this.normalize(values)
    return spec.rules.find((item) => matchesRule(item, current, env)) ?? null
  }
}

/** 去掉 runtime 标记再比较：它是"来源"而不是"定义"，不该参与 diff。 */
function stripRuntime(spec: ChemicalSpec): ChemicalSpec {
  const { runtime: _runtime, ...rest } = spec
  return rest as ChemicalSpec
}

/**
 * diff 用的视图：除了去 runtime 标记，还要把多巴胺被 enthusiasm 盖掉的基线
 * 还原成文件里的原始值——否则只要气质 ≠ 默认，每次重载都会谎报"dopamine 改动"。
 */
function diffable(spec: ChemicalSpec, dopamineFactoryBaseline: number | null): ChemicalSpec {
  const base = stripRuntime(spec)
  if (spec.id === 'dopamine' && dopamineFactoryBaseline !== null) {
    return { ...base, baseline: dopamineFactoryBaseline }
  }
  return base
}

/** 值表-in / 值表-out 是否相同（0.01 的容差：浮点误差不算变化）。 */
export function diffSignificant(before: ChemicalValues, after: ChemicalValues, epsilon = 0.01): boolean {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  for (const key of keys) {
    const a = before[key]
    const b = after[key]
    if (typeof a !== 'number' || typeof b !== 'number') {
      if (a !== b) return true
      continue
    }
    if (Math.abs(a - b) > epsilon) return true
  }
  return false
}

/** 规则成立的判定（纯函数）。 */
export function matchesRule(rule: ChemicalRule, values: ChemicalValues, env: ChemicalEnv): boolean {
  if (rule.kind === 'stress') {
    const ref = values[rule.triggerRef]
    if (typeof ref !== 'number' || !Number.isFinite(ref)) return false
    return ref >= rule.triggerAtLeast
  }
  if (env.energy <= rule.energyAbove) return false
  if (rule.requireNoHighTensionGap && env.highTensionGap) return false
  return true
}

/** 向基线指数衰减，并夹到该物质自己的 [min, max]。 */
export function decayTowardRange(
  current: number,
  baseline: number,
  elapsedMs: number,
  halfLifeMs: number,
  min: number,
  max: number,
): number {
  return clamp(decayToward(current, baseline, elapsedMs, halfLifeMs), min, max)
}
