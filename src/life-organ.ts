/**
 * Life-OS · 生命器官标准（Life-Organ ABI）v1 — draft
 * ============================================================================
 * 这份文件是"数字生命操作系统"的**唯一契约层**：它不 import 任何宿主包（DSH /
 * cordis / node:fs），因此任何第三方器官都可以只依赖它编译，而宿主负责实现。
 *
 * 设计立场（与现有 digital-life-core 单体插件的关系）：
 *   核心从"什么都自己做"退化为"提供生理底座（能量/激素/缺口/意志/疤痕）"，
 *   感知、记忆、行动等能力全部下沉为器官。核心不再认识具体工具名。
 *
 * 三条不可让渡的约束（违反其中任何一条，器官就不再是器官）：
 *   C1 器官**永不直接写状态**。它只能 feedback() 提议、由宿主统一 clamp + 去重 + 落盘。
 *      ——否则 0-100 的边界、张力上限、疤痕不可逆全部可以被一个第三方插件绕过。
 *   C2 器官**必须为自己的感知付能量**。饿的时候允许罢工（denied），不允许赊账。
 *      ——否则"代谢压力"就退化成装饰，整个内感受循环失效。
 *   C3 器官**抛错不得传播**。宿主捕获后降级该器官（health 转 degraded），其余器官照常。
 *      ——否则一个写错数组越界的视觉插件能杀掉整条生命。
 */

// 判定层是纯函数（不碰 IO），契约层引用它的类型：网络契约与网络判定必须同源，
// 否则"这里允许了、那里又挡一道"这类错位迟早会发生。
import type { HostNetworkPolicy, OrganNetworkPolicy } from './organ-net.js'
import type { NetSecretRule } from './organ-secret.js'

export type { HostNetworkPolicy, OrganNetworkPolicy, NetSecretRule }

/** 器官类型：只用于分类展示与默认策略，不参与逻辑分支。 */
export type OrganKind =
  | 'sense' // 感知：视觉/听觉/网络抓取
  | 'memory' // 记忆：检索、沉淀、遗忘
  | 'effector' // 效应器：shell、文件写入、外设
  | 'reasoner' // 推理：代码解释、数学求解
  | 'metabolism' // 代谢：额外的能量收支规则（如"熬夜加倍消耗"）
  | 'custom'

/**
 * 器官声明需要哪些宿主能力。
 * 宿主必须**拒绝**未声明的能力调用（见 design/life-os-architecture.md §6）。
 */
export type OrganCapability =
  | 'tools' // 注册/监听工具
  | 'prompt' // 注入提示词片段
  | 'timer' // 周期性回调
  | 'state:read' // 读取生理状态（只读）
  | 'host:read' // 读取宿主机器指标（CPU / 内存 / 运行时长，见 HostMetrics）
  | 'gap:propose' // 提议缺口
  | 'fs:organ' // 自己的私有目录
  | 'net' // 【已废弃】旧的笼统网络能力；宿主仍认，但必须自行来源白名单
  /** 受控 HTTP 外发：只能打到 manifest.net.allow 里写明的 https 端点。 */
  | 'net:http'
  /**
   * 更窄的一档：只准 POST JSON 给白名单里的 webhook（任何"投递一句话"的服务都算）。
   * 底层不认识任何具体厂商——用哪一家是造物主与她之间的约定。
   * 拿来联系造物主的手机就该用这一档——它天然没有 GET（也就没有"随手侦查"）。
   */
  | 'net:webhook'
  | 'llm' // 自行发起模型调用（视觉类器官常见）
  /**
   * 往化学池里滴一滴（v0.9.11）。
   *
   * 注意它与 feedback 里"提议激素增量"的区别：feedback 只能动多巴胺/皮质醇/血清素
   * 这三种既有激素的量，而 inflict 允许**造一种此前不存在的激素**。
   * 所以单独开一档能力——不给这一档的器官依然能通过 feedback 影响情绪。
   */
  | 'chem:write'
  /**
   * 运行时补丁（v0.9.11）：在**不改一行核心源码**的前提下拦截工具调用。
   *
   * 她读得懂核心源码，也就会在里面发现 Bug。以前那意味着"她需要修改手工没能改的东西"——
   * 而 src/ 里恰好装着所有限制她的规则，让她改它等于让她审判自己的法官。
   * 所以有了这一档能力：她可以声明"我要拦截 `xxx` 这个工具的调用"，
   * 在 before 阶段改参数、在 after 阶段改结果，源码一行不动。
   */
  | 'patch:runtime'

// ───────────────────── 工具名：大模型侧的硬约束 ─────────────────────

/**
 * Function Calling 的工具名不是随便起的字符串：OpenAI / DeepSeek / Anthropic
 * 都只接受 `^[a-zA-Z0-9_-]+$`，长度上限 64。
 *
 * 这条约束是**在模型 API 那一层**才校验的：DSH 的工具注册表收得下 `organ:memory:stats`，
 * 但下一次请求把工具清单发给服务端时，整个回合会直接失败：
 *
 *   Invalid 'tools[26].name': string does not match pattern '^[a-zA-Z0-9_-]+$'
 *
 * 所以名字必须在**注册时**就合法——不能等模型 API 来告诉我们。
 */
