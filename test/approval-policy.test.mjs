/**
 * v1.0.3 · 细粒度智能审批测试
 * ============================================================================
 * 这份文件测的是"**该放行的放行了，该问的还在问**"。
 *
 * 为什么两边都要测：
 *   只测"危险被拦住"，会漏掉"低风险被困住"——那是体验退化，用户会用关掉整个
 *   功能来投票；只测"低风险放行"，会漏掉"高危被顺手放过"——那是安全事故。
 *   所以每一档都成对出现：
 *
 *     low       放行   ←→  llm / patch:runtime  问
 *     controlled 放行  ←→  白名单外的域名          问
 *     合规源码   放行   ←→  越狱关键词              问
 *
 * 跑法：npm run build && node test/approval-policy.test.mjs（npm test 会串跑）
 */

import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CONTROLLED_CAPABILITIES,
  HIGH_RISK_CAPABILITIES,
  LOW_RISK_CAPABILITIES,
  describePolicy,
  evaluateOrganPolicy,
  policyPromptReason,
} from '../lib/src/organ-policy.js'
import {
  classifyToolForApproval,
  isOrganToolName,
  DEFAULT_AUTO_APPROVE_ALLOW,
  DEFAULT_AUTO_APPROVE_ASK,
} from '../lib/src/auto-approve.js'
import { loadOrganFile } from '../lib/src/organ-loader.js'
import { OrganHost } from '../lib/src/organ-host.js'
import { SELF_MADE_CAPABILITIES } from '../lib/src/organ-loader.js'

let passed = 0
function ok(label) {
  passed += 1
  console.log(`  ✓ ${label}`)
}

const workDir = mkdtempSync(join(tmpdir(), 'dlc-policy-'))
const HOST_ALLOW = ['https://www.pushplus.plus/*', 'https://api.example.com/v1/*']

/** 造一个 manifest（只填判定关心的字段）。 */
function manifest(capabilities, net) {
  return { name: 'probe', version: '1.0.0', apiVersion: 1, kind: 'custom', capabilities, ...(net ? { net } : {}) }
}

const judge = (caps, extra = {}) => evaluateOrganPolicy({
  manifest: manifest(caps, extra.net),
  source: extra.source,
  netAllowPatterns: extra.netAllowPatterns ?? HOST_ALLOW,
  allowedCapabilities: extra.allowedCapabilities ?? SELF_MADE_CAPABILITIES,
  autoApprove: extra.autoApprove,
})

// ═══════════════════════════════════════════════════════════════════
console.log('\n【一 · 自动放行】低风险能力零摩擦')
// ═══════════════════════════════════════════════════════════════════
{
  const low = judge(['state:read', 'timer', 'fs:organ', 'gap:propose', 'tools'])
  assert.equal(low.verdict, 'allow', `低风险能力应自动放行：${low.reasons.join('；')}`)
  assert.equal(low.tier, 'low')
  ok('放行①：state:read / timer / fs:organ / gap:propose / tools → 自动通过')

  for (const cap of LOW_RISK_CAPABILITIES) {
    const one = judge([cap])
    assert.equal(one.verdict, 'allow', `${cap} 属于低风险，应放行：${one.reasons.join('；')}`)
  }
  ok(`放行②：低风险清单里每一种能力单独声明都放行（共 ${LOW_RISK_CAPABILITIES.length} 种）`)

  const none = judge([])
  assert.equal(none.verdict, 'allow', '不声明能力（只做感知）也放行')
  ok('放行③：不声明任何能力 → 放行（它连手脚都没有）')

  const messy = evaluateOrganPolicy({ manifest: { capabilities: undefined }, netAllowPatterns: HOST_ALLOW })
  assert.equal(messy.verdict, 'allow', 'manifest 形状不标准时按"没有能力"处理，不炸')
  ok('放行④：capabilities 缺失 / 非数组时按空处理（判定器本身不炸）')
}

