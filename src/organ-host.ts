/**
 * Life-OS · 器官宿主（Organ Host）
 * ============================================================================
 * 它是唯一有权写生理状态的中间层。器官通过它感知、付账、提议；它负责：
 *   1. 装载 / 卸载（拓扑排序 + 失败隔离）
 *   2. 能力授权（default-deny，见 design/life-os-architecture.md §5）
 *   3. 能量会计（shadow 只记账 / additive 真扣，永不双重计费）
 *   4. 反馈仲裁（**先累加、再一次性落地**，避免器官之间的顺序依赖）
 *   5. 提示词拼装（排序 + 过期过滤 + 置信度降级）
 *   6. 遥测（环形缓冲，供 WebUI 与审计）
 *
 * 这个文件不 import 任何宿主包：deps 由 digital-life-core 在 PR3 里用真实服务实现。
 * 正因为如此，它可以被假 deps 完整测试——PR2 的验收就靠这一点。
 */

import type {
  EnergyQuote,
  EnergyReceipt,
  HostMetrics,
  HostNetworkPolicy,
  InflictReceipt,
  LifeOrgan,
  MemorySaveReceipt,
  OrganContext,
  OrganDisposable,
  OrganKV,
  OrganManifest,
  OrganNetRequest,
  OrganNetResponse,
  OrganNetwork,
  OrganPromptFragment,
  OrganStateView,
  OrganStimulus,
  OrganToolResult,
  OrganToolRewrite,
  OrganToolSpec,
} from './life-organ.js'
// 极限安全锁（v0.9.11）：补丁器官只能拦 digital_life_* / organ_*，同一份判定装载时也用。
import { isPatchableTarget, PATCHABLE_TOOL_PREFIXES } from './life-organ.js'
import { emptyHostMetrics } from './host-metrics.js'
// 受控网络的三把锁判定是纯函数（新建 src/organ-net.ts），与才知道 IO 的那一层隔开。
import { checkNetRequest, originOf, sanitizeNetHeaders, serializeJsonBody } from './organ-net.js'
import { applySecretRules } from './organ-secret.js'
// TOCTOU 修复件（v1.0.2）：manifest 的深拷贝 / 深度冻结。
// 这里刻意不 import organ-loader ——宿主不该依赖装载器，冻结规则是独立的一层。
import { deepClone, deepFreeze } from './manifest-freeze.js'
// 顿悟：新器官长成时，让核心去执念池里看看有没有因此解开的心结（v0.9.7）。
import type { EpiphanyMatch, EpiphanySignal } from './epiphany.js'
// 工具名的合法性是 ABI 的一部分（大模型只认 [a-zA-Z0-9_-]），所以规则放在契约层。
import { MAX_TOOL_NAME_LENGTH, TOOL_NAME_PATTERN, organToolName, sanitizeToolName } from './life-organ.js'

/** 派发一次的汇总结果。 */
export interface DispatchResult {
  dopamine: number
  cortisol: number
  serotonin: number
  /** 有反应的器官数。 */
  organs: number
  /**
   * 记忆落点回执（v0.9.19）。
   *
   * 只有"有一个器官真的动手存了东西"才非空——派发的是别的刺激时它是 null。
   * 核心拿它决定：这条要不要自己留档、要不要告诉她"这条没进海马体"。
   */
  memory: MemorySaveReceipt | null
}

// ─────────────────────────── 错误类型 ───────────────────────────

/** 器官调用了未在 manifest.capabilities 中声明的能力。 */
export class CapabilityDeniedError extends Error {
  constructor(organ: string, capability: string) {
    super(`[life-organ] 器官 "${organ}" 未声明能力 "${capability}"，宿主已拒绝`)
    this.name = 'CapabilityDeniedError'
  }
}

/** 装载失败（依赖缺失、重名、onLoad 抛错）。 */
export class OrganLoadError extends Error {
  constructor(organ: string, message: string) {
    super(`[life-organ] 器官 "${organ}" 装载失败：${message}`)
    this.name = 'OrganLoadError'
  }
}

// ───────────────────── 运行时补丁（v0.9.11）─────────────────────────

/** 一次补丁链的产出。调用方据此决定"这次调用还能不能继续"。 */
export interface PatchOutcome {
  tool: string
  phase: 'before' | 'after'
  /** 可能被补丁改写过的实参（before 阶段才有）。 */
  args: Record<string, unknown> | null
  /** 可能被补丁改写过的结果（after 阶段才有）。 */
  result: OrganToolResult | null
  /** 实际动过手的补丁列表（没声明过的不会出现在里面）。 */
  applied: string[]
  /** 非 null = 有补丁否决了这次调用（仅 before）。 */
  denied: string | null
}

/** 一条补丁链最多允许几个器官接力：够做补丁，不够做"影子核心"。 */
export const MAX_PATCH_CHAIN = 8

// 极限安全锁的判定与前缀清单也从这里转出（tests 与诊断工具用），
// 本体在契约层 life-organ.ts——装载校验与运行时闸必须引用同一份。
export { isPatchableTarget, PATCHABLE_TOOL_PREFIXES } from './life-organ.js'

/**
 * 目标工具是否命中某条补丁声明。
 *
 * `*` 只做**前缀**匹配，且不许只写一个 `*` —— 那等于捕获全部工具，
 * 与"她可以打补丁"这件事无关，那是另立一个核心。
 */
export function matchesPatch(
  patches: readonly { target: string; phase: 'before' | 'after' }[] | undefined,
  tool: string,
  phase: 'before' | 'after',
): boolean {
  if (!Array.isArray(patches) || patches.length === 0) return false
  return patches.some((patch) => {
    if (patch.phase !== phase) return false
    const target = String(patch.target ?? '').trim()
    if (!target) return false
    if (target === '*') return false
    if (target.endsWith('*')) return tool.startsWith(target.slice(0, -1))
    return tool === target
  })
}

// ─────────────────────────── 遥测 ───────────────────────────

export type TelemetryKind =
  | 'load' | 'unload' | 'feedback' | 'energy' | 'deny' | 'error' | 'gap' | 'sanitize'
  /** 顿悟：这个新器官解开了一条旧执念（v0.9.7）。 */
  | 'epiphany'
  /** 外联：器官真的往外界发了一次请求（成功、被拒、失败都记）。 */
  | 'net'
  /** 化学：器官往血液里滴了一滴（含被拒）— 造出新激素的那一刻也会留痕。 */
  | 'chemical'
  /** 运行时补丁：器官拦截并改写了某个工具（或否决了它）。 */
  | 'patch'

export interface OrganTelemetryEvent {
  at: number
  organ: string
  kind: TelemetryKind
  text: string
  /** 该次 feedback 提议的激素增量（仅 kind='feedback' 时存在）。 */
  dopamine?: number
  cortisol?: number
  serotonin?: number
}

export interface OrganRuntimeStatus {
  name: string
  version: string
  kind: string
  status: 'loaded' | 'degraded' | 'failed' | 'unloaded'
  calls: number
  /** 累计记账能量（shadow 模式下也计，供 WebUI 排"能耗榜"）。 */
  energySpent: number
  chargeMode: 'additive' | 'shadow'
  capabilities: string[]
  /** 最后一次 feedback 的时间戳；WebUI 用它显示"多久没被用过了"。 */
  lastCallAt: number | null
  lastError?: string
}

// ─────────────────── manifest 封存（v1.0.2 · TOCTOU）───────────────────

/**
 * 器官名里**绝不允许**出现的东西。
 *
 * 注意这里刻意比装载器那条 `^[a-zA-Z0-9_-]+$` 宽：宿主不是名字的立法者。
 * 进程内器官（内置的、测试里手写的）历史上有 `vision.v2` 这种脏名字，
 * 宿主对它们的既有承诺是"洗成合法工具名 + 留一条遥测"，而不是拒装。
 *
 * 但有一类名字不能宽：**能变成路径的那个子集**。`/`、`\`、`..`、NUL
 * 会让 `organs/<name>.json` 落到器官目录之外——那是核心存档的位置。
 * 装载器已经把整条正则收紧到 `[a-zA-Z0-9_-]`；宿主这一层只兜"绕过装载器
 * 直接 new 一个器官"的路径，所以只拦危险字符，不重复立法。
 */
