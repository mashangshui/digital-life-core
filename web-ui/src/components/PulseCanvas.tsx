import { useEffect, useMemo, useRef } from 'react'
import type { PulseBus } from '../lib/usePulse'
import type { ChemicalView, PulseSample, RestMode, Soma } from '../lib/types'
import { COLORS, isSleeping, pulseSeries, seriesValue } from '../lib/theme'

/** 显示窗口：最近 60 秒。 */
const WINDOW_MS = 60_000
/** 环形缓冲上限：1200 点 = 60s@20Hz，足够覆盖最密的推送。 */
const MAX_SAMPLES = 1_200

/**
 * 呼吸周期（毫秒）。
 *
 * 睡得越沉，呼吸越慢——深睡 4.6 秒一次，只是夜里躺着歇着 6 秒一次。
 * 这不是装饰：光晕的节奏就是它"呼吸"的节奏，用同一个数驱动 canvas 和 CSS 两层，
 * 才不会出现"外圈在吸气、内圈在呼气"的错拍。
 */
const BREATH_MS: Record<RestMode, number> = {
  'deep-sleep': 4_600,
  'night-rest': 6_000,
  // 下面三个不该被读到（isSleeping 已经过滤掉），给同一个值只为让类型完整。
  awake: 4_600,
  sated: 4_600,
  frozen: 4_600,
}

/**
 * 神经脉冲图。
 *
 * 为什么是手写 Canvas 而不是图表库：
 *   10Hz × 3 条曲线，React 每条消息 setState 会重渲染整棵树；
 *   而图表库为三条折线引入 ~200KB。这里热路径完全不碰 React——
 *   订阅把点塞进 ref 数组，rAF 直接 stroke。
 */