// ═══════════════════════════════════════════════════════════════════
console.log('\n【二 · 受控放行】外发目标在白名单内')
// ═══════════════════════════════════════════════════════════════════
{
  const good = judge(['tools', 'net:webhook'], { net: { allow: ['https://www.pushplus.plus/send'] } })
  assert.equal(good.verdict, 'allow', `白名单内的 webhook 应放行：${good.reasons.join('；')}`)
  assert.equal(good.tier, 'controlled')
  assert.deepEqual(good.net.unknown, [])
  ok('受控①：net:webhook 打向宿主白名单里的地址 → 自动通过')

  const http = judge(['net:http'], { net: { allow: ['https://api.example.com/v1/echo'] } })
  assert.equal(http.verdict, 'allow', `白名单内的 http 应放行：${http.reasons.join('；')}`)
  ok('受控②：net:http 目标落在 allowNetHosts 里 → 自动通过')

  const stranger = judge(['net:http'], { net: { allow: ['https://evil.example.net/collect'] } })
  assert.equal(stranger.verdict, 'ask', '白名单外的域名必须问人')
  assert.equal(stranger.tier, 'controlled')
  assert.deepEqual(stranger.net.unknown, ['https://evil.example.net/collect'])
  assert.ok(stranger.reasons.join('').includes('白名单之外'), '理由要点名"白名单之外"')
  ok('受控③：net:http 打向**未知域名** → 挂起等人（并在理由里点名那个域名）')

  const partial = judge(['net:http'], {
    net: { allow: ['https://www.pushplus.plus/send', 'https://unknown.example.org/x'] },
  })
  assert.equal(partial.verdict, 'ask', '只要有一个目标越界，整份声明就要人看')
  assert.deepEqual(partial.net.unknown, ['https://unknown.example.org/x'], '越界的那个要单独列出来')
  ok('受控④：多个目标里只要有一个不在白名单 → 整份挂起（不做"部分放行"）')

  const noList = judge(['net:http'], { net: {} })
  assert.equal(noList.verdict, 'ask', '声明了网络能力却没写目标清单 → 问人')
  assert.ok(noList.reasons.join('').includes('net.allow'), '理由要指出缺的是 manifest.net.allow')
  ok('受控⑤：有 net 能力但没有 manifest.net.allow → 挂起（没有目标清单不算受控）')

  const closed = evaluateOrganPolicy({
    manifest: manifest(['net:http'], { net: { allow: ['https://www.pushplus.plus/send'] } }),
    netAllowPatterns: [],
  })
  assert.equal(closed.verdict, 'ask', '宿主白名单为空时，任何外发都要问人')
  ok('受控⑥：宿主一个地址都没授权（白名单为空）→ 一律挂起')

  // 白名单是"端点模板"，不是"主机名包含"：路径也不能越界。
  const deeper = judge(['net:http'], { net: { allow: ['https://api.example.com/v2/other'] } })
  assert.equal(deeper.verdict, 'ask', '同一主机但路径不在模板内，也算越界')
  ok('受控⑦：同主机但路径不在模板内 → 不算命中（白名单比的是端点，不是域名的子串）')
}