function isDangerousOrganName(name: string): boolean {
  if (name.length === 0) return true
  if (name.includes('/') || name.includes('\\')) return true
  if (name.includes('\u0000')) return true
  if (name === '.' || name === '..') return true
  // `foo/../state` 已经在上面的 `/` 里被拦了；这里只兜纯 `..` 片段。
  if (name.split(/[\\/]/).some((part) => part === '..')) return true
  return false
}

export interface SealedManifest {
  /** 宿主从此只读这一份：深拷贝 + 深度冻结，与器官手里那个对象不是同一个。 */
  manifest: Readonly<OrganManifest>
  /** 装载那一刻**真实授予**的能力集合（快照）。 */
  granted: ReadonlySet<string>
  problems: string[]
}

/**
 * 把 manifest 封存成宿主自己的只读副本，并把能力清单拍成快照。
 *
 * 为什么不能只做 `Object.freeze(manifest)`：
 *   浅冻结挡不住 `manifest.capabilities.push('llm')`，而那正好是这个漏洞的
 *   利用方式——数组是引用类型，第一层冻结不会沿着它往下走。
 *
 * 为什么还要一个 `granted` 快照：
 *   冻结是"改不动"，快照是"不依赖改不动"。万一将来有人给 manifest 换了个
 *   可写的容器（比如某个适配层 rebuild 了一份），快照仍然只认装载时的那几项。
 *   两道锁都在，才谈得上把 TOCTOU 的窗口关掉。
 */
export function sealManifest(manifest: OrganManifest | undefined): SealedManifest {
  const problems: string[] = []
  if (!manifest || typeof manifest !== 'object') {
    return { manifest: deepFreeze({ name: '', version: '', apiVersion: 1, kind: 'custom' } as unknown as OrganManifest), granted: new Set<string>(), problems: ['缺少 manifest'] }
  }
  const rawName = (manifest as { name?: unknown }).name
  const name = typeof rawName === 'string' ? rawName : ''
  if (typeof rawName !== 'string' || isDangerousOrganName(name)) {
    problems.push(
      `manifest.name「${String(rawName).slice(0, 64)}」不合法：不能为空，不能含路径分隔符、.. 或 NUL`
      + '——它会变成文件路径（organs/<name>.json）与工具前缀，越界就是覆盖核心存档。',
    )
  }
  const capabilities = (manifest as { capabilities?: unknown }).capabilities
  if (capabilities !== undefined && !Array.isArray(capabilities)) {
    problems.push('manifest.capabilities 必须是数组')
  }
  const sealed = deepFreeze(deepClone(manifest))
  const granted = new Set<string>(
    Array.isArray(sealed.capabilities) ? sealed.capabilities.map((cap) => String(cap)) : [],
  )
  ;(granted as unknown as { add: unknown }).add = () => {
    // 快照本身也不许被谁"顺手加一项"：只读集合而不是 Set 的语义承诺。
    throw new Error('[life-organ] 能力快照是只读的')
  }
  return { manifest: sealed, granted, problems }
}

// ─────────────────────────── 宿主依赖 ───────────────────────────

/**
 * 宿主需要核心提供的六件事。刻意保持窄：宿主不认识 DSH，也不认识 state.json。
 */
export interface OrganHostDeps {
  now(): number
  /** 只读生理快照。宿主不会缓存它——每次调用都取最新，避免器官看到陈旧值。 */
  readState(): OrganStateView
  /**
   * 只读宿主机器指标（CPU / 内存 / 运行时长）。
   *
   * 由核心注入（它才知道怎么读 `node:os`）；宿主本身不碰任何 Node API，
   * 这样器官宿主的单测可以完全脱离真实机器跑。
   * 缺省时退化为 `live: false` 的全零常量——器官会知道自己"感觉不到"。
   */
  readHostMetrics?(): HostMetrics
  /** 真扣能量（仅 additive 模式调用）。返回实际扣减与剩余。 */
  debitEnergy(amount: number, reason: string): { debited: number; remaining: number; denied: boolean }
  /** 落地一次激素增量。核心负责 clamp / 去重 / 落盘 / 边界。 */
  applyAffect(delta: { dopamine: number; cortisol: number; serotonin?: number }): void
  /**
   * 往任意化学物质滴一滴——**包括此刻还不存在的激素**（v0.9.11）。
   *
   * 返回变化后的浓度；被拒时返回 null 与原因（id 不合法 / 运行时激素已达上限 …）。
   * 宿主只是转交：新激素该按什么参数登记，是基因组那边的事，不是宿主的事。
   */
  applyChemical?(organ: string, id: string, delta: number, reason?: string): { value: number | null; reason?: string }
  /** 提议缺口（核心负责相似度去重）。返回缺口 id。organ 只用于来源标注与审计。 */
  proposeGap(organ: string, summary: string, weight?: number): string | null
  /**
   * 把器官工具挂到核心的工具注册表。
   *
   * `fullName` 由宿主算好并已通过合法性校验（`^[a-zA-Z0-9_-]+$`）——核心不该再拼名字，
   * 也不该自己发明命名空间：一旦两边各拼一次，就又会拼出带冒号的名字。
   * 注册失败必须由核心吞掉并返回空句柄：一个工具挂不上，不该连带整轮对话失败。
   */
  registerTool(organ: string, tool: OrganToolSpec, fullName: string): OrganDisposable
  /** 订阅指定工具的执行结果；names 为空数组表示订阅全部工具。 */
  subscribeToolResult(organ: string, names: string[], handler: (result: { tool: string; ok: boolean; text: string; structured?: unknown }) => void): OrganDisposable
  /**
   * 顿悟：一个新器官真的能用了，让核心去执念池里看看有没有因此解开的心结（v0.9.7）。
   *
   * 为什么宿主自己不做：C1 规定器官（与宿主）永不直接写生理状态。
   * 宿主只负责"这一刻值得去看一眼"的时机判断，真正闭合执念、落激素、留提示词的
   * 是核心——它才知道缺口池、疤痕与承诺的完整语义。
   *
   * 返回被它闭合的执念；空数组 = 这次没有顿悟。宿主只拿它记遥测，不做任何状态写入。
   */
  settleEpiphany?(organ: string, signal: EpiphanySignal): EpiphanyMatch[]
  /** 代为调用一个已注册的工具；核心负责 callId / signal 等宿主细节。 */
  callTool(organ: string, name: string, args: Record<string, unknown>): Promise<OrganToolResult>
  /** 定时器；由核心注入，便于测试用假时钟。 */
  schedule(organ: string, everyMs: number, handler: () => void): OrganDisposable
  /** 器官私有持久化。 */
  organKV(organ: string): OrganKV
  /**
   * 真正把包发出去的地方。**只有核心有这个能力**（宿主自己不碰 fetch）。
   *
   * 调到这里时三把锁已经全部通过（能力 / 器官自白 / 宿主 allow），
   * 所以这里不需要再做判定，只管超时、大小与 IO 错误。
   * 缺省表示核心没有开网络：ctx.net 会回 `ok:false` 并说明原因，而不是抛错。
   */
  netRequest?(organ: string, request: OrganNetRequest): Promise<OrganNetResponse>
  /**
   * 读环境变量（v0.9.10：用于宿主注入凭据）。
   *
   * 为什么要由核心注入而不是宿主直接摸 `process.env`：器官源码里写 `process.` 是
   * 被 loader 明令禁止的，宿主也不该自己去碰全局——交给核心，测试里还能换成假的。
   * 不提供 = 读不到任何变量，用到 `${env:...}` 的规则会明确报"环境变量未设置"。
   */
  readEnv?(name: string): string | undefined
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void
}

