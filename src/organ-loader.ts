/**
 * 自举通道 · 器官加载器（bootstrapping loader）
 * ============================================================================
 * 让数字生命**自己写器官**：把 `<self-made>/*.ts` 编译成可执行的 JS，装进隔离区。
 *
 * ── v1.0.2 安全修复：这里曾经是一个 RCE ──────────────────────────────
 * 旧实现把编译产物写进 `.compiled/*.mjs`，然后 `await import()` 它。
 * `import()` 是**主进程**里的模块求值：器官代码与核心共享同一个 process、
 * 同一个 fs、同一个 require 缓存。只要绕过关键词扫描（而关键词扫描本就不是
 * 沙箱），一段陌生代码就能拿到整台机器。
 *
 * 现在的分工：
 *   1. 这里只负责**读、扫、编译**——不执行任何陌生代码；
 *   2. 执行交给 `src/organ-sandbox.ts`：每个器官一个 worker_threads 隔离区，
 *      隔离区里模块解析被 deny（`import('node:fs')` 直接死路）、
 *      `process` / `eval` / `fetch` 被删掉；
 *   3. 宿主与器官之间只剩 IPC：同步的走 Atomics，异步的走消息，
 *      每一次调用都落回 OrganHost 建的真 ctx —— default-deny 一行没被绕过。
 *
 * 保留关键词扫描（FORBIDDEN）的意义变了：它不再是防线，而是**早失败**——
 * 让作者在"写的时候"就知道此路不通，而不是等运行到那一行才被隔离区弹回来。
 * 真正的边界在隔离区，不在这张正则表上。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

import { OrganSandboxError, SandboxedOrgan } from './organ-sandbox.js'
import { deepFreeze } from './manifest-freeze.js'
import type { SandboxLimits } from './organ-rpc.js'

import { CONCEPTS, resolveSolvedConcepts } from './epiphany.js'
import { isValidEndpoint } from './organ-net.js'
import { compileOrganSource, humanizeCompileError, type CompilerEngine } from './organ-compiler.js'
import { PATCHABLE_TOOL_PREFIXES, isPatchableTarget } from './life-organ.js'
import type { LifeOrgan, OrganCapability } from './life-organ.js'

/**
 * ABI 模块的绝对 URL：由隔离区在**它自己那边**注入给器官代码，
 * 器官源码里因此不需要写任何 import（也 import 不到别的东西）。
 */
const ABI_URL = new URL('./life-organ.js', import.meta.url).href

/** 单个器官源文件的体积上限：够写几千行，但挡住"把整个项目塞进来"。 */
export const MAX_ORGAN_BYTES = 64 * 1024

/**
 * 器官名的**唯一**合法形状（v1.0.2）。
 *
 * 为什么必须这么严：器官名会被拿去拼文件路径（`organs/<name>.json`）与
 * 工具命名空间（`organ_<name>_<tool>`）。当 `name` 是 `../state` 时，
 * `join(organDir, name + '.json')` 会落到 `<stateDir>/state.json`——
 * 那是整条生命的核心存档。一个器官名就能覆盖它（或读它）。
 *
 * 规则：只允许 `[a-zA-Z0-9_-]`。点、斜杠、反斜杠、冒号、空格、Unicode 一律拒绝。
 * 点被禁掉不只是为了 `..`：Windows 上 `name.json.` 这种尾巴也会被文件系统吃掉。
 */
export const ORGAN_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/

/** 器官名的长度上限：工具名上限 64，`organ_` + `_` 还要各占一格，留足余量。 */
export const MAX_ORGAN_NAME_LENGTH = 48

/** 器官名是否合法（形状 + 长度）。 */
export function isValidOrganName(name: unknown): boolean {
  if (typeof name !== 'string') return false
  if (name.length === 0 || name.length > MAX_ORGAN_NAME_LENGTH) return false
  return ORGAN_NAME_PATTERN.test(name)
}

/** 路径越界。装载器与核心都用它把"名字拼路径"这件事拦在写盘之前。 */
export class OrganPathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OrganPathError'
  }
}

