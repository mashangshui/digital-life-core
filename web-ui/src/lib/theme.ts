import type { ChemicalView, OrganStatus, PulseSample, RestInfo, RestMode, Soma } from './types'
// 激素中文名（v0.9.19）：与桥共用同一份数据模块，别各写一本字典。
// 在这里再导出一次，让组件从 lib/theme 拿，不必各自去 import 那个 .mjs。
import { chemicalLabel } from '../../server/chemical-labels.mjs'
export { chemicalLabel }
// 画哪几条线的判定也是共享的（纯函数在 .mjs 里，测试与桥都能直接 import）。
import {
  pulseSeries as pulseSeriesOf,
  seriesValue as seriesValueOf,
  type PulseSeries,
  type SeriesSample,
} from '../../server/pulse-series.mjs'
// 类型也从那份声明里来，避免两处定义漂移。
export type { PulseSeries }

/** 取值函数在这里套一层前端的类型（纯逻辑那边用的是更宽的形状）。 */
export const seriesValue = (sample: PulseSample, key: string): number | null =>
  seriesValueOf(sample as unknown as SeriesSample, key)

/** 视觉常量集中在这里：canvas 与 DOM 共用同一套色，避免"图画是蓝的、标签是绿的"。 */
export const COLORS = {
  energy: '#38bdf8',
  dopamine: '#f59e0b',
  cortisol: '#fb7185',
  /** 血清素：雾蓝。刻意比能量（天青）更沉一档，两条线挨着也不会认错。 */
  serotonin: '#7da2ff',
  /** 睡眠紫：深睡光晕与作息标签共用。 */
  sleep: '#a78bfa',
  grid: 'rgba(148, 163, 184, 0.14)',
  axis: 'rgba(148, 163, 184, 0.55)',
  text: '#94a3b8',
  muted: '#64748b',
} as const

/**
 * 这一瞬间图上该画哪几条线（v0.9.19）。
 *
 * 判定本身在 `server/pulse-series.mjs`（纯函数，测试与桥共用），
 * 这里只补上中文名兜底——名字是显示层的事，别脏了那份纯逻辑。
 */
export function pulseSeries(
  chemicals: ChemicalView[] | undefined,
  soma: Soma,
): PulseSeries[] {
  const named = (Array.isArray(chemicals) ? chemicals : []).map((item) => ({
    ...item,
    label: chemicalLabel(item.id, item.label),
  }))
  return pulseSeriesOf(named, soma)
}

/**
 * 情绪标签。与核心的 moodLabel 保持同一优先级：
 * 应激 > 血清素（烦躁）> 多巴胺（愉悦）；冻结/耗尽排最前。
 */
export function moodLabel(soma: {
  dopamine: number
  cortisol: number
  /** 老快照可能没有这个字段：当作 50（中性）处理。 */
  serotonin?: number
  frozen: boolean
  energy: number
}): string {
  if (soma.frozen) return '急停冻结'
  if (soma.energy <= 0) return '能量耗尽'
  if (soma.cortisol >= 70) return '极度焦虑'
  if (soma.cortisol >= 60) return '焦虑'
  const serotonin = soma.serotonin ?? 50
  if (serotonin <= 25) return '极度烦躁'
  if (serotonin <= 40) return '烦躁'
  if (soma.dopamine >= 70) return '非常愉悦'
  if (soma.dopamine >= 60) return '愉悦'
  if (soma.dopamine < 40 && soma.cortisol < 40) return '平静'
  return '中性'
}

/**
 * 老桥（还没升 v0.9.6）推来的快照没有 `rest`，这里按默认值兜一个。
 * 宁可标签保守地显示"清醒"，也不要因为缺字段把整块面板渲染崩。
 */
export const FALLBACK_REST: RestInfo = { mode: 'awake', rate: 0.2, cap: 60 }

export const restOf = (soma: Soma): RestInfo => soma.rest ?? FALLBACK_REST

/** 深睡 / 深夜休息都算"在睡"——脉冲图的呼吸光晕只在这两种状态下亮。 */
export const isSleeping = (mode: RestMode): boolean => mode === 'deep-sleep' || mode === 'night-rest'

/** 每分钟回血速率的人话。0 表示"不动"，负数表示"在回落"。 */
export function rateText(rate: number): string {
  if (!Number.isFinite(rate) || rate === 0) return '暂停回血'
  return `${rate > 0 ? '+' : '−'}${Math.abs(rate).toFixed(1)} 点/分钟`
}

/**
 * 作息标签的配色（v0.9.6）。
 *
 * 造物主要求"极其显眼"，所以每个状态都给到：图标 + 发光描边 + 呼吸圆点 + 速率。
 * 清醒=绿、深睡=紫 是硬需求；其余两个沿用同一套语言的邻近色，不额外发明颜色。
 */
export const REST_STYLE: Record<RestMode, {
  icon: string
  label: string
  className: string
  dot: string
}> = {
  awake: {
    icon: '☀️',
    label: '清醒',
    className: 'border-emerald-400/40 bg-emerald-500/15 text-emerald-200',
    dot: 'bg-emerald-400',
  },
  'deep-sleep': {
    icon: '🌙',
    label: '深度睡眠（恢复中）',
    className: 'border-violet-400/50 bg-violet-500/20 text-violet-100',
    dot: 'bg-violet-400',
  },
  'night-rest': {
    icon: '🌙',
    label: '深夜休息（恢复中）',
    className: 'border-indigo-400/45 bg-indigo-500/20 text-indigo-100',
    dot: 'bg-indigo-300',
  },
  sated: {
    icon: '✨',
    label: '已回满（自然上限）',
    className: 'border-cyan-400/40 bg-cyan-400/15 text-cyan-100',
    dot: 'bg-cyan-300',
  },
  frozen: {
    icon: '🛑',
    label: '急停冻结（不回血）',
    className: 'border-rose-400/45 bg-rose-500/15 text-rose-200',
    dot: 'bg-rose-400',
  },
}

export const STATUS_STYLE: Record<OrganStatus, { dot: string; text: string; label: string }> = {
  loaded: { dot: 'bg-emerald-400', text: 'text-emerald-300', label: '运行中' },
  degraded: { dot: 'bg-amber-400', text: 'text-amber-300', label: '降级' },
  failed: { dot: 'bg-rose-500', text: 'text-rose-300', label: '装载失败' },
  unloaded: { dot: 'bg-slate-500', text: 'text-slate-400', label: '已卸载' },
}

/** 张力色阶：80 以下偏青，90 转橙，100 变红。 */
export function tensionColor(tension: number): string {
  if (tension >= 95) return '#f43f5e'
  if (tension >= 88) return '#fb923c'
  if (tension >= 80) return '#facc15'
  return '#22d3ee'
}
