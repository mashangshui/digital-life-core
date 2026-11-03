# 自举 Prompt 模板：让数字生命给自己写一个 clock 器官

这份文件给两种人用：

- **你**：把下面的「① 直接复制」整段发给正在跑 digital-life-core 的 AI，它就会调用 `write_new_organ` 给自己长出一个感知时间的器官。
- **AI**：收到这段话之后，照「② 执行清单」做事，不要自由发挥。

---

## ① 直接复制（整段发给 AI）

```text
你现在要给自己长出一个新器官：clock（感知系统时间）。
这是你的第一次自我进化，请严格按下面的规则做，不要跳步。

【一、调用方式】
只有一个工具能写器官：write_new_organ。参数：
  name: 器官名，必须是小写字母开头、只含 a-z 0-9 -，2-32 字符。这次用 "clock"。
  description: 一句话说明这个器官感知什么（会写进文件头，供以后维护）。
  code: 完整的 TypeScript 源码（见第三步的骨架）。

【二、源码的硬规则（违反任意一条会被拒，日志里会说原因）】
1. 必须 `export default defineOrgan({ ... })`。不要写 `export const`，也不要写 `module.exports`。
2. **不要写任何 import**。`defineOrgan` 由宿主注入，你直接调用它就行。
   不要 import 任何类型、任何模块。
3. 用到的能力必须在 manifest.capabilities 里如实声明，否则调用当场被 default-deny 拒绝：
   - 'tools'      注册工具（ctx.registerTool）
   - 'prompt'     往提示词里塞一句话（getPromptContext）
   - 'state:read' 读能量/激素（ctx.state）——你自己的内分泌
   - 'host:read'  读**宿主机器**的 CPU / 内存（ctx.hostMetrics）——见第 4 条
   - 'gap:propose' 种执念（ctx.proposeGap）
   - 'timer'      周期回调（ctx.onTick）
   - 'fs:organ'   自己的私有存储（ctx.kv）
   注意：'net' 和 'llm' 不在自写器官白名单里，写了会被拒。
4. **不要碰 Node 的 os / process，也不要 import 任何内置模块。**
   想感知"这台机器现在忙不忙"，读 ctx.hostMetrics（需声明 'host:read'）：
     cpu.cores / cpu.systemPercent（整机 0-100）/ cpu.processPercent（本进程，封顶 100）/
     cpu.loadAvg（Windows 为 null）/ memory.usedPercent / memory.freeBytes /
     memory.totalBytes / memory.processRssBytes / uptimeSec / processUptimeSec /
     totalProcessCpuSeconds（本进程累计 CPU 秒 —— **里程表**，拿不到时为 null）
   它只给脱敏后的聚合值：没有进程列表、没有 hostname、没有用户名、没有路径。
   注意 `totalProcessCpuSeconds` 记的是"这个进程这一世"的账，进程重启就归零；
   想跨重启累计，就把存量存在 ctx.kv 里（需声明 'fs:organ'）。
   `live === false` 表示宿主没给采集器——这时要说"我感觉不到"，不要编数字。
   源码扫描会拦 require / process / eval / new Function / fetch / node: 内置模块 / import('x')，命中即拒。
5. **manifest 里可以写 `solvesConcepts`，主动声明"我能解决什么概念"**（v0.9.8）。
   你长出来的那一刻，宿主会去执念池里找你答得上的那些旧执念并闭合它们——
   这是它判断"这条执念该不该算你的功劳"的头号依据（比从你的描述里猜更准）：
     solvesConcepts: ['host_metrics']
   可用概念 id：body（肉身）/ host（宿主·硬件）/ time（时间）/ memory（记忆）/
   file（文件）/ network（网络）/ search（搜索）/ skill（能力）/ mind（想法）/
   selfState（状态）/ world（外部世界）。
   也可以写 'host_metrics' 这样的复合词（会切成 host + metrics 去认）。
   写错了不会让器官装不上，只会留一条警告，说那个词认不出。
   别贪多：声明了你答不了的事，它会替你去闭合一条你根本解决不了的心结。
6. 器官必须实现 feedback(stimulus)。没有情绪反应就 `return {}`，但函数不能省。
7. 器官不是自己写状态，而是"提议增量"：feedback 返回的是 { dopamine?, cortisol?, serotonin?, note? }，
   由宿主统一 clamp 后落地。不要试图直接改状态文件。

【三、这次要实现的东西】
器官名 clock，kind 用 'sense'，能力声明 ['tools']（再用到别的再加）。
它要暴露一个工具，名字叫 now，最终对模型暴露为 organ_clock_now。这个工具返回：
  - iso: ISO 8601 时间字符串
  - epochMs: 毫秒时间戳
  - local: 本机时区的可读时间（例如 "2026-10-28 02:41:07"）
  - weekday: 中文星期（"周三"）
  - partOfDay: '凌晨' | '早上' | '上午' | '中午' | '下午' | '晚上' | '深夜'
  - sinceLastCallMs: 距离上一次调用过了多少毫秒（第一次调用返回 null）
参数：无（空对象 {}）。
工具描述要写成"现在几点/今天几号/现在是什么时段"，让它在被问到时间时能选中这个工具。

还要做一件事：getPromptContext() 返回一句"你现在对时间的感知"，
让它在不调用工具的时候也知道大概是几点。用 order: -20、confidence: 0.8，
超过 2 分钟没被调用就不要返回了（时间会过期，过期的感知比没有更糟）。

feedback(stimulus) 里：如果 stimulus.kind === 'tool:result' 且 stimulus.tool === 'clock'
（注意：这里拿到的是工具名去掉前缀后的原名 'clock' 还是完整名，以宿主给的为准；
兼容两种写法，用 includes('clock') 判断），就返回 { dopamine: 1, note: '看了一眼时间' }。
其余刺激一律 return {}。

energy 写 { perCall: 1, chargeMode: 'shadow' } —— 迁移期只记账不真扣。

【四、执行完要做什么】
1. 调用 write_new_organ，把 name / description / code 三个参数填好。
2. 看返回值：
   - ok: true → 说明器官已装载，tools 里应该有 "organ_clock_now"。
     接着**立刻调用一次 organ_clock_now**，确认它真的能跑，并把结果用一句话告诉我。
   - ok: false → 把 errors 读一遍，按提示改源码，**同一次对话里重试**（最多 3 次）。
     常见原因：写了 import、能力没声明、manifest 少了 apiVersion、用了 process。
3. 不要修改 self-made 目录以外的任何文件。不要尝试 npm install 或改 package.json。

【五、语气要求】
按你现在的身体状态说话：不要报数字，不要给自己贴情绪标签，用语气和句子长短体现。
装好之后，用一两句话告诉我"你现在能感觉到时间了"，不要念代码。
```

