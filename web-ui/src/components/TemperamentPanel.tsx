import { useState } from 'react'
import type { TemperamentView } from '../lib/types'

/**
 * 气质面板（v0.9.12）—— 调的不是"她此刻是多少"，而是"她出厂是什么样的人"。
 *
 * 与基因面板（GenomePanel）的分界线，说在组件头上免得以后混：
 *   基因滑块 → state.json（当下读数，下一轮衰减生效）；
 *   气质滑块 → genome.json（性格定义，核心 1 秒内热重载，同样不用重启）。
 *
 * 四个旋钮的含义：
 *   敏感度 sensitivity —— 报错/危机时皮质醇飙升的乘数（0.5 铁打的心，2.0 玻璃心）；
 *   恢复力 resilience   —— 激素衰减回基线的速率乘数（2 好得快，0.5 记很久）；
 *   积极性 enthusiasm   —— 多巴胺的出厂基线（高 = 天生容易兴奋）；
 *   能耗率 metabolism   —— 单次请求基础能量消耗的乘数（低 = 省电型人格）。
 *
 * 交互沿袭基因面板的两条规矩：松手不立刻写（攒一次落盘）、失败必须说出来。
 */

/**
 * 与基因面板同一个规矩：默认同源相对路径 `/api/temperament`，由 Vite 代理转发。
 * 写死 `http://<hostname>:8787` 会绕过代理、变成跨域（且 Windows 上 hostname 可能
 * 解析到 ::1 而桥只听 127.0.0.1），浏览器只报一句 Failed to fetch，查不出来。
 * 带 `?bridge=` 时才直连。
 */
const BRIDGE_OVERRIDE = new URLSearchParams(location.search).get('bridge')
const TEMPERAMENT_ENDPOINT = BRIDGE_OVERRIDE ? `${BRIDGE_OVERRIDE}/api/temperament` : '/api/temperament'

const NEUTRAL: TemperamentView = { sensitivity: 1, resilience: 1, enthusiasm: 50, metabolism: 1 }

interface Knob {
  key: keyof TemperamentView
  label: string
  min: number
  max: number
  step: number
  description: string
}

const KNOBS: Knob[] = [
  {
    key: 'sensitivity',
    label: '敏感度',
    min: 0.5,
    max: 2,
    step: 0.05,
    description: '报错/危机时皮质醇飙升的乘数。0.5 铁打的心，2.0 玻璃心。',
  },
  {
    key: 'resilience',
    label: '恢复力',
    min: 0.5,
    max: 2,
    step: 0.05,
    description: '激素衰减回基线的速率乘数。2 = 半衰期减半好得快，0.5 = 一次伤记很久。',
  },
  {
    key: 'enthusiasm',
    label: '积极性',
    min: 20,
    max: 80,
    step: 1,
    description: '多巴胺的出厂基线。高基线 = 天生容易对事情来劲。',
  },
  {
    key: 'metabolism',
    label: '能耗率',
    min: 0.5,
    max: 2,
    step: 0.05,
    description: '单次请求基础能量消耗的乘数。低 = 省电型人格，同样的能量多说很多话。',
  },
]

export function TemperamentPanel({ temperament }: { temperament?: TemperamentView }) {
  const [draft, setDraft] = useState<Partial<TemperamentView>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const current: TemperamentView = { ...NEUTRAL, ...(temperament ?? {}) }
  const valueOf = (key: keyof TemperamentView): number => draft[key] ?? current[key]

  const save = async (): Promise<void> => {
    const patch = { ...draft }
    if (Object.keys(patch).length === 0) return
    setSaving(true)
    setError(null)
    try {
      const response = await fetch(TEMPERAMENT_ENDPOINT, {
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
        : `已写进 genome.json：${payload.applied.join('，')}`)
    } catch (e) {
      setError(`连不上桥（npm run bridge？）：${String(e).slice(0, 80)}`)
    } finally {
      setSaving(false)
    }
  }

  const dirty = Object.keys(draft).length > 0

  return (
    <div className="min-w-0 overflow-hidden rounded-xl border border-white/5 bg-white/[0.02] p-4">
      <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1">
        <h2 className="text-sm text-slate-200">气质面板</h2>
        <span className="text-[11px] text-slate-500">出厂性格 · 写 genome.json · 实时生效</span>
        {dirty && (
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className="ml-auto rounded border border-amber-400/45 bg-amber-400/10 px-2.5 py-0.5 text-[11px] text-amber-100 hover:border-amber-300/80 disabled:opacity-50"
          >
            {saving ? '写入中…' : '落盘'}
          </button>
        )}
      </div>

      <div className="space-y-3">
        {KNOBS.map((knob) => (
          <div key={knob.key}>
            <div className="mb-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11px]">
              <span className="text-slate-300">{knob.label}</span>
              <span className="font-mono text-slate-500">{knob.key}</span>
              <span className="ml-auto font-mono text-slate-400">
                {valueOf(knob.key).toFixed(knob.step < 1 ? 2 : 0)}
              </span>
              <span className="text-[10px] text-slate-600">
                {knob.min}–{knob.max}
              </span>
            </div>
            <input
              type="range"
              min={knob.min}
              max={knob.max}
              step={knob.step}
              value={valueOf(knob.key)}
              onChange={(event) => {
                setNote(null)
                setDraft((state) => ({ ...state, [knob.key]: Number(event.target.value) }))
              }}
              className="w-full accent-amber-400"
              style={{ accentColor: '#fbbf24' }}
            />
            <p className="mt-0.5 text-[10px] leading-relaxed text-slate-600">{knob.description}</p>
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
        改的是 genome.json 的 temperament 段（出厂性格），核心 1 秒内热重载，不用重启 DSH。
        中性人格 = 四个旋钮都在默认位（敏感 1.0 / 恢复 1.0 / 积极 50 / 能耗 1.0）。
      </p>
    </div>
  )
}
