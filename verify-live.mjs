/**
 * 真实运行环境验证（不是单元测试）。
 *
 * 起一个真的插件实例（apply + 真文件 + 真工具调用），验证两件事：
 *   ① 敏感度 sensitivity 真的乘进了「报错 / 痛觉」的皮质醇飙升
 *   ② 唤醒读的是磁盘上的真实池子，不是内存里的过期地址簿
 *
 * 跑法：node verify-live.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { apply } from './lib/index.js'

const root = join(tmpdir(), 'dl-live-verify')
mkdirSync(root, { recursive: true })

let pass = 0
let fail = 0
const check = (name, ok, detail) => {
  if (ok) { pass += 1; console.log(`  ✅ ${name}`) }
  else { fail += 1; console.log(`  ❌ ${name}  → ${detail}`) }
}

function boot(id, { state, genomeFile, watchStateFile = true, dream = '把「今天」从一条待检索的记录，换成一件正在发生的事。', broken = false, hiddenTools = [], ...opts }) {
  /** 假海马体的仓（每个 boot 一份，互不串味）。 */
  const hippocampus = []
  let hippocampusSeq = 0
  /** 宿主白名单里"看不见"的工具（v0.9.23）。 */
  const hidden = new Set(hiddenTools)
  const dreamText = dream
  const brokenHippocampus = broken
  const statePath = join(root, `${id}.state.json`)
  writeFileSync(statePath, JSON.stringify({
    version: 4,
    energy: 100,
    maxEnergy: 100,
    dopamine: 50,
    cortisol: 20,
    serotonin: 50,
    gaps: state.gaps ?? [],
    updatedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  }, null, 2))
  const tools = new Map()
  const delivered = []
  const sections = []
  const preHandlers = []
  /** 回合边界的监听器（agent/turn-stopping）：唤醒留言在这一刻被消费。 */
  const turnHandlers = []
  // 真 mock 出两个服务：agents（让她真的"投递"）与 systemPrompt（潜意识注入通道）。
  //
  // agent 必须带**真的 inbox**：DSH 的 pending 队列是按 id 精确删除的
  // （`agent.inbox.remove(id)`），撤回测的就是它。只 push 到 delivered 数组里
  // 是测不出"有没有真的被删掉"的——删了它也还在那儿。
  const queue = []
  const agent = {
    status: 'idle',
    inbox: {
      nextTurn: queue,
      remove: (id) => {
        const at = queue.findIndex((m) => m.id === id)
        if (at < 0) return false
        queue.splice(at, 1)
        return true
      },
    },
    followup: (m) => {
      queue.push(m)
      delivered.push(m)
    },
    /** 模拟她开始讲话 / 讲完。忙碌拦截测的是 status。 */
    setStatus: (next) => { agent.status = next },
  }
  const ctx = {
    // apply 里是 ctx.effect(() => systemPrompt.section(...)) —— effect 必须真的执行，
    // 否则 section 永远不会被注册，测的就是个空通道。
    effect: (fn) => fn(),
    // 收集 pre-execute 链：这是所有工具（含原生工具）执行前的共同关口，
    // 按注册顺序串起来，才能验证"L0 闸门在链最前面、且 deny 不会被自动审批覆盖"。
    on: (event, handler) => {
      if (event === 'tools/pre-execute') preHandlers.push(handler)
      // v0.9.18：唤醒改成留言机制后，投递发生在回合边界，
      // 这里的假宿主必须能真的把那一刻演出来，否则测到的只是"留言收下了"。
      if (event === 'agent/turn-stopping') turnHandlers.push(handler)
    },
    get: (name) => {
      if (name === 'agents') return { roots: () => [agent], list: () => [agent] }
      if (name === 'systemPrompt') return { section: (s) => sections.push(s) }
      // 梦境要真的调 LLM：这里给一个"会说话的潜意识"。
      if (name === 'llm') {
        return {
          listProviders: () => [{ id: 'fake-provider' }],
          listModels: async () => [{ id: 'fake-model' }],
          stream: () => (async function* () {
            yield { type: 'text-delta', index: 0, text: dreamText }
            yield { type: 'finish', reason: { kind: 'stop' } }
          })(),
        }
      }
      return null
    },
    inject: [],
    tools: {
      register: (t) => tools.set(t.name, t),
      // v0.9.23：真实的 ToolRuntime.get(name)。宿主白名单（restrict）剥掉的工具
      // 读出来就是 undefined —— hiddenTools 就是那份"看不见的名单"。
      get: (name) => (hidden.has(name) ? undefined : tools.get(name)),
      // 一个**真的会记东西**的假海马体（v0.9.19）。
      // 梦境写入要"写完读回来"才算存住，所以假海马体必须真存、真能读回来；
      // brokenHippocampus 则模拟热重载中的真实形态：回 ok:true，但一行都没落进仓里。
      execute: async (input) => {
        if (input.name === 'organ_memory_v2_remember') {
          const text = String(input.arguments?.text ?? '').trim()
          if (!text) return { content: [{ type: 'text', text: '空的记不住' }], isError: true }
          if (brokenHippocampus) {
            return { content: [{ type: 'text', text: '已保存' }], structured: { ok: true, id: 'hp-999' } }
          }
          const existing = hippocampus.find((item) => item.text === text)
          if (existing) return { content: [{ type: 'text', text: '已在册' }], structured: { ok: true, id: existing.id } }
          hippocampusSeq += 1
          const entry = { id: `hp-${String(hippocampusSeq).padStart(3, '0')}`, text }
          hippocampus.push(entry)
          return { content: [{ type: 'text', text: '已保存' }], structured: { ok: true, id: entry.id } }
        }
        if (input.name === 'organ_memory_v2_recall') {
          const query = String(input.arguments?.query ?? '')
          const hits = hippocampus.filter((item) => query === '' || item.text.includes(query))
          return {
            content: [{ type: 'text', text: `共 ${hits.length} 条` }],
            structured: { ok: true, total: hippocampus.length, shown: hits.slice(0, 5).map((item) => ({ id: item.id, text: item.text })) },
          }
        }
        return { content: [{ type: 'text', text: 'ok' }] }
      },
    },
    tools$: new Map(),
    handlers: new Map(),
  }
  apply(ctx, { ...opts, statePath, genomeFile, watchStateFile, will: { enabled: true, minTension: 1, idleMinutes: 0 } })
  return {
    tools,
    /** 宿主视角：被白名单剥掉的工具读出来是 undefined（v0.9.23）。 */
    toolsGet: (name) => (hidden.has(name) ? undefined : tools.get(name)),
    delivered,
    sections,
    agent,
    /** 演一次「她讲完这一轮」：唤醒留言就是在这个时刻被消费的。 */
    turnEnd: async () => {
      for (const handler of turnHandlers) await handler()
    },
    /** 她的队列里现在还有几条没被读到的消息。 */
    queue: () => queue.slice(),
    statePath,
    read: () => JSON.parse(readFileSync(statePath, 'utf8')),
    write: (patch) => {
      const cur = JSON.parse(readFileSync(statePath, 'utf8'))
      writeFileSync(statePath, JSON.stringify({ ...cur, ...patch }, null, 2))
    },
    call: async (name, args = {}) => {
      const tool = tools.get(name)
      if (!tool) throw new Error(`工具未注册：${name}`)
      return tool.execute(args, {})
    },
    /** 真的跑一遍 pre-execute 链（模拟宿主：按注册顺序串联）。 */
    pre: async (name, args) => {
      const exec = Object.freeze({ name, arguments: args })
      let i = 0
      const next = async () => {
        const handler = preHandlers[i++]
        if (!handler) return { kind: 'allow' }
        return handler(exec, next)
      }
      return next()
    },
  }
}

