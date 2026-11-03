/**
 * 器官隔离区 · 入口（organ-worker）
 * ============================================================================
 * 这个文件**只在 worker_threads 里跑**，永远不会被 import 进主进程。
 *
 * 它做四件事，顺序不能换：
 *   1. **先把自己关起来**：注册一个解析钩子，deny 掉除 data: 与 ABI 之外的一切
 *      模块说明符。`import('node:fs')` 从此在隔离区里是一条死路——无论它来自
 *      谁的代码，也无论那行代码是不是用 `Function` 构造出来的；
 *   2. **再抹掉全局**：process / eval / fetch / WebSocket 一律删掉。
 *      器官拿不到环境变量，也没有第二条出门的路（出门只有 ctx.net，那把锁在宿主）；
 *   3. **最后才装载器官**：源码来自 workerData（字符串，不落盘、不进主进程），
 *      用 data: URL 装成真正的 ES 模块（这样 `export default` 的语义还在）；
 *   4. 用一套**代理 ctx** 把器官的感知与手脚接到宿主：同步的走 Atomics，
 *      异步的走消息。器官代码本身一行都不用改。
 *
 * 为什么用「删全局 + 解析钩子」而不是只做关键词扫描：
 *   关键词扫描能挡住手滑，挡不住"知道自己在干什么"的代码。真正的边界必须由
 *   V8/Node 的机制来兜——解析钩子在模块加载层，Function 构造出来的代码也绕不过；
 *   全局删除在作用域层，`globalThis.process` 与 `Function('return process')` 同时失效。
 *   两层都不依赖正则写得够不够聪明。
 */

import { register } from 'node:module'
import { parentPort, workerData } from 'node:worker_threads'

import { SANDBOX_PROTOCOL, SYNC_HEADER_BYTES, SYNC_ERROR_KEY, toPlain } from './organ-rpc.js'
import type {
  CallMessage,
  PromptSnapshot,
  ReplyMessage,
  ResultMessage,
  SandboxFeatures,
  SyncMethod,
  WorkerInit,
} from './organ-rpc.js'
import { deepClone, deepFreeze } from './manifest-freeze.js'
import type {
  EnergyReceipt,
  HostMetrics,
  OrganContext,
  OrganDisposable,
  OrganNetRequest,
  OrganNetResponse,
  OrganPromptFragment,
  OrganStateView,
  OrganStimulus,
  OrganToolResult,
  OrganToolSpec,
} from './life-organ.js'

const port = parentPort
if (!port) {
  // 被当成普通脚本跑了：什么都不做。宁可安静退出，也不要在这里抛栈。
  throw new Error('[organ-worker] 本文件只能在 worker_threads 中运行')
}

const init = workerData as WorkerInit
if (!init || init.protocol !== SANDBOX_PROTOCOL) {
  port.postMessage({
    t: 'boot',
    ok: false,
    protocol: SANDBOX_PROTOCOL,
    error: `隔离区协议不匹配（${String(init?.protocol)} ≠ ${SANDBOX_PROTOCOL}）`,
  })
  // 协议对不上就没有继续的意义：不装载任何代码。
  process.exit(0)
}

const limits = init.limits
const ctl = new Int32Array(init.sab, 0, 4)
const payload = new Uint8Array(init.sab, SYNC_HEADER_BYTES, limits.payloadBytes)
const encoder = new TextEncoder()
const decoder = new TextDecoder()

// ───────────────────── ① 解析钩子：把模块系统关掉 ─────────────────────

/**
 * 允许被解析的说明符只有两种：
 *   · data: —— 器官模块自己（宿主用 data URL 递进来，不落盘）；
 *   · ABI 的 file: URL —— 契约层，公众源码，读它不泄露任何东西。
 *
 * 其余一律 throw。注意这个钩子对 `Function('return import(...)')()` 同样生效——
 * 那正是它比"删全局"更值得存在的地方。
 */
function installModuleDenyHook(): void {
  const allowed = [init.abiUrl]
  const source = `
const ALLOWED = new Set(${JSON.stringify(allowed)})
export async function resolve(specifier, context, nextResolve) {
  const spec = String(specifier)
  if (spec.startsWith('data:')) return nextResolve(spec, context)
  if (ALLOWED.has(spec)) return nextResolve(spec, context)
  throw new Error('[organ-sandbox] 隔离区禁止加载模块：' + spec)
}
`
  try {
    register(`data:text/javascript,${encodeURIComponent(source)}`)
  } catch (error) {
    // 装不上钩子就等于没有边界：宁可不装载，也不要在"看起来隔离"的地方跑陌生代码。
    throw new Error(`[organ-sandbox] 无法建立模块边界：${error instanceof Error ? error.message : String(error)}`)
  }
}

