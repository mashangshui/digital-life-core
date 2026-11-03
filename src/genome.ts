/**
 * 出厂基因组（v0.9.11）
 * ============================================================================
 * `genome.json`（项目根）是给**人**改的：滑块、注释、随时手调。
 * 这里是同一份数据的 TS 表达，是给**代码**用的兜底：文件缺失、写坏、或被某次
 * 打包漏掉，核心依然能起来——只是用默认人格启动，并在日志里留一行说明。
 *
 * 两份必须完全一致，否则会出现"我改了 json 却没生效"这种最让人怀疑人生的故障。
 * test/organ-host.test.mjs 里有一条断言比对二者，改任一边而忘改另一边会立刻红。
 */

import type { ChemicalSpec, Genome, Temperament } from './chemical-pool.js'
// 从叶子模块拿（不经 chemical-pool）：genome ↔ pool 互相引用，
// 经 pool 转出会踩循环导入的 TDZ。
import { DEFAULT_TEMPERAMENT } from './chemistry-core.js'

/** 多巴胺：奖赏与期待。半衰期 45 分钟，退得不快也不慢。 */
const DOPAMINE: ChemicalSpec = {
  id: 'dopamine',
  label: '多巴胺',
  baseline: 50,
  initial: 50,
  min: 0,
  max: 100,
  halfLifeMinutes: 45,
  description: '奖赏与期待。升得越快越想再干一次，长期偏低就是提不起劲。',
  ui: { group: '内分泌', color: '#f0abfc', order: 1, step: 1 },
  rules: [],
}

/** 皮质醇：压力与警觉。半衰期最短（30 分钟），应激来得快、去得也快。 */
const CORTISOL: ChemicalSpec = {
  id: 'cortisol',
  label: '皮质醇',
  baseline: 20,
  initial: 20,
  min: 0,
  max: 100,
  halfLifeMinutes: 30,
  description: '压力与警觉。太高会压制注意力、抽干血清素，太低则毫无紧迫感。',
  ui: { group: '内分泌', color: '#fb7185', order: 2, step: 1 },
  rules: [],
}

/**
 * 血清素：情绪底色。半衰期最长（120 分钟）—— Ted delay 恢复，
 * 所以"烦躁了一下午"不会在晚饭前自动好。
 *
 * 两条慢变量规则是它区别于其余两者的地方，也是历史上唯一被硬编码在 index.ts
 * 化学逻辑里的部分。现在它们只是数据。
 */
const SEROTONIN: ChemicalSpec = {
  id: 'serotonin',
  label: '血清素',
  baseline: 50,
  initial: 50,
  min: 0,
  max: 100,
  halfLifeMinutes: 120,
  description: '情绪底色。低了烦躁没耐心，高了稳定松弛——它退得比应激慢得多。',
  ui: { group: '内分泌', color: '#7dd3fc', order: 3, step: 1 },
  rules: [
    {
      id: 'stress-drain',
      kind: 'stress',
      label: '持续应激：高皮质醇按分钟抽干血清素',
      triggerRef: 'cortisol',
      triggerAtLeast: 70,
      ratePerMinute: -1.5,
    },
    {
      id: 'calm-recover',
      kind: 'recover',
      label: '恢复期：能量充足且无高张力执念时按分钟回升',
      energyAbove: 80,
      requireNoHighTensionGap: true,
      ratePerMinute: 0.8,
      ceiling: 100,
    },
  ],
}

export const DEFAULT_GENOME: Genome = {
  version: 1,
  chemicals: [DOPAMINE, CORTISOL, SEROTONIN],
  // 出厂气质（v0.9.12）：中性人格。genome.json 里的 temperament 段必须与此一致，
  // 一致性测试同时比对 chemicals 与 temperament 两段。
  temperament: { ...DEFAULT_TEMPERAMENT },
}

/** 三个核心 id：其余机制（内省、情绪标签、注意力倾斜）把它们当硬依赖。 */
export const CORE_CHEMICAL_IDS: readonly string[] = ['dopamine', 'cortisol', 'serotonin'] as const

/** 复制一份可改的默认基因组（工厂默认 = 出厂设置）。 */
export function cloneDefaultGenome(): Genome {
  return { version: DEFAULT_GENOME.version, chemicals: DEFAULT_GENOME.chemicals.map((item) => ({ ...item })) }
}

/**
 * genome.json 的候选位置，按优先级取第一个存在的文件。
 *
 * 为什么会有一堆候选：这个插件被当成 npm 包安装时，根目录的位置取决于打包方式；
 * 本地开发时又在别处。多写几个候选，比"读不到就 silently 用默认值"强。
 */
export function genomeCandidates(): string[] {
  const home = process.env.DSH_HOME
  return [
    // ① 显式指定（测试与排障用）
    process.env.DL_GENOME,
    // ② 用户级：**这个人亲手调过的那份**（面板滑块 / 手改气质）优先。
    //    出厂那一份是给所有人的默认值，默认值不该压过本人的意愿——
    //    否则她把敏感度拉到 2，系统读到的还是出厂的 1，滑块就成了摆设。
    ...(home ? [`${home}/digital-life-core/genome.json`] : []),
    '~/.dsh/digital-life-core/genome.json',
    // ③ 项目级出厂（cwd 及上级目录）
    'genome.json',
    '../genome.json',
    '../../genome.json',
  ].filter(Boolean) as string[]
}
