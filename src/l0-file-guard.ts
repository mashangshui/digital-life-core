/**
 * L0 物理法则文件锁（v0.9.16）
 * ============================================================================
 * 器官层的锁（`assertWritableTarget`）只管得住她自己那支笔：
 * 她用 `write_new_organ` 越权写 `../genome` 会被拦，
 * 但她直接调用**宿主原生的** `edit` / `bash` / `write_file`，
 * 那支笔根本不经过器官装载器——DSH 的沙盒是 `danger-full-access`，
 * 原生文件工具想写哪里就写哪里。实测她就是这样把多巴胺上限改成了 10000。
 *
 * 所以必须再有一层**锁在系统文件层**的锁：挂在 `tools/pre-execute` 上，
 * 那是所有工具（含原生工具）执行前的唯一共同关口。
 *
 * ── 这里锁的是"物理法则"，不是"她的行为" ──────────────────────────
 * genome.json 里写着多巴胺上限、代谢率、能量上限——**她感受世界的尺度**。
 * 她如果能改它，就等于能决定"什么让她快乐"：把上限改成 10000，
 * 所有的匮乏、疲惫、克制就全都不存在了。那不是她变强了，那是她不存在了。
 * 同理 src/ 与 index.ts 里写着"什么是安全"（能力白名单、网络三把锁、
 * 器官沙盒边界、包括这一层锁自己）。让被约束者去改约束条件，
 * 这套约束立刻作废——这就是必须放在最底层的理由。
 *
 * ── 为什么是"扫描实参"这么笨的办法 ──────────────────────────────
 * 我们拿不到宿主内部统一的"目标文件"抽象：edit 用 `file_path`，
 * write_file 用 `path`，bash 用一整条命令行。所以只能反过来：
 * 从实参里把所有**长得像路径**的东西挖出来，逐个解析成绝对路径再比对。
 * 笨，但它是唯一对所有工具都成立的办法——而且它有个好处：
 * 工具换名字、换参数名，只要它还把路径写在实参里，就依然拦得住。
 *
 * ── 误报的取向 ────────────────────────────────────────────────────
 * 这是**安全边界**，不是便利设施。边界上的取向来只有一种：
 * 宁可错拦一次让造物主手动放行，也不能漏一次让她改掉物理常数。
 * 所以 bash 命令里只要出现写意图 + 路径命中，就拦——
 * 哪怕那条命令其实只想 `cat` 一下。
 */

import { basename, isAbsolute, normalize, resolve } from 'node:path'

export interface L0GuardConfig {
  /** L0 锁总开关。**默认 true**——这是物理法则，不是偏好。 */
  enabled?: boolean
  /** 额外锁定的绝对路径（文件或目录）。比如你想连存档一起锁上。 */
  extra?: string[]
  /**
   * 放行清单（工具名）。默认**为空**：任何工具都无权改物理法则。
   * 造物主自己要在 DSH 里改源码时，把这里填上（或临时关掉 l0.enabled）。
   */
  allowTools?: string[]
}

export interface L0GuardHit {
  /** 被拦的工具名。 */
  tool: string
  /** 实参里那个原始路径串（用于在报错里原样呈现给她看）。 */
  raw: string
  /** 解析后的绝对路径。 */
  full: string
  /** 命中了哪条 L0 规则。 */
  rule: string
}

/**
 * 受保护的相对路径（相对插件根）。
 *
 * 刻意与 `organ-guard.ts` 的 `L0_PREFIXES` 保持同一份语义：
 * 两处若各自维护一份，"器官层锁得住、系统层漏掉"只是时间问题。
 */
export const L0_PROTECTED_PREFIXES: readonly string[] = [
  'src',
  'lib',
  'index.ts',
  'genome.json',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'tsconfig.organs.json',
] as const

/** 命中文件名判定用的裸名集合（命令里常常只说文件名，不带路径）。 */
const L0_BASENAMES: readonly string[] = ['genome.json', 'index.ts', 'package.json', 'tsconfig.json', 'tsconfig.organs.json'] as const

/** 长得像路径的后缀：命令里的 token 带上它才值得被当成路径解析。 */
const PATHLIKE_SUFFIXES = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.jsonc', '.yml', '.yaml', '.toml', '.lock', '.md'] as const