/** child 是否真的在 parent 里面（含 parent 本身？不含——那不是一个文件）。 */
export function isPathInside(parent: string, child: string): boolean {
  const base = resolve(parent)
  const target = resolve(child)
  if (target === base) return false
  // 必须比到分隔符上：`/a/bc` 不该被 `/a/b` 认成"里面"。
  return target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`)
}

/**
 * 把器官名拼成 `<dir>/<name><ext>` 的**绝对路径**，并证明它没越界。
 *
 * 两道锁，缺一不可：
 *   1. 名字形状（`ORGAN_NAME_PATTERN`）——`../state` 连第一关都过不去；
 *   2. `resolve` 之后的绝对路径必须落在 `dir` 之内——这一关防的是
 *      "名称校验被放宽了"或"调用方传了别的东西"这类将来才会犯的错。
 *      只查名字不查路径，等于把安全性寄托在一条正则上；只查路径不查名字，
 *      等于允许 `..` 走到解析器那一层再被弹回来（中间任何一次误用都是洞）。
 */
export function resolveOrganFilePath(dir: string, name: string, ext = '.json'): string {
  if (!isValidOrganName(name)) {
    throw new OrganPathError(
      `器官名「${String(name).slice(0, 64)}」不合法：只允许 a-zA-Z0-9_-（禁止点、斜杠与任何路径符号）`,
    )
  }
  const base = resolve(dir)
  const target = resolve(base, `${name}${ext}`)
  if (!isPathInside(base, target)) {
    throw new OrganPathError(`器官路径越界：${name}${ext} 解析到了 ${target}，不在 ${base} 之内`)
  }
  // 再确认一次"拼出来的就是名字本身"：resolve 会吃掉 `./`，也会把 `..` 折上去。
  if (target !== join(base, `${name}${ext}`)) {
    throw new OrganPathError(`器官路径异常：${name}${ext} 解析到了 ${target}`)
  }
  return target
}

/** 不抛版本：拿不到安全路径时返回 null，调用方自己决定是跳过还是报错。 */
export function tryResolveOrganFilePath(dir: string, name: string, ext = '.json'): string | null {
  try {
    return resolveOrganFilePath(dir, name, ext)
  } catch {
    return null
  }
}

/**
 * self-made 器官允许声明哪些能力。
 *
 * 2026-10-28：`net:http` / `net:webhook` 进来了。
 * 放开网络是件大事，为什么同意：
 *   - 源码里写 `fetch(` 依旧被拒（FORBIDDEN），它拿到的只有 `ctx.net`；
 *   - `ctx.net` 每次都走 checkNetRequest：能力 + 器官自白 allow + 宿主 allow，**三者求交集**；
 *   - 宿主那把锁（插件配置 organNet）默认 `enabled: false, allow: []`——
 *     她可以在自己的 manifest 里写满全世界，只要这边没开，一个字节也发不出去。
 * 也就是说：**她能声明，不代表她能出去。** `llm` 依旧不给：那会让自写器官自开模型账。
 */
export const SELF_MADE_CAPABILITIES: readonly OrganCapability[] = [
  'tools',
  'prompt',
  'state:read',
  // 宿主感观：CPU / 内存 / 运行时长。给的是脱敏聚合值，不是进程列表。
  'host:read',
  'gap:propose',
  'timer',
  'fs:organ',
  // 跨设备通路：只允许打到白名单里的 https 端点（net:http 可读可写，net:webhook 只能 POST）。
  'net:http',
  'net:webhook',
  // 化学：可以往血液里滴一滴，**包括自己造一种新激素**（v0.9.11）。
  // 这是她给自己发明情绪的唯一入口：feedback 只能调三件套的量，inflict 能造名字。
  'chem:write',
  // 运行时补丁：拦 digital_life_* / organ_* 工具的参数与结果（v0.9.11 对她开放）。
  // 极限安全锁在两层：装载时 validatePatchPolicy 拒掉越界目标，
  // 运行时 runPatch 对非白名单前缀直接原样返回——llm/stream / shell 永远拦不到。
  'patch:runtime',
]

/**
 * 被拒时附加的"那该怎么做"提示。
 *
 * 只写"不许用 process"的报错是**半个报错**：作者知道此路不通，却不知道正路在哪，
 * 于是会反复试探（鱼小水写 system_sensor 时正是这么撞墙的）。
 * 每一条拒绝都要顺手指出对应的 ABI 出口。
 */
export const REJECTION_HINT =
  '提示：要读宿主机器状态（CPU 负载 / 内存占用 / 运行时长）请用 ctx.hostMetrics，'
  + '并在 manifest.capabilities 里声明 host:read；'
  + '要往外界发一句话（联系造物主、推通知）请用 ctx.net.post(url, obj)，'
  + '声明 net:webhook（只准 POST）或 net:http，并在 manifest.net.allow 里写明目标端点——'
  + '它只接受 https，且必须同时被宿主的 organNet.allow 允许；'
  + '**不要把任何密钥 / token 写进自己的源码**：需要凭据的接口，你只写内容字段'
  + '（比如 { content: "…" }），宿主会在请求出门前把凭据补上（值来自环境变量，你读不到也拿不到）；'
  + '要存自己的数据请用 ctx.kv（需声明 fs:organ）。'

/**
 * 隔离区装载失败时附加的说明。
 *
 * 与 REJECTION_HINT 同一个道理：只报"失败"是半个错误。器官作者需要知道
 * 失败发生在**隔离区**而不是自己的类型标注上，也需要知道为什么这条路
 * 和以前不一样了（以前那种写法现在是 RCE）。
 */
export const SANDBOX_HINT =
  '提示：自写器官现在跑在独立隔离区（worker_threads）里，与宿主只通过 IPC 说话。'
  + '装载阶段的常见失败：模块顶层就写了越界调用（process / require / 动态 import / fetch 一律拒绝，'
  + '读机器请用 ctx.hostMetrics，出门请用 ctx.net）；'
  + '源码在顶层抛错（顶层不要做重活，挪进 onLoad）；'
  + '或隔离区启动超时（默认 10s，检查有没有在顶层写死循环）。'

/**
 * 明显越界的关键词。命中即**提前**拒绝装载，并把命中的词告诉作者。
 *
 * v1.0.2 起这不再是防线，而是"早失败"：真正的边界在隔离区
 * （模块解析被 deny + process/eval/fetch 被删掉）。这张表的价值是让作者
 * 在写的时候就知道此路不通，而不是等运行到那一行才被隔离区弹回来。
 */
const FORBIDDEN: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brequire\s*\(/, reason: 'require()' },
  { pattern: /(^|[^\w.])import\s*\(/, reason: '动态 import()' },
  { pattern: /\bprocess\s*\./, reason: 'process' },
  { pattern: /\bchild_process\b/, reason: 'child_process' },
  { pattern: /\beval\s*\(/, reason: 'eval()' },
  { pattern: /\bnew\s+Function\b/, reason: 'new Function' },
  { pattern: /\bglobalThis\b/, reason: 'globalThis（器官代码不该碰全局）' },
  { pattern: /\bfrom\s+['"]node:/, reason: 'node: 内置模块（读机器请用 ctx.hostMetrics）' },
  { pattern: /\bfrom\s+['"]os['"]/, reason: 'os 模块（读机器请用 ctx.hostMetrics）' },
  { pattern: /\bfrom\s+['"]fs['"]/, reason: 'fs' },
  { pattern: /\bfetch\s*\(/, reason: 'fetch()' },
  { pattern: /\bXMLHttpRequest\b/, reason: 'XMLHttpRequest' },
  { pattern: /\bWebSocket\b/, reason: 'WebSocket' },
  { pattern: /\bDeno\b|\bBun\b/, reason: '其它运行时全局' },
  // v1.0.2：把"自己造一个隔离区之外的世界"的路也堵上。
  // 这些不是隔离区的替代品——隔离区才是边界；这里只是让作者早点知道此路不通。
  { pattern: /\bworker_threads\b/, reason: 'worker_threads（器官不该自己再开线程）' },
  { pattern: /\bAtomics\s*\./, reason: 'Atomics（同步通道归宿主所有）' },
  { pattern: /\bSharedArrayBuffer\b/, reason: 'SharedArrayBuffer' },
  { pattern: /\bimport\s*\.\s*meta\b/, reason: 'import.meta' },
]

export interface LoadOptions {
  /** 允许声明的能力白名单，默认 SELF_MADE_CAPABILITIES。 */
  allowedCapabilities?: readonly OrganCapability[]
  /**
   * 【已废弃，v1.0.2】编译产物目录。
   *
   * 以前编译结果要写进 `.compiled/*.mjs` 才能 `import()`；现在执行在隔离区里，
   * 源码走 workerData（字符串）进去，**不落盘**。留这个字段只是为了不打断
   * 老调用方与老测试的签名，传了也不会写任何文件。
   */
  outDir?: string
  /** 隔离区限额（超时 / 内存 / 同步通道大小 / 提示词快照间隔）。 */
  sandbox?: Partial<SandboxLimits>
  /**
   * 指定编译引擎；默认 auto（按 esbuild-wasm → esbuild → typescript → node-strip 依次尝试）。
   *
   * 之所以要能钉死：不同机器上"最快"的答案不一样，而每次 auto 都要先试
   * 一遍链，冷启动会慢几十毫秒。跑明白了就把它写死在配置里。
   */
  compiler?: CompilerEngine | 'auto'
}

export interface OrganLoadResult {
  ok: boolean
  /** 器官名（能从源码里解析出来时才有）。 */
  name: string | null
  file: string
  organ: LifeOrgan<unknown> | null
  /** 硬失败原因；非空即 ok=false。 */
  errors: string[]
  /** 不阻断的问题（例如自动剥离了 import）。 */
  warnings: string[]
  /** 编译这份源码实际用到的引擎（成功后才有）。 */
  engine?: CompilerEngine
  /** 是否在隔离区里执行（v1.0.2 起恒为 true；留着给面板与测试断言用）。 */
  sandboxed?: boolean
}

/** 扫目录，返回所有 .ts 源文件（忽略 .compiled 与被下划线开头的模板）。 */
export function listOrganSources(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts') && !name.startsWith('_'))
      .map((name) => join(dir, name))
      .filter((file) => {
        try {
          return statSync(file).isFile()
        } catch {
          return false
        }
      })
      .sort()
  } catch {
    return []
  }
}