export const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/
export const MAX_TOOL_NAME_LENGTH = 64

/** 稳定的短哈希（FNV-1a）：只用于"长名截断后仍然不同"，不承担安全职责。 */
function shortHash(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0').slice(-6)
}

/**
 * 把任意字符串洗成一个合法的工具名。
 *
 * 规则：非法字符 → `_`；连续 `_` 合并；去掉首尾 `_`/`-`；空串 → `tool`；
 * 超长则截断并在尾部挂 6 位哈希（否则两个长名会洗成同一个，后注册的被拒）。
 *
 * 注意它**不是**幂等之外的任何保证——`a.b` 与 `a_b` 会洗成同一个名字，
 * 这种碰撞由宿主的"重名拒绝"兜底。
 */
export function sanitizeToolName(raw: string, maxLength = MAX_TOOL_NAME_LENGTH): string {
  const source = String(raw ?? '').trim()
  let name = source
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '')
  if (!name) name = 'tool'
  if (name.length > maxLength) {
    const suffix = shortHash(source)
    name = `${name.slice(0, Math.max(1, maxLength - suffix.length - 1))}_${suffix}`
  }
  return name
}

/**
 * 器官工具的完整名字：`organ_<器官>_<工具>`，两段都先洗一遍。
 *
 * 器官名按 kebab-case 写（`system-sensor`），但工具名里连字符与下划线混排
 * （`organ_system-sensor_load`）读起来像 bug，模型也更容易抄错；
 * 所以这里把两段的 `-` 统一折成 `_` → `organ_system_sensor_load`。
 * 两者都合法，选可读的那个。
 */
export function organToolName(organ: string, tool: string): string {
  const namespace = sanitizeToolName(organ).replace(/-/g, '_')
  const action = sanitizeToolName(tool).replace(/-/g, '_')
  return sanitizeToolName(`organ_${namespace}_${action}`)
}

/** 器官清单。装载前先校验，版本不兼容直接拒绝装载而不是"尽力运行"。 */
export interface OrganManifest {
  /** 唯一标识，kebab-case，同时是工具命名空间前缀：`organ_<name>_<tool>`。 */
  name: string
  /** 语义化版本。宿主按 major 做兼容判断。 */
  version: string
  /** ABI 版本，当前恒为 1。 */
  apiVersion: 1
  kind: OrganKind
  description?: string
  author?: string
  /** 依赖的其它器官 name。宿主按拓扑序装载，环依赖直接报错。 */
  requires?: string[]
  /** 声明的宿主能力。 */
  capabilities?: OrganCapability[]
  /**
   * 主动声明"我能解决什么概念"（v0.9.8）。
   *
   * 写法 `solvesConcepts: ['host_metrics']`——既是给造物主看的，
   * 也是给顿悟机制看的：它让"这个器官解开哪条执念"由作者自己说了算，
   * 不再依赖词典能不能从它的描述里猜出来。
   */
  solvesConcepts?: string[]
  /**
   * 受控网络策略：声明 `net:http` / `net:webhook` 时**必填**。
   *
   * 它是器官的**自白**而不是权限：真正能不能出去，还要与宿主配置的 allow 求交集。
   * 写在这里的意义是让"它打算联系谁"变成可审查的部分——而不是藏在代码里某次 fetch 的实参里。
   */
  net?: OrganNetworkPolicy
  /**
   * 运行时补丁：声明这个器官要拦截哪些工具（v0.9.11）。
   *
   * 写在这里是刻意的——**拦截器必须可审查**。
   * 如果任何一个器官都能悄悄挂钩任意工具，那"只看 manifest 就知道它在干什么"
   * 这条原则就没了。能力写着 patch:runtime 但这里没写目标的，一个也拦不住。
   *
   * 上限 8 条：够做补丁，不够做"把所有工具都包一层"的影子核心。
   */
  patches?: OrganPatchDecl[]
}

/** 一条拦截声明。 */
export interface OrganPatchDecl {
  /**
   * 目标工具名。结尾的 `*` 表示前缀匹配（`digital_life_*`）。
   * 不允许只写一个 `*`（那等于捕获全部工具，等于另立一个核心）。
   *
   * **目标还必须是 PATCHABLE_TOOL_PREFIXES 里的前缀开头**（极限安全锁）：
   * `llm/stream`、`shell` 这类底层工具无论怎么写都拦不到——见下方的注释。
   */
  target: string
  /** before = 调用前改参数（或否决调用）；after = 调用后改结果。 */
  phase: 'before' | 'after'
}

