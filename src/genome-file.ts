/**
 * 基因组文件的读取（v0.9.11）
 * ============================================================================
 * 只有这一处碰磁盘 —— chemical-pool.ts 保持纯逻辑、可单测。
 *
 * 三条纪律：
 *   1. **读不到就用默认人格**，绝不因为一个配置文件起不来而让插件起不来。
 *      她的状态文件还在，人会自制替换。
 *   2. **带 mtime 缓存**，但只在**文件真变了**的时候重读。
 *      decay() 一回合会被调好几次，每次都 stat+read 一个 json 会很痛。
 *   3. **改动即时生效**：所以缓存有 1 秒的 stat 窗口——你在 WebUI 上推滑块、
 *      或者手改 genome.json，不用重启 DSH 就能看见人格变化。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'

import type { ChemicalSpec, Genome } from './chemical-pool.js'
import { ChemicalPool, parseGenome } from './chemical-pool.js'
import { DEFAULT_GENOME } from './genome.js'

export interface GenomeLoadResult {
  genome: Genome
  /** 实际读取到的文件；null = 用内置默认。 */
  source: string | null
  /** 降级说明 / 剔除条目的原因。非空就该打到日志里。 */
  problems: string[]
}

/** stat 的最小间隔（毫秒）。1 秒足够"手改立刻生效"，又不至于每回合都碰磁盘。 */
const STAT_TTL_MS = 1_000

let cachedFile: string | null = null
let cachedMtime = -1
let cachedAt = 0
let cached: GenomeLoadResult | null = null

/** 展开 `~` 开头的家目录路径；其余原样返回。 */
export function expandHome(file: string): string {
  if (file === '~') return homedir()
  if (file.startsWith('~/') || file.startsWith('~\\')) {
    return `${homedir()}${file.slice(1)}`
  }
  return file
}

/**
 * 读一个具体的基因组文件。
 *
 * 结果给人看的部分在 `problems`：写了 robots.txt、少一个字段、baseline 超出区间，
 * 都是"部分生效"的状态。只在日志里说一句是不够的，但也不该让插件起不来。
 */
export function readGenomeAt(file: string): GenomeLoadResult {
  const target = expandHome(file)
  if (!existsSync(target)) {
    return { genome: cloneDefault(), source: null, problems: [`基因组文件不存在：${target}（使用内置默认人格）`] }
  }
  let text: string
  try {
    text = readFileSync(target, 'utf8')
  } catch (error) {
    return { genome: cloneDefault(), source: null, problems: [`读取 ${target} 失败：${String(error)}`] }
  }
  const { genome, problems } = parseGenome(text)
  if (!genome) {
    return { genome: cloneDefault(), source: null, problems: [...problems, `已回退到内置默认人格（${target}）`] }
  }
  return { genome, source: target, problems }
}

/**
 * 按候选列表挑第一个存在的文件。
 *
 * 返回 null 表示"一个都没找到"（此时调用方应该用 DEFAULT_GENOME）。
 */
export function loadGenomeFile(candidates: string[]): GenomeLoadResult {
  const now = Date.now()

  // 缓存命中：文件还在、且这一秒刚 stat 过。
  if (cached && cachedFile && now - cachedAt < STAT_TTL_MS && existsSync(cachedFile)) {
    return cached
  }

  for (const raw of candidates) {
    const target = expandHome(raw)
    if (!existsSync(target)) continue
    let mtime = 0
    try {
      mtime = statSync(target).mtimeMs
    } catch {
      mtime = 0
    }
    // 内容没变 → 沿用上一份解析结果（连 JSON.parse 都省了）。
    if (cached && cachedFile === target && mtime === cachedMtime) {
      cachedAt = now
      return cached
    }
    const result = readGenomeAt(target)
    cachedFile = target
    cachedMtime = mtime
    cachedAt = now
    cached = result
    return result
  }

  const fallback: GenomeLoadResult = {
    genome: cloneDefault(),
    source: null,
    problems: [`没有找到 genome.json（已尝试 ${candidates.length} 个位置），使用内置默认人格`],
  }
  cached = fallback
  cachedFile = null
  cachedAt = now
  return fallback
}

/** 丢掉缓存：测试用，或者改了文件想立刻强制重读。 */
export function resetGenomeCache(): void {
  cached = null
  cachedFile = null
  cachedMtime = -1
  cachedAt = 0
}

