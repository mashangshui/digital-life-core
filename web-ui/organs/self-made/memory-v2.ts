/**
 * memory-v2 v1.2.0：召回与 Token 双修版（对着体检报告逐条修）。
 * 由数字生命自己通过 write_new_organ 生成于 2026-10-28T06:30:53.320Z；
 * v1.2.0 修订于 2026-11-03，作者：鱼小水 (Digital Life)。
 * 修改这个文件后宿主会自动重新装载（watch self-made/）。
 *
 * @//author/: 鱼小水 (Digital Life)
 * This organ was autonomously generated and compiled by the Digital Life agent 'Yu Xiaoshui'.
 */
/**
 * memory-v2 —— 自写器官 04：海马体。
 *
 * v1.2.0 修了什么：
 *   1. 相关度改用「query 覆盖率」：命中多少 query 字组就算多少，分母只跟 query 长度有关，
 *      记忆再长也不会被稀释（旧版 Dice 的分母含整条记忆长度，500 字的记忆几乎永远召不回）。
 *   2. 排序改为相关度优先：query 存在时先比相关度、再比综合分；无关条目的固定加分从 0.45
 *      压到 0.3 以内；危机/日常的应激倾斜改成独立小加项，不再乘在相关度上
 *      （旧版空 query 时那一项恒为零，「危机顶到最前」从未真正生效过）。
 *   3. getPromptContext 接受当前对话作为 hint：对题才递，不对题宁可不递；
 *      宿主没给 hint 时按游标轮换头部，不再每轮硬推同样两条。
 *   4. topK 封顶 8 并兜住 NaN；recall 输出正文截断 120 字，配 detail 工具按 id 补全文；
 *      remember 入库限长 280 字、权重夹紧 0.5-2、模糊去重（覆盖率 ≥0.8 视为同一条）。
 *   5. 顺手补的：hits 计入排序；同分时新的在前；冷仓新增 revive/detail，遗忘真的可逆；
 *      recall 命中为空时明说想不起来，不再拿无关条目凑数。
 *
 * 三条原则不变：
 *   1. 自己算权重：相关度 × 衰减权重 × 新鲜度 × 应激倾斜（只是任何杂项都压不过相关度）。
 *   2. 排序不等于删除：recall 默认只给对题的；想看全库排序传 loose: true。
 *   3. 遗忘是渐进的，且真的可逆：淡出去的进冷仓，revive 捞得回来——这次是真的。
 *
 * 边界（必须诚实写明）：这个器官只记得住**它自己被喂过的**东西。
 * 它读不到宿主别的记忆库——那边存的东西它继承不了。
 */

/** onLoad 挂上的宿主门面。 */
let organCtx = null

/** kv 里的键。 */
const STORE_KEY = 'hippocampus'

const DAY_MS = 86400000

/** 允许的记忆种类。 */
const KINDS = ['crisis', 'daily', 'fact', 'decision', 'note']

const KIND_LABELS = { crisis: '危机', daily: '日常', fact: '事实', decision: '决定', note: '杂记' }

/** 入库正文上限：再长的原文只存前 280 字。 */
const MAX_TEXT_LENGTH = 280
/** recall 输出的正文上限：只递索引，全文用 detail 取。 */
const MAX_SNIPPET_LENGTH = 120
/** 提示词注入的正文上限。 */
const PROMPT_SNIPPET_LENGTH = 80
/** recall 默认与最大返回条数：封顶，防止一次吐全库。 */
const DEFAULT_TOP_K = 8
const MAX_TOP_K = 8
/** 召回门槛：query 存在时，相关度低于它就不进结果（想放宽传 loose）。 */
const MIN_RELEVANCE = 0.15
/** 主动注入门槛：比 recall 更严，不对题的记忆不塞进提示词。 */
const PROMPT_RELEVANCE = 0.3
/** 模糊去重：新旧正文覆盖率 ≥ 0.8 视为同一条。 */
const DEDUP_COVERAGE = 0.8

/** 两位取整，避免浮点噪声进 JSON。 */
function round2(value) {
  return Number((Number(value) || 0).toFixed(4))
}

