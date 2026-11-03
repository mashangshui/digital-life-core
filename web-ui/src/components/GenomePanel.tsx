import { useState } from 'react'
import type { ChemicalView } from '../lib/types'

/**
 * 基因面板（v0.9.11）—— 用滑块直接调她的出厂性格。
 *
 * 三条设计取舍：
 *
 *  1. **只调当下，不改定义。** 滑块改的是"这个值现在是多少"（写进 state.json），
 *     而不是 genome.json 里的基线与半衰期。想改"她是个什么性情的人"就去改那个文件，
 *     这里只是"此刻把她推进某种心情"。
 *
 *  2. **松手才写。** 拖动过程中每秒 POST 十几次会把 state.json 刷爆，
 *     也会让她的激素曲线变成锯齿。所以 `onChange` 只改本地，`onPointerUp` 才落盘。
 *
 *  3. **失败要说出来。** 写不回去（桥没开 / 值越界）时面板上直接显示原因，
 *     而不是让滑块"看起来生效了其实没有"。
 */

/**
 * 默认走**同源相对路径** `/api/genome`，由 Vite 代理转到桥（见 vite.config.ts 的 proxy）。
 *
 * 以前这里写死 `http://<hostname>:8787`：那样两个后果——
 *   1. 绕过代理，变成跨端口的跨域请求，桥那边的放行头一变就 Failed to fetch；
 *   2. `location.hostname` 在 Windows 上可能先解析到 ::1（IPv6），
 *      而桥只听 127.0.0.1，于是连不上——报错却长得一模一样，极难排查。
 *
 * 只有显式带 `?bridge=http://host:port` 时才直连（给脱离 Vite 单独部署前端的场合留的口子）。
 */
const BRIDGE_OVERRIDE = new URLSearchParams(location.search).get('bridge')
const GENOME_ENDPOINT = BRIDGE_OVERRIDE ? `${BRIDGE_OVERRIDE}/api/genome` : '/api/genome'

export function GenomePanel({ chemicals }: { chemicals: ChemicalView[] }) {
  const [draft, setDraft] = useState<Record<string, number>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  if (!chemicals || chemicals.length === 0) return null

  const valueOf = (item: ChemicalView): number => draft[item.id] ?? item.value

  const save = async (): Promise<void> => {
    const patch = { ...draft }
    if (Object.keys(patch).length === 0) return
    setSaving(true)
    setError(null)
    try {
      const response = await fetch(GENOME_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      })
      const payload = await response.json()
      if (!payload?.ok) {
        setError(payload?.error ?? `写入失败（HTTP ${response.status}）`)
        return
      }
      setDraft({})
      setNote(payload.rejected?.length
        ? `已改 ${payload.applied.join('，')}；被拒：${payload.rejected.join('；')}`
        : `已改 ${payload.applied.join('，')}`)
    } catch (e) {
      // 桥没启动是最常见的原因，所以这句话要说在前面。
      setError(`连不上桥（npm run bridge？）：${String(e).slice(0, 80)}`)
    } finally {
      setSaving(false)
    }
  }

  const dirty = Object.keys(draft).length > 0

  return (
    <div className="min-w-0 overflow-hidden rounded-xl border border-white/5 bg-white/[0.02] p-4">
      <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1">
        <h2 className="text-sm text-slate-200">基因面板</h2>
        <span className="text-[11px] text-slate-500">拖动滑块 = 直接调她的化学水平</span>
        {dirty && (
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className="ml-auto rounded border border-cyan-400/45 bg-cyan-400/10 px-2.5 py-0.5 text-[11px] text-cyan-100 hover:border-cyan-300/80 disabled:opacity-50"
          >
            {saving ? '写入中…' : '落盘'}
          </button>
        )}
      </div>

      <div className="space-y-3">
        {chemicals.map((item) => (
          <div key={item.id}>
            <div className="mb-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11px]">
              <span className="text-slate-300">{item.label}</span>
              <span className="font-mono text-slate-500">{item.id}</span>
              {item.runtime && (
                <span
                  className="rounded bg-violet-500/15 px-1 text-[10px] text-violet-300"
                  title="这是她自己用 ctx.inflict 造出来的激素，不在出厂基因组里"
                >
                  她自己造的
                </span>
              )}
              <span className="ml-auto font-mono text-slate-400">
                {valueOf(item).toFixed(0)}
              </span>
              <span className="text-[10px] text-slate-600">基线 {item.baseline}</span>
              <span className="text-[10px] text-slate-600">半衰期 {item.halfLifeMinutes}min</span>
            </div>
            {/* v0.9.18：直接用桥算好的颜色（自造激素的色由 id 推出来），不再到处写 fallback */}
            <input
              type="range"
              min={item.min}
              max={item.max}
              step={Number(item.step || 1)}
              value={valueOf(item)}
              onChange={(event) => {
                setNote(null)
                setDraft((current) => ({ ...current, [item.id]: Number(event.target.value) }))
              }}
              onPointerUp={() => { /* 松手不立刻写：允许连续微调多个滑块再一次落盘 */ }}
              className="w-full accent-cyan-400"
              style={{ accentColor: item.color }}
            />
            {item.description && (
              <p className="mt-0.5 text-[10px] leading-relaxed text-slate-600">{item.description}</p>
            )}
          </div>
        ))}
      </div>

      {error && (
        <p className="mt-3 rounded border border-rose-500/20 bg-rose-500/10 px-2 py-1 text-[11px] text-rose-200">
          {error}
        </p>
      )}
      {note && <p className="mt-2 text-[11px] text-emerald-300/80">{note}</p>}
      <p className="mt-2 text-[10px] text-slate-600">
        改的是"她此刻是多少"，下一轮衰减就生效，不用重启 DSH。
        想改"她是什么性情"（基线与半衰期），去编辑项目根的 genome.json。
      </p>
    </div>
  )
}
