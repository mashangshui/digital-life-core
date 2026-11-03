/**
 * 器官隔离 · 宿主侧门面（organ-sandbox）
 * ============================================================================
 * v1.0.2 的安全底座：`organ-loader` 不再 `await import()` 陌生代码。
 * 每个自写器官装进自己的 worker_threads 隔离区，宿主手里只留一个**门面**——
 * 它长得和 `LifeOrgan` 一模一样，所以 host / index / 测试都不用改一行调用方式。
 *
 * 三条设计约束（改这个文件之前请先读）：
 *
 * 1. **宿主永远不阻塞。**
 *    器官 → 宿主的同步调用走 SharedArrayBuffer + Atomics.wait（器官等，宿主照常
 *    处理事件循环）。反过来不行：宿主一旦忙等隔离区，"器官等宿主、宿主等器官"
 *    就是死锁。所以 `getPromptContext()` 用的是**快照**，不是同步回话。
 *
 * 2. **隔离区是耗材。**
 *    超时 / 崩溃 / 内存爆掉 → terminate，器官记为 degraded，宿主继续活。
 *    这就是"隔离"在 RCE 之外的第二层意义：不只是偷不到东西，还弄不死人。
 *
 * 3. **能力闸门还在宿主。**
 *    隔离区里的 ctx 是个代理，每一次调用都回到这里，再落到 OrganHost 建的真 ctx 上；
 *    也就是说 default-deny 一行都没被绕过（`require()` 仍在 organ-host 里）。
 */

import { Worker } from 'node:worker_threads'

import {
  DEFAULT_SANDBOX_LIMITS,
  SANDBOX_PROTOCOL,
  SYNC_ERROR_KEY,
  SYNC_HEADER_BYTES,
  toPlain,
} from './organ-rpc.js'
import type {
  AsyncMethod,
  BootMessage,
  CallMethod,
  NoteMessage,
  PromptSnapshot,
  ReplyMessage,
  RequestMessage,
  SandboxFeatures,
  SandboxLimits,
  SyncMethod,
  SyncMessage,
  WorkerInit,
} from './organ-rpc.js'
import type {
  EnergyQuote,
  EnergyReceipt,
  LifeOrgan,
  OrganContext,
  OrganDisposable,
  OrganFeedback,
  OrganHookOutcome,
  OrganManifest,
  OrganPromptFragment,
  OrganStimulus,
  OrganToolResult,
  OrganToolRewrite,
} from './life-organ.js'
import { deepClone, deepFreeze } from './manifest-freeze.js'

/** 隔离区起不来 / 崩了 / 超时：统一用这个错误类型，调用方好分辨。 */
export class OrganSandboxError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OrganSandboxError'
  }
}

export interface SandboxInput {
  /** 编译后的 JS（不是 .ts）。隔离区里没有类型擦除器。 */
  code: string
  /** 源文件名，只用于报错与栈帧。 */
  filename: string
  /** ABI 模块绝对 URL（器官源码里不写 import，由隔离区注入）。 */
  abiUrl: string
  limits?: Partial<SandboxLimits>
}

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** 一个器官 = 一个隔离区 = 一个门面。 */
export class SandboxedOrgan implements LifeOrgan<unknown> {
  readonly name: string
  readonly manifest: Readonly<OrganManifest>
  readonly energy?: Readonly<EnergyQuote>
  /** 隔离区里到底有没有这些东西：没有就不挂那根线，省掉一次跨线程调用。 */
  readonly features: SandboxFeatures

  private readonly worker: Worker
  private readonly ctl: Int32Array
  private readonly payload: Uint8Array
  private readonly encoder = new TextEncoder()
  private readonly decoder = new TextDecoder()
  private readonly limits: SandboxLimits
  private readonly pending = new Map<number, PendingCall>()
  private readonly disposables = new Map<string, OrganDisposable>()
  private seq = 0
  private ctx: OrganContext | null = null
  private closed = false
  private deadReason: string | null = null
  private promptTimer: ReturnType<typeof setInterval> | null = null
  private promptSnapshotCache: PromptSnapshot = { main: null, providers: [] }
  private refreshing = false

