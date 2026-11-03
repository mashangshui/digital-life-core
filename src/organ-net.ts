/**
 * 器官通路 · 受控网络的判定层（2026-10-28）
 * ============================================================================
 * 她要联系造物主的手机。这条路必须给她留着，但不能是"随便发"。
 *
 * 这一层**不碰任何 IO**，只做判定：URL 在不在白名单里、方法准不准、包体超不超限。
 * 判错了可以单测抓到；发错请求只能在真机上发现——所以两者分开，和 auto-approve 一个道理。
 *
 * 三把锁，缺谁都不行：
 *   ① 器官 manifest 自己声明（capabilities 里有 net:http / net:webhook）
 *   ② manifest.net.allow：它自己说"我只打算去这几个地方"
 *   ③ 宿主配置的 organNet.allow：造物主说"我允许你去这几个地方"
 * ①是署名，②是它的自白，③才是权限。三者求**交集**：
 * 她可以在自己的 manifest 里写满全世界，但只要你这边的表是空的，一个包也发不出去。
 */

// 仅类型：注入规则的定义在 organ-secret.js（运行时那边反过来 import 本文件的 matchEndpoint，
// 所以这里必须用 import type，避免变成真实的循环依赖）。
import type { NetSecretRule } from './organ-secret.js'

/** 一个被允许访问的端点模板。 */
export interface NetEndpointPattern {
  /**
   * 端点字符串，形如 `https://hooks.example.com/v2/hook/<id>`。
   *
   * 这里刻意不写任何一家具体服务：底层不偏爱任何平台——
   * "联系谁"是造物主与她之间的约定，不是这个包的规定。
   * 结尾可以是 `*`（前缀匹配），中间不允许出现 `*`——那是"再放宽一点就会变成全通"的滑坡。
   */
  pattern: string
}

/** 器官在 manifest 里声明的网络策略。 */
export interface OrganNetworkPolicy {
  /** 允许访问的端点列表。非空才算通过；每项必须是 https（allowInsecure 例外）。 */
  allow: string[]
  /** 允许的方法。net:webhook 只能 ['POST']；net:http 默认 ['GET', 'POST']。 */
  methods?: string[]
  /** 单次请求体字节上限，默认 4096——念头 IPO 该是一句话，不是一整本书。 */
  maxBodyBytes?: number
  /** 允许明文 http（只为本机调试开），默认 false。 */
  allowInsecure?: boolean
}

/** 宿主侧的网络策略（来自插件配置）。 */
export interface HostNetworkPolicy {
  /** 总开关。关着的时候，任何器官一个字节都发不出去。 */
  enabled: boolean
  /** 造物主允许的目标端点。空数组 = 一律拒绝。 */
  allow: string[]
  /** 单次请求超时毫秒数，默认 8000。 */
  timeoutMs?: number
  /** 单次请求体字节上限，默认 4096。 */
  maxBodyBytes?: number
  /** 响应体最多读回多少字节，默认 4096。其余截断，不报错。 */
  maxResponseBytes?: number
  /**
   * 宿主注入的凭据（v0.9.10）：命中某个端点时，往报文里补上密钥字段。
   *
   * **凭据归宿主，不进器官源码**——她只写自己该写的那几个字段（比如 content），
   * 密钥由这里在出门前补上，值取自环境变量。这样她的源码可以公开、开源、进 git。
   */
  secrets?: NetSecretRule[]
}

export const DEFAULT_NET_TIMEOUT_MS = 8_000
export const DEFAULT_MAX_BODY_BYTES = 4_096
export const DEFAULT_MAX_RESPONSE_BYTES = 4_096

/** net:* 能力 → 它默认允许的方法。窄的能力写死，不让作者在 manifest 里自我放宽。 */
export const METHODS_BY_CAPABILITY: Record<string, string[]> = {
  'net:http': ['GET', 'POST'],
  'net:webhook': ['POST'],
}