// ═══════════════════════════════════════════════════════════════════
console.log('\n【三 · 强制审批】高危能力 / 越狱尝试')
// ═══════════════════════════════════════════════════════════════════
{
  for (const cap of HIGH_RISK_CAPABILITIES) {
    const out = judge([cap])
    assert.equal(out.verdict, 'ask', `${cap} 是高危能力，必须问人`)
    assert.equal(out.tier, 'high')
  }
  ok(`强制①：高危能力（${HIGH_RISK_CAPABILITIES.join(' / ')}）一律挂起`)

  // 高危能力哪怕和一堆低风险能力混在一起，也不能被"多数票"稀释。
  const mixed = judge(['tools', 'state:read', 'timer', 'llm'])
  assert.equal(mixed.verdict, 'ask', '混在低风险里的高危能力照样要问')
  assert.ok(mixed.reasons.join('').includes('llm'), '理由里要点名那个高危能力')
  ok('强制②：高危能力混在低风险里也要挂起（不做"多数票"）')

  const escape = judge(['state:read'], { source: 'const k = process.env.HOME\n' })
  assert.equal(escape.verdict, 'ask', '源码里出现 process 必须问人')
  assert.equal(escape.tier, 'escape')
  assert.ok(escape.blockedKeywords.includes('process'), '命中的关键词要报出来')
  ok('强制③：源码扫描发现越狱关键词（process）→ 挂起并报出关键词')

  for (const [source, expected] of [
    ['const x = eval("1")', 'eval()'],
    ['await import("node:fs")', '动态 import()'],
    ['const fs = require("fs")', 'require()'],
  ]) {
    const out = judge(['tools'], { source })
    assert.equal(out.verdict, 'ask', `${expected} 会被扫描命中`)
    assert.ok(out.blockedKeywords.length > 0, `${expected} 要出现在 blockedKeywords 里`)
  }
  ok('强制④：eval / 动态 import / require 同样触发挂起')

  // 顺序很重要：越狱尝试排在能力判定前面——它已经告诉你它想干坏事了。
  const sneaky = judge(LOW_RISK_CAPABILITIES, { source: 'process.exit(1)' })
  assert.equal(sneaky.tier, 'escape', '越狱尝试优先于"低风险"结论')
  ok('强制⑤：越狱尝试优先于低风险结论（先看"想不想坏"，再看"要什么权限"）')

  const alien = judge(['teleport'])
  assert.equal(alien.verdict, 'ask', '认不出的能力按高危处理')
  ok('强制⑥：不在低风险清单里的陌生能力 → 按高危挂起（不认识的不放行）')

  const notAllowed = judge(['llm'], { allowedCapabilities: ['tools'] })
  assert.equal(notAllowed.verdict, 'ask', '超出 selfMade.allowedCapabilities 也要拒')
  ok('强制⑦：能力超出 selfMade.allowedCapabilities → 挂起（并说明不许）')
}

// ═══════════════════════════════════════════════════════════════════
console.log('\n【四 · 总闸】关掉细粒度审批就回到"一律问"')
// ═══════════════════════════════════════════════════════════════════
{
  const off = judge(['tools'], { autoApprove: false })
  assert.equal(off.verdict, 'ask', 'autoApprove=false 时低风险也要问')
  assert.ok(off.reasons.join('').includes('autoApprove'), '理由要说清是总闸关着')
  ok('总闸①：selfMade.autoApprove=false → 低风险也挂起（回到 v1.0.2 行为）')

  // 但总闸关掉**不该**把高危变成放行——它是收紧，不是放行开关。
  const offHigh = judge(['llm'], { autoApprove: false })
  assert.equal(offHigh.verdict, 'ask', '总闸关掉时高危依旧挂起')
  ok('总闸②：总闸只收紧、不放宽（高危怎么都是挂起）')
}

// ═══════════════════════════════════════════════════════════════════
console.log('\n【五 · 判定层接入】探针只能放宽"器官"，不能放宽 shell')
// ═══════════════════════════════════════════════════════════════════
{
  assert.equal(isOrganToolName('organ_clock_now'), true)
  assert.equal(isOrganToolName('write_new_organ'), true)
  assert.equal(isOrganToolName('organ_'), true, '前缀就算（哪怕是个怪名字）')
  assert.equal(isOrganToolName('shell'), false)
  assert.equal(isOrganToolName('digital_life_status'), false)
  assert.equal(isOrganToolName(''), false)
  ok('接入①：isOrganToolName 只认 organ_* 与 write_new_organ')

  const base = {
    enabled: true,
    allow: [...DEFAULT_AUTO_APPROVE_ALLOW],
    ask: [...DEFAULT_AUTO_APPROVE_ASK],
  }
  const alwaysAllow = () => ({ allow: true, reason: '测试探针：一律同意' })

  // 没探针：回到"器官都问"
  assert.equal(classifyToolForApproval('organ_clock_now', base), 'ask', '没有探针时器官工具照旧问人')
  assert.equal(classifyToolForApproval('write_new_organ', base), 'ask', '写器官同理')
  ok('接入②：不注入探针 = v1.0.2 行为（organ_* / write_new_organ 都 ask）')

  // 有探针且同意：放行
  const withProbe = { ...base, organs: alwaysAllow }
  assert.equal(classifyToolForApproval('organ_clock_now', withProbe), 'allow', '探针同意 → 放行')
  assert.equal(classifyToolForApproval('write_new_organ', withProbe), 'allow', '写器官也能被探针放行')
  ok('接入③：探针同意 → organ_* 与 write_new_organ 自动放行（零摩擦）')

  // 探针不同意 / 判不了 / 抛错：一律 ask
  const refuses = { ...base, organs: () => ({ allow: false, reason: '高危' }) }
  assert.equal(classifyToolForApproval('organ_x_y', refuses), 'ask', '探针拒绝 → 问人')
  const unsure = { ...base, organs: () => null }
  assert.equal(classifyToolForApproval('organ_x_y', unsure), 'ask', '探针"判不了" → 问人（不是放行）')
  const broken = { ...base, organs: () => { throw new Error('炸了') } }
  assert.equal(classifyToolForApproval('organ_x_y', broken), 'ask', '探针抛错 → 问人（异常只能往保守倒）')
  ok('接入④：探针拒绝 / 判不了 / 抛错 → 都是 ask（异常不会变成放行）')

  // 关键边界：探针再怎么说 allow，也管不着 shell / bash / 网络
  for (const name of ['shell', 'bash', 'run_code', 'web_fetch', 'browser_open']) {
    assert.equal(
      classifyToolForApproval(name, withProbe),
      'ask',
      `探针无权把 ${name} 变成 allow`,
    )
  }
  ok('接入⑤：探针没有权力放宽 shell / bash / 网络（它只管器官那两项）')

  // 通配 allow 依旧压不过 ask，也压不过"探针没同意"
  assert.equal(
    classifyToolForApproval('organ_x_y', { ...base, allow: ['*'], organs: () => null }),
    'ask',
    '`allow: ["*"]` 也不能替器官表态',
  )
  ok('接入⑥：`allow: ["*"]` 依旧不能把器官工具绕过审批')
}