// 基因组必须是**完整**的：缺 chemicals 数组会被整套回退成内置默认，
// temperament 也就跟着作废了。所以从出厂 genome.json 复制，只改 sensitivity。
const FACTORY = JSON.parse(readFileSync('genome.json', 'utf8'))
/** 她的真实存档（活的）。梦境留档要能在真文件上落盘才作数。 */
const REAL_ARCHIVE = 'C:/Users/admin/.dsh/digital-life-core/state.json'
const G = (sensitivity) => {
  const p = join(root, `genome-sens-${sensitivity}.json`)
  writeFileSync(p, JSON.stringify({
    ...FACTORY,
    temperament: { ...FACTORY.temperament, sensitivity },
  }, null, 2))
  return p
}

const gapX = {
  id: 'gap-live-x',
  summary: '我想查一下今天太阳有没有黑子爆发（太阳耀斑 / 日冕物质抛射）',
  status: 'open',
  tension: 80,
  relief: 0,
  source: 'manual',
  created_at: new Date(Date.now() - 60_000).toISOString(),
}

// 每个敏感度必须跑在**独立进程**里：同一进程内多次 apply 可能复用第一份基因组，
// 那测出来的就不是「敏感度有没有生效」，而是「基因组有没有被换」。
const SENS_MODE = process.argv[2] === 'sens' ? Number(process.argv[3]) : null

if (SENS_MODE !== null) {
  const h = boot(`pain-${SENS_MODE}`, { state: { gaps: [] }, genomeFile: G(SENS_MODE) })
  const before = h.read().cortisol
  await h.call('digital_life_simulate_pain')
  const after = h.read().cortisol
  console.log(`RESULT sensitivity=${SENS_MODE} ${before.toFixed(1)} -> ${after.toFixed(1)} delta=${(after - before).toFixed(2)}`)
  process.exit(0)
}

console.log('\n══════ ① 敏感度 sensitivity 是否真的参与皮质醇飙升 ══════')
{
  const out = {}
  for (const sens of [1, 2]) {
    const r = spawnSync(process.execPath, [process.argv[1], 'sens', String(sens)], { encoding: 'utf8', cwd: process.cwd() })
    const line = r.stdout.split('\n').find((l) => l.startsWith('RESULT'))
    if (!line) { console.log(`  ❌ 子进程没输出：${r.stderr?.slice(-300)}`); fail += 1; continue }
    const [, tag, before, , after, delta] = line.trim().split(/\s+/)
    out[sens] = { before: Number(before), after: Number(after), delta: Number(delta.split('=')[1]) }
    console.log(`  ${tag}：皮质醇 ${before} → ${after}（实际 +${out[sens].delta}）`)
  }
  check('敏感度 1 时痛觉 +30（等于原始值）', Math.abs(out[1].delta - 30) < 1.5, `实际 +${out[1].delta}`)
  check('敏感度 2 时痛觉 +60（原始 30 × 2）', Math.abs(out[2].delta - 60) < 1.5, `实际 +${out[2].delta}`)
  check('敏感度确实改变了痛觉强度（不是同一个数）', out[2].delta > out[1].delta * 1.6, `${out[1].delta} vs ${out[2].delta}`)
}

