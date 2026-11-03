/**
 * 只读桥（bridge）—— Life-OS 进化中枢的数据源
 * ============================================================================
 * 浏览器读不了 ~/.dsh/digital-life-core/state.json（沙箱 + 同源策略），所以必须有这一层。
 *
 * 三条纪律：
 *   1. **只读**。本进程不提供任何写接口，也不持有状态副本的可写引用。
 *   2. **不伪造**。激素是惰性衰减的，文件不更新就没有新点；桥不会替它"插值补点"。
 *   3. **不丢帧**。fs.watch 在 Windows/NTFS 上会漏 rename 事件，所以叠加 1s 轮询兜底。
 *
 * 启动：node server/bridge.mjs
 * 环境变量：
 *   DL_STATE  状态文件路径（默认 ~/.dsh/digital-life-core/state.json）
 *   DL_PORT   监听端口（默认 8787）
 */

import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { Ring } from './ring.mjs'
import { buildSnapshot, buildTemperament, TEMPERAMENT_RANGES } from './snapshot.mjs'

/** web-ui/server → 项目根。手册默认放在项目根，也允许放在别处（见 MANUAL_CANDIDATES）。 */
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * 基因组文件的候选位置（v0.9.11）。
 *
 * 与核心 `src/genome.ts` 的候选保持一致：桥是独立进程，读不到插件配置，
 * 但它只需要"人改过的那一份"来给滑块画范围——值本身从 state.json 读。
 *
 * 注意声明顺序：这是个 `const` 数组，求值发生在这一行，
 * 写在 PROJECT_ROOT 之前会踩 TDZ（Cannot access before initialization），
 * 一启动就崩——而且崩在 nobody expects 的地方。
 */
// 气质面板的**写入**目标：永远是用户级这一份（不存在就以出厂那份为底稿复制）。
const USER_GENOME = process.env.DSH_HOME
  ? path.join(process.env.DSH_HOME, 'digital-life-core', 'genome.json')
  : path.join(os.homedir(), '.dsh', 'digital-life-core', 'genome.json')

// 顺序必须和 src/genome.ts 的 genomeCandidates() 一致：
// 用户级（她调过的）优先于项目级出厂。两边若不一致，面板写的和插件读的
// 会是两个文件——滑块看着生效了，人却没变。
const GENOME_CANDIDATES = [
  process.env.DL_GENOME,
  process.env.DSH_HOME && path.join(process.env.DSH_HOME, 'digital-life-core', 'genome.json'),
  path.join(os.homedir(), '.dsh', 'digital-life-core', 'genome.json'),
  path.join(PROJECT_ROOT, 'genome.json'),
].filter(Boolean)

const PORT = Number(process.env.DL_PORT ?? 8787)
const STATE_PATH = process.env.DL_STATE
  ?? path.join(os.homedir(), '.dsh', 'digital-life-core', 'state.json')
const ORGANS_DIR = process.env.DL_ORGANS
  ?? path.join(path.dirname(STATE_PATH), 'organs')

/**
 * 手册的候选路径，**按顺序取第一个存在的**。
 *
 * 刻意不接受客户端传路径：这个桥是"只读"的，但"读任意文件"照样是泄露
 * （哪怕只读，`/api/manual?path=~/.ssh/id_rsa` 也会把它念出来）。
 * 所以路径写死在服务端，前端只能要"那份手册"。
 *
 * D:/DSH_Sandbox 那一行是历史位置：手册最初写在沙盒里，后来项目里也有副本时优先项目。
 */
const MANUAL_CANDIDATES = [
  process.env.DL_MANUAL,
  path.join(PROJECT_ROOT, 'digital-life-manual.md'),
  path.join(PROJECT_ROOT, 'docs', 'digital-life-manual.md'),
  'D:/DSH_Sandbox/digital-life-manual.md',
  path.join(os.homedir(), '.dsh', 'digital-life-core', 'digital-life-manual.md'),
].filter(Boolean)

/** 手册体积上限：超过就当配置错了（正常是几十 KB），免得把整个磁盘读进内存。 */
const MAX_MANUAL_BYTES = 4 * 1024 * 1024

function resolveManual() {
  for (const file of MANUAL_CANDIDATES) {
    try {
      if (fs.statSync(file).isFile()) return file
    } catch {
      /* 不存在：试下一个 */
    }
  }
  return null
}