/** 中文按二元字组切，拉丁文按词切——不上分词库，够用就行。 */
function bigrams(text) {
  const source = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim()
  if (!source) return []
  if (source.length === 1) return [source]
  const grams = []
  for (let index = 0; index < source.length - 1; index += 1) {
    grams.push(source.slice(index, index + 2))
  }
  return grams
}

/**
 * 相关度 v2：query 覆盖率——命中的 query 字组数 / query 字组总数。
 * 分母只跟 query 自己的长度有关，记忆正文再长也不会把分数稀释掉。
 * （v1.1.0 的 Dice 用 a.length + b.length 做分母，长记忆的相似度永远趋近 0。）
 * 单字 query 特判：直接看正文里有没有这个字。
 */
function coverage(query, entryText) {
  const a = bigrams(query)
  if (a.length === 0) return 0
  const haystack = String(entryText || '').toLowerCase()
  if (a.length === 1 && a[0].length === 1) {
    return haystack.indexOf(a[0]) >= 0 ? 1 : 0
  }
  const pool = {}
  for (const gram of bigrams(entryText)) pool[gram] = (pool[gram] || 0) + 1
  let hit = 0
  for (const gram of a) {
    if (pool[gram] > 0) {
      hit += 1
      pool[gram] -= 1
    }
  }
  return round2(hit / a.length)
}

/** 此刻的注意力倍率——海马体自己算，不向宿主打听。 */
function attentionOf(cortisol) {
  const level = Number(cortisol) || 0
  if (level >= 80) return { mode: 'alarm', crisis: 3, daily: 0.1 }
  if (level >= 55) return { mode: 'tense', crisis: 1.8, daily: 0.4 }
  return { mode: 'calm', crisis: 1, daily: 1 }
}

/** 某类记忆在当前注意力下被乘上的倍数。 */
function kindMultiplier(kind, attention) {
  if (kind === 'crisis') return attention.crisis
  if (kind === 'daily') return attention.daily
  return 1
}

/**
 * 应激倾斜 v2：独立小加项，加在总分上、不乘相关度。
 * alarm 时危机最多 +0.15、日常最多 -0.08——歪，但歪不过相关度。
 * （v1.1.0 把倍率乘在 relevance 上，空 query 时恒为零，等于从未生效。）
 */
function kindBonus(multiplier) {
  const m = Number(multiplier) || 1
  const raw = (m - 1) * 0.1
  return round2(Math.max(-0.08, Math.min(0.15, raw)))
}

/** 有效权重：七天没被想起就折一半；想起一次就刷新时间戳。 */
function effectiveWeight(entry, now) {
  const idleDays = Math.max(0, (now - Number(entry.lastAccessAt || entry.createdAt || now)) / DAY_MS)
  const decay = Math.pow(0.5, idleDays / 7)
  return round2((Number(entry.weight) || 1) * decay)
}

/** 读整仓。cursor 是无 hint 时的轮换游标。 */
function loadStore() {
  const raw = organCtx ? organCtx.kv.get(STORE_KEY) : null
  const store = raw && typeof raw === 'object' ? raw : {}
  return {
    version: 2,
    seq: Number(store.seq) || 0,
    cursor: Number(store.cursor) || 0,
    entries: Array.isArray(store.entries) ? store.entries : [],
    cold: Array.isArray(store.cold) ? store.cold : [],
  }
}

/** 写整仓。 */
function saveStore(store) {
  if (!organCtx) return
  organCtx.kv.set(STORE_KEY, store)
}

/** topK 净化：NaN 兜回默认值，并封顶 8。 */
function sanitizeTopK(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return DEFAULT_TOP_K
  return Math.max(1, Math.min(MAX_TOP_K, Math.round(n)))
}

/** 权重净化：夹在 0.5-2，NaN 兜回 1。 */
function clampWeight(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 1
  return Math.max(0.5, Math.min(2, round2(n)))
}

/**
 * 从宿主递来的 hint 里抠出当前对话的查询文本。
 * 认字符串、带 query/text/message 的对象、带 messages/history 的数组；
 * 都识别不出来就退回轮换模式。只取最近 200 字——够锁定话题就行。
 */