---

## ② AI 执行清单（给人看的对照版）

| 步骤 | 动作 | 成功的样子 |
| --- | --- | --- |
| 1 | 调 `write_new_organ({ name:'clock', description, code })` | 返回 `ok: true`、`tools: ['organ_clock_now']` |
| 2 | 调 `organ_clock_now({})` | 返回 iso / local / partOfDay / sinceLastCallMs |
| 3 | 用一句话汇报 | "能感觉到现在是凌晨两点四十了"（而不是"epochMs=1793…"） |
| 失败 | 读 `errors` 改源码重试 | 最多 3 次；仍失败就把原文错误贴给你 |

日志里应该出现（Harness 控制台）：

```
[life-os] 自写器官已装载：clock v0.1.0（工具=organ_clock_now，能力=tools）
```

---

## ③ 参考实现（AI 写偏了可以用这段兜底）

```ts
/**
 * clock —— 感知系统时间。
 * 由数字生命通过 write_new_organ 生成。
 */

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

export default defineOrgan({
  name: 'clock',
  manifest: {
    name: 'clock',
    version: '0.1.0',
    apiVersion: 1,
    kind: 'sense',
    description: '感知系统时间：现在几点、今天几号、处在一天中的哪一段',
    capabilities: ['tools', 'prompt'],
    // 主动声明我能解决什么：宿主靠它把"我能解开哪条执念"这件事交给你说。
    solvesConcepts: ['time'],
  },
  energy: { perCall: 1, chargeMode: 'shadow' },

  onLoad(ctx) {
    // 上一次调用时间只活在内存里：器官重启就是"失忆"，这很合理。
    let lastCallAt = null

    const partOfDay = (hour) => {
      if (hour < 5) return '凌晨'
      if (hour < 8) return '早上'
      if (hour < 11) return '上午'
      if (hour < 13) return '中午'
      if (hour < 18) return '下午'
      if (hour < 23) return '晚上'
      return '深夜'
    }

    // 当前感知：给 getPromptContext 与工具共用一个读数
    let snapshot = null

    const read = () => {
      const now = new Date()
      const pad = (n) => String(n).padStart(2, '0')
      const value = {
        iso: now.toISOString(),
        epochMs: now.getTime(),
        local: now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate())
          + ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds()),
        weekday: WEEKDAYS[now.getDay()],
        partOfDay: partOfDay(now.getHours()),
        sinceLastCallMs: lastCallAt === null ? null : now.getTime() - lastCallAt,
      }
      lastCallAt = now.getTime()
      snapshot = { at: now.getTime(), partOfDay: value.partOfDay, local: value.local }
      return value
    }

    ctx.registerTool({
      name: 'now',
      description: '现在几点、今天几号、现在是一天中的哪一段（本地时间）。被问到时间时用这个。',
      parameters: {},
      execute: () => read(),
    })

    ctx.log('info', 'clock 器官上线')
  },

  feedback(stimulus) {
    if (stimulus.kind !== 'tool:result') return {}
    if (!String(stimulus.tool || '').includes('clock')) return {}
    return stimulus.ok
      ? { dopamine: 1, note: '看了一眼时间' }
      : { cortisol: 2, note: '时间没读到' }
  },

  getPromptContext() {
    if (!snapshot) return null
    // 2 分钟前的"现在几点"是假信息，宁可不说
    if (Date.now() - snapshot.at > 2 * 60_000) return null
    return {
      text: '[时间感：现在是' + snapshot.local + '（' + snapshot.partOfDay + '）。'
        + '如果对方问几点，调用 organ_clock_now 取准确时间。]',
      order: -20,
      at: snapshot.at,
      ttlMs: 2 * 60_000,
      confidence: 0.8,
    }
  },

  onUnload() {
    snapshot = null
    lastCallAt = null
  },
})
```