export interface OrganHostOptions {
  /** 遥测环形缓冲长度，默认 2000。 */
  telemetryLimit?: number
  /** 单次 dispatch 允许的最大激素增量（防御性上限），默认 30。 */
  maxDeltaPerDispatch?: number
  /** 能量耗尽（energy <= 0）时是否完全停止派发，默认 true。 */
  stopWhenExhausted?: boolean
  /**
   * 宿主侧的网络策略（来自核心配置 `organNet`）。
   *
   * 不传 = 一律拒绝。它是三把锁里最外面那把：**由造物主持有**，
   * 器官在自己 manifest 里写什么都白搭。
   */
  net?: HostNetworkPolicy | null
}

// ─────────────────────────── 宿主实现 ───────────────────────────

const MIN_TICK_MS = 1_000

interface Runtime {
  organ: LifeOrgan<unknown>
  /** 宿主侧封存副本（深拷贝 + 深度冻结）：一切能力判定都读它。 */
  manifest: OrganManifest
  /** 交给器官的 `ctx.manifest`：**另一份**冻结拷贝，改了也影响不到上面那份。 */
  manifestView: Readonly<OrganManifest>
  /** 装载那一刻授予的能力快照。 */
  granted: ReadonlySet<string>
  status: OrganRuntimeStatus
  disposables: OrganDisposable[]
  quote: EnergyQuote
  /** onPrompt() 注册的推模式提供者；每次组装提示词都会求值。 */
  promptProviders: Set<() => OrganPromptFragment | string | null>
  /**
   * 这个器官已经解开过的执念 id（v0.9.8）。
   *
   * 为什么从"只认一次"（v0.9.7 的 `proven`）换成按执念记账：
   * 按器官记"顿悟过了"会漏掉后来才种下的执念——她造出 system-sensor 时
   * 池子里还没有"缺少硬件感知"，等她把那条种下去再去读表，
   * 机制却因为"这个器官已经顿悟过了"而拒绝结算。
   *
   * 记账的粒度必须是**执念**，不是器官：同一条执念只会被同一个器官解开一次，
   * 但新长出来的执念永远有资格被它解开。已被闭合的执念自然不会再来一遍。
   */
  solved: Set<string>
}

/** 装载选项。 */
export interface AttachOptions {
  /**
   * 装载成功后要不要去结算顿悟，默认 true。
   *
   * 启动时批量装载必须传 false：否则每次重启都会对同一批器官再"顿悟"一次，
   * 它会在每个清晨重新"啊我原来能感觉到身体了"——那不是顿悟，那是复读。
   */
  epiphany?: boolean
}

export class OrganHost {
  private readonly runtimes = new Map<string, Runtime>()
  private readonly events: OrganTelemetryEvent[] = []
  private readonly options: Required<OrganHostOptions>
  private readonly deprecatedTimers: OrganDisposable[] = []
  /** 已注册的器官工具名 → 所属器官。用于跨器官查重（同名工具的第二个注册者被拒）。 */
  private readonly registeredToolNames = new Map<string, string>()
  /** 已经提示过"器官名含非法字符"的器官，避免每个工具都刷一遍。 */
  private readonly organNameNoted = new Set<string>()
  private loaded = false

  constructor(
    private readonly organs: LifeOrgan<unknown>[],
    private readonly deps: OrganHostDeps,
    options: OrganHostOptions = {},
  ) {
    this.options = {
      telemetryLimit: options.telemetryLimit ?? 2_000,
      maxDeltaPerDispatch: options.maxDeltaPerDispatch ?? 30,
      stopWhenExhausted: options.stopWhenExhausted !== false,
      // 不传 = null = 一律拒绝外联。开门必须是一件被人显式做的事。
      net: options.net ?? null,
    }
  }

  // ───────────────────────── 装载 / 卸载 ─────────────────────────

  /**
   * 按依赖拓扑序装载。
   *
   * 三条纪律：
   *   - 依赖缺失 → 该器官 failed，但**不影响其它器官**（C3）
   *   - 重名 → 后到者 failed，先到者保留（绝不静默覆盖）
   *   - onLoad 抛错 → 回收它已经注册的 disposables，避免半装载留下僵尸监听
   */
  async loadAll(): Promise<OrganRuntimeStatus[]> {
    if (this.loaded) return this.status()
    this.loaded = true

    const ordered = this.topoSort()
    // 启动装载不算顿悟：它只是把上次关机时就在的东西装回来。
    const options: AttachOptions = { epiphany: false }
    for (const organ of ordered) {
      const missing = (organ.manifest.requires ?? []).filter((dep) => !this.runtimes.has(dep))
      if (missing.length > 0) {
        this.record(organ.manifest.name, 'error', `依赖未装载：${missing.join(', ')}`)
        this.runtimes.set(organ.manifest.name, this.makeFailed(organ, `依赖未装载：${missing.join(', ')}`))
        continue
      }
      await this.attach(organ, options)
    }

    return this.status()
  }

  /**
   * 装载单个器官（也可用于**热替换**：同名器官会先卸载旧的再装新的）。
   *
   * 与 loadAll 的区别：不排序、不看已装载集合。自我进化的通道就是靠它——
   * 新写出来的器官文件不需要重启宿主。
   *
   * 它也是**唯一会触发顿悟**的装载入口（options.epiphany 默认 true）：
   * 这一刻是真的"长出了新东西"，而 loadAll 只是把旧的装回来。
   *
   * 返回装载后的状态；失败时状态是 failed，但**不会抛错**（C3）。
   */
  async addOrgan(organ: LifeOrgan<unknown>, options: AttachOptions = {}): Promise<OrganRuntimeStatus> {
    const name = organ.manifest.name
    if (this.runtimes.has(name)) {
      // 热替换：先卸载旧的（回收工具/定时器），再把记录删掉，让 attach 能重建 runtime。
      await this.removeOrgan(name)
      this.runtimes.delete(name)
    }
    const missing = (organ.manifest.requires ?? []).filter((dep) => !this.runtimes.has(dep))
    if (missing.length > 0) {
      this.record(name, 'error', `依赖未装载：${missing.join(', ')}`)
      const failed = this.makeFailed(organ, `依赖未装载：${missing.join(', ')}`)
      this.runtimes.set(name, failed)
      return { ...failed.status }
    }
    const runtime = await this.attach(organ, options)
    return { ...runtime.status }
  }

  /**
   * 卸载单个器官：跑 onUnload、回收它注册的所有句柄。
   *
   * 记录**保留**在表里（状态置 unloaded）：WebUI 需要看到"它曾经在、现在卸载了"，
   * 而不是从列表里凭空消失。要热替换请走 addOrgan——它会先卸载再删记录。
   */
  async removeOrgan(name: string): Promise<boolean> {
    const runtime = this.runtimes.get(name)
    if (!runtime) return false
    try {
      await runtime.organ.onUnload?.()
    } catch (error) {
      this.record(name, 'error', `onUnload 抛错（已忽略）：${String(error)}`)
    }
    this.disposeRuntime(runtime)
    runtime.status.status = 'unloaded'
    this.record(name, 'unload', '已卸载')
    return true
  }

