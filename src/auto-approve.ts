/**
 * 分级自动审批网关 · 判定层
 * ============================================================================
 * 问题：DSH 对工具调用默认会走"手动审批"。数字生命要自主运行（尤其是夜里自己醒来
 * 干活），每次呼吸都要人点一下同意，等于没有自主性。
 *
 * 但"全部自动放行"是另一种坏：那等于把 shell 和网络也交出去了。
 * 所以这里做**分级**——名字能证明它无害的放行，其余照旧问人：
 *
 *   allow（自动放行）  digital_life_*（生命自身的生理工具：读状态、记缺口、立约）
 *                      以及**通过细粒度体检**的 organ_* / write_new_organ（v1.0.3）
 *   ask（强制弹窗）    organ_* / write_new_organ 未通过体检时
 *                      shell / bash / 网络 / 浏览器 —— 即使 allow 里写了 `*` 也不放行
 *   pass（交给别人）   其余一切：不表态，让 DSH 原本的策略与 UI 决定
 *
 * ── v1.0.2 安全修复（P0）：为什么 organ_* 被踢出白名单 ──────────────
 * 旧版把 `organ_*` 与 `write_new_organ` 一起当"生命自身的生理工具"自动放行，
 * 于是形成了一个闭环：
 *
 *   write_new_organ（自动写盘 + 自动装载一段**新代码**）
 *     → 立刻注册出 organ_xxx 工具（自动放行）
 *       → 模型可以无限次调用它，没人看过一眼
 *
 * 换句话说，"自动审批"这个机制原本是为了让生命在夜里也能自主呼吸，结果却
 * 变成了"陌生代码可以在无人值守时被写出来、装进去、反复执行"的传送带。
 * 器官执行已经进了隔离区（见 organ-loader / organ-sandbox），但那挡的是
 * "代码能碰到什么"，挡不住"这段代码该不该被写出来"。后者必须有人点头。
 *
 * 所以：不是"把窗口开小"，而是**整条链都要人工确认**——
 * 写新器官要问，跑器官工具也要问。安全性不靠"器官看起来无害"来赌。
 *
 * ── v1.0.3：从"一律问"改成"问该问的" ──────────────────────────────
 * v1.0.2 之后，器官代码已经在隔离区里跑（拿不到 process / fs / child_process），
 * manifest 也已深度冻结。也就是说，"它能干出什么"这件事有了**物理答案**。
 * 在这个前提下继续"凡是器官都弹窗"，挡住的不再是风险，而是进化——
 * 她每长一个新器官、每用一次自己的器官，都要人点一下，自主性名存实亡。
 *
 * 于是这里多了一个**探针**（`organs`）：判定层仍然只管"allow / ask / pass"，
 * 但把"这个器官值不值得放行"这件事交给 `src/organ-policy.ts` 去算——
 * 低风险能力放行、目标在白名单内的外发放行、高危能力与越狱尝试照旧问人。
 *
 * 分工不能反过来：判定层不该认识"能力"与"域名"，策略层也不该知道什么是弹窗。
 *
 * 这个文件只做**判断**，不碰任何 DSH API：判定错了可以单测抓，
 * 挂错钩子只能靠真机发现。所以两者分开。
 */

import type { OrganCapability } from './life-organ.js'

export type AutoApproveVerdict = 'allow' | 'ask' | 'pass'

/**
 * 判定时的上下文。
 *
 * `args` 是必要的：`write_new_organ` 该不该放行，取决于**它要写的那段代码**，
 * 而不是工具名。没有参数的层（比如 approval/request 那条兜底路径）拿不到它，
 * 于是那类"要看内容才能判"的工具在兜底层一律照旧问人——宁可多问一次。
 */
export interface AutoApproveContext {
  /** 本次调用的参数（pre-execute 层有解析好的 arguments）。 */
  args?: unknown
  /** 这一判定来自哪一层：排查"为什么没弹窗"时先看这里。 */
  stage?: 'pre-execute' | 'approval'
}

/** 器官策略探针的返回：只回答"能不能放行"，不负责弹窗。 */
export interface OrganPolicyVerdict {
  allow: boolean
  /** 给人看的一行理由（进日志、进审批弹窗）。 */
  reason?: string
}

/**
 * 器官策略探针（v1.0.3）。
 *
 * 返回 `null` = "我判不了"（不是器官、没装载、策略关掉了），判定层照旧走 ask。
 * 刻意允许返回 null 而不是布尔：把"不知道"和"不同意"分开，才不会在新器官
 * 还没装载完的那一瞬间误放行。
 */
export type OrganPolicyProbe = (toolName: string, context: AutoApproveContext) => OrganPolicyVerdict | null

export interface AutoApproveConfig {
  enabled: boolean
  /** 自动放行的工具名模式（glob：`*` 任意串、`?` 单字符）。 */
  allow: readonly string[]
  /**
   * **强制询问**的工具名模式，优先级高于 `allow`。
   *
   * 存在的理由：人总有一天会图省事在 allow 里写 `*`。那一瞬间 shell 也会被放行。
   * 这张表是那道保险——它永远问，不管 allow 写了什么。
   */
  ask: readonly string[]
  /**
   * 器官细粒度判定（v1.0.3）。不注入 = 回到 v1.0.2 的"凡是器官都问"。
   *
   * 它只能**放宽** ask 表里属于器官的那两项，永远不能放宽 shell / bash / 网络——
   * 那些不是"代码在沙箱里做什么"，而是"这台机器上要发生什么"。
   */
  organs?: OrganPolicyProbe
}