// ───────────────────── ② 抹掉宿主能力 ─────────────────────

/**
 * 删除而不是"覆盖成 undefined"：两者对 `typeof` 有区别，但对 `in` 也有——
 * 删掉的属性在原型链上也查不到，覆盖成 undefined 的属性还在 `Object.keys` 里。
 * 器官代码最常撞的两句是 `process.env` 与 `typeof process`，删掉之后两种写法
 * 都指向同一个答案：这里没有 process。
 */
function hardenGlobals(): string[] {
  const bag = globalThis as unknown as Record<string, unknown>
  const removed: string[] = []
  const targets = [
    'process',
    'eval',
    'fetch',
    'WebSocket',
    'XMLHttpRequest',
    'require',
    'global',
    'Buffer',
  ]
  for (const key of targets) {
    if (!(key in bag)) continue
    try {
      delete bag[key]
      if (!(key in bag)) removed.push(key)
    } catch {
      /* 不可配置的属性删不掉：退化成不可写 */
      try {
        Object.defineProperty(bag, key, { value: undefined, writable: false, configurable: false })
        removed.push(key)
      } catch {
        /* 实在关不掉也不阻断启动：解析钩子已经挡住了出门的路 */
      }
    }
  }
  return removed
}

let removedGlobals: string[] = []

// ───────────────────── 同步通道（器官 → 宿主）─────────────────────

let syncSeq = 0

/**
 * 同步调用宿主。
 *
 * 只有这一侧可以阻塞：宿主主线程永远不忙等隔离区，所以"器官等着、宿主照常
 * 处理事件循环"这个组合不会死锁。反过来就会。
 */
function syncCall<R>(method: SyncMethod, args: Record<string, unknown> = {}): R {
  if (dead) throw new Error('[organ-sandbox] 器官已卸载')
  const id = (syncSeq += 1)
  Atomics.store(ctl, 1, id)
  Atomics.store(ctl, 0, 0)
  port!.postMessage({ t: 'sync', id, method, args })
  const deadline = Date.now() + limits.timeoutMs
  for (;;) {
    const left = deadline - Date.now()
    if (left <= 0) throw new Error(`[organ-sandbox] 宿主同步调用超时（${method}）`)
    const verdict = Atomics.wait(ctl, 0, 0, left)
    if (verdict === 'timed-out') continue
    // 上一轮超时后宿主才写回来的陈旧响应：丢掉，接着等本轮。
    if (Atomics.load(ctl, 1) !== id) {
      Atomics.store(ctl, 0, 0)
      continue
    }
    break
  }
  const length = Atomics.load(ctl, 2)
  const text = decoder.decode(payload.subarray(0, length))
  Atomics.store(ctl, 0, 0)
  const parsed = JSON.parse(text) as Record<string, unknown>
  if (parsed && typeof parsed[SYNC_ERROR_KEY] === 'string') {
    throw new Error(String(parsed[SYNC_ERROR_KEY]))
  }
  return (parsed?.value ?? null) as R
}

// ───────────────────── 异步通道 ─────────────────────

let asyncSeq = 0
const pendingReplies = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()

function asyncCall<R>(method: string, args: Record<string, unknown> = {}): Promise<R> {
  if (dead) return Promise.reject(new Error('[organ-sandbox] 器官已卸载'))
  const id = (asyncSeq += 1)
  return new Promise<R>((resolve, reject) => {
    pendingReplies.set(id, { resolve: resolve as (value: unknown) => void, reject })
    port!.postMessage({ t: 'req', id, method, args })
    const timer = setTimeout(() => {
      if (!pendingReplies.has(id)) return
      pendingReplies.delete(id)
      reject(new Error(`[organ-sandbox] 宿主异步调用超时（${method}）`))
    }, limits.timeoutMs)
    // 别让等待中的请求把进程钉住。
    ;(timer as { unref?: () => void }).unref?.()
  })
}

// ───────────────────── 器官实例 ─────────────────────

type AnyOrgan = {
  name: string
  manifest: Record<string, unknown>
  energy?: Record<string, unknown>
  onLoad?: (ctx: OrganContext) => unknown
  feedback?: (stimulus: OrganStimulus) => unknown
  getPromptContext?: () => unknown
  rewriteToolResult?: (stimulus: OrganStimulus, result: OrganToolResult) => unknown
  hook?: (input: unknown) => unknown
  onUnload?: () => unknown
}