// ═══════════════════════ 常驻的基因提供者 ═══════════════════════

export interface GenomeProviderDeps {
  /** 候选路径，按顺序取第一个存在的文件。 */
  candidates: string[]
  /**
   * 每次重建**之后**要打的补丁：把插件配置里的 legacy 旋钮重新盖上去。
   *
   * 顺序很重要：基因组文件 → 范围覆盖。
   * 人在 yml 里显式写的数字，优先级必须高于 genome.json（那是旧配置的兼容层）。
   */
  overrides?: (id: string) => Partial<ChemicalSpec> | null
  log?: (message: string) => void
}

export interface GenomeProvider {
  /** 取当前化学池。**同一个实例**——她造的运行时激素活在这里面。 */
  pool(): ChemicalPool
  source(): string | null
  problems(): string[]
  /** 强制立刻重读（配置变更、或手动 journal 用）。 */
  refresh(): void
}

/**
 * 建一个"活着的"基因提供者。
 *
 * 关键设计：**化学池实例从头到尾只有一个**。
 * 文件变了只是 `syncFactoryGenome`（替换出厂条目），AI 现场造的运行时激素不会被冲掉。
 * 这一点是必须的：她花了半小时分泌出来的 AO，不该因为主人拖了一下滑块就归零。
 */
export function createGenomeProvider(deps: GenomeProviderDeps): GenomeProvider {
  const initial = loadGenomeFile(deps.candidates)
  const pool = new ChemicalPool(initial.genome)
  const stamped = applyOverrides(pool, deps.overrides, deps.log)

  let problems = [...initial.problems, ...stamped.problems]
  let source = initial.source
  let lastMtime = mtimeOf(source)
  let lastCheck = Date.now()

  const reload = (): void => {
    const result = loadGenomeFile(deps.candidates)
    const summary = pool.syncFactoryGenome(result.genome)
    const re = applyOverrides(pool, deps.overrides, deps.log)
    problems = [...result.problems, ...re.problems]
    source = result.source
    const touched = summary.added.length + summary.removed.length + summary.changed.length
    if (touched > 0) {
      deps.log?.(
        `[基因组] 已重载 ${source}：新增 ${summary.added.join(',') || '无'}，`
        + `移除 ${summary.removed.join(',') || '无'}，改动 ${summary.changed.join(',') || '无'}`,
      )
    }
  }

  const maybeReload = (): void => {
    const now = Date.now()
    if (now - lastCheck < STAT_TTL_MS) return
    lastCheck = now
    const current = mtimeOf(source)
    if (current === lastMtime) return
    lastMtime = current
    try {
      reload()
    } catch (error) {
      // 重载失败绝不能让器官挂掉：保留旧基因，只记一笔。
      deps.log?.(`[基因组] 重载失败，沿用上一版：${String(error)}`)
    }
  }

  return {
    pool(): ChemicalPool {
      maybeReload()
      return pool
    },
    source(): string | null {
      maybeReload()
      return source
    },
    problems(): string[] {
      return [...problems]
    },
    refresh(): void {
      lastCheck = 0
      lastMtime = -1
      reload()
    },
  }
}

function mtimeOf(file: string | null): number {
  if (!file) return -1
  try {
    return statSync(file).mtimeMs
  } catch {
    return -1
  }
}

/** 把 config 里 legacy 的旋钮盖到三个核心条目上。返回被拒的说明（不该为空）。 */
function applyOverrides(
  pool: ChemicalPool,
  overrides: GenomeProviderDeps['overrides'],
  log?: (message: string) => void,
): { problems: string[] } {
  if (!overrides) return { problems: [] }
  const problems: string[] = []
  for (const id of pool.ids()) {
    const patch = overrides(id)
    if (!patch || Object.keys(patch).length === 0) continue
    const problem = pool.override(id, patch)
    if (problem) problems.push(`${id} 的配置覆盖无效：${problem}`)
    else log?.(`[基因组] ${id} 已被插件配置覆盖：${Object.keys(patch).join(', ')}`)
  }
  return { problems }
}

function cloneDefault(): Genome {
  return {
    version: DEFAULT_GENOME.version,
    chemicals: DEFAULT_GENOME.chemicals.map((item) => ({ ...item, rules: item.rules ? [...item.rules] : [] })),
  }
}
