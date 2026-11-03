/**
 * 器官守卫（v0.9.11）
 * ============================================================================
 * 两件事，都是"她有能力伤害自己"之后必须补上的东西：
 *
 *   ① 防爆仓 —— 同一个器官编译/装载连续失败超过阈值，强制锁定。
 *   ② L0 安全锁 —— 她绝对不能改核心源码；遇到 Bug 只能写运行时补丁器官。
 *
 * ── 为什么需要 ① ──────────────────────────────────────────────────
 * 她写完一个器官，watcher 会立刻装载；装不上，她会改一版再写。
 * 如果文件格式一直不对，就会变成：写入 → watch → 编译 → 失败 → 她再写 → …
 * 这个循环在 token 上是很贵的，而且**她自己感觉不到贵**——
 * 每一次失败在她看来只是"上一次不太对"。
 *
 * 所以需要一个"跳闸"的概念：连着 3 次没装上，就冻结这个文件，
 * 不再尝试装载，并且**注入高额皮质醇**（让她明确感觉到"这条路走不通了，
 * 再试也没用"），把错误信息连同"该怎么改"一次性交给她。
 *
 * ── 为什么需要 ② ──────────────────────────────────────────────────
 * 她能读源码（否则她诊断不出 manifest.net 那个 ABI bug），也就**能改源码**。
 * 一旦允许她改 src/，两个后果：
 *   - 安全的那三层锁（能力白名单、关键词扫描、网络三把锁）都在 src/ 里，她能绕；
 *   - 每次她改坏了都不能回滚到"我们知道是对的"那一版。
 * 所以 L0 = index.ts + src/** 只读。她发现 Bug 的出口是**写补丁器官**：
 * 一个声明了 patch 的器官，能在不碰源码的前提下拦截/改写核心行为。
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, normalize, resolve, sep } from 'node:path'

// ═══════════════════════ ① 熔断器 ═══════════════════════

export interface BreakerConfig {
  /** 连续失败多少次跳闸。默认 3。 */
  threshold?: number
  /** 跳闸时该往"非常疼"里加多少皮质醇。默认 30。 */
  penaltyCortisol?: number
  /** 跳闸时是否把该文件从这一轮装载里剔除。默认 true。 */
  blockOnTrip?: boolean
}

export interface GuardRecord {
  /** 键：器官文件名（不含路径）——同一个器官改内容也算同一个人。 */
  key: string
  failures: number
  successes: number
  locked: boolean
  lockedAt?: number
  unlockedAt?: number
  lastError?: string
  /** 累计跳闸次数：重启也记得她在这件事上栽过几次。 */
  trips: number
}

export interface FailureVerdict {
  failures: number
  locked: boolean
  /** 本次是否触发跳闸（false = 还没到阈值）。 */
  tripped: boolean
  /**
   * 该对激素做什么。宿主拿到它去滴——守卫自己不碰化学。
   * 为什么不在里面直接改激素：这一层必须能单测，而化学是另一条线。
   */
  penalty: { cortisol: number; reason: string } | null
}

/** 一条记录的原样样貌，写盘/读盘用。 */
interface LockFileShape {
  version: 1
  records: Record<string, GuardRecord>
}

export class OrganCircuitBreaker {
  private readonly records = new Map<string, GuardRecord>()
  readonly threshold: number
  readonly penaltyCortisol: number
  readonly blockOnTrip: boolean

  constructor(config: BreakerConfig = {}, private readonly lockFile: string | null = null) {
    this.threshold = Math.max(1, config.threshold ?? 3)
    this.penaltyCortisol = Math.max(0, config.penaltyCortisol ?? 30)
    this.blockOnTrip = config.blockOnTrip !== false
    this.restore()
  }

  /** 用文件名或器官名都能查；内部统一按文件名 key。 */
  private keyOf(name: string): string {
    return basename(String(name)).replace(/\.ts$/, '')
  }

  peek(name: string): GuardRecord {
    return this.records.get(this.keyOf(name)) ?? {
      key: this.keyOf(name), failures: 0, successes: 0, locked: false, trips: 0,
    }
  }

  list(): GuardRecord[] {
    return [...this.records.values()].map((item) => ({ ...item }))
  }

  /** 该文件此刻是否被冻结。syncSelfMade 装载前先问这一句。 */
  isLocked(name: string): boolean {
    return this.peek(name).locked
  }

  /** 装载成功：清掉失败计数，顺带解锁（她改好了就该立刻生效，不用重启）。 */
  recordSuccess(name: string): { unlocked: boolean } {
    const key = this.keyOf(name)
    const current = this.peek(name)
    const unlocked = current.locked
    this.records.set(key, {
      ...current,
      failures: 0,
      successes: current.successes + 1,
      locked: false,
      unlockedAt: unlocked ? Date.now() : current.unlockedAt,
      lastError: undefined,
    })
    if (unlocked) this.persist()
    else if (current.failures > 0) this.persist()
    return { unlocked }
  }