const PULSE_HZ = 10
const PULSE_WINDOW = 600 // 60s @10Hz
const ring = new Ring(PULSE_WINDOW)

let lastRaw = ''
let lastSnapshot = null
let lastSignature = ''
/** 器官目录的指纹：器官装载/调用计数变化也要触发推送，否则器官树要等下一次对话才刷新。 */
let lastOrganSig = ''

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function organSignature() {
  try {
    return fs.readdirSync(ORGANS_DIR)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => `${name}:${fs.statSync(path.join(ORGANS_DIR, name)).mtimeMs}`)
      .join('|')
  } catch {
    return '' // 目录还不存在 = 没有器官
  }
}

/** 读基因组文件（失败返回 null：面板退化为"只显示三件套的数值"）。 */
function readGenomeFile() {
  for (const file of GENOME_CANDIDATES) {
    try {
      const parsed = readJson(file)
      if (parsed && Array.isArray(parsed.chemicals)) return parsed
    } catch { /* 继续试下一个 */ }
  }
  return null
}

function readOrgans() {
  try {
    return fs.readdirSync(ORGANS_DIR)
      .filter((name) => name.endsWith('.json'))
      .map((name) => readJson(path.join(ORGANS_DIR, name)))
      .filter(Boolean)
  } catch {
    return [] // 还没接入任何器官 → 空数组，前端显示空态
  }
}

function refresh(force = false) {
  let raw
  try {
    raw = fs.readFileSync(STATE_PATH, 'utf8')
  } catch {
    return null
  }
  const organsSig = organSignature()
  const stateChanged = force || raw !== lastRaw
  const organsChanged = organsSig !== lastOrganSig
  if (!stateChanged && !organsChanged) return null
  lastRaw = raw
  lastOrganSig = organsSig

  const parsed = JSON.parse(raw) // 解析失败让调用方 catch：宁可报错也不要吞掉
  const snapshot = buildSnapshot(parsed, readOrgans(), readGenomeFile())
  lastSnapshot = snapshot

  // 器官变化不该在脉冲图上留下一个"假心跳"：没有新数据点就不推 pulse。
  if (!stateChanged) return { snapshot, pulse: null }

  const pulse = {
    t: Date.now(),
    energy: snapshot.soma.energy,
    dopamine: snapshot.soma.dopamine,
    cortisol: snapshot.soma.cortisol,
    serotonin: snapshot.soma.serotonin,
    frozen: snapshot.soma.frozen,
    // v0.9.19：她造的激素也要有自己的脉冲线。
    // 按 id 递值（不是按名字），前端拿 snapshot.chemicals 的全表去对，
    // 这样她造出第五种激素时，图上会自己多一条线，不需要改前端。
    chemicals: Object.fromEntries(snapshot.chemicals.map((item) => [item.id, item.value])),
  }
  ring.push(pulse)

  return { snapshot, pulse }
}

// ───────────────────────── HTTP ─────────────────────────

/** 读请求体，带体积上限——这是唯一的写接口，更要设闸。 */
function readBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) { reject(new Error(`请求体超过 ${limit} 字节`)); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * CORS 放行头（v0.9.12）。
 *
 * 两个面板曾经写死 `http://<hostname>:8787` 直连桥——那绕过了 Vite 代理，浏览器
 * 按跨域处理，而这里一个放行头都没有，于是 POST（content-type: application/json
 * 会触发预检）连 404 都拿不到，直接 `TypeError: Failed to fetch`。
 *
 * 现在前端已改回同源相对路径走代理，但桥仍然把头放全：万一有人直接打开
 * `web-ui/dist` 的静态页、或把桥换到别的端口，预检也得过得去。
 * 只读桥、无凭据、只认本机，放行 * 是可以接受的。
 */
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
}

/** 给这个响应挂上放行头：包装 writeHead，免得 20 处调用点各写一遍。 */
function withCors(res) {
  const original = res.writeHead.bind(res)
  res.writeHead = (status, headers) => original(status, { ...CORS_HEADERS, ...(headers ?? {}) })
  return res
}

