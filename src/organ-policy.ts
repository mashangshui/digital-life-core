/**
 * 器官审批策略 · 细粒度判定（organ-policy）
 * ============================================================================
 * v1.0.3：把"一刀切拦截"换成"按证据分级"。
 *
 * 背景：v1.0.2 把器官执行搬进了隔离区，并冻结了 manifest。那之后，"器官代码
 * 能不能碰到宿主机器的东西"这件事已经有了**物理答案**：碰不到。于是继续用
 * "凡是器官就必须弹窗"来保护，就成了拿代价换安慰——挡住的不是风险，而是进化。
 *
 * 但"物理隔离"不等于"零风险"。真正还需要人看一眼的，只剩三类：
 *   1. 它想要的能力是**能向外说话**的（net）；而如果它要去的地址恰好就在造物主
 *      自己写的白名单里，那连这一条也不该再问——人早就表过态了；
 *   2. 它想要的能力是**能改变宿主行为**的（llm / patch:runtime）；
 *   3. 它的源码在**试图越狱**（process / eval / 动态 import …）。
 *      隔离区会拦住它，但"尝试"本身是一条情报，值得让人知道。
 *
 * 除此之外的一切（读状态、定时器、自己的 kv、提议缺口、注册工具……）都是
 * 在一个已经拿不到宿主任东西的沙箱里自我表达——自动放行。
 *
 * 这个文件是**纯函数**：没有 IO、没有时间、没有全局状态。判定错了可以单测抓，
 * 不必去真机上复现。
 */

import { whichEndpoint } from './organ-net.js'
import { scanSource } from './organ-loader.js'
import type { OrganCapability } from './life-organ.js'

/**
 * 低风险能力：自动放行。
 *
 * 判据是"最坏情况下它能改变什么"：
 *   - 只影响她自己的感知与表达（state:read / host:read / prompt / gap:propose）；
 *   - 只影响她自己的时间（timer）；
 *   - 只影响她自己的地盘（fs:organ —— 落在 organs/kv/<name>.json）；
 *   - 只影响她自己的身体（chem:write —— 造一种激素，动的是她自己的内分泌）；
 *   - 只是把自己的手接上（tools —— 工具本身还在隔离区里跑）。
 * 这些都没有"把数据送出机器"或"改变宿主判定"的出口。
 */
export const LOW_RISK_CAPABILITIES: readonly OrganCapability[] = [
  'tools',
  'prompt',
  'state:read',
  'host:read',
  'gap:propose',
  'timer',
  'fs:organ',
  'chem:write',
]

/**
 * 受控能力：只有在目标是造物主**已经写明**的地址时才自动放行。
 *
 * 为什么要单独一档：`net` 是唯一能让数据离开这台机器的能力。但"能外发"本身
 * 不是风险——风险是"发给谁"。造物主在 `organNet.allow` / `allowNetHosts` 里
 * 写下的那几个地址，就是他对此类外发的**预先表态**；器官要去的地址落在这张
 * 表里，等于他已经同意过了。
 */
export const CONTROLLED_CAPABILITIES: readonly OrganCapability[] = ['net:http', 'net:webhook']

/**
 * 高危能力：一律人工。
 *
 *   - `llm`：自开模型账，也让它可以借模型改写自己的行为准则；
 *   - `patch:runtime`：拦截工具调用（参数与结果都能改）——这不是补丁，是接管；
 *   - `net`（已废弃的笼统档）：没有目标清单，等于"能去任何地方"。
 */
export const HIGH_RISK_CAPABILITIES: readonly OrganCapability[] = ['llm', 'patch:runtime', 'net']

export type OrganPolicyTier = 'low' | 'controlled' | 'high' | 'escape'

export interface OrganPolicyInput {
  /** 器官的 manifest（可以是从隔离区拿回来的真实那一份）。 */
  manifest: { capabilities?: unknown; net?: unknown } & Record<string, unknown>
  /**
   * 源码。给了就做关键词扫描（"试图越狱"的信号）。
   *
   * 装载之后评估时可以不给：带越狱关键词的源码根本装不上，能到这一步的
   * 源码必然已经通过了扫描。这一点让"调用期判定"不必再去读一遍文件。
   */
  source?: string
  /** 宿主允许的网络目标（organNet.allow / allowNetHosts 归一后的端点模板）。 */
  netAllowPatterns?: readonly string[]
  /** 器官可以声明的能力白名单（selfMade.allowedCapabilities）。 */
  allowedCapabilities?: readonly OrganCapability[]
  /** 总闸：关掉就回到"凡是器官都问人"。 */
  autoApprove?: boolean
}

export interface OrganPolicyOutcome {
  verdict: 'allow' | 'ask'
  tier: OrganPolicyTier
  /** 给人看的一行理由：自动放行也要能说出"凭什么"。 */
  reasons: string[]
  capabilities: string[]
  /** 命中的越狱关键词（空 = 没试图越狱）。 */
  blockedKeywords: string[]
  /** 声明的网络目标，以及其中**不在**白名单里的那些。 */
  net: { declared: string[]; unknown: string[] }
}

/** 能力名 → 归一后的数组（过滤掉非字符串，去重）。 */
export function normalizeCapabilities(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    const text = String(item ?? '').trim()
    if (text && !out.includes(text)) out.push(text)
  }
  return out
}

