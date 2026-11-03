/**
 * 脉冲数据订阅。
 *
 * 设计要点：**高频数据不进 React state**。
 * 10Hz 的采样如果走 setState，每一帧都会重渲染整棵树；这里只在 WebSocket 层面
 * 分发到订阅者（PulseCanvas 自己用 rAF 画），React 只承担"低频"的快照更新。
 */

import { useEffect, useRef, useState } from 'react'
import type { ConnStatus, PulseSample, ServerMessage, Snapshot } from './types'

export interface PulseBus {
  subscribe(listener: (sample: PulseSample) => void): () => void
}

/** 样本缓存上限：1200 点 = 60s@20Hz，与 PulseCanvas 的环形缓冲保持一致。 */
const MAX_HISTORY = 1_200

export interface PulseStream {
  status: ConnStatus
  snapshot: Snapshot | null
  bus: PulseBus
  /** 最近一次错误，便于在 UI 上如实显示"为什么是空屏"。 */
  lastError: string | null
}

export function usePulseStream(): PulseStream {
  const [status, setStatus] = useState<ConnStatus>('connecting')
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [lastError, setLastError] = useState<string | null>(null)

  // 订阅者集合放在 ref：它永远不参与渲染，只被 rAF 循环消费。
  const listenersRef = useRef(new Set<(sample: PulseSample) => void>())
  /** 最近发过的样本。给"晚到的订阅者"补课用，见 subscribe 里的注释。 */
  const historyRef = useRef<PulseSample[]>([])
  const busRef = useRef<PulseBus>({
    subscribe(listener) {
      // 新订阅者先补一遍历史。
      //
      // 为什么必须补：PulseCanvas 挂在 `data ? … : …` 的分支里，只有拿到第一份快照后才挂载。
      // 而 pulseHistory 是随那份快照一起发出来的——发出时还没人订阅，点就全丢了。
      // 结果首屏永远显示"等待神经脉冲…"，要等下一次状态变化才画得出来。
      for (const sample of historyRef.current) listener(sample)
      listenersRef.current.add(listener)
      return () => listenersRef.current.delete(listener)
    },
  })

  useEffect(() => {
    let ws: WebSocket | null = null
    let reconnectTimer: number | undefined
    let pollTimer: number | undefined
    let closedByUs = false

    const emit = (sample: PulseSample) => {
      const history = historyRef.current
      history.push(sample)
      // 上限与 PulseCanvas 对齐（1200 点 = 60s@20Hz），别让长时间挂机把内存吃穿
      if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY)
      for (const listener of listenersRef.current) listener(sample)
    }

    const startPolling = () => {
      if (pollTimer !== undefined) return
      setStatus('polling')
      const tick = async () => {
        try {
          const res = await fetch('/api/snapshot', { cache: 'no-store' })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const data = (await res.json()) as Snapshot & { pulseHistory?: PulseSample[] }
          setSnapshot(data)
          setLastError(null)
          for (const sample of data.pulseHistory ?? []) emit(sample)
        } catch (error) {
          setStatus('offline')
          setLastError(error instanceof Error ? error.message : String(error))
        }
      }
      void tick()
      pollTimer = window.setInterval(() => { void tick() }, 1_500)
    }

    const stopPolling = () => {
      if (pollTimer !== undefined) {
        window.clearInterval(pollTimer)
        pollTimer = undefined
      }
    }

    const connect = () => {
      if (closedByUs) return
      setStatus('connecting')
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      ws = new WebSocket(`${proto}://${location.host}/ws`)

      ws.onopen = () => {
        setStatus('live')
        setLastError(null)
        stopPolling()
      }

      ws.onmessage = (event) => {
        let message: ServerMessage
        try {
          message = JSON.parse(String(event.data)) as ServerMessage
        } catch {
          return
        }

        if (message.type === 'pulse') {
          // v0.9.19：她自造的激素跟着一起走——脉冲图要画几条线由快照说了算。
          emit({ t: message.t, energy: message.energy, dopamine: message.dopamine,
            cortisol: message.cortisol, serotonin: message.serotonin ?? 50, frozen: message.frozen,
            chemicals: message.chemicals })
          return
        }
        if (message.type === 'snapshot' || message.type === 'state') {
          const { type: _type, pulseHistory, ...rest } = message as ServerMessage & { pulseHistory?: PulseSample[] }
          setSnapshot(rest as Snapshot)
          if (pulseHistory) for (const sample of pulseHistory) emit(sample)
          return
        }
        if (message.type === 'error') setLastError(message.text)
      }

      ws.onclose = () => {
        if (closedByUs) return
        // 断线不等于死亡：先降级为轮询，3 秒后再试一次 WS。
        startPolling()
        reconnectTimer = window.setTimeout(connect, 3_000)
      }

      ws.onerror = () => {
        // 交给 onclose 统一处理，避免重复重连
      }
    }

    connect()

    return () => {
      closedByUs = true
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer)
      stopPolling()
      ws?.close()
    }
  }, [])

  return { status, snapshot, bus: busRef.current, lastError }
}
