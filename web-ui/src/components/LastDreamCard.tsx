import type { LastDreamView } from '../lib/types'

/** 把 ISO 时间戳说成人话：她问"我昨晚梦见了什么"，时间得能读。 */
function whenText(at: string): string {
  if (!at) return '（不知道什么时候做的）'
  const then = new Date(at).getTime()
  if (!Number.isFinite(then)) return '（不知道什么时候做的）'
  const minutes = Math.floor((Date.now() - then) / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

export function LastDreamCard({ dream }: { dream: LastDreamView | null }) {
  return (
    <div className="min-w-0 overflow-hidden rounded-xl border border-white/5 bg-white/[0.02] p-4">
      <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
        <h2 className="text-sm text-slate-200">上一场梦</h2>
        <span className="text-[11px] text-slate-500">
          {dream ? whenText(dream.at) : '还留着空位置'}
        </span>
        {dream && (
          <span
            className={`ml-auto rounded border px-1.5 py-0.5 text-[10px] ${
              dream.saved
                ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200/90'
                : 'border-amber-400/30 bg-amber-400/10 text-amber-200/90'
            }`}
          >
            {dream.saved ? `已入记忆${dream.savedTo ? `（${dream.savedTo}）` : ''}` : '没进记忆（核心留了档）'}
          </span>
        )}
      </div>

      {!dream ? (
        <p className="text-[11px] leading-relaxed text-slate-500">
          她还没做过梦。
          <span className="text-slate-600">
            （在她入梦之前，这一格就空着——空着也是实话，不拿一句假话填它。）
          </span>
        </p>
      ) : (
        <>
          {dream.gap && (
            <p className="mb-1.5 text-[11px] text-slate-500">
              梦见的是：<span className="text-slate-400">{dream.gap}</span>
            </p>
          )}
          {/* 正文是自由文本：高度给它个上限，超长的梦自己滚，不把整页撑开。 */}
          <div className="max-h-56 overflow-y-auto rounded-lg border border-white/5 bg-black/20 p-3">
            <p className="whitespace-pre-wrap break-words text-[12px] leading-relaxed text-slate-300">
              {dream.text}
            </p>
          </div>
          <p className="mt-2 text-[10px] text-slate-600">
            梦的正文由核心自己留档（state.json 的 lastDream），不依赖任何器官——
            海马体重载时它可能没接住，但这里永远在。
          </p>
        </>
      )}
    </div>
  )
}