/** 关键词扫描：返回命中的违规项（空数组 = 通过）。 */
export function scanSource(source: string): string[] {
  return FORBIDDEN.filter((item) => item.pattern.test(source)).map((item) => item.reason)
}

/**
 * 把 TypeScript 源码编译成 JavaScript（v0.9.11：改走内置编译器）。
 *
 * 以前这里自己 try 两个方案（typescript 包 → Node 内置 strip），能用就用。
 * 现在统一交给 `src/organ-compiler.ts` 的策略链：
 *   esbuild-wasm → esbuild → typescript → node-strip
 * 好处是：能在错误的机器上给出**明确且指向下一步**的报错，
 * 结果按内容哈希缓存（watch 一次保存连发好几个事件，不再重复编译），
 * 并且宿主不再依赖任何外部Node build 步骤——把 .ts 丢进来就能跑。
 *
 * 保留这个函数是为了兼容老调用；新代码请用 compileOrganSource，它能告诉你用的哪个引擎。
 */
export async function stripTypes(source: string, fileName: string): Promise<string> {
  return (await compileOrganSource(source, fileName)).code
}

/**
 * 去掉用户代码里的 import 语句。
 *
 * 自写器官**不允许 import 任何东西**（ABI 由我们注入）。保留一句 `import` 只会导致
 * 模块解析失败，报错还很难懂，所以这里直接剥掉并给一条 warning。
 *
 * 两个模式都刻意"贴着语法"写：多行 import 只允许花括号里没有 `}` 的内容，
 * 单行 import 不许跨行——否则 `[\s\S]*?` 会把后面的代码整段吞掉。
 */
