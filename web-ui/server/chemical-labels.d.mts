/**
 * 激素中文名字典的类型声明。
 *
 * 数据本体在 `chemical-labels.mjs`（桥与前端共用的那份）；
 * TypeScript 只认 .d.ts 声明，所以这里单独给出形状。
 */
export const CHEMICAL_LABELS: Record<string, string>

/**
 * 一个激素该怎么称呼：**她起的名字 > 字典 > id**。
 * 把 id 抄了一遍的 label 视为"没名字"。
 */
export function chemicalLabel(id: string, label?: string | null): string