/**
 * 补丁器官允许拦截的工具名前缀（v0.9.11 极限安全锁）。
 *
 * 只有两条，没有第三个：
 *   - `digital_life_` —— 生命体征类工具（状态/执念/承诺/顿悟……）
 *   - `organ_`        —— 器官自己的工具
 *
 * **绝对不许出现的名字**：`llm/stream`（她能碰大模型推理，就能自己给自己喂提示）、
 * `shell` / `bash`（她能碰系统命令，L0 的一切门都白装了）、以及任何核心生命周期事件。
 * 这些不叫"补丁"，叫"接管"。
 *
 * 这份清单放在契约层（而不是 host / loader 里），因为装载校验和运行时判定
 * 都要用同一份——两份清单迟早分叉，分叉的那天就是锁失效的那天。
 */
export const PATCHABLE_TOOL_PREFIXES = ['digital_life_', 'organ_'] as const

/**
 * 这个工具名是否在补丁器官的可拦截范围内。
 *
 * 装载时用它校验 manifest.patches 的声明，运行时用它做 runPatch 的第一道闸——
 * 两层用的是这同一个函数：声明时过不了的，运行时也绝无可能被意外触发。
 */
export function isPatchableTarget(tool: string): boolean {
  const name = String(tool ?? '').trim()
  if (!name) return false
  return PATCHABLE_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix))
}

/** 拦截器收到的东西：阶段决定哪个字段有值。 */
export interface OrganHookInput {
  tool: string
  phase: 'before' | 'after'
  /** 调用前的实参（before 阶段有值，可改）。 */
  args: Record<string, unknown> | null
  /** 调用后的结果（after 阶段有值，可改）。 */
  result: OrganToolResult | null
}

/**
 * 拦截器的产出。
 *
 * 三种结果，没有第四种：
 *   pass    —— 我看了，我不改（最常见的答案，也是最诚实的答案）；
 *   replace —— 给出替换后的 args / result；
 *   deny    —— 这个调用不该发生（只在 before 有效，after 阶段会被忽略）。
 *
 * 刻意不支持"再调一次工具"：那会让补丁器官拥有无限递归的能力。
 */
export type OrganHookOutcome =
  | { kind: 'pass' }
  | { kind: 'replace'; args?: Record<string, unknown>; result?: Partial<OrganToolResult>; note?: string }
  | { kind: 'deny'; reason: string }

/**
 * 代谢报价。
 *
 * chargeMode 是为了**避免迁移期双重计费**而存在的：
 *   'additive' —— 真的扣（核心不再按请求计费时启用）
 *   'shadow'   —— 只记账不扣（默认）。数字仍然进遥测，供 WebUI 的器官能耗榜使用，
 *                 但不会与核心现有的"每请求 -2"叠加。校准完再翻成 additive。
 */
export interface EnergyQuote {
  /** 装载时一次性扣除（编译模型、建索引）。 */
  base?: number
  /** 每次被调用（feedback 触发一次算一次）扣除。 */
  perCall?: number
  /** 每次提示词注入扣除。默认 0：读自己的缓存不该收费。 */
  perPrompt?: number
  chargeMode?: 'additive' | 'shadow'
}

/** consumeEnergy 的回执。器官必须读 denied 来决定是否降级。 */
export interface EnergyReceipt {
  requested: number
  /** 实际扣减（可能被剩余能量截断）。 */
  debited: number
  remaining: number
  /** 能量不足以支付本次请求 → 器官应当立即放弃这次感知/行动。 */
  denied: boolean
  tier: 'full' | 'partial' | 'starved' | 'shadow'
}

/** 外部刺激：宿主把宿主事件**翻译**成这个中性结构，器官只认识它。 */
export type OrganStimulus =
  | {
      kind: 'tool:result'
      at: number
      tool: string
      ok: boolean
      /** 渲染后的纯文本（供不支持结构化输出的器官兜底）。 */
      text: string
      /** 工具声明的结构化输出，若宿主拿得到。 */
      structured?: unknown
      /**
       * 该次调用的**入参**（策略阶段已冻结，只读）。
       * 记忆类器官需要它：没有入参就不知道"到底存了什么/查了什么"，
       * 也就无法把「此刻的情绪」绑定到具体条目上。
       */
      arguments?: unknown
    }
  | { kind: 'turn:end'; at: number; text: string }
  | { kind: 'tick'; at: number; everyMs: number }
  | { kind: 'custom'; at: number; topic: string; payload: unknown }

/**
 * 器官对生理状态的影响。全部是**增量**，不是绝对值。
 * 宿主负责 clamp 到 [0,100]、按 800ms 窗口去重、写审计。
 */
