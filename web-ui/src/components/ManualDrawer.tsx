import { useCallback, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/**
 * 内置操作手册阅读器。
 *
 * 为什么要做成抽屉而不是新开页：手册是"边看边操作"的东西——看到一半想回去点一下
 * 执念池、看一眼器官树，切页面就断了。抽屉带走一半屏幕，另一半还能用。
 *
 * 三条实现取舍：
 *   1. **打开才拉、拉一次就缓存**（点 ↻ 强制重取）。手册 40KB 左右，每开关一次都读
 *      是浪费；但它会被手改，所以缓存必须有个显式失效入口。
 *   2. **渲染交给 react-markdown + remark-gfm**：手册里有大量表格（GFM 语法），
 *      没有 remark-gfm 表格会退化成一行行竖线。代码高亮只做"视觉高亮"，
 *      不引 highlight.js——为一个只读文档多背 1MB 运行时不值。
 *   3. **关闭时的动画不能靠条件渲染**：`translate-x-full` 过渡需要元素还在 DOM 里，
 *      所以用 pointer-events + opacity 控制，而不是 `{open && <aside/>}`。
 */

interface ManualPayload {
  ok: boolean
  name?: string
  path?: string
  bytes?: number
  mtimeMs?: number
  content?: string
  error?: string
  tried?: string[]
}

type LoadState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ready'; data: ManualPayload }
  | { phase: 'error'; message: string; tried?: string[] }

function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KB`
}

function formatTime(ms?: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function ManualDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [state, setState] = useState<LoadState>({ phase: 'idle' })
  const scrollRef = useRef<HTMLDivElement>(null)
  /** 每次强制刷新 +1，用来让 effect 重跑（比在 effect 里塞几百行更直观）。 */
  const [reloadKey, setReloadKey] = useState(0)

  const load = useCallback(async (force: boolean) => {
    setState((prev) => (force || prev.phase !== 'ready' ? { phase: 'loading' } : prev))
    try {
      const res = await fetch('/api/manual', { cache: 'no-store' })
      const body = (await res.json()) as ManualPayload
      if (!res.ok || !body.ok || typeof body.content !== 'string') {
        setState({
          phase: 'error',
          message: body.error ?? `HTTP ${res.status}`,
          tried: body.tried,
        })
        return
      }
      setState({ phase: 'ready', data: body })
    } catch (error) {
      setState({ phase: 'error', message: String(error) })
    }
  }, [])

  // 打开时按需加载：已经拿到内容就不再拉（点 ↻ 才重取）
  useEffect(() => {
    if (!open) return
    if (state.phase === 'ready' || state.phase === 'loading') return
    void load(false)
    // state.phase 故意不进依赖：只在"打开且还没有内容"时触发一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, reloadKey])

  // ESC 关闭 + 锁住背景滚动（抽屉里自己滚，底下的页面不该跟着动）
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [open, onClose])

  // 换手册/重载后回到顶部：否则会停在上一份文档的滚动位置
  useEffect(() => {
    if (state.phase === 'ready') scrollRef.current?.scrollTo({ top: 0 })
  }, [state.phase, state.phase === 'ready' ? state.data.mtimeMs : 0])

  return (
    <div className={`fixed inset-0 z-50 ${open ? '' : 'pointer-events-none'}`} aria-hidden={!open}>
      {/* 遮罩：点它就关。blur 让背后的脉冲图变成一块背景光，而不是干扰物 */}
      <div
        role="presentation"
        onClick={onClose}
        className={`absolute inset-0 bg-[#05070c]/70 backdrop-blur-[3px] transition-opacity duration-300 ${
          open ? 'opacity-100' : 'opacity-0'
        }`}
      />

      <aside
        role="dialog"
        aria-modal="true"
        aria-label="数字生命操作手册"
        className={`absolute right-0 top-0 flex h-full w-full transform flex-col border-l border-cyan-400/25 bg-slate-950/72 shadow-[-24px_0_80px_-20px_rgba(34,211,238,0.35)] backdrop-blur-2xl transition-transform duration-300 ease-out sm:w-[min(920px,94vw)] ${
          open ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        {/* 顶部霓虹线：毛玻璃边界太软，需要一条硬线把面板"钉"在屏幕上 */}
        <div className="h-px w-full bg-gradient-to-r from-transparent via-cyan-300/70 to-transparent" />

        <header className="flex items-center gap-3 border-b border-white/5 px-4 py-3">
          <span className="text-sm text-cyan-200">📖 操作手册</span>
          {state.phase === 'ready' && (
            <span className="truncate text-[10px] text-slate-500" title={state.data.path}>
              {state.data.name} · {formatBytes(state.data.bytes)} · 更新于 {formatTime(state.data.mtimeMs)}
            </span>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => {
                setState({ phase: 'idle' })
                setReloadKey((n) => n + 1)
              }}
              className="rounded border border-white/10 px-2 py-0.5 text-[11px] text-slate-400 transition-colors hover:border-cyan-300/40 hover:text-cyan-200"
              title="重新读取（手册手改之后点这里）"
            >
              ↻
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-white/10 px-2 py-0.5 text-[11px] text-slate-400 transition-colors hover:border-rose-300/40 hover:text-rose-200"
              title="关闭（Esc）"
            >
              ✕
            </button>
          </div>
        </header>

        <div ref={scrollRef} className="manual-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">
          {state.phase === 'loading' && (
            <div className="flex h-full items-center justify-center text-xs text-slate-500">
              <span className="mr-2 inline-block h-2 w-2 animate-pulse rounded-full bg-cyan-300" />
              正在读取手册…
            </div>
          )}

          {state.phase === 'error' && (
            <div className="rounded-lg border border-rose-500/25 bg-rose-500/10 p-4 text-xs text-rose-200">
              <p>读不到手册：{state.message}</p>
              {state.tried && state.tried.length > 0 && (
                <ul className="mt-2 space-y-0.5 font-mono text-[10px] text-rose-300/70">
                  {state.tried.map((item) => <li key={item}>试过：{item}</li>)}
                </ul>
              )}
              <p className="mt-2 text-rose-300/70">
                把手册放到项目根（digital-life-manual.md），或用环境变量 <code>DL_MANUAL</code> 指定路径后重启桥。
              </p>
            </div>
          )}

          {state.phase === 'ready' && (
            <article className="manual-body">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  // 外链一律新窗口：抽屉里去调页面会把阅读位置弄丢
                  a: ({ children, href, ...props }) => (
                    <a href={href} target="_blank" rel="noreferrer noopener" {...props}>{children}</a>
                  ),
                  // 代码块把语言提到 <pre> 上，CSS 才能用 attr(data-lang) 画出角标
                  pre: ({ children, ...props }) => {
                    const first = Array.isArray(children) ? children[0] : children
                    const className = (first as { props?: { className?: string } } | null)?.props?.className ?? ''
                    const lang = /language-([\w+-]+)/.exec(className)?.[1]
                    return <pre data-lang={lang ?? 'text'} {...props}>{children}</pre>
                  },
                  // 代码块加语言标签（视觉高亮，不做 token 级着色——那要背一个 highlight.js）
                  code: ({ className, children, ...props }) => {
                    const lang = /language-([\w+-]+)/.exec(className ?? '')?.[1]
                    return (
                      <code className={className} data-lang={lang ?? undefined} {...props}>
                        {children}
                      </code>
                    )
                  },
                  // 表格套一层横向滚动：手册里的宽表在窄屏会撑破面板
                  table: ({ children, ...props }) => (
                    <div className="manual-table-wrap">
                      <table {...props}>{children}</table>
                    </div>
                  ),
                }}
              >
                {state.data.content ?? ''}
              </ReactMarkdown>
            </article>
          )}
        </div>

        <footer className="border-t border-white/5 px-4 py-2 text-[10px] text-slate-600">
          只读阅读器 · 手册来自 {state.phase === 'ready' ? state.data.path : '/api/manual'} · Esc 关闭
        </footer>
      </aside>
    </div>
  )
}
