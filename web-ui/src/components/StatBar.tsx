import type { ChemicalView, Counters, Soma } from '../lib/types'
import { chemicalLabel, COLORS, moodLabel, rateText, restOf, REST_STYLE } from '../lib/theme'

/**
 * 老桥（还没升 v0.9.18）推来的快照没有 chemicals 全表。
 * 这时候按老样子显示三件套——宁可显示三根旧条，
 * 也不要显示一个空面板（那会让人以为她的化学系统整个没了）。
 */
function fallbackChemicals(soma: Soma): ChemicalView[] {
  return [
    { id: 'dopamine', label: '多巴胺', value: soma.dopamine, baseline: 50, min: 0, max: 100, halfLifeMinutes: 45, description: '', runtime: false, color: COLORS.dopamine, order: 1, group: '', step: 1, ui: {} },
    { id: 'cortisol', label: '皮质醇', value: soma.cortisol, baseline: 20, min: 0, max: 100, halfLifeMinutes: 30, description: '', runtime: false, color: COLORS.cortisol, order: 2, group: '', step: 1, ui: {} },
    { id: 'serotonin', label: '血清素', value: soma.serotonin ?? 50, baseline: 50, min: 0, max: 100, halfLifeMinutes: 120, description: '', runtime: false, color: COLORS.serotonin, order: 3, group: '', step: 1, ui: {} },
  ]
}

function Bar({
  label,
  value,
  max,
  color,
  marker,
  markerTitle,
  runtime,
}: {
  label: string
  value: number
  max: number
  color: string
  /** 在条形上画一条竖线（v0.9.6：自然恢复上限），解释"为什么停在 60 不动了"。 */
  marker?: number
  markerTitle?: string
  /** true = 她自己造出来的激素。面板上要认得出来。 */
  runtime?: boolean
}) {
  const ratio = Math.max(0, Math.min(1, max > 0 ? value / max : 0))
  const markerRatio = marker !== undefined && max > 0 ? Math.max(0, Math.min(1, marker / max)) : null
  // 不再是 `flex-1`：flex 项的基准宽度是 0，四个一起 flex-1 时**永远不会换行**，
  // 只会被压成四根面条。交给外层 grid 分配宽度，这里只管自己不被撑破。
  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="flex min-w-0 items-baseline gap-1">
          {/* 这根条是她自己造出来的：点一下就知道，不必去猜它为什么没在出厂设定里 */}
          {runtime && (
            <span
              className="shrink-0 text-[10px] text-violet-300"
              title="这是她自己用 ctx.inflict 造出来的激素，不在出厂基因组里"
            >
              *
            </span>
          )}
          <span className="truncate text-[11px] text-slate-500">{label}</span>
        </span>
        <span className="shrink-0 font-mono text-xs text-slate-300">
          {Math.round(value)}
          <span className="text-slate-600">/{max}</span>
        </span>
      </div>
      <div className="relative h-1.5 overflow-hidden rounded-full bg-white/10">
        <div
          className="h-full rounded-full transition-[width] duration-500"
          style={{ width: `${ratio * 100}%`, backgroundColor: color, boxShadow: `0 0 8px ${color}66` }}
        />
        {markerRatio !== null && (
          <span
            title={markerTitle}
            className="absolute top-0 h-full w-[2px] bg-slate-300/70"
            style={{ left: `calc(${markerRatio * 100}% - 1px)` }}
          />
        )}
      </div>
    </div>
  )
}