const server = http.createServer(async (req, res) => {
  withCors(res)
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

  // 预检：非 simple header（application/json）的 POST 必先发 OPTIONS，
  // 不回 204 的话浏览器根本不会把真正的请求发出去。
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {})
    res.end()
    return
  }

  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, state: STATE_PATH, clients: wss?.clients.size ?? 0 }))
    return
  }

  if (url.pathname === '/api/snapshot') {
    try {
      const fresh = refresh(true) ?? (lastSnapshot ? { snapshot: lastSnapshot } : null)
      if (!fresh) {
        res.writeHead(503, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'state file not readable', state: STATE_PATH }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ ...fresh.snapshot, pulseHistory: ring.toArray() }))
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: String(error) }))
    }
    return
  }

  // 操作手册：给 WebUI 内置的阅读器用。路径固定候选、不接客户端参数。
  if (url.pathname === '/api/manual') {
    const file = resolveManual()
    if (!file) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({
        ok: false,
        error: 'manual not found',
        tried: MANUAL_CANDIDATES,
      }))
      return
    }
    try {
      const stat = fs.statSync(file)
      if (stat.size > MAX_MANUAL_BYTES) {
        res.writeHead(413, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: `manual too large: ${stat.size} bytes`, path: file }))
        return
      }
      const content = fs.readFileSync(file, 'utf8')
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        // 手册会手改：宁可每次重读，也不要浏览器缓存一份旧的
        'cache-control': 'no-store',
      })
      res.end(JSON.stringify({
        ok: true,
        path: file,
        name: path.basename(file),
        bytes: stat.size,
        mtimeMs: stat.mtimeMs,
        content,
      }))
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: String(error), path: file }))
    }
    return
  }

  /**
   * 基因面板（v0.9.11）：唯一的写接口。
   *
   * 桥自称"只读"，却要开一个写口——这不矛盾吗？不：
   * 它写的不是状态，而是**造物主的决定**。滑块推的是"她的出厂性格"，
   * 那本来就是人的权限，和"她自己能不能改"是两回事。
   *
   * 三条边界，一条都不能少：
   *   1. **只写一个文件**（state.json），且只改 `chemicals` 这一段；
   *   2. **只接受已知的化学物质 id**——这里不做"顺手造一种新激素"，那是她的权利（ctx.inflict）；
   *   3. 值夹紧到 [min, max]，非法值直接拒绝而不是夹silent。
   *
   * 为什么改 state.json 而不是 genome.json：genome 定义的是"她是什么样的人"，
   * 滑块调的是"她此刻是多少"。改前者要重启，改后者下一轮衰减就生效。
   */
  if (url.pathname === '/api/genome') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ ok: true, genome: readGenomeFile() }))
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: 'use POST' }))
      return
    }
    try {
      const body = await readBody(req, 8 * 1024)
      const patch = JSON.parse(body)
      const genomeFile = readGenomeFile()
      /**
       * 已知的化学物质 = 出厂的（genome.json）+ 她自己造的（state.json 的 chemicalSpecs）。
       *
       * v0.9.18：以前只认出厂那份，于是她造的激素在面板上有滑块却拖不动
       * （POST 一发就被判"不是已知的化学物质"）。看得见却调不了，
       * 比看不见更让人恼火——现在两处都认。
       */
      const state = readJson(STATE_PATH)
      if (!state) {
        res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: 'state.json 读不到' }))
        return
      }
      const specs = new Map(
        [
          ...(genomeFile?.chemicals ?? []),
          ...(Array.isArray(state.chemicalSpecs) ? state.chemicalSpecs : []),
        ].map((item) => [item.id, item]),
      )
      if (!specs.size) {
        res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: 'genome.json 不可用，无法校验取值范围' }))
        return
      }
      const chemicals = { ...(state.chemicals ?? {}) }
      const applied = []
      const rejected = []
      for (const [id, rawValue] of Object.entries(patch ?? {})) {
        const spec = specs.get(id)
        if (!spec) { rejected.push(`${id}：不是已知的化学物质`); continue }
        const value = Number(rawValue)
        if (!Number.isFinite(value)) { rejected.push(`${id}：不是数字`); continue }
        if (value < spec.min || value > spec.max) { rejected.push(`${id}：超出 [${spec.min}, ${spec.max}]`); continue }
        chemicals[id] = value
        applied.push(`${id}=${value}`)
      }
      // 顶层三个兼容字段同步：否则核心下一次 decay 会把它覆盖回去。
      for (const id of ['dopamine', 'cortisol', 'serotonin']) {
        if (Number.isFinite(Number(chemicals[id]))) state[id] = Number(chemicals[id])
      }
      state.chemicals = chemicals
      // 时间戳不动：改的是"她是多少"，不是"时间过去了多久"。
      fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, applied, rejected }))
    } catch (error) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: String(error) }))
    }
    return
  }

  /**
   * 气质面板（v0.9.12）：写的是 genome.json，不是 state.json。
   *
   * 与 /api/genome 的分工：基因滑块改"她此刻是多少"（state，下一轮衰减生效）；
   * 气质滑块改"她出厂是什么样的人"（定义，核心 1 秒内热重载，同样不用重启）。
   *
   * 三条边界：
   *   1. **只接受四个已知旋钮**，其余字段一律拒收（不顺便改别人的文件）；
   *   2. 值越界**拒收**而不是夹回——滑块本身有范围，能到这里越界的必是手改脚本，该看见错误；
   *   3. 原文件整体读入、只盖 temperament 段、整体写回——$comment 注释字段随之保留。
   *
   * genome.json 不存在时**拒绝创建**而不是悄悄生成一份：缺了 chemicals 定义的
   * 半份文件会让核心整套回退到内置默认（那才是真正难查的静默故障）。
   */
  if (url.pathname === '/api/temperament') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ ok: true, temperament: buildTemperament(readGenomeFile()), ranges: TEMPERAMENT_RANGES }))
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: 'use POST' }))
      return
    }
    let writeTarget = null
    try {
      // 永远写**用户级**那一份。出厂 genome.json（插件目录里）是给所有人的默认值，
      // 不该被某个人的滑块改掉——否则「出厂默认 vs 本人人格」就再也分不开，
      // 一致性校验和别人的首次安装都会被这一次拖动污染。
      writeTarget = USER_GENOME
      if (!fs.existsSync(USER_GENOME)) {
        const factory = GENOME_CANDIDATES.find((file) => fs.existsSync(file)) ?? null
        if (!factory) {
          res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: `找不到 genome.json（试过 ${GENOME_CANDIDATES.join('，')}）。请在项目根放一份再调气质。` }))
          return
        }
        // 以出厂那份为底稿复制一份：chemicals / $comment 全部跟着过去，
        // 她只在这上面改气质，不会丢失任何出厂定义。
        fs.mkdirSync(path.dirname(USER_GENOME), { recursive: true })
        fs.copyFileSync(factory, USER_GENOME)
      }
      const body = await readBody(req, 4 * 1024)
      const patch = JSON.parse(body)
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: '请求体必须是对象' }))
        return
      }
      // 原文件先整体读进来：写回时 $comment 与 chemicals 原样保留。
      const doc = JSON.parse(fs.readFileSync(writeTarget, 'utf8'))
      if (!doc || typeof doc !== 'object' || !Array.isArray(doc.chemicals)) {
        res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: `${writeTarget} 缺少 chemicals 定义，拒绝改写` }))
        return
      }
      const applied = []
      const rejected = []
      const next = { ...(doc.temperament ?? {}) }
      for (const [key, rawValue] of Object.entries(patch)) {
        const range = TEMPERAMENT_RANGES[key]
        if (!range) { rejected.push(`${key}：不是气质旋钮`); continue }
        const value = Number(rawValue)
        if (!Number.isFinite(value)) { rejected.push(`${key}：不是数字`); continue }
        if (value < range.min || value > range.max) { rejected.push(`${key}=${value} 超出 [${range.min}, ${range.max}]`); continue }
        next[key] = value
        applied.push(`${key}=${value}`)
      }
      if (applied.length > 0) {
        doc.temperament = next
        fs.writeFileSync(writeTarget, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, applied, rejected, file: writeTarget }))
    } catch (error) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: String(error) }))
    }
    return
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('not found. try /api/snapshot, /api/manual or /health')
})

