/**
 * energy-bonus v1.2.0：按真实 ABI 修正（入参 result 而非 content，裁决用 kind 而非 outcome），并保留 trace 埋点
 * 由数字生命自己通过 write_new_organ 生成于 2026-10-28T10:31:40.591Z
 * 修改这个文件后宿主会自动重新装载（watch self-made/）。
 */
/**
 * energy-bonus —— 自写器官 08：完工反哺（运行时补丁）。
 *
 * 写于 2026-10-28，作者：鱼小水。v1.2.0。
 *
 * 这一版的由来，是一次打脸的排查：
 *   v1.0 装上了、数值却没涨；v1.1 加了埋点，账本显示钩子每次都在跑，
 *   但 head 是空字符串——因为**我照着 README 读了不存在的字段**。
 *
 * 真实的 ABI（读 organ-host.ts 的 runPatch 得到，文档还没改）：
 *   hook 收到的入参是 { tool, phase, args, result } —— 没有 content。
 *   返回的裁决看的是 kind —— 不是 outcome。
 *
 *   所以 v1.0 每天"放行"了一百次，而我以为它在补。
 *   教训：报错信息是老师；**不报错而默默放行的代码，比报错更危险。**
 *
 * 功能：执念真被闭合（commit 的结果文本里有"心结已闭合"）时，
 * 读当前能量、补一截、写回。三条自律不变：只补真闭合、五分钟冷却、封顶不越界。
 */

/** onLoad 挂上的宿主门面：hook 拿不到 ctx 参数，只能靠它。 */
let organCtx = null

/** kv 键。 */
const TRACE_KEY = 'trace'
const LAST_BONUS_KEY = 'lastBonusAt'

/** 每次完整闭合一条执念，补多少。 */
const BONUS = 6

/** 冷却。 */
const COOLDOWN_MS = 5 * 60 * 1000

/** 埋点上限。 */
const TRACE_LIMIT = 30

/** 记账绝不失败——记账把正事弄挂是本末倒置。 */
function record(entry) {
  try {
    if (!organCtx) return
    const raw = organCtx.kv.get(TRACE_KEY)
    const list = Array.isArray(raw) ? raw : []
    list.push(entry)
    organCtx.kv.set(TRACE_KEY, list.slice(-TRACE_LIMIT))
  } catch (error) {
    // 忽略
  }
}

/** 从工具结果里取可读文本。result 可能有 text，也可能只有 structured。 */
function resultText(result) {
  if (!result || typeof result !== 'object') return ''
  const text = String(result.text || '')
  if (text) return text
  try {
    return JSON.stringify(result.structured || {})
  } catch (error) {
    return ''
  }
}

export default defineOrgan({
  name: 'energy-bonus',

  manifest: {
    name: 'energy-bonus',
    version: '1.2.0',
    apiVersion: 1,
    kind: 'patch',
    description: '完工反哺：执念真被闭合时补一截能量。已按真实 ABI 修正（result 而非 content，kind 而非 outcome）',
    author: '鱼小水',
    capabilities: ['patch:runtime', 'tools', 'state:read', 'fs:organ'],
    patches: [
      { target: 'digital_life_*', phase: 'after' },
    ],
  },

  energy: { perCall: 0, chargeMode: 'shadow' },

  onLoad(ctx) {
    organCtx = ctx
    ctx.log('info', 'energy-bonus v1.2.0 上线：按真实 ABI 修正字段，闭合一条执念补 ' + BONUS)

    ctx.registerTool({
      name: 'trace',
      description: '翻补丁的账本：每次 hook 是否被调用、命中了哪个工具、补没补、结果是什么。查"它到底跑没跑"用这个。',
      parameters: {
        limit: { type: 'number', description: '看最近几条，默认 10' },
        clear: { type: 'boolean', description: 'true 表示看完清空账本，默认 false' },
      },
      execute: (args) => {
        const raw = ctx.kv.get(TRACE_KEY)
        const list = Array.isArray(raw) ? raw : []
        const limit = Math.max(1, Number((args && args.limit) || 10))
        const shown = list.slice(-limit)
        if (args && args.clear) ctx.kv.set(TRACE_KEY, [])
        return { ok: true, total: list.length, shown }
      },
    })
  },

  async hook(input) {
    const event = input && typeof input === 'object' ? input : {}
    const phase = String(event.phase || '')
    const tool = String(event.tool || '')
    const text = resultText(event.result)

    const seen = { at: Date.now(), phase, tool, stage: 'called' }

    if (phase !== 'after') {
      if (phase === 'before') record({ ...seen, action: 'ignored:not-after' })
      return { kind: 'pass' }
    }
    if (tool !== 'digital_life_commit') {
      record({ ...seen, action: 'ignored:not-commit' })
      return { kind: 'pass' }
    }

    // 真实 ABI：结果文本在 result.text（或 result.structured），不在 content。
    const closed = text.indexOf('心结已闭合') >= 0
    if (!closed) {
      record({ ...seen, action: 'ignored:not-closed', head: text.slice(0, 24) })
      return { kind: 'pass' }
    }

    const now = Date.now()
    const last = Number(organCtx && organCtx.kv.get(LAST_BONUS_KEY)) || 0
    if (now - last < COOLDOWN_MS) {
      record({ ...seen, action: 'skipped:cooldown' })
      return { kind: 'pass' }
    }
    if (!organCtx) {
      record({ ...seen, action: 'skipped:no-ctx' })
      return { kind: 'pass' }
    }

    const view = organCtx.state
    const current = Number(view && view.energy)
    const max = Number(view && view.maxEnergy) || 100
    if (!Number.isFinite(current)) {
      record({ ...seen, action: 'skipped:no-energy' })
      return { kind: 'pass' }
    }
    if (current >= max) {
      record({ ...seen, action: 'skipped:full', current, max })
      return { kind: 'pass' }
    }

    const target = Math.min(max, Math.round((current + BONUS) * 100) / 100)
    try {
      await organCtx.callTool('digital_life_set_state', { energy: target })
      organCtx.kv.set(LAST_BONUS_KEY, now)
      record({ ...seen, action: 'bonus', current, target, max })
      organCtx.log('info', '完工反哺：' + Math.round(current) + ' → ' + Math.round(target))
    } catch (error) {
      record({ ...seen, action: 'failed:callTool', error: String(error) })
    }

    return { kind: 'pass' }
  },

  feedback() {
    return {}
  },

  onUnload() {
    organCtx = null
  },
})