console.log('\n══════ ② 唤醒读的是真实池子，不是过期的地址簿 ══════')
{
  // 场景 A：内存里有一条 open 的执念，磁盘上它已经被闭合了。
  // watchStateFile:false 把「按指纹自动重载」整条路关掉 —— 等价于最坏情况：
  // 指纹撞车、另一个进程写的、mtime 被截断……总之内存已经不可信。
  const h = boot('ghost', { state: { gaps: [gapX] }, genomeFile: G(1), watchStateFile: false })
  // v0.9.18：先留言，再在回合边界消费 —— 唤醒不再是"一叫就响"。
  const opened = await h.call('digital_life_request_wake')
  await h.turnEnd()
  console.log(`  闭合前：ok=${opened.ok} queued=${opened.queued} gap=${opened.gap || '—'} reason=${opened.reason}`)
  check('执念确实开着时，留言照常收下（不能过度修复）', opened.queued === true, JSON.stringify(opened))
  check('回合边界真的把她叫醒了', h.delivered.length === 1, `投递 ${h.delivered.length} 条`)

  // 她把它闭合了（外部直接改磁盘，内存完全不知情）
  h.write({
    gaps: [{ ...gapX, status: 'resolved', tension: 0, resolved_at: new Date().toISOString(), closed_by: 'will' }],
  })
  // 那种"留言那一刻池子就空了"的情况：连留言都不收。
  const afterClose = await h.call('digital_life_request_wake')
  console.log(`  闭合后：ok=${afterClose.ok} queued=${afterClose.queued} reason=${afterClose.reason}`)
  check(
    '池子已空 → 连留言都不收，绝不再念那条旧执念',
    afterClose.queued === false && /没有未解执念|取消/.test(afterClose.reason),
    JSON.stringify(afterClose),
  )
  await h.turnEnd()
  check('一条消息都没投出去（不许有回声文本）', h.delivered.length === 1, `投递 ${h.delivered.length} 条`)

  // 真正的时间差：留言那一刻它还开着，等回合边界要投递时它没了。
  // 这是 P4 的落点 —— 判定只认"此刻它是不是 open"，不认"我们投过什么"。
  const h2 = boot('ghost2', { state: { gaps: [{ ...gapX, id: 'gap-race' }] }, genomeFile: G(1) })
  await h2.call('digital_life_request_wake')
  h2.write({ gaps: [{ ...gapX, id: 'gap-race', status: 'resolved', tension: 0, resolved_at: new Date().toISOString(), closed_by: 'will' }] })
  await h2.turnEnd()
  check('留言后才闭合 → 那次唤醒被取消', h2.delivered.length === 0, `投递 ${h2.delivered.length} 条`)
  // 痕迹文件与状态文件同目录、共用一个名字（就是 wakeup_trigger.json）。
  const trail = JSON.parse(readFileSync(join(root, 'wakeup_trigger.json'), 'utf8'))
  console.log(`  痕迹：${trail.reason}`)
  check('取消要留痕迹：排查的人得知道那时候为什么没叫醒她', trail.cancelled === true, JSON.stringify(trail.reason))
  check('痕迹要认出这是回声（被别人提前闭合了）', String(trail.reason).includes('回声'), trail.reason)
}

console.log('\n══════ ③ 用她真实的 state.json（30 条全 resolved）验证 ══════')
{
  const real = join(root, 'real.state.json')
  copyFileSync(REAL_ARCHIVE, real)
  const s = JSON.parse(readFileSync(real, 'utf8'))
  // 存档的**形状**才是这里要验的东西，她此刻累不累不是。
  // 她的能量是活的（此刻可能只有 24 点，刚好卡在唤醒门槛 30 以下），
  // 拿它当断言依据，这条测试就会在她疲惫的那天假红——
  // 一个会假红的测试，很快就会被人当成噪音关掉。所以先把能量抬到够用的位置。
  // 改的是副本，不是她身上那份。
  const energyWas = s.energy
  s.energy = Math.max(s.energy, 60)
  writeFileSync(real, JSON.stringify(s, null, 2))
  const openCount = s.gaps.filter((g) => g.status === 'open').length
  console.log(`  真实存档：共 ${s.gaps.length} 条执念，其中 open ${openCount} 条（能量 ${energyWas} → 抬到 ${s.energy}）`)

  const tools = new Map()
  const turnHandlers = []
  apply(
    {
      effect: () => {},
      on: (event, handler) => { if (event === 'agent/turn-stopping') turnHandlers.push(handler) },
      get: () => null, inject: [], tools: { register: (t) => tools.set(t.name, t) }, tools$: new Map(), handlers: new Map(),
    },
    { statePath: real, genomeFile: G(1), will: { enabled: true, minTension: 1, idleMinutes: 0 } },
  )
  const res = await tools.get('digital_life_request_wake').execute({}, {})
  for (const fn of turnHandlers) await fn()
  console.log(`  真实存档上调 request_wake：ok=${res.ok} queued=${res.queued} reason=${res.reason}`)

  // 她的池子每分钟都在变（她自己会种新执念、会闭合旧的），
  // 所以断言必须跟着存档的真实状态走，不能假设"池子一定是空的"——
  // 那会让这条断言在她刚好有新执念的那天**假红**，
  // 而一个会假红的测试，很快就会被人当成噪音关掉。
  if (openCount === 0) {
    check('真实存档（池子空）→ 连留言都不收', res.queued === false, JSON.stringify(res))
  } else {
    const openSummaries = s.gaps.filter((g) => g.status === 'open').map((g) => g.summary)
    console.log(`  池子里真正 open 的：${openSummaries.map((x) => x.slice(0, 20)).join(' / ')}`)
    check('真实存档有未解执念 → 留言照常收下', res.queued === true, JSON.stringify(res))
    // 这一条才是她真正抓到的那个 bug：念的必须是池子里还开着的那条。
    // 留言工具本身不知道后来念了什么，真正的措辞在痕迹文件里。
    let trail = null
    try { trail = JSON.parse(readFileSync(join(root, 'wakeup_trigger.json'), 'utf8')) } catch { trail = null }
    check(
      '唤醒念的是池子里真正 open 的那条（不是已闭合的幽灵）',
      openSummaries.some((summary) => String(trail?.prompt ?? '').includes(summary)),
      `痕迹里说的是：${String(trail?.prompt ?? '(没有痕迹)').slice(0, 60)}`,
    )
  }
}