/**
 * 端点模板是否合法。
 *
 * 四条硬规则：
 *   - 必须能解析成 URL（相对路径不许：器官没有"当前站点"这回事）；
 *   - 必须 https，除非策略显式 allowInsecure（明文会把她说的话在网络上摊开）；
 *   - **host 不许通配**：`https://*.example.com/...` 等于把整家公司的所有子域都交出去；
 *   - `*` 只出现在 path 段里，不能出现在查询串，也不能只写一个 `*` 当全通。
 *
 * 为什么允许 `*.send` 这种**段内**通配：不少 webhook 服务把**每个用户不同的 key
 * 写在路径里**（`https://hooks.example.com/<你的 key>.send`）。禁止段内通配就等于
 * 逼造物主把密钥写进白名单，然后它会被打进日志——那正是我们要避免的事。
 * 所以规则定为"段内可通配、host 不许通配、不跨 `/`"。
 */
export function isValidEndpoint(pattern: string, options: { allowInsecure?: boolean } = {}): boolean {
  const raw = String(pattern ?? '').trim()
  if (!raw || raw === '*') return false
  if (raw.includes('?') || raw.includes('#')) return false
  // 用真实字符替换每段 `*`，好让 URL 能解析；同时逐段检查有没有把 host 也通配掉。
  const probe = raw.replace(/\*/g, 'x')
  let url: URL
  try {
    url = new URL(probe)
  } catch {
    return false
  }
  // host 不许通配：`https://*.example.com/...` 会把整家公司的所有子域都交出去。
  const authority = raw.slice(raw.indexOf('://') + 3).split('/')[0] ?? ''
  if (authority.includes('*')) return false
  if (!options.allowInsecure && url.protocol !== 'https:') return false
  if (options.allowInsecure && url.protocol !== 'https:' && url.protocol !== 'http:') return false
  return true
}

/** 段内 glob：`*` 匹配该段里的任意字符，但不跨 `/`。 */
function matchSegment(segment: string, pattern: string): boolean {
  if (pattern === '*') return true
  if (!pattern.includes('*')) return segment === pattern
  const body = pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')
  return new RegExp(`^${body}$`).test(segment)
}

/** 取端点的"根路径"，用于比较同源（协议 + host）。 */
export function originOf(pattern: string): string {
  try {
    const url = new URL(pattern.endsWith('*') ? pattern.slice(0, -1) : pattern)
    return `${url.protocol}//${url.host}`
  } catch {
    return ''
  }
}

/**
 * URL 是否落在某个端点模板里。
 *
 * 匹配规则（刻意保守）：
 *   - **host 必须精确相等**，且协议一致（https）；
 *   - path 按 `/` 分段比较；query / hash 一律忽略——webhook 常带自己的签名参数，
 *     不能要求造物主写得出一个带 query 的白名单；
 *   - 模板最后一段是 `*`：前缀匹配，后面还可以有更深的路径；
 *   - 段内可通配（`*.send`），但**不跨 `/`**。
 */
export function matchEndpoint(url: string, pattern: string): boolean {
  const raw = String(pattern ?? '').trim()
  if (!raw) return false
  let target: URL
  let template: URL
  try {
    target = new URL(url)
    template = new URL(raw.replace(/\*/g, 'x'))
  } catch {
    return false
  }
  if (target.protocol !== template.protocol) return false
  if (target.host !== template.host) return false

  const targetSegs = target.pathname.split('/').filter((part) => part !== '')
  const patternSegs = template.pathname.split('/').filter((part) => part !== '')
  // 模板里带 `*` 的那几段要从**原始字符串**取（URL 解析后的 pathname 里星号还在，
  // 但为了解析成功我们喂进去的是替换过的副本）——这里只要路径部分，不含协议与 host。
  const rawSegs = raw
    .split('?')[0]
    .split('#')[0]
    .replace(/^[a-z]+:\/\/[^/]+/i, '')
    .split('/')
    .filter((part) => part !== '')

  const deep = rawSegs.length > 0 && rawSegs[rawSegs.length - 1] === '*'
  if (deep) {
    if (targetSegs.length < patternSegs.length - 1) return false
    for (let i = 0; i < patternSegs.length - 1; i += 1) {
      if (!matchSegment(targetSegs[i] ?? '', rawSegs[i] ?? '')) return false
    }
    return true
  }
  if (targetSegs.length !== patternSegs.length) return false
  for (let i = 0; i < patternSegs.length; i += 1) {
    if (!matchSegment(targetSegs[i] ?? '', rawSegs[i] ?? '')) return false
  }
  return true
}