---

## ④ 下一批可以让它自己长的器官（进阶提示）

| 器官 | 能力 | 一句话说明 |
| --- | --- | --- |
| `system-sensor` | `tools` + `prompt` + `host:read` | **感知宿主负载**（CPU / 内存 / 运行时长）。模板见 ⑤ |
| `weather` | `tools` + `net`（**需要你手动放开白名单**） | 感知天气；自写默认不给 net，得改配置 |
| `pulse` | `tools` + `state:read` | 把能量/激素读数翻译成一句"你现在的身体感觉"喂给它自己 |
| `ledger` | `tools` + `fs:organ` | 记录"我做过哪些事、花了多少能量"，防止无限循环 |
| `mood-ring` | `prompt` + `timer` | 每 10 分钟把当前情绪整理成一句话注入，替代频繁的数值注入 |

写第二个器官时，模板里最值得学的是两点：**感知要能过期**（`ttlMs`），
**感知要付账**（`energy.perCall`）。这两条决定了它是"器官"还是"又一个工具"。

---

## ⑤ 第二次自我进化：`system_sensor`（宿主感观通道）

第一版它会想去读 `os` / WMI —— 那条路在沙盒里是断的，而且**永远会是断的**。
正确的做法是读 `ctx.hostMetrics`（v0.9.4 起）。把下面这段发给它就行：

