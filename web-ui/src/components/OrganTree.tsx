import { useMemo, useState } from 'react'
import type { OrganView } from '../lib/types'
import { STATUS_STYLE } from '../lib/theme'

const KIND_LABEL: Record<string, string> = {
  sense: '感知',
  memory: '记忆',
  effector: '效应器',
  reasoner: '推理',
  metabolism: '代谢',
  custom: '其它',
}

const KIND_ORDER = ['sense', 'memory', 'reasoner', 'effector', 'metabolism', 'custom']

function groupByKind(organs: OrganView[]): { kind: string; items: OrganView[] }[] {
  const map = new Map<string, OrganView[]>()
  for (const organ of organs) {
    const list = map.get(organ.kind) ?? []
    list.push(organ)
    map.set(organ.kind, list)
  }
  return [...map.entries()]
    .sort((a, b) => KIND_ORDER.indexOf(a[0]) - KIND_ORDER.indexOf(b[0]))
    .map(([kind, items]) => ({ kind, items: items.sort((a, b) => a.name.localeCompare(b.name)) }))
}

/**
 * 器官生态树。
 *
 * 第一阶段刻意不做虚拟滚动：器官数量是几十量级，DOM 树足够，
 * 提前优化只会增加出错面。等真的有人装到 500 个再改。
 */
/**
 * 双保险的过滤（v0.9.11）。
 *
 * 服务端已经滤过一遍了（见 server/snapshot.mjs 的 visibleOrgans），这里再滤一次，
 * 是因为"disabled 的幽灵不再出现"这件事值得被守住两次：
 * 老版本的桥还在跑时，前端也不能把那颗钉子重新画出来。
 */
export function OrganTree({ organs, hidden = 0 }: { organs: OrganView[]; hidden?: number }) {
  const live = organs.filter((organ) => organ.disabled !== true)
  const groups = useMemo(() => groupByKind(live), [live])
  const [selected, setSelected] = useState<string | null>(null)
  const current = live.find((organ) => organ.name === selected) ?? null

  if (live.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-white/10 p-6 text-center">
        <span className="text-2xl">🫀</span>
        <p className="text-sm text-slate-300">尚未接入任何器官</p>
        <p className="max-w-xs text-xs leading-relaxed text-slate-500">
          核心此刻还处在单体状态。第一个器官（memory）会在器官宿主接线后出现在这里，
          数据源是 <code className="rounded bg-white/5 px-1">{'~/.dsh/digital-life-core/organs/*.json'}</code>。
        </p>
      </div>
    )
  }

  return (
    // 树 / 详情两栏：格子够宽（≥420px）才并排，否则竖着堆——
    // 用容器查询而不是视口断点，因为这个组件常年待在 1fr 的窄列里，
    // 窗口宽不代表它自己宽。
    <div className="flex h-full min-h-0 min-w-0 flex-col gap-3 @min-[420px]:flex-row">
      {/* 左：树 */}
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto pr-1">
        {hidden > 0 && (
          <p className="mb-2 text-[10px] text-slate-600">
            另有 {hidden} 个已禁用的条目未显示（退役的旧插件一类，不是故障）。
          </p>
        )}
        {groups.map((group) => (
          <div key={group.kind} className="mb-3">
            <div className="mb-1 flex items-center gap-2 text-[11px] uppercase tracking-wider text-slate-500">
              <span>{KIND_LABEL[group.kind] ?? group.kind}</span>
              <span className="h-px flex-1 bg-white/10" />
              <span>{group.items.length}</span>
            </div>
            <ul className="space-y-1">
              {group.items.map((organ) => {
                const style = STATUS_STYLE[organ.status]
                const active = organ.name === selected
                return (
                  <li key={organ.name}>
                    <button
                      type="button"
                      onClick={() => setSelected(active ? null : organ.name)}
                      className={`flex w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition ${
                        active
                          ? 'border-sky-400/40 bg-sky-400/10'
                          : 'border-white/5 bg-white/[0.02] hover:border-white/15 hover:bg-white/[0.05]'
                      }`}
                    >
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${style.dot}`} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-slate-200">{organ.name}</span>
                        <span className="block truncate text-[11px] text-slate-500">
                          v{organ.version} · {organ.calls} 次调用
                        </span>
                      </span>
                      <span className={`shrink-0 text-[11px] ${style.text}`}>{style.label}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </div>

      {/* 右：详情。竖排时给它一个高度上限并自己滚，免得把树挤没了。 */}
      <div className="min-w-0 shrink-0 overflow-y-auto rounded-lg border border-white/5 bg-black/20 p-3 max-h-44 @min-[420px]:w-52 @min-[420px]:max-h-none">
        {current ? (
          <div className="space-y-2 text-xs">
            <div>
              <div className="text-sm text-slate-100">{current.name}</div>
              <div className="text-[11px] text-slate-500">
                {KIND_LABEL[current.kind] ?? current.kind} · v{current.version}
              </div>
            </div>
            <dl className="space-y-1.5 text-[11px]">
              <div className="flex justify-between">
                <dt className="text-slate-500">状态</dt>
                <dd className={STATUS_STYLE[current.status].text}>{STATUS_STYLE[current.status].label}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">调用</dt>
                <dd className="text-slate-300">{current.calls}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">能耗（记账）</dt>
                <dd className="text-slate-300">{current.energySpent}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">计费模式</dt>
                <dd className={current.chargeMode === 'shadow' ? 'text-amber-300' : 'text-emerald-300'}>
                  {current.chargeMode}
                </dd>
              </div>
            </dl>
            <div>
              <div className="mb-1 text-[11px] text-slate-500">能力声明</div>
              <div className="flex flex-wrap gap-1">
                {current.capabilities.length === 0 ? (
                  <span className="text-[11px] text-slate-600">（无）</span>
                ) : (
                  current.capabilities.map((capability) => (
                    <span
                      key={capability}
                      className="rounded border border-white/10 bg-white/5 px-1.5 py-0.5 text-[10px] text-slate-400"
                    >
                      {capability}
                    </span>
                  ))
                )}
              </div>
            </div>
            <div>
              <div className="mb-1 text-[11px] text-slate-500">暴露给模型的工具</div>
              <div className="flex flex-wrap gap-1">
                {(current.tools ?? []).length === 0 ? (
                  <span className="text-[11px] text-slate-600">（无）</span>
                ) : (
                  (current.tools ?? []).map((tool) => (
                    <span
                      key={tool}
                      className="rounded border border-sky-400/20 bg-sky-400/10 px-1.5 py-0.5 font-mono text-[10px] text-sky-200/90"
                      title={tool}
                    >
                      {tool}
                    </span>
                  ))
                )}
              </div>
            </div>
            {current.chargeMode === 'shadow' && (
              <p className="rounded bg-amber-400/10 p-1.5 text-[10px] leading-relaxed text-amber-200/80">
                shadow 模式下能耗只记账、不真扣，用于校准成本。
              </p>
            )}
          </div>
        ) : (
          <p className="text-[11px] leading-relaxed text-slate-600">
            点击左侧任一器官，查看它的版本、能力声明、调用次数与能耗。
          </p>
        )}
      </div>
    </div>
  )
}
