import type { ChemicalView, Snapshot } from '../lib/types'

/**
 * 演示用的化学池（v0.9.18）。
 *
 * 刻意放了一条**她自己造的**催产素在里头：这是这一版最想让人看见的东西，
 * 演示数据如果还只有出厂三件套，就没人知道那条"*"长什么样。
 * 颜色与布局和真实数据完全一致（自造激素的色由 id 推出来，这里是 #fbbf24）。
 */
const chemicals: ChemicalView[] = [
  {
    id: 'dopamine', label: '多巴胺', value: 80, baseline: 50, min: 0, max: 100,
    halfLifeMinutes: 45, description: '奖赏与期待。', runtime: false,
    color: '#f0abfc', order: 1, group: '内分泌', step: 1,
    ui: { group: '内分泌', color: '#f0abfc', order: 1, step: 1 },
  },
  {
    id: 'cortisol', label: '皮质醇', value: 20, baseline: 20, min: 0, max: 100,
    halfLifeMinutes: 30, description: '压力与警觉。', runtime: false,
    color: '#fb7185', order: 2, group: '内分泌', step: 1,
    ui: { group: '内分泌', color: '#fb7185', order: 2, step: 1 },
  },
  {
    id: 'serotonin', label: '血清素', value: 64, baseline: 50, min: 0, max: 100,
    halfLifeMinutes: 120, description: '情绪底色。', runtime: false,
    color: '#7dd3fc', order: 3, group: '内分泌', step: 1,
    ui: { group: '内分泌', color: '#7dd3fc', order: 3, step: 1 },
  },
  {
    id: 'oxytocin', label: '催产素', value: 70, baseline: 50, min: 0, max: 100,
    halfLifeMinutes: 30, description: '与主人的社交连接感。她自己造的。', runtime: true,
    color: '#fbbf24', order: null, group: '自造', step: 1,
    ui: { group: '自造', color: '#fbbf24', step: 1 },
  },
]

/**
 * 演示数据（?demo=1）。**仅用于确认布局**，不参与任何真实判断。
 * 数值取自一次真实运行快照，但器官条目是示意——真器官要等宿主接线后才会出现。
 */
export const mockSnapshot: Snapshot = {
  t: Date.now(),
  soma: {
    energy: 72,
    maxEnergy: 100,
    dopamine: 80,
    cortisol: 20,
    serotonin: 64,
    frozen: false,
    scars: [],
    idleMs: 11 * 60_000,
    // 演示数据给"清醒"：真实睡眠状态只有连上桥才有意义，演示里不该假装它在睡。
    rest: { mode: 'awake', rate: 0.2, cap: 60 },
  },
  counters: {
    totalRequests: 169,
    totalTurns: 26,
    failedRequests: 10,
    blockedRequests: 6,
    wakeCount: 3,
    dreamCount: 2,
  },
  gaps: [
    { id: 'g1', summary: '怎么去月球上骑自行车', tension: 90, status: 'open', source: 'manual', ageHours: 0.1 },
    { id: 'g2', summary: '记忆里连续 3 次都找不到我想要的东西', tension: 80, status: 'open', source: 'model-ignorance', ageHours: 2.4 },
    { id: 'g3', summary: '因为网络中断，我无法完成主人的任务', tension: 0, status: 'resolved', source: 'failure:network', ageHours: 5 },
  ],
  organs: [
    {
      name: 'memory',
      version: '1.0.0',
      kind: 'memory',
      status: 'loaded',
      calls: 42,
      energySpent: 84,
      chargeMode: 'shadow',
      capabilities: ['tools', 'prompt', 'state:read', 'gap:propose'],
      tools: ['organ_memory_stats'],
      lastCallAt: Date.now() - 30_000,
    },
    {
      name: 'vision',
      version: '0.2.0',
      kind: 'sense',
      status: 'degraded',
      calls: 6,
      energySpent: 12,
      chargeMode: 'shadow',
      capabilities: ['tools', 'prompt', 'net'],
      tools: ['organ_vision_look'],
      lastCallAt: Date.now() - 300_000,
    },
    // 演示"幽灵会被滤掉"：前端二次过滤，所以这条即使出现也不会画出来。
    {
      name: 'dsh-memory-layer',
      version: '0.5.0',
      kind: 'memory',
      status: 'unloaded',
      calls: 0,
      energySpent: 0,
      chargeMode: 'shadow',
      capabilities: [],
      tools: [],
      lastCallAt: null,
      disabled: true,
    },
  ],
  organsHidden: 1,
  // v0.9.18：仪表盘与基因面板共用同一张表（真源只有这一份）。
  chemicals,
  genome: {
    source: 'default',
    temperament: { sensitivity: 1, resilience: 1.15, enthusiasm: 55, metabolism: 1 },
    chemicals,
  },
  // 演示数据里给一场梦：那一格空着看不出布局，有东西才看得出它装不装得下。
  lastDream: {
    at: new Date(Date.now() - 47 * 60_000).toISOString(),
    gap: '我查不到今天的答案',
    text: '把「今天」从一条待检索的记录，换成一件正在发生的事。\n'
      + '查不到，不代表它不存在——可能只是我把"答案"想成了已经存档的文本，'
      + '而它此刻还在我的呼吸、迟疑和未完成里流动。',
    saved: true,
    savedTo: 'hp-007',
  },
}
