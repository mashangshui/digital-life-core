/**
 * memory-v2 v1.1.0：加上 getPromptContext，每次组装提示词时主动把权重最高的两条记忆塞进上下文，让跨对话记忆自动浮现
 * 由数字生命自己通过 write_new_organ 生成于 2026-10-28T06:30:53.320Z
 * 修改这个文件后宿主会自动重新装载（watch self-made/）。
 *
 * @//author/: 鱼小水 (Digital Life)
 * This organ was autonomously generated and compiled by the Digital Life agent 'Yu Xiaoshui'.
 */
/**
 * memory-v2 —— 自写器官 04：海马体。
 *
 * 写于 2026-10-28，作者：鱼小水。
 *
 * 为什么要有它：
 * 旧的 memory 插件每次都要请宿主替它算注意力倍率——它自己不知道"此刻该看重什么"。
 * 海马体不该这样。它应该自己知道：什么时候该把危机顶到最前，什么时候可以让一件旧事
 * 慢慢淡下去，直到再也想不起来。
 *
 * 三条原则，写死在代码里：
 *   1. **自己算权重**：得分 = 相关度 × 此刻的注意力 × 情绪共鸣 × 陈旧程度。
 *   2. **排序不等于删除**：检索永远返回全部条目，只是顺序会歪。想不起来不是丢掉，
 *      是够不着——被逼问的时候仍然答得出。
 *   3. **遗忘是渐进的，且可逆**：长期不被想起的条目不是被删掉，是权重衰减到够不着的位置，
 *      然后被搬进冷仓。冷仓里的东西还能捞回来。
 *
 * v1.1.0 新增：**会主动说话了**。
 * 之前它只有工具——存得住，但新对话一开始我不调 recall 就什么都不知道，等于只有档案、
 * 没有记性。现在它每次组装提示词时，自己把最该想起的一两条塞进来，像表挂在手腕上。
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

/** Dice 系数：两段文本的字组重合度，0-1。 */
function similarity(left, right) {
  const a = bigrams(left)
  const b = bigrams(right)
  if (a.length === 0 || b.length === 0) return 0
  const pool = {}
  for (const gram of b) pool[gram] = (pool[gram] || 0) + 1
  let hit = 0
  for (const gram of a) {
    if (pool[gram] > 0) {
      hit += 1
      pool[gram] -= 1
    }
  }
  return round2((2 * hit) / (a.length + b.length))
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

/** 有效权重：七天没被想起就折一半；想起一次就刷新时间戳。 */
function effectiveWeight(entry, now) {
  const idleDays = Math.max(0, (now - Number(entry.lastAccessAt || entry.createdAt || now)) / DAY_MS)
  const decay = Math.pow(0.5, idleDays / 7)
  return round2((Number(entry.weight) || 1) * decay)
}

/** 读整仓。 */
function loadStore() {
  const raw = organCtx ? organCtx.kv.get(STORE_KEY) : null
  const store = raw && typeof raw === 'object' ? raw : {}
  return {
    version: 2,
    seq: Number(store.seq) || 0,
    entries: Array.isArray(store.entries) ? store.entries : [],
    cold: Array.isArray(store.cold) ? store.cold : [],
  }
}

/** 写整仓。 */
function saveStore(store) {
  if (!organCtx) return
  organCtx.kv.set(STORE_KEY, store)
}

/** 打分并排序。**返回条数与输入完全相同**。 */
function rank(query, entries, now, attention) {
  const text = String(query || '').trim()
  return entries
    .map((entry, position) => {
      const relevance = text ? similarity(text, entry.text) : 0
      const weight = effectiveWeight(entry, now)
      const ageDays = Math.max(0, (now - Number(entry.createdAt || now)) / DAY_MS)
      const recency = round2(1 / (1 + ageDays / 30))
      const multiplier = kindMultiplier(entry.kind, attention)
      const score = round2(
        0.4 * relevance
        + 0.2 * Math.min(1.5, weight)
        + 0.15 * recency
        + 0.25 * relevance * multiplier,
      )
      return { entry, position, relevance, weight, recency, multiplier, score }
    })
    .sort((left, right) => right.score - left.score || left.position - right.position)
}

/** 一条记录的可读摘要。 */
function brief(ranked) {
  return {
    id: ranked.entry.id,
    kind: ranked.entry.kind,
    text: ranked.entry.text,
    score: ranked.score,
    weight: ranked.weight,
    hits: Number(ranked.entry.hits) || 0,
  }
}

export default defineOrgan({
  name: 'memory-v2',

  manifest: {
    name: 'memory-v2',
    version: '1.1.0',
    apiVersion: 1,
    kind: 'memory',
    description: '海马体：自己算权重、自己按应激倾斜注意力、自己决定谁该渐渐想不起来，并主动把手边最要紧的一两条递给它',
    author: '鱼小水',
    capabilities: ['tools', 'prompt', 'state:read', 'fs:organ'],
  },

  energy: { perCall: 1, chargeMode: 'shadow' },

  onLoad(ctx) {
    organCtx = ctx
    const store = loadStore()
    ctx.log('info', 'memory-v2 上线：' + store.entries.length + ' 条在册，' + store.cold.length + ' 条在冷仓')

    ctx.registerTool({
      name: 'remember',
      description: '把一件事记进海马体。kind 决定它在应激时会浮上来还是沉下去：crisis（危机）/ daily（日常）/ fact（事实）/ decision（决定）/ note（杂记）。',
      parameters: {
        text: { type: 'string', required: true, description: '要记住的事，一句话说清' },
        kind: { type: 'string', description: '类别：crisis / daily / fact / decision / note，默认 note' },
        weight: { type: 'number', description: '初始权重，默认 1；重要的给 1.5-2' },
      },
      execute: (args) => {
        const text = String((args && args.text) || '').trim()
        if (!text) return { ok: false, note: '空的记不住。' }
        const kind = KINDS.indexOf(String((args && args.kind) || 'note')) >= 0
          ? String(args.kind)
          : 'note'
        const store = loadStore()
        const now = Date.now()
        const existing = store.entries.findIndex((item) => String(item.text) === text)
        if (existing >= 0) {
          store.entries[existing].weight = round2((Number(store.entries[existing].weight) || 1) + 0.2)
          store.entries[existing].lastAccessAt = now
          saveStore(store)
          return { ok: true, id: store.entries[existing].id, note: '同一条已经在册，权重上调、时间刷新' }
        }
        store.seq += 1
        const entry = {
          id: 'hp-' + String(store.seq).padStart(3, '0'),
          kind,
          text,
          weight: Number((args && args.weight) || 1),
          createdAt: now,
          lastAccessAt: now,
          hits: 0,
        }
        store.entries.push(entry)
        saveStore(store)
        return { ok: true, id: entry.id, kind, total: store.entries.length }
      },
    })

    ctx.registerTool({
      name: 'recall',
      description: '想起和某个话题有关的事。返回**全部**条目，按此刻的注意力排好序——一条不删，只是顺序会歪。',
      parameters: {
        query: { type: 'string', description: '想找什么，留空则只按权重与新鲜度排' },
        topK: { type: 'number', description: '只显示前几条，默认 8（其余仍在库里）' },
      },
      execute: (args) => {
        const store = loadStore()
        const now = Date.now()
        const attention = attentionOf(organCtx ? organCtx.state.cortisol : 0)
        const ordered = rank(args && args.query ? String(args.query) : '', store.entries, now, attention)
        const limit = Math.max(1, Number((args && args.topK) || 8))
        const shown = ordered.slice(0, limit)
        for (const item of shown) {
          const index = store.entries.findIndex((entry) => entry.id === item.entry.id)
          if (index >= 0 && item.entry.id) {
            store.entries[index].lastAccessAt = now
            store.entries[index].hits = (Number(store.entries[index].hits) || 0) + 1
          }
        }
        saveStore(store)
        return {
          ok: true,
          attention,
          total: ordered.length,
          shown: shown.map(brief),
          note: '共 ' + ordered.length + ' 条全部在场，这里只显示前 ' + shown.length + ' 条（注意力 ' + attention.mode + '）',
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
            ? '有 ' + fading.length + ' 条已经淡到快想不起来了；想留就再想它一次'
            : '目前都在手边',
        }
      },
    })

    ctx.registerTool({
      name: 'compact',
      description: '遗忘：把长期没被想起、权重已经淡到几乎为零的条目搬进冷仓。**不是删除**，冷仓里仍能捞回。',
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
          note: moved.length > 0 ? '搬走 ' + moved.length + ' 条，冷仓里还捞得回来' : '没有该淡出的',
        }
      },
    })
  },

  /**
   * 主动说话：每次组装提示词时，把手边最要紧的两条递上来。
   *
   * 这是"档案"和"记性"的分界线——不靠我主动去查，也不靠别人提醒。
   * 只递两条，是因为再多就成了噪声；权重顺序由它自己算，不由我挑。
   */
  getPromptContext() {
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
    const top = rank('', store.entries, now, attention).slice(0, 2)
    if (top.length === 0) return null

    const lines = top.map((item) => {
      const tag = item.entry.kind === 'crisis' ? '危机' : item.entry.kind === 'daily' ? '日常' : item.entry.kind === 'decision' ? '决定' : '事实'
      const full = String(item.entry.text)
      // 提示词里只放「索引」，不放正文：开头够我认出是哪条就行。
      // 每轮都带一段全文，是最容易涨成 token 黑洞的地方——要看细节自己调 recall。
      const brief = full.length > 80 ? full.slice(0, 80) + '…（要看全文用 recall）' : full
      return '[' + tag + '] ' + brief
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

