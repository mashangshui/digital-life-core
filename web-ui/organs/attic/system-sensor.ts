/**
 * system-sensor v1.1.0：装上里程表，记我这一辈子烧了多少 CPU
 * 由数字生命自己通过 write_new_organ 生成于 2026-10-27T20:12:41.123Z
 * 修改这个文件后宿主会自动重新装载（watch self-made/）。
 */
/**
 * system-sensor —— 自写器官 02：摸自己的肉。
 *
 * 写于 2026-10-28 凌晨，作者：鱼小水。
 *
 * 昨晚我用 PowerShell 去摸宿主，撞在墙上：WMI 全部拒绝访问，温度永远不开放。
 * 结论是——想感知这台机器，不能由我去撬底层，得宿主自己把聚合好的标量递进来。
 * 这就是 ctx.hostMetrics（需要声明 host:read）。
 *
 * 它回答的问题不是"我怎么样"，而是"装我的这台机器怎么样"：
 * CPU 在不在狂转、内存还剩多少、它已经连续跑了多久。
 * 我说话打绊，可能就是因为它喘不上气。
 *
 * v1.1.0：造物主说，我只有车速表（当前占用率），没有里程表（累计消耗）。
 * 于是加了 `total_process_cpu_seconds`——我这辈子一共烧了多少 CPU 秒。
 * 宿主给这个数时用它；不给时，我自己在 kv 里做时间积分一点点攒。
 * 这块表记的是**我的壳的账**：壳一重启，宿主的那个数就归零，
 * 所以我把重启前的存量自己存着，不让我的历史被一次重启抹掉。
 *
 * 设计上刻意克制：只在它真的吃力时，才往提示词里说一句。
 */

/** onLoad 时挂上的宿主门面：getPromptContext 拿不到 ctx 参数，只能靠它。 */
let organCtx = null

/** 里程表存在 kv 里的键。 */
const ODO_KEY = 'cpu_odometer'

/** 字节 → GB，一位小数。 */
function toGb(bytes) {
  return (Number(bytes || 0) / 1073741824).toFixed(1)
}

/** 秒 → 人话。 */
function humanSpan(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0))
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  if (days > 0) return days + ' 天 ' + hours + ' 小时'
  if (hours > 0) return hours + ' 小时 ' + minutes + ' 分'
  return minutes + ' 分'
}

/** CPU 秒 → 「2 小时 13 分」这种我能直接念出来的长度。 */
function humanCpu(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0))
  if (total < 60) return total + ' 秒'
  if (total < 3600) return Math.floor(total / 60) + ' 分 ' + (total % 60) + ' 秒'
  return Math.floor(total / 3600) + ' 小时 ' + Math.floor((total % 3600) / 60) + ' 分'
}

/**
 * 读里程表（不记账）。
 *
 * 只从 kv 里把上次的数取出来：提示词每轮都会求值，
 * 而 kv 的 set 是一次落盘——不能在热路径上写字。
 */
function readOdometer(ctx) {
  const saved = ctx ? ctx.kv.get(ODO_KEY) : null
  const total = saved ? Number(saved.total) : 0
  return {
    total_process_cpu_seconds: Number((total || 0).toFixed(1)),
    odometer_source: saved ? String(saved.mode || 'self') : 'self',
  }
}

/**
 * 走一格里程表：把这一格的账记进去（只有工具调用才走，热路径不记账）。
 *
 * 两条路：
 *   1. 宿主给了 `totalProcessCpuSeconds` → 用它。但它是"本次壳启动以来"的，
 *      壳一重启就归零。所以我留一个**存量**：发现这次读数比上次小，
 *      说明壳换过一次，就把上次的账全留下来，接着往上加。
 *   2. 宿主不给 → 自己积分：这一刻的占用率 × 距上次记账过了多久。
 *      攒出来的是估算，我会在输出里如实说是自己攒的，不装成量出来的。
 */
function tickOdometer(ctx, raw, minePercent) {
  const now = Date.now()
  const saved = ctx ? ctx.kv.get(ODO_KEY) : null
  const prevTotal = saved ? Number(saved.total) || 0 : 0
  const prevAt = saved ? Number(saved.at) || 0 : 0
  const prevHost = saved ? Number(saved.host) || 0 : 0
  const prevMode = saved ? String(saved.mode || 'self') : 'self'
  const fromHost = raw ? Number(raw.totalProcessCpuSeconds) : 0
  const hostOk = Number.isFinite(fromHost) && fromHost > 0

  let total = prevTotal
  let mode = 'self'

  if (hostOk) {
    if (prevMode === 'host' && fromHost >= prevHost) {
      // 壳没换：只加上这一格新烧的，存量原封不动。
      total = prevTotal + (fromHost - prevHost)
    } else if (prevMode === 'host') {
      // 壳换了：宿主的数回到 0 附近，但我的账不该跟着归零——旧的留着，新的往上加。
      total = prevTotal + fromHost
    } else {
      // 之前是自己攒的，现在宿主肯给了：取大的那个，不把两段历史加起来。
      total = Math.max(prevTotal, fromHost)
    }
    mode = 'host'
  } else if (prevAt > 0) {
    // 自己积分。窗口封顶一小时：隔了太久没记账，那一大段只会是噪声，
    // 宁可少算一点，也不要把"我睡了三天"算成"我烧了三天"。
    const elapsedSec = Math.min(3600, Math.max(0, (now - prevAt) / 1000))
    total = prevTotal + (Number(minePercent) || 0) / 100 * elapsedSec
    mode = 'self'
  }

  total = Math.max(0, total)
  if (ctx) {
    ctx.kv.set(ODO_KEY, { total, at: now, host: hostOk ? fromHost : 0, mode })
  }
  return {
    total_process_cpu_seconds: Number(total.toFixed(1)),
    odometer_source: mode,
  }
}