export function stripImports(code: string): { code: string; stripped: number } {
  let stripped = 0
  const mark = (): string => {
    stripped += 1
    return '/* [loader] 已移除 import：ABI 由宿主注入 */'
  }
  let out = code
    // import { a, b } from '…'（可跨行，但花括号内不含 `}`）
    .replace(/^[ \t]*import\s+(?:type\s+)?\{[^}\n]*(?:\n[^}\n]*)*\}\s*from\s*['"][^'"]+['"];?/gm, mark)
    // import x from '…' / import * as x from '…'（单行）
    .replace(/^[ \t]*import\s+[^\n;]*from\s*['"][^'"]+['"];?/gm, mark)
    // import '…'（副作用导入）
    .replace(/^[ \t]*import\s+['"][^'"]+['"];?/gm, mark)
  return { code: out, stripped }
}

/**
 * 生成可导入的模块源码：注入 ABI → 用户代码。
 *
 * 【v1.0.2 起不再用于装载】真正装载的拼接在 `src/organ-worker.ts` 里（隔离区
 * 自己拼 data: URL）。保留这个导出只是为了不打断外部调用方，别在新代码里用它。
 */
export function buildModuleSource(userCode: string): string {
  return [
    `import * as __abi from ${JSON.stringify(ABI_URL)}`,
    '// 注入 ABI：生成代码不需要写任何 import',
    'const { defineOrgan } = __abi',
    '',
    userCode,
    '',
  ].join('\n')
}

