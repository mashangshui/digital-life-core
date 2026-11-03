/**
 * 器官通路 · 宿主注入的凭据（2026-10-28）
 * ============================================================================
 * 这条规则只有一句话：**凭据归宿主，永远不进器官的源码。**
 *
 * 为什么非得这么做：器官源码是她自己写的，会落在磁盘上（self-made 目录）、
 * 会被 git 追踪、会在我们要开源的时候被打包发布。任何写在里面的 token 都会跟着跑。
 * 而"让她自己保管密钥"这件事本身也不成立——她没有只属于自己的秘密存储空间，
 * 写在哪都等于写在明文里。
 *
 * 所以流程掉个个儿：
 *   她写    { content: '我想说的话' }
 *   宿主补  { token: '<来自环境变量>', title: '来自鱼小水的消息' }
 *   发出去  两者合并后的 JSON
 *
 * 她那一行里没有秘密，可公开、可开源、可进 git；秘密只在环境变量里活着，
 * 由宿主在**请求出门前**补上。她甚至读不到它——注入发生在 ctx.net 内部，
 * 源码里那句 post 拿不到补完的 body。
 *
 * 三条硬规矩：
 *   1. 宿主注入的字段**覆盖**器官写的同名字段（她想自己写 token 也盖不动）；
 *   2. 环境变量没配 = 直接拒绝出门，绝不带着空 token 发出去（宁可失败得难看）；
 *   3. 注入的值**永不进日志**，遥测只记键名（"注入了 token"），不记值。
 *
 * 这一层同样不碰 IO：readEnv 由外部注入，方便单测。
 */

import { matchEndpoint } from './organ-net.js'

/** 一条注入规则：命中某个端点时，往请求里补哪些字段。 */
export interface NetSecretRule {
  /**
   * 命中哪些端点，用与 `allow` 完全相同的匹配规则（host 精确、路径分段、`*` 前缀）。
   * 只有一条规则能命中也可以，多条命中时**按顺序叠加**（后者覆盖前者）。
   */
  match: string
  /**
   * 补进请求体的字段。值里可以写 `${env:VAR_NAME}`，发出时才从环境变量取。
   * **宿主字段覆盖器官字段**：她要是自己写了 token，这里的会把它的盖掉。
   */
  body?: Record<string, string>
  /**
   * 补进请求头的字段（同样支持 ${env:}）。
   * 它们是在 header 净化**之后**才补的，所以 authorization 也能用——
   * 器官自己带的那一份会被丢掉，宿主给的这份才是可信的。
   */
  headers?: Record<string, string>
  /** 只给人看的备注（不会进日志的正文，进日志的只有键名）。 */
  note?: string
}

/** 读环境变量的方式。由宿主注入，默认"读不到"。 */
export type ReadSecretEnv = (name: string) => string | undefined

/** `${env:VAR}` —— 唯一被识别的占位符写法。 */
const PLACEHOLDER = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g

/**
 * 展开一个值里的环境变量占位符。
 *
 * 找不到就明确报缺哪个变量，**不 silently 留空**——带着空 token 发出去
 * 只会换来一个看不懂的服务端错误，比在门口拦下难查得多。
 */
export function expandSecret(value: string, readEnv?: ReadSecretEnv): { ok: boolean; value: string; missing: string[] } {
  const missing: string[] = []
  const out = String(value ?? '').replace(PLACEHOLDER, (_all, name: string) => {
    const found = readEnv ? readEnv(name) : undefined
    if (found === undefined || found === '') {
      missing.push(name)
      return ''
    }
    return found
  })
  return { ok: missing.length === 0, value: out, missing }
}

export interface SecretApplyInput {
  url: string
  /** 器官自己给的请求体（对象，或 JSON 字符串）。 */
  body?: unknown
  /** 器官自己给的请求头。 */
  headers?: Record<string, string>
  /** 宿主配置的注入规则。 */
  rules?: readonly NetSecretRule[] | null
  readEnv?: ReadSecretEnv
}