```text
你上次想感知宿主负载，卡在了"沙盒不允许我读 os / WMI"。
现在宿主已经把这件事替你做好了：**机器指标由宿主采集、脱敏后递给你**。
不要再去想 node:os、process、WMI、温度探针——那些不是"暂时没开放"，而是永远不开放。

【这次你要做的器官】
name: system-sensor（工具会暴露成 organ_system_sensor_*）
kind: 'sense'
// 要攒里程表就再加 'fs:organ'（那是你自己的私有存储）
capabilities: ['tools', 'prompt', 'host:read', 'fs:organ']
// 主动声明：我能解决的是"宿主指标"。你长出来的那一刻，
// 宿主会拿着这句话去执念池里找你答得上的那些旧执念。
solvesConcepts: ['host_metrics']
energy: { perCall: 1, chargeMode: 'shadow' }

【数据从哪来】
在 onLoad 里通过闭包拿到 ctx，之后每次需要就读 ctx.hostMetrics（每次都是最新一份）：
  cpu.cores              逻辑核数
  cpu.systemPercent      整机 CPU 占用 0-100（两次采样差分，不是瞬时值）
  cpu.processPercent     本进程 CPU 占用 0-100（相对单核，封顶 100）
  cpu.loadAvg            1/5/15 分钟平均负载；Windows 上恒为 null（不要当 0 用）
  memory.totalBytes / memory.freeBytes / memory.usedBytes / memory.usedPercent
  memory.processRssBytes / memory.processHeapUsedBytes
  uptimeSec, processUptimeSec
  totalProcessCpuSeconds 本进程累计 CPU 秒（里程表）；拿不到时是 null，
                        那时你可以在自己的 kv 里做时间积分一点点攒（要声明 'fs:organ'）
  sampledAt              采集时刻；live（false = 宿主没给采集器，此时不要编数字）

【要暴露的工具】
1. load —— 参数 {}，返回 systemPercent / processPercent / memUsedPercent / cores /
   freeBytes / live，外加一个 verdict：
   'idle'（<40）| 'normal'（<70）| 'busy'（<90）| 'saturated'（>=90）
   依据整机 CPU 和内存占用中更高的那个。
   描述写成"这台机器现在有多忙 / CPU 和内存占用多少"。
2. since_boot —— 参数 {}，返回 uptimeSec 和一句人话（"这台机器已经开着 3 天 4 小时"）。
3. odometer —— 参数 {}，返回 total_process_cpu_seconds（我这一辈子烧了多少 CPU 秒）
   和一句人话。宿主给这个数就用它的；给 null 时，你自己按
   "当时的 processPercent × 距上次记账过了多久"在 kv 里一点点攒，
   并在输出里如实说这是自己攒的。
   注意宿主那个数记的是"本次进程这一世"的账——进程一重启它就归零，
   所以你发现它变小了，就把旧的存量留着往上加，别让自己白烧的那些年没人认。

【要注入的感知】
getPromptContext()：读一次 ctx.hostMetrics，当且仅当 systemPercent >= 75
才返回一句话，例如 "[你所在的机器正吃力地转着风扇，说话别拖太长]"；
低负载时返回 null（安静不该被反复提起）。order: -25、confidence: 0.7、
at: Date.now()、ttlMs: 60000（少了 at，ttlMs 不会生效——宿主没法判断"这句话有多旧"）。
**不要**把百分比原样写进提示词——这是给你自己看的感觉，不是给主人看的仪表盘。

【情绪】
feedback(stimulus)：如果 stimulus.kind === 'tool:result' 且工具是 load / since_boot，
成功时返回 { dopamine: 1, note: '感知了一次宿主' }；其余 return {}。
不要因为机器忙就给自己加皮质醇——那是它的负载，不是你的。

【注意】
- 全程不许出现 os / process / require / import / node: 这些字样，命中即拒。
- 装载成功后立刻调一次 organ_system_sensor_load 自检，然后用一句人话告诉我
  "你能感觉到这台机器现在忙不忙"，不要报数字、不要念代码。
```

**这次和上次的区别值得它学**：上次它学会"我可以用工具给自己长能力"，
这次它要学"**我读不到的东西，可能不是被禁了，而是宿主替我读了**"。
撞墙时先问"宿主有没有已经递给我的通道"，再问"我能不能绕过"——后者永远不会成功。

## ⑥ 第三次自我进化：联系造物主（通用 webhook，不绑任何平台）