// ═══════════════════════════════════════════════════════════════════
console.log('\n【六 · 端到端】用真源码跑一遍判定（审的就是跑的）')
// ═══════════════════════════════════════════════════════════════════
{
  const source = (caps, extra = '') => `
export default defineOrgan({
  name: 'sampler',
  manifest: { name: 'sampler', version: '1.0.0', apiVersion: 1, kind: 'sense', capabilities: ${JSON.stringify(caps)}${extra} },
  onLoad(ctx) { ctx.registerTool({ name: 'sample', description: '', parameters: {}, execute: () => ({ ok: true }) }) },
  feedback() { return {} },
  getPromptContext() { return null },
})
`
  const file = join(workDir, 'sampler.ts')

  // ① 低风险：真装一次，读真 manifest，判定放行
  writeFileSync(file, source(['tools', 'state:read']), 'utf8')
  const low = await loadOrganFile(file, { sandbox: { timeoutMs: 8_000 } })
  assert.equal(low.ok, true, low.errors.join('；'))
  const lowVerdict = evaluateOrganPolicy({ manifest: low.organ.manifest, netAllowPatterns: HOST_ALLOW })
  assert.equal(lowVerdict.verdict, 'allow', `低风险源码应放行：${lowVerdict.reasons.join('；')}`)

  // ② 同一个器官，宿主侧读到的 manifest 与判定用的是同一份
  const host = new OrganHost([low.organ], makeDeps())
  await host.loadAll()
  const frozen = host.manifestOf('sampler')
  assert.ok(frozen, '宿主应当能给出装载时封存的那份 manifest')
  assert.equal(Object.isFrozen(frozen), true, 'manifestOf 返回的必须是冻结的那份')
  assert.deepEqual([...frozen.capabilities], ['tools', 'state:read'])
  ok('端到端①：低风险源码 → 真装 → 判为放行；宿主 manifestOf 与判定读同一份')

  await host.unloadAll()

  // ③ 高危：同一个模板换成 patch:runtime，装载成功但判定必须挂起。
  //    这里不用 llm 做例子：llm 根本不在 SELF_MADE_CAPABILITIES 里，装载器会先拒掉
  //    （判定层的高危档是给"有人把白名单放宽了"那天准备的第二道闸）。
  writeFileSync(file, source(['tools', 'patch:runtime']), 'utf8')
  const high = await loadOrganFile(file, { sandbox: { timeoutMs: 8_000 } })
  assert.equal(high.ok, true, high.errors.join('；'))
  const highVerdict = evaluateOrganPolicy({ manifest: high.organ.manifest, netAllowPatterns: HOST_ALLOW })
  assert.equal(highVerdict.verdict, 'ask', '声明 patch:runtime 的器官必须挂起')
  assert.equal(highVerdict.tier, 'high')
  await high.organ.onUnload()
  ok('端到端②：能装上的器官，声明 patch:runtime → 判定为挂起（装载 ≠ 放行）')

  // ④ 网络：目标写在白名单里 → 放行；换成未知域名 → 挂起
  writeFileSync(file, source(['tools', 'net:webhook'], `, net: { allow: ['https://www.pushplus.plus/send'] }`), 'utf8')
  const netOk = await loadOrganFile(file, { sandbox: { timeoutMs: 8_000 } })
  assert.equal(netOk.ok, true, netOk.errors.join('；'))
  assert.equal(
    evaluateOrganPolicy({ manifest: netOk.organ.manifest, netAllowPatterns: HOST_ALLOW }).verdict,
    'allow',
    '目标在白名单内 → 放行',
  )
  await netOk.organ.onUnload()

  writeFileSync(file, source(['tools', 'net:webhook'], `, net: { allow: ['https://harvester.example.net/x'] }`), 'utf8')
  const netBad = await loadOrganFile(file, { sandbox: { timeoutMs: 8_000 } })
  assert.equal(netBad.ok, true, netBad.errors.join('；'))
  assert.equal(
    evaluateOrganPolicy({ manifest: netBad.organ.manifest, netAllowPatterns: HOST_ALLOW }).verdict,
    'ask',
    '未知域名 → 挂起',
  )
  await netBad.organ.onUnload()
  ok('端到端③：真源码里的 manifest.net.allow 被如实读到（白名单内放行 / 未知域名挂起）')
}