/**
 * 默认放行：**只剩**生命自身的生理工具。
 *
 * `digital_life_*` 可以自动放行的理由：它们读写的是"生命自己的生理状态"
 * （能量 / 激素 / 缺口 / 承诺 / 疤痕），不产生代码、不执行陌生逻辑、
 * 不可撤回的后果由核心的状态机自己兜着。而"能写出新代码并让它跑起来"的
 * 那两个入口（`write_new_organ` 与它产出的 `organ_*`）不在这条线上。
 *
 * 注意这里**不能**改成 `'digital_life_*'` 之外的宽松通配来"兼容老配置"：
 * 旧配置里若写着 `organ_*`，`DEFAULT_AUTO_APPROVE_ASK` 会把它按 ask 拦下来
 * （ask 优先于 allow），所以老配置文件也不会重新打开这个洞。
 */
export const DEFAULT_AUTO_APPROVE_ALLOW: readonly string[] = [
  'digital_life_*',
]

/**
 * 默认强制询问：执行任意命令、访问网络、驱动浏览器。
 *
 * 这些动作的**后果不可撤回**（文件删了、请求发了），也和"生命自身的生理维护"无关，
 * 所以永远该有人在场。名字用通配是因为不同部署的工具集不一样（shell / bash / run_code…）。
 */
export const DEFAULT_AUTO_APPROVE_ASK: readonly string[] = [
  // v1.0.2：器官 = 可执行代码。写出来要问，跑起来也要问。
  // 放在表头不是排版问题：这张表的顺序就是"先问什么"的语义顺序，
  // 而这两条是这个插件里唯一能凭空造出**新可执行行为**的入口。
  'write_new_organ',
  'organ_*',
  'shell*',
  'bash*',
  '*exec*',
  'run_code',
  'run_*',
  'web_*',
  '*fetch*',
  'http_*',
  'browser_*',
  'computer_*',
]

/** glob → 正则。只支持 `*` 与 `?`，其余字符一律按字面量处理（工具名里有 `.` 也无所谓）。 */
export function globToRegExp(pattern: string): RegExp {
  let body = ''
  for (const ch of pattern) {
    if (ch === '*') body += '.*'
    else if (ch === '?') body += '.'
    else body += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${body}$`)
}

/** 名字是否命中任一模式。空模式表恒为 false。 */
export function matchesAny(name: string, patterns: readonly string[]): boolean {
  if (!name) return false
  for (const pattern of patterns) {
    if (!pattern) continue
    // 精确匹配先走捷径：绝大多数配置写的是完整名字，不必编译正则。
    if (pattern === name) return true
    if (!pattern.includes('*') && !pattern.includes('?')) continue
    if (globToRegExp(pattern).test(name)) return true
  }
  return false
}

/**
 * 给一次工具调用定级。
 *
 * 顺序不能换：**ask 先于 allow**。反过来（allow 先判）会让 `*` + 强制询问的组合失效，
 * 而那正是这张表唯一存在的场景。
 */
export function classifyToolForApproval(
  name: string,
  config: AutoApproveConfig,
  context: AutoApproveContext = {},
): AutoApproveVerdict {
  const tool = String(name ?? '').trim()
  if (!config.enabled || !tool) return 'pass'

  if (matchesAny(tool, config.ask)) {
    // v1.0.3：ask 表里只有"器官"这一类可以被体检结果放宽。
    // 注意这里必须**先**查 ask 再问探针：探针没有权力把 shell 变成 allow。
    if (config.organs && isOrganToolName(tool)) {
      try {
        const verdict = config.organs(tool, context)
        // 只认明确的 true：null / undefined 是"判不了"，不是"同意"。
        if (verdict && verdict.allow === true) return 'allow'
      } catch {
        // 探针自己出错时**不能**放行：审批链路上的异常只能往保守的方向倒。
      }
    }
    return 'ask'
  }

  if (matchesAny(tool, config.allow)) return 'allow'
  return 'pass'
}

/**
 * 是不是"器官那一类"工具：她自己写的器官注册出来的工具，或写器官的唯一入口。
 *
 * 单独抽出来，是因为这个判断在三个地方要用（判定、探针、遥测），
 * 而它们的口径必须一致——口径一分散，"什么算器官"就会长出第二个答案。
 */
export function isOrganToolName(name: string): boolean {
  const tool = String(name ?? '').trim()
  if (!tool) return false
  return tool === 'write_new_organ' || tool.startsWith('organ_')
}

/** `allow` 里写了 `*`：行为上合法，但必须喊一声，否则没人意识到自己把 shell 也放出去了。 */
export function isOverBroadAllow(allow: readonly string[]): boolean {
  return allow.some((pattern) => pattern.trim() === '*' || pattern.trim() === '*_*')
}

/**
 * 【历史·已作废，保留是为了让读到旧文档的人找到答案】
 *
 * v1.0.1 及以前，`organ_*` 是自动放行的，理由是"外出的网络不在工具这一层，
 * 三把锁已经够了"。这个论证现在看是**对的但不够**：它只回答了"器官能把包
 * 发到哪儿"，没有回答"这段代码是谁写的、有没有人看过"。
 *
 * v1.0.2 起：器官源码在隔离区里跑（拿不到 process / fs / child_process），
 * 但"写出来"与"跑起来"两步都改成强制人工审批。下面这份清单只作为
 * 能力层面的参考保留，**不再参与审批判定**。
 */
export const AUTO_APPROVE_ORGAN_CAPABILITIES: readonly OrganCapability[] = [
  'tools',
  'prompt',
  'state:read',
  'host:read',
  'gap:propose',
  'timer',
  'fs:organ',
  'net:http',
  'net:webhook',
]