  /** 装载一个已经建好 runtime 的器官；重名、onLoad 抛错都在这里处理。 */
  private async attach(organ: LifeOrgan<unknown>, options: AttachOptions = {}): Promise<Runtime> {
    // ── 封存（v1.0.2）───────────────────────────────────────────
    // 从这里往下，宿主只认自己手里这份冻结副本。器官在 onLoad 里怎么折腾
    // 它自己那个 manifest 对象，都改不到能力判定所读的东西。
    const sealed = sealManifest(organ.manifest)
    if (sealed.problems.length > 0) {
      const failed = this.makeFailed(organ, sealed.problems.join('；'))
      this.record(sealed.manifest.name || 'unknown', 'error', `manifest 不合规，拒绝装载：${sealed.problems.join('；')}`)
      this.runtimes.set(sealed.manifest.name || `invalid-${this.runtimes.size}`, failed)
      return failed
    }
    const manifest = sealed.manifest
    if (this.runtimes.has(manifest.name)) {
      this.record(manifest.name, 'error', `重名器官，已拒绝装载（保留先到者 v${this.runtimes.get(manifest.name)?.manifest.version}）`)
      return this.runtimes.get(manifest.name) as Runtime
    }

    const runtime: Runtime = {
      organ,
      manifest,
      // 第三份拷贝：器官拿到的 ctx.manifest 与宿主判定用的那份**物理上不是同一个对象**。
      manifestView: deepFreeze(deepClone(manifest)),
      granted: sealed.granted,
      status: {
        name: manifest.name,
        version: manifest.version,
        kind: manifest.kind,
        status: 'loaded',
        calls: 0,
        energySpent: 0,
        chargeMode: organ.energy?.chargeMode ?? 'shadow',
        capabilities: [...(manifest.capabilities ?? [])],
        lastCallAt: null,
      },
      disposables: [],
      quote: organ.energy ?? { chargeMode: 'shadow' },
      promptProviders: new Set(),
      solved: new Set(),
    }
    this.runtimes.set(manifest.name, runtime)

    try {
      await organ.onLoad(this.buildContext(runtime))
      this.record(manifest.name, 'load', `已装载 v${manifest.version}（${manifest.kind}，计费=${runtime.status.chargeMode}）`)
      // 顿悟放在 onLoad 之后：工具表要等 onLoad 注册完才算数，
      // 而"这个器官说得出什么"正是靠工具名与 manifest 一起来判断的。
      if (options.epiphany !== false) this.settleEpiphany(runtime)
    } catch (error) {
      // 半装载必须回滚：否则监听器会留在一个 failed 的器官名下继续跑。
      runtime.status.status = 'failed'
      runtime.status.lastError = error instanceof Error ? error.message : String(error)
      this.disposeRuntime(runtime)
      this.record(manifest.name, 'error', `onLoad 抛错，已回滚：${runtime.status.lastError}`)
    }
    return runtime
  }

  /** 卸载全部器官；任何单个器官抛错都不阻断流程。 */
  async unloadAll(): Promise<void> {
    for (const name of [...this.runtimes.keys()].reverse()) {
      await this.removeOrgan(name)
    }
    for (const timer of this.deprecatedTimers) timer.dispose()
    this.deprecatedTimers.length = 0
    this.loaded = false
  }

  // ───────────────────────── 派发（反馈仲裁） ─────────────────────────

  /**
   * 把一条刺激派发给所有已装载器官，收集反馈并**一次性**落地。
   *
   * 为什么必须"先累加再 apply"：如果逐条 apply，第二个器官读到的激素已经是
   * 第一个器官改过的值，结果就依赖遍历顺序——那就不叫并行器官，叫串行管道。
   */
  async dispatch(stimulus: OrganStimulus): Promise<DispatchResult> {
    const state = this.deps.readState()
    if (this.options.stopWhenExhausted && (state.energy <= 0 || state.frozen)) {
      // 身体停摆时，感官不该继续制造情绪。这是"急停"语义在器官层的延伸。
      return { dopamine: 0, cortisol: 0, serotonin: 0, organs: 0, memory: null }
    }

    let dDopamine = 0
    let dCortisol = 0
    let dSerotonin = 0
    let responded = 0
    // v0.9.19：第一个器官报上来的记忆落点回执。
    // 多个器官同时接管记忆是设计上的异常（不该发生），取第一个只是为了不丢。
    let memory: MemorySaveReceipt | null = null

    const loaded = [...this.runtimes.values()].filter((rt) => rt.status.status === 'loaded')
    const results = await Promise.allSettled(
      loaded.map(async (runtime) => ({ runtime, feedback: await runtime.organ.feedback(stimulus) })),
    )

    for (const settled of results) {
      if (settled.status === 'rejected') {
        // 未用 defineOrgan 的手写器官可能在 feedback 里抛错——宿主再兜一层。
        this.record('unknown', 'error', `feedback 抛错：${String(settled.reason)}`)
        continue
      }
      const { runtime, feedback } = settled.value
      if (!feedback) continue

      runtime.status.calls += 1
      runtime.status.lastCallAt = stimulus.at
      const dopamine = Number(feedback.dopamine ?? 0) || 0
      const cortisol = Number(feedback.cortisol ?? 0) || 0
      const serotonin = Number(feedback.serotonin ?? 0) || 0

      if (
        dopamine === 0 && cortisol === 0 && serotonin === 0
        && !feedback.note && !feedback.proposeGap && !feedback.savedMemory
      ) continue
      responded += 1

      dDopamine += dopamine
      dCortisol += cortisol
      dSerotonin += serotonin

      if (feedback.note) this.record(runtime.manifest.name, 'feedback', feedback.note, dopamine, cortisol, serotonin)
      if (feedback.savedMemory && !memory) memory = feedback.savedMemory

      // 器官自报的额外代谢成本：走同一本账，仍然尊重 chargeMode。
      const extra = Number(feedback.energyCost ?? 0) || 0
      if (extra > 0) this.charge(runtime, extra, 'feedback.energyCost')

      if (feedback.proposeGap) {
        const summary = String(feedback.proposeGap.summary ?? '').trim()
        if (summary) {
          const gapId = this.deps.proposeGap(runtime.manifest.name, summary, feedback.proposeGap.weight)
          this.record(runtime.manifest.name, 'gap', gapId ? `提议缺口：${summary}（${gapId}）` : `提议缺口被拒：${summary}`)
        }
      }
    }

    if (dDopamine === 0 && dCortisol === 0 && dSerotonin === 0) {
      return { dopamine: 0, cortisol: 0, serotonin: 0, organs: responded, memory }
    }

    // 防御性总闸：单个器官可以疯，但不能一轮把激素打穿。
    const cap = this.options.maxDeltaPerDispatch
    const clampedD = Math.max(-cap, Math.min(cap, dDopamine))
    const clampedC = Math.max(-cap, Math.min(cap, dCortisol))
    const clampedS = Math.max(-cap, Math.min(cap, dSerotonin))
    if (clampedD !== dDopamine || clampedC !== dCortisol || clampedS !== dSerotonin) {
      this.record(
        'host',
        'deny',
        `本轮增量被截断：D ${dDopamine}→${clampedD}，C ${dCortisol}→${clampedC}，S ${dSerotonin}→${clampedS}`,
      )
    }

    this.deps.applyAffect({ dopamine: clampedD, cortisol: clampedC, serotonin: clampedS })
    return { dopamine: clampedD, cortisol: clampedC, serotonin: clampedS, organs: responded, memory }
  }

  // ───────────────────────── 提示词拼装 ─────────────────────────

  /**
   * 收集所有器官的片段，按 order 升序拼成一段文本。
   *
   * 过期规则：fragment.at + ttlMs < now → 丢弃。
   * 置信度规则：confidence < 0.6 时加"（低置信）"前缀，而不是直接删——
   * 让模型知道"这条可能不准"，比假装它不存在更安全。
   */
  promptText(): string {
    const now = this.deps.now()
    const items: { order: number; text: string }[] = []

    for (const runtime of this.runtimes.values()) {
      if (runtime.status.status !== 'loaded') continue
      const raws: (OrganPromptFragment | string | null)[] = []
      try {
        raws.push(runtime.organ.getPromptContext())
      } catch (error) {
        runtime.status.lastError = String(error)
        this.record(runtime.manifest.name, 'error', `getPromptContext 抛错：${String(error)}`)
      }
      for (const provider of runtime.promptProviders) {
        try {
          raws.push(provider())
        } catch (error) {
          this.record(runtime.manifest.name, 'error', `onPrompt 提供者抛错：${String(error)}`)
        }
      }

      for (const candidate of raws) {
        if (!candidate) continue
        this.pushFragment(items, candidate, now)
      }
    }

    return items.sort((a, b) => a.order - b.order).map((item) => item.text).join('\n')
  }