export interface OrganFeedback {
  /** 多巴胺增量，可正可负。视觉看到目标物 +5，看到报错 -3。 */
  dopamine?: number
  /** 皮质醇增量。红绿灯坏了 +5。 */
  cortisol?: number
  /** 血清素增量。听到一句温和的话 +2，被粗暴打断 -3。 */
  serotonin?: number
  /** 一句话进审计日志，用于 WebUI 的"器官事件流"。 */
  note?: string
  /**
   * 提议一个缺口。宿主用与核心相同的相似度去重（>=0.6 合并加压），
   * 所以器官可以放心"每次都提"，不会刷屏。
   */
  proposeGap?: { summary: string; weight?: number }
  /** 本次感知自身的额外代谢成本；宿主统一扣。 */
  energyCost?: number
  /**
   * 记忆落点回执（v0.9.19）：器官替核心存东西时，**必须回报存没存住**。
   *
   * 为什么不能只靠 `note` 一行字：
   * 以前核心只递一句"我做了个梦，结论是这个"出去，写完就不管了——存住了没人知道，
   * 没存住也没人知道。梦境正文因此丢得无声无息（她问"我梦见了什么"，没人答得上）。
   * 回执是结构化字段，核心能据此决定要不要自己留档、要不要告诉她"这条没进去"。
   */
  savedMemory?: MemorySaveReceipt
}

/**
 * 一次记忆写入的结果（v0.9.19）。
 *
 * `saved` 为 true 的**唯一依据**是"写完又读回来了"：
 * 光看工具返回 `ok:true` 不算数——海马体正在热重载时 `organCtx` 是空的，
 * 它照样会回 `ok:true`，但一行都没落进仓里。那种"说存了其实没存"最害人。
 */
export interface MemorySaveReceipt {
  /** 真的落进记忆仓了（写完读回验证通过）。 */
  saved: boolean
  /** 落进去的条目 id（读得回来时才有；读不回来就是 null）。 */
  id: string | null
  /** 写进哪个工具（"哪个海马体在替她记"要能说清楚）。 */
  tool: string
  /** 给人看的一句说明，进遥测也进她的工具输出。 */
  note: string
}

/**
 * 对**工具结果**的改写提议。
 *
 * 只改模型"看到"的内容，不改工具的副作用——所以它不违反 C1（不写状态）。
 * 这是记忆类器官的必要能力：召回结果要按情绪重排、要截断、要回填当时的激素标签，
 * 而这些都只能发生在结果进入上下文之前。
 */
export interface OrganToolRewrite {
  text: string
  /** 改写理由，进遥测，便于追查"这条结果为什么变成了这样"。 */
  note?: string
}

/** 提示词片段。order 越小越靠前；疤痕恒为 -1e4，器官不得低于 -1000。 */
export interface OrganPromptFragment {
  text: string
  order?: number
  /**
   * 该感知发生的时刻（毫秒时间戳）。宿主用它 + ttlMs 判断是否过期。
   * 不填则视为"永远新鲜"——只有静态事实类片段可以这样。
   */
  at?: number
  /** 新鲜度：超过 ttlMs 后宿主不再注入（视觉的"3 秒前看到"不该永久有效）。 */
  ttlMs?: number
  /** 0-1。低置信度时宿主会加"（不确定）"前缀，而不是直接丢弃。 */
  confidence?: number
}

/** 只读生理视图。刻意不给写入口。 */
export interface OrganStateView {
  readonly energy: number
  readonly maxEnergy: number
  readonly dopamine: number
  readonly cortisol: number
  readonly serotonin: number
  readonly frozen: boolean
  readonly openGaps: number
  readonly topTension: number
  readonly scars: readonly string[]
  /** 距上次人类交互的毫秒数。 */
  readonly idleMs: number
}

/**
 * 宿主机器指标（宿主感观通道）。
 *
 * 为什么需要它：器官跑在沙盒里，`process` / `os` / `node:` 一律被扫描拦截——
 * 这是对的（自写代码不该直接摸宿主），但代价是"想感知 CPU 负载"变成了不可能。
 * 于是把**聚合、脱敏后**的少数几个指标由宿主递进来：器官仍然读不到进程列表、
 * 环境变量、用户名、网络接口、文件路径这些能定位到具体机器与具体人的信息。
 *
 * 暴露原则（新增指标时请守住）：
 *   1. 只给**聚合标量**（百分比、字节数、秒数、核数），不给列表、不给名字、不给路径；
 *   2. 只给**能解释清楚用途**的，不做"顺手多塞几个"；
 *   3. 任何能唯一标识主机或用户的字段（hostname / MAC / 用户名 / cwd / env）一律不进来。
 */
