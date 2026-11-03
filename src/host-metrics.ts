/**
 * 宿主感观通道 · 机器指标采集
 * ============================================================================
 * 器官跑在沙盒里，`process` / `os` / `node:` 一律被拦。这是对的，但"想感知
 * CPU 负载"就变成了不可能——鱼小水写 `system_sensor` 时正是撞在这堵墙上。
 *
 * 所以由宿主自己读 `node:os`，只把**聚合后的标量**递进去（见 life-organ.ts
 * 的 HostMetrics）。这个文件是唯一允许 import `node:os` 的地方：
 * 采集与 ABI 分离，器官作者编译时只依赖契约层，不需要 Node 类型。
 *
 * 三条设计取舍：
 *   1. **差分而不是瞬时**：CPU 使用率本质是"一段时间里有多少时间没在 idle"，
 *      单点读数没有意义。第一次采样没有基准，就退化成"开机以来的平均值"，
 *      这比返回 0 或 undefined 都更接近真相。
 *   2. **短窗口缓存**：多个器官各自 onTick 时不该把 `os.cpus()` 当免费调用；
 *      250ms 内的重复采样直接给上一次的结果（sampledAt 也保持真实采样时刻，
 *      不伪造"新鲜度"）。
 *   3. **不需要调用方配合**：采样器自己维护基准，器官只管读 `ctx.hostMetrics`。
 */

import { cpus, freemem, loadavg, totalmem, uptime } from 'node:os'

import type { HostMetrics } from './life-organ.js'

interface CpuTimes {
  user: number
  nice: number
  sys: number
  idle: number
  irq: number
}

interface CpuSample {
  readonly times: readonly CpuTimes[]
  /** 采样时刻（epoch ms），只用于算差分的时间分母。 */
  readonly at: number
}

/** 默认缓存窗口：够挡住"几个器官同一秒各读一次"，又不至于让读数变陈旧。 */
export const DEFAULT_MIN_INTERVAL_MS = 250

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  // toFixed 顺带把 -0 变成 0：DSH 的 lossless JSON 校验会把 -0 判为有损。
  return Number(Math.max(0, Math.min(100, value)).toFixed(1))
}

function sumTimes(times: readonly CpuTimes[]): { total: number; idle: number } {
  let total = 0
  let idle = 0
  for (const item of times) {
    total += item.user + item.nice + item.sys + item.idle + item.irq
    idle += item.idle
  }
  return { total, idle }
}

/**
 * 两次 CPU 累计时间之间的使用率（0–100）。没有可用的增量时返回 null。
 *
 * 导出是为了能单测：这是整个通道里唯一有算术的地方，其余都是取数。
 */
export function cpuPercentBetween(
  prev: readonly CpuTimes[],
  next: readonly CpuTimes[],
): number | null {
  const before = sumTimes(prev)
  const after = sumTimes(next)
  const deltaTotal = after.total - before.total
  const deltaIdle = after.idle - before.idle
  // 核数变化（热插拔 / 容器配额调整）或时钟回退时，差分没有意义。
  if (deltaTotal <= 0 || deltaIdle < 0 || prev.length !== next.length) return null
  return clampPercent((1 - deltaIdle / deltaTotal) * 100)
}

/** 开机以来的平均 CPU 使用率：首次采样没有基准时的退化方案。 */
export function cpuPercentSinceBoot(times: readonly CpuTimes[]): number | null {
  const { total, idle } = sumTimes(times)
  if (total <= 0) return null
  return clampPercent((1 - idle / total) * 100)
}

function readCpuTimes(): CpuTimes[] {
  try {
    // 某些容器里 cpus() 可能返回空数组：此时"没有 CPU 信息"，不要编一个 0。
    return cpus().map((core) => ({
      user: core.times.user,
      nice: core.times.nice,
      sys: core.times.sys,
      idle: core.times.idle,
      irq: core.times.irq,
    }))
  } catch {
    return []
  }
}

/** 本进程累计 CPU 微秒数（user + system）。差分用，所以要在构造时就取一次。 */
function readProcessMicros(): number {
  try {
    const usage = process.cpuUsage()
    return usage.user + usage.system
  } catch {
    return 0
  }
}

/** 退化值：宿主没有采集器时用它，`live: false` 明确告诉器官"我其实感觉不到"。 */
export function emptyHostMetrics(nowMs = Date.now()): HostMetrics {
  return {
    sampledAt: nowMs,
    cpu: { cores: 0, systemPercent: 0, processPercent: 0, loadAvg: null },
    memory: {
      totalBytes: 0,
      freeBytes: 0,
      usedBytes: 0,
      usedPercent: 0,
      processRssBytes: 0,
      processHeapUsedBytes: 0,
    },
    uptimeSec: 0,
    processUptimeSec: 0,
    totalProcessCpuSeconds: null,
    live: false,
  }
}