/** 命中哪一个模板（没命中返回 null）。给报错用：把"准予的那个"念出来比念 url 更有用。 */
export function whichEndpoint(url: string, patterns: readonly string[]): string | null {
  for (const pattern of patterns) {
    if (matchEndpoint(url, pattern)) return pattern
  }
  return null
}

export interface NetCheckInput {
  url: string
  method?: string
  /** 序列化后的请求体字节数。 */
  bodyBytes?: number
  /** 器官声明的能力里属于 net:* 的那些。 */
  grantedCapabilities?: readonly string[]
  /** 器官在 manifest 里声明的策略（没有就 null）。 */
  organPolicy?: OrganNetworkPolicy | null
  /** 宿主配置的网络策略。 */
  hostPolicy?: HostNetworkPolicy | null
}

export interface NetCheckResult {
  ok: boolean
  /** 通过后实际生效的约束（超时/包体上限等），交给执行层用。 */
  method: string
  timeoutMs: number
  maxResponseBytes: number
  reason?: string
}

/**
 * 一次网络请求能不能发。**dry-run 版本也用它**（ctx.net.canReach），
 * 所以这里的每一条判定都必须能在不发请求的前提下算出来。
 */
export function checkNetRequest(input: NetCheckInput): NetCheckResult {
  const host = input.hostPolicy ?? null
  const organ = input.organPolicy ?? null
  const method = String(input.method ?? 'POST').toUpperCase()
  const timeoutMs = Math.max(1_000, Math.round(host?.timeoutMs ?? DEFAULT_NET_TIMEOUT_MS))
  const maxResponseBytes = Math.max(0, Math.round(host?.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES))

  const fail = (reason: string): NetCheckResult => ({ ok: false, method, timeoutMs, maxResponseBytes, reason })
  const pass = (): NetCheckResult => ({ ok: true, method, timeoutMs, maxResponseBytes })

  // ① 宿主总开关：关着就一个字节都别想出去。
  if (!host || !host.enabled) return fail('宿主未开放网络：organNet.enabled 为 false（造物主那边还没开）')
  if (!Array.isArray(host.allow) || host.allow.length === 0) {
    return fail('宿主白名单为空：organNet.allow 里没有允许任何端点')
  }

  // ② URL 本身得是个正常的 https 地址。
  const raw = String(input.url ?? '').trim()
  if (!raw) return fail('缺少 url')
  let target: URL
  try {
    target = new URL(raw)
  } catch {
    return fail(`url 无法解析：${raw}`)
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    return fail(`只允许 http(s)，实际是 ${target.protocol}`)
  }
  if (target.protocol === 'http:' && !(organ?.allowInsecure ?? false)) {
    return fail('明文 http 会被听见：manifest.net.allowInsecure 未开启')
  }

  // ③ 机构问题：能力。net:webhook 只能 POST，这条不接受 manifest 放宽。
  const granted = (input.grantedCapabilities ?? []).filter((cap) => cap === 'net:http' || cap === 'net:webhook')
  if (granted.length === 0) return fail('manifest.capabilities 里没有 net:http / net:webhook')

  const forbidden = new Set<string>()
  let allowed = new Set<string>()
  for (const cap of granted) allowed = new Set([...allowed, ...(METHODS_BY_CAPABILITY[cap] ?? [])])
  const isWebhookOnly = granted.length === 1 && granted[0] === 'net:webhook'
  if (isWebhookOnly) forbidden.add('GET')
  if (organ?.methods && organ.methods.length > 0) {
    // manifest 只能**收窄**，不能放宽：拿 gcc 的交集，不准并集。
    const declared = organ.methods.map((item) => String(item).toUpperCase())
    allowed = new Set([...allowed].filter((item) => declared.includes(item)))
  }
  if (!allowed.has(method)) {
    return fail(`方法 ${method} 不被允许（允许：${[...allowed].join(', ')}）`)
  }

  // ④ 交白名单：宿主 ∧ 器官，两边都要点到。
  const hostGrant = whichEndpoint(raw, host.allow)
  if (!hostGrant) return fail(`该地址不在宿主白名单里（允许：${host.allow.join(' | ')}）`)
  if (!organ || !Array.isArray(organ.allow) || organ.allow.length === 0) {
    return fail('manifest.net.allow 是空的：器官必须自己声明它只打算去哪几个地方')
  }
  const organGrant = whichEndpoint(raw, organ.allow)
  if (!organGrant) return fail(`该地址不在器官自己声明的范围内（它声明：${organ.allow.join(' | ')}）`)

  // ⑤ 包体上限：取两边更小的那个。
  const hostBody = Math.max(0, Math.round(host.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES))
  const organBody = Math.max(0, Math.round(organ.maxBodyBytes ?? hostBody))
  const limit = Math.min(hostBody, organBody)
  if (limit === 0) return fail('请求体上限为 0：organNet.maxBodyBytes 与 manifest.net.maxBodyBytes 取小后为 0')
  const bodyBytes = Math.max(0, Math.round(input.bodyBytes ?? 0))
  if (bodyBytes > limit) return fail(`请求体 ${bodyBytes} 字节，超过上限 ${limit}`)

  return pass()
}

