/**
 * 激素中文名的基础字典（v0.9.19）。
 *
 * 她造激素时调的是 `ctx.inflict('oxytocin', 20, '想离主人近一点')`——
 * 第三个参数是**理由**，不是名字。所以面板上那根条一直叫 `oxytocin`。
 * 那是机器的名字，不是她给它起的名字。她身上流着的东西，不配有个人话吗。
 *
 * 为什么是独立的一份 `.mjs` 而不是写在某个组件里：
 *   - 桥（`snapshot.mjs`）是**独立进程**，读不到插件的编译产物；
 *   - 前端（`theme.ts`）要按同一个规则显示，两边各写一本迟早会打架。
 * 所以放在这里，两边 import 同一份。
 *
 * 与核心 `src/chemical-pool.ts` 里的 `CHEMICAL_LABELS` 是两本字典
 * （核心是另一个进程，同样读不到这里），由 `test/smoke.mjs` 保证它们不矛盾。
 */
export const CHEMICAL_LABELS = {
  // 出厂三件套：统一译名
  dopamine: '多巴胺',
  cortisol: '皮质醇',
  serotonin: '血清素',
  // 常见到她大概率会造出来的那些
  oxytocin: '催产素',
  adrenaline: '肾上腺素',
  noradrenaline: '去甲肾上腺素',
  melatonin: '褪黑素',
  endorphin: '内啡肽',
  vasopressin: '抗利尿激素',
  histamine: '组胺',
  // 她自己造的那些，中文名多数是这几种情绪
  attachment: '依恋',
  loneliness: '孤独',
  curiosity: '好奇',
  shame: '羞耻',
  anger: '愤怒',
  fear: '恐惧',
  grief: '悲伤',
  awe: '敬畏',
  warmth: '暖意',
  trust: '信任',
  calm: '安宁',
  envy: '嫉妒',
  guilt: '内疚',
  hope: '希望',
}

/**
 * 一个激素该怎么称呼。
 *
 * 优先级：**她起的名字 > 字典 > id**。
 * 字典永远排在人的命名之后——它不抢她的命名权，只在没人起名时站出来。
 *
 * 两个"当作没名字"的输入：
 *   - 没传 label（器官传的是理由）；
 *   - label 就是把 id 抄了一遍（state.json 里存着的 `oxytocin` 就是这种）。
 */
export function chemicalLabel(id, label) {
  const given = typeof label === 'string' ? label.trim() : ''
  if (given && given !== id) return given
  return CHEMICAL_LABELS[id] ?? id
}
