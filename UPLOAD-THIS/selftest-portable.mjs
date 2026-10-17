/**
 * 可移植性自测 —— 模拟「skill 被复制到别的机器 / 别的用户名下」。
 *
 * 做法：不写死任何绝对路径，只用 process.env + 相对解析定位 skill 目录，
 *       然后 import 自带解码器并跑一次真实会话文件。
 *
 * 用法：node selftest-portable.mjs [<某个 .zstd 文件>]
 * 退出码：0 全部通过 / 1 有问题
 */
import { pathToFileURL } from 'node:url'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readdirSync } from 'node:fs'

const problems = []
const ok = (m) => console.log('  ✅ ' + m)
const bad = (m) => { console.log('  ❌ ' + m); problems.push(m) }

// ① 定位 skill 目录：优先用本文件所在目录（最可移植），其次用环境变量拼
const here = dirname(fileURLToPath(import.meta.url))
console.log('\n========== ① skill 目录定位 ==========\n')
console.log('  本文件所在目录: ' + here)

const candidates = [
  here,
  join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'skills', 'workspace-main-conversation'),
  process.env.DSH_HOME ? join(process.env.DSH_HOME, 'skills', 'workspace-main-conversation') : '',
].filter(Boolean)

let skillDir = ''
for (const c of candidates) {
  if (existsSync(join(c, 'zstd-frames.mjs'))) { skillDir = c; break }
}
if (skillDir) ok('找到 skill 目录: ' + skillDir)
else bad('找不到 skill 目录（三处候选都试过了）')

// ② 检查有没有写死的绝对路径（.mjs 里不该出现）
console.log('\n========== ② 脚本内是否写死绝对路径 ==========\n')
let hardcoded = 0
for (const f of readdirSync(here)) {
  if (!f.endsWith('.mjs')) continue
  const t = (await import('node:fs')).readFileSync(join(here, f), 'utf8')
  // 匹配 C:/Users/xxx 或 C:\Users\xxx（排除注释里的示例说明不强求）
  const m = t.match(/["'`]([A-Za-z]:[\\/]Users[\\/][^"'`]+)["'`]/g)
  if (m) { console.log(`  ⚠️ ${f}: ${m.length} 处硬编码路径`); hardcoded += m.length }
}
if (hardcoded === 0) ok('脚本里没有硬编码的绝对路径')
else console.log(`  ⓘ ${hardcoded} 处（若只在注释/示例里可接受，在代码里则不可）`)

// ③ 动态 import 解码器（用 file URL，不用写死路径）
console.log('\n========== ③ 动态 import 解码器 ==========\n')
let decodeAll = null
try {
  const mod = await import(pathToFileURL(join(skillDir, 'zstd-frames.mjs')).href)
  decodeAll = mod.decodeAll
  if (typeof decodeAll === 'function') ok('import 成功，decodeAll 可用')
  else bad('decodeAll 不是函数')
} catch (e) {
  bad('import 失败: ' + e.message)
}

// ④ 真跑一次解码
console.log('\n========== ④ 真实解码验证 ==========\n')
const target = process.argv[2]
if (target && decodeAll) {
  if (!existsSync(target)) bad('指定的文件不存在: ' + target)
  else {
    const r = decodeAll(target)
    console.log(`  frames=${r.total} ok=${r.ok} failed=${r.failed} chars=${r.text.length}`)
    if (r.failed === 0 && r.text.length > 1000) ok('解码正常')
    else if (r.text.length <= 1000) bad('解出字符过少 —— 可能只解了第一帧')
    else bad(`${r.failed} 帧解码失败`)
  }
} else {
  console.log('  （跳过：没传文件路径）')
}

// ⑤ 时间不写死检查
console.log('\n========== ⑤ 时间是否来自运行时 ==========\n')
console.log('  本机当前时间: ' + new Date().toISOString())
console.log('  ⇒ 模板里的 <日期>/<时间> 应由 new Date() 生成，而不是从文档里抄')

console.log('\n========== 汇总 ==========\n')
if (problems.length === 0) { console.log('  ✅ 可移植性自测通过'); process.exitCode = 0 }
else { console.log('  需要修：'); problems.forEach((p) => console.log('    • ' + p)); process.exitCode = 1 }
