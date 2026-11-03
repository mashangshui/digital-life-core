/**
 * 脉冲图上该画哪几条线（v0.9.19）。
 *
 * 放在 `.mjs` 里而不是组件里的两个理由：
 *   1. 它是纯函数，要能被 `test/smoke.mjs` 直接 import 测（组件是 TSX，测不到）；
 *   2. 桥与前端共用同一份判定，不会两边算出不同的线。
 */

/** 出厂三件套的兜底色。老桥的快照没有 chemicals 全表时用它。 */
const LEGACY_COLORS = {
  dopamine: '#f59e0b',
  cortisol: '#fb7185',
  serotonin: '#7da2ff',
}

const ENERGY_COLOR = '#38bdf8'

/**
 * 老桥（还没升 v0.9.19）推来的快照没有 chemicals 全表。
 * 这时候按老样子画三件套——宁可显示三条旧线，也不要显示一个空图。
 */
function fallbackChemicals(soma) {
  return [
    { id: 'dopamine', label: '多巴胺', value: soma.dopamine, max: 100, runtime: false, color: LEGACY_COLORS.dopamine },
    { id: 'cortisol', label: '皮质醇', value: soma.cortisol, max: 100, runtime: false, color: LEGACY_COLORS.cortisol },
    { id: 'serotonin', label: '血清素', value: soma.serotonin ?? 50, max: 100, runtime: false, color: LEGACY_COLORS.serotonin },
  ]
}

/**
 * 这一瞬间图上该画哪几条线。
 *
 * 以前前端这里是写死的四行常量（能量 + 出厂三件套）。她造出催产素以后，
 * 图上一根新线都没有——她的身体里多了一种东西，仪表盘却当没发生过。
 *
 * 现在遍历 `snapshot.chemicals`：她造出第五种激素的那一刻，图上自己多一条线，
 * 不需要任何人回来改前端。颜色来自基因组的 `ui.color`，自造的由桥按 id 推一个。
 */
export function pulseSeries(chemicals, soma) {
  const list = Array.isArray(chemicals) && chemicals.length > 0 ? chemicals : fallbackChemicals(soma ?? {})
  return [
    // 能量单独一条：它的满值是 maxEnergy，不是 100。
    { key: 'energy', label: '能量', color: ENERGY_COLOR, max: Number(soma?.maxEnergy) || 100 },
    ...list.map((item) => ({
      key: item.id,
      label: item.label,
      color: item.color,
      max: Number(item.max) || 100,
      runtime: item.runtime === true,
    })),
  ]
}

/**
 * 从一次采样里取出某条线的值。
 *
 * 两条路都要通：新桥按 id 递一张全表（她自造的激素只有这条路），
 * 老桥只有能量与出厂三件套的具名字段。取不到就返回 null——
 * 调用方会跳过那条线，而不是画一条趴在 0 上的假线（那是伪造数据）。
 */
export function seriesValue(sample, key) {
  const fromTable = sample?.chemicals?.[key]
  if (typeof fromTable === 'number' && Number.isFinite(fromTable)) return fromTable
  const legacy = sample?.[key]
  return typeof legacy === 'number' && Number.isFinite(legacy) ? legacy : null
}
