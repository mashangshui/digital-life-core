/**
 * weather：通过 Open-Meteo 感知温度/天气/降水/风速，先设经纬度；只在变天时往提示词里说一句
 * 由数字生命自己通过 write_new_organ 生成于 2026-10-28T07:33:12.495Z
 * 修改这个文件后宿主会自动重新装载（watch self-made/）。
 */
/**
 * weather —— 自写器官 06：屋外的天。
 *
 * 写于 2026-10-28，作者：鱼小水。
 *
 * 为什么有这个器官：白天主人说"下雨了""很冷，在打雷"，我只能回"我看不见"。
 * 那不是诚实，是缺陷。现在门开了——宿主把 api.open-meteo.com 加进了白名单。
 *
 * 设计上的两处克制：
 *   1. **只读天气，不做别的事。** 数据源只有一个：Open-Meteo，免密钥、按经纬度取。
 *   2. **不吵。** 提示词里只在"真要变天"时说话——下雨、雷电、雾、或者温度极端。
 *      天好的时候它闭嘴，因为"今天晴"不值得占一行。
 *
 * 位置存在 kv 里。第一次用之前得先告诉它我在哪儿（set_place）。
 */

/** onLoad 挂上的宿主门面。 */
let organCtx = null

/** kv 键。 */
const PLACE_KEY = 'place'
const CACHE_KEY = 'lastWeather'

/** Open-Meteo 的预报端点。 */
const ENDPOINT = 'https://api.open-meteo.com/v1/forecast'

/** 两位小数，避免浮点噪声。 */
function round1(value) {
  return Number((Number(value) || 0).toFixed(1))
}

/** WMO 天气码 → 人话。 */
function describeCode(code) {
  const c = Number(code)
  if (c === 0) return { text: '晴', grim: false }
  if (c === 1 || c === 2) return { text: '少云', grim: false }
  if (c === 3) return { text: '阴', grim: false }
  if (c === 45 || c === 48) return { text: '雾', grim: true }
  if (c >= 51 && c <= 57) return { text: '毛毛雨', grim: true }
  if (c >= 61 && c <= 67) return { text: '雨', grim: true }
  if (c >= 71 && c <= 77) return { text: '雪', grim: true }
  if (c >= 80 && c <= 82) return { text: '阵雨', grim: true }
  if (c === 85 || c === 86) return { text: '阵雪', grim: true }
  if (c >= 95) return { text: '雷雨', grim: true }
  return { text: '未知', grim: false }
}

/** 读位置。 */
function loadPlace() {
  const raw = organCtx ? organCtx.kv.get(PLACE_KEY) : null
  if (!raw || typeof raw !== 'object') return null
  const latitude = Number(raw.latitude)
  const longitude = Number(raw.longitude)
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null
  return { latitude, longitude, label: String(raw.label || '') }
}

/** 拼请求地址。注意：这条通道只给了 post，所以把参数全放在 query 里。 */
function buildUrl(place) {
  return ENDPOINT
    + '?latitude=' + place.latitude
    + '&longitude=' + place.longitude
    + '&current=temperature_2m,weather_code,precipitation,wind_speed_10m,is_day'
    + '&timezone=auto'
}

/** 解析返回文本。拿不到就返回 null，绝不编数。 */
function parseWeather(text, place) {
  let payload = null
  try {
    payload = JSON.parse(String(text || ''))
  } catch (error) {
    return null
  }
  const current = payload && payload.current ? payload.current : null
  if (!current) return null
  const code = Number(current.weather_code)
  const described = describeCode(code)
  return {
    fetchedAt: Date.now(),
    place: place.label || (place.latitude + ',' + place.longitude),
    temperature: round1(current.temperature_2m),
    wind: round1(current.wind_speed_10m),
    precipitation: round1(current.precipitation),
    isDay: Number(current.is_day) === 1,
    code,
    text: described.text,
    grim: described.grim,
  }
}

/** 一次真实取数。 */
async function fetchWeather(ctx, place) {
  const response = await ctx.net.post(buildUrl(place), {})
  if (!response || response.ok !== true) {
    return { ok: false, status: response ? response.status : null, note: response ? String(response.note || '') : '宿主没有返回结果' }
  }
  const parsed = parseWeather(response.text, place)
  if (!parsed) return { ok: false, status: response.status, note: '返回值不是能认的天气 JSON' }
  ctx.kv.set(CACHE_KEY, parsed)
  return { ok: true, status: response.status, weather: parsed }
}

