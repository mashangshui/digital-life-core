/**
 * manifest 的深拷贝与深度冻结（v1.0.2 的 TOCTOU 修复件）
 * ============================================================================
 * 漏洞长什么样：`validateManifest` 只在**装载那一刻**检查能力白名单，
 * 而它检查的那个 `manifest` 对象随后被原样交给器官（`ctx.manifest`）。
 * 于是器官只要在自己的 onLoad 里写一行
 *
 *   ctx.manifest.capabilities.push('llm')      // 或者 push('patch:runtime')
 *
 * 就能在"已经通过校验"之后给自己加权限——校验发生在 T1，使用发生在 T2，
 * 中间那段时间里对象是可变的。这就是 TOCTOU（time-of-check to time-of-use）。
 *
 * 修法不是"再校验一次"（那只是把窗口缩小），而是**让窗口不存在**：
 *   1. 校验通过后立刻深拷贝 + 深度冻结，宿主从此只读这份冻结的副本；
 *   2. 交给器官的是**另一份**深拷贝（也冻结）——器官怎么改都是改它自己脚下那张纸；
 *   3. 能力判定永远读宿主那份冻结副本，所以 `caps.push()` 要么抛（严格模式），
 *      要么改到一份没人看的对象上。两条路都不通。
 *
 * 这个文件不 import 任何东西，所以契约层、宿主、装载器、隔离区都能引它。
 */

/** 深拷贝：只处理 manifest 会出现的形状（对象 / 数组 / 基本类型）。 */
export function deepClone<T>(value: T, seen = new Map<unknown, unknown>()): T {
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return seen.get(value) as T
  if (Array.isArray(value)) {
    const out: unknown[] = []
    seen.set(value, out)
    for (const item of value) out.push(deepClone(item, seen))
    return out as unknown as T
  }
  const out: Record<string, unknown> = {}
  seen.set(value, out)
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = deepClone(item, seen)
  }
  return out as T
}

/**
 * 深度冻结。
 *
 * 必须"深"：`Object.freeze(manifest)` 只冻住第一层，
 * `manifest.capabilities.push('llm')` 照样成功——那正是这个漏洞本来的样子。
 */
export function deepFreeze<T>(value: T, seen = new Set<unknown>()): T {
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return value
  seen.add(value)
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key], seen)
  }
  return Object.freeze(value)
}

/** 拷贝 + 冻结，一步到位：调用方拿到的对象从出生那一刻起就不可写。 */
export function frozenCopy<T>(value: T): T {
  return deepFreeze(deepClone(value))
}

/**
 * 冻结一份"给宿主自己用"的 manifest，同时保证 `capabilities` / `requires` /
 * `net.allow` / `patches` 这些**数组**是独立的副本（不与调用方共享引用）。
 */
export function freezeManifest<T extends object>(manifest: T): Readonly<T> {
  return frozenCopy(manifest)
}

/** 这份对象（含其全部嵌套值）是不是已经被冻住了——测试与自检用。 */
export function isDeeplyFrozen(value: unknown, seen = new Set<unknown>()): boolean {
  if (value === null || typeof value !== 'object') return true
  if (seen.has(value)) return true
  seen.add(value)
  if (!Object.isFrozen(value)) return false
  for (const item of Object.values(value as Record<string, unknown>)) {
    if (!isDeeplyFrozen(item, seen)) return false
  }
  return true
}
