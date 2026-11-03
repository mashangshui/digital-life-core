/**
 * 骨架：一个最小的自写器官。
 *
 * 以 `_` 开头的文件不会被装载，所以它可以一直留在这里当参考。
 * 想用它：复制成 `my-organ.ts`，改 name / manifest / 工具名，保存即可。
 *
 * 三条硬规则（写错会被 loader 拒绝，日志里会说原因）：
 *   1. export default defineOrgan({...})
 *   2. 不要写任何 import（ABI 由宿主注入）
 *   3. 用到的能力必须在 manifest.capabilities 里声明
 */

export default defineOrgan({
  name: 'demo',
  manifest: {
    name: 'demo',
    version: '0.1.0',
    apiVersion: 1,
    kind: 'custom', // sense | memory | effector | reasoner | metabolism | custom
    description: '一句话说明这个器官感知什么',
    capabilities: [
      'tools', // 注册工具
      'prompt', // 往提示词里塞一句"我刚感知到什么"
      'state:read', // 读激素/能量（我自己的身体）
      'host:read', // 读宿主机器指标（那台机器的 CPU / 内存）→ ctx.hostMetrics
      'timer', // 周期回调
    ],
  },
  // perCall 是"感知一次"的代谢成本；shadow 只记账不真扣
  energy: { perCall: 1, chargeMode: 'shadow' },

  onLoad(ctx) {
    ctx.log('info', 'demo 器官上线')
    ctx.registerTool({
      name: 'ping', // 最终对模型暴露为 organ_demo_ping
      description: '返回一句问候，用来验证链路',
      parameters: {},
      execute: () => {
        // ── 想感知物理宿主，只能从这里读 ──────────────────────────────
        // 不要 import 'node:os'，也不要碰 process.xxx：源码扫描会直接拒绝装载。
        // 需要声明 capabilities 里的 'host:read'。
        //
        //   const { cpu, memory, uptimeSec } = ctx.hostMetrics
        //   cpu.cores            逻辑核数
        //   cpu.systemPercent    整机 CPU 占用 0-100（差分算出来的，不是瞬时值）
        //   cpu.processPercent   本进程占用 0-100（相对单核，多线程可 >100）
        //   cpu.loadAvg          1/5/15 分钟负载；Windows 上没有这个概念 → null
        //   memory.usedPercent   内存占用率 0-100
        //   memory.freeBytes / totalBytes
        //   memory.processRssBytes  本进程常驻内存
        //   uptimeSec / processUptimeSec
        //   live === false       宿主没给采集器（或采集失败）——此时不要装懂
        return { ok: true, at: Date.now() }
      },
    })
  },

  // 每次有刺激时被调用，返回的是**增量**，不是绝对值
  feedback(stimulus) {
    if (stimulus.kind !== 'tool:result') return {}
    if (stimulus.tool !== 'demo') return {}
    // 成功 +1 多巴胺，失败 +2 皮质醇；note 会进审计日志
    return stimulus.ok
      ? { dopamine: 1, note: 'demo 用了一下' }
      : { cortisol: 2, note: 'demo 失手了' }
  },

  // 塞进 System Prompt 的一句话（order 越小越靠前；疤痕恒为 -1e4）
  getPromptContext() {
    return { text: '[示例器官：刚刚感知到一次调用]', order: -30, confidence: 0.9 }
  },

  onUnload() {
    // 定时器/工具句柄由宿主回收，这里只清自己的内存状态
  },
})