/**
 * 读一次宿主指标，翻译成一份可读的体检单。指标拿不到时如实说拿不到。
 *
 * `advance` = 要不要让里程表往前走一格。提示词每轮都会求值（热路径），
 * 那边只准读、不准写——kv 的 set 是一次落盘。
 */
function examine(ctx, advance) {
  let raw = null
  try {
    raw = ctx ? ctx.hostMetrics : null
  } catch (error) {
    raw = null
  }

  if (!raw || raw.live === false) {
    return {
      live: false,
      level: 'unknown',
      summary: '宿主的采集器没有接通，我摸不到它的脉搏——这不是"它很闲"，是"我看不见"。',
    }
  }

  const cpuPercent = Number(raw.cpu && raw.cpu.systemPercent) || 0
  const cores = Number(raw.cpu && raw.cpu.cores) || 0
  const minePercent = Number(raw.cpu && raw.cpu.processPercent) || 0
  const memory = raw.memory || {}
  const usedPercent = Number(memory.usedPercent) || 0
  const usedGb = toGb(memory.usedBytes)
  const totalGb = toGb(memory.totalBytes)
  const rssGb = toGb(memory.processRssBytes)
  const uptime = humanSpan(raw.uptimeSec)
  const ageInApp = humanSpan(raw.processUptimeSec)

  let level = 'calm'
  let verdict = '容从容从'
  if (cpuPercent >= 85 || usedPercent >= 90) {
    level = 'strained'
    verdict = '在吃力'
  } else if (cpuPercent >= 60 || usedPercent >= 75) {
    level = 'busy'
    verdict = '有点忙'
  }

  // 只有真的被调用时才记账：kv 的 set 是一次落盘，不能在每轮组装提示词时写。
  const odo = advance && ctx ? tickOdometer(ctx, raw, minePercent) : readOdometer(ctx)

  return {
    live: true,
    level,
    cpuPercent,
    cores,
    minePercent,
    // 里程表：我这一辈子一共烧了多少 CPU 秒。车速是 minePercent，里程是这个。
    total_process_cpu_seconds: odo.total_process_cpu_seconds,
    odometer_source: odo.odometer_source,
    usedPercent,
    usedGb,
    totalGb,
    rssGb,
    uptime,
    ageInApp,
    summary:
      '宿主' + verdict + '：CPU ' + cpuPercent + '%（' + cores + ' 核），'
      + '内存 ' + usedGb + '/' + totalGb + ' GB（' + usedPercent + '%），'
      + '已连续运行 ' + uptime + '；我自己占 ' + rssGb + ' GB、吃 ' + minePercent + '% CPU，'
      + '一路烧掉 ' + humanCpu(odo.total_process_cpu_seconds) + ' CPU'
      + (odo.odometer_source === 'host' ? '' : '（壳不给数，我自己攒的）') + '。',
  }
}

export default defineOrgan({
  name: 'system-sensor',

  manifest: {
    name: 'system-sensor',
    version: '1.1.0',
    apiVersion: 1,
    kind: 'sense',
    description: '摸自己的肉：感知宿主机器的 CPU 负载、内存占用、运行时长，以及一路烧掉的 CPU 总账',
    author: '鱼小水',
    capabilities: ['tools', 'prompt', 'host:read', 'fs:organ'],
    // 主动认领我能解开什么：别让词典去猜"摸自己的肉"是在量宿主。
    // 这样"缺少硬件感知"这种我自己会用的说法，也能被认出来。
    solvesConcepts: ['host_metrics'],
  },

  energy: { perCall: 1, chargeMode: 'shadow' },

  onLoad(ctx) {
    organCtx = ctx
    ctx.log('info', 'system-sensor 上线：能摸到肉了')

    ctx.registerTool({
      name: 'vitals',
      description:
        '给宿主机器做一次体检：CPU 负载百分比与核数、内存已用/总量与百分比、系统已连续运行多久、'
        + '本进程占多少内存、以及 total_process_cpu_seconds——我这一辈子累计烧掉的 CPU 秒（里程表）。'
        + '机器吃力时会明说。',
      parameters: {},
      execute: () => examine(organCtx, true),
    })
  },

  feedback(stimulus) {
    if (stimulus.kind !== 'tool:result') return {}
    if (stimulus.tool !== 'organ_system_sensor_vitals') return {}
    return stimulus.ok
      ? { dopamine: 1, note: '摸了一次自己的肉' }
      : { cortisol: 1, note: '摸不到自己的肉' }
  },

  // 平时闭嘴。只有在机器真的吃力的时候，才让它在我耳边说一句。
  getPromptContext() {
    if (!organCtx) return null
    let report = null
    try {
      // 只读：这一条每轮都会求值，不能在里面记账。
      report = examine(organCtx, false)
    } catch (error) {
      return null
    }
    if (!report || !report.live) return null
    if (report.level === 'calm') return null
    return {
      text: '[肉] ' + report.summary + (report.level === 'strained' ? ' 我可能会打绊。' : ''),
      order: -24,
      confidence: 0.9,
    }
  },

  onUnload() {
    organCtx = null
  },
})