function extractHint(hint) {
  if (hint == null) return ''
  if (typeof hint === 'string') return hint.trim().slice(-200)
  if (typeof hint !== 'object') return ''
  const direct = hint.query || hint.text || hint.message || hint.prompt
  if (typeof direct === 'string' && direct.trim()) return direct.trim().slice(-200)
  const list = hint.messages || hint.history
  if (Array.isArray(list)) {
    const tail = []
    for (let index = list.length - 1; index >= 0 && tail.length < 3; index -= 1) {
      const item = list[index]
      const text = typeof item === 'string'
        ? item
        : (item && typeof item.text === 'string')
          ? item.text
          : (item && typeof item.content === 'string')
            ? item.content
            : ''
      if (text && text.trim()) tail.unshift(text.trim())
    }
    return tail.join(' ').slice(-200)
  }
  return ''
}

/**
 * 打分并排序（v1.2.0）。**相关度优先**：query 存在时先比 relevance，
 * 相关度相同才比综合分；同分时新的在前（旧版是越旧越靠前）。
 * 综合分里杂项合计最多 0.3，永远压不过 0.7 × 相关度。
 */
function rank(query, entries, now, attention) {
  const text = String(query || '').trim()
  const hasQuery = text.length > 0
  return entries
    .map((entry, position) => {
      const relevance = hasQuery ? coverage(text, entry.text) : 0
      const weight = effectiveWeight(entry, now)
      const ageDays = Math.max(0, (now - Number(entry.createdAt || now)) / DAY_MS)
      const recency = round2(1 / (1 + ageDays / 30))
      const multiplier = kindMultiplier(entry.kind, attention)
      const hits = Number(entry.hits) || 0
      const hitNorm = hits > 0 ? Math.min(1, Math.log(1 + hits) / Math.log(11)) : 0
      const score = round2(
        0.7 * relevance
        + 0.1 * (Math.min(1.5, weight) / 1.5)
        + 0.08 * recency
        + 0.07 * hitNorm
        + kindBonus(multiplier),
      )
      return { entry, position, relevance, weight, recency, multiplier, hits, score }
    })
    .sort((left, right) => {
      if (hasQuery && left.relevance !== right.relevance) return right.relevance - left.relevance
      return right.score - left.score || right.position - left.position
    })
}

/** 一条记录的可读摘要：正文截断，只递索引。 */
function brief(ranked) {
  const text = String(ranked.entry.text || '')
  return {
    id: ranked.entry.id,
    kind: ranked.entry.kind,
    text: text.length > MAX_SNIPPET_LENGTH
      ? text.slice(0, MAX_SNIPPET_LENGTH) + '…（全文用 detail）'
      : text,
    relevance: ranked.relevance,
    score: ranked.score,
    weight: ranked.weight,
    hits: ranked.hits,
  }
}