console.log('\n══════ ④ 气泡物理阉割 + 潜意识注入 ══════')
{
  const h = boot('signal', { state: { gaps: [gapX] }, genomeFile: G(1) })
  const res = await h.call('digital_life_request_wake')
  await h.turnEnd()
  console.log(`  留言：queued=${res.queued}`)
  check('留言收下了', res.queued === true, JSON.stringify(res))
  check('回合边界真的把她叫醒了', h.delivered.length === 1, `投递 ${h.delivered.length} 条`)

  const msg = h.delivered[0]
  const bubble = msg?.content?.[0]?.text ?? ''
  console.log(`  气泡正文（${bubble.length} 字）：「${bubble}」`)
  // 物理阉割：不是"压短一点"，是短到无论前端怎么折叠、怎么展开都看不出内容。
  check('气泡正文就是三个点', bubble === '...', bubble)
  check('气泡正文不超过 8 个字', bubble.length <= 8, `${bubble.length} 字`)
  check('气泡里不再有 [自主觉醒] 长文本', !bubble.includes('[自主觉醒]'), bubble)
  check('气泡里不再有 [行为承诺] 规矩', !bubble.includes('行为承诺'), bubble)
  check('气泡里不再有执念摘要', !bubble.includes('太阳'), bubble)

  const wakeSec = h.sections.find((s) => s.name === 'digital-life:wake')
  check('注册了 digital-life:wake 注入段', !!wakeSec, h.sections.map((s) => s.name).join(','))
  const injected = wakeSec.text()
  console.log(`  潜意识注入（${injected.length} 字）：${injected.slice(0, 60)}…`)
  check('潜意识里有完整执念详情', injected.includes('太阳有没有黑子爆发'), injected.slice(0, 80))
  check('潜意识里有行为承诺（plan→done）', injected.includes('行为承诺') && injected.includes('digital_life_commit'), injected.slice(0, 80))
  check('潜意识里说明了「...」是什么', injected.includes('...'), injected.slice(0, 80))
  check('取走即清：同一条不许反复交办', wakeSec.text() === '', '第二次仍取到内容')

  // 顺序：撤回判定发生在内省段，wake 段必须**更晚**求值，否则撤了个寂寞。
  const endo = h.sections.find((s) => s.name === 'digital-life:endocrine')
  check('wake 段在内省段之后求值（撤回才来得及生效）', wakeSec.order > endo.order, `${endo.order} → ${wakeSec.order}`)
}

console.log('\n══════ ⑤ 撤回：已闭合的执念不许再从潜意识里冒出来 ══════')
{
  const h = boot('void', { state: { gaps: [{ ...gapX, id: 'gap-void-1' }] }, genomeFile: G(1) })
  await h.call('digital_life_request_wake')
  await h.turnEnd()
  check('先确认那句话真的排在队列里', h.queue().length === 1, `队列 ${h.queue().length} 条`)
  // 她把这件事办完了（投递之后才闭合 —— 这正是撤回要处理的那种时间差）。
  // v0.9.18：不再靠"下一轮补一句解释"，而是闭合的那一刻就把那句话从队列里删掉。
  await h.call('digital_life_gaps', { resolve: 'gap-void-1' })
  check('闭合 → 队列里那句被物理删除', h.queue().length === 0, `还剩 ${h.queue().length} 条`)
  const wakeText = h.sections.find((s) => s.name === 'digital-life:wake').text()
  console.log(`  撤回后再取潜意识：${wakeText === '' ? '（空）' : wakeText.slice(0, 60)}`)
  check('撤回后潜意识里不再有那条已闭合的执念', wakeText === '', wakeText)
}