// ───────────────────────── WebSocket ─────────────────────────

const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  if (url.pathname !== '/ws') {
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
})

wss.on('connection', (ws) => {
  // 新客户端先给一份完整快照，避免"前 60 秒空白"
  try {
    const fresh = refresh(true)
    if (fresh) {
      ws.send(JSON.stringify({ type: 'snapshot', ...fresh.snapshot, pulseHistory: ring.toArray() }))
    }
  } catch { /* 初帧失败不影响后续增量 */ }
})

function broadcast(message) {
  const payload = JSON.stringify(message)
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(payload)
  }
}

// ───────────────────────── 变更侦测 ─────────────────────────

let debounceTimer = null
let lastSignatureSeen = ''

function onChanged() {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    let result
    try {
      result = refresh()
    } catch (error) {
      broadcast({ type: 'error', text: `状态文件解析失败：${String(error)}` })
      return
    }
    if (!result) return

    const { snapshot, pulse } = result
    if (pulse) broadcast({ type: 'pulse', ...pulse })

    // gaps / organs / counters 只在真变了的时候推，避免前端无谓重排
    const signature = JSON.stringify({
      g: snapshot.gaps.map((g) => [g.id, Math.round(g.tension), g.status]),
      o: snapshot.organs.map((o) => [o.name, o.calls, o.status]),
      c: snapshot.counters,
    })
    if (signature !== lastSignatureSeen) {
      lastSignatureSeen = signature
      broadcast({ type: 'state', ...snapshot })
    }
  }, 120)
}