export function PulseCanvas({
  bus,
  restMode = 'awake',
  chemicals,
  soma,
}: {
  bus: PulseBus
  restMode?: RestMode
  /**
   * 化学池全景。她造出催产素的那一刻，这里就会多一条——图上跟着多一根线。
   * 不传（老桥）则退回出厂三件套。
   */
  chemicals?: ChemicalView[]
  /** 老桥没有 chemicals 全表时，用它兜出三件套。 */
  soma: Soma
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const samplesRef = useRef<PulseSample[]>([])
  const frozenRef = useRef(false)
  // 作息是低频数据（每次快照才变），但 rAF 循环要读它——塞进 ref，别让循环闭包抓到旧值。
  const restRef = useRef<RestMode>(restMode)
  useEffect(() => {
    restRef.current = restMode
  }, [restMode])

  // 画哪几条线由快照说了算（v0.9.19）。
  const series = useMemo(() => pulseSeries(chemicals, soma), [chemicals, soma])
  // 但 rAF 循环不能因为 props 变了就重建（那会丢掉缓冲区），所以塞进 ref。
  const seriesRef = useRef(series)
  useEffect(() => {
    seriesRef.current = series
  }, [series])

  // ① 订阅：只写 ref，不触发渲染
  useEffect(() => {
    return bus.subscribe((sample) => {
      const samples = samplesRef.current
      samples.push(sample)
      frozenRef.current = sample.frozen
      if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES)
    })
  }, [bus])

  // ② 绘制：rAF 常驻，DPR 自适应
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let raf = 0
    let width = 1
    let height = 1

    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      width = Math.max(1, Math.floor(rect.width))
      height = Math.max(1, Math.floor(rect.height))
      canvas.width = Math.floor(width * dpr)
      canvas.height = Math.floor(height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)

    const drawEmpty = () => {
      ctx.clearRect(0, 0, width, height)
      ctx.fillStyle = COLORS.muted
      ctx.font = '13px ui-sans-serif, system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText('等待神经脉冲…（让数字生命做点什么，或确认 bridge 已连上状态文件）', width / 2, height / 2)
      ctx.textAlign = 'left'
    }

    const draw = () => {
      const now = Date.now()
      const from = now - WINDOW_MS
      const samples = samplesRef.current.filter((sample) => sample.t >= from)

      ctx.clearRect(0, 0, width, height)

      // 睡眠呼吸光晕：睡着的那一层"还在活着"的证明。
      // 刻意压到 0.03~0.09 alpha——再亮一点就会盖住曲线，那就本末倒置了。
      const rest = restRef.current
      if (isSleeping(rest)) {
        const period = BREATH_MS[rest]
        const phase = (Math.sin((now / period) * Math.PI * 2) + 1) / 2 // 0..1
        const alpha = 0.03 + phase * 0.06
        const radius = Math.max(width, height) * 0.75
        const glow = ctx.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, radius)
        glow.addColorStop(0, `rgba(167, 139, 250, ${alpha.toFixed(3)})`)
        glow.addColorStop(1, 'rgba(167, 139, 250, 0)')
        ctx.fillStyle = glow
        ctx.fillRect(0, 0, width, height)
      }

      // 网格：0 / 25 / 50 / 75 / 100
      ctx.strokeStyle = COLORS.grid
      ctx.lineWidth = 1
      ctx.font = '10px ui-monospace, monospace'
      ctx.fillStyle = COLORS.muted
      for (const value of [0, 25, 50, 75, 100]) {
        const y = height - (value / 100) * height
        ctx.beginPath()
        ctx.moveTo(0, y)
        ctx.lineTo(width, y)
        ctx.stroke()
        ctx.fillText(String(value), 4, Math.min(height - 2, y - 3))
      }

      if (samples.length === 0) {
        drawEmpty()
        return
      }

      const xOf = (t: number) => ((t - from) / WINDOW_MS) * width
      // 归一化：激素各自的满值是 max（多数是 100，但基因组里可以改），
      // 能量是 maxEnergy。按各自的满值画，才不会出现"上限 200 的激素永远只画半格"。
      const yOf = (value: number, max: number) => height - (Math.max(0, Math.min(max, value)) / (max > 0 ? max : 100)) * height

      for (const line of seriesRef.current) {
        const valueOf = (sample: PulseSample) => seriesValue(sample, line.key)

        // 这条线在这个窗口里一个点都没有（老桥没递它的值）→ 跳过，
        // 不要画一条趴在 0 上的假线，那是伪造数据。
        const visible = samples.filter((sample) => valueOf(sample) !== null)
        if (visible.length === 0) continue

        ctx.beginPath()
        visible.forEach((sample, index) => {
          const x = xOf(sample.t)
          const y = yOf(valueOf(sample) ?? 0, line.max)
          if (index === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        })

        ctx.strokeStyle = line.color
        ctx.lineWidth = 1.8
        ctx.lineJoin = 'round'
        ctx.shadowColor = line.color
        ctx.shadowBlur = 6
        ctx.stroke()
        ctx.shadowBlur = 0

        // 单点时画一个点，否则"有数据但看不见"
        if (visible.length === 1) {
          const only = visible[0]
          ctx.beginPath()
          ctx.fillStyle = line.color
          ctx.arc(xOf(only.t), yOf(valueOf(only) ?? 0, line.max), 2.5, 0, Math.PI * 2)
          ctx.fill()
        }
      }

      // 冻结时压一层红：状态本身就该被看见
      if (frozenRef.current) {
        ctx.fillStyle = 'rgba(244, 63, 94, 0.08)'
        ctx.fillRect(0, 0, width, height)
      }
    }

    const loop = () => {
      draw()
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
    }
  }, [])

  return (
    // 呼吸周期写进 CSS 变量，让外圈光晕和 canvas 内层用同一个节奏（见 BREATH_MS）
    <div
      className={`relative h-full w-full${isSleeping(restMode) ? ' is-sleeping' : ''}`}
      style={isSleeping(restMode) ? { ['--breath-ms' as string]: `${BREATH_MS[restMode]}ms` } : undefined}
    >
      {/* block：canvas 默认是 inline，底部会多出几像素基线空隙，撑得父容器对不齐 */}
      <canvas ref={canvasRef} className="block h-full w-full" />
      {/* 图例在窄屏会换行，所以右对齐改成可换行的 flex，而不是死守一行 */}
      {/* 图例也是遍历出来的：她造了多少种，这里就有多少个名字 */}
      <div className="pointer-events-none absolute right-3 top-2 flex max-w-[calc(100%-1.5rem)] flex-wrap justify-end gap-x-3 gap-y-1">
        {series.map((line) => (
          <span key={line.key} className="flex items-center gap-1.5 text-[11px] text-slate-400">
            <span className="inline-block h-[2px] w-4 rounded" style={{ backgroundColor: line.color }} />
            {/* 她自己造的激素：图例上点一下就知道，不必去猜它为什么没在出厂设定里 */}
            {line.runtime && (
              <span className="text-violet-300" title="这是她自己用 ctx.inflict 造出来的激素，不在出厂基因组里">
                *
              </span>
            )}
            {line.label}
          </span>
        ))}
      </div>
    </div>
  )
}
