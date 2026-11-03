/**
 * 内置 TypeScript 编译器（v0.9.11）
 * ============================================================================
 * 让宿主**直接跑** AI 写的 .ts，不再依赖外部 `tsc` / `npm run build`。
 *
 * 为什么单独抽一层：
 *   以前 organ-loader 里那段 `stripTypes()` 直接 try 两个方案，能用就用。
 *   它有三个问题：
 *     1. **在错误的机器上悄悄退化**：开源出去别人没装 typescript 也没 Node 22.13，
 *        器官就装不上，而报错长得像"你的代码写错了"；
 *     2. **每次都重编译**：watch 一次保存会产生 2-3 个事件，同一份源码被剥三遍；
 *     3. **没有选择权**：有人就想用最快的 engine，有人机器上是 esbuild-wasm。
 *
 * 这一层把"用哪个引擎"变成**显式可配的策略链**，并把结果按内容哈希缓存。
 *
 * 四条底线：
 *   1. **永不假装成功**：编译不出来就抛带解释的错误，不返回原源码（那会在
 *      import 那一刻炸出一个看不懂的 SyntaxError）。
 *   2. **错误信息要指向下一步**：告诉 AI"别用 enum，改用 as const"，而不是
 *      "Transform failed"。
 *   3. **零强制依赖**：链上四个引擎全是**可选**的，最差的那条（Node 内置
 *      strip）在所有支持的 Node 上都有，真正做到了没有外部依赖也能工作。
 *   4. **缓存按内容哈希**：改一个字就是新键，不会出现"改了却不生效"。
 */

import { createHash } from 'node:crypto'

/** 可用的编译引擎，按"想要程度"排序（不是按可用性）。 */
export type CompilerEngine = 'esbuild-wasm' | 'esbuild' | 'typescript' | 'node-strip'

/** 默认策略链：从最快最强到最兜底。 */
export const COMPILER_CHAIN: readonly CompilerEngine[] = [
  'esbuild-wasm',
  'esbuild',
  'typescript',
  'node-strip',
] as const

export const ENGINE_LABEL: Record<CompilerEngine, string> = {
  'esbuild-wasm': 'esbuild-wasm（内置 wasm，跨平台一致）',
  esbuild: 'esbuild（本机原生二进制）',
  typescript: 'typescript（ts.transpileModule）',
  'node-strip': 'node-strip（Node 内置类型擦除，零依赖）',
}

export interface CompileAttempt {
  engine: CompilerEngine
  ok: boolean
  /** 失败原因（已翻译成人话）。 */
  note?: string
}

export interface CompileResult {
  code: string
  engine: CompilerEngine
  /** 试过哪些引擎（含失败的），排查"为什么用了这个"时看这里。 */
  tried: CompileAttempt[]
  /** true = 命中缓存（没真的编译）。 */
  cached?: boolean
}

export interface CompileOptions {
  /** 'auto' 按策略链依次尝试；也可以钉死一个。默认 auto。 */
  engine?: CompilerEngine | 'auto'
  /** 自定义策略链，默认 COMPILER_CHAIN。 */
  chain?: readonly CompilerEngine[]
  /** 关掉缓存（测试 / 一次性编译用）。默认开启。 */
  noCache?: boolean
}

/** 内存缓存上限。器官是几十个量级，超过说明有人在用错误的姿势循环编译。 */
const CACHE_LIMIT = 128

const cache = new Map<string, CompileResult>()

export function resetCompilerCache(): void {
  cache.clear()
}

export function compilerCacheSize(): number {
  return cache.size
}

function cacheKeyOf(source: string, engine: CompilerEngine | 'auto'): string {
  return createHash('sha1').update(`${engine}\u0000${source}`).digest('hex')
}

function remember(key: string, result: CompileResult): CompileResult {
  // 简单的插入序淘汰：够用，且不会出现"随机丢掉刚编译好的那个"。
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next()
    if (!oldest.done) cache.delete(oldest.value)
  }
  cache.set(key, result)
  return result
}

/**
 * 把各类引擎的生硬报错翻译成"下一步该干什么"。
 *
 * 这些提示是**写给她看的**：她会在写代码那一刻看到它们。
 * 只报错不指路的错误，只会让她在原地试第十次。
 */