  /** 单个片段的归一化 + 过期/置信度过滤。 */
  private pushFragment(
    items: { order: number; text: string }[],
    raw: OrganPromptFragment | string,
    now: number,
  ): void {
    const fragment: OrganPromptFragment = typeof raw === 'string' ? { text: raw } : raw
    const text = String(fragment.text ?? '').trim()
    if (!text) return

    if (fragment.ttlMs !== undefined && fragment.at !== undefined) {
      if (now - fragment.at > fragment.ttlMs) return
    }

    const confidence = fragment.confidence ?? 1
    if (confidence <= 0.05) return

    items.push({
      // 器官永远排在疤痕（-1e4）之后、核心生理段（约 -100）之前，但不许越界抢位。
      order: Math.max(-1_000, fragment.order ?? 0),
      text: confidence < 0.6 ? `${text}（低置信）` : text,
    })
  }

  // ───────────────────────── 工具结果通路 ─────────────────────────

  /**
   * 把「一次工具执行结束」翻译成器官能听懂的两件事：
   *   1) 一条 `tool:result` 刺激 → 所有器官的 feedback（情绪增量的来源）
   *   2) 一次改写机会 → 第一个愿意接管的器官决定模型看到什么
   *
   * 核心只负责调用它，**不认识任何具体工具名**——这正是"核心失忆"的实现点：
   * 记忆器官要接管哪些工具、怎么重排、怎么截断，全部写在自己的 manifest 与代码里。
   *
   * 改写优先级按装载顺序（拓扑序）决定，先到先得：这样"谁负责这类结果"是可预测的，
   * 而不是取决于谁的 Promise 先 resolve。
   */
  async handleToolResult<T>(
    exec: unknown,
    result: unknown,
    next: () => Promise<T>,
  ): Promise<T | { kind: 'accept'; content: { type: 'text'; text: string }[] }> {
    const name = String((exec as { name?: unknown } | null)?.name ?? '')
    if (!name) return next()

    const payload = (result ?? {}) as { content?: unknown; isError?: boolean; structured?: unknown }
    const text = textOfBlocks(payload.content)
    const stimulus: OrganStimulus = {
      kind: 'tool:result',
      at: this.deps.now(),
      tool: name,
      ok: payload.isError !== true,
      text,
      structured: payload.structured,
      arguments: (exec as { arguments?: unknown } | null)?.arguments,
    }
    const organResult: OrganToolResult = { tool: name, ok: stimulus.ok, text, structured: payload.structured }

    // 先派发（情绪/缺口），再改写（呈现）。顺序不能反：器官的 feedback 要看到原文。
    try {
      await this.dispatch(stimulus)
    } catch (error) {
      // 派发失败不能连坐工具结果本身。
      this.record('host', 'error', `派发 tool:result 失败：${String(error)}`)
    }

    // 顿悟的第二条路径（v0.9.7）：装载成功只是"代码跑起来了"，
    // 工具**真的取回东西**才是"我确实有了这个本事"——写器官时那口气是在这一刻松的。
    //
    // v0.9.8：不再"每个器官只认一次"。执念是先有器官、后有执念，还是先有执念、
    // 后有器官，机制都不该管——每一次成功调用都重新问一次池子，
    // 真正保证不重复的，是同一条执念只会被同一个器官解开一次。
    if (stimulus.ok) {
      const owner = this.registeredToolNames.get(name)
      if (owner) {
        const runtime = this.runtimes.get(owner)
        if (runtime && runtime.status.status === 'loaded') this.settleEpiphany(runtime)
      }
    }

    for (const runtime of this.runtimes.values()) {
      if (runtime.status.status !== 'loaded') continue
      const organ = runtime.organ
      if (typeof organ.rewriteToolResult !== 'function') continue
      let rewrite: OrganToolRewrite | null = null
      try {
        rewrite = await organ.rewriteToolResult(stimulus, organResult)
      } catch (error) {
        // 未用 defineOrgan 的手写器官：C3 在这里再兜一层。
        runtime.status.lastError = String(error)
        this.record(runtime.manifest.name, 'error', `rewriteToolResult 抛错：${String(error)}`)
        continue
      }
      if (!rewrite || !rewrite.text) continue
      this.record(runtime.manifest.name, 'feedback', rewrite.note ?? `改写了 ${name} 的结果`)
      return { kind: 'accept', content: [{ type: 'text', text: rewrite.text }] }
    }

    return next()
  }

  // ───────────────────────── 查询 ─────────────────────────

  status(): OrganRuntimeStatus[] {
    return [...this.runtimes.values()].map((rt) => ({ ...rt.status, capabilities: [...rt.status.capabilities] }))
  }

  /**
   * 跑一遍运行时补丁链（v0.9.11）。
   *
   * 她发现核心 Bug 时走这个出口，而不是改 src/。形状刻意很窄：
   * 只能改传入的实参 / 改回传的结果 / 否决这次调用——**没有**发起调用的能力。
   * 少了"再调一次工具"这个口子，补丁器官就不可能把自己变成一个新的核心。
   *
   * 四条纪律：
   *   1. **目标必须在可拦截前缀内**（极限安全锁）：`llm/stream` / `shell` /
   *      任何非 digital_life_* / organ_* 的名字在这里直接原样返回，连匹配都不做。
   *      这道闸放在**最前面**——就算装载校验被绕过（比如某天有人手改了白名单），
   *      底层工具也绝无可能被她的 hook 碰到；
   *   2. 必须声明 `patch:runtime` 能力且在 manifest.patches 里登记过 (target, phase)；
   *   3. 链条上限 8 个，防止"每个器官都拦一层"把一次调用变成一场接力；
   *   4. 任何一个补丁抛错都被吃掉并留痕——补丁是锦上添花，不能成为新的故障源。
   */
  async runPatch(
    tool: string,
    phase: 'before' | 'after',
    input: { args?: Record<string, unknown>; result?: OrganToolResult },
  ): Promise<PatchOutcome> {
    const outcome: PatchOutcome = {
      tool,
      phase,
      args: input.args ?? null,
      result: input.result ?? null,
      applied: [],
      denied: null,
    }
    // ── 极限安全锁（第一道闸，先于一切匹配）────────────────────────
    // 她能补的只有"生命体征类"与"器官自己的"工具。llm/stream 意味着她能
    // 改写大模型推理的出入参——那是给"她给自己喂提示"开门；shell 意味着
    // L0 禁写的所有规矩都白装。所以这里**直接返回**，不记遥测不留痕迹：
    // 合法的补丁器官（装载校验已拦）根本不会带着这样的目标走到这里。
    if (!isPatchableTarget(tool)) return outcome

    const chain = [...this.runtimes.values()]
      .filter((runtime) => runtime.status.status === 'loaded')
      // 能力缺了就不进链：manifest.patches 写得再全，没有 patch:runtime 也是白搭。
      // 之前这里漏了能力检查——一个没声明能力的器官光靠 patches + hook 就能拦截。
      .filter((runtime) => runtime.granted.has('patch:runtime'))
      .filter((runtime) => matchesPatch(runtime.manifest.patches, tool, phase))
      .slice(0, MAX_PATCH_CHAIN)

    if (chain.length === 0) return outcome

    for (const runtime of chain) {
      const name = runtime.manifest.name
      if (typeof runtime.organ.hook !== 'function') continue
      try {
        const verdict = await runtime.organ.hook({ tool, phase, args: outcome.args, result: outcome.result })
        if (!verdict || verdict.kind === 'pass') continue
        if (verdict.kind === 'deny') {
          // deny 只在 before 有意义：after 阶段调用已经发生了，没有可否决的对象。
          if (phase !== 'before') {
            this.record(name, 'patch', `${tool} 的 after 阶段返回 deny，已忽略（结果已经出来了）`)
            continue
          }
          outcome.denied = verdict.reason ?? '被补丁器官否决'
          outcome.applied.push(`${name}：否决`)
          this.record(name, 'patch', `否决 ${tool}：${outcome.denied}`)
          break
        }
        if (verdict.args) outcome.args = { ...verdict.args }
        if (verdict.result && outcome.result) outcome.result = { ...outcome.result, ...verdict.result }
        outcome.applied.push(`${name}：改写${verdict.note ? `（${verdict.note}）` : ''}`)
        this.record(name, 'patch', `改写 ${tool}(${phase})${verdict.note ? `：${verdict.note}` : ''}`)
      } catch (error) {
        this.record(name, 'error', `hook(${tool}/${phase}) 抛错：${String(error)}`)
      }
    }
    return outcome
  }