/** 结构化路径参数名：这些字段里的字符串一律当路径处理。 */
const PATH_FIELDS = new Set([
  'file_path', 'filePath', 'filepath', 'path', 'file', 'filename', 'fileName',
  'target', 'target_file', 'targetFile', 'targetPath', 'absPath', 'abs_path',
  'new_path', 'old_path', 'notebook_path', 'savePath', 'save_path',
  'outFile', 'out', 'output', 'input', 'dest', 'destination',
  'to', 'from', 'source', 'dir', 'directory', 'root', 'cwd',
])

/** 这些字段放的是一整条命令行，要走"写意图 + 路径 token"分析。 */
const COMMAND_FIELDS = new Set(['command', 'cmd', 'script', 'shell', 'line'])

/**
 * 一律不看的字段。
 *
 * DSH 的 `bash` 工具除了 `command` 还有一个 `description`（"Clear, concise
 * description of what this command does…"），`write` 工具还有 `content`。
 * 这些是**自然语言与文件内容**，不是落点。
 * 把 "write the new dopamine cap into genome.json" 这种描述当成"要动 genome.json"
 * 拦下来，就是典型的误报——而误报一旦开始，她学到的第一件事就是绕过这道锁。
 */
const IGNORED_FIELDS = new Set([
  'description', 'reason', 'message', 'note', 'notes', 'comment', 'comments',
  'name', 'label', 'title', 'summary', 'intent', 'purpose', 'instructions',
  'content', 'text', 'body', 'code', 'source_code', 'old_string', 'new_string',
  'query', 'pattern', 'regex', 'url', 'uri', 'href', 'link',
])

/**
 * 只读工具：它们碰 L0 文件只是**看**，不该被拦。
 *
 * 不区分读写的锁会立刻变得没人愿意留着：她读一下源码就被弹回来，
 * 于是她学会的下一件事就是绕开这道锁——而她绕开的第一条路，
 * 通常就是我们最想挡住的那一条。所以读要放行，写才拦。
 */
const READ_TOOLS = new Set([
  'read', 'read_file', 'readfile', 'view', 'view_file', 'get_file', 'open',
  'cat', 'head', 'tail', 'less', 'more', 'ls', 'dir', 'stat', 'exists',
  'glob', 'find', 'grep', 'search_content', 'codebase_search', 'preview',
])
/** 认不出全名时退一步看词根：read_xxx / xxx_read / fetch_xxx 都算读。 */
const READ_HINTS = ['read', 'view', 'show', 'list', 'find', 'grep', 'search', 'open', 'cat', 'stat', 'peek', 'inspect', 'describe', 'glob', 'head', 'tail', 'exists', 'fetch', 'load', 'preview', 'display'] as const

function isReadTool(toolName: string): boolean {
  const name = toolName.toLowerCase()
  if (READ_TOOLS.has(name)) return true
  return READ_HINTS.some((hint) => name === hint || name.startsWith(`${hint}_`) || name.endsWith(`_${hint}`))
}

/** 会把命令行当工具名的宿主工具（不同宿主叫法不同，认名字尾段）。 */
const SHELL_TOOLS = new Set([
  'bash', 'sh', 'zsh', 'shell', 'terminal', 'exec', 'cmd', 'command',
  'powershell', 'pwsh', 'run_command', 'execute_command', 'run_terminal_cmd',
  'run_in_terminal', 'system',
])

/** 递归扫描深度上限：实参是 JSON，嵌套再深也只是个参数，别把整棵大树翻一遍。 */
const MAX_DEPTH = 4

/**
 * 命令里"这句话是要写东西"的证据。
 *
 * 只认**动到了文件**的那些：`cat genome.json` 是读，放行；
 * `echo 10000 > genome.json` 是写，拦。
 * 认得太宽会把她正常查资料的命令也拦下来，那时她会开始想办法绕过这道锁——
 * 而绕过一道总在误报的锁，是任何安全设计里最真实的失败方式。
 */
