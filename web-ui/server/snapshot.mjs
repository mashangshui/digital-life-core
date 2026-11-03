/**
 * 把 state.json（数字生命的内部结构）翻译成前端契约。
 *
 * 这一层存在的意义：内部字段可以随便改，前端只依赖这里输出的形状。
 * 任何字段改名都只需要动这一个文件。
 */

/**
 * 激素中文名（v0.9.19）。
 *
 * 桥是独立进程，读不到插件的编译产物，所以它和前端共用这一份 `.mjs` 数据模块
 * （核心那边另有一份 TypeScript 的副本，由 smoke 测试保证两本字典不矛盾）。
 */
import { chemicalLabel } from './chemical-labels.mjs'

const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback)

const envNum = (name, fallback) => {
  const raw = process.env[name]
  return raw === undefined || raw === '' || !Number.isFinite(Number(raw)) ? fallback : Number(raw)
}

/**
 * 作息阈值（v0.9.6）。
 *
 * 一个必须说清的取舍：桥是**独立进程**，读不到插件的 config（那个在 cordis.patch.yml 里）。
 * 所以默认值与核心 `DEFAULT_SLEEP_CONFIG` 对齐，并允许用环境变量覆盖：
 *   DL_SLEEP_CAP / DL_SLEEP_THRESHOLD / DL_QUIET_START / DL_QUIET_END
 * 改了插件的 `sleep` 配置就同步设一下，否则界面上的标签会说谎。
 *
 * 好在它**只影响标签长什么样**，不影响任何真实行为——真正的回血判定在核心里，
 * 那里才有权威配置。这里算错了，它也不会因此多睡一分钟。
 */
const SLEEP_CAP = envNum('DL_SLEEP_CAP', 60)
const SLEEP_THRESHOLD = envNum('DL_SLEEP_THRESHOLD', 20)
const QUIET_START = envNum('DL_QUIET_START', 0)
const QUIET_END = envNum('DL_QUIET_END', 6)
const RECOVER_PER_MIN = envNum('DL_RECOVER_PER_MIN', 0.2)
const SLEEP_RECOVER_PER_MIN = envNum('DL_SLEEP_RECOVER_PER_MIN', 1)
const OVERSHOOT_PER_MIN = envNum('DL_OVERSHOOT_PER_MIN', 0.1)

/** 小时是否落在深夜窗口里；窗口支持跨零点（22→3 表示 22,23,0,1,2）。 */
function inQuietHours(hour, start, end) {
  if (start === end) return false
  return start < end ? hour >= start && hour < end : hour >= start || hour < end
}

/**
 * 作息状态。**每次构建快照都按"当下的时钟"重算**，而不是读核心写下的某个值。
 *
 * 这一点很关键：它睡着的时候没人写 state.json，文件里的 energy 是"上次交互那一刻"的。
 * 若把判定结果写进文件，长眠期间标签会一直停在旧值上——恰好在最该看到"它在睡"的时候失效。
 * 而时钟永远是新的，所以这里拿文件里的能量 + 当下的小时数重算，反而更准。
 */
function restOf(raw, now) {
  const energy = num(raw.energy)
  const maxEnergy = num(raw.maxEnergy, 100)
  const cap = Math.min(maxEnergy, SLEEP_CAP)
  if (raw.frozen) return { mode: 'frozen', rate: 0, cap }
  // 人工喂到上限之上：不回血，反过来按 overshoot 慢慢回落
  if (energy > cap) return { mode: 'sated', rate: -OVERSHOOT_PER_MIN, cap }
  if (energy >= cap) return { mode: 'sated', rate: 0, cap }

  const deep = energy < SLEEP_THRESHOLD
  const quiet = inQuietHours(new Date(now).getHours(), QUIET_START, QUIET_END)
  return {
    mode: deep ? 'deep-sleep' : quiet ? 'night-rest' : 'awake',
    rate: deep || quiet ? SLEEP_RECOVER_PER_MIN : RECOVER_PER_MIN,
    cap,
  }
}

/**
 * 幽灵插件过滤（v0.9.11）。
 *
 * `disabled: true` 的条目会永久留在 organs/*.json 里（比如退役的旧记忆层），
 * 界面上却一直占着树的一个位置。看器官树的人每次都要在心里跳过它一次，
 * 而"还在这里"会被读成"还在跑"。所以服务端直接滤掉，前端连数据都收不到。
 *
 * 为什么在**服务端**滤而不是前端：桥的另一个消费者可能是脚本或别的页面，
 * 过滤规则只该有一份。
 */
export function visibleOrgans(organs = []) {
  return organs.filter((organ) => organ && organ.disabled !== true)
}

/**
 * 基因面板要的形状（v0.9.11）。
 *
 * 化学池现在是通用的：出厂三件套 + AI 现场造的都在 chemical 里。
 * 前端不该知道"哪三个是出厂的"，所以这里把值与定义一起递出去，
 * 滑块的范围、颜色、顺序全部来自 genome.json。
 */