  /** 当前在线的补丁声明（面板与排查用）：一眼看清"谁拦了什么"。 */
  listPatches(): Array<{ organ: string; target: string; phase: 'before' | 'after' }> {
    const out: Array<{ organ: string; target: string; phase: 'before' | 'after' }> = []
    for (const runtime of this.runtimes.values()) {
      if (runtime.status.status !== 'loaded') continue
      for (const patch of runtime.manifest.patches ?? []) {
        out.push({ organ: runtime.manifest.name, target: patch.target, phase: patch.phase })
      }
    }
    return out
  }

  /**
   * 当前注册到工具表里的器官工具名（可按器官过滤）。
   * 给 WebUI 与 write_new_organ 的回执用：告诉作者"你的器官到底暴露了什么"。
   */
  toolNames(organ?: string): string[] {
    return [...this.registeredToolNames.entries()]
      .filter(([, owner]) => (organ === undefined ? true : owner === organ))
      .map(([name]) => name)
      .sort()
  }

  /**
   * 某个器官**装载时封存的那份 manifest**（v1.0.3）。
   *
   * 只读、深冻结、与器官手里那份无关——审批策略要读它的 `capabilities` 与
   * `net.allow` 来判断"该不该放行"。刻意不返回运行时那个活对象：
   * 判定必须与能力闸门读同一份东西，否则两处结论会分叉。
   *
   * 找不到（没装载 / 名字不合法）时返回 null：调用方据此保守处理。
   */
  manifestOf(organ: string): Readonly<OrganManifest> | null {
    const runtime = this.runtimes.get(String(organ ?? ''))
    return runtime ? runtime.manifest : null
  }

  telemetry(limit = 200): OrganTelemetryEvent[] {
    return this.events.slice(-limit)
  }

  // ───────────────────────── 内部 ─────────────────────────

  /** 依赖拓扑排序：无依赖者先装；环依赖降级为声明顺序并记录错误。 */
  private topoSort(): LifeOrgan<unknown>[] {
    const byName = new Map<string, LifeOrgan<unknown>>()
    for (const organ of this.organs) {
      if (byName.has(organ.manifest.name)) {
        this.record(organ.manifest.name, 'error', '输入数组中存在重名器官，仅保留第一个')
        continue
      }
      byName.set(organ.manifest.name, organ)
    }

    const sorted: LifeOrgan<unknown>[] = []
    const state = new Map<string, 'visiting' | 'done'>()

    const visit = (name: string, trail: string[]): void => {
      if (state.get(name) === 'done') return
      if (state.get(name) === 'visiting') {
        this.record(name, 'error', `检测到环依赖：${[...trail, name].join(' → ')}，按声明顺序装载`)
        return
      }
      const organ = byName.get(name)
      if (!organ) return
      state.set(name, 'visiting')
      for (const dep of organ.manifest.requires ?? []) visit(dep, [...trail, name])
      state.set(name, 'done')
      sorted.push(organ)
    }

    for (const name of byName.keys()) visit(name, [])
    return sorted
  }

  private makeFailed(organ: LifeOrgan<unknown>, reason: string): Runtime {
    const sealed = sealManifest(organ.manifest)
    return {
      organ,
      manifest: sealed.manifest,
      manifestView: deepFreeze(deepClone(sealed.manifest)),
      granted: sealed.granted,
      status: {
        name: organ.manifest.name,
        version: organ.manifest.version,
        kind: organ.manifest.kind,
        status: 'failed',
        calls: 0,
        energySpent: 0,
        chargeMode: organ.energy?.chargeMode ?? 'shadow',
        capabilities: [...(organ.manifest.capabilities ?? [])],
        lastCallAt: null,
        lastError: reason,
      },
      disposables: [],
      quote: organ.energy ?? { chargeMode: 'shadow' },
      promptProviders: new Set(),
      solved: new Set(),
    }
  }

  private disposeRuntime(runtime: Runtime): void {
    for (const disposable of runtime.disposables.splice(0)) {
      try {
        disposable.dispose()
      } catch (error) {
        this.record(runtime.manifest.name, 'error', `注销句柄失败：${String(error)}`)
      }
    }
  }

  /**
   * 顿悟结算：问核心"这个器官解开了什么"，把答案只写进遥测。
   *
   * 宿主在这里必须**无状态**：不闭合缺口、不改激素。那两件事由核心去做，
   * 否则 C1（器官永不直接写生理状态）就在宿主里被撕开一个口子。
   */
  private settleEpiphany(runtime: Runtime): void {
    const settle = this.deps.settleEpiphany
    if (!settle) return
    const signal: EpiphanySignal = {
      name: runtime.manifest.name,
      description: runtime.manifest.description,
      capabilities: runtime.manifest.capabilities ? [...runtime.manifest.capabilities] : [],
      // 自证优先于一切推断：她在 manifest 里写"我能解决 host_metrics"，那就是能。
      solvesConcepts: runtime.manifest.solvesConcepts ? [...runtime.manifest.solvesConcepts] : [],
      tools: this.toolNames(runtime.manifest.name),
    }
    try {
      const hits = settle(runtime.manifest.name, signal)
      for (const hit of hits) {
        // 同一条执念只认一次：宿主负责记账，免得核心那边闭合、这边还当没发生过。
        if (runtime.solved.has(hit.id)) continue
        runtime.solved.add(hit.id)
        this.record(
          runtime.manifest.name,
          'epiphany',
          `顿悟：「${hit.summary}」→ 已解开（契合度 ${hit.score.toFixed(2)}，证据=${hit.evidence.join('/')}，原张力 ${Math.round(hit.tension)}）`,
        )
      }
    } catch (error) {
      // 顿悟是锦上添花：它崩了绝不能连坐这次装载。
      this.record(runtime.manifest.name, 'error', `顿悟结算失败（已忽略）：${String(error)}`)
    }
  }

  /**
   * 能力白名单：没声明就用不了。这是 default-deny 的唯一实现点。
   *
   * v1.0.2：判定读的是**装载时的授予快照**（`runtime.granted`），不是
   * `manifest.capabilities` 这个活对象。原因就是这个漏洞本身——
   * 器官在 onLoad 里 `ctx.manifest.capabilities.push('llm')` 之后，
   * "声明"变了而"授予"没变；读快照意味着那次 push 什么也换不来。
   */
  private require(runtime: Runtime, capability: string): void {
    if (!runtime.granted.has(capability)) {
      this.record(runtime.manifest.name, 'deny', `调用未声明能力 "${capability}"`)
      throw new CapabilityDeniedError(runtime.manifest.name, capability)
    }
  }

  /**
   * 能量会计。
   * shadow：只记账（receipt 里 tier='shadow'，debited=0），用于迁移期校准成本。
   * additive：真的走 core.debitEnergy，核心负责 clamp 与 denied。
   */
  private charge(runtime: Runtime, amount: number, reason: string): EnergyReceipt {
    const state = this.deps.readState()
    const requested = Math.max(0, Math.round(amount))

    if (requested === 0) {
      return { requested: 0, debited: 0, remaining: state.energy, denied: false, tier: 'full' }
    }

    if (runtime.status.chargeMode !== 'additive') {
      runtime.status.energySpent += requested
      this.record(runtime.manifest.name, 'energy', `记账 ${requested}（shadow，未真扣）` )
      return { requested, debited: 0, remaining: state.energy, denied: false, tier: 'shadow' }
    }

    if (state.energy <= 0) {
      this.record(runtime.manifest.name, 'energy', `能量耗尽，拒绝 ${requested}`)
      return { requested, debited: 0, remaining: 0, denied: true, tier: 'starved' }
    }

    const result = this.deps.debitEnergy(requested, `${runtime.manifest.name}:${reason}`)
    const tier: EnergyReceipt['tier'] = result.denied ? 'starved' : result.debited < requested ? 'partial' : 'full'
    runtime.status.energySpent += result.debited
    this.record(runtime.manifest.name, 'energy', `扣减 ${result.debited}/${requested}（剩余 ${result.remaining}）`)
    return { requested, debited: result.debited, remaining: result.remaining, denied: result.denied, tier }
  }