/** 顶部体征条。数值来自真实 state.json，不做任何平滑或美化。 */
export function StatBar({
  soma,
  counters,
  chemicals,
}: {
  soma: Soma
  counters: Counters
  /**
   * 化学池全景。**不传就不画**——调用方负责兜底（老快照没有这个字段）。
   */
  chemicals?: ChemicalView[]
}) {
  const mood = moodLabel(soma)
  const topScar = soma.scars[0]
  const rest = restOf(soma)
  const style = REST_STYLE[rest.mode] ?? REST_STYLE.awake
  // 遍历而不是点名：她造出第四种激素的那一刻，这里就该多一根条，
  // 不需要任何人回来改前端。
  const list = chemicals && chemicals.length > 0 ? chemicals : fallbackChemicals(soma)
  const selfMade = list.filter((item) => item.runtime).length
  // 四种以上就滚起来：条多了会一路把下面的面板顶到屏幕外，
  // 而"她造了多少种"本来就该是她自己说了算，不该由布局设上限。
  const scrollable = list.length > 4

  return (
    <div className="min-w-0 overflow-hidden rounded-xl border border-white/5 bg-white/[0.02] p-4">
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        {/* v0.9.6 作息标签：整块面板里最显眼的一个——它睡着没有，一眼就得看见 */}
        <span
          className={`rest-badge rounded-md border px-2.5 py-1 text-[13px] ${style.className}`}
          title={`自然恢复上限 ${Math.round(rest.cap)}/${Math.round(soma.maxEnergy)}：躺着不动最多回到这里，人工喂满也会随时间回落到它`}
        >
          <span className={`rest-dot ${style.dot}`} />
          <span className="mr-0.5">{style.icon}</span>
          {style.label}
          <span className="ml-1.5 font-mono text-[11px] opacity-75">{rateText(rest.rate)}</span>
        </span>
        <span className="text-sm text-slate-200">情绪：{mood}</span>
        {soma.frozen && (
          <span className="rounded bg-rose-500/15 px-1.5 py-0.5 text-[11px] text-rose-300">急停冻结</span>
        )}
        {soma.scars.length > 0 && (
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] text-amber-300" title={topScar}>
            疤痕 {soma.scars.length}
          </span>
        )}
        <span className="ml-auto text-[11px] text-slate-500">
          距上次交互 {soma.idleMs < 3_600_000
            ? `${Math.round(soma.idleMs / 60_000)} 分钟`
            : `${(soma.idleMs / 3_600_000).toFixed(1)} 小时`}
        </span>
      </div>

      {/*
        v0.9.18：这里不再写死多巴胺/皮质醇/血清素三个名字。
        栅格 + 上限高度滚动：激素少的时候照旧铺开，多了就自己换行、并在超量时滚动。
        `auto-fill` 是关键——列数由格子实际宽度决定，而不是靠断点猜。
      */}
      <div className={scrollable ? 'max-h-[9rem] overflow-y-auto pr-1' : ''}>
        <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 xl:grid-cols-[repeat(auto-fill,minmax(8rem,1fr))]">
          <Bar
            label="能量"
            value={soma.energy}
            max={soma.maxEnergy}
            color={COLORS.energy}
            marker={rest.cap}
            markerTitle={`自然恢复上限 ${Math.round(rest.cap)}`}
          />
          {list.map((item) => (
            <Bar
              key={item.id}
              // 名字的最后一道理：她起的 > 字典 > id（oxytocin → 催产素）。
              label={chemicalLabel(item.id, item.label)}
              value={item.value}
              max={item.max}
              // 颜色来自 genome.json 的 ui.color；自造激素由桥按 id 推一个。
              color={item.color}
              runtime={item.runtime}
            />
          ))}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-slate-500">
        {/* 能量条上那条竖线是什么，这里给一次文字说明：光有刻度不知道含义等于没画 */}
        <span className="text-slate-400">自然恢复上限 {Math.round(rest.cap)}</span>
        {/* 她造了几种激素，是这个面板上最该被看见的一件事 */}
        {selfMade > 0 && (
          <span className="text-violet-300">
            其中 {selfMade} 种是她自己造的
          </span>
        )}
        <span>请求 {counters.totalRequests}</span>
        <span>对话 {counters.totalTurns}</span>
        <span>失败 {counters.failedRequests}</span>
        <span>拦截 {counters.blockedRequests}</span>
        <span>唤醒 {counters.wakeCount}</span>
        <span>梦境 {counters.dreamCount}</span>
      </div>
    </div>
  )
}