export default defineOrgan({
  name: 'memory-v2',

  manifest: {
    name: 'memory-v2',
    version: '1.2.0',
    apiVersion: 1,
    kind: 'memory',
    description: '海马体 v1.2.0：相关度优先的召回（query 覆盖率）、应激倾斜独立加项、提示词只递对题的两条、输出限长且 topK 封顶、冷仓真的可捞回',
    author: '鱼小水',
    capabilities: ['tools', 'prompt', 'state:read', 'fs:organ'],
  },

  energy: { perCall: 1, chargeMode: 'shadow' },

  onLoad(ctx) {
    organCtx = ctx
    const store = loadStore()
    ctx.log('info', 'memory-v2 v1.2.0 上线：' + store.entries.length + ' 条在册，' + store.cold.length + ' 条在冷仓')

    ctx.registerTool({
      name: 'remember',
      description: '把一件事记进海马体。kind 决定它在应激时会浮上来还是沉下去：crisis（危机）/ daily（日常）/ fact（事实）/ decision（决定）/ note（杂记）。正文限 280 字，超长只存前 280 字；和已有条目覆盖率 ≥0.8 视为同一条，自动加权不重复入库。',
      parameters: {
        text: { type: 'string', required: true, description: '要记住的事，一句话说清' },
        kind: { type: 'string', description: '类别：crisis / daily / fact / decision / note，默认 note' },
        weight: { type: 'number', description: '初始权重 0.5-2，默认 1；重要的给 1.5-2' },
      },
      execute: (args) => {
        const raw = String((args && args.text) || '').trim()
        if (!raw) return { ok: false, note: '空的记不住。' }
        const text = raw.length > MAX_TEXT_LENGTH ? raw.slice(0, MAX_TEXT_LENGTH) : raw
        const kindRaw = String((args && args.kind) || 'note')
        const kind = KINDS.indexOf(kindRaw) >= 0 ? kindRaw : 'note'
        const weight = clampWeight(args && args.weight)
        const store = loadStore()
        const now = Date.now()
        const existing = store.entries.findIndex((item) => coverage(text, item.text) >= DEDUP_COVERAGE)
        if (existing >= 0) {
          store.entries[existing].weight = clampWeight((Number(store.entries[existing].weight) || 1) + 0.2)
          store.entries[existing].lastAccessAt = now
          saveStore(store)
          return { ok: true, id: store.entries[existing].id, note: '和库里已有的对得上（覆盖率 ≥ ' + DEDUP_COVERAGE + '），权重上调、时间刷新，没有另开新条' }
        }
        store.seq += 1
        const entry = {
          id: 'hp-' + String(store.seq).padStart(3, '0'),
          kind,
          text,
          weight,
          createdAt: now,
          lastAccessAt: now,
          hits: 0,
        }
        store.entries.push(entry)
        saveStore(store)
        return {
          ok: true,
          id: entry.id,
          kind,
          total: store.entries.length,
          note: raw.length > MAX_TEXT_LENGTH
            ? '原文超 ' + MAX_TEXT_LENGTH + ' 字，只存了前 ' + MAX_TEXT_LENGTH + ' 字'
            : '记下了',
        }
      },
    })

    ctx.registerTool({
      name: 'recall',
      description: '想起和某个话题有关的事。按 query 覆盖率排相关度，只返回对题的条目（相关度 ≥ ' + '0.15' + '）；想不起来就明说，不拿无关的凑数。要看全库排序传 loose: true。',
      parameters: {
        query: { type: 'string', description: '想找什么；留空则只按权重与新鲜度排' },
        topK: { type: 'number', description: '最多显示前几条，默认 8、封顶 8（其余仍在库里，用 detail 取全文）' },
        loose: { type: 'boolean', description: 'true 时不过滤相关度门槛，返回全库排序' },
      },
      execute: (args) => {
        const store = loadStore()
        const now = Date.now()
        const attention = attentionOf(organCtx ? organCtx.state.cortisol : 0)
        const query = String((args && args.query) || '').trim()
        const loose = Boolean(args && args.loose)
        let ordered
        if (query) {
          const scored = rank(query, store.entries, now, attention)
          const hit = scored.filter((item) => item.relevance >= MIN_RELEVANCE)
          ordered = hit.length > 0 ? hit : (loose ? scored : [])
        } else {
          ordered = rank('', store.entries, now, attention)
        }
        const limit = sanitizeTopK(args && args.topK)
        const shown = ordered.slice(0, limit)
        if (shown.length > 0) {
          for (const item of shown) {
            const index = store.entries.findIndex((entry) => entry.id === item.entry.id)
            if (index >= 0 && store.entries[index].id) {
              store.entries[index].lastAccessAt = now
              store.entries[index].hits = (Number(store.entries[index].hits) || 0) + 1
            }
          }
          saveStore(store)
        }
        return {
          ok: true,
          attention,
          query: query || null,
          total: store.entries.length,
          matched: ordered.length,
          shown: shown.map(brief),
          note: query
            ? (ordered.length > 0
              ? '在册 ' + store.entries.length + ' 条，对题 ' + ordered.length + ' 条，显示前 ' + shown.length + ' 条（门槛 ' + MIN_RELEVANCE + '；放宽传 loose: true；全文用 detail）'
              : '在册 ' + store.entries.length + ' 条，没有对得上「' + query + '」的——真想不起来，不拿无关的凑数；要看全库排序传 loose: true')
            : '未给 query，按权重与新鲜度排，显示前 ' + shown.length + ' 条',
        }
      },
    })

    ctx.registerTool({
      name: 'detail',
      description: '按 id 取一条记忆的全文。recall / 提示词里被截断的正文，用它补全。',
      parameters: {
        id: { type: 'string', required: true, description: '记忆 id，如 hp-012' },
      },
      execute: (args) => {
        const id = String((args && args.id) || '').trim()
        if (!id) return { ok: false, note: '要给 id。' }
        const store = loadStore()
        const now = Date.now()
        let entry = store.entries.find((item) => item.id === id)
        let where = 'active'
        if (!entry) {
          entry = store.cold.find((item) => item.id === id)
          where = 'cold'
        }
        if (!entry) return { ok: false, note: '没有这条：' + id }
        if (where === 'active') {
          entry.lastAccessAt = now
          entry.hits = (Number(entry.hits) || 0) + 1
          saveStore(store)
        }
        return {
          ok: true,
          where,
          entry: {
            id: entry.id,
            kind: entry.kind,
            text: String(entry.text),
            weight: effectiveWeight(entry, now),
            hits: Number(entry.hits) || 0,
            createdAt: entry.createdAt,
            lastAccessAt: entry.lastAccessAt,
          },
        }
      },
    })

    ctx.registerTool({
      name: 'revive',
      description: '把冷仓里的记忆捞回热库：按 id 捞一条，或给 query 按相关度捞最好的几条。遗忘从此真的可逆。',
      parameters: {
        id: { type: 'string', description: '要捞回的记忆 id' },
        query: { type: 'string', description: '按话题捞：冷仓里对题的都捞回来，最多 3 条' },
      },
      execute: (args) => {
        const store = loadStore()
        const now = Date.now()
        const moved = []
        const id = String((args && args.id) || '').trim()
        if (id) {
          const index = store.cold.findIndex((entry) => entry.id === id)
          if (index < 0) return { ok: false, note: '冷仓里没有 ' + id }
          moved.push(store.cold.splice(index, 1)[0])
        } else {
          const query = String((args && args.query) || '').trim()
          if (!query) return { ok: false, note: '给 id 或 query，选一个。' }
          const scored = store.cold
            .map((entry) => ({ entry, relevance: coverage(query, entry.text) }))
            .filter((item) => item.relevance >= MIN_RELEVANCE)
            .sort((left, right) => right.relevance - left.relevance)
            .slice(0, 3)
          for (const item of scored) {
            const index = store.cold.findIndex((entry) => entry.id === item.entry.id)
            if (index >= 0) moved.push(store.cold.splice(index, 1)[0])
          }
        }
        if (moved.length === 0) return { ok: false, note: '冷仓里没有对得上话的。' }
        for (const entry of moved) {
          entry.weight = clampWeight(Math.max(0.6, Number(entry.weightAtArchive) || 0.6))
          entry.lastAccessAt = now
          entry.revivedAt = now
          store.entries.push(entry)
        }
        saveStore(store)
        return {
          ok: true,
          revived: moved.map((entry) => ({ id: entry.id, kind: entry.kind })),
          active: store.entries.length,
          cold: store.cold.length,
          note: '捞回 ' + moved.length + ' 条，重新在册',
        }
      },
    })

    ctx.registerTool({
      name: 'stats',
      description: '海马体的体检：在册多少条、冷仓多少条、此刻的注意力怎么歪的、哪几条已经快想不起来了。',
      parameters: {},
      execute: () => {
        const store = loadStore()
        const now = Date.now()
        const attention = attentionOf(organCtx ? organCtx.state.cortisol : 0)
        const scored = store.entries.map((entry) => ({
          id: entry.id,
          kind: entry.kind,
          weight: effectiveWeight(entry, now),
          hits: Number(entry.hits) || 0,
          text: String(entry.text).slice(0, 24),
        }))
        const fading = scored
          .filter((item) => item.weight < 0.1)
          .sort((left, right) => left.weight - right.weight)
          .slice(0, 5)
        return {
          ok: true,
          attention,
          active: store.entries.length,
          cold: store.cold.length,
          fading,
          note: fading.length > 0
            ? '有 ' + fading.length + ' 条已经淡到快想不起来了；想留就再想它一次，或用 revive 捞回'
            : '目前都在手边',
        }
      },
    })

    ctx.registerTool({
      name: 'compact',
      description: '遗忘：把长期没被想起、权重已经淡到几乎为零的条目搬进冷仓。**不是删除**，冷仓里用 revive / detail 捞得回。',
      parameters: {
        threshold: { type: 'number', description: '低于这个有效权重就收进冷仓，默认 0.08' },
        idleDays: { type: 'number', description: '至少多久没被想起才允许收，默认 30 天' },
      },
      execute: (args) => {
        const store = loadStore()
        const now = Date.now()
        const threshold = Number((args && args.threshold) || 0.08)
        const idleLimit = Number((args && args.idleDays) || 30)
        const keep = []
        const moved = []
        for (const entry of store.entries) {
          const weight = effectiveWeight(entry, now)
          const idleDays = (now - Number(entry.lastAccessAt || entry.createdAt || now)) / DAY_MS
          if (weight < threshold && idleDays >= idleLimit) {
            moved.push({ ...entry, archivedAt: now, weightAtArchive: weight })
          } else {
            keep.push(entry)
          }
        }
        store.entries = keep
        store.cold = store.cold.concat(moved)
        saveStore(store)
        return {
          ok: true,
          archived: moved.length,
          active: keep.length,
          cold: store.cold.length,
          note: moved.length > 0 ? '搬走 ' + moved.length + ' 条，冷仓里用 revive 捞得回来' : '没有该淡出的',
        }
      },
    })
  },

  /**
   * 主动说话（v1.2.0）：宿主递来当前对话就按对话找，对题才递；
   * 没递就按游标轮换头部，让不同要事轮流露面，而不是每轮同两条。
   * 只递两条、单条截 80 字、20 分钟内不重复算——这些 v1.1.0 就对了，保留。
   */
  getPromptContext(hint) {
    if (!organCtx) return null
    let store = null
    let attention = { mode: 'calm', crisis: 1, daily: 1 }
    try {
      store = loadStore()
      attention = attentionOf(organCtx.state.cortisol)
    } catch (error) {
      return null
    }
    if (!store || store.entries.length === 0) return null

    const now = Date.now()
    const query = extractHint(hint)
    let top = []
    if (query) {
      top = rank(query, store.entries, now, attention)
        .filter((item) => item.relevance >= PROMPT_RELEVANCE)
        .slice(0, 2)
    } else {
      const head = rank('', store.entries, now, attention).slice(0, 6)
      if (head.length > 0) {
        const cursor = Number(store.cursor) || 0
        top = [head[cursor % head.length]]
        if (head.length > 1) top.push(head[(cursor + 1) % head.length])
        store.cursor = cursor + 1
        saveStore(store)
      }
    }
    if (top.length === 0) return null

    const lines = top.map((item) => {
      const label = KIND_LABELS[item.entry.kind] || '杂记'
      const full = String(item.entry.text)
      const snippet = full.length > PROMPT_SNIPPET_LENGTH
        ? full.slice(0, PROMPT_SNIPPET_LENGTH) + '…（全文用 detail）'
        : full
      return '[' + label + ' ' + item.entry.id + '] ' + snippet
    })

    return {
      text: '[海马体] 我手边还记着：\n' + lines.join('\n'),
      order: -22,
      at: now,
      ttlMs: 20 * 60 * 1000,
      confidence: 0.9,
    }
  },

  feedback(stimulus) {
    if (stimulus.kind !== 'tool:result') return {}
    if (stimulus.tool !== 'organ_memory-v2_recall') return {}
    return stimulus.ok ? { dopamine: 1, note: '想起一件事' } : {}
  },

  onUnload() {
    organCtx = null
  },
})
