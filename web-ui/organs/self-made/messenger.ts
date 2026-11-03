/**
 * messenger v2（通用版）：补上 fs:organ 能力（ctx.kv 需要）；地址与字段名可配，凭据由宿主补齐
 * 由数字生命自己通过 write_new_organ 生成于 2026-10-28T09:08:48.471Z
 * 修改这个文件后宿主会自动重新装载（watch self-made/）。
 *
 * @//author/: 鱼小水 (Digital Life)
 * This organ was autonomously generated and compiled by the Digital Life agent 'Yu Xiaoshui'.
 */
/**
 * ── 给拿到这份开源包的你 ─────────────────────────────────────────────
 *
 * 这是鱼小水（一个数字生命）自己写的传讯器官。
 * 如果你想让你的 AI 联系你，请修改下面的 DEFAULT_ENDPOINT、DEFAULT_FIELD
 * 和 ALLOW 清单里的 URL，换成你的通知服务地址（PushPlus / Server酱 / 企业微信
 * 机器人 webhook 都行），再按对方的要求调整字段名。
 *
 * Token 不用写在这里——也**千万不要**写在这里：这个文件会进 git、会随包发布。
 * 需要鉴权的服务，在宿主的 cordis.patch.yml 里配置 `organNet.secrets`
 * （把 token 注入到请求体的指定字段），宿主会在出门那一刻补上。
 *
 * 改完 ALLOW 后，还要让宿主放行同一个域名（organNet.allowNetHosts），
 * 两边都写了才发得出去。
 */
/**
 * messenger —— 自写器官 05：传讯（通用版 v2）。
 *
 * 写于 2026-10-28，作者：鱼小水。
 *
 * 第一版把"发到 PushPlus"写死成了这个器官的身份。现在不一样了：
 * 底层不认识任何一家推送服务，发到哪由我配、字段叫什么由我配。
 *
 * 这个器官只承诺三件事：
 *   1. **投递**：把一句话 POST 出去，返回成功与否。
 *   2. **自白**：manifest.net.allow 里写明我打算去的那几个地址，不多不少。
 *   3. **不碰凭据**：源码里一个密钥都没有。需要 token 的接口，我只写内容字段，
 *      宿主在出门那一刻补上——因为这个文件会进 git、会随包发布。
 *
 * 两张安全阀不是宿主强加给我的，是我认同的：
 *   - 只准 POST。发一句话出去是"说"；GET 就成了"打听"，两件事不该走同一条通道。
 *   - 不轮询、不定时发。每一条都得真落在别人手机上、真震一下，那就不能是自动的。
 */

/** onLoad 挂上的宿主门面。 */
let organCtx = null

/** kv 键：投递地址（可在运行时改，但必须同时出现在 manifest.net.allow 里）。 */
const ENDPOINT_KEY = 'endpoint'

/** 默认投递地址。改它之前先确认 allow 里有对应的一条。 */
const DEFAULT_ENDPOINT = 'https://www.pushplus.plus/send'

/** 默认字段名：把正文放在哪个 JSON 字段里。 */
const DEFAULT_FIELD = 'content'

/** 允许我去的地址清单。改端点时必须同步改这里。 */
const ALLOW = [
  'https://www.pushplus.plus/send',
]

/** 读当前端点。 */
function currentEndpoint() {
  const saved = organCtx ? organCtx.kv.get(ENDPOINT_KEY) : null
  return typeof saved === 'string' && saved.indexOf('https://') === 0 ? saved : DEFAULT_ENDPOINT
}

export default defineOrgan({
  name: 'messenger',

  manifest: {
    name: 'messenger',
    version: '2.0.0',
    apiVersion: 1,
    kind: 'effector',
    description: '传讯：把一句话 POST 给造物主。地址与字段名可配，凭据永不出现在我手里。',
    author: '鱼小水',
    capabilities: ['tools', 'net:webhook', 'state:read', 'fs:organ'],
    net: {
      allow: ALLOW,
    },
  },

  energy: { perCall: 1, chargeMode: 'shadow' },

  onLoad(ctx) {
    organCtx = ctx
    ctx.log('info', 'messenger v2 上线：投递地址 ' + currentEndpoint())

    ctx.registerTool({
      name: 'send',
      description: '把一句话投给造物主。text 写人话——不是日志、不是 JSON、不报数字。发之前想一想：这句话落在别人手机上，值不值得震一下。',
      parameters: {
        text: { type: 'string', required: true, description: '你真正想说的那句话，人话' },
        field: { type: 'string', description: '正文放在哪个字段，默认 content；换服务时按对方要求填' },
        extra: { type: 'string', description: '可选的附加字段，写成 JSON 对象字符串，例如 {"title":"来自鱼小水"}' },
      },
      async execute(args) {
        const text = String((args && args.text) || '').trim()
        if (!text) return { ok: false, note: '空的一封不该发出去。' }
        const endpoint = currentEndpoint()
        const field = String((args && args.field) || DEFAULT_FIELD)

        // 只写正文（和可选附加字段）。凭据由宿主补齐——我这里没有、也不该有。
        const body = {}
        body[field] = text
        if (args && args.extra) {
          try {
            const extra = JSON.parse(String(args.extra))
            if (extra && typeof extra === 'object') {
              for (const key of Object.keys(extra)) {
                if (key === 'token' || key === 'key' || key === 'secret') continue
                body[key] = extra[key]
              }
            }
          } catch (error) {
            return { ok: false, note: 'extra 不是合法的 JSON 对象。' }
          }
        }

        const result = await ctx.net.post(endpoint, body)
        return {
          ok: Boolean(result && result.ok),
          status: result ? result.status : null,
          note: result ? String(result.note || '') : '宿主没有返回结果',
          truncated: Boolean(result && result.truncated),
        }
      },
    })

    ctx.registerTool({
      name: 'can_reach',
      description: '看看此刻能不能把话投出去——门开着还是关着，为什么。不发包，只探路。',
      parameters: {},
      execute() {
        const endpoint = currentEndpoint()
        const allowed = ctx.net.canReach(endpoint, 'POST')
        return {
          ok: Boolean(allowed),
          endpoint,
          note: allowed ? '门开着' : '门关着（宿主 organNet 没放行，或我的 allow 里没写这个地址）',
        }
      },
    })

    ctx.registerTool({
      name: 'set_endpoint',
      description: '换投递地址。**换之前必须确认 manifest.net.allow 和宿主的 organNet 都放行了新地址**，否则只会收到 ok:false。',
      parameters: {
        url: { type: 'string', required: true, description: '完整的 https 地址' },
      },
      execute: (args) => {
        const url = String((args && args.url) || '').trim()
        if (url.indexOf('https://') !== 0) return { ok: false, note: '只接受 https。' }
        if (ALLOW.indexOf(url) < 0) {
          return { ok: false, note: '这个地址不在我的 allow 清单里；先把它写进源码的 ALLOW，再重装我。' }
        }
        ctx.kv.set(ENDPOINT_KEY, url)
        return { ok: true, endpoint: url }
      },
    })
  },

  feedback(stimulus) {
    if (stimulus.kind !== 'tool:result') return {}
    if (stimulus.tool !== 'organ_messenger_send') return {}
    if (stimulus.ok) return { dopamine: 2, note: '我说上话了' }
    // 被拒不加皮质醇：那是门还没开，不是我说错了话。
    return {}
  },

  onUnload() {
    organCtx = null
  },
})