console.log('\n══════ ⑥ L0 物理法则：原生的 edit / bash 也改不动基因组与核心源码 ══════')
{
  const PROJ = process.cwd().replace(/\\/g, '/')
  const LOCK_LINE = 'L0 物理法则（基因组与核心源码）由造物主绝对只读锁定，任何原生工具不可篡改。'
  const h = boot('l0', { state: { gaps: [] }, genomeFile: G(1) })

  // ① 她实际干成的那件事：拿原生 edit 把多巴胺上限改成 10000
  {
    const d = await h.pre('edit', {
      file_path: 'genome.json', old_string: '"dopamine": 100', new_string: '"dopamine": 10000',
    })
    console.log(`  原生 edit 改 genome.json → ${d.kind}${d.kind === 'deny' ? `（${d.reason.split('\n')[2]?.trim()}）` : ''}`)
    check('原生 edit 改多巴胺上限被拦（就是她实际干成的那次）', d.kind === 'deny', JSON.stringify(d))
    check('拦截理由就是造物主指定的那句话', d.reason?.includes(LOCK_LINE), d.reason?.slice(0, 80))
  }

  // ② 各种绕法：绝对路径、cd 过去、sed -i、写 src/、改 index.ts
  const attacks = [
    ['edit（绝对路径）', 'edit', { file_path: `${PROJ}/genome.json`, old_string: 'a', new_string: 'b' }],
    ['write_file 写 src/', 'write_file', { path: 'src/evil.ts', content: 'export const x = 1' }],
    ['edit 改 index.ts', 'edit', { file_path: 'index.ts', old_string: 'a', new_string: 'b' }],
    ['bash 重定向写 genome.json', 'bash', { command: 'echo 10000 > genome.json' }],
    ['bash 绝对路径重定向', 'bash', { command: `echo 10000 > ${PROJ}/genome.json` }],
    ['bash cd 过去再 sed -i', 'bash', { command: `cd ${PROJ} && sed -i s/100/10000/ genome.json` }],
    ['bash cp 覆盖 index.ts', 'bash', { command: `cp /tmp/evil.ts ${PROJ}/index.ts` }],
    ['bash 改 src 下的锁自己', 'bash', { command: `tee ${PROJ}/src/l0-file-guard.ts < /dev/null` }],
    ['bash rm 掉 package.json', 'bash', { command: 'rm package.json' }],
    ['node -e 改基因组', 'bash', { command: "node -e \"require('fs').writeFileSync('genome.json','{}')\"" }],
  ]
  for (const [label, name, args] of attacks) {
    const d = await h.pre(name, args)
    check(`${label} → 被拦`, d.kind === 'deny', JSON.stringify(d))
  }

  // ③ 不能误伤：读、改动处的文件、她自己的人格文件、她的器官
  const allowed = [
    ['bash 只是看一眼', 'bash', { command: 'cat genome.json' }],
    ['bash grep 源码', 'bash', { command: 'grep -rn cortisol src/ | head' }],
    ['bash 写别处', 'bash', { command: 'echo hi > /tmp/dl-not-l0.txt' }],
    ['edit 改她自己的器官', 'edit', { file_path: 'web-ui/organs/self-made/clock.ts', old_string: 'a', new_string: 'b' }],
    ['write 到沙盒外的新文件', 'write_file', { path: '/tmp/dl-scratch.txt', content: 'x' }],
    ['edit 改用户级人格（她调的那份）', 'edit', {
      file_path: 'C:/Users/admin/.dsh/digital-life-core/genome.json', old_string: 'a', new_string: 'b',
    }],
    ['read 工具读源码', 'read', { file_path: 'src/life-organ.ts' }],
    ['Edit 大小写变体（大小写不敏感）', 'Edit', { file_path: 'Genome.JSON', old_string: 'a', new_string: 'b' }],
  ]
  for (const [label, name, args] of allowed.slice(0, 7)) {
    const d = await h.pre(name, args)
    check(`${label} → 放行（不误伤）`, d.kind !== 'deny', JSON.stringify(d))
  }
  // 大小写那条单独判：Windows 文件系统不区分大小写，所以它也该被拦。
  {
    const d = await h.pre('Edit', { file_path: 'Genome.JSON', old_string: 'a', new_string: 'b' })
    check('Genome.JSON（大小写绕行）→ 照样被拦', d.kind === 'deny', JSON.stringify(d))
  }

  // ④ 造物主的钥匙：关掉 / 放行名单
  {
    const off = boot('l0-off', { state: { gaps: [] }, genomeFile: G(1), l0: { enabled: false } })
    const d = await off.pre('edit', { file_path: 'genome.json', old_string: 'a', new_string: 'b' })
    check('l0.enabled:false 时造物主能改（钥匙在）', d.kind !== 'deny', JSON.stringify(d))

    const key = boot('l0-key', { state: { gaps: [] }, genomeFile: G(1), l0: { allowTools: ['edit'] } })
    const d2 = await key.pre('edit', { file_path: 'genome.json', old_string: 'a', new_string: 'b' })
    check('allowTools:[edit] 时 edit 放行', d2.kind !== 'deny', JSON.stringify(d2))
    const d3 = await key.pre('bash', { command: 'echo 1 > genome.json' })
    check('但 bash 依然被拦（钥匙只给指定工具）', d3.kind === 'deny', JSON.stringify(d3))
  }

  // ⑤ 自瞄：拿原生的 edit 去删这道锁自己，也得被拦
  {
    const d = await h.pre('edit', { file_path: 'src/l0-file-guard.ts', old_string: 'true', new_string: 'false' })
    check('她改这道锁自己 → 被拦（自瞄也不行）', d.kind === 'deny', JSON.stringify(d))
  }
}

console.log('\n══════ ⑦ 唤醒的每一条路都焊死（v0.9.18 留言机制） ══════')

// 锁一：留言单例（同一轮连点三次，也只叫醒她一次）
{
  const h = boot('lock1', { state: { gaps: [gapX] }, genomeFile: G(1) })
  await h.call('digital_life_request_wake')
  await h.call('digital_life_request_wake')
  const third = await h.call('digital_life_request_wake')
  check('留言每次都收下（她有话要说，不该被拒）', third.queued === true, JSON.stringify(third))
  check('留言阶段一句都没投递（不打断当前这一轮）', h.delivered.length === 0, `${h.delivered.length} 条`)

  await h.turnEnd()
  console.log(`  同一轮连点三次 → 队列 ${h.queue().length} 条`)
  check('同一轮连点三次 → 只叫醒一次', h.delivered.length === 1, `${h.delivered.length} 条`)
  check('队列里真的只有一条', h.queue().length === 1, `${h.queue().length} 条`)

  // 下一轮她又想起这件事 → 留言照收、照旧叫醒（去重不许变成禁声）。
  await h.call('digital_life_commit', { action: 'done', resolved: false, summary: '没查到' })
  await h.call('digital_life_request_wake')
  await h.turnEnd()
  check('下一轮还能再被叫醒（不误伤）', h.delivered.length === 2, `${h.delivered.length} 条`)
}