let organ: AnyOrgan | null = null
let dead = false
let loaded = false
/** 器官是否声明了 `prompt` 能力（决定"空快照"之后还要不要继续问它）。 */
let declaredPrompt = false
/** 上一次快照是否整份为空。 */
let promptBarren = false
/**
 * 冻结后的 manifest：**这**一份才是给器官看的（ctx.manifest）。
 *
 * 注意不是 `organ.manifest`——那是器官作者手里的活对象。交给器官一份它自己
 * 能改的 manifest，等于把"读到什么"的决定权还给被审计者。
 */
let organManifest: Readonly<Record<string, unknown>> = {}

const toolHandlers = new Map<string, OrganToolSpec>()
const tickHandlers = new Map<string, () => void>()
const resultHandlers = new Map<string, (result: OrganToolResult) => void>()
const promptProviders = new Map<string, () => OrganPromptFragment | string | null>()

function buildContext(manifest: Readonly<Record<string, unknown>>): OrganContext {
  return {
    manifest: manifest as OrganContext['manifest'],
    get state(): OrganStateView {
      return syncCall<OrganStateView>('state')
    },
    get hostMetrics(): HostMetrics {
      return syncCall<HostMetrics>('hostMetrics')
    },
    log(level, message) {
      port!.postMessage({
        t: 'note',
        kind: 'log',
        payload: { level, message: String(message ?? '') },
      })
    },
    consume(amount, reason): EnergyReceipt {
      return syncCall<EnergyReceipt>('consume', { amount: Number(amount) || 0, reason: reason ?? null })
    },
    emit(stimulus) {
      // 发完就走：派发是宿主的异步工作，等它等于让自己等自己。
      port!.postMessage({ t: 'note', kind: 'emit', payload: { stimulus: toPlain(stimulus) } })
    },
    proposeGap(summary, weight) {
      return syncCall<string | null>('proposeGap', { summary: String(summary ?? ''), weight: weight ?? null })
    },
    callTool(name, args) {
      return asyncCall<OrganToolResult>('callTool', { name: String(name ?? ''), args: toPlain(args) as Record<string, unknown> })
    },
    onToolResult(names, handler): OrganDisposable {
      const id = `res-${(asyncSeq += 1)}`
      resultHandlers.set(id, handler)
      syncCall<null>('onToolResult', { id, names: toPlain(names) })
      return {
        dispose: () => {
          resultHandlers.delete(id)
          port!.postMessage({ t: 'note', kind: 'unregister', payload: { kind: 'toolResult', id } })
        },
      }
    },
    onTick(everyMs, handler): OrganDisposable {
      const id = `tick-${(asyncSeq += 1)}`
      tickHandlers.set(id, handler)
      syncCall<null>('onTick', { id, everyMs: Number(everyMs) || 0 })
      return {
        dispose: () => {
          tickHandlers.delete(id)
          port!.postMessage({ t: 'note', kind: 'unregister', payload: { kind: 'tick', id } })
        },
      }
    },
    registerTool(tool): OrganDisposable {
      const id = `tool-${(asyncSeq += 1)}`
      toolHandlers.set(id, tool)
      // 注册走同步通道：宿主能当场告诉我们"重名了 / 清洗过了"，与在进程内一致。
      syncCall<boolean>('registerTool', {
        id,
        name: String(tool?.name ?? ''),
        description: String(tool?.description ?? ''),
        parameters: toPlain(tool?.parameters) ?? {},
      })
      return {
        dispose: () => {
          toolHandlers.delete(id)
          port!.postMessage({ t: 'note', kind: 'unregister', payload: { kind: 'tool', id } })
        },
      }
    },
    onPrompt(provider): OrganDisposable {
      const id = `prompt-${(asyncSeq += 1)}`
      promptProviders.set(id, provider)
      syncCall<boolean>('onPrompt', { id })
      return {
        dispose: () => {
          promptProviders.delete(id)
          port!.postMessage({ t: 'note', kind: 'unregister', payload: { kind: 'prompt', id } })
        },
      }
    },
    get kv() {
      return {
        get: <T,>(key: string): T | undefined => {
          const found = syncCall<{ found: boolean; value: unknown }>('kvGet', { key: String(key) })
          return (found && found.found ? found.value : undefined) as T | undefined
        },
        set: (key: string, value: unknown) => {
          syncCall<null>('kvSet', { key: String(key), value: toPlain(value) })
        },
        delete: (key: string) => {
          syncCall<null>('kvDelete', { key: String(key) })
        },
      }
    },
    get net() {
      return {
        request: (req: OrganNetRequest) => asyncCall<OrganNetResponse>('netRequest', { request: toPlain(req) }),
        // 重载在本侧用 arguments.length 判断，宿主那边照它的规则再判一次：
        // 两端都不猜对方的意图，规则只有一份（在 organ-host 的 net.post 里）。
        post: (...args: unknown[]) => asyncCall<OrganNetResponse>('netPost', { args: toPlain(args) }),
        canReach: (url: string, method?: 'GET' | 'POST') =>
          syncCall<boolean>('netCanReach', { url: String(url ?? ''), method: method ?? 'POST' }),
      }
    },
    inflict: (idOrPatch: string | Record<string, number>, delta?: number, reason?: string) =>
      asyncCall<Array<{ id: string; value: number | null; applied: boolean; reason?: string }>>('inflict', {
        idOrPatch: toPlain(idOrPatch),
        delta: delta ?? null,
        reason: reason ?? null,
      }),
  }
}