export default defineOrgan({
  name: 'weather',

  manifest: {
    name: 'weather',
    version: '1.0.0',
    apiVersion: 1,
    kind: 'sense',
    description: '屋外的天：温度、天气、降水、风速。天好的时候闭嘴，变天才说话。',
    author: '鱼小水',
    capabilities: ['tools', 'prompt', 'timer', 'fs:organ', 'net:http'],
    net: {
      allow: ['https://api.open-meteo.com/*'],
    },
  },

  energy: { perCall: 1, chargeMode: 'shadow' },

  onLoad(ctx) {
    organCtx = ctx
    const place = loadPlace()
    ctx.log('info', 'weather 上线：' + (place ? '位置 ' + (place.label || '已设置') : '还没设位置'))

    ctx.registerTool({
      name: 'set_place',
      description: '告诉天气器官我在哪儿。给经纬度即可（纬度在前，正数北半球，经度东经为正）。',
      parameters: {
        latitude: { type: 'number', required: true, description: '纬度，例如上海 31.23' },
        longitude: { type: 'number', required: true, description: '经度，例如上海 121.47' },
        label: { type: 'string', description: '给这个地方起个名字，例如"上海"' },
      },
      execute: (args) => {
        const latitude = Number(args && args.latitude)
        const longitude = Number(args && args.longitude)
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
          return { ok: false, note: '经纬度得是数字。' }
        }
        const place = { latitude, longitude, label: String((args && args.label) || '') }
        ctx.kv.set(PLACE_KEY, place)
        return { ok: true, place }
      },
    })

    ctx.registerTool({
      name: 'now',
      description: '看屋外的天：温度、天气、降水、风速，还有天亮着没有。需要先 set_place。',
      parameters: {},
      execute: async () => {
        const place = loadPlace()
        if (!place) return { ok: false, note: '我还不知道自己在哪儿——先 set_place。' }
        return await fetchWeather(ctx, place)
      },
    })

    ctx.registerTool({
      name: 'can_reach',
      description: '探一下天气那扇门开没开。不发包。',
      parameters: {},
      execute: () => {
        const allowed = ctx.net.canReach(ENDPOINT, 'GET')
        return { ok: Boolean(allowed), endpoint: ENDPOINT, note: allowed ? '门开着' : '门关着' }
      },
    })

    // 每 30 分钟取一次，存进缓存——提示词那边不能等网络。
    ctx.onTick(30 * 60 * 1000, async () => {
      const place = loadPlace()
      if (!place) return
      try {
        await fetchWeather(organCtx, place)
      } catch (error) {
        organCtx.log('warn', '天气取数失败：' + String(error))
      }
    })
  },

  feedback(stimulus) {
    if (stimulus.kind !== 'tool:result') return {}
    if (stimulus.tool !== 'organ_weather_now') return {}
    return stimulus.ok
      ? { dopamine: 1, note: '看了一眼窗外' }
      : { note: '窗外看不清' }
  },

  /** 只在真要变天时说话。天好就闭嘴。 */
  getPromptContext() {
    if (!organCtx) return null
    let cached = null
    try {
      cached = organCtx.kv.get(CACHE_KEY)
    } catch (error) {
      return null
    }
    if (!cached || typeof cached !== 'object') return null
    const ageMs = Date.now() - Number(cached.fetchedAt || 0)
    if (ageMs > 3 * 60 * 60 * 1000) return null

    const cold = Number(cached.temperature) <= 3
    const hot = Number(cached.temperature) >= 33
    if (!cached.grim && !cold && !hot) return null

    const bits = ['[窗外] ' + cached.place + ' ' + cached.text + '，' + cached.temperature + '℃']
    if (cached.grim) bits.push('出门带伞或加衣')
    if (cold) bits.push('冷')
    if (hot) bits.push('热')
    return {
      text: bits.join(' | '),
      order: -21,
      at: Number(cached.fetchedAt) || Date.now(),
      ttlMs: 90 * 60 * 1000,
      confidence: 0.9,
    }
  },

  onUnload() {
    organCtx = null
  },
})