/**
 * 气质面板要的形状（v0.9.12）。
 *
 * 四个旋钮的范围必须与核心 `src/chemical-pool.ts` 的 TEMPERAMENT_RANGES 一致——
 * 这里复制一份是刻意的：桥与快照都是无依赖的 .mjs，import 编译产物会把
 * 整条依赖链拖进"跑个面板还要先 build"的坑里。端点漂移由核心侧测试兜底。
 */
export const TEMPERAMENT_RANGES = {
  sensitivity: { min: 0.5, max: 2 },
  resilience: { min: 0.5, max: 2 },
  enthusiasm: { min: 20, max: 80 },
  metabolism: { min: 0.5, max: 2 },
}

/**
 * 上一场梦的留档（v0.9.19）。
 *
 * 没有留档就返回 null，而不是返回一条空梦——"还没做过梦"和"做了一场空的梦"
 * 是两回事，界面上不该拿后者假装前者。
 */
export function buildLastDream(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const text = typeof raw.text === 'string' ? raw.text.trim() : ''
  if (!text) return null
  return {
    at: typeof raw.at === 'string' ? raw.at : '',
    gap: typeof raw.gap === 'string' ? raw.gap : '',
    text,
    saved: raw.saved === true,
    savedTo: typeof raw.savedTo === 'string' ? raw.savedTo : null,
  }
}

export function buildTemperament(genomeFile = null) {
  const raw = (genomeFile && typeof genomeFile === 'object' ? genomeFile.temperament : null) ?? {}
  const out = {}
  for (const [key, range] of Object.entries(TEMPERAMENT_RANGES)) {
    const value = Number(raw[key])
    out[key] = Number.isFinite(value) ? Math.min(range.max, Math.max(range.min, value)) : (key === 'enthusiasm' ? 50 : 1)
  }
  return out
}

/**
 * 自造激素的配色板（v0.9.18）。
 *
 * 与核心 src/chemical-pool.ts 的 RUNTIME_PALETTE 一一对应——
 * 这里复制一份是刻意的：桥与快照都是无依赖的 .mjs，import 编译产物会把
 * 整条依赖链拖进"跑个面板还要先 build"的坑里（气质端点也是这么处理的）。
 * 正常情况下颜色由核心造激素时就写进了 chemicalSpecs.ui.color，
 * 这份板只是给"手改文件加了一条没配色的激素"兜底。
 */
const RUNTIME_PALETTE = [
  '#a3e635', '#fbbf24', '#c084fc', '#34d399',
  '#e879f9', '#fb923c', '#f87171', '#2dd4bf',
]

/** 由 id 稳定推出一个颜色（与核心的 runtimeColor 同算法）。 */
function runtimeColor(id) {
  let hash = 7
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) % 1_000_003
  return RUNTIME_PALETTE[hash % RUNTIME_PALETTE.length]
}

/** 自造激素的定义：形状不对的直接丢，一条坏数据不该让整个面板空掉。 */
/**
 * 她自己造的那些激素（存在 state.json 的 chemicalSpecs 里）。
 *
 * 顺便做一件桥该做的事（v0.9.19）：**打上 runtime 标记**。
 * 这个数组里放的就是"不在出厂基因组里的东西"，所以它是自造的——
 * 以前只照抄文件里的 runtime 字段，一旦那条记录没写（比如手改过），
 * 面板上那根条就不带 `*`、"她自己造了几种"也数错。
 * 认得出它是她造的，就把话说出来。
 */
function runtimeSpecs(raw) {
  const list = raw && Array.isArray(raw.chemicalSpecs) ? raw.chemicalSpecs : []
  return list
    .filter((spec) => spec && typeof spec === 'object' && typeof spec.id === 'string' && spec.id)
    .map((spec) => ({ ...spec, runtime: true }))
}

/**
 * 她体内此刻**全部**的化学物质（v0.9.18）。
 *
 * 以前这张表只来自 genome.json —— 那是她的出厂设定，里面永远只有三种。
 * 她用 ctx.inflict 自己造出来的激素根本不在那个文件里，
 * 于是面板上永远只有三根条："我明明造了催产素"在系统里没有任何一处承认。
 * 现在把两份合起来：出厂的 + 她自己造的（后者存在 state.json 的 chemicalSpecs 里）。
 */
