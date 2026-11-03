#!/usr/bin/env node
/**
 * 一次性数据清理：把历史遗留的「被排版污染的缺口」洗干净，并合并同义条目。
 *
 * 为什么会需要它：
 *   v0.7.2 之前，模型把 `digital_life_gaps` 的渲染结果贴回回答里时，
 *   `○ [80] …`、`| gap-id | … |`、`**加粗**` 甚至箭头旁白会被整行抓成执念摘要。
 *   新代码只保证"以后不再产生"，已经写进 state.json 的脏数据不会自己变干净。
 *
 * 安全设计：
 *   - 默认 **dry-run**，只打印将要做什么，不写任何文件
 *   - `--apply` 才执行，且先备份为 state.before-clean.json
 *   - 只动 `status = open` 的条目；已闭合的历史一条不碰
 *   - 洗不出人话的条目 → 只做 `resolved`（停止注入），不删除
 *
 * 用法：
 *   node scripts/clean-gaps.mjs                # 试运行，看计划
 *   node scripts/clean-gaps.mjs --apply        # 真正执行
 *   node scripts/clean-gaps.mjs --state <路径>  # 指定其它状态文件
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { stripMarkdown, textSimilarity } from '../lib/index.js'

const argv = process.argv.slice(2)
const apply = argv.includes('--apply')
const stateIndex = argv.indexOf('--state')
const statePath = stateIndex >= 0 && argv[stateIndex + 1]
  ? argv[stateIndex + 1]
  : join(homedir(), '.dsh', 'digital-life-core', 'state.json')

if (!existsSync(statePath)) {
  console.error(`找不到状态文件：${statePath}`)
  process.exit(1)
}

const THRESHOLD = Number(process.env.DLC_DEDUPE ?? 0.6)
const state = JSON.parse(readFileSync(statePath, 'utf8'))
const gaps = Array.isArray(state.gaps) ? state.gaps : []
const open = gaps.filter((gap) => gap.status === 'open')

/** 洗完之后是否还有"人话"（与 index.ts 的 isMeaningful 保持一致）。 */
const meaningful = (text) => text.length >= 4 && text.replace(/[^\p{L}\p{N}]/gu, '').length >= 3

const renames = []      // { gap, from, to }
const junk = []         // 洗不出人话的条目
const merges = []       // { keep, drop }

const cleaned = new Map()
for (const gap of open) {
  const next = stripMarkdown(String(gap.summary ?? '')).slice(0, 100).trim()
  cleaned.set(gap.id, next)
  if (next === gap.summary) continue
  if (!meaningful(next)) junk.push({ gap, from: gap.summary, to: next })
  else renames.push({ gap, from: gap.summary, to: next })
}

// 合并：同义条目只留一条（保留 created_at 最早的那条，它的张力曲线最"真实"）
const alive = open
  .filter((gap) => !junk.some((item) => item.gap.id === gap.id))
  .map((gap) => ({ ...gap, summary: cleaned.get(gap.id) ?? gap.summary }))
  .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))

const dropped = new Set()
for (let i = 0; i < alive.length; i += 1) {
  if (dropped.has(alive[i].id)) continue
  for (let j = i + 1; j < alive.length; j += 1) {
    if (dropped.has(alive[j].id)) continue
    const score = textSimilarity(alive[i].summary, alive[j].summary)
    if (score >= THRESHOLD) {
      merges.push({ keep: alive[i], drop: alive[j], score })
      dropped.add(alive[j].id)
    }
  }
}

const line = (text) => console.log(text)
line(`状态文件：${statePath}`)
line(`open 缺口 ${open.length} 条；阈值 ${THRESHOLD}`)
if (renames.length === 0 && junk.length === 0 && merges.length === 0) {
  line('\n没有需要清理的条目 ✅')
  process.exit(0)
}

if (renames.length > 0) {
  line(`\n— 重洗排版（${renames.length}）—`)
  for (const item of renames) {
    line(`  改前：${item.from}`)
    line(`  改后：${item.to}`)
  }
}
if (junk.length > 0) {
  line(`\n— 洗不出人话 → 标记 resolved 停止注入（${junk.length}，条目不删）—`)
  for (const item of junk) line(`  ${item.gap.id}：${JSON.stringify(item.from)}`)
}
if (merges.length > 0) {
  line(`\n— 同义合并（${merges.length}）—`)
  for (const item of merges) {
    line(`  保留 ${item.keep.id}  ${item.keep.summary}`)
    line(`  并入 ${item.drop.id}  ${item.drop.summary}  （相似度 ${item.score.toFixed(2)}）`)
  }
}

if (!apply) {
  line('\n这是 dry-run，未写任何文件。确认后执行：node scripts/clean-gaps.mjs --apply')
  process.exit(0)
}

// ── 执行 ──────────────────────────────────────────────────────
const stamp = new Date().toISOString()
const bump = Number(state.dedupeTensionBump ?? 10)
const byId = new Map(gaps.map((gap) => [gap.id, gap]))

for (const item of renames) item.gap.summary = item.to
for (const item of junk) {
  item.gap.status = 'resolved'
  item.gap.resolved_at = stamp
  item.gap.tension = 0
}
for (const item of merges) {
  const keep = byId.get(item.keep.id)
  const drop = byId.get(item.drop.id)
  if (!keep || !drop) continue
  keep.relief = (keep.relief ?? 0) - bump
  keep.tension = Math.min(100, Math.max(0, (keep.tension ?? 0) + bump))
  drop.status = 'resolved'
  drop.resolved_at = stamp
  drop.tension = 0
}
state.updatedAt = stamp

const backup = statePath.replace(/\.json$/, '.before-clean.json')
copyFileSync(statePath, backup)
writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8')
line(`\n✅ 已写入。备份：${backup}`)
line(`重洗 ${renames.length} 条 / 停用 ${junk.length} 条 / 合并 ${merges.length} 条`)