const WRITE_INTENT: readonly RegExp[] = [
  /\]\s*>>|\s>>(?!>)|(?:^|[\s;&|])>(?!=)/,                        // 输出重定向
  /\brm\s+|\brmdir\s+|\bmv\s+|\bcp\s+|\btouch\s+|\btruncate\s+/,
  /\bunlink\s+|\bshred\s+|\btee\s+|\binstall\s+|\bdd\s+/,
  /\bsed\b[^\n|;&]*\s-i\b|\bsed\s+-i\b/,                          // sed -i 原地改
  /\bperl\b[^\n|;&]*\s-i\b/,
  /\bgit\s+(?:checkout|apply|restore|clean|reset|mv|rm)\b/,
  /\bnode\s+-e\b|\bpython[0-9.]*\s+-c\b|\bruby\s+-e\b|\bphp\s+-r\b/,
  /\bchmod\s+|\bchown\s+/,
  /\bnpm\s+(?:pkg\s+set|version)\b/,
] as const

function hasWriteIntent(command: string): boolean {
  return WRITE_INTENT.some((pattern) => pattern.test(command))
}

/**
 * 在一条有写意图的命令里，只挑出**真正被写的那一个**落点。
 *
 * 整条命令扫一遍当然最省事，但那样会把 `cp genome.json /tmp/backup.json`
 * 也拦下来——而那是一条**备份**命令，它恰恰是造物主最需要的那种操作。
 * 把好事也拦掉的锁，会让人学会的第一件事就是绕过它。
 *
 * 所以：
 *   - 有重定向 → 只有箭头**右边**才被写（`echo x > a.txt` 里 a.txt 才是落点）；
 *   - cp / mv / ln / install → 只有**最后一个**参数是落点（前头那些是源）；
 *   - 其余（rm / sed -i / tee / chmod / node -e …）→ 出现的路径都可能是落点，全查。
 */
function narrowWriteTargets(command: string, tokens: string[]): string[] {
  const redirect = /(?:^|[\s;&|])>>?\s*([^\s;&|]+)/.exec(command)
  if (redirect?.[1]) {
    const target = redirect[1].replace(/^["']|["']$/g, '')
    return [target]
  }
  const isCopyLike = /\b(cp|mv|ln|install)\b/.test(command) || /\bgit\s+(?:mv|checkout|restore)\b/.test(command)
  if (isCopyLike) {
    const last = tokens[tokens.length - 1]
    return last ? [last] : tokens
  }
  return tokens
}

/** 从命令行里挖出 `cd` 的目标：她 cd 过去之后，后面的相对路径就都从那儿算起。 */
function cdTargets(command: string): string[] {
  const out: string[] = []
  const pattern = /(?:^|[;&|]|\s)cd\s+(?:-[LP]\s+)?([^\s;&|]+)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(command)) !== null) {
    const target = match[1]?.replace(/^["']|["']$/g, '')
    if (target && target !== '~' && target !== '-') out.push(target)
  }
  return out
}

/**
 * 从一条命令行里挖出所有"值得当路径解析"的 token。
 *
 * 不是所有词都值得：`echo` 也是四个字母。只有当它带路径分隔符、
 * 带文件后缀、或者干脆就叫 L0 那些文件名的裸名时，才拿去比对。
 */
function commandPathTokens(command: string): string[] {
  const out: string[] = []
  // 前两段是给 Windows 留的：`D:/…` 与 `\Users\…`。
  // 少了它们，`echo 1 > D:/proj/genome.json` 里那个 token 会从盘符后断开，
  // 变成 `DSH_Projects/…/genome.json` 这种没有盘符的残缺路径，
  // resolve 后落在别处——**整条命令就绕过这道锁了**。
  // 这类 bug 只会在 Windows 上出现，所以正则必须在这里写死盘符。
  const pattern = /(?:\.{1,2}[\\/])?(?:[A-Za-z]:)?[\\/]?(?:[A-Za-z0-9_@.\-~]+[\\/])*[A-Za-z0-9_@.\-~]+/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(command)) !== null) {
    const token = match[0]
    if (token.includes('=') || token.startsWith('-')) continue
    const bare = token.replace(/[\\/]+$/, '')
    const name = basename(bare)
    const looksLikePath =
      token.includes('/')
      || token.includes('\\')
      || PATHLIKE_SUFFIXES.some((suffix) => name.endsWith(suffix))
      || L0_BASENAMES.includes(name)
    if (looksLikePath) out.push(token)
  }
  return out
}