export function explainCompileError(message: string): string | null {
  const raw = message.trim()
  if (!raw) return null
  if (/enum/i.test(raw) && /(not supported|Strip|unsupported|requires transformation)/i.test(raw)) {
    return '用了 enum —— 写 `const Level = { low: 1, high: 2 } as const` 代替'
  }
  if (/namespace/i.test(raw)) {
    return '用了 namespace —— 器官里不需要命名空间，直接写顶层 const / function'
  }
  if (/parameter propert/i.test(raw)) {
    return '用了构造器参数属性（constructor(private x)）—— 改成在构造器里显式 this.x = x'
  }
  if (/\bdeclare\b/i.test(raw)) {
    return '用了 declare —— 器官里不需要，删掉即可'
  }
  if (/import\s*=|require/i.test(raw)) {
    return '用了 import = / require —— 器官不许 import 任何东西，ABI 由宿主注入'
  }
  if (/(experimental decorators|decorator)/i.test(raw)) {
    return '用了装饰器 —— 器官不支持'
  }
  return null
}

/** 给 AI 看的错误包装：原文 + 一条能落地的建议。 */
export function humanizeCompileError(message: string): string {
  const hint = explainCompileError(message)
  return hint ? `${message}（${hint}）` : message
}

/**
 * 纯类型擦除引擎能处理的子集检测。
 *
 * 用于在**降级到 node-strip 之前**提前判断：如果源码里有必须"变换"的语法，
 * 那条路注定失败，就不必先撞一次墙再回头（慢，且日志难读）。
 */
export function needsTransform(source: string): { needed: boolean; reason?: string } {
  if (/^\s*export\s+enum\b|^\s*(?:declare\s+)?enum\s+\w/m.test(source)) {
    return { needed: true, reason: 'enum' }
  }
  if (/^\s*(?:export\s+)?namespace\s+\w/m.test(source)) {
    return { needed: true, reason: 'namespace' }
  }
  if (/constructor\s*\([^)]*\b(?:private|public|protected|readonly)\b/m.test(source)) {
    return { needed: true, reason: '构造器参数属性' }
  }
  return { needed: false }
}

// ───────────────────────── 四个引擎 ─────────────────────────

interface TransformLike {
  transform: (code: string, options: Record<string, unknown>) => Promise<{ code: string }> | { code: string }
}

async function loadEsbuildWasm(): Promise<TransformLike> {
  const mod = await import('esbuild-wasm' as string) as unknown as TransformLike
  if (typeof mod?.transform !== 'function') throw new Error('esbuild-wasm 没有导出 transform')
  return mod
}

async function loadEsbuildNative(): Promise<TransformLike> {
  const mod = await import('esbuild' as string) as unknown as TransformLike
  if (typeof mod?.transform !== 'function') throw new Error('esbuild 没有导出 transform')
  return mod
}

async function runEsbuild(loader: Promise<TransformLike>, source: string, fileName: string): Promise<string> {
  const engine = await loader
  // 注意：这里是 transform（单文件变换），不是 build。
  // 别往里塞 `bundle` —— 那是 build 的选项，transform 收到会直接抛
  // "Invalid option in transform() call"，把最强的引擎白白打成一个"不可用"。
  // 不做打包这件事由"根本不传 bundle"来保证：transform 从不解析 import。
  const out = await engine.transform(source, {
    loader: 'ts',
    format: 'esm',
    target: 'es2022',
    sourcefile: fileName,
  })
  if (!out?.code) throw new Error('编译结果为空')
  return out.code
}

async function runTypescript(source: string, fileName: string): Promise<string> {
  const ts = await import('typescript' as string) as unknown as {
    transpileModule: (code: string, options: Record<string, unknown>) => { outputText: string }
    ModuleKind: { ESNext: number }
    ScriptTarget: { ES2022: number }
  }
  const out = ts.transpileModule(source, {
    fileName,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
      removeComments: false,
    },
  })
  if (!out.outputText) throw new Error('编译结果为空')
  return out.outputText
}

async function runNodeStrip(source: string): Promise<string> {
  const nodeModule = await import('node:module') as { stripTypeScriptTypes?: (code: string) => string }
  if (typeof nodeModule.stripTypeScriptTypes !== 'function') {
    throw new Error('Node 没有内置类型擦除（需要 Node ≥ 22.13）')
  }
  const out = nodeModule.stripTypeScriptTypes(source)
  if (!out) throw new Error('编译结果为空')
  return out
}

/**
 * 单个引擎跑一次。失败时把原因翻成人话往上抛，由策略链决定要不要降级。
 */
async function attempt(engine: CompilerEngine, source: string, fileName: string): Promise<string> {
  switch (engine) {
    case 'esbuild-wasm':
      return await runEsbuild(loadEsbuildWasm(), source, fileName)
    case 'esbuild':
      return await runEsbuild(loadEsbuildNative(), source, fileName)
    case 'typescript':
      return await runTypescript(source, fileName)
    case 'node-strip':
      return await runNodeStrip(source)
    default:
      throw new Error(`未知编译引擎：${String(engine)}`)
  }
}