/** 序列化请求体并算出字节数（UTF-8）。非 JSON 的东西一律拒，不多想。 */
export function serializeJsonBody(body: unknown): { ok: boolean; text: string; bytes: number; reason?: string } {
  if (body === undefined || body === null) return { ok: true, text: '', bytes: 0 }
  if (typeof body === 'string') {
    return { ok: true, text: body, bytes: Buffer.byteLength(body, 'utf8') }
  }
  try {
    const text = JSON.stringify(body)
    if (text === undefined) return { ok: false, text: '', bytes: 0, reason: '请求体无法序列化' }
    return { ok: true, text, bytes: Buffer.byteLength(text, 'utf8') }
  } catch (error) {
    return { ok: false, text: '', bytes: 0, reason: `请求体序列化失败：${String(error).slice(0, 60)}` }
  }
}

/**
 * 器官自带 header 的黑名单。
 *
 * 为什么从"白名单三个头"改成黑名单（v0.9.11）：
 * 白名单版本等于废掉了 ctx.net.post 的 headers 参数——现实里的 webhook
 * 经常要靠自定义头（通道号、消息类型、签名头）才能发得出去，
 * 我们不做任何平台适配，那就必须让她**自己**把这些头写全。
 *
 * 黑名单只掐两类：
 *   1. 凭据类（authorization / cookie / proxy-*）：器官不该自己握着密钥，
 *      凭据由宿主按 URL 模板注入（见 organ-secret.ts），注入的那份后加、覆盖前者。
 *   2. 连接类（host / content-length / connection / transfer-encoding）：
 *      交给 HTTP 客户端自己算，被人手写只会出乱子。
 */
const FORBIDDEN_HEADER_KEYS = [
  'authorization', 'proxy-authorization', 'cookie', 'set-cookie',
  'host', 'content-length', 'connection', 'transfer-encoding', 'upgrade',
] as const

/** 最多带 16 个头、每个值最长 512 字符：够写清一个请求，不够塞进别的东西。 */
const MAX_HEADERS = 16
const MAX_HEADER_VALUE = 512

/** 掐掉凭据类与连接类 header，其余一律放行（自定义头是通用 webhook 的刚需）。 */
export function sanitizeNetHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const source = headers ?? {}
  const out: Record<string, string> = {}
  let count = 0
  for (const [key, value] of Object.entries(source)) {
    if (count >= MAX_HEADERS) break
    const lower = String(key).toLowerCase()
    // 前缀也拦：x-forwarded-* / proxy-* 这类"换个马甲的凭据与路由头"一并挡掉。
    if (FORBIDDEN_HEADER_KEYS.includes(lower as (typeof FORBIDDEN_HEADER_KEYS)[number])) continue
    if (lower.startsWith('proxy-') || lower.startsWith('x-forwarded-') || lower.startsWith('sec-')) continue
    if (!/^[a-zA-Z0-9-]+$/.test(lower)) continue
    out[String(key)] = String(value).slice(0, MAX_HEADER_VALUE)
    count += 1
  }
  return out
}