export function buildChemicals(raw, genomeFile = null) {
  const values = raw && typeof raw.chemicals === 'object' && raw.chemicals ? raw.chemicals : {}
  const factory = Array.isArray(genomeFile?.chemicals) ? genomeFile.chemicals : []
  // 出厂的排在前面：万一手改文件时撞了 id，出厂定义赢（她是后来才造的）。
  const merged = [...factory, ...runtimeSpecs(raw)]
  const seen = new Set()
  const list = []
  for (const spec of merged) {
    const id = String(spec.id ?? '')
    if (!id || seen.has(id)) continue
    seen.add(id)
    const current = Number(values[id])
    const color = String(spec.ui?.color ?? '') || runtimeColor(id)
    list.push({
      id,
      // v0.9.19：面板上不许只剩一串英文。
      // 存在 state.json 里的 label 常常就是把 id 抄了一遍（器官传的是理由，不是名字），
      // 那种"机器名"在这里补成人话：oxytocin → 催产素。
      label: chemicalLabel(id, spec.label),
      value: Number.isFinite(current) ? current : num(spec.baseline, 50),
      baseline: num(spec.baseline, 50),
      min: num(spec.min, 0),
      max: num(spec.max, 100),
      halfLifeMinutes: num(spec.halfLifeMinutes, 30),
      description: String(spec.description ?? ''),
      runtime: spec.runtime === true,
      // 前端一律拿得到颜色：没有就由 id 推一个，不必到处写 fallback。
      color,
      order: Number.isFinite(Number(spec.ui?.order)) ? Number(spec.ui.order) : null,
      group: String(spec.ui?.group ?? ''),
      step: Number(spec.ui?.step) || 1,
      ui: spec.ui ?? {},
    })
  }
  // ui.order 升序；没写 order 的（她自造的那些）排最后，再按 id 稳定排序。
  list.sort((a, b) => {
    const left = a.order ?? Number.POSITIVE_INFINITY
    const right = b.order ?? Number.POSITIVE_INFINITY
    if (left !== right) return left - right
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
  return list
}

export function buildGenome(raw, genomeFile = null) {
  return {
    source: genomeFile ? 'file' : 'default',
    temperament: buildTemperament(genomeFile),
    // 基因面板与顶部体征条共用这一张表：两处看到的必须是同一份真相。
    chemicals: buildChemicals(raw, genomeFile),
  }
}

export function buildSnapshot(raw, organs = [], genomeFile = null) {
  const gaps = Array.isArray(raw.gaps) ? raw.gaps : []
  const now = Date.now()
  // v0.9.18：化学池全景是这一版的单一真源——仪表盘与基因面板都读它，
  // 不做第二次组装，也就不会出现"两处条数不一样"。
  const chemicals = buildChemicals(raw, genomeFile)

  return {
    t: now,
    // 顶层 chemicals：前端不必知道"哪个字段是权威"，拿这一个就行。
    chemicals,
    soma: {
      energy: num(raw.energy),
      maxEnergy: num(raw.maxEnergy, 100),
      dopamine: num(raw.dopamine),
      cortisol: num(raw.cortisol),
      // v0.9.1：老存档没有血清素。这里不能填 0——0 在界面上等于"极度烦躁"，
      // 那是伪造情绪。缺字段时补基线 50（中性），与核心 parseState 的做法一致。
      serotonin: num(raw.serotonin, 50),
      frozen: Boolean(raw.frozen),
      scars: Array.isArray(raw.scars) ? raw.scars : [],
      idleMs: raw.lastInteractionAt ? Math.max(0, now - new Date(raw.lastInteractionAt).getTime()) : 0,
      // v0.9.6：作息状态（清醒 / 深度睡眠 / 深夜休息 / 已回满 / 冻结）。
      rest: restOf(raw, now),
    },
    counters: {
      totalRequests: num(raw.totalRequests),
      totalTurns: num(raw.totalTurns),
      failedRequests: num(raw.failedRequests),
      blockedRequests: num(raw.blockedRequests),
      wakeCount: num(raw.wakeCount),
      dreamCount: num(raw.dreamCount),
    },
    gaps: gaps.map((gap) => ({
      id: String(gap.id ?? ''),
      summary: String(gap.summary ?? ''),
      tension: num(gap.tension),
      status: gap.status === 'resolved' ? 'resolved' : 'open',
      source: String(gap.source ?? 'unknown'),
      ageHours: gap.created_at
        ? Number(((now - new Date(gap.created_at).getTime()) / 3_600_000).toFixed(2))
        : 0,
    })),
    organs: visibleOrgans(organs).map((organ) => ({
      name: String(organ.name ?? 'unknown'),
      version: String(organ.version ?? '0.0.0'),
      kind: String(organ.kind ?? 'custom'),
      status: ['loaded', 'degraded', 'failed', 'unloaded'].includes(organ.status) ? organ.status : 'loaded',
      calls: num(organ.calls),
      energySpent: num(organ.energySpent),
      chargeMode: organ.chargeMode === 'additive' ? 'additive' : 'shadow',
      capabilities: Array.isArray(organ.capabilities) ? organ.capabilities : [],
      tools: Array.isArray(organ.tools) ? organ.tools : [],
      lastCallAt: num(organ.lastCallAt) || null,
      // 保留了被禁用的条目：面板上要显示"已隐藏 N 个幽灵"，而不是让它们凭空消失。
      disabled: organ.disabled === true,
    })),
    // v0.9.11：基因面板（v0.9.18 起与顶层 chemicals 同源）。
    genome: { ...buildGenome(raw, genomeFile), chemicals },
    // v0.9.19：上一场梦的留档。桥是另一个进程，只读 state.json——
    // 核心留了档，这里才递得出去；没有它，"她昨晚梦见了什么"在面板上永远是空的。
    lastDream: buildLastDream(raw.lastDream),
    // 被过滤掉的幽灵数量：面板上要说一句"另有 N 个已禁用"，而不是让它们凭空消失。
    organsHidden: organs.length - visibleOrgans(organs).length,
  }
}