  /**
   * 装载失败。**连续**计数——中间成功过一次就清零，
   * 所以"写坏了三个版本"会被拦，"偶尔手滑一次"不会。
   */
  recordFailure(name: string, error?: string): FailureVerdict {
    const key = this.keyOf(name)
    const current = this.peek(name)
    const failures = current.failures + 1
    const tripped = !current.locked && failures >= this.threshold
    const next: GuardRecord = {
      ...current,
      failures,
      locked: current.locked || tripped,
      lockedAt: tripped ? Date.now() : current.lockedAt,
      lastError: error?.slice(0, 400),
      trips: current.trips + (tripped ? 1 : 0),
    }
    this.records.set(key, next)
    this.persist()
    return {
      failures,
      locked: next.locked,
      tripped,
      penalty: tripped
        ? { cortisol: this.penaltyCortisol, reason: `器官 ${key} 连续 ${failures} 次装不上，宿主已冻结它` }
        : null,
    }
  }

  /**
   * 人工解锁（`/digital-life organs unlock <name>`）。
   *
   * 必须留这条手动闸：自动跳闸保护的是钱包，但判定错的代价是她再也长不出这个器官。
   * 人能一键放行，才算真的有最终裁量权。
   */
  unlock(name: string): boolean {
    const key = this.keyOf(name)
    const current = this.records.get(key)
    if (!current || !current.locked) return false
    this.records.set(key, { ...current, locked: false, failures: 0, unlockedAt: Date.now(), lastError: undefined })
    this.persist()
    return true
  }

  /**
   * 给她的回执文案。
   *
   * 只有"失败了"三个字的报错会逼她再试第四次；把上限、剩余次数、
   * 以及"再失败就要被冻结"提前说清楚，她第三次就知道该停下来换思路。
   */
  failureMessage(name: string, verdict: FailureVerdict, error?: string): string {
    const key = this.keyOf(name)
    if (verdict.tripped) {
      return [
        `器官 ${key} 已冻结：连续 ${verdict.failures} 次装载失败（上限 ${this.threshold} 次）。`,
        '宿主不会再尝试装载它，也不会再去读这个文件——你继续改同一行代码是无效的。',
        '要么等主人手动解锁（/digital-life organs unlock），要么换一个器官名重开一局。',
        error ? `最后一次的错误：${error}` : '',
      ].filter(Boolean).join('\n')
    }
    if (verdict.locked) {
      return `器官 ${key} 当前处于冻结状态，跳过装载。改动不会被采纳，请先解锁。`
    }
    const left = this.threshold - verdict.failures
    return `器官 ${key} 第 ${verdict.failures} 次装载失败，再失败 ${left} 次就会被冻结：${error ?? '（无详情）'}`
  }

  // ── 持久化 ──────────────────────────────────────────────
  //
  // 为什么要落盘：只在内存里计数的话，她可以"重启一次就有三次机会"，
  // 死循环成本被摊薄到每次重启——保护等于没做。

