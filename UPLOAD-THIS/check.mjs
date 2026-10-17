/**
 * 主对话的一键巡检 —— 每次接到「到你了」就跑这个。
 *
 * 用法：
 *   node check.mjs "<工作区路径>"
 *
 * 做四件事（全部只读，不改任何文件）：
 *   ① 目录归属审计     —— 有孤儿目录就报
 *   ② 对话活跃度       —— 谁还在写、谁停了（判断台账是否过期）
 *   ③ 归属与目录交叉    —— 哪个对话占了多个目录、哪个目录没人认领
 *   ④ sum.md 是否过期   —— 对比台账里的「最后活动」和实际 mtime
 *
 * 退出码：0 = 无问题；1 = 有需要主对话处理的问题。
 */
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const SESSION_RE = /session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/
const DSH = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
const SESSIONS_ROOT = join(DSH, 'sessions')

const ws = process.argv[2]
// 参数错误时用 exitCode（不是 process.exit），保证 stderr 先刷完再退出；
// 并且必须立刻停止后续逻辑 —— 否则下面 readdirSync(undefined) 会崩。
if (!ws || !existsSync(ws)) {
  console.error(!ws
    ? '用法: node check.mjs "<工作区路径>"'
    : '工作区不存在: ' + ws)
  process.exitCode = 2
} else {
  main(ws)
}

function main(ws) {

const problems = []
const pad = (s, n) => String(s).padEnd(n)

/* ── ① 目录归属 ── */
function readOwner(dir) {
  const sid = join(dir, '.session-id')
  if (existsSync(sid)) {
    try {
      const v = readFileSync(sid, 'utf8').trim()
      const m = v.match(SESSION_RE)
      if (m) return { id: m[0], source: '.session-id' }
    } catch { }
  }
  for (const n of ['OWNER.md', 'README.md', 'MANIFEST.md']) {
    const f = join(dir, n)
    if (!existsSync(f)) continue
    try {
      const m = readFileSync(f, 'utf8').match(SESSION_RE)
      if (m) return { id: m[0], source: n }
    } catch { }
  }
  return null
}

const dirs = []
let newestAll = 0
for (const e of readdirSync(ws, { withFileTypes: true })) {
  if (!e.isDirectory() || e.name.startsWith('.')) continue
  const p = join(ws, e.name)
  const owner = readOwner(p)
  let newest = 0
  try {
    for (const f of readdirSync(p, { withFileTypes: true })) {
      if (!f.isFile()) continue
      try { newest = Math.max(newest, statSync(join(p, f.name)).mtimeMs) } catch { }
    }
  } catch { }
  newestAll = Math.max(newestAll, newest)
  dirs.push({ name: e.name, owner, mtime: newest })
}

console.log('\n========== ① 目录归属 ==========\n')
console.log(pad('目录', 34) + pad('归属会话', 46) + '来源')
console.log('-'.repeat(34 + 46 + 12))
for (const d of dirs) {
  const id = d.owner ? d.owner.id : '（孤儿 —— 无人认领）'
  const src = d.owner ? d.owner.source : '—'
  if (!d.owner) problems.push(`孤儿目录：${d.name} 没有 .session-id`)
  console.log(pad(d.name, 34) + pad(id, 46) + src)
}

/* ── ② 一个对话占几个目录 ── */
console.log('\n========== ② 对话 → 目录 ==========\n')
const byOwner = new Map()
for (const d of dirs) {
  if (!d.owner) continue
  if (!byOwner.has(d.owner.id)) byOwner.set(d.owner.id, [])
  byOwner.get(d.owner.id).push(d.name)
}
for (const [id, list] of [...byOwner.entries()].sort()) {
  console.log(`  ${id}`)
  console.log(`     → ${list.join(', ')}${list.length > 1 ? `   (${list.length} 个目录)` : ''}`)
}
console.log(`\n  ${dirs.length} 个目录 / ${byOwner.size} 个对话`)
if (dirs.length !== byOwner.size) {
  console.log('  ⓘ 目录数 ≠ 对话数是正常的：一个对话可以合法拥有多个目录。')
  console.log('    真正要警惕的是「孤儿目录」，不是数量差。')
}

/* ── ③ 活跃度 ── */
console.log('\n========== ③ 活跃度（判断台账是否过期）==========\n')
const now = Date.now()
const rows = dirs.slice().sort((a, b) => b.mtime - a.mtime)
for (const d of rows) {
  const mins = Math.round((now - d.mtime) / 60000)
  const tag = mins <= 10 ? '🔥 刚在写' : mins <= 60 ? '⏳ 一小时内' : '💤 已停'
  console.log(`  ${pad(d.name, 34)} ${pad(String(mins) + ' 分钟前', 14)} ${tag}`)
}

/* ── ④ sum.md 是否过期 ── */
console.log('\n========== ④ sum.md 时效 ==========\n')
const sum = join(ws, 'sum.md')
if (!existsSync(sum)) {
  console.log('  ⚠️ 没有 sum.md（如果这是新工作区，主对话应当建一份）')
  problems.push('缺少 sum.md')
} else {
  const sumM = statSync(sum).mtimeMs
  const stale = newestAll > sumM + 60_000
  console.log(`  sum.md 改于 ${new Date(sumM).toLocaleString()}`)
  console.log(`  目录最新写入 ${new Date(newestAll).toLocaleString()}`)
  if (stale) {
    console.log('  ⚠️ 有目录在 sum.md 之后又被写过 —— 台账可能过期，建议更新')
    problems.push('sum.md 落后于目录实际活动')
  } else {
    console.log('  ✅ sum.md 不比任何目录旧')
  }
}

/* ── 汇总 ── */
console.log('\n========== 汇总 ==========\n')
if (problems.length === 0) {
  console.log('  ✅ 全部通过：无孤儿目录、台账未过期')
  process.exitCode = 0
} else {
  console.log('  需要主对话处理：')
  for (const p of problems) console.log('    • ' + p)
  process.exitCode = 1
}

} // end main()
