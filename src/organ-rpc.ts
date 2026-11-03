/**
 * 器官隔离通道 · 协议层（organ-rpc）
 * ============================================================================
 * v1.0.2 起，自写器官**不再进主进程**：源码在 worker_threads 里编译产物级的
 * 独立 V8 隔离区中运行，宿主与器官之间只剩这一份协议。
 *
 * 为什么协议要单独成文：
 *   两端（宿主 / 隔离区）必须对"能问什么"有且只有一份定义。协议写在 Worker 里，
 *   宿主就只能靠猜；写在宿主里，隔离区就会多出一份"顺手加的"接口。
 *   这一层刻意**不 import 任何东西**（连 node: 都不碰），所以两端都能安全引用它。
 *
 * 两类调用，别混：
 *   · sync  —— 器官 → 宿主，**同步**（Atomics + SharedArrayBuffer）。
 *              ABI 里那些同步成员（ctx.state / ctx.kv / ctx.consume / getPromptContext）
 *              必须同步才有意义；把它们改成 Promise 等于改写整个 ABI。
 *   · call  —— 宿主 → 器官，异步；器官 → 宿主的异步请求也走 req/res。
 *
 * 只有"器官阻塞、宿主不阻塞"这一个方向是允许阻塞的：
 * 宿主一旦阻塞（比如忙等隔离区回话），隔离区的同步调用就永远等不到人，
 * 那就成了死锁。所以宿主侧永远不阻塞——prompt 用快照，不用同步回话。
 */

/** 协议版本：宿主与隔离区对不上就直接拒绝装载，而不是"尽力跑"。 */
export const SANDBOX_PROTOCOL = 1

/** 同步通道头：4 个 int32（flag / requestId / byteLength / 保留）。 */
export const SYNC_HEADER_BYTES = 16

/** 同步通道的默认负载上限（一次调用的返回值最多这么大）。 */
export const SYNC_PAYLOAD_BYTES = 1024 * 1024

export interface SandboxLimits {
  /**
   * 单次调用的墙钟上限。到点就 terminate 隔离区——一个死循环的器官
   * 不该把整条生命拖住（这是"隔离"在 RCE 之外的第二层意义）。
   */
  timeoutMs: number
  /** 隔离区的堆上限（MB）。超出即 OutOfMemory，宿主活得好好的。 */
  memoryMb: number
  /** 同步通道负载上限（字节）。 */
  payloadBytes: number
  /** 提示词快照的刷新间隔（ms）。宿主侧不阻塞，只能靠快照。 */
  promptRefreshMs: number
}

export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = {
  // 10s：够一次慢速索引，不够把宿主卡死。器官的 feedback 本该是毫秒级。
  timeoutMs: 10_000,
  memoryMb: 96,
  payloadBytes: SYNC_PAYLOAD_BYTES,
  // 1s：提示词片段晚 1 秒注入，比"宿主为了拿它而阻塞"划算得多。
  promptRefreshMs: 1_000,
}

/**
 * 器官 → 宿主的**同步**方法名。
 *
 * 能进这张表的唯一条件：宿主侧的实现本身是同步且短的（读内存、查表、扣个数）。
 * 任何要 await 的东西（网络、工具调用、写盘）都不许进来——它会让隔离区
 * 不是"等一下"，而是"永久卡住"。
 */
export const SYNC_METHODS = [
  'state',
  'hostMetrics',
  'consume',
  'proposeGap',
  'kvGet',
  'kvSet',
  'kvDelete',
  'registerTool',
  'onTick',
  'onToolResult',
  'onPrompt',
  'netCanReach',
] as const

export type SyncMethod = (typeof SYNC_METHODS)[number]

/** 器官 → 宿主的**异步**方法名（走 req/res，不阻塞隔离区）。 */
export const ASYNC_METHODS = [
  'callTool',
  'inflict',
  'netRequest',
  'netPost',
] as const

export type AsyncMethod = (typeof ASYNC_METHODS)[number]

/** 宿主 → 隔离区的调用名。 */
export const CALL_METHODS = [
  'load',
  'feedback',
  'prompt',
  'rewrite',
  'hook',
  'unload',
  'execTool',
  'tick',
  'toolResult',
] as const

export type CallMethod = (typeof CALL_METHODS)[number]

/** 隔离区启动时回报的"我有哪些可选能力"，宿主据此决定要不要挂那根线。 */
export interface SandboxFeatures {
  hook: boolean
  rewrite: boolean
  onUnload: boolean
}

/** 一次提示词快照：主 getPromptContext + 各 onPrompt 提供者。 */
export interface PromptSnapshot {
  main: unknown
  providers: Array<{ id: string; fragment: unknown }>
}

// ─────────────────────────── 消息形状 ───────────────────────────

/** 隔离区 → 宿主：启动结果（成功才有 manifest）。 */
export interface BootMessage {
  t: 'boot'
  ok: boolean
  protocol: number
  name?: string
  manifest?: Record<string, unknown>
  energy?: Record<string, unknown> | null
  features?: SandboxFeatures
  error?: string
}

/** 隔离区 → 宿主：同步调用（宿主必须**当场**写回同步缓冲区）。 */
export interface SyncMessage {
  t: 'sync'
  id: number
  method: SyncMethod
  args: Record<string, unknown>
}

/** 隔离区 → 宿主：异步请求。 */
export interface RequestMessage {
  t: 'req'
  id: number
  method: AsyncMethod
  args: Record<string, unknown>
}

/** 隔离区 → 宿主：不需要回话的通知（日志 / 事件 / 注销）。 */
export interface NoteMessage {
  t: 'note'
  kind: 'log' | 'emit' | 'unregister'
  payload?: Record<string, unknown>
}

/** 隔离区 → 宿主：一次宿主调用的结果。 */
export interface ResultMessage {
  t: 'res'
  id: number
  ok: boolean
  value?: unknown
  error?: string
}

/** 宿主 → 隔离区：一次调用。 */
export interface CallMessage {
  t: 'call'
  id: number
  method: CallMethod
  args: Record<string, unknown>
}

/** 宿主 → 隔离区：异步请求的回应。 */
export interface ReplyMessage {
  t: 'reply'
  id: number
  ok: boolean
  value?: unknown
  error?: string
}

export type WorkerMessage = BootMessage | SyncMessage | RequestMessage | NoteMessage | ResultMessage

/** 启动载荷（workerData）。 */
export interface WorkerInit {
  protocol: number
  /** 编译产物（JS），不是 .ts——隔离区里没有类型擦除器。 */
  code: string
  /** ABI 模块的绝对 URL：器官源码里不写任何 import，由宿主注入。 */
  abiUrl: string
  /** 源文件名（只用于报错与栈帧，不参与任何路径拼接）。 */
  filename: string
  limits: SandboxLimits
  /** 同步通道：头 16 字节 + 负载。 */
  sab: SharedArrayBuffer
}

/** 同步通道的错误封装：JSON 传不了 Error，只能传一句话。 */
export const SYNC_ERROR_KEY = '__sandbox_error'

/** 结构化克隆过不去的东西（函数 / Symbol / 循环引用）先降级成纯数据。 */
export function toPlain(value: unknown): unknown {
  if (value === undefined) return null
  try {
    return JSON.parse(JSON.stringify(value)) as unknown
  } catch {
    try {
      return String(value)
    } catch {
      return null
    }
  }
}