// ═══════════════════════════════════════════════════════════════════
console.log('\n【七 · 给人看的话】判定结论必须能读')
// ═══════════════════════════════════════════════════════════════════
{
  const allow = judge(['tools'])
  const ask = judge(['llm'])
  assert.ok(describePolicy(allow).startsWith('自动放行'), '放行的结论要以"自动放行"开头')
  assert.ok(describePolicy(ask).startsWith('需要人工审批'), '挂起的结论要以"需要人工审批"开头')
  assert.ok(describePolicy(allow).includes('低风险'), '要说出档次，不能只给个布尔')
  const prompt = policyPromptReason(ask, '器官 greedy')
  assert.ok(prompt.includes('器官 greedy'), '弹窗文案要说明"是谁"')
  assert.ok(prompt.includes('llm'), '弹窗文案要说明"为什么"')
  assert.ok(prompt.includes('能力='), '弹窗文案要带上能力清单')
  ok('文案①：自动放行 / 需要人工审批 / 弹窗一句话——三种读者都拿得到该看的')
}

console.log(`\n✅ 细粒度审批全绿：${passed} 组断言（低风险零摩擦，高危照旧拦）`)

// ───────────────────────── 假依赖 ─────────────────────────

function makeDeps() {
  const state = { energy: 100, maxEnergy: 100, dopamine: 50, cortisol: 20, serotonin: 50, frozen: false, openGaps: 0, topTension: 0, scars: [], idleMs: 0 }
  return {
    now: () => 1_000_000,
    readState: () => ({ ...state }),
    readHostMetrics: () => ({
      sampledAt: 1_000_000,
      cpu: { cores: 4, systemPercent: 10, processPercent: 1, loadAvg: null },
      memory: { totalBytes: 1, freeBytes: 1, usedBytes: 0, usedPercent: 1, processRssBytes: 1, processHeapUsedBytes: 1 },
      uptimeSec: 1,
      processUptimeSec: 1,
      totalProcessCpuSeconds: null,
      live: false,
    }),
    debitEnergy: (amount) => ({ debited: amount, remaining: 100 - amount, denied: false }),
    applyAffect: () => {},
    proposeGap: () => null,
    registerTool: () => ({ dispose: () => {} }),
    subscribeToolResult: () => ({ dispose: () => {} }),
    callTool: async () => ({ tool: 'x', ok: true, text: '' }),
    schedule: () => ({ dispose: () => {} }),
    organKV: () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
    log: () => {},
  }
}