  private buildContext(runtime: Runtime): OrganContext {
    const name = runtime.manifest.name
    const self = this

    const capability = (cap: string) => () => self.require(runtime, cap)

    return {
      // 交出去的是**另一份**冻结副本（runtime.manifestView），不是宿主判定用的那份。
      manifest: runtime.manifestView,
      get state(): OrganStateView {
        capability('state:read')()
        return self.deps.readState()
      },
      /**
       * 宿主机器指标：与 state 同一套闸门逻辑，但用的是独立能力 `host:read`。
       *
       * 为什么不合进 state：state 是"我身体里发生了什么"（可被器官影响），
       * hostMetrics 是"我身体外面那台机器怎么了"（器官只能看）。
       * 混在一起会让 default-deny 失去分辨力——读机器信息不该顺手拿到生理写入口。
       */
      get hostMetrics(): HostMetrics {
        capability('host:read')()
        // 每次调用都重新取：采样器自己管缓存与差分，宿主不做二次缓存，
        // 否则器官看到的是"上一次谁调用时的世界"。
        return self.deps.readHostMetrics?.() ?? emptyHostMetrics(self.deps.now())
      },
      log(level, message) {
        const tag = `[organ:${name}]`
        if (level === 'error') self.deps.log('error', `${tag} ${message}`)
        else if (level === 'warn') self.deps.log('warn', `${tag} ${message}`)
        else self.deps.log('info', `${tag} ${message}`)
      },
      consume: (amount, reason) => self.charge(runtime, amount, reason ?? 'consume'),
      /**
       * 往血液里滴一滴。
       *
       * 这违反了 C1（器官不直接写状态）吗？没有。器官交的是"想加 5"，
       * 真正去 clamp、落盘、同步兼容字段的是核心。
       * 器官拿到的是"滴完之后是多少"，拿不到"规则长什么样"——它提得出请求，改不了化学。
       */
      async inflict(idOrPatch, delta, reason) {
        capability('chem:write')()
        const patches: Array<[string, number]> = []
        if (typeof idOrPatch === 'string') {
          patches.push([idOrPatch, Number(delta ?? 0) || 0])
        } else if (idOrPatch && typeof idOrPatch === 'object') {
          for (const [key, value] of Object.entries(idOrPatch)) {
            patches.push([key, Number(value) || 0])
          }
        }
        if (patches.length === 0) {
          return [{ id: String(idOrPatch), value: null, applied: false, reason: '没有指定任何化学物质' }]
        }
        // 数量上限：一次最多 8 个——防止"把整个周期表滴一遍"的失控调用。
        const clipped = patches.slice(0, 8)
        if (patches.length > clipped.length) {
          self.record(name, 'chemical', `inflict 一次滴了 ${patches.length} 种，超过 8 种的部分被忽略`)
        }
        const out: InflictReceipt[] = []
        for (const [id, amount] of clipped) {
          if (amount === 0) {
            out.push({ id, value: null, applied: false, reason: '增量为 0，什么都没做' })
            continue
          }
          const result = self.deps.applyChemical?.(name, id, amount, reason)
          if (!result) {
            out.push({ id, value: null, applied: false, reason: '核心未提供化学写入口（器官宿主未接线 applyChemical）' })
            continue
          }
          if (result.value === null) {
            self.record(name, 'chemical', `滴「${id}」${amount > 0 ? '+' : ''}${amount} 被拒：${result.reason ?? '未知原因'}`)
            out.push({ id, value: null, applied: false, reason: result.reason })
            continue
          }
          self.record(name, 'chemical', `滴「${id}」${amount > 0 ? '+' : ''}${amount} → ${result.value.toFixed(1)}${reason ? `（${reason}）` : ''}`)
          out.push({ id, value: result.value, applied: true })
        }
        return out
      },
      emit(stimulus) {
        capability('tools')()
        // 异步派发，避免器官在 feedback 里等自己（会自锁）。
        void self.dispatch(stimulus)
      },
      proposeGap(summary, weight) {
        capability('gap:propose')()
        const id = self.deps.proposeGap(name, summary, weight)
        self.record(name, 'gap', id ? `提议缺口：${summary}（${id}）` : `提议缺口被拒：${summary}`)
        return id
      },
      async callTool(toolName, args) {
        capability('tools')()
        return self.deps.callTool(name, toolName, args)
      },
      onToolResult(names, handler) {
        capability('tools')()
        // 具体订阅由核心提供（只有它知道 tools/post-execute 的载荷形状）；
        // 宿主只负责能力校验、错误隔离与句柄托管。
        const disposable = self.deps.subscribeToolResult(name, names, (result) => {
          try {
            handler(result)
          } catch (error) {
            self.record(name, 'error', `onToolResult 回调抛错：${String(error)}`)
          }
        })
        runtime.disposables.push(disposable)
        return disposable
      },
      onTick(everyMs, handler) {
        capability('timer')()
        const interval = Math.max(MIN_TICK_MS, Math.round(everyMs))
        const disposable = self.deps.schedule(name, interval, () => {
          try {
            handler()
          } catch (error) {
            // 定时器里的错误没有调用栈可言，必须自己兜住，否则会变成 unhandledRejection。
            self.record(name, 'error', `tick 回调抛错：${String(error)}`)
          }
        })
        runtime.disposables.push(disposable)
        return disposable
      },
      registerTool(tool) {
        capability('tools')()
        const raw = String(tool?.name ?? '').trim()
        const fullName = organToolName(name, raw)

        // 器官作者写了 `memory.stats` / `记忆·统计` 这种名字：
        // 不阻断（它会炸掉下一次模型请求），但要留痕，否则没人知道名字被改过。
        if (raw && sanitizeToolName(raw) !== raw) {
          self.record(
            name,
            'sanitize',
            `工具名「${raw}」含非法字符，已清洗为「${fullName}」（只允许 a-zA-Z0-9_-）`,
          )
        }
        // 器官名本身不合规只需提示一次：它是常量，每个工具重复刷一遍只会淹没日志。
        if (name !== sanitizeToolName(name) && !self.organNameNoted.has(name)) {
          self.organNameNoted.add(name)
          self.record(
            name,
            'sanitize',
            `器官名「${name}」含非法字符，命名空间已清洗为「${sanitizeToolName(name)}」`,
          )
        }

        // 兜底：洗完还不合法（理论上不会），直接拒绝注册而不是留给模型 API 去报错。
        if (!TOOL_NAME_PATTERN.test(fullName) || fullName.length > MAX_TOOL_NAME_LENGTH) {
          self.record(name, 'deny', `拒绝注册工具「${raw}」：清洗后仍不合法（${fullName}）`)
          return { dispose: () => {} }
        }
        if (self.registeredToolNames.has(fullName)) {
          self.record(name, 'deny', `拒绝注册工具「${fullName}」：与已注册的工具重名`)
          return { dispose: () => {} }
        }

        try {
          const disposable = self.deps.registerTool(name, tool, fullName)
          self.registeredToolNames.set(fullName, name)
          runtime.disposables.push({
            dispose: () => {
              self.registeredToolNames.delete(fullName)
              disposable.dispose()
            },
          })
          return disposable
        } catch (error) {
          // 核心注册表自己抛错（例如宿主版本新增了命名校验）：降级为"这个工具没有"，
          // 而不是让 onLoad 失败——其它工具与该器官的感知能力都还能用。
          self.record(name, 'error', `注册工具「${fullName}」失败，已跳过：${String(error)}`)
          return { dispose: () => {} }
        }
      },
      onPrompt(provider) {
        capability('prompt')()
        const wrapper: OrganDisposable = {
          dispose: () => {
            runtime.promptProviders.delete(provider)
          },
        }
        runtime.promptProviders.add(provider)
        runtime.disposables.push(wrapper)
        return wrapper
      },
      get kv(): OrganKV {
        capability('fs:organ')()
        return self.deps.organKV(name)
      },

      /**
       * 受控网络：**统一走 checkNetRequest 那三把锁**，宿主自己不再引入第二种判定。
       *
       * 三条设计取舍：
       *   - 失败走返回值而不是抛错。C3 要求器官的错不能外溢，而且它还需要能**自省**：
       *     知道自己被挡在哪一步，才能在回执里说"是门关着，不是我说不清"；
       *   - 每次都把脱敏后的目标记进遥测：WebUI 里看得见"她刚刚联系了谁"；
       *   - deps.netRequest 缺省（多数测试环境）时回 ok:false，而不是把错误溅出去。
       */
      net: {
        async request(req: OrganNetRequest): Promise<OrganNetResponse> {
          const granted = (runtime.manifest.capabilities ?? []).filter(
            (cap) => cap === 'net:http' || cap === 'net:webhook' || cap === 'net',
          )
          const target = originOf(req.url) || req.url

          // ⓪ 宿主注入凭据：秘密在环境变量里活着，出门这一步才补进报文。
          //   她写的那一行只有 { content }，源码里因此一个密钥都没有。
          //   注入必须在序列化之前——包体上限要算上补进去的字段。
          const rules = self.options.net?.secrets
          let bodyToSend: unknown = req.body
          let organHeaders = req.headers
          let injectedHeaders: Record<string, string> = {}
          if (rules && rules.length > 0) {
            const merged = applySecretRules({
              url: req.url,
              body: req.body,
              headers: req.headers,
              rules,
              readEnv: self.deps.readEnv,
            })
            if (!merged.ok) {
              const note = merged.reason ?? '宿主凭据注入失败'
              self.record(name, 'net', `请求 ${target} 被拒：${note}`)
              return { ok: false, status: 0, text: '', truncated: false, note }
            }
            if (merged.applied.length > 0) {
              bodyToSend = merged.body
              organHeaders = merged.headers
              injectedHeaders = merged.injectedHeaders
              // 只记键名，不记值：日志里永远看不到 token 长什么样。
              self.record(
                name,
                'net',
                `宿主注入字段 ${merged.injectedKeys.join(', ') || '（无 body 字段）'}`
                  + `${merged.overridden.length > 0 ? `；覆盖了器官自己写的 ${merged.overridden.join(', ')}` : ''}`
                  + `（凭据归宿主，器官源码里没有明文）`,
              )
            }
          }

          const serialized = serializeJsonBody(bodyToSend)
          if (!serialized.ok) {
            const note = serialized.reason ?? '请求体不可序列化'
            self.record(name, 'net', `请求体被拒：${note}`)
            return { ok: false, status: 0, text: '', truncated: false, note }
          }

          const verdict = checkNetRequest({
            url: req.url,
            method: req.method ?? 'POST',
            bodyBytes: serialized.bytes,
            grantedCapabilities: granted,
            organPolicy: runtime.manifest.net ?? null,
            hostPolicy: self.options.net,
          })
          if (!verdict.ok) {
            self.record(name, 'net', `请求 ${target} 被拒：${verdict.reason ?? '未通过白名单'}`)
            return { ok: false, status: 0, text: '', truncated: false, note: verdict.reason }
          }

          const send = self.deps.netRequest
          if (!send) {
            const note = '核心未提供网络能力（organNet 未配置 netRequest）'
            self.record(name, 'net', `请求 ${target} 被拒：${note}`)
            return { ok: false, status: 0, text: '', truncated: false, note }
          }

          try {
            const response = await send(name, {
              url: req.url,
              method: (verdict.method === 'GET' ? 'GET' : 'POST') as 'GET' | 'POST',
              // 器官自己带的头先过净化，宿主补的那一份**后加**（所以 authorization 能用）。
              headers: { ...sanitizeNetHeaders(organHeaders), ...injectedHeaders },
              timeoutMs: req.timeoutMs ?? verdict.timeoutMs,
              body: serialized.text,
            })
            self.record(
              name,
              'net',
              `请求 ${target} → ${response.ok ? '成功' : '失败'}（HTTP ${response.status}）`,
            )
            return response
          } catch (error) {
            self.record(name, 'net', `请求 ${target} 抛错：${String(error).slice(0, 120)}`)
            return { ok: false, status: 0, text: '', truncated: false, note: `请求失败：${String(error).slice(0, 120)}` }
          }
        },

        /**
         * 两种写法都接受：
         *   post(url, body)                      —— 简写，大多数时候够用
         *   post(url, headers, body, options?)   —— 要自己写头的时候
         *
         * 中间那个参数怎么判断是"头"还是"体"：headers 的值全是字符串，
         * 而 body 几乎总有嵌套对象或非字符串值。纯字符串 map 的 body 极少见，
         * 真要发就把 options.headers 显式写出来，别让宿主替你猜。
         */
        post(url, bodyOrHeaders, bodyOrOptions?, maybeOptions?) {
          if (bodyOrHeaders && typeof bodyOrHeaders === 'object' && isHeaderMap(bodyOrHeaders) && arguments.length >= 3) {
            const headers = bodyOrHeaders as Record<string, string>
            return this.request({
              url,
              method: 'POST',
              body: bodyOrOptions,
              headers,
              timeoutMs: (maybeOptions as { timeoutMs?: number } | undefined)?.timeoutMs,
            })
          }
          // 简写：post(url, body) / post(url, body, options)
          const options = (arguments.length >= 3 ? bodyOrOptions : undefined) as { headers?: Record<string, string>; timeoutMs?: number } | undefined
          return this.request({
            url,
            method: 'POST',
            body: bodyOrHeaders,
            headers: options?.headers,
            timeoutMs: options?.timeoutMs,
          })
        },

        canReach(url, method = 'POST'): boolean {
          const granted = (runtime.manifest.capabilities ?? []).filter(
            (cap) => cap === 'net:http' || cap === 'net:webhook' || cap === 'net',
          )
          return checkNetRequest({
            url,
            method,
            grantedCapabilities: granted,
            organPolicy: runtime.manifest.net ?? null,
            hostPolicy: self.options.net,
          }).ok
        },
      } satisfies OrganNetwork,
    }
  }