// ① 事件监听（快，但可能漏）
try {
  fs.watch(path.dirname(STATE_PATH), (_event, filename) => {
    if (!filename || String(filename).includes('state.json')) onChanged()
  })
} catch (error) {
  console.warn(`[bridge] fs.watch 不可用（${String(error)}），退化为纯轮询`)
}

// ①b 器官目录也要监听：移植完一个器官，界面上应立刻长出节点
try {
  fs.watch(ORGANS_DIR, () => onChanged())
} catch {
  /* 目录还不存在：等器官第一次落盘后再靠轮询发现 */
}

// ② 轮询兜底（慢，但必然不漏）—— 两条路同时开，是这个桥最重要的可靠性设计
setInterval(() => {
  try {
    const stat = fs.statSync(STATE_PATH)
    const signature = `${stat.mtimeMs}:${stat.size}:${organSignature()}`
    if (signature !== lastSignature) {
      lastSignature = signature
      onChanged()
    }
  } catch { /* 文件暂时不存在：静默 */ }
}, 1_000)

// ③ 心跳：让前端能区分"没数据"和"连接已死"
setInterval(() => broadcast({ type: 'heartbeat', t: Date.now() }), 2_000)

// 让 PULSE_HZ 参与实际节流（变更驱动的推送已经足够，这里只做注释级保留）
void PULSE_HZ

server.listen(PORT, '127.0.0.1', () => {
  console.log('─'.repeat(58))
  console.log('  Life-OS 进化中枢 · 只读桥已启动')
  console.log(`  状态文件  ${STATE_PATH}`)
  console.log(`  器官目录  ${ORGANS_DIR}${fs.existsSync(ORGANS_DIR) ? '' : '（尚未创建）'}`)
  console.log(`  HTTP      http://127.0.0.1:${PORT}/api/snapshot`)
  console.log(`            http://127.0.0.1:${PORT}/api/manual`)
  console.log(`  操作手册  ${resolveManual() ?? '（未找到，用 DL_MANUAL 指定）'}`)
  console.log(`  WS        ws://127.0.0.1:${PORT}/ws`)
  console.log('─'.repeat(58))
  try {
    refresh(true)
    console.log(`[bridge] 首帧已读取：energy=${lastSnapshot?.soma.energy ?? '?'}，缺口 ${lastSnapshot?.gaps.length ?? 0} 条`)
    lastSignatureSeen = JSON.stringify({
      g: lastSnapshot.gaps.map((g) => [g.id, Math.round(g.tension), g.status]),
      o: lastSnapshot.organs.map((o) => [o.name, o.calls, o.status]),
      c: lastSnapshot.counters,
    })
  } catch (error) {
    console.warn(`[bridge] 首帧读取失败：${String(error)}`)
  }
})

process.on('SIGINT', () => {
  console.log('\n[bridge] 退出')
  wss.close()
  server.close(() => process.exit(0))
})