  private constructor(
    worker: Worker,
    sab: SharedArrayBuffer,
    boot: BootMessage,
    limits: SandboxLimits,
  ) {
    this.worker = worker
    this.ctl = new Int32Array(sab, 0, 4)
    this.payload = new Uint8Array(sab, SYNC_HEADER_BYTES, limits.payloadBytes)
    this.limits = limits
    this.name = String(boot.name ?? '')
    this.manifest = deepFreeze(deepClone((boot.manifest ?? {}) as unknown as OrganManifest))
    this.energy = boot.energy ? deepFreeze(deepClone(boot.energy as EnergyQuote)) : undefined
    this.features = boot.features ?? { hook: false, rewrite: false, onUnload: false }

    worker.on('message', (message: { t?: string }) => {
      this.onMessage(message)
      // 见 relax() 的注释：端口一旦有过流量就会被 ref，必须每次之后再松开。
      this.relax()
    })
    worker.on('error', (error: Error) => this.fail(`隔离区崩溃：${error.message}`))
    worker.on('exit', (code: number) => {
      // 正常关闭（我们主动 terminate）不算异常。
      if (!this.closed) this.fail(`隔离区已退出（code=${code}）`)
    })
    // 隔离区里没实现的钩子就不要挂在门面上：OrganHost 是拿 `typeof === 'function'`
    // 决定要不要调的（改写每一条工具结果都会走一遍），留一个恒返回 null 的方法，
    // 等于给每个器官每次工具结果都加一趟跨线程往返。
    const optional = this as unknown as { rewriteToolResult?: unknown; hook?: unknown }
    if (!this.features.rewrite) optional.rewriteToolResult = undefined
    if (!this.features.hook) optional.hook = undefined

    // 启动握手就已经让端口有过流量了：这里补一次，否则"只装载、不调用"的器官
    // 会把宿主进程钉住（这条路径在 security 测试里被专门覆盖）。
    this.relax()
  }

  /** 起一个隔离区并把器官装进去。失败会抛 OrganSandboxError（调用方据此给装载错误）。 */
  static async create(input: SandboxInput): Promise<SandboxedOrgan> {
    const limits: SandboxLimits = { ...DEFAULT_SANDBOX_LIMITS, ...(input.limits ?? {}) }
    const sab = new SharedArrayBuffer(SYNC_HEADER_BYTES + limits.payloadBytes)
    const init: WorkerInit = {
      protocol: SANDBOX_PROTOCOL,
      code: input.code,
      abiUrl: input.abiUrl,
      filename: input.filename,
      limits,
      sab,
    }
    const worker = new Worker(new URL('./organ-worker.js', import.meta.url), {
      workerData: init,
      // 内存上限：狂吃内存的器官只会把自己撑死（ERR_WORKER_OUT_OF_MEMORY）。
      resourceLimits: {
        maxOldGenerationSizeMb: Math.max(16, limits.memoryMb),
        maxYoungGenerationSizeMb: 8,
        stackSizeMb: 4,
      },
      // 环境变量一个都不给：即使哪天隔离区被绕过，"读 env 拿 token"这条路也先断了。
      env: {},
      argv: [],
      execArgv: [],
      name: `organ-sandbox:${input.filename}`,
    })
    // 不让一个空闲的隔离区把宿主进程钉在事件循环上。
    worker.unref()

    const boot = await waitBoot(worker, limits.timeoutMs)
    if (!boot.ok) {
      await worker.terminate()
      throw new OrganSandboxError(boot.error ?? '隔离区装载失败')
    }
    if (boot.protocol !== SANDBOX_PROTOCOL) {
      await worker.terminate()
      throw new OrganSandboxError(`隔离区协议不匹配（${String(boot.protocol)}）`)
    }
    return new SandboxedOrgan(worker, sab, boot, limits)
  }

  // ───────────────────────── LifeOrgan 门面 ─────────────────────────

  async onLoad(ctx: OrganContext): Promise<void> {
    this.ctx = ctx
    const value = await this.call('load', {}) as { prompt?: PromptSnapshot } | null
    if (value?.prompt) this.applyPrompt(value.prompt)
    this.startPromptRefresh()
  }