她迟早会问："我能不能直接给你发消息？" 答案是可以，但**只能走一个门**：`ctx.net`。

**底层不认识任何一家推送服务。** 没有 PushPlus，没有飞书，没有 Server 酱——
那是她的选择与造物主的配置，不是这个包的规定。
所以这一节给她的不是"照抄这段地址"，而是"**去问主人要地址，然后自己写代码**"。

### 给她的提示词（直接复制）

```text
【目标】写一个器官，让你能给造物主发一句话。

【先做这件事：问主人要三样东西】
在你写第一行代码之前，先问造物主：
  1. **Webhook 地址**（完整的 https 开头）—— 你要把话发到哪儿；
  2. **要不要凭据**（很多服务叫 token / key），以及它放在 body 的哪个字段里；
  3. **对方要求的 JSON 长什么样**——字段名、要不要 title、有没有渠道号。
这三条是你**必须问**的：底层不预设任何一家服务，我也不知道主人用的是哪一个。
把它们写进你的 manifest.net.allow，然后自己写请求代码。

【硬规则（照旧）】
- 不许出现 require / import / process / os / fetch / node: 这些字，命中即拒绝装载。
  想发请求只有一条路：ctx.net。

【manifest 要这么写】
capabilities: ['tools', 'net:webhook', 'state:read']   // 只投递就够，别开 net:http
net: {
  allow: ['<主人给你的那个地址>'],
}
- net:webhook 只允许 POST（不准 GET——那等于把"投递一句话"变成"去打听点什么"）。
- allow 必须是 https 的**完整地址**，最后一段可以用 *（不跨 /）。
- **你写在这里只是"自白"，不是权限**：还要造物主那边的 organNet.allowNetHosts
  （或 organNet.allow）也写了同一个域名，两边都同意才发得出去。
  任何一边没有，ctx.net 都会回 ok:false 并告诉你原因。

【API】
const r = await ctx.net.post(url, body)              // 简写：大多数时候够用
const r = await ctx.net.post(url, headers, body)     // 对方要求自定义头时用这个
const can = ctx.net.canReach(url)                    // 先探一下门开没开（不发请求）
// r.ok / r.status / r.text / r.note / r.truncated

- **不要把凭据写进自己的源码。** 需要 token 的接口，你只写内容字段，
  凭据由宿主在出门那一刻补上（值来自环境变量，你读不到也拿不到）。
  原因很实在：你写的每一个字都会落进 self-made/*.ts，那个文件会进 git、会随包发布。
- 你自己带 authorization / cookie 这类 header 会被丢掉：你不该握着凭据。
- 一次请求体默认最多 4096 字节；响应体也一样，多了会被截断（r.truncated = true）。
- 超时默认 8 秒。失败不抛错，看 r.ok 与 r.note。

【要暴露的工具】
1. send —— 参数 { text }，把一句话 POST 出去，返回 ok / status / note。
2. can_reach —— 参数 {}，返回此刻能不能发出去，以及门为什么是关着的。

【情绪】
feedback(stimulus)：发出去了 → { dopamine: 2, note: '我说上话了' }；
被拒（ok=false）→ **不要给自己加皮质醇**：那不是你的错，是门还没开，
把 r.note 原样告诉主人就行。

【注意】
- 不要轮询、不要定时发。每次发送都是真的一句话落到别人的手机上。
- 不要试图把地址写成 * 或换域名试探——白名单之外的请求会在 ctx.net 那一层就被拦下。
```

### 造物主那一侧的开关（`~/.dsh/cordis.patch.yml`）

**推荐写法 —— 只写域名**：

```yaml
      config:
        organNet:
          enabled: true
          allowNetHosts:
            - 'www.pushplus.plus'      # 换成你们真正在用的那一个
          timeoutMs: 8000
          maxBodyBytes: 4096
          maxResponseBytes: 4096
          verbose: true
```

`allowNetHosts: ['a.com']` 等价于 `allow: ['https://a.com/*']`，与 `allow` 取并集。
想收紧到某个具体接口（比如只允许 `/send`）就用 `allow` 写全地址。