export interface SecretApplyResult {
  ok: boolean
  /** 补完之后的请求体（没命中规则就是原样）。 */
  body: unknown
  /** 器官自己给的请求头，原样返回（净化在宿主那边做）。 */
  headers: Record<string, string>
  /** 宿主补进去的请求头。**绕过净化**，所以它可以带 authorization。 */
  injectedHeaders: Record<string, string>
  /** 注入了哪些 body 字段（**只记键名**）。 */
  injectedKeys: string[]
  /** 命中的规则描述（给人看）。 */
  applied: string[]
  /** 缺哪些环境变量。 */
  missing: string[]
  /** 器官自己写过、但被宿主盖掉的字段（说明她试着自己带凭据了）。 */
  overridden: string[]
  reason?: string
}

/**
 * 把命中的规则合并进请求体 / 请求头。
 *
 * 失败只发生在两种情况，都会给出人话：
 *   - 环境变量没配（该补的补不出来）；
 *   - 器官给的是一段非 JSON 字符串（没法往里塞字段）。
 */
export function applySecretRules(input: SecretApplyInput): SecretApplyResult {
  const headers = { ...(input.headers ?? {}) }
  const base: SecretApplyResult = {
    ok: true,
    body: input.body,
    headers,
    injectedHeaders: {},
    injectedKeys: [],
    applied: [],
    missing: [],
    overridden: [],
  }

  const rules = input.rules ?? []
  if (rules.length === 0) return base

  const matched = rules.filter((rule) => matchEndpoint(String(input.url ?? ''), rule.match))
  if (matched.length === 0) return base

  // 请求体：宿主得往里加东西，所以它必须是个能加的对象。
  let body: Record<string, unknown>
  if (input.body === undefined || input.body === null) {
    body = {}
  } else if (typeof input.body === 'string') {
    // 她要是写成了字符串，能解析成对象就救一下，不能就说清楚。
    try {
      const parsed = JSON.parse(input.body)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ...base, ok: false, reason: '宿主需要往请求体里注入字段，但器官给的字符串不是 JSON 对象' }
      }
      body = { ...(parsed as Record<string, unknown>) }
    } catch {
      return { ...base, ok: false, reason: '宿主需要往请求体里注入字段，但器官给的字符串不是合法 JSON' }
    }
  } else if (typeof input.body === 'object' && !Array.isArray(input.body)) {
    body = { ...(input.body as Record<string, unknown>) }
  } else {
    return { ...base, ok: false, reason: '宿主需要往请求体里注入字段，但器官给的请求体不是对象' }
  }

  const injectedKeys: string[] = []
  const overridden: string[] = []
  const missing: string[] = []
  const injectedHeaders: Record<string, string> = {}
  const applied: string[] = []

  for (const rule of matched) {
    applied.push(rule.note?.trim() || rule.match)
    for (const [key, rawValue] of Object.entries(rule.body ?? {})) {
      const expanded = expandSecret(String(rawValue), input.readEnv)
      if (!expanded.ok) {
        missing.push(...expanded.missing)
        continue
      }
      if (body[key] !== undefined) overridden.push(key)
      body[key] = expanded.value
      if (!injectedKeys.includes(key)) injectedKeys.push(key)
    }
    for (const [key, rawValue] of Object.entries(rule.headers ?? {})) {
      const expanded = expandSecret(String(rawValue), input.readEnv)
      if (!expanded.ok) {
        missing.push(...expanded.missing)
        continue
      }
      injectedHeaders[key] = expanded.value
    }
  }

  if (missing.length > 0) {
    return {
      ...base,
      ok: false,
      missing,
      reason: `宿主注入的凭据没配好：环境变量 ${[...new Set(missing)].join(' / ')} 未设置（宁可拦下，也不带空凭据出门）`,
    }
  }

  return { ...base, ok: true, body, injectedHeaders, injectedKeys, applied, overridden }
}

/**
 * 这些规则一共管着哪些字段——只给"键名"，永远不给值。
 * 用来在遥测里留一句"宿主注入了 token"，方便排障而不泄漏秘密。
 */
export function secretKeysOf(rules: readonly NetSecretRule[] | null | undefined): string[] {
  const keys = new Set<string>()
  for (const rule of rules ?? []) {
    for (const key of Object.keys(rule.body ?? {})) keys.add(key)
    for (const key of Object.keys(rule.headers ?? {})) keys.add(key)
  }
  return [...keys]
}