export interface HostMetricsSamplerOptions {
  /** 缓存窗口，默认 250ms。设为 0 表示每次都真实采样（测试用）。 */
  minIntervalMs?: number
}

export interface HostMetricsSampler {
  /** 取一份指标。永不抛错：任何一步失败都退化成 `live: false` 的常量。 */
  sample(nowMs?: number): HostMetrics
}

/**
 * 创建一个采样器。**每个宿主一个**（不是每次调用一个）——
 * 差分基准是它的内部状态，每次新建就等于永远只有"开机平均"。
 */
export function createHostMetricsSampler(options: HostMetricsSamplerOptions = {}): HostMetricsSampler {
  const minInterval = Math.max(0, options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS)

  /**
   * **构造时就立基准**，而不是等第一次 sample。
   *
   * 否则第一次读数没有"上一帧"，只能退回"进程生命周期平均"——那会把启动期
   * 加载模块的 CPU 全算进去，第一个 system_sensor 读数常常是 100%，
   * 于是器官得出"我在狂转"的错误结论。提前立基准后，首次读数的窗口是
   * "插件启动到现在"，这就是最接近"当下"的可信平均。
   */
  const startedAt = Date.now()
  let lastCpu: CpuSample | null = { times: readCpuTimes(), at: startedAt }
  let cached: HostMetrics | null = null
  /** 上一次读到的进程累计 CPU 微秒数：进程使用率也是差分。 */
  let lastProcessMicros = readProcessMicros()

  /** 差分窗口短于这个值时噪声大于信号（Windows 的 CPU tick 精度约 10ms）。 */
  const MIN_DIFF_WINDOW_MS = 100

  return {
    sample(nowMs = Date.now()): HostMetrics {
      if (cached && nowMs - cached.sampledAt < minInterval) return cached

      try {
        const times = readCpuTimes()
        const cores = times.length
        const windowMs = lastCpu ? nowMs - lastCpu.at : 0
        const canDiff = windowMs >= MIN_DIFF_WINDOW_MS

        // 系统 CPU：窗口够长走差分；否则退回"开机以来平均"（比编一个 0 诚实）。
        const systemPercent = canDiff && lastCpu
          ? cpuPercentBetween(lastCpu.times, times) ?? cpuPercentSinceBoot(times) ?? 0
          : cpuPercentSinceBoot(times) ?? 0

        // 本进程 CPU：微秒差 / 实际经过的毫秒。
        const usage = process.cpuUsage()
        const processMicros = usage.user + usage.system
        // 里程表：累计 CPU 秒。toFixed 顺带消灭 -0（lossless JSON 会拒 -0）。
        const totalProcessCpuSeconds = Number((processMicros / 1e6).toFixed(3))
        const lifetimeMs = Math.max(1, process.uptime() * 1000)
        const processPercent = canDiff
          ? clampPercent((processMicros - lastProcessMicros) / (windowMs * 1000) * 100)
          : clampPercent(processMicros / lifetimeMs * 100)
        lastProcessMicros = processMicros

        lastCpu = { times, at: nowMs }

        const memory = process.memoryUsage()
        const totalBytes = Math.max(0, totalmem())
        const freeBytes = Math.max(0, freemem())
        const usedBytes = Math.max(0, totalBytes - freeBytes)

        cached = {
          sampledAt: nowMs,
          cpu: {
            cores,
            systemPercent,
            processPercent,
            // Windows 没有 run-queue 概念，loadavg() 恒为 [0,0,0]：
            // 给 null 比给一个恒零的三元组更诚实（器官会误读成"完全不忙"）。
            loadAvg: process.platform === 'win32'
              ? null
              : ((): [number, number, number] => {
                const [a, b, c] = loadavg()
                return [
                  Number((a ?? 0).toFixed(2)),
                  Number((b ?? 0).toFixed(2)),
                  Number((c ?? 0).toFixed(2)),
                ]
              })(),
          },
          memory: {
            totalBytes,
            freeBytes,
            usedBytes,
            usedPercent: totalBytes > 0 ? clampPercent(usedBytes / totalBytes * 100) : 0,
            processRssBytes: Math.max(0, memory.rss),
            processHeapUsedBytes: Math.max(0, memory.heapUsed),
          },
          uptimeSec: Math.max(0, Math.round(uptime())),
          processUptimeSec: Math.max(0, Math.round(process.uptime())),
          totalProcessCpuSeconds,
          live: true,
        }
        return cached
      } catch {
        // 采集失败不能让器官挂掉：给退化值，别抛。
        return emptyHostMetrics(nowMs)
      }
    },
  }
}