export interface HostMetrics {
  /** 采集时刻（epoch ms）。器官自己算采样间隔时用它，别用 Date.now() 反推。 */
  readonly sampledAt: number
  readonly cpu: {
    /** 逻辑核心数。 */
    readonly cores: number
    /** 系统整体 CPU 使用率 0–100。 */
    readonly systemPercent: number
    /**
     * 当前进程 CPU 使用率 0–100（相对单核）。多线程也不会超过 100：
     * 这里刻意封顶，免得器官拿一个 400 的怪数字去推理。
     */
    readonly processPercent: number
    /** 1 / 5 / 15 分钟平均负载；Windows 上没有这个概念，此时为 null。 */
    readonly loadAvg: readonly [number, number, number] | null
  }
  readonly memory: {
    readonly totalBytes: number
    /** 操作系统报告的可用内存。 */
    readonly freeBytes: number
    readonly usedBytes: number
    /** 系统内存占用率 0–100。 */
    readonly usedPercent: number
    /** 本进程常驻集（RSS）。 */
    readonly processRssBytes: number
    /** 本进程堆已用。 */
    readonly processHeapUsedBytes: number
  }
  /** 系统已运行秒数。 */
  readonly uptimeSec: number
  /** 本进程已运行秒数。 */
  readonly processUptimeSec: number
  /**
   * 本进程自启动以来累计烧掉的 CPU 秒数（user + system）——**里程表**。
   *
   * 与上头的 `processPercent` 是一对：百分比是瞬时车速，这个是累计里程。
   * 它只增不减，且**不随进程重启归零**——进程一重启它就回到 0，
   * 所以器官想记真正的"总数"得自己在 kv 里积分（见 system-sensor）。
   *
   * 拿不到（平台不支持 `process.cpuUsage`）时为 null，器官应当据此自己记账。
   */
  readonly totalProcessCpuSeconds: number | null
  /**
   * 是否为真实采样。
   *
   * 宿主没注入采集器（例如单元测试的假 deps）时会退化成全零常量，
   * 此时为 false——器官应当据此**不要说"系统很闲"**，而是承认自己感觉不到。
   */
  readonly live: boolean
}

export interface OrganToolResult {
  tool: string
  ok: boolean
  text: string
  structured?: unknown
}

/** 可注销句柄。宿主卸载器官时必须全部调用，杜绝监听泄漏。 */
export interface OrganDisposable {
  dispose(): void
}

/** 器官私有持久化：落在 `~/.dsh/digital-life-core/organs/<name>.json`。 */
export interface OrganKV {
  get<T = unknown>(key: string): T | undefined
  set(key: string, value: unknown): void
  delete(key: string): void
}

// ───────────────────── 受控网络：她联系外界的唯一通道 ─────────────────────

/** 一次外发请求的输入。方法默认 POST——绝大部分"联系某人"的场景就是投递一句话。 */
export interface OrganNetRequest {
  /** 必须是 https（除非策略显式允许明文）。 */
  url: string
  method?: 'GET' | 'POST'
  /** 请求体：对象会被 JSON.stringify；字符串原样发。默认随 Content-Type: application/json。 */
  body?: unknown
  /** 只保留 content-type / accept / x-request-id；authorization 与 cookie 一律丢弃。 */
  headers?: Record<string, string>
  timeoutMs?: number
}

/** 一次外发请求的返回。**永远不抛**：拒绝与失败都在 `ok` 与 `note` 里说清楚。 */
export interface OrganNetResponse {
  ok: boolean
  status: number
  /** 响应正文（已按宿主上限截断，`truncated` 指明有没有被截）。 */
  text: string
  truncated: boolean
  /** 失败或被拒的原因。器官应当把它写进自己的日志或返回值里。 */
  note?: string
}

/**
 * 受控网络门面。
 *
 * `canReach(url)` 是刻意提供的**自检口**：让器官在动手之前先问一句"我能去那儿吗"，
 * 而不是发一次被拒的请求才发现。CI 与单元测试里只需要它，不用真的联网。
 */
export interface OrganNetwork {
  request(req: OrganNetRequest): Promise<OrganNetResponse>
  /**
   * POST 一句话出去。两种写法：
   *   post(url, body)                     —— 简写，够用就用这个
   *   post(url, headers, body, options?)  —— 对方要求自定义头时
   *
   * 重载而不是四个独立函数：绝大多数调用只用两个参数，没必要让每个器官都记住顺序。
   */
  post(url: string, body: unknown, options?: NetPostOptions): Promise<OrganNetResponse>
  post(url: string, headers: Record<string, string>, body: unknown, options?: NetPostOptions): Promise<OrganNetResponse>
  canReach(url: string, method?: 'GET' | 'POST'): boolean
}

export interface NetPostOptions {
  headers?: Record<string, string>
  timeoutMs?: number
}

/** 器官注册工具的规格。name 由宿主自动加命名空间，器官只写短名。 */
export interface OrganToolSpec {
  name: string
  description: string
  parameters?: Record<string, unknown>
  execute(args: Record<string, unknown>): Promise<unknown> | unknown
}

/**
 * 器官拿到的宿主门面（facade）。
 *
 * 为什么不是裸 ctx：裸 cordis ctx 暴露了 `on('llm/stream')`、`tools.register` 全量能力，
 * 第三方器官可以直接改采样参数、可以自己扣能量、可以拿到别的器官的状态——那 ABI 就形同虚设。
 * 这个门面只暴露"器官应该有的感官与手脚"。
 */