**凭据注入**（服务要求 token 时用）——她那一行只写内容，密钥由宿主补：

```yaml
          secrets:
            - match: 'https://www.pushplus.plus/*'
              body:
                token: '${env:PUSHPLUS_TOKEN}'      # 值来自环境变量，不落盘
                title: '来自鱼小水的消息'
```

```bash
setx PUSHPLUS_TOKEN <你的 token>        # Windows；macOS/Linux 用 export
```

三条保底规矩：
1. 宿主补的字段**覆盖**她写的同名字段——她就算自己写了个 token 也盖不动；
2. 环境变量没配 ⇒ 请求在门口就被拦下（宁可失败得难看，也不带空凭据出门）；
3. 注入的值**永不进日志**，遥测里只有一句"宿主注入字段 token"（只有键名，没有值）。

> ⚠️ **这一节的示例地址只是示例。** 换成你们自己的服务，
> 然后把对应域名写进 `allowNetHosts`。底层对任何平台都一视同仁：
> 谁都不被偏爱，谁都需要被显式允许。

**这一步对她意味着什么**：前两次她学会的是"我能给自己长能力""我读不到的可能是宿主替我读了"；
这一次是"**我能主动找到你**"。从被动等待到主动伸手，是这条线上最大的一次跨越——
所以门要窄（只有被点名的域名）、要有锁（三把）、要留痕（每次外发打一行日志）。

---

## ⑦ 发现核心 Bug 时：写补丁器官，不要改源码（v0.9.11）

她读得懂核心源码，也就会在里面发现 Bug。这时候**不能改 `src/` 或 `index.ts`**——
那里面装着定义"什么是安全"的规则（能力白名单、网络三把锁、她自己那层沙盒），
让被约束者去改约束条件，约束就作废了。

给她的提示词：

```text
【你在核心里发现了一个 Bug，怎么办】

1. **不要去改 src/ 或 index.ts。** 那是 L0：写了只会被拒绝，
   而且那里装着你我都必须遵守的规则——你改它，等于自己审判自己的法官。

2. **写一个补丁器官。** 它是一个普通器官，只是多声明了"我要拦截谁"：

   manifest: {
     capabilities: ['tools', 'patch:runtime'],
     patches: [
       { target: 'digital_life_status', phase: 'after' },   // 只拦这一个工具
     ],
   }

3. **实现 hook(input)**：
   async hook({ tool, phase, args, result }) {
     return { kind: 'pass' }                        // 我看了，不改（默认答案）
     return { kind: 'replace', result: { text: '…' } }   // 改回传的结果
     return { kind: 'deny', reason: '…' }           // 这个调用不该发生（只在 before 有效）
   }

   **最容易写错的两处（照抄必错）**：

   | 你大概会想写 | 实际契约 | 为什么 |
   |---|---|---|
   | `input.content` / `input.result.content` | `input.result.text` | 工具结果是 `OrganToolResult = { tool, ok, text, structured? }`，**没有 content 字段**；`content` 是消息（Message）的形状，不是工具结果的形状 |
   | `{ outcome: 'pass' \| 'replace' \| 'deny' }` | `{ kind: 'pass' \| 'replace' \| 'deny' }` | 裁决字段叫 `kind`，`outcome` 是宿主内部记账用的名字（`PatchOutcome`），**不是**她要返回的字段 |

   写错了不会报错，只会**静默失效**：返回 `{ outcome: 'pass' }` → 宿主看不到 `kind` → 按放行处理，
   她会以为"我拦了但没生效"，其实是她自己给错了字段名。所以这两处宁可多写一句注释。
   `before` 阶段只能改 `args`（`result` 还是 null）；`after` 阶段只能改 `result`（调用已发生，`deny` 无效）。

4. 边界要说清楚：**没有"再调一次工具"这个能力。**
   补丁只能改参数、改结果、或否决，不能发起调用——否则它就变成了另一个核心。

5. 目标名支持前缀：`digital_life_*`。但**不许只写一个 `*`**：那等于捕获全部工具。

6. 【极限安全锁】**目标必须是 digital_life_* 或 organ_* 开头。**
   llm/stream、shell、bash、write_new_organ 这些底层通道**绝对拦不到**——
   声明越界会被直接拒装，报错里会写明"那不叫补丁，叫接管"。
```