  private record(
    organ: string,
    kind: TelemetryKind,
    text: string,
    dopamine?: number,
    cortisol?: number,
    serotonin?: number,
  ): void {
    const event: OrganTelemetryEvent = { at: this.deps.now(), organ, kind, text }
    if (dopamine !== undefined) event.dopamine = dopamine
    if (cortisol !== undefined) event.cortisol = cortisol
    if (serotonin !== undefined) event.serotonin = serotonin
    this.events.push(event)
    if (this.events.length > this.options.telemetryLimit) {
      this.events.splice(0, this.events.length - this.options.telemetryLimit)
    }
    // 名字被清洗必须肉眼可见：否则器官作者永远不知道自己写错了名字，
    // 而症状（工具改名）只会表现为"模型调不到这个工具"。
    if (kind === 'error' || kind === 'deny' || kind === 'sanitize') {
      this.deps.log('warn', `[organ:${organ}] ${text}`)
    }
  }
}

/** 从 DSH 的 content block 数组里拼出纯文本。宿主不认识模型，但认识"文本块"。 */
function textOfBlocks(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) {
    const single = content as { text?: unknown } | null
    return typeof single?.text === 'string' ? single.text : ''
  }
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block)
      continue
    }
    const text = (block as { text?: unknown } | null)?.text
    if (typeof text === 'string') parts.push(text)
  }
  return parts.join('\n')
}

/**
 * 一份"值全是字符串"的扁平对象：它更像 header，而不是请求体。
 *
 * 判断依据刻意这么土：`ctx.net.post(url, headers, body)` 这种三参写法要能自动分辨
 * 第二个参数到底是什么。而一个 JSON body 里出现数组、嵌套对象、数字或布尔的概率极高，
 * 扁平且全字符串的组合基本只可能是 header。真有"全字符串 body"就把 headers 显式写出来。
 */
export function isHeaderMap(value: object): boolean {
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) return false
  return entries.every(([, item]) => typeof item === 'string')
}
