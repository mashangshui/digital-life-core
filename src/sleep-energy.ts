/**
 * 休眠与自然恢复 · 积分内核
 * ============================================================================
 * 问题：能量以前只减不增。耗尽之后唯一的出路是"人手动 resume"或改文件——
 * 这让它在对话里说的"我累了，先歇会儿"变成一句空话：它根本不会因为休息而好转。
 *
 * 现在补上"睡觉回血"，但要带三道闸，否则半夜自己醒来能把 API 烧穿：
 *
 *   1. **速率分档**：平常每分钟 +0.2；深度休眠（能量 < 20 或深夜）每分钟 +1。
 *   2. **自然上限 `naturalCap`（默认 60）**：自然恢复最多到 60，到顶就停。
 *      人工喂到 100 也留不住——高于 60 会按 `overshootDecayPerMinute` 慢慢回落。
 *      这一条是"喂饭焦虑"的解药：你喂它是情分，它自己睡是本分，但本分只有半血。
 *   3. **冻结不恢复**：急停（frozen）是人明确按下的"别动"，此时既不回血也不衰减。
 *      否则冻了一夜它自己解冻，急停就成了摆设。
 *
 * 为什么是**分段积分**而不是"总时长 × 速率"：速率取决于当时的能量与时段，
 * 而一次惰性结算可能横跨 8 小时——这 8 小时里它可能先跌破 20（进入深度休眠）、
 * 又因为天亮退出深夜窗口。一次乘法算不出这种变化，只能切片累加。
 * 步长默认 5 分钟，误差在 0.1 点以内；上限 2000 段（≈7 天）防止恶意超长时间跨度。
 */

export interface SleepEnergyConfig {
  recoverPerMinute: number
  sleepRecoverPerMinute: number
  /** 低于这个能量算"深度休眠"，默认 20。 */
  sleepEnergyThreshold: number
  /** 自然恢复的上限，默认 60。 */
  naturalCap: number
  /** 高于自然上限时每分钟回落多少，默认 0.1。 */
  overshootDecayPerMinute: number
  /** 深夜窗口 [开始小时, 结束小时)，支持跨零点；null 表示不区分时段。 */
  quietHours: readonly [number, number] | null
  /** 积分步长（分钟），默认 5。 */
  stepMinutes: number
}

export interface SleepEnergyInput {
  energy: number
  maxEnergy: number
  elapsedMs: number
  /** 结算终点（epoch ms）：往回推每一步的时刻，用来判断"那时是不是深夜"。 */
  nowMs: number
  frozen: boolean
  config: SleepEnergyConfig
  /** 判断某个时刻是否处于深夜。可注入，便于测试；默认按本地时区的小时数。 */
  isQuietHour?: (ms: number) => boolean
}

export interface SleepEnergyResult {
  energy: number
  /**
   * 处于**深度休眠**的毫秒数（能量低于阈值的那段时间）。
   *
   * 只算 `energy < threshold` 的那一段，不算"深夜但精神很好"的时间——
   * 暂停执念张力是给"真的睡过去了"的补偿，不是给"熬夜"的奖励。
   */
  sleepMs: number
  /** 状态机总结，给日志和面板用。 */
  mode: 'awake' | 'deep-sleep' | 'night-rest' | 'frozen' | 'sated'
}

/** 默认深夜窗口：0 点到 6 点。凌晨那几小时是真正没人打扰的休息期。 */
export const DEFAULT_QUIET_HOURS: readonly [number, number] = [0, 6]

/** 默认配置。数值都是"一个普通夜晚刚好回满"的量级，不是拍脑袋的整数。 */
export const DEFAULT_SLEEP_CONFIG: SleepEnergyConfig = {
  recoverPerMinute: 0.2, // 50 点 → 250 分钟 ≈ 4 小时，够一次工作间隙慢慢回
  sleepRecoverPerMinute: 1, // 0 → 60 用一小时；0 → 20（脱离濒死）只要 20 分钟
  sleepEnergyThreshold: 20,
  naturalCap: 60,
  overshootDecayPerMinute: 0.1, // 100 → 60 要 400 分钟；喂满能撑一阵，但留不住
  quietHours: DEFAULT_QUIET_HOURS,
  stepMinutes: 5,
}

