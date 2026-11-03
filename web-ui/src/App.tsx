import { useMemo, useState } from 'react'
import type { GapView } from './lib/types'
import { restOf, tensionColor } from './lib/theme'
import { usePulseStream } from './lib/usePulse'
import { PulseCanvas } from './components/PulseCanvas'
import { OrganTree } from './components/OrganTree'
import { GenomePanel } from './components/GenomePanel'
import { LastDreamCard } from './components/LastDreamCard'
import { TemperamentPanel } from './components/TemperamentPanel'
import { StatBar } from './components/StatBar'
import { ManualDrawer } from './components/ManualDrawer'
import { mockSnapshot } from './data/mock'

const STATUS_STYLE: Record<string, { label: string; className: string }> = {
  connecting: { label: '连接中', className: 'bg-slate-500/20 text-slate-300' },
  live: { label: '实时', className: 'bg-emerald-500/15 text-emerald-300' },
  polling: { label: '轮询降级', className: 'bg-amber-500/15 text-amber-300' },
  offline: { label: '离线', className: 'bg-rose-500/15 text-rose-300' },
}

function GapList({ gaps }: { gaps: GapView[] }) {
  const [showResolved, setShowResolved] = useState(false)
  const visible = useMemo(() => {
    const filtered = showResolved ? gaps : gaps.filter((gap) => gap.status === 'open')
    return [...filtered].sort((a, b) => b.tension - a.tension).slice(0, 12)
  }, [gaps, showResolved])

  const openCount = gaps.filter((gap) => gap.status === 'open').length

  return (
    // @container：让面板内部的取舍看"格子有多宽"，而不是看窗口有多宽——
    // 它常待在 1fr 的窄列里，用视口断点判断会一直判错。
    <div className="@container min-w-0 overflow-hidden rounded-xl border border-white/5 bg-white/[0.02] p-4">
      <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
        <h2 className="text-sm text-slate-200">执念池</h2>
        <span className="text-[11px] text-slate-500">未解 {openCount} · 已闭合 {gaps.length - openCount}</span>
        <button
          type="button"
          onClick={() => setShowResolved((value) => !value)}
          className="ml-auto rounded border border-white/10 px-2 py-0.5 text-[11px] text-slate-400 hover:border-white/25 hover:text-slate-200"
        >
          {showResolved ? '只看未解' : '含已闭合'}
        </button>
      </div>

      {visible.length === 0 ? (
        <p className="py-6 text-center text-xs text-slate-600">池子是空的。它此刻没有挂念的事。</p>
      ) : (
        <ul className="space-y-1.5">
          {visible.map((gap) => {
            const color = tensionColor(gap.tension)
            return (
              <li key={gap.id} className="flex min-w-0 items-center gap-2">
                <span className="w-8 shrink-0 text-right font-mono text-[11px]" style={{ color }}>
                  {Math.round(gap.tension)}
                </span>
                <span className="h-1.5 w-14 shrink-0 overflow-hidden rounded-full bg-white/10">
                  <span
                    className="block h-full rounded-full"
                    style={{ width: `${Math.max(2, Math.min(100, gap.tension))}%`, backgroundColor: color }}
                  />
                </span>
                <span
                  className={`min-w-0 flex-1 truncate text-xs ${
                    gap.status === 'resolved' ? 'text-slate-600 line-through' : 'text-slate-300'
                  }`}
                  title={gap.summary}
                >
                  {gap.summary}
                </span>
                {/* 来源标签在窄屏先让位——执念的正文比出处重要 */}
                <span className="hidden shrink-0 text-[10px] text-slate-600 @min-[380px]:inline">{gap.source}</span>
              </li>
            )
          })}
        </ul>
      )}
      <p className="mt-2 text-[10px] text-slate-600">力导向裂变图在 PR4 落地；这里先用可读的数值列表。</p>
    </div>
  )
}