/**
 * 把 TypeScript 源码编译成可 import 的 JavaScript。
 *
 * engine='auto' 时按策略链依次尝试：第一个能把这份源码编译通过的胜出。
 * 注意"能加载"和"能编译"是两件事——esbuild 装了但这份源码里有它支持的语法，
 * 才算真成功；加载失败（没装）会安静地降级到下一个，不打扰。
 *
 * @throws 全链失败时抛**最后一个引擎**的错误，但错误信息里带上前面所有尝试。
 */
export async function compileOrganSource(
  source: string,
  fileName: string,
  options: CompileOptions = {},
): Promise<CompileResult> {
  const engineChoice = options.engine ?? 'auto'
  const key = cacheKeyOf(source, engineChoice)
  if (options.noCache !== true) {
    const hit = cache.get(key)
    if (hit) return { ...hit, cached: true }
  }

  const chain: readonly CompilerEngine[] = engineChoice === 'auto'
    ? (options.chain ?? COMPILER_CHAIN)
    : [engineChoice]

  const tried: CompileAttempt[] = []
  let lastError: string = '没有可用的编译引擎'

  for (const engine of chain) {
    // node-strip 纯擦除：源码里有必须变换的语法时，这条路必败，直接跳过，
    // 省一次"撞墙再回头"（它的报错也最难懂）。
    if (engine === 'node-strip') {
      const check = needsTransform(source)
      if (check.needed) {
        tried.push({ engine, ok: false, note: `不支持 ${check.reason}（需要真正的编译器）` })
        continue
      }
    }
    try {
      const code = await attempt(engine, source, fileName)
      tried.push({ engine, ok: true })
      return remember(key, { code, engine, tried })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      lastError = message
      tried.push({ engine, ok: false, note: message.slice(0, 200) })
    }
  }

  const summary = tried.map((item) => `${ENGINE_LABEL[item.engine]}：${item.ok ? '通过' : item.note ?? '失败'}`).join('；')
  throw new Error(
    `无法编译 ${fileName}：${humanizeCompileError(lastError)}。`
    + `已尝试：${summary}。`
    + '解决办法：安装任一编译引擎（推荐 esbuild-wasm，纯 wasm 无原生二进制），'
    + '或把代码写成纯类型擦除子集（不用 enum / namespace / 构造器参数属性）。',
  )
}

/**
 * 当前环境实际能用哪个引擎——启动横幅与自检用。
 *
 * 只做"能不能加载"的探测，不真编译（快，也不触发 wasm 初始化的开销）。
 */
export async function probeEngines(): Promise<Array<{ engine: CompilerEngine; available: boolean; note?: string }>> {
  const out: Array<{ engine: CompilerEngine; available: boolean; note?: string }> = []
  for (const engine of COMPILER_CHAIN) {
    try {
      if (engine === 'esbuild-wasm') {
        const mod = await loadEsbuildWasm()
        out.push({ engine, available: typeof mod.transform === 'function' })
      } else if (engine === 'esbuild') {
        const mod = await loadEsbuildNative()
        out.push({ engine, available: typeof mod.transform === 'function' })
      } else if (engine === 'typescript') {
        const ts = await import('typescript' as string) as unknown as { transpileModule?: unknown }
        out.push({ engine, available: typeof ts.transpileModule === 'function' })
      } else {
        const nodeModule = await import('node:module') as { stripTypeScriptTypes?: unknown }
        out.push({ engine, available: typeof nodeModule.stripTypeScriptTypes === 'function' })
      }
    } catch (error) {
      out.push({ engine, available: false, note: String(error).slice(0, 120) })
    }
  }
  return out
}

// 探测结果：一次进程只做一次。
// 不记忆化的话，每次装载器官都要重新 import 一遍 wasm / 原生二进制，
// 日志里会刷出一长串"xx 可用"——看着像装了十遍。
let engineProbe: Promise<CompilerEngine | null> | null = null

/** 挑一个当前**可用**的引擎（策略链里第一个能加载的），横幅显示用。 */
export function pickEngine(): Promise<CompilerEngine | null> {
  engineProbe ??= probeEngines().then(
    (probed) => probed.find((item) => item.available)?.engine ?? null,
    () => null,
  )
  return engineProbe
}

/** 清空探测结果（换了环境 / 测试用）。 */
export function resetEngineProbe(): void {
  engineProbe = null
}