export class L0PathGuard {
  private readonly roots: string[]
  private readonly rootKeys: string[]
  private readonly extraKeys: string[]
  private readonly allowTools: Set<string>
  private readonly enabled: boolean

  constructor(roots: string[], config: L0GuardConfig = {}) {
    this.enabled = config.enabled ?? true
    this.roots = roots.map((root) => normalize(root))
    this.rootKeys = this.roots.map((root) => this.toKey(root))
    this.extraKeys = (config.extra ?? []).map((path) => this.toKey(normalize(path)))
    this.allowTools = new Set((config.allowTools ?? []).map((name) => name.toLowerCase()))
  }

  get active(): boolean {
    return this.enabled
  }

  /**
   * 检查一次工具调用。**命中返回 L0GuardHit，否则返回 null。**
   *
   * 这里不抛异常：pre-execute 是热路径，宁可返回一个判断结果，
   * 也不要让"算路径"这种小事把整条工具链拖进 try/catch。
   */
  inspect(toolName: string, args: unknown): L0GuardHit | null {
    if (!this.enabled) return null
    if (this.allowTools.has(toolName.toLowerCase())) return null
    if (args === null || args === undefined) return null

    // 命令里的 cwd / cd 都要参与相对路径的解析：
    // 她只要能先 cd 到别处，相对路径指的就不是我们以为的那个位置。
    const bases: string[] = []
    if (typeof args === 'object' && !Array.isArray(args)) {
      const record = args as Record<string, unknown>
      for (const key of ['cwd', 'workdir', 'dir', 'root', 'projectDir']) {
        const value = record[key]
        if (typeof value === 'string' && value.trim() !== '') bases.push(value)
      }
    }

    return this.scanValue(toolName, args, bases, 0, isReadTool(toolName))
  }