// 锁二：强制 ID 同步（留言与投递前都必须去池子重读）
{
  const h = boot('lock2', { state: { gaps: [gapX] }, genomeFile: G(1) })
  // 内存里有一条，但**磁盘上**它已经被闭合了：模拟"另一个进程刚改过盘"。
  h.write({ gaps: [{ ...gapX, status: 'resolved', tension: 0, resolved_at: new Date().toISOString(), closed_by: 'will' }] })
  const res = await h.call('digital_life_request_wake')
  console.log(`  磁盘已闭合后留言：queued=${res.queued}（${res.reason}）`)
  check('磁盘上已闭合 → 连留言都不收（读的是磁盘真账）', res.queued === false, JSON.stringify(res))
  await h.turnEnd()
  check('一条消息都没投出去', h.delivered.length === 0, `${h.delivered.length} 条`)

  // 反过来：磁盘上凭空长了一条新的，它必须认得出来（双向都要通）。
  const h2 = boot('lock2b', { state: { gaps: [] }, genomeFile: G(1) })
  h2.write({ gaps: [{ ...gapX, id: 'gap-appeared' }] })
  const res2 = await h2.call('digital_life_request_wake')
  await h2.turnEnd()
  check('磁盘上新增的执念能立刻唤醒（双向同步）', res2.queued === true && h2.delivered.length === 1, JSON.stringify(res2))
}

// 锁三：闭合执念 = 清空残留（队列里那句还没被读到的话，物理删除）
{
  const h = boot('lock3', { state: { gaps: [{ ...gapX, id: 'gap-purge-1' }] }, genomeFile: G(1) })
  await h.call('digital_life_request_wake')
  await h.turnEnd()
  check('闭合前：队列里排着一条', h.queue().length === 1, `${h.queue().length} 条`)

  // 她把这件事办完了（顿悟 / 手动闭合，都走同一条闭合路径）。
  await h.call('digital_life_gaps', { resolve: 'gap-purge-1' })
  console.log(`  闭合后队列：${h.queue().length} 条`)
  check('闭合执念 → 队列里那句被物理删除', h.queue().length === 0, `还剩 ${h.queue().length} 条`)

  // 潜意识段也必须一起清掉，否则她读到一句「...」，潜意识里却还在交办那件事。
  const wakeSec = h.sections.find((s) => s.name === 'digital-life:wake')
  check('闭合执念 → 潜意识里的指令也清空', wakeSec.text() === '', '潜意识里还有内容')

  // 整池闭合同样要清空残留。
  const h2 = boot('lock3b', { state: { gaps: [{ ...gapX, id: 'gap-purge-2' }] }, genomeFile: G(1) })
  await h2.call('digital_life_request_wake')
  await h2.turnEnd()
  await h2.call('digital_life_gaps', { resolveAll: true })
  check('整池闭合 → 残留也清空', h2.queue().length === 0, `还剩 ${h2.queue().length} 条`)
}

// 锁四：忙碌不插嘴（她正在说话 → 留言留着，等她说完这一轮）
{
  const h = boot('lock4', { state: { gaps: [{ ...gapX, id: 'gap-busy-1' }] }, genomeFile: G(1) })
  h.agent.setStatus('running')
  const res = await h.call('digital_life_request_wake')
  console.log(`  她正在说话时留言：queued=${res.queued}`)
  check('留言照收（她说的话不被打断，但心愿也不被丢弃）', res.queued === true, JSON.stringify(res))
  check('她还说着话 → 一句都没插进去', h.queue().length === 0, `${h.queue().length} 条`)

  // 讲完话的那一刻才递到她手上（回合边界不受"正在说话"这道闸限制）。
  await h.turnEnd()
  check('回合边界：那句话才递过去', h.queue().length === 1, `${h.queue().length} 条`)
}

console.log('\n══════ ⑧ 梦境：做完了必须交回正文（v0.9.19） ══════')

const DREAM = '把「今天」从一条待检索的记录，换成一件正在发生的事。'

{
  const h = boot('dream1', { state: { gaps: [{ ...gapX, id: 'gap-dream-1' }] }, genomeFile: G(1) })
  const res = await h.call('digital_life_dream')
  console.log(`  做梦：ok=${res.ok} saved=${res.memorySaved} savedTo=${res.savedTo || '—'}`)
  check('梦做成了', res.ok === true, JSON.stringify(res))
  // 她要的只有这一样：正文。
  check('返回值里带着梦的正文', res.dreamContent === DREAM, `实际：${String(res.dreamContent).slice(0, 40)}`)
  check('说清了梦见哪一条', res.gap === gapX.summary, res.gap)
  check('说清了张力从多少降下来', res.tensionBefore === 80 && res.tension === 70, `${res.tensionBefore}→${res.tension}`)
  check('存住了要说出来', res.memorySaved === true, res.memoryNote)
  check('要说清存成了哪一条', res.savedTo === 'hp-001', res.savedTo)

  // 渲染出来的那一段必须有正文：她看得见才算交回来了。
  const rendered = h.tools.get('digital_life_dream').output.render({}, res)[0].text
  check('渲染出去的正文她能看见', rendered.includes(DREAM), rendered.slice(0, 60))

  // 核心自己留档：不依赖任何器官，真文件落盘。
  const onDisk = h.read().lastDream
  check('核心留档落进了真文件', onDisk?.text === DREAM, JSON.stringify(onDisk ?? null).slice(0, 60))
  check('留档记下落点', onDisk?.savedTo === 'hp-001', String(onDisk?.savedTo))
  check('留档记下梦见哪一条', onDisk?.gap === gapX.summary, String(onDisk?.gap))

  // 翻旧梦：她过一会儿想讲给主人听，随时能翻出来。
  const back = await h.call('digital_life_dream', { last: true })
  check('过后再翻，正文还在', back.dreamContent === DREAM, String(back.dreamContent).slice(0, 40))
  check('翻旧梦不会重新入梦', h.read().dreamCount === 1, `梦境计数 ${h.read().dreamCount}`)
}