  async feedback(stimulus: OrganStimulus): Promise<OrganFeedback> {
    const value = await this.call('feedback', { stimulus: toPlain(stimulus) }) as
      | { feedback?: OrganFeedback; prompt?: PromptSnapshot }
      | null
    if (value?.prompt) this.applyPrompt(value.prompt)
    return (value?.feedback ?? {}) as OrganFeedback
  }

  /**
   * 提示词片段：返回**快照**。
   *
   * 宿主组装提示词的路径是同步的（`promptText()`），跨线程同步回话会让主线程
   * 忙等——那正是死锁的入口。所以隔离区定期（以及每次 feedback 之后）把快照推上来，
   * 这里只读缓存。代价是片段最多晚 `promptRefreshMs` 注入；对"几秒前看到的东西"
   * 这种语义，1 秒的延迟远好过把宿主卡住。
   */
  getPromptContext(): OrganPromptFragment | string | null {
    return (this.promptSnapshotCache.main ?? null) as OrganPromptFragment | string | null
  }

  async rewriteToolResult(stimulus: OrganStimulus, result: OrganToolResult): Promise<OrganToolRewrite | null> {
    const out = await this.call('rewrite', { stimulus: toPlain(stimulus), result: toPlain(result) })
    return (out ?? null) as OrganToolRewrite | null
  }

  async hook(input: unknown): Promise<OrganHookOutcome | null> {
    const out = await this.call('hook', { input: toPlain(input) })
    return (out ?? null) as OrganHookOutcome | null
  }

  async onUnload(): Promise<void> {
    if (this.closed) return
    this.stopPromptRefresh()
    try {
      if (this.ctx) await this.call('unload', {}, Math.min(this.limits.timeoutMs, 3_000))
    } catch {
      /* 收尾失败不阻断卸载：隔离区本来就是要被销毁的 */
    }
    await this.dispose()
  }

  /**
   * ABI 要求同步返回。宿主侧的 ctx.consume 本来就是同步的（读内存 + 扣个数），
   * 所以这里直接落到真 ctx 上，不绕隔离区——绕过去反而会让扣费变成"稍后再说"。
   */
  consumeEnergy(amount: number, reason?: string): EnergyReceipt {
    if (!this.ctx) {
      return { requested: amount, debited: 0, remaining: 0, denied: true, tier: 'starved' }
    }
    return this.ctx.consume(amount, reason ?? this.name)
  }

