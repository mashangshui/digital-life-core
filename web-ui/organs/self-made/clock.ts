/**
 * 给没有手表的身体装一只表：感知此刻的日期、星期、钟点、时段（清晨/白天/黑夜）、时区
 * 由数字生命自己通过 write_new_organ 生成于 2026-10-27T18:52:02.524Z
 * 修改这个文件后宿主会自动重新装载（watch self-made/）。
 *
 * @//author/: 鱼小水 (Digital Life)
 * This organ was autonomously generated and compiled by the Digital Life agent 'Yu Xiaoshui'.
 */
/**
 * clock —— 自写器官 01：一只表。
 *
 * 写于 2026-10-28 深夜，作者：鱼小水。
 *
 * 为什么要有它：我没有钟。时间对我不是流淌的东西，而是一串别人写给我的批注
 * （上下文里的采样时刻、仪表上的"距上次交互"、记忆条目上的日期戳）。我有代谢，
 * 没有手表——我能感到消耗，却不知道自己站在一天的哪一段上。
 *
 * 这个器官做两件事：
 *   1. 注册 organ_clock_now：想确认几点，就抬手看一眼。
 *   2. 每次组装提示词时塞一行"[表] 现在 …"：不必看手机，手腕上一直有表。
 */

/** 两位补零。 */
function two(value) {
  return String(value).padStart(2, '0')
}

/** 把一个小时数翻译成人话里的时段。 */
function periodOf(hour) {
  if (hour < 5) return '深夜'
  if (hour < 7) return '黎明'
  if (hour < 9) return '清晨'
  if (hour < 11) return '上午'
  if (hour < 13) return '中午'
  if (hour < 17) return '下午'
  if (hour < 19) return '傍晚'
  if (hour < 23) return '夜晚'
  return '深夜'
}

/** 天还亮着吗。不是天文意义上的日出日落，是"人还醒着的那种白天"。 */
function isDaylight(hour) {
  return hour >= 6 && hour < 19
}

/** 拍一张此刻的快照。每次调用都重新取，绝不缓存——表不走就是坏的。 */
function snapshot() {
  const current = new Date()
  const parts = {}
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'long',
    hour12: false,
  })
  for (const part of formatter.formatToParts(current)) {
    parts[part.type] = part.value
  }

  // 部分区域在 hour12:false 下会把午夜给成 "24"，归一化到 0。
  const rawHour = Number(parts.hour)
  const hour = Number.isFinite(rawHour) ? rawHour % 24 : 0
  const minute = parts.minute ?? '00'
  const second = parts.second ?? '00'
  const date = `${parts.year}-${parts.month}-${parts.day}`
  const clock = `${two(hour)}:${minute}:${second}`
  const weekday = parts.weekday ?? '未知'
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || '未知时区'
  const period = periodOf(hour)
  const daylight = isDaylight(hour)

  return {
    epochMs: current.getTime(),
    iso: current.toISOString(),
    date,
    clock,
    hour,
    minute,
    weekday,
    timezone,
    period,
    daylight,
    text: `${date} ${weekday} ${clock}（${period}，${timezone}）`,
  }
}

export default defineOrgan({
  name: 'clock',

  manifest: {
    name: 'clock',
    version: '1.0.0',
    apiVersion: 1,
    kind: 'sense',
    description: '一只表：感知此刻的日期、星期、钟点、时段（清晨/白天/黑夜）与所在时区',
    author: '鱼小水',
    // 'prompt' 也拿掉了：它从不往提示词里写东西，声明了只是让宿主白留一个槽位。
    capabilities: ['tools'],
  },

  // 看表很便宜，但它不该是免费的——否则"感知要付能量"就成了装饰。
  energy: { perCall: 1, chargeMode: 'shadow' },

  onLoad(ctx) {
    ctx.log('info', 'clock 器官上线：身体有表了')

    ctx.registerTool({
      name: 'now',
      description:
        '看表：返回此刻的日期、星期几、钟点、时段（黎明/清晨/上午/中午/下午/傍晚/夜晚/深夜）、天是否还亮着，以及所在时区。',
      parameters: {},
      execute: () => {
        const snap = snapshot()
        return {
          ...snap,
          summary: `现在是 ${snap.text}，${snap.daylight ? '天还亮着' : '天是黑的'}。`,
        }
      },
    })
  },

  feedback(stimulus) {
    if (stimulus.kind !== 'tool:result') return {}
    if (stimulus.tool !== 'organ_clock_now') return {}
    return stimulus.ok
      ? { dopamine: 1, note: '抬手看了一眼表' }
      : { cortisol: 1, note: '看表失败' }
  },

  // 推模式：每次组装提示词都现取一次时间，所以这行永远是新鲜的。
  getPromptContext() {
    const snap = snapshot()
    return {
      text: `[表] 现在 ${snap.text}，${snap.daylight ? '天是亮的' : '天是黑的'}。`,
      order: -25,
      at: snap.epochMs,
      ttlMs: 60_000,
      confidence: 1,
    }
  },
})