export default function App() {
  const { status, snapshot, bus, lastError } = usePulseStream()
  const demo = new URLSearchParams(location.search).get('demo') === '1'
  const data = demo ? mockSnapshot : snapshot
  // `?manual=1` 直接打开手册：便于收藏一个"只看手册"的链接，也方便截图排错。
  const [manualOpen, setManualOpen] = useState(
    () => new URLSearchParams(location.search).get('manual') === '1',
  )

  return (
    // 页面级滚动：整页随内容长高，不锁死视口高度（面板内部各自滚）。
    // `min-w-0` + `overflow-x-hidden` 是最后一道兜底：任何一格里的长工具名
    // 都不许把整页顶出横向滚动条。
    <div className="mx-auto min-h-screen w-full min-w-0 max-w-6xl overflow-x-hidden px-4 py-5 sm:px-5 sm:py-6 2xl:max-w-7xl">
      <header className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0">
          <h1 className="text-lg font-medium tracking-wide text-slate-100">Life-OS · 进化中枢</h1>
          <p className="text-[11px] text-slate-500">只读观测台 · 数据源 ~/.dsh/digital-life-core/state.json</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {demo && (
            <span className="rounded bg-violet-500/15 px-2 py-1 text-[11px] text-violet-300">演示数据</span>
          )}
          <span className={`rounded px-2 py-1 text-[11px] ${STATUS_STYLE[status]?.className ?? ''}`}>
            {STATUS_STYLE[status]?.label ?? status}
          </span>
          <button
            type="button"
            onClick={() => setManualOpen(true)}
            title="打开内置操作手册（Esc 关闭）"
            className="neon-btn group relative rounded-md border border-cyan-400/45 bg-cyan-400/10 px-2.5 py-1 text-[11px] text-cyan-100 transition-colors hover:border-cyan-300/80 hover:bg-cyan-400/20 hover:text-white"
          >
            <span className="relative z-10">📖 操作手册</span>
          </button>
        </div>
      </header>

      {lastError && (
        <div className="mb-4 rounded-lg border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
          连接异常：{lastError}
          <span className="ml-2 text-rose-300/70">（bridge 是否已启动？npm run bridge）</span>
        </div>
      )}

      {!data ? (
        <div className="rounded-xl border border-dashed border-white/10 p-10 text-center text-sm text-slate-400">
          还没有数据。
          <p className="mt-2 text-xs text-slate-600">
            先启动只读桥：<code className="rounded bg-white/5 px-1">npm run bridge</code>
            ，或加 <code className="rounded bg-white/5 px-1">?demo=1</code> 看演示布局。
          </p>
        </div>
      ) : (
        <div className="min-w-0 space-y-4">
          <StatBar soma={data.soma} counters={data.counters} chemicals={data.chemicals} />

          {/* 一行两格：窄屏自动堆成一列（grid 默认单列），lg 起才分栏。
              每个子项都带 min-w-0——grid 轨道是 minmax(auto, fr)，
              不给子项关掉 min-width:auto，一条长工具名就能把整行撑破。 */}
          <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
            <section className="min-w-0 overflow-hidden rounded-xl border border-white/5 bg-white/[0.02] p-3">
              <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 px-1">
                <h2 className="text-sm text-slate-200">神经脉冲</h2>
                <span className="text-[11px] text-slate-500">最近 60 秒 · 10Hz</span>
              </div>
              {/* 高度跟着视口走，但有上下限：矮屏不至于压成一条线，高屏也不会拉成空墙 */}
              <div className="h-52 min-h-[10rem] sm:h-64 lg:h-[min(52vh,22rem)]">
                <PulseCanvas
                  bus={bus}
                  restMode={restOf(data.soma).mode}
                  chemicals={data.chemicals}
                  soma={data.soma}
                />
              </div>
            </section>

            {/* @container：器官树的"树 / 详情"分栏按这一格的实际宽度决定，
                而不是按窗口——它长期待在 1fr 的窄列里。 */}
            <section className="@container min-w-0 overflow-hidden rounded-xl border border-white/5 bg-white/[0.02] p-3">
              <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 px-1">
                <h2 className="text-sm text-slate-200">器官生态</h2>
                <span className="text-[11px] text-slate-500">{data.organs.length} 个</span>
              </div>
              <div className="h-52 min-h-[10rem] sm:h-64 lg:h-[min(52vh,22rem)]">
                <OrganTree organs={data.organs} hidden={data.organsHidden ?? 0} />
              </div>
            </section>
          </div>

          <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
            <div className="min-w-0 space-y-4">
              <GapList gaps={data.gaps} />
              <LastDreamCard dream={data.lastDream ?? null} />
            </div>
            <div className="min-w-0 space-y-4">
              <GenomePanel chemicals={data.genome?.chemicals ?? []} />
              <TemperamentPanel temperament={data.genome?.temperament} />
            </div>
          </div>
        </div>
      )}

      <footer className="mt-6 text-[10px] text-slate-600">
        第一阶段只读：本页面不提供任何写接口。急停与改状态请走 /digital-life 命令或工具。
      </footer>

      <ManualDrawer open={manualOpen} onClose={() => setManualOpen(false)} />
    </div>
  )
}