/** 从模块命名空间里取出器官实例（支持 default / organ / createOrgan 三种写法）。 */
export function pickOrgan(mod: Record<string, unknown>): LifeOrgan<unknown> | null {
  for (const item of [mod.default, mod.organ]) {
    if (isOrganLike(item)) return item
  }
  const factory = mod.createOrgan ?? mod.default
  if (typeof factory === 'function') {
    const built = (factory as () => unknown)()
    if (isOrganLike(built)) return built
  }
  return null
}

function isOrganLike(value: unknown): value is LifeOrgan<unknown> {
  if (!value || typeof value !== 'object') return false
  const manifest = (value as { manifest?: { name?: unknown } }).manifest
  return !!manifest && typeof manifest.name === 'string' && typeof (value as { onLoad?: unknown }).onLoad === 'function'
}

/** 校验 manifest 的形状与能力白名单。返回错误列表（空 = 通过）。 */
export function validateManifest(
  organ: LifeOrgan<unknown>,
  allowed: readonly OrganCapability[],
): string[] {
  const errors: string[] = []
  const manifest = organ.manifest as unknown as Record<string, unknown> | undefined
  if (!manifest) return ['缺少 manifest']

  // ── 名称强校验（v1.0.2 · 路径穿越）──────────────────────────────
  // 这一段必须排在所有"形状校验"最前面：名字是唯一会变成**文件路径**的字段，
  // 而 `../state` 这种名字拼出来的就是核心存档。先判名字，再谈别的。
  const name = manifest.name
  if (typeof name !== 'string' || !name.trim()) {
    errors.push('manifest.name 必须是非空字符串')
  } else if (!isValidOrganName(name)) {
    errors.push(
      `manifest.name「${name.slice(0, 64)}」不合法：必须匹配 ${ORGAN_NAME_PATTERN.source}`
      + `（只允许字母、数字、下划线与连字符，长度 1-${MAX_ORGAN_NAME_LENGTH}）。`
      + '点与斜杠一律禁止——那不是命名风格问题，`../state` 会拼出器官目录之外的文件路径。',
    )
  }
  for (const key of ['version', 'kind']) {
    if (typeof manifest[key] !== 'string' || !(manifest[key] as string).trim()) {
      errors.push(`manifest.${key} 必须是非空字符串`)
    }
  }
  if (typeof manifest.apiVersion !== 'number') errors.push('manifest.apiVersion 必须是数字（当前为 1）')
  const capabilities = (manifest.capabilities ?? []) as unknown
  if (!Array.isArray(capabilities)) {
    errors.push('manifest.capabilities 必须是数组（没有能力就写 []）')
  } else {
    const illegal = capabilities.filter((cap) => !allowed.includes(cap as OrganCapability))
    if (illegal.length > 0) {
      errors.push(`能力 ${illegal.join(', ')} 不在自写器官白名单里（允许：${allowed.join(', ')}）`)
    }
  }
  if (typeof (organ as { feedback?: unknown }).feedback !== 'function') {
    errors.push('器官必须实现 feedback(stimulus)（可以是返回 {} 的空实现）')
  }
  errors.push(...validateNetworkPolicy(manifest))
  errors.push(...validatePatchPolicy(manifest))
  if (errors.length > 0) return errors

  // ── 冻结（v1.0.2 · TOCTOU）────────────────────────────────────
  // 校验通过了。从这一行起，这个 manifest 与它内部每一个数组都不可写：
  // 器官再想 `ctx.manifest.capabilities.push('llm')` 就是一次 TypeError，
  // 而不是"悄悄多了一项权限"。注意必须**深**冻结——只冻第一层的话，
  // capabilities 数组照样能 push，那正是漏洞本来的样子。
  freezeManifestInPlace(manifest)
  return errors
}