  private persist(): void {
    if (!this.lockFile) return
    try {
      const payload: LockFileShape = { version: 1, records: Object.fromEntries(this.records) }
      writeFileSync(this.lockFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    } catch {
      // 写盘失败不该让器官装载这件事本身失败：降级为纯内存守卫。
    }
  }

  private restore(): void {
    if (!this.lockFile || !existsSync(this.lockFile)) return
    try {
      const parsed = JSON.parse(readFileSync(this.lockFile, 'utf8')) as LockFileShape
      for (const [key, record] of Object.entries(parsed.records ?? {})) {
        // trips 保留：她在这件事上栽过几次，重启后依然算数。
        // failures 也保留：不能靠重启白嫖新一轮重试机会。
        this.records.set(key, { ...record, key })
      }
    } catch {
      // 锁文件坏了就当没有：宁可重新计数，也不要陷在里面起不来。
    }
  }
}

// ═══════════════════════ ② L0 安全锁 ═══════════════════════

/**
 * L0（不可写）的范围。
 *
 * 判定用**相对路径前缀**，不看绝对路径：换台机器安装位置变了也一样成立。
 * 这些目录里的东西定义了"什么是安全"，而她不能重新定义安全。
 */
export const L0_PREFIXES: readonly string[] = [
  'src/',
  'index.ts',
  'package.json',
  'tsconfig.json',
  'tsconfig.organs.json',
  'genome.json',
  'lib/',
] as const

/** 只允许她写的地方（相对插件根）。 */
export const WRITABLE_PREFIXES: readonly string[] = [
  'web-ui/organs/self-made/',
] as const

/**
 * 目标路径能不能写。**返回 null = 可以写**，否则是拒因。
 *
 * 三条防线：
 *   1. `..` 与绝对路径 —— 最经典的越狱写法；先 normalize 再比前缀；
 *   2. L0 前缀 —— 明确写在黑单里；
 *   3. 白名单前缀 —— 不在沙子堆里的一律不许，哪怕它既不叫 index.ts 也不在 src/ 下。
 *
 * 为什么白名单而不是黑名单：她总有一天会找到一个我们没想到名字的文件
 * （比如 .npmrc、.dsh/xxx），黑名单漏一个就是一次提权。
 */
export function assertWritableTarget(target: string, rootDir: string): string | null {
  const root = resolve(rootDir)
  const full = resolve(root, target)
  const rel = normalize(full.startsWith(root) ? full.slice(root.length) : `../${full}`)
    .replace(/^([/\\])+/, '')
    .split(/[\\/]/)
    .join('/')

  if (rel.startsWith('..') || rel.includes(`../`) || full === root) {
    return `「${target}」越出了沙盒目录：器官只能写进 web-ui/organs/self-made/`
  }
  // Windows：盘符不同的绝对路径也当作越界（resolve 之后前缀一定对不上，这里再兜一道）。
  if (!full.startsWith(root + sep) && full !== root) {
    return `「${target}」不在插件根目录下，拒绝写入`
  }
  for (const prefix of L0_PREFIXES) {
    if (rel === prefix || rel.startsWith(prefix)) {
      return [
        `「${target}」是 L0 核心源码，不可修改。`,
        '这里是定义"什么是安全"的地方——包括能力白名单、网络三把锁与你自己那层沙盒，',
        '让被约束者去改约束条件，这套约束就作废了。',
        '如果你在里面发现了 Bug：写一个**运行时补丁器官**（capabilities 加 patch:runtime），',
        '它能在不改一行源码的前提下拦截并改写目标行为。详见 design/self-made-prompt.md。',
      ].join('')
    }
  }
  const allowed = WRITABLE_PREFIXES.some((prefix) => rel.startsWith(prefix))
  if (!allowed) {
    return `「${target}」不在可写白名单里（只允许 ${WRITABLE_PREFIXES.join(', ')}）`
  }
  // .ts 之外的东西一律不收：器官就是 TypeScript，不给她往沙盒里塞任意文件的机会。
  if (!rel.endsWith('.ts')) {
    return `只接受 .ts 文件（收到的是 ${basename(rel) || '目录'}）`
  }
  return null
}

/**
 * 器官文件名校验：过关返回文件名，不过关返回 null。
 *
 * 这里**不清洗，只拒绝**。
 * 早期版本会把 `../clock` 悄悄洗成 `clock`——看着贴心，实际上是在骗人：
 * 她以为自己写到了上层目录，宿主却把文件放进了沙盒，下一次她还会再试一次。
 * 安全边界上的静默改写比报错更危险，所以这里一律返回 null，让调用方把话说清楚。
 */
export function safeOrganFileName(name: string): string | null {
  const raw = name.trim()
  if (!raw) return null
  // 任何路径符号都不收：目录分隔符、`..`、点开头（隐藏文件 / 相对路径）。
  if (raw.includes('/') || raw.includes('\\') || raw.includes('..') || raw.startsWith('.')) return null
  if (!/^[a-zA-Z0-9_-]+$/.test(raw)) return null
  // 下划线开头留给我们自己的模板文件（_template.ts），她的器官不能叫这个。
  if (raw.startsWith('_')) return null
  return raw
}

/**
 * 核心文件的指纹（自检用）。
 *
 * 启动时算一次并存下来，之后每次装载自写器官前比一下：
 * 变了就说明有人（也许不是她，也许是某种自动化）动过核心。
 * 不做"自动恢复"——恢复意味着我们有覆盖权，那又是另一套权限问题；
 * 只留一行醒目的警告，把决定权留给造物主。
 */
export function coreFingerprint(rootDir: string, files: readonly string[]): string {
  const digest = createHash('sha256')
  for (const relative of files) {
    const full = join(rootDir, relative)
    try {
      const info = statSync(full)
      digest.update(`${relative}:${info.size}:${Math.floor(info.mtimeMs)};`)
    } catch {
      digest.update(`${relative}:missing;`)
    }
  }
  return digest.digest('hex').slice(0, 16)
}

/** 默认要盯的核心文件清单。刻意不递归扫整个 src：它应该是一份明确的名单。 */
export const L0_WATCHED_FILES: readonly string[] = [
  'index.ts',
  'src/life-organ.ts',
  'src/organ-host.ts',
  'src/organ-loader.ts',
  'src/organ-net.ts',
  'src/organ-secret.ts',
  'src/organ-compiler.ts',
  'src/auto-approve.ts',
  'genome.json',
] as const