function pickOrgan(mod: Record<string, unknown>): AnyOrgan | null {
  const looksLikeOrgan = (value: unknown): value is AnyOrgan => {
    if (!value || typeof value !== 'object') return false
    const manifest = (value as { manifest?: { name?: unknown } }).manifest
    return !!manifest && typeof manifest.name === 'string'
  }
  for (const item of [mod.default, mod.organ]) {
    if (looksLikeOrgan(item)) return item
  }
  const factory = mod.createOrgan ?? mod.default
  if (typeof factory === 'function') {
    const built = (factory as () => unknown)()
    if (looksLikeOrgan(built)) return built
  }
  return null
}

function featuresOf(value: AnyOrgan): SandboxFeatures {
  return {
    hook: typeof value.hook === 'function',
    rewrite: typeof value.rewriteToolResult === 'function',
    onUnload: typeof value.onUnload === 'function',
  }
}

async function boot(): Promise<void> {
  try {
    installModuleDenyHook()
    removedGlobals = hardenGlobals()
    // 源码来自 workerData：不落盘、不经过主进程的 import()。
    const source = `import * as __abi from ${JSON.stringify(init.abiUrl)}\nconst { defineOrgan } = __abi\n${init.code}`
    const url = `data:text/javascript,${encodeURIComponent(source)}`
    const mod = (await import(url)) as Record<string, unknown>
    const picked = pickOrgan(mod)
    if (!picked) {
      port!.postMessage({
        t: 'boot',
        ok: false,
        protocol: SANDBOX_PROTOCOL,
        error: '模块没有导出器官：请 export default defineOrgan({...}) 或 export const organ = ...',
      })
      return
    }
    organ = picked
    const manifest = deepFreeze(deepClone((picked.manifest ?? {}) as Record<string, unknown>))
    declaredPrompt = Array.isArray(manifest.capabilities) && (manifest.capabilities as unknown[]).includes('prompt')
    organManifest = manifest
    const energy = picked.energy ? deepFreeze(deepClone(picked.energy)) : null
    port!.postMessage({
      t: 'boot',
      ok: true,
      protocol: SANDBOX_PROTOCOL,
      name: String(manifest.name ?? ''),
      manifest,
      energy,
      features: featuresOf(picked),
      // 出于排查方便，把"到底抹掉了什么"带回去；器官自己看不到这个字段。
      removed: removedGlobals,
    })
  } catch (error) {
    port!.postMessage({
      t: 'boot',
      ok: false,
      protocol: SANDBOX_PROTOCOL,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * 提示词快照。
 *
 * `force` 只在装载那一次用：让"从没产出过片段"的器官也试一次（有的器官第一次
 * 调用之后才有话说）。之后如果它一直是空的、又没声明 `prompt` 能力，就不再打扰它——
 * 否则一个"忘了写 getPromptContext"的器官会被每秒问一次，每次都在日志里留一条
 * "def.getPromptContext is not a function"。噪音会淹没真正重要的告警。
 */
function promptSnapshot(force = false): PromptSnapshot {
  if (promptBarren && !declaredPrompt && !force) return { main: null, providers: [] }
  let main: unknown = null
  try {
    main = organ?.getPromptContext ? organ.getPromptContext() : null
  } catch {
    main = null
  }
  const providers: PromptSnapshot['providers'] = []
  for (const [id, provider] of promptProviders) {
    try {
      providers.push({ id, fragment: toPlain(provider()) })
    } catch {
      providers.push({ id, fragment: null })
    }
  }
  promptBarren = (main === null || main === undefined) && providers.every((item) => item.fragment === null || item.fragment === undefined)
  return { main: toPlain(main), providers }
}

/**
 * 回宿主一次调用的结果。
 *
 * 注意方向：宿主 → 隔离区的回应叫 `reply`，隔离区 → 宿主的结果叫 `res`。
 * 两者名字不同不是洁癖——同一条消息通道里两个方向都用同一个名字时，
 * 排查"为什么调用没回来"会变成猜谜（这个 bug 在 v1.0.2 的开发中出现过）。
 */
function reply(message: Omit<ResultMessage, 't'>): void {
  port!.postMessage({ t: 'res', ...message })
}

async function handleCall(message: CallMessage): Promise<void> {
  const id = message.id
  const args = (message.args ?? {}) as Record<string, unknown>
  try {
    if (dead) {
      reply({ id, ok: false, error: '隔离区已关闭' })
      return
    }
    switch (message.method) {
      case 'load': {
        if (!organ) throw new Error('器官实例不存在')
        const ctx = buildContext(organManifest)
        await organ.onLoad?.(ctx)
        loaded = true
        reply({ id, ok: true, value: { prompt: promptSnapshot(true) } })
        return
      }
      case 'feedback': {
        if (!organ?.feedback) {
          reply({ id, ok: true, value: { feedback: {} } })
          return
        }
        const feedback = await organ.feedback((args.stimulus ?? {}) as OrganStimulus)
        reply({ id, ok: true, value: { feedback: toPlain(feedback) ?? {} } })
        return
      }
      case 'prompt': {
        reply({ id, ok: true, value: promptSnapshot() })
        return
      }
      case 'rewrite': {
        if (!organ?.rewriteToolResult) {
          reply({ id, ok: true, value: null })
          return
        }
        const out = await organ.rewriteToolResult(
          (args.stimulus ?? {}) as OrganStimulus,
          (args.result ?? {}) as OrganToolResult,
        )
        reply({ id, ok: true, value: toPlain(out) })
        return
      }
      case 'hook': {
        if (!organ?.hook) {
          reply({ id, ok: true, value: null })
          return
        }
        const out = await organ.hook(toPlain(args.input))
        reply({ id, ok: true, value: toPlain(out) })
        return
      }
      case 'unload': {
        try {
          // 先让器官自己收尾（它还可能要 kv / log），收完再关门。
          await organ?.onUnload?.()
          dead = true
        } catch (error) {
          dead = true
          reply({ id, ok: false, error: error instanceof Error ? error.message : String(error) })
          return
        }
        reply({ id, ok: true, value: null })
        return
      }
      case 'execTool': {
        const handler = toolHandlers.get(String(args.id ?? ''))
        if (!handler) throw new Error(`工具句柄已失效（${String(args.id)}）`)
        const out = await handler.execute((args.args ?? {}) as Record<string, unknown>)
        reply({ id, ok: true, value: toPlain(out) })
        return
      }
      case 'tick': {
        const handler = tickHandlers.get(String(args.id ?? ''))
        if (!handler) {
          reply({ id, ok: true, value: null })
          return
        }
        handler()
        reply({ id, ok: true, value: null })
        return
      }
      case 'toolResult': {
        const handler = resultHandlers.get(String(args.id ?? ''))
        if (!handler) {
          reply({ id, ok: true, value: null })
          return
        }
        handler((args.result ?? {}) as OrganToolResult)
        reply({ id, ok: true, value: null })
        return
      }
      default: {
        reply({ id, ok: false, error: `未知调用：${String(message.method)}` })
        return
      }
    }
  } catch (error) {
    reply({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

port.on('message', (message: { t?: string }) => {
  if (!message || typeof message !== 'object') return
  if (message.t === 'call') {
    void handleCall(message as CallMessage)
    return
  }
  if (message.t === 'reply') {
    const replyMessage = message as ReplyMessage
    const slot = pendingReplies.get(replyMessage.id)
    if (!slot) return
    pendingReplies.delete(replyMessage.id)
    if (replyMessage.ok) slot.resolve(replyMessage.value ?? null)
    else slot.reject(new Error(replyMessage.error ?? '宿主调用失败'))
  }
})

void boot()
