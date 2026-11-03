/** 一条脉冲线：画什么、什么颜色、按什么满值归一。 */
export interface PulseSeries {
  key: string
  label: string
  color: string
  /** 归一时用的满值：激素是各自的 max，能量是 maxEnergy。 */
  max: number
  /** true = 她自己造出来的激素（图例上标个记号）。 */
  runtime?: boolean
}

/** 老快照（没有 chemicals 全表）时的最小激素形状。 */
export interface MinimalChemical {
  id: string
  label: string
  value: number
  max: number
  runtime?: boolean
  color: string
}

/** 脉冲图的取样形状：只用到 t 与具名字段/全表，不依赖完整的 PulseSample。 */
export interface SeriesSample {
  t: number
  chemicals?: Record<string, number>
  [key: string]: unknown
}

export function pulseSeries(
  chemicals: MinimalChemical[] | undefined | null,
  soma: { maxEnergy?: number; dopamine?: number; cortisol?: number; serotonin?: number },
): PulseSeries[]

export function seriesValue(sample: SeriesSample | null | undefined, key: string): number | null
