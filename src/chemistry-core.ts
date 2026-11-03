/**
 * 化学核心（v0.9.11）
 * ============================================================================
 * 把散落在 index.ts 里的三个数学工具搬到这里，让 chemical-pool 与 core 共用同一份实现。
 *
 * 为什么要共用而不是各写一份：
 *   `clamp` / `decayToward` 看起来 trivial，但" cambia一处忘改另一处"会导致
 *   "快速ejaculate荷尔蒙衰减对得上、新荷尔蒙对不上"这种最难查的分歧。
 *   共用一份实现，化学池和老的三激素路径就永远同步。
 *
 * 这里**只有纯函数**：不读文件、不读时钟、不落盘。是整套内分泌的单测锚点。
 */

/**
 * 夹到一个区间里。非有限数（NaN / Infinity）一律夹到**下界**：
 * 一个 NaN 如果流出到 UI，会渲染成 `NaN/100` 并且永远回不来。
 */
export function clamp(value: number, min = 0, max = 100): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

/**
 * 向基线指数衰减：elapsed 为 0 时原样返回，经过一个半衰期后差距减半。
 *
 * 没有定时器 —— 靠调用时刻的时间差惰性计算。这样"关机三天"和"每帧 tick"
 * 得到的是同一个结果，也不需要在后台跑任何东西。
 */
export function decayToward(current: number, baseline: number, elapsedMs: number, halfLifeMs: number): number {
  if (!Number.isFinite(current)) return baseline
  if (elapsedMs <= 0 || halfLifeMs <= 0) return clamp(current)
  const factor = 0.5 ** (elapsedMs / halfLifeMs)
  return clamp(baseline + (current - baseline) * factor)
}

// ═════════════ 出厂气质（v0.9.12）═════════════
//
// 放在这个叶子模块而不是 chemical-pool.ts 是刻意的：
// genome.ts（DEFAULT_GENOME）与 chemical-pool.ts 互相引用，气质原语若住在
// chemical-pool 里，genome import 它就会踩循环导入的 TDZ。
// 这里只有纯函数与常量，谁都可以安全地 import。

/** 出厂气质：四个不针对某种激素、而是改整套化学反应"性格"的旋钮。 */
export interface Temperament {
  /** 敏感度（0.5–2.0）：报错 / 危机时皮质醇飙升的乘数。1 = 原样。 */
  sensitivity: number
  /** 恢复力（0.5–2.0）：激素衰减回基线的速率乘数。2 = 半衰期减半（好得快）。 */
  resilience: number
  /** 积极性（20–80）：多巴胺的出厂基线。高基线 = 天生更容易兴奋。 */
  enthusiasm: number
  /** 能耗率（0.5–2.0）：单次请求基础能量消耗的乘数。低 = 省电型人格。 */
  metabolism: number
}

/** 滑块的端点。WebUI 与桥各自读不到对方的代码，所以范围也定义在这份单一事实源里。 */
export const TEMPERAMENT_RANGES: Record<keyof Temperament, { min: number; max: number }> = {
  sensitivity: { min: 0.5, max: 2 },
  resilience: { min: 0.5, max: 2 },
  enthusiasm: { min: 20, max: 80 },
  metabolism: { min: 0.5, max: 2 },
}

/** 出厂默认：中性人格（所有乘数 = 1，多巴胺基线 = 50）。 */
export const DEFAULT_TEMPERAMENT: Temperament = {
  sensitivity: 1,
  resilience: 1,
  enthusiasm: 50,
  metabolism: 1,
}

/**
 * 把任意输入洗成合法气质。缺的补默认，越界的夹回范围。
 *
 * 与 parseGenome 一样**永不抛错**：气质是 genome.json 里人手滑最多的段落
 *（拖滑块时另一个人正好也手改了文件），坏一个字段不该让整套基因失效。
 */