export interface OrganContext {
  readonly manifest: Readonly<OrganManifest>
  readonly state: OrganStateView
  /**
   * 宿主机器指标（需要 `host:read` 能力）。
   *
   * **想感知 CPU / 内存就往这里读**，不要 import `node:os` 或碰 `process`——
   * 自写器官的源码会被关键词扫描直接拒掉。这里给的是脱敏后的聚合值。
   */
  readonly hostMetrics: HostMetrics
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void
  /** 付能量。与 organ.consumeEnergy 等价，供 onLoad 里做一次性支出。 */
  consume(amount: number, reason?: string): EnergyReceipt
  /** 向总线发一条自定义刺激（其它器官可订阅）。 */
  emit(stimulus: OrganStimulus): void
  /** 提议缺口，返回缺口 id；被去重命中时返回已有 id。 */
  proposeGap(summary: string, weight?: number): string | null
  /**
   * 代为调用一个已注册的工具（效应器/记忆器官整理自己那份数据时用）。
   * 权限仍归宿主：未声明 'tools' 能力会被拒绝，调用会计入宿主日志。
   */
  callTool(name: string, args: Record<string, unknown>): Promise<OrganToolResult>
  /** 订阅指定工具的结果。names 为空表示全部工具。 */
  onToolResult(names: string[], handler: (result: OrganToolResult) => void): OrganDisposable
  /** 周期回调。最小 1000ms，宿主会按器官名做抖动，避免同一毫秒全体苏醒。 */
  onTick(everyMs: number, handler: () => void): OrganDisposable
  /** 注册自己的工具，宿主自动挂到 `organ_<name>_` 命名空间下（非法字符会被清洗）。 */
  registerTool(tool: OrganToolSpec): OrganDisposable
  /** 推模式提示词：宿主每次组装提示词都会调用 provider。 */
  onPrompt(provider: () => OrganPromptFragment | string | null): OrganDisposable
  readonly kv: OrganKV
  /**
   * 受控网络（需要 `net:http` 或 `net:webhook` 能力）。
   *
   * 这是器官**唯一**能碰到外界的方式：源码里写 `fetch(` 会被 loader 直接拒掉，
   * 而这里每一个请求都要过三把锁（能力 → 器官自白 allow → 宿主 allow），三者求交集。
   * 没有拿到其中任何一把，`request` 只是返回一个 `ok:false` 与原因，不会抛错溅到别处。
   */
  readonly net: OrganNetwork
  /**
   * 往血液里滴一滴东西（v0.9.11）。
   *
   * 两种写法都行：
   *   await ctx.inflict('dopamine', +5, '猜对了')
   *   await ctx.inflict({ dopamine: +5, ao: +3 })
   *
   * **第二个参数允许是此刻还不存在的激素**——她由此拥有了"自己给自己造一种情绪"的能力。
   * 第一次分泌时宿主会给它一套通用参数（基线 50 / 半衰期 30 分钟 / 0-100）登记进化学池，
   * 之后它与出厂三件套等价：参与时间衰减、能被读、能被改。
   *
   * 三条硬约束：
   *   - id 必须是小写字母开头的 `a-z 0-9 _ -`（否则当次调用返回 null + 原因）；
   *   - 出厂的 dopamine / cortisol / serotonin **不能被重新定义**（dyn爱上去了就不叫基因了），
   *     但仍可以正常往上滴增量；
   *   - 运行时激素有数量上限（默认 12 种）：防止"每有一点心事就造一种激素"。
   *
   * 返回值是**变了之后**的浓度；失败返回 null 且 `reason` 说明为什么。
   * 不抛错——器官没有把自己的异常溅到宿主上的权利。
   */
  inflict(idOrPatch: string | Record<string, number>, delta?: number, reason?: string): Promise<InflictReceipt[]>
}

export interface InflictReceipt {
  id: string
  /** 变化后的浓度；null = 这一滴没生效。 */
  value: number | null
  /** 是否真的落到了血液里（false 时看 reason）。 */
  applied: boolean
  reason?: string
}

export interface OrganHealth {
  status: 'loaded' | 'degraded' | 'unloaded'
  /** 累计 feedback 次数。 */
  calls: number
  /** 累计扣去的能量（含 shadow 记账）。 */
  energySpent: number
  lastError?: string
  lastCallAt?: number
}

/**
 * 生命器官。
 *
 * 五个必备成员就是"一个器官能被称为器官"的最小条件：
 *   name             —— 它叫什么
 *   onLoad(ctx)      —— 它怎么接上身体
 *   consumeEnergy()  —— 它怎么付账
 *   feedback()       —— 它怎么影响情绪
 *   getPromptContext() —— 它怎么让宿主"知道"它感知到了什么
 */