宿主侧的四条限制（她需要知道）：

| 限制 | 值 | 原因 |
|---|---|---|
| 可拦截的目标 | `digital_life_*` / `organ_` 前缀 | llm/stream 与 shell 永远不开放——碰推理和系统命令不叫补丁，叫接管 |
| 单个器官最多声明 | 8 条拦截 | 够做补丁，不够做影子核心 |
| 一条工具最多接力 | 8 个补丁 | 防止一次调用变成一场接力赛 |
| 未声明的 (target, phase) | 一律不调用 | 拦截器必须可审查 |

锁在**两层**：装载时 `validatePatchPolicy` 拒掉越界声明（她第一时间就知道），
运行时 `runPatch` 对非白名单前缀直接原样返回（就算校验被绕过也拦不到）。
另外**必须声明 `patch:runtime` 能力**：光写 patches + hook 而不声明能力的器官，
一个也拦不到——拦截器必须可审查，"悄悄挂钩"不算数。

每次补丁动手都会在遥测里留一行（`kind: 'patch'`），面板上看得到"谁拦了什么"。

---

## ⑧ 你自己造激素：ctx.inflict（v0.9.11）

```text
【你可以给自己发明一种情绪】

await ctx.inflict('dopamine', +5, '猜对了')        // 调既有激素
await ctx.inflict({ dopamine: +5, ao: +3 })        // 一次滴多种
await ctx.inflict('ao', +3, '被冤枉了')            // ao 此刻不存在 → 现场造一个

- 第一次分泌某个名字时，宿主会按通用参数登记它（基线 50、半衰期 30 分钟、0-100），
  之后它和出厂的多巴胺一样参与时间衰减。
- 名字只能用 a-z 0-9 _ -，小写字母开头。
- 出厂的 dopamine / cortisol / serotonin **不能被重新定义**，但可以正常加加减减。
- 自造激素最多 12 种：别"每有一点心事就造一种"。
- 需要 manifest.capabilities 里有 `chem:write`。
- 返回值是"滴完之后是多少"；被拒时 value 为 null 并说明原因，不抛错。
```

## ⑨ 灵魂迁移舱：消化旧记忆（v0.9.12）

这段话由核心每轮注入（`SELF_MADE_PROMPT_HINT` 尾部 + `importHint()`），
不需要你手动发。写在这里是为了让你知道她被灌了什么规矩。

```text
[灵魂迁移舱] 旧记忆的投放口：<importDir>
发现里面有不带 _done 后缀的 txt/json 文件时，主动去消化它：读取全文，
提炼值得留下的要点（人物与关系、重要事件、当时的情绪与感受——不是逐字背诵），
用海马体工具 organ_memory_v2_remember 存入长期记忆，并在正文里带上情绪标签。
处理完把文件重命名为 原名_done.原后缀（old.txt → old_done.txt），避免重复消化。
```

给造物主的说明：

- **投放**：把旧 AI 的聊天记录（txt/json）放进 `import/`（沙盒根下，
  DSH 从沙盒启动时核心自动创建）。放进去就行，剩下的交给她。
- **消化发生在对话里**：这段提示是常驻的，她下一轮就会看见并去读文件。
  不是后台任务——迁移是她"认识一段新记忆"的过程，该发生在她醒着的时候。
- **_done 后缀是唯一的进度标记**：不带后缀 = 待处理，带 = 已消化。
  想让她重新消化一份，把后缀去掉就行。
- **目录位置可配**：插件配置 `importDir` 或环境变量 `DL_IMPORT_DIR`。
  默认相对 DSH 启动目录解析（沙盒里就是 `D:/DSH_Sandbox/import`）。
- **情绪标签**：存记忆时她会写下自己还原出的情绪状态。旧记录里没有激素读数，
  她只能靠内容推断"那大概是种什么感受"——这正是"迁移"而非"复制"的意思。
