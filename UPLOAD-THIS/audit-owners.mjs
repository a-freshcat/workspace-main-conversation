/**
 * 工作区目录归属审计 —— 主对话用的只读检查器。
 *
 * 用途：列出工作区下每个目录的「归属会话」，并标出**没有归属标记**的孤儿目录。
 *
 * 用法：
 *   node audit-owners.mjs "<工作区路径>"
 *
 * 归属怎么判定（按可信度从高到低）：
 *   1. 目录里的 `.session-id` 文件（规范做法，session-namespace skill 用的就是这个）
 *   2. README.md / OWNER.md 里出现的第一个 `session-<uuid>`
 *   3. 以上都没有 ⇒ `null`（孤儿目录，需要主对话补标记）
 *
 * ⚠️ 只读，不修改任何文件。
 */
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const SESSION_RE = /session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/

function readOwner(dir) {
  // 1) .session-id
  const sid = join(dir, '.session-id')
  if (existsSync(sid)) {
    try {
      const v = readFileSync(sid, 'utf8').trim()
      if (SESSION_RE.test(v)) return { source: '.session-id', id: v.match(SESSION_RE)[0] }
    } catch { }
  }
  // 2) README / OWNER
  for (const name of ['OWNER.md', 'README.md', 'MANIFEST.md']) {
    const f = join(dir, name)
    if (!existsSync(f)) continue
    try {
      const t = readFileSync(f, 'utf8')
      const m = t.match(SESSION_RE)
      if (m) return { source: name, id: m[0] }
    } catch { }
  }
  return null
}

const ws = process.argv[2]
// 参数错误时用 exitCode（不是 process.exit），保证 stderr 先刷完再退出；
// 并且必须立刻停止后续逻辑 —— 否则下面 readdirSync(undefined) 会崩。
if (!ws || !existsSync(ws)) {
  console.error(!ws
    ? '用法: node audit-owners.mjs "<工作区路径>"'
    : '工作区不存在: ' + ws)
  process.exitCode = 2
} else {
  main(ws)
}

function main(ws) {

const rows = []
for (const e of readdirSync(ws, { withFileTypes: true })) {
  if (!e.isDirectory()) continue
  if (e.name.startsWith('.')) continue
  const p = join(ws, e.name)
  const o = readOwner(p)
  let newest = 0
  try {
    for (const f of readdirSync(p, { withFileTypes: true })) {
      if (!f.isFile()) continue
      try { newest = Math.max(newest, statSync(join(p, f.name)).mtimeMs) } catch { }
    }
  } catch { }
  rows.push({ name: e.name, owner: o, mtime: newest })
}

rows.sort((a, b) => a.name.localeCompare(b.name))

const W = 34
console.log('\n目录'.padEnd(W) + '归属会话'.padEnd(48) + '来源')
console.log('-'.repeat(W + 48 + 14))
let orphans = 0
for (const r of rows) {
  const id = r.owner ? r.owner.id : '（无 —— 孤儿目录）'
  const src = r.owner ? r.owner.source : '—'
  if (!r.owner) orphans++
  console.log(r.name.padEnd(W) + id.padEnd(48) + src)
}

console.log('')
console.log(`共 ${rows.length} 个目录，其中 ${orphans} 个没有归属标记`)
if (orphans > 0) {
  console.log('\n建议：给上面这些目录各写一个 `.session-id`（内容 = 创建它那个对话的 id）。')
  console.log('主对话负责补；补之前先用会话记录反查真实归属，别凭目录名猜。')
  process.exitCode = 1
}

} // end main()