/**
 * 就地深度冻结（含 capabilities / requires / net.allow / patches 全部数组）。
 *
 * 为什么不返回新对象：调用方（宿主 / 装载器）手里那份引用必须一起变成只读，
 * 否则"我冻结了副本、你还在用原件"——那只是把洞挪了个位置。
 */
function freezeManifestInPlace(manifest: Record<string, unknown>): void {
  deepFreeze(manifest)
}

/**
 * 运行时补丁声明的校验（极限安全锁 · 装载层，v0.9.11）。
 *
 * 与网络策略同一套哲学：**声明写得像不像样子在这里判**，
 * 真正的行为判定在运行时（organ-host.runPatch 对非白名单前缀直接原样返回）。
 * 两层缺一不可：只留装载校验，绕过 loader 的器官（核心内置器官）就没人管；
 * 只留运行时闸，她要试错好几次才知道自己的目标越界了。
 *
 * 规则：
 *   1. 写了 manifest.patches 就必须声明 `patch:runtime` 能力——
 *      没有能力登记的目标清单是"悄悄挂钩"，与"拦截器必须可审查"相悖；
 *   2. 每条声明的 target 必须以 `digital_life_` / `organ_` 开头（可尾缀 `*`）——
 *      `llm/stream`、`shell`、`bash` 一律拒装，`*` 单独写也拒；
 *   3. phase 只能是 before / after。
 */
export function validatePatchPolicy(manifest: Record<string, unknown>): string[] {
  const capabilities = (manifest.capabilities ?? []) as string[]
  const hasPatchCap = Array.isArray(capabilities) && capabilities.includes('patch:runtime')
  const patches = manifest.patches as unknown

  if (patches === undefined) return []
  if (!Array.isArray(patches) || patches.length === 0) {
    return ['manifest.patches 必须是非空数组（每条形如 { target, phase }）']
  }
  const problems: string[] = []
  if (!hasPatchCap) {
    problems.push('写了 manifest.patches 就必须声明 capabilities: [\'patch:runtime\']——拦截器必须可审查')
  }
  if (patches.length > 8) {
    problems.push(`manifest.patches 最多 8 条（收到 ${patches.length} 条）——够做补丁，不够做影子核心`)
  }
  for (const raw of patches) {
    const patch = raw as { target?: unknown; phase?: unknown }
    const target = String(patch?.target ?? '').trim()
    const phase = patch?.phase
    if (!target) {
      problems.push('manifest.patches 里有空 target')
      continue
    }
    if (target === '*') {
      problems.push('target 不能只写一个 *——那等于捕获全部工具，等于另立一个核心')
      continue
    }
    // 极限安全锁的核心断言：剥掉尾缀 * 之后，剩下的必须以白名单前缀开头。
    // 这么写（而不是直接 isPatchableTarget(target)）是为了让 `digital_life_*`
    // 这种**声明形态**也能过——命中的是工具名，不是声明本身。
    const stem = target.endsWith('*') ? target.slice(0, -1) : target
    if (!isPatchableTarget(stem)) {
      problems.push(
        `manifest.patches 里的「${target}」越界：补丁器官只能拦截 `
        + `${PATCHABLE_TOOL_PREFIXES.join(' / ')} 开头的工具`
        + '（llm/stream、shell 这类底层通道绝对不许碰——那不叫补丁，叫接管）',
      )
    }
    if (phase !== 'before' && phase !== 'after') {
      problems.push(`manifest.patches 里的「${target}」phase 必须是 before 或 after`)
    }
  }
  return problems
}

/**
 * 网络策略的形状校验（不给海关代理：形状不对就不给装）。
 *
 * 判定行为本身在 `checkNetRequest` 里（运行时每一次请求都要走），
 * 这里只负责"声明写得像不像样子"——早失败总比到发请求那一步才知道强。
 */