/** 声明的网络目标（manifest.net.allow）。 */
export function declaredEndpoints(manifest: { net?: unknown }): string[] {
  const net = manifest?.net as { allow?: unknown } | undefined
  if (!net || typeof net !== 'object') return []
  if (!Array.isArray(net.allow)) return []
  return net.allow.map((item) => String(item ?? '').trim()).filter(Boolean)
}

/**
 * 判定一次器官装载 / 调用该不该自动放行。
 *
 * 顺序是刻意的：**先看"有没有想干坏事"，再看"想要什么权限"**。
 * 一个试图越狱但只声明了 state:read 的器官不该被当成低风险——它已经告诉了你
 * 它想干什么，只是没成功。
 */
export function evaluateOrganPolicy(input: OrganPolicyInput): OrganPolicyOutcome {
  const capabilities = normalizeCapabilities(input.manifest?.capabilities)
  const declared = declaredEndpoints(input.manifest ?? {})
  const blockedKeywords = input.source ? scanSource(input.source) : []
  const netAllowPatterns = input.netAllowPatterns ?? []
  const allowed = input.allowedCapabilities

  const unknown = declared.filter((endpoint) => whichEndpoint(endpoint, netAllowPatterns) === null)
  const base = {
    capabilities,
    blockedKeywords,
    net: { declared, unknown },
  }

  // ① 试图越狱：隔离区会拦住，但"它试过"这件事必须让人知道。
  if (blockedKeywords.length > 0) {
    return {
      ...base,
      verdict: 'ask',
      tier: 'escape',
      reasons: [
        `源码里有越狱尝试：${blockedKeywords.join('、')}`,
        '隔离区能拦住这次，但"它试过"值得你看一眼再决定',
      ],
    }
  }

  // ② 声明了白名单之外的能力（装载器也会拒，这里提前给出可读理由）。
  if (allowed && allowed.length > 0) {
    const illegal = capabilities.filter((cap) => !(allowed as readonly string[]).includes(cap))
    if (illegal.length > 0) {
      return {
        ...base,
        verdict: 'ask',
        tier: 'high',
        reasons: [`声明了自写器官不允许的能力：${illegal.join('、')}`],
      }
    }
  }

  // ③ 高危能力
  const high = capabilities.filter((cap) => (HIGH_RISK_CAPABILITIES as readonly string[]).includes(cap))
  if (high.length > 0) {
    return {
      ...base,
      verdict: 'ask',
      tier: 'high',
      reasons: [`包含高危能力：${high.join('、')}（会改变宿主行为，或让数据流向未知处）`],
    }
  }

  // ④ 受控能力：目标必须全部落在造物主写明的白名单里
  const needsNet = capabilities.some((cap) => (CONTROLLED_CAPABILITIES as readonly string[]).includes(cap))
  if (needsNet) {
    if (declared.length === 0) {
      return {
        ...base,
        verdict: 'ask',
        tier: 'controlled',
        reasons: ['声明了网络能力却没有写 manifest.net.allow——没有目标清单的外发不是"受控"'],
      }
    }
    if (unknown.length > 0) {
      return {
        ...base,
        verdict: 'ask',
        tier: 'controlled',
        reasons: [
          `要联系白名单之外的地址：${unknown.join('、')}`,
          `宿主当前允许：${netAllowPatterns.length > 0 ? netAllowPatterns.join('、') : '（空：一个都不许）'}`,
        ],
      }
    }
    // 全部命中：人已经为这些地址表过态了，不必再问一次。
    return {
      ...base,
      verdict: 'allow',
      tier: 'controlled',
      reasons: [`只联系已授权的地址：${declared.join('、')}`],
    }
  }

  // ⑤ 剩下的能力全在低风险档
  const unknownCaps = capabilities.filter(
    (cap) => !(LOW_RISK_CAPABILITIES as readonly string[]).includes(cap)
      && !(CONTROLLED_CAPABILITIES as readonly string[]).includes(cap),
  )
  if (unknownCaps.length > 0) {
    return {
      ...base,
      verdict: 'ask',
      tier: 'high',
      reasons: [`能力 ${unknownCaps.join('、')} 不在已知的低风险清单里（保守起见按高危处理）`],
    }
  }

  if (input.autoApprove === false) {
    return {
      ...base,
      verdict: 'ask',
      tier: 'low',
      reasons: ['细粒度自动审批已关闭（selfMade.autoApprove=false），按旧策略一律询问'],
    }
  }

  return {
    ...base,
    verdict: 'allow',
    tier: 'low',
    reasons: [`只用了低风险能力${capabilities.length > 0 ? `：${capabilities.join('、')}` : '（没有声明能力）'}`],
  }
}

/** 一行人类可读的结论：进审批弹窗的 reason，也进工具回执。 */
export function describePolicy(outcome: OrganPolicyOutcome): string {
  const head = outcome.verdict === 'allow' ? '自动放行' : '需要人工审批'
  const tier = {
    low: '低风险',
    controlled: '受控（目标在授权名单内）',
    high: '高危',
    escape: '越狱尝试',
  }[outcome.tier]
  return `${head} · ${tier}｜${outcome.reasons.join('；')}`
}

/**
 * 给审批弹窗用的**一句话**版本。
 *
 * 弹窗里的人不该读一段散文：他要在一秒内判断"这事要不要我做主"。
 * 所以只留"为什么问"和"它想干什么"。
 */
export function policyPromptReason(outcome: OrganPolicyOutcome, subject: string): string {
  const why = outcome.reasons[0] ?? '策略要求人工确认'
  return `${subject}：${why}（能力=${outcome.capabilities.join('/') || '无'}）`
}