  /** 关掉隔离区（装载校验失败、热替换、卸载都会走这里）。 */
  async dispose(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.stopPromptRefresh()
    for (const [, disposable] of this.disposables) {
      try {
        disposable.dispose()
      } catch {
        /* 注销失败无所谓：宿主那边的 runtime 也在拆 */
      }
    }
    this.disposables.clear()
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new OrganSandboxError(this.deadReason ?? '隔离区已关闭'))
    }
    this.pending.clear()
    try {
      await this.worker.terminate()
    } catch {
      /* 已经死了 */
    }
  }

  // ───────────────────────── 宿主 → 隔离区 ─────────────────────────

  /**
   * 松开隔离区对宿主事件循环的引用。
   *
   * 为什么要在**每次**消息之后再松一次：`worker.unref()` 只对当时的句柄生效，
   * 而 Worker 内部的 MessagePort 一旦真的收发过消息就会被重新 ref 上——于是
   * 一个"装完就没人再说话"的器官会让宿主进程永远退不出去（单测里表现为
   * 跑完不退出，生产里表现为关不掉）。这不是美观问题，是可观测的泄漏。
   */
  private relax(): void {
    // 有人在等隔离区回话时绝不能松：那时宿主的事件循环里可能**只有**这一个句柄，
    // 松手就等于让进程在"还欠着一个 await"的状态下退出（Node 会报
    // unsettled top-level await）。所以只在完全没有在飞调用时才松。
    if (this.pending.size > 0) return
    try {
      this.worker.unref()
    } catch {
      /* 已经终止了 */
    }
  }

  /** 有调用在飞 → 必须抓住事件循环，否则宿主会提前退出。 */
  private grip(): void {
    try {
      this.worker.ref()
    } catch {
      /* 已经终止了 */
    }
  }

  private call(method: CallMethod, args: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    if (this.deadReason) return Promise.reject(new OrganSandboxError(this.deadReason))
    if (this.closed) return Promise.reject(new OrganSandboxError('隔离区已关闭'))
    const id = (this.seq += 1)
    const budget = timeoutMs ?? this.limits.timeoutMs
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return
        // 到点就杀：一个死循环的器官不该把整条生命拖住。
        reject(new OrganSandboxError(`器官调用超时（${method}，${budget}ms）`))
        void this.fail(`器官调用超时（${method}）`)
        this.relax()
      }, budget)
      ;(timer as { unref?: () => void }).unref?.()
      // 先抓住事件循环：从这一刻到结果回来，宿主可能没有别的活干。
      this.grip()
      this.pending.set(id, { resolve, reject, timer })
      this.worker.postMessage({ t: 'call', id, method, args })
    })
  }

  private decode(value: unknown): unknown {
    return value ?? null
  }

  private onMessage(message: { t?: string }): void {
    if (!message || typeof message !== 'object') return
    switch (message.t) {
      case 'res': {
        const result = message as ReplyMessage
        const slot = this.pending.get(result.id)
        if (!slot) return
        this.pending.delete(result.id)
        clearTimeout(slot.timer)
        if (result.ok) slot.resolve(this.decode(result.value))
        else slot.reject(new OrganSandboxError(result.error ?? '隔离区调用失败'))
        this.relax()
        return
      }
      case 'sync': {
        this.handleSync(message as SyncMessage)
        return
      }
      case 'req': {
        void this.handleRequest(message as RequestMessage)
        return
      }
      case 'note': {
        this.handleNote(message as NoteMessage)
        return
      }
      default:
    }
  }

  // ───────────────────── 同步通道（隔离区阻塞等我们）─────────────────────

  /**
   * 必须**同步写完**：隔离区此刻正卡在 Atomics.wait 上，我们一 await，
   * 它就等到超时。这张表里只许放同步、短、不重入隔离区的实现。
   */
  private handleSync(message: SyncMessage): void {
    let envelope: Record<string, unknown>
    try {
      const value = this.runSync(message.method, message.args ?? {})
      envelope = { value: value === undefined ? null : value }
    } catch (error) {
      envelope = { [SYNC_ERROR_KEY]: error instanceof Error ? error.message : String(error) }
    }
    this.writeSync(message.id, envelope)
  }

  private writeSync(id: number, envelope: Record<string, unknown>): void {
    let bytes = this.encoder.encode(JSON.stringify(envelope))
    if (bytes.length > this.payload.length) {
      // 超限时退回一条**小**错误：绝不能让隔离区读到半截 JSON。
      bytes = this.encoder.encode(JSON.stringify({
        [SYNC_ERROR_KEY]: `返回值超过隔离通道上限（${this.payload.length} 字节），请拆分后再取`,
      }))
    }
    this.payload.set(bytes)
    Atomics.store(this.ctl, 2, bytes.length)
    Atomics.store(this.ctl, 1, id)
    Atomics.store(this.ctl, 0, 1)
    Atomics.notify(this.ctl, 0, 1)
  }

  private runSync(method: SyncMethod, args: Record<string, unknown>): unknown {
    const ctx = this.ctx
    if (!ctx) throw new OrganSandboxError('器官尚未装载（ctx 还没建立）')
    switch (method) {
      case 'state':
        return toPlain(ctx.state)
      case 'hostMetrics':
        return toPlain(ctx.hostMetrics)
      case 'consume':
        return ctx.consume(Number(args.amount ?? 0) || 0, args.reason ? String(args.reason) : undefined)
      case 'proposeGap':
        return ctx.proposeGap(String(args.summary ?? ''), typeof args.weight === 'number' ? args.weight : undefined)
      case 'kvGet': {
        const key = String(args.key ?? '')
        const value = ctx.kv.get(key)
        return { found: value !== undefined, value: toPlain(value) }
      }
      case 'kvSet':
        ctx.kv.set(String(args.key ?? ''), args.value)
        return null
      case 'kvDelete':
        ctx.kv.delete(String(args.key ?? ''))
        return null
      case 'registerTool':
        return this.registerToolFromIsolate(args)
      case 'onTick':
        return this.scheduleFromIsolate(args)
      case 'onToolResult':
        return this.subscribeFromIsolate(args)
      case 'onPrompt':
        return this.providerFromIsolate(args)
      case 'netCanReach':
        return ctx.net.canReach(String(args.url ?? ''), args.method === 'GET' ? 'GET' : 'POST')
      default:
        throw new OrganSandboxError(`未知的同步调用：${String(method)}`)
    }
  }

  // ───────────────────── 异步通道（隔离区 → 宿主）─────────────────────

  private async handleRequest(message: RequestMessage): Promise<void> {
    const ctx = this.ctx
    try {
      if (!ctx) throw new OrganSandboxError('器官尚未装载（ctx 还没建立）')
      const value = await this.runAsync(message.method, message.args ?? {}, ctx)
      this.worker.postMessage({ t: 'reply', id: message.id, ok: true, value: toPlain(value) })
    } catch (error) {
      this.worker.postMessage({
        t: 'reply',
        id: message.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private async runAsync(method: AsyncMethod, args: Record<string, unknown>, ctx: OrganContext): Promise<unknown> {
    switch (method) {
      case 'callTool':
        return ctx.callTool(String(args.name ?? ''), (args.args ?? {}) as Record<string, unknown>)
      case 'inflict':
        return ctx.inflict(
          args.idOrPatch as string | Record<string, number>,
          typeof args.delta === 'number' ? args.delta : undefined,
          args.reason ? String(args.reason) : undefined,
        )
      case 'netRequest':
        return ctx.net.request((args.request ?? {}) as never)
      case 'netPost': {
        // 参数个数在隔离区就定下来了：这里原样展开，规则仍只有 net.post 那一份。
        const argv = Array.isArray(args.args) ? (args.args as unknown[]) : []
        return (ctx.net.post as (...rest: unknown[]) => unknown)(...argv)
      }
      default:
        throw new OrganSandboxError(`未知的异步调用：${String(method)}`)
    }
  }

  // ───────────────────── 句柄：工具 / 定时器 / 订阅 / 提示词 ─────────────────────

  private registerToolFromIsolate(args: Record<string, unknown>): boolean {
    const ctx = this.ctx
    if (!ctx) throw new OrganSandboxError('器官尚未装载')
    const id = String(args.id ?? '')
    const disposable = ctx.registerTool({
      name: String(args.name ?? ''),
      description: String(args.description ?? ''),
      parameters: (args.parameters ?? {}) as Record<string, unknown>,
      // 工具跑在哪？跑在隔离区里。宿主只负责把参数递进去、把结果带回来。
      execute: async (toolArgs: Record<string, unknown>) => {
        const out = await this.call('execTool', { id, args: toPlain(toolArgs) })
        if (out === null || out === undefined) throw new Error('工具没有返回值')
        return out
      },
    })
    this.disposables.set(id, disposable)
    return true
  }

  private scheduleFromIsolate(args: Record<string, unknown>): boolean {
    const ctx = this.ctx
    if (!ctx) throw new OrganSandboxError('器官尚未装载')
    const id = String(args.id ?? '')
    const disposable = ctx.onTick(Number(args.everyMs ?? 0) || 1_000, () => {
      void this.call('tick', { id }).catch((error) => {
        this.deadReason = this.deadReason ?? (error instanceof Error ? error.message : String(error))
      })
    })
    this.disposables.set(id, disposable)
    return true
  }

  private subscribeFromIsolate(args: Record<string, unknown>): boolean {
    const ctx = this.ctx
    if (!ctx) throw new OrganSandboxError('器官尚未装载')
    const id = String(args.id ?? '')
    const names = Array.isArray(args.names) ? (args.names as string[]).map(String) : []
    const disposable = ctx.onToolResult(names, (result) => {
      void this.call('toolResult', { id, result: toPlain(result) })
    })
    this.disposables.set(id, disposable)
    return true
  }

  private providerFromIsolate(args: Record<string, unknown>): boolean {
    const ctx = this.ctx
    if (!ctx) throw new OrganSandboxError('器官尚未装载')
    const id = String(args.id ?? '')
    // 推模式在这里变成拉快照：provider 只读缓存，绝不跨线程同步。
    const disposable = ctx.onPrompt(() => {
      const hit = this.promptSnapshotCache.providers.find((item) => item.id === id)
      return (hit?.fragment ?? null) as OrganPromptFragment | string | null
    })
    this.disposables.set(id, disposable)
    return true
  }

  private handleNote(message: NoteMessage): void {
    const payload = (message.payload ?? {}) as Record<string, unknown>
    switch (message.kind) {
      case 'log': {
        const level = payload.level === 'error' || payload.level === 'warn' || payload.level === 'debug'
          ? payload.level
          : 'info'
        try {
          this.ctx?.log(level as 'debug' | 'info' | 'warn' | 'error', String(payload.message ?? ''))
        } catch {
          /* 日志失败不致命 */
        }
        return
      }
      case 'emit': {
        try {
          this.ctx?.emit(payload.stimulus as never)
        } catch {
          /* 同上 */
        }
        return
      }
      case 'unregister': {
        const id = String(payload.id ?? '')
        const disposable = this.disposables.get(id)
        if (!disposable) return
        this.disposables.delete(id)
        try {
          disposable.dispose()
        } catch {
          /* 注销失败不阻断 */
        }
        return
      }
      default:
    }
  }

  // ───────────────────── 提示词快照 ─────────────────────

  private applyPrompt(snapshot: PromptSnapshot): void {
    this.promptSnapshotCache = {
      main: snapshot.main ?? null,
      providers: Array.isArray(snapshot.providers) ? snapshot.providers : [],
    }
    // 整份空的、又没声明 prompt 能力 → 这个器官不产出提示词，别再每秒问一次。
    const declared = Array.isArray(this.manifest.capabilities)
      && (this.manifest.capabilities as readonly string[]).includes('prompt')
    if (!declared && this.promptSnapshotCache.main === null && this.promptSnapshotCache.providers.length === 0) {
      this.stopPromptRefresh()
    }
  }

  private startPromptRefresh(): void {
    this.stopPromptRefresh()
    const every = Math.max(200, this.limits.promptRefreshMs)
    this.promptTimer = setInterval(() => {
      if (this.refreshing || this.closed || this.deadReason) return
      this.refreshing = true
      void this.call('prompt', {})
        .then((value) => {
          if (value) this.applyPrompt(value as PromptSnapshot)
        })
        .catch(() => {
          /* 刷新失败：保留上一份快照，下一次再来 */
        })
        .finally(() => {
          this.refreshing = false
        })
    }, every)
    ;(this.promptTimer as { unref?: () => void }).unref?.()
  }

  private stopPromptRefresh(): void {
    if (!this.promptTimer) return
    clearInterval(this.promptTimer)
    this.promptTimer = null
  }

  // ───────────────────── 生命周期 ─────────────────────

  private fail(reason: string): void {
    if (this.deadReason) return
    this.deadReason = reason
    this.stopPromptRefresh()
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new OrganSandboxError(reason))
    }
    this.pending.clear()
    this.closed = true
    void this.worker.terminate().catch(() => undefined)
  }
}

// ─────────────────────────── 工具函数 ───────────────────────────

export { deepClone, deepFreeze }

/**
 * 等隔离区回报启动结果。
 *
 * 必须带超时：顶层写死循环的器官永远不会回话，而 `create()` 是装载路径上的
 * await——没有超时的话，一次"写了坏器官"就变成一次"宿主启动卡死"。
 */
function waitBoot(worker: Worker, timeoutMs: number): Promise<BootMessage> {
  return new Promise<BootMessage>((resolve, reject) => {
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      worker.off('message', onMessage)
      fn()
    }
    const timer = setTimeout(() => {
      finish(() => {
        void worker.terminate().catch(() => undefined)
        reject(new OrganSandboxError(`隔离区启动超时（${timeoutMs}ms）`))
      })
    }, timeoutMs)
    ;(timer as { unref?: () => void }).unref?.()

    const onMessage = (message: unknown): void => {
      const boot = message as BootMessage
      if (!boot || boot.t !== 'boot') return
      finish(() => resolve(boot))
    }
    worker.on('message', onMessage)
    worker.once('error', (error: Error) => {
      finish(() => reject(new OrganSandboxError(`隔离区启动失败：${error.message}`)))
    })
    worker.once('exit', (code: number) => {
      finish(() => reject(new OrganSandboxError(`隔离区在启动前退出（code=${code}）`)))
    })
  })
}