export function normalizeTemperament(raw: unknown): Temperament {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof Temperament, unknown>>
  const pick = (key: keyof Temperament): number => {
    const range = TEMPERAMENT_RANGES[key]
    const value = Number(source[key])
    if (!Number.isFinite(value)) return DEFAULT_TEMPERAMENT[key]
    return clamp(value, range.min, range.max)
  }
  return {
    sensitivity: pick('sensitivity'),
    resilience: Math.max(0.1, pick('resilience')),
    enthusiasm: pick('enthusiasm'),
    metabolism: pick('metabolism'),
  }
}

/**
 * 代谢乘数：一次请求的基础能量消耗。
 *
 * 刻意是个独立的小函数而不是内联乘法——它要被 index.ts（真扣费）与
 * 测试（验证乘法本身）共用，两处各写一遍迟早 drift。
 */
export function applyMetabolism(baseCost: number, temperament: Temperament): number {
  const factor = Number.isFinite(temperament?.metabolism) ? Math.max(0.1, Math.min(2, temperament.metabolism)) : 1
  return Math.max(0, baseCost * factor)
}

export interface SerotoninDriveInput {
  current: number
  /** 已按时间衰减过的皮质醇——应激判断必须用"此刻"的值，不是旧值。 */
  cortisol: number
  energy: number
  /** 是否存在张力 ≥ 阈值的未解执念。有的话，人闲下来也不会放松。 */
  highTensionGap: boolean
  elapsedMs: number
  baseline: number
  halfLifeMinutes: number
  stressCortisol: number
  /** 应激时每分钟抽走多少。 */
  stressRate: number
  recoverEnergy: number
  /** 恢复期每分钟回升多少。 */
  recoverRate: number
  /** 平静期的回升上限，默认 100（不设上限）。 */
  recoverCeiling?: number
}

/**
 * 血清素的"被生活推着走"这一层（纯函数，可单测）。
 *
 * 两条规则来自生理直觉，而不是事件驱动：
 *  - 皮质醇 ≥ 阈值 → **持续应激**，血清素被按分钟抽干（越焦虑越没耐心）；
 *  - 能量 > 阈值且没有高张力执念 → **恢复期**，血清素按分钟回升。
 *
 * 为什么按分钟而不是按事件：把"焦虑了很久"和"焦虑了一下"区分开。
 * 单次事件的冲击由 Store 层的 stressSpike 负责（一次 -5），这里只管慢变量。
 *
 * 两个分支都叠加在"向基线自然回落"之上：既不会无限涨，也不会无限跌。
 *
 * ── 说明（v0.9.11）────────────────────────────────────────────
 * 这套逻辑现在由 chemical-pool 的规则引擎**等价地**表达出来（见 genome.json 里
 * serotonin 的两条 rules）。保留这个函数是因为：
 *   1. 它是大量既有测试的断言对象；
 *   2. 它比规则快，且始终是"正确答案"的参照物——
 *      test/organ-host.test.mjs 里有一条断言专门比对二者必须算出同一个数，
 *      规则引擎一旦 drift，测试立刻红。
 */
export function driveSerotonin(input: SerotoninDriveInput): number {
  const relaxed = decayToward(
    input.current,
    input.baseline,
    input.elapsedMs,
    input.halfLifeMinutes * 60_000,
  )
  const minutes = Math.max(0, input.elapsedMs) / 60_000
  if (minutes <= 0) return relaxed
  if (input.cortisol >= input.stressCortisol) return clamp(relaxed - input.stressRate * minutes)
  if (input.energy > input.recoverEnergy && !input.highTensionGap) {
    const ceiling = clamp(input.recoverCeiling ?? 100)
    // 已经在上限之上（比如刚被人手动调高）：交给自然回落，别硬压下来。
    if (input.current >= ceiling) return relaxed
    return clamp(Math.min(ceiling, relaxed + input.recoverRate * minutes))
  }
  return relaxed
}