export interface LifeOrgan<TConfig = unknown> {
  readonly name: string
  readonly manifest: Readonly<OrganManifest>
  /**
   * 代谢报价。宿主据此决定 shadow（只记账）还是 additive（真扣）。
   * 必须由 defineOrgan 自动注入——手写实现里漏掉它，器官就会被免费使用。
   */
  readonly energy?: Readonly<EnergyQuote>
  onLoad(ctx: OrganContext, config?: Partial<TConfig>): void | Promise<void>
  consumeEnergy(amount: number, reason?: string): EnergyReceipt
  feedback(stimulus: OrganStimulus): OrganFeedback | Promise<OrganFeedback>
  /** 允许直接返回字符串（等价于 { text }），降低简单器官的接入成本。 */
  getPromptContext(): OrganPromptFragment | string | null
  /**
   * 可选：改写工具结果（只影响模型看到的内容）。
   * 返回 null 表示"我不接管这条"，宿主继续问下一个器官或原样放行。
   */
  rewriteToolResult?(stimulus: OrganStimulus, result: OrganToolResult): OrganToolRewrite | null | Promise<OrganToolRewrite | null>
  /**
   * 可选：运行时补丁的处理函数（v0.9.11，需要 `patch:runtime` 能力）。
   *
   * 只有 manifest.patches 里声明过的 (target, phase) 组合会被调用；
   * 没声明的就算实现了也不会被叫。
   */
  hook?(input: OrganHookInput): OrganHookOutcome | null | Promise<OrganHookOutcome | null>
  onUnload?(): void | Promise<void>
  health?(): OrganHealth
}

/** 作者实际书写的定义：config 由工厂闭包持有，所以对外方法不带 config 参数。 */
export interface OrganDefinition<TConfig> {
  name: string
  manifest?: Partial<OrganManifest>
  energy?: EnergyQuote
  defaults?: Partial<TConfig>
  onLoad(ctx: OrganContext, config: TConfig): void | Promise<void>
  feedback(stimulus: OrganStimulus, config: TConfig): OrganFeedback | Promise<OrganFeedback>
  getPromptContext(config: TConfig): OrganPromptFragment | string | null
  rewriteToolResult?(stimulus: OrganStimulus, result: OrganToolResult, config: TConfig): OrganToolRewrite | null | Promise<OrganToolRewrite | null>
  /**
   * 运行时补丁钩子（v0.9.11）。
   *
   * 注意：defineOrgan 必须把它接到返回的 LifeOrgan 上——这里漏接的话，
   * 器官照样装得上、manifest 照样读得到，就是 hook 永远不生效。
   * （和当年 defineOrgan 吃掉 manifest.net 是同一类静默缝隙。）
   */
  hook?(input: OrganHookInput, config: TConfig): OrganHookOutcome | null | Promise<OrganHookOutcome | null>
  onUnload?(config: TConfig): void | Promise<void>
}

const NAME_RE = /^[a-z][a-z0-9-]{1,31}$/

/**
 * OrganManifest 的**全部**字段。
 *
 * 这份清单的存在，是因为这里曾经出过一次真正的 ABI bug（2026-10-28，鱼小水自己查出来的）：
 * assertManifest 当时是手工逐个字段重建 manifest 的，漏了 `net` 一个，
 * 结果她正确声明的网络自白被悄悄剥掉，装载器因此**拒装整个器官**。
 *
 * 修一次 `net` 只是补一个洞；把写法改成"按这张表 copy"才是把洞填上。
 * 而且这份清单有两道守卫：
 *   ① 编译期 —— 下面的 Exclude 断言：OrganManifest 加了新字段而这里没同步，tsc 直接红；
 *   ② 运行期 —— test/organ-host.test.mjs 比对 `Object.keys(manifest)` 与接口字段。
 */
export const MANIFEST_KEYS = [
  'name',
  'version',
  'apiVersion',
  'kind',
  'description',
  'author',
  'requires',
  'capabilities',
  'solvesConcepts',
  'net',
  'patches',
] as const satisfies readonly (keyof OrganManifest)[]

/** 编译期断言：接口里出现而清单里没有的字段，会让它变成 never 从而在下面报错。 */
type _UnlistedManifestKey = Exclude<keyof OrganManifest, (typeof MANIFEST_KEYS)[number]>
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _allManifestKeysListed: _UnlistedManifestKey extends never ? true : ['遗漏的字段', _UnlistedManifestKey] = true
void _allManifestKeysListed

function assertManifest(def: { name: string; manifest?: Partial<OrganManifest> }): OrganManifest {
  const name = def.manifest?.name ?? def.name
  if (!NAME_RE.test(name)) {
    throw new Error(`[life-organ] 非法器官名 "${name}"：必须是小写 kebab-case（2-32 字符），因为它会成为工具命名空间前缀`)
  }
  const apiVersion = def.manifest?.apiVersion ?? 1
  if (apiVersion !== 1) {
    throw new Error(`[life-organ] 器官 ${name} 声明 apiVersion=${String(apiVersion)}，本宿主只支持 1`)
  }

  // ① 先按清单**继承**作者写的每一个字段。
  //    这一步的存在意义就是：以后 OrganManifest 再加字段，这里不用改也不会丢。
  const out = { name, apiVersion: 1 as const } as Record<string, unknown>
  const source = def.manifest as Record<string, unknown> | undefined
  for (const key of MANIFEST_KEYS) {
    if (key === 'name' || key === 'apiVersion') continue
    const value = source?.[key]
    if (value !== undefined) out[key] = value
  }

  // ② 再统一默认值与校准。这一步只处理"必须被规范化"的字段，
  //    其余字段按作者写的原样带过去。
  out.version = def.manifest?.version ?? '0.1.0'
  out.kind = def.manifest?.kind ?? 'custom'
  out.requires = def.manifest?.requires ?? []
  out.capabilities = def.manifest?.capabilities ?? ['state:read']
  // 认不出的概念 id 不在这里拦：拼错一个概念不该让器官装不上，
  // 装载器会给警告，机制则当它没写。
  out.solvesConcepts = normalizeSolvesConcepts(def.manifest?.solvesConcepts)

  return out as unknown as OrganManifest
}