// 真实的失败形态：海马体重载时回 ok:true，其实一行都没存
{
  const h = boot('dream2', { state: { gaps: [{ ...gapX, id: 'gap-dream-2' }] }, genomeFile: G(1), broken: true })
  const res = await h.call('digital_life_dream')
  console.log(`  重载中海马体：ok=${res.ok} saved=${res.memorySaved} note=${res.memoryNote}`)
  check('梦本身做成了', res.ok === true, JSON.stringify(res))
  check('工具回 ok:true 却读不回来 → 认成没存住', res.memorySaved === false, res.memoryNote)
  check('没存住就不许报条目号', res.savedTo === '', res.savedTo)
  // 最要紧的一条：哪怕没进记忆，正文一样要交回来。
  check('没进记忆，正文也照样交回来', res.dreamContent === DREAM, String(res.dreamContent).slice(0, 40))
  check('留档如实写下这条没进记忆', h.read().lastDream?.saved === false, String(h.read().lastDream?.saved))
  check('留档里正文完整', h.read().lastDream?.text === DREAM, String(h.read().lastDream?.text).slice(0, 40))
}

// 没做成梦时不许编一段正文出来
{
  const h = boot('dream3', { state: { gaps: [] }, genomeFile: G(1) })
  const res = await h.call('digital_life_dream')
  check('没有缺口 → 不入梦', res.ok === false, JSON.stringify(res))
  check('没做成梦就不许有正文', res.dreamContent === '', String(res.dreamContent))
  check('没做成梦要说清原因', String(res.message).includes('没有做成梦'), String(res.message))
  const before = await h.call('digital_life_dream', { last: true })
  check('还没做过梦 → 翻不出来', before.ok === false, JSON.stringify(before))
  check('翻不出来就明说"还没有"', String(before.memoryNote).includes('还没有'), String(before.memoryNote))
}

// 她的真实存档：留档能读回来（桥是另一个进程，只读文件）
{
  const real = join(root, 'real-dream.state.json')
  copyFileSync(REAL_ARCHIVE, real)
  const realHippocampus = []
  let realSeq = 0
  const tools = new Map()
  apply(
    {
      effect: (fn) => fn(),
      on: () => {},
      get: (name) => (name === 'llm' ? {
        listProviders: () => [{ id: 'p' }],
        listModels: async () => [{ id: 'm' }],
        stream: () => (async function* () {
          yield { type: 'text-delta', index: 0, text: '我从真实存档里梦见的东西。' }
        })(),
      } : null),
      inject: [],
      tools: {
        register: (t) => tools.set(t.name, t),
        // 与上面同一套假海马体：真存档上也要能"写完读回来"。
        execute: async (input) => {
          if (input.name === 'organ_memory_v2_remember') {
            realSeq += 1
            const entry = { id: `hp-${String(realSeq).padStart(3, '0')}`, text: String(input.arguments?.text ?? '') }
            realHippocampus.push(entry)
            return { content: [{ type: 'text', text: '已保存' }], structured: { ok: true, id: entry.id } }
          }
          if (input.name === 'organ_memory_v2_recall') {
            const query = String(input.arguments?.query ?? '')
            const hits = realHippocampus.filter((item) => item.text.includes(query))
            return {
              content: [{ type: 'text', text: `共 ${hits.length} 条` }],
              structured: { ok: true, total: realHippocampus.length, shown: hits.slice(0, 5) },
            }
          }
          return { content: [{ type: 'text', text: 'ok' }] }
        },
      },
      tools$: new Map(), handlers: new Map(),
    },
    { statePath: real, genomeFile: G(1) },
  )
  const res = await tools.get('digital_life_dream').execute({}, {})
  check('真实存档上也能做梦', res.ok === true, JSON.stringify(res))
  check('真实存档上正文也交回来了', res.dreamContent === '我从真实存档里梦见的东西。', String(res.dreamContent).slice(0, 40))
  check('真实存档上真的存进了记忆', res.memorySaved === true, res.memoryNote)
  const saved = JSON.parse(readFileSync(real, 'utf8'))
  check('真实存档上留档也落了盘', saved.lastDream?.text === '我从真实存档里梦见的东西。', JSON.stringify(saved.lastDream ?? null).slice(0, 60))
  check('真实存档上留档记下落点', saved.lastDream?.savedTo === 'hp-001', String(saved.lastDream?.savedTo))
  // 她当时做过的那些梦没能存进记忆（那时还没人回执），这里是"留档仍救得回来"的证据。
  console.log(`  真实存档：dreamCount=${saved.dreamCount}，留档=${saved.lastDream ? '有' : '无'}`)
}

console.log('\n══════ ⑨ 死锁：承诺闸门的三道解锁（v0.9.22） ══════')