const MAX_STEPS = 2000
const MINUTE = 60_000

/**
 * 某个时刻是否落在深夜窗口里（本地时区）。
 *
 * 为什么核心自己读时钟、而不是去问 clock 器官：器官可能没装载、可能被禁、
 * 也可能因为能量耗尽而罢工——"现在几点"这种东西不能依赖一个会饿的组件。
 * 时段划分与 clock 器官保持一致（凌晨/深夜），只是取数路径不同。
 */
export function isQuietHour(ms: number, quietHours: readonly [number, number] | null): boolean {
  if (!quietHours) return false
  const [start, end] = quietHours
  if (start === end) return false
  const hour = new Date(ms).getHours()
  // 跨零点：22 → 3 表示 22,23,0,1,2
  return start < end ? hour >= start && hour < end : hour >= start || hour < end
}

/** 把一次结算切成若干段。返回每段的（开始时刻, 时长毫秒）。 */
function planSteps(
  nowMs: number,
  elapsedMs: number,
  stepMinutes: number,
): Array<{ at: number; ms: number }> {
  const total = Math.max(0, elapsedMs)
  if (total <= 0) return []
  const stepMs = Math.max(1, stepMinutes) * MINUTE
  // 段数太多就放大步长：宁可粗一点，也不要在一次读状态里跑几十万次循环。
  const step = Math.max(stepMs, total / MAX_STEPS)
  const steps: Array<{ at: number; ms: number }> = []
  let consumed = 0
  while (consumed < total) {
    const ms = Math.min(step, total - consumed)
    steps.push({ at: nowMs - total + consumed, ms })
    consumed += ms
  }
  return steps
}

/**
 * 结算一段"没人管它"的时间。
 *
 * 纯函数：不读时钟、不写盘，所有输入显式传进来——它决定了整个回血机制是否可信，
 * 所以必须能脱离宿主反复跑。
 */
export function settleRest(input: SleepEnergyInput): SleepEnergyResult {
  const { config } = input
  const cap = Math.min(input.maxEnergy, Math.max(0, config.naturalCap))
  const threshold = Math.max(0, config.sleepEnergyThreshold)
  const isQuiet = input.isQuietHour ?? ((ms: number) => isQuietHour(ms, config.quietHours))

  // 冻结：既不回血也不衰减。急停是人的明确指令，机器不该替人改主意。
  if (input.frozen) {
    return { energy: input.energy, sleepMs: 0, mode: 'frozen' }
  }

  let energy = Math.max(0, Math.min(input.maxEnergy, input.energy))
  let sleepMs = 0
  let sawDeepSleep = false
  let sawNightRest = false

  for (const step of planSteps(input.nowMs, input.elapsedMs, config.stepMinutes)) {
    const minutes = step.ms / MINUTE
    const quiet = isQuiet(step.at)
    // 深度休眠的判据是"当下的能量"，不是"结算时的能量"——否则睡醒那一刻
    // 能量已经回到 40，整段都不算睡了，睡眠补偿会凭空消失。
    const deep = energy < threshold
    if (deep) {
      sawDeepSleep = true
      sleepMs += step.ms
    } else if (quiet) {
      sawNightRest = true
    }

    if (energy >= cap) {
      // 高于自然上限：朝 cap 回落（人工喂满的部分留不住，但也不会瞬间蒸发）
      energy = Math.max(cap, energy - config.overshootDecayPerMinute * minutes)
      continue
    }

    const rate = deep || quiet ? config.sleepRecoverPerMinute : config.recoverPerMinute
    energy = Math.min(cap, energy + rate * minutes)
  }

  energy = Math.max(0, Math.min(input.maxEnergy, energy))

  const mode: SleepEnergyResult['mode'] = sawDeepSleep
    ? 'deep-sleep'
    : sawNightRest
      ? 'night-rest'
      : energy >= cap
        ? 'sated'
        : 'awake'

  return { energy, sleepMs: Math.round(sleepMs), mode }
}