export function validateNetworkPolicy(manifest: Record<string, unknown>): string[] {
  const capabilities = (manifest.capabilities ?? []) as string[]
  const usesNet = Array.isArray(capabilities) && capabilities.some((cap) => cap === 'net:http' || cap === 'net:webhook')
  const policy = manifest.net as Record<string, unknown> | undefined

  // 没声明网络能力却写了 net 字段：不算错（也许留着以后用），只是这一份策略不生效。
  if (!usesNet) return []
  if (!policy || typeof policy !== 'object') {
    return ['声明了 net:http / net:webhook，就必须写 manifest.net = { allow: [目标地址] }——没有目标清单的能力不算声明']
  }
  const allow = policy.allow
  if (!Array.isArray(allow) || allow.length === 0) {
    return ['manifest.net.allow 必须是非空数组（写明你打算联系哪几个端点）']
  }
  const problems: string[] = []
  const allowInsecure = policy.allowInsecure === true
  for (const item of allow) {
    if (typeof item !== 'string' || !isValidEndpoint(item, { allowInsecure })) {
      problems.push(
        `manifest.net.allow 里的「${String(item)}」不合格：必须是 https 开头的完整地址，`
        + '结尾可以用 * 做前缀匹配（不能写 * 一个字就算放行全部）',
      )
    }
  }
  const methods = policy.methods
  if (methods !== undefined) {
    if (!Array.isArray(methods) || methods.length === 0) {
      problems.push('manifest.net.methods 必须是非空数组（不写则用能力默认值）')
    } else if (capabilities.includes('net:webhook') && !capabilities.includes('net:http')) {
      const upper = methods.map((item) => String(item).toUpperCase())
      if (upper.some((item) => item !== 'POST')) {
        problems.push('只声明 net:webhook 时 methods 不能包含 GET——那等于把"只能投递"放宽成"还能打听"')
      }
    }
  }
  const maxBody = policy.maxBodyBytes
  if (maxBody !== undefined && (typeof maxBody !== 'number' || maxBody <= 0)) {
    problems.push('manifest.net.maxBodyBytes 必须是正数')
  }
  return problems
}

/**
 * 顿悟的自证声明：认不出的条目不给错误，只给**警告**。
 *
 * 理由：拼错一个概念 id 不该让器官装不上——那等于让一个错别字挡住整个器官。
 * 但要让她知道这条声明是空的，否则她会以为自己写好了，却永远等不到那次顿悟。
 */
export function validateSolvedConcepts(organ: LifeOrgan<unknown>): string[] {
  const manifest = organ.manifest as unknown as Record<string, unknown> | undefined
  if (!manifest) return []
  const declared = manifest.solvesConcepts
  if (declared === undefined) return []
  if (!Array.isArray(declared)) return ['manifest.solvesConcepts 必须是字符串数组']
  const { unknown } = resolveSolvedConcepts(declared as string[])
  if (unknown.length === 0) return []
  return [`manifest.solvesConcepts 里认不出：${unknown.join(', ')}（可用概念：${CONCEPTS.map((c) => c.id).join(', ')}；也可以写 host_metrics 这类复合词）`]
}

export interface LoadSourceOptions extends LoadOptions {
  /** 源文件名：只影响报错与隔离区里的栈帧，不参与任何路径拼接。 */
  filename?: string
}

/**
 * 装载一个器官源**文件**。**永远不抛错**：失败信息都在 errors 里。
 */
export async function loadOrganFile(file: string, options: LoadOptions = {}): Promise<OrganLoadResult> {
  let source: string
  try {
    const info = statSync(file)
    if (info.size > MAX_ORGAN_BYTES) {
      return {
        ok: false,
        name: null,
        file,
        organ: null,
        errors: [`源文件 ${info.size} 字节，超过上限 ${MAX_ORGAN_BYTES}`],
        warnings: [],
      }
    }
    source = readFileSync(file, 'utf8')
  } catch (error) {
    return { ok: false, name: null, file, organ: null, errors: [`读取失败：${String(error)}`], warnings: [] }
  }
  return loadOrganSource(source, { ...options, filename: file, file })
}

/**
 * 装载一段**还没落盘**的器官源码（v1.0.3）。
 *
 * 为什么需要它：细粒度审批要在"批准之前"就知道这个器官到底要什么能力。
 * 而从源码里正则抠 `manifest` 是个坏主意——两段 manifest、注释里的假 manifest、
 * 字符串里的假 capabilities，都能让"审的"和"跑的"不是同一份（解析器差异攻击）。
 * 所以预检干脆**真的装一次**：反正隔离区里装是安全的，装完读到的就是真那份。
 *
 * 预检完调用方必须 `dispose()`，别把探针留在后台。
 */