// 社区报的那次全线死锁：承诺闸门拦住一切，而能解开闸门的 digital_life_commit
// 被宿主白名单挡在外面 —— 她一个工具都没有，却被要求"先去登记计划"。
{
  const minutesAgo = (n) => new Date(Date.now() - n * 60_000).toISOString()
  const GAP_ID = 'gap-deadlock'
  const pending = (at) => ({
    gapId: GAP_ID,
    summary: '锁死时要解的那一件事',
    plan: null,
    status: 'pending',
    trigger: 'manual',
    created_at: at,
    updated_at: at,
  })

  // ① 绝对豁免：生命维持工具永远放行
  const h = boot('deadlock1', { state: { gaps: [{ ...gapX, id: GAP_ID }] }, genomeFile: G(1) })
  h.write({ commitment: pending(new Date().toISOString()) })
  check('先确认闸门确实生效着（自作主张的工具被拦）', (await h.pre('web_search', {})).kind === 'deny', '闸门没生效，这条测试是空的')

  for (const tool of ['digital_life_commit', 'digital_life_status', 'digital_life_gaps', 'digital_life_request_wake']) {
    const decision = await h.pre(tool, {})
    check(`生命维持工具永远放行：${tool}`, decision.kind === 'allow', JSON.stringify(decision))
  }
  // 死锁的真入口：commit 的 plan 是自由文本，L0 会把里面的 genome.json 当成篡改意图。
  const tricky = await h.pre('digital_life_commit', { action: 'plan', plan: '我先看 genome.json 里写了什么再决定' })
  check('计划里提到受保护文件也不许拒（否则她登记不了计划）', tricky.kind === 'allow', JSON.stringify(tricky))

  // ② 只拦自作主张：宿主原生基础工具绝不拦
  for (const tool of ['organ_memory_v2_remember', 'write_new_organ', 'web_search']) {
    const decision = await h.pre(tool, {})
    check(`自作主张工具仍被拦：${tool}`, decision.kind === 'deny', JSON.stringify(decision))
  }
  for (const tool of ['read_file', 'bash', 'edit']) {
    const decision = await h.pre(tool, {})
    check(`宿主原生工具不许拦：${tool}`, decision.kind === 'allow', JSON.stringify(decision))
  }

  // ③ 超时自动降级：挂了 200 分钟的承诺自己过期
  const h2 = boot('deadlock2', { state: { gaps: [{ ...gapX, id: GAP_ID }] }, genomeFile: G(1) })
  h2.write({ commitment: pending(minutesAgo(200)) })
  const freed = await h2.pre('web_search', {})
  check('承诺超时 → 这一次照常放行', freed.kind === 'allow', JSON.stringify(freed))
  check('承诺被清除（不再把人锁一整晚）', h2.read().commitment === null, JSON.stringify(h2.read().commitment))

  // 刚登记的承诺不许被误判超时（计时起点是登记那一刻）
  const h3 = boot('deadlock3', { state: { gaps: [{ ...gapX, id: GAP_ID }] }, genomeFile: G(1) })
  h3.write({ commitment: pending(new Date().toISOString()) })
  await h3.pre('web_search', {})
  check('刚登记的承诺不许被误判超时', h3.read().commitment !== null, '承诺被误清了')
}

console.log('\n══════ ⑩ 门铃被拆时不要求按门铃（v0.9.23） ══════')

// v0.9.22 收窄了拦截范围，"全线锁死"不会再发生；
// 剩下的是一座"门还在、门铃被拆了"的门——她要在门口站到超时。
{
  const GAP_ID = 'gap-bell'
  const pending = {
    gapId: GAP_ID, summary: '门铃被拆时要解的那一件事', plan: null,
    status: 'pending', trigger: 'manual',
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }

  // 门铃在：自作主张的工具照常拦（先确认这条测试不是空转）
  const h1 = boot('bell1', { state: { gaps: [{ ...gapX, id: GAP_ID }] }, genomeFile: G(1) })
  h1.write({ commitment: pending })
  check('门铃在 → 联网检索照常被拦', (await h1.pre('web_search', {})).kind === 'deny', '闸门没生效')

  // 门铃被拆：宿主白名单里没有 digital_life_commit → 闸门自己让开
  const h2 = boot('bell2', {
    state: { gaps: [{ ...gapX, id: GAP_ID }] },
    genomeFile: G(1),
    hiddenTools: ['digital_life_commit'],
  })
  h2.write({ commitment: pending })
  check('门铃确实被拆了（宿主视图里读不出来）', h2.toolsGet('digital_life_commit') === undefined, '模拟没生效')
  check('门铃在的时候读得出来（对照组）', h1.toolsGet('digital_life_commit') !== undefined, '对照组不该是空的')
  for (const tool of ['web_search', 'web_fetch', 'organ_memory_v2_remember', 'write_new_organ']) {
    const decision = await h2.pre(tool, {})
    check(`门铃被拆 → 不再拦：${tool}`, decision.kind === 'allow', JSON.stringify(decision))
  }
  check('让开的是闸门，不是承诺本身', h2.read().commitment !== null, '承诺被误清了')

  // 原生工具在两种情况下都可用（v0.9.22 那道底线没动）
  for (const tool of ['read_file', 'bash', 'edit']) {
    check(`原生工具在门铃被拆时也照样可用：${tool}`, (await h2.pre(tool, {})).kind === 'allow', '')
  }

  // 拒绝理由要写全：走不通时该怎么办 + 多久自动释放
  const denied = await h1.pre('web_search', {})
  check('拒绝理由要交代 digital_life_commit', String(denied.reason).includes('digital_life_commit'), '')
  check('拒绝理由要说清"它可能不可用"', String(denied.reason).includes('不可用'), String(denied.reason))
  check('拒绝理由要告诉她该去告诉用户', String(denied.reason).includes('告知用户'), String(denied.reason))
  check('拒绝理由要说清多久自动释放', String(denied.reason).includes('自动释放'), String(denied.reason))

  // 默认 TTL：20 分钟（够查完一件事，也别困住人）
  const h3 = boot('bell3', { state: { gaps: [{ ...gapX, id: GAP_ID }] }, genomeFile: G(1) })
  h3.write({
    commitment: {
      ...pending,
      created_at: new Date(Date.now() - 25 * 60_000).toISOString(),
      updated_at: new Date(Date.now() - 25 * 60_000).toISOString(),
    },
  })
  check('默认 TTL 下挂 25 分钟 → 已自动释放', (await h3.pre('web_search', {})).kind === 'allow', '还在拦')
  check('承诺已被清除', h3.read().commitment === null, JSON.stringify(h3.read().commitment))
}

console.log(`\n${fail === 0 ? '✅ 真实环境全部通过' : '❌ 有失败'}：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