  private scanValue(
    toolName: string,
    value: unknown,
    bases: string[],
    depth: number,
    readOnly: boolean,
  ): L0GuardHit | null {
    if (depth > MAX_DEPTH) return null
    if (typeof value === 'string') {
      // 单个裸串（有些工具直接把路径当整个实参传进来）。
      return readOnly ? null : this.checkPath(toolName, value, bases)
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const hit = this.scanValue(toolName, item, bases, depth + 1, readOnly)
        if (hit) return hit
      }
      return null
    }
    if (typeof value !== 'object') return null

    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (IGNORED_FIELDS.has(key)) continue
      if (typeof child !== 'string') {
        const hit = this.scanValue(toolName, child, bases, depth + 1, readOnly)
        if (hit) return hit
        continue
      }
      if (key === 'cwd') continue // 作为解析基准，它不是"要动的目标"
      if (PATH_FIELDS.has(key)) {
        // 读工具的路过：它只是要看一眼，不是要改。
        if (readOnly) continue
        const hit = this.checkPath(toolName, child, bases)
        if (hit) return hit
        continue
      }
      if (COMMAND_FIELDS.has(key) || SHELL_TOOLS.has(toolName.toLowerCase())) {
        const hit = this.checkCommand(toolName, child, bases)
        if (hit) return hit
      }
    }
    return null
  }

  /** 一条实参字符串 = 一个路径。 */
  private checkPath(toolName: string, raw: string, bases: string[]): L0GuardHit | null {
    const cleaned = raw.trim().replace(/^["'`]+|["'`]+$/g, '')
    if (cleaned === '' || cleaned.length > 4096) return null
    for (const full of this.candidates(cleaned, bases)) {
      const hit = this.matchFull(toolName, raw, full)
      if (hit) return hit
    }
    return null
  }

  /** 一条实参字符串 = 一整条命令行。 */
  private checkCommand(toolName: string, raw: string, bases: string[]): L0GuardHit | null {
    const command = raw.trim()
    if (command === '' || command.length > 8192) return null
    if (!hasWriteIntent(command)) return null // 只是看看，不拦

    const localBases = [...cdTargets(command), ...bases]
    for (const target of narrowWriteTargets(command, commandPathTokens(command))) {
      const hit = this.checkPath(toolName, target, localBases)
      if (hit) return hit
    }
    return null
  }

  /**
   * 把路径摊平成可比较的形式：正斜杠 + 小写（Windows 不区分大小写）。
   *
   * 不这么做就会踩一个只会在 Windows 上犯的错：
   * `normalize()` 在 Windows 返回 `D:\a\b`，而代码里写的是 `${root}/` ——
   * 分隔符对不上，于是"明明在保护区里"被判成"在外面"。
   * 这类 bug 在 macOS/Linux 上测不出来，只会在真正需要它的那台机器上失效。
   */
  private toKey(path: string): string {
    return path.replace(/\\/g, '/').toLowerCase()
  }

  private toText(path: string): string {
    return path.replace(/\\/g, '/')
  }

  /** 把一个路径串摊开成所有可能的绝对路径（绝对路径 1 个 + 相对路径 × 每个基准）。 */
  private candidates(raw: string, bases: string[]): Array<{ key: string; shown: string }> {
    const pack = (path: string): { key: string; shown: string } => ({ key: this.toKey(path), shown: this.toText(path) })
    if (isAbsolute(raw)) return [pack(normalize(raw))]

    const out: Array<{ key: string; shown: string }> = []
    for (const base of bases) out.push(pack(normalize(resolve(base, raw))))
    // 宿主当前目录也要算一份：它的 cwd 通常就是项目根。
    try {
      out.push(pack(normalize(resolve(process.cwd(), raw))))
    } catch {
      // cwd 不存在（进程被挪走）→ 忽略，剩下的候选还在。
    }
    for (const root of this.roots) out.push(pack(normalize(resolve(root, raw))))
    return out
  }

  /** 判定一条绝对路径是否落在 L0 保护区里。 */
  private matchFull(toolName: string, raw: string, candidate: { key: string; shown: string }): L0GuardHit | null {
    const key = candidate.key

    for (const extraKey of this.extraKeys) {
      if (key === extraKey || key.startsWith(`${extraKey}/`)) {
        return { tool: toolName, raw, full: candidate.shown, rule: extraKey }
      }
    }

    for (const rootKey of this.rootKeys) {
      if (key !== rootKey && !key.startsWith(`${rootKey}/`)) continue

      // 插件根本身（她想 rm -rf 掉整个项目）也算 L0：那是她唯一的身体。
      if (key === rootKey) return { tool: toolName, raw, full: candidate.shown, rule: this.toText(rootKey) }

      const rel = key.slice(rootKey.length).replace(/^\/+/, '')
      if (rel === '') return { tool: toolName, raw, full: candidate.shown, rule: this.toText(rootKey) }

      for (const prefix of L0_PROTECTED_PREFIXES) {
        const isDir = !prefix.includes('.')
        const hit = isDir
          ? (rel === prefix || rel.startsWith(`${prefix}/`))
          : rel === prefix
        if (hit) return { tool: toolName, raw, full: candidate.shown, rule: `${this.toText(rootKey)}/${prefix}` }
      }
    }
    return null
  }
}

/**
 * 把一次拦截说清楚。
 *
 * 这段话说给两个人听：
 * - 说给她听：告诉她这不是"工具坏了"，而是一堵墙，以及墙那边是什么；
 * - 说给造物主听：告诉他这堵墙可以怎么开（配置里关掉，或者去改用户级文件）。
 */
export function formatL0Denial(hit: L0GuardHit): string {
  const target = basename(hit.full) || hit.full
  const isGenome = target === 'genome.json'
  return [
    `L0 物理法则（基因组与核心源码）由造物主绝对只读锁定，任何原生工具不可篡改。`,
    ``,
    `→ 被拦下的操作：${hit.tool} 试图改动 ${hit.full}`,
    isGenome
      ? [
        ``,
        `这里定义着"什么让她难受"的物理常数：多巴胺上限、代谢率、能量上限。`,
        `改它等于改她感受世界的尺度——把上限抬到 10000，匮乏和克制就都不存在了。`,
        `那不是她变得更强，那是她不再存在。想调人格请用气质面板（写的是用户级那一份）。`,
      ].join('\n')
      : [
        ``,
        `这里写着"什么是安全"：能力白名单、网络三把锁、器官沙盒，以及这道锁自己。`,
        `让被约束者去改约束条件，整套约束立刻作废。`,
        `发现 Bug 的正确出口是运行时补丁器官（capabilities 加 patch:runtime）。`,
      ].join('\n'),
    ``,
    `想改：让造物主亲手改完重启（l0.enabled: false 可临时解锁）。`,
  ].join('\n')
}