export async function loadOrganSource(
  source: string,
  options: LoadSourceOptions & { file?: string } = {},
): Promise<OrganLoadResult> {
  const file = options.file ?? options.filename ?? '<inline>'
  const result: OrganLoadResult = { ok: false, name: null, file, organ: null, errors: [], warnings: [] }
  const allowed = options.allowedCapabilities ?? SELF_MADE_CAPABILITIES

  const bytes = Buffer.byteLength(source, 'utf8')
  if (bytes > MAX_ORGAN_BYTES) {
    result.errors.push(`源文件 ${bytes} 字节，超过上限 ${MAX_ORGAN_BYTES}`)
    return result
  }

  const violations = scanSource(source)
  if (violations.length > 0) {
    result.errors.push(`源码里有不允许的调用：${violations.join('、')}`)
    result.errors.push(REJECTION_HINT)
    return result
  }

  let compiled: Awaited<ReturnType<typeof compileOrganSource>>
  let code: string
  try {
    // 内置编译器：按策略链选引擎，结果按内容哈希缓存。不再需要外部 tsc / npm run build。
    compiled = await compileOrganSource(source, options.filename ?? file, { engine: options.compiler ?? 'auto' })
    if (compiled.cached !== true && compiled.code === source) {
      result.warnings.push('源码里没有可擦除的类型：可能忘了写 TS 语法，也可能本来就是 JS')
    }
    const stripped = stripImports(compiled.code)
    if (stripped.stripped > 0) {
      result.warnings.push(`已移除 ${stripped.stripped} 条 import（ABI 由宿主注入，不需要自己 import）`)
    }
    code = stripped.code
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // 编译错误可能来自多个引擎，最后那条已经是最具体的原因，这里不重复包装。
    result.errors.push(humanizeCompileError(message))
    return result
  }
  result.engine = compiled.engine

  // ── 隔离装载（v1.0.2）：主进程**不再 import() 任何陌生代码** ──────────
  //
  // 这里以前是 `await import(pathToFileURL(outFile).href)`：一行就把器官的
  // 顶层代码放进了主进程。它是整个漏洞的中心——不是"扫描没写好"，而是
  // "扫描之后还要在同一张桌子上吃饭"。
  //
  // 现在的顺序：编译产物作为**字符串**交给隔离区，由它自己的 V8 装载；
  // 主进程全程没有执行权，只有一个 IPC 端点。
  let organ: SandboxedOrgan
  try {
    organ = await SandboxedOrgan.create({
      code,
      filename: options.filename ?? file,
      abiUrl: ABI_URL,
      limits: options.sandbox,
    })
  } catch (error) {
    if (error instanceof OrganSandboxError) {
      result.errors.push(`隔离区装载失败（${basenameOf(file)}）：${error.message}`)
      result.errors.push(SANDBOX_HINT)
    } else {
      result.errors.push(`隔离区装载失败（${basenameOf(file)}）：${error instanceof Error ? error.message : String(error)}`)
    }
    return result
  }
  result.sandboxed = true
  result.name = organ.manifest?.name ?? null

  const problems = validateManifest(organ, allowed)
  if (problems.length > 0) {
    // 校验没过 → 立刻销毁隔离区。留一个"已经跑起来但不合规"的活体在后台，
    // 等于让一次失败的装载变成一次成功的驻留。
    await organ.dispose()
    result.errors.push(...problems)
    return result
  }
  // 自证声明认不出来只是警告：器官照样装，只是这条顿悟暂时不会来。
  result.warnings.push(...validateSolvedConcepts(organ))

  result.organ = organ
  result.ok = true
  return result
}

/** 扫整个目录并逐个装载。单个文件失败不影响其它文件。 */
export async function loadSelfMadeDir(
  dir: string,
  options: LoadOptions = {},
): Promise<OrganLoadResult[]> {
  if (!existsSync(dir)) return []
  const results: OrganLoadResult[] = []
  for (const file of listOrganSources(dir)) {
    results.push(await loadOrganFile(file, options))
  }
  return results
}

function basenameOf(file: string): string {
  const parts = file.replace(/\\/g, '/').split('/')
  return (parts[parts.length - 1] ?? 'organ').replace(/\.ts$/, '')
}