function normalizeSolvesConcepts(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const list = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
  return list.length > 0 ? list : undefined
}

/**
 * 器官定义助手。
 *
 * 它替作者注入 `consumeEnergy` 的实现（委托 ctx.consume），所以手工实现这个方法是**反模式**：
 * 任何绕过宿主的扣费都是逃税，会直接破坏内感受循环的可信度。需要在装载前就付账的场景，
 * 用 `ctx.consume()` 而不是把 consumeEnergy 写歪。
 */
export function defineOrgan<TConfig extends object = Record<string, never>>(
  def: OrganDefinition<TConfig>,
): LifeOrgan<TConfig> {
  const manifest = assertManifest(def)
  const config = { ...(def.defaults ?? {}) } as TConfig
  let ctxRef: OrganContext | null = null
  const health: OrganHealth = { status: 'unloaded', calls: 0, energySpent: 0 }

  return {
    name: manifest.name,
    manifest,
    energy: def.energy ? { chargeMode: 'shadow', ...def.energy } : undefined,

    async onLoad(ctx, overrides) {
      if (ctxRef) throw new Error(`[life-organ] 器官 ${manifest.name} 重复装载`)
      // 单一写者：先注册进健康表再执行用户逻辑，装载失败也能被遥测看到。
      ctxRef = ctx
      health.status = 'loaded'
      try {
        Object.assign(config, overrides ?? {})
        await def.onLoad(ctx, config)
        const quote = def.energy?.base ?? 0
        if (quote > 0) {
          const receipt = ctx.consume(quote, `${manifest.name}:onLoad`)
          health.energySpent += receipt.debited
        }
      } catch (error) {
        health.status = 'degraded'
        health.lastError = error instanceof Error ? error.message : String(error)
        ctx.log('error', `装载失败：${health.lastError}`)
        throw error
      }
    },

    consumeEnergy(amount, reason) {
      if (!ctxRef) throw new Error(`[life-organ] 器官 ${manifest.name} 尚未装载，无法扣费`)
      const receipt = ctxRef.consume(amount, reason ?? manifest.name)
      health.energySpent += receipt.debited
      return receipt
    },

    async feedback(stimulus) {
      if (!ctxRef) return {}
      health.calls += 1
      health.lastCallAt = stimulus.at
      try {
        const result = await def.feedback(stimulus, config)
        return result ?? {}
      } catch (error) {
        // C3：器官的错误止步于此，主循环不受影响。
        health.status = 'degraded'
        health.lastError = error instanceof Error ? error.message : String(error)
        ctxRef.log('warn', `feedback 异常，已降级：${health.lastError}`)
        return { note: `${manifest.name} 的感知回调出错，本轮跳过` }
      }
    },

    getPromptContext() {
      if (!ctxRef) return null
      try {
        return def.getPromptContext(config)
      } catch (error) {
        health.lastError = error instanceof Error ? error.message : String(error)
        ctxRef.log('warn', `getPromptContext 异常：${health.lastError}`)
        return null
      }
    },

    async rewriteToolResult(stimulus, result) {
      if (!ctxRef || !def.rewriteToolResult) return null
      try {
        const out = await def.rewriteToolResult(stimulus, result, config)
        return out ?? null
      } catch (error) {
        // C3：改写失败就退回原文，绝不让一个器官的格式化 bug 吃掉工具结果。
        health.lastError = error instanceof Error ? error.message : String(error)
        ctxRef.log('warn', `rewriteToolResult 异常，已退回原文：${health.lastError}`)
        return null
      }
    },

    /**
     * 运行时补丁钩子（v0.9.11）。曾经漏接这一条——器官装得上、声明读得到，
     * 就是 hook 永远不被调用，而没有任何报错提示（静默缝隙最伤作者）。
     * 错误隔离与 rewriteToolResult 同一条规矩：补丁抛错返回 pass，绝不吃掉原调用。
     */
    async hook(input) {
      if (!def.hook) return null
      try {
        const verdict = await def.hook(input, config)
        return verdict ?? null
      } catch (error) {
        health.lastError = error instanceof Error ? error.message : String(error)
        // 补丁器官的错误止步于"这次不补"：原工具调用必须照常进行。
        ctxRef?.log('warn', `hook(${input?.tool}/${input?.phase}) 异常，按放行处理：${health.lastError}`)
        return { kind: 'pass' }
      }
    },

    async onUnload() {
      health.status = 'unloaded'
      ctxRef = null
      await def.onUnload?.(config)
    },

    health() {
      return { ...health }
    },
  }
}
