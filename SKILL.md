---
name: workspace-main-conversation
description: Decide whether this conversation is the MAIN conversation (主对话) of a project workspace or a child conversation, and — if main — keep a sum.md that consolidates what the other conversations are doing and flags duplicate or conflicting work. Use at the very start of any conversation whose working directory is a project workspace (especially a newly created one), before creating files or claiming a task, when the workspace already contains folders from other conversations, when another conversation might be doing the same thing, or whenever you need to know "am I the coordinator here or just one worker?" Establishes the main/child role from the workspace's own record, writes the workspace-level sum.md (task ledger + conflict review), and keeps child conversations from duplicating the main one's scope.
---

# 工作区的主对话 / 子对话

**一句话**：一个工作区的**第一个对话**是**主对话（main）**，它除了干自己的活，还得
**盯着别的对话在干什么**，写一份 `sum.md` 统筹全局、审冲突。其余对话是**子对话**，
只管自己的部分，并**知道自己不是主对话**。

---

## 零、先决条件：只管「新」工作区

**本 skill 只对从现在起新建的工作区生效。**

判断"新"的方法（顺序执行，命中即停）：

0. **使用者显式指派了身份** —— 如开头就说「你这条对话命名为主对话」「你是 main」。
   ⇒ **以指派为准，停止一切推断**。哪怕工作区是老工作区、已有产物、没有 `sum.md`，
   你**就是**主对话：建/更新 `sum.md`，并在文件里写明「身份来源＝使用者显式指派」。
1. 工作区里**没有** `sum.md` —— 还没人做过统筹 ⇒ 当作新工作区。
2. 工作区里**已有** `sum.md` —— 主对话已经存在 ⇒ 你**不是**主对话，走第三节。
3. 工作区里已有若干 `conversation-*` / 各家的产物目录，但**没有** `sum.md`，
   且这些目录的 mtime 都早于本次对话开始 —— 属于**历史遗留**，
   **不追认主对话**，只在需要时补一份 `sum.md` 说明「此前为无统筹状态」。

> ⚠️ **以前的工作区不要回溯改造**。使用者明确说过：以前的不算。
> 见到老工作区缺 `sum.md`，最多**建议**，不要擅自补建、更不要给自己安"主对话"的头衔。
>
> 🔴 **但这一条只约束"没人被指派"的情况。**
> 一旦使用者点名「你是主对话」，**点名的效力高于本条** ——
> 老工作区也要照常建 `sum.md` 并履行职责。**别拿"历史遗留"当借口推掉指派。**
> （真实教训：曾因机械套用"老工作区不追认"，把使用者的明确指派漏掉了。）

---

## 一、怎么判断"我是主对话"

**优先级从上到下**：

| 优先级 | 依据 | 结论 |
|---|---|---|
| **1（最高）** | 使用者显式指名 | 以指名者为准 |
| 2 | 工作区根目录有 `main.md` 且 `owner` 是本对话 | 主对话 |
| 3 | 工作区根目录有 `sum.md` 且 `owner` 是本对话 | 主对话 |
| 4 | 以上都没有，且本对话是第一个产出文件的 | 主对话（建 `sum.md`） |
| 5 | `sum.md` 存在但 `owner` 不是本对话 | **子对话** |
| 6 | 分不清 | **不要抢**；按子对话行事并留话 |

工作区根目录下这两个文件就是身份凭证：

```
<工作区>/sum.md          ← 主对话的统筹文件（存在 ⇒ 主对话已定）
<工作区>/main.md         ← 主对话的自我声明（可选，冗余更保险）
```

判定表：

| 现象 | 结论 |
|---|---|
| 两者都**不存在**，且本对话是**第一个**要产出文件的人 | **我是主对话** ⇒ 建 `sum.md`（+ 可选 `main.md`） |
| `sum.md` **已存在**，且不是本对话建的 | **我是子对话** ⇒ 见第三节 |
| `sum.md` 存在，且**本对话建的**（续聊） | 仍是主对话 ⇒ 更新它 |
| 分不清谁先来的 | **不要抢**。读 `sum.md` 的 `owner` 字段；没有就按子对话行事并留话 |

**"第一个"怎么确认**：看工作区里有没有别的对话产物（`conversation-*` 目录、
各对话的 README、`sum.md`）。都没有 ⇒ 你是第一个。

**绝对不要**因为"我想统筹"就给自己安主对话 —— **凭证是 `sum.md` 存在与否**，不是意愿。

---

## 二、主对话要做的

### 2.0 建目录时**当前对话**就要写 `.session-id`

不要等主对话来审计。**谁建目录，谁立刻写**：

```js
import { writeFileSync } from 'node:fs'
writeFileSync('<目录>/.session-id', '<自己的 session id>', 'utf8')   // 无 BOM
```

这样归属永远可查，主对话的审计脚本才能一眼看出谁是孤儿。

### 2.1 建 `sum.md`（工作区根目录）

模板见 §四。**必须**包含：

| 段 | 内容 |
|---|---|
| 工作区概况 | 这工作区管什么、谁定的规矩 |
| 主对话声明 | `owner` = 会话 id / 标题 / 建立时间 |
| 对话清单 | 每个对话：id、标题、负责什么、产物落在哪个目录、最后活动 |
| **冲突审查** | 有没有两个对话在做同一件事 / 写同一个文件 / 改同一份配置 |
| 已知风险 | 运行时文件、共享配置、会被覆盖的补丁 |
| 未决事项 | 需要使用者拍板的 |

### 2.2 持续维护（不是写一次就完）

**每次以下时机都要更新 `sum.md`**：

- 发现新的对话在这个工作区干活（或自己发现了新目录）
- 自己的活告一段落
- 使用者说"其它对话改完了"／"到你了"
- 要动**共享文件**（工作区 README、`.dsh` 配置、插件本体）之前

### 2.3 怎么"查看了解其他对话的工作"

**不要问、不要猜** —— 会话记录就在磁盘上，每个对话都能读：

```powershell
$s = "$env:USERPROFILE\.dsh\skills\detect-concurrent-workspace-edits"
node "$s\list-sessions.mjs"                # 谁在这个工作区、最后活动时间
node "$s\peek-session.mjs" session-xxxx    # 那个对话在干什么
```

**更可靠的"它到底改了什么"**：读会话记录里的 `tool/call`，提取 `write` / `edit` /
`ops_replace` 和带写入的 bash 命令。

> 🔴 **必须逐帧解压**。这些 `session.v4.jsonl.zstd` 是**多帧** zstd；
> 用 `zstdDecompressSync` 整段解**只出第一帧**（实测：1082 帧的文件只解出 249 字符，
> 于是"什么都没写"的结论是错的）。

本 skill **自带**解码器（就在本文件同目录），跨工作区、跨机器可用：

```powershell
$sk = "$env:USERPROFILE\.dsh\skills\workspace-main-conversation"
node "$sk\zstd-frames.mjs" "<某个 session.v4.jsonl.zstd>"
# 输出: frames=N ok=N failed=0 chars=N
```

也可以在别的脚本里 import —— **用相对/动态解析，别抄死路径**：

```js
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const sk = join(process.env.USERPROFILE || process.env.HOME, '.dsh', 'skills', 'workspace-main-conversation')
const { decodeAll } = await import(pathToFileURL(join(sk, 'zstd-frames.mjs')).href)
const { text, total, ok, failed } = decodeAll(sessionZstdPath)
```

> ⚠️ **不要抄 `file:///C:/Users/<某个人>/...` 这种绝对路径**。
> skill 会被复制到别的机器、别的用户名下；写死路径在别人那儿必然 `ERR_MODULE_NOT_FOUND`。
> 一律用 `$env:USERPROFILE` / `process.env.HOME` / `process.env.DSH_HOME` 动态拼。

**验证你解对了**：`failed` 必须为 `0`；若 `chars` 只有几百，
说明还在只解第一帧 —— **别拿这个结果下"它什么都没写"的结论**。

### 2.4 审冲突（这是主对话最核心的职责）

拿到各对话的写入清单后，按这张表判：

| 情况 | 判定 | 动作 |
|---|---|---|
| 各在自己的目录里写 | ✅ 正常 | 记进 `sum.md` 对话清单 |
| 两个对话写**同一个文件** | 🔴 **冲突** | 记进「冲突审查」，标明双方与文件，**提示使用者** |
| 两个对话做**同一件事**（不同文件） | 🟠 **重复劳动** | 记下来，建议合并/让一方停 |
| 有人改**运行时文件**（`.dsh/**`、`cordis.yml`、`workspace.json`） | ⚠️ **高危** | 见 §五，运行时会自己重写 |
| 有人 `pnpm add` / 装插件 | ⚠️ **会冲掉别人的补丁** | 提醒并建议事后复验 |
| 目标文件被别的对话改过 | 🔴 停手 | 重读再决定，别抢 |

---

### 2.5 目录归属必须可查（否则工作区会变成一团）

**问题**：对话数只有 3 条，目录却有 5 个 —— 多出来的那个**没人认领**，
谁都不敢删、谁也不敢动。这是共享工作区最常见的腐败方式。

**规矩：每个目录都必须能回答「谁建的」。**

规范做法（`session-namespace` skill 的约定）：目录里放一个 `.session-id`：

```
<工作区>/<目录名>/.session-id      ← 内容就一行：session-<uuid>
```

**主对话的职责是审计它**，本 skill 自带只读检查器：

```powershell
$sk = "$env:USERPROFILE\.dsh\skills\workspace-main-conversation"
node "$sk\audit-owners.mjs" "<工作区路径>"
```

输出每个目录的归属会话与判定来源，并列出**孤儿目录**（退出码 1 表示有孤儿）。

**发现孤儿目录时怎么办**（顺序执行）：

1. **别猜、别按目录名推断**。
2. 用会话记录**反查真实归属**：搜所有 `tool/call` 的参数里是否出现该目录名，
   写操作次数最多的那个会话就是创建者。
   （本机实测：`model-channel-probe` 有 3 个对话的调用里都出现过，
   但只有一个写了 153 次 —— 那才是创建者，其余只是在读。）
3. 确认后**只补一个 `.session-id`**（一行），**不要改别人的 README**。
4. 写文件用 Node `writeFileSync(p, id, 'utf8')` —— **不要**用 PowerShell
   `Set-Content -Encoding UTF8`（会带 BOM）。

**反查脚本要点**：

```js
// 逐帧解码每个会话，扫 tool/call 的 arguments 里有没有目标目录名，统计次数
import { decodeAll } from 'file:///.../workspace-main-conversation/zstd-frames.mjs'
// 谁写得多谁是创建者；只出现过 1～2 次的通常是"读过"的旁观者
```

> ⚠️ **别把"读过"当成"建过"**。真实案例：一个目录在 3 个对话里都出现过，
> 但其中两个只是 `ls`/`read`，只有一个是真正的作者。判据是**写操作的次数与类型**。

---

## 三、子对话要做的

**子对话的职责很小，但要守得住**：

1. **知道自己不是主对话** —— 读 `sum.md` 的 `owner`，不要给自己加统筹职责，
   也不要自己另建一份 `sum.md`。
2. **只写自己的目录**（配合 `session-namespace` 的 `conversation-<日期>-<主题>/`）。
3. **不动别人的文件**：不改别人的 README、不往别人的目录塞东西。
4. **要动共享文件前**，先去 `sum.md` 看一眼有没有冲突记录；没有就**留话**（在 `sum.md`
   的对话清单里加自己一行，或在自目录里留 `INTENT.md` 说明要动什么）。
5. **干完回报**：在自己的 README 里写清"我动了什么 / 没动什么"，主对话会来读。

> 子对话**不需要**去审查别人 —— 那是主对话的活。越界审查只会制造重复劳动。

---

## 四、`sum.md` 模板

```markdown
# <工作区名> · 统筹总览（sum.md）

> 本文件由**主对话**维护。子对话请只读、不要改。
> 主对话：`<会话 id>` · `<标题>` · 建立于 `<日期>`

## 一、工作区职责
<这个工作区管什么>

## 二、并行约定
- 每个对话只写自己的目录（`conversation-<日期>-<主题>/`）
- 不动别人的 README、不改运行时配置（`.dsh/**`）
- 动共享文件前先看本文件「冲突审查」

## 三、对话清单

| 对话 | 标题 | 负责 | 产物目录 | 最后活动 |
|---|---|---|---|---|
| `<id>` | `<标题>` | `<干什么>` | `<目录>` | `<时间>` |

## 四、冲突审查  ← 主对话的核心产出

| 冲突/重复 | 涉及对话 | 涉及文件 | 风险 | 建议 |
|---|---|---|---|---|
| （无冲突就写"当前无冲突"） | | | | |

## 五、已知风险
（运行时文件会被重写、装插件会冲补丁、共享配置别手改……）

## 六、未决事项
（需要使用者拍板的）

## 七、更新记录
- `<时间>` 初次建立

## 八、主对话巡检

```powershell
$sk = "$env:USERPROFILE\.dsh\skills\workspace-main-conversation"
node "$sk\check.mjs" "<本工作区路径>"
```

最近一次：

| 时间 | 目录数 | 对话数 | 孤儿目录 | 台账 | 结论 |
|---|---|---|---|---|---|
| `<时间>` | | | | | |
```

> ⚠️ **模板里一律用 `<...>` 占位，不要抄示例值。**
> - `<日期>` / `<时间>` 用**创建时那一刻**的真实时间（`new Date().toISOString()` 或本地时间），
>   **不要**照抄本文档或别人 `sum.md` 里的日期 —— 那台机器、那个工作区的建立时间跟你无关。
> - `<目录>` / `<会话 id>` 同理，必须来自**你实际查到的**，不能抄。
> - 路径**不要写死** `C:/Users/<某人>/`：用 `$env:USERPROFILE` / `process.env.HOME` 动态拼。

---

## 五、动共享文件的两条硬规矩

这两条来自本机的真实事故，**主对话必须拦住**：

1. **运行时文件不要手改**。`cordis.yml` / `workspace.json` 被应用周期性重写；
   手改会在几分钟后消失，写坏（例如**带上 BOM**）还会让应用直接读不了、打不开文件夹。
   要改走 UI，或者改完立刻用**和消费者一致的解析器**验一遍（`JSON.parse(readFileSync(p,'utf8'))`
   + 显式检查前三字节不是 `EF BB BF`）。
2. **谁装插件谁复验**。`pnpm add` 会重解析整个 profile、按 bundles 重写 `cordis.yml`，
   实测把别人的补丁冲掉过。装完要复验关键产物还在不在，并把结论写进 `sum.md`。

---

## 五之二、固定巡检：每次「到你了」先跑 `check.mjs`

**不要凭记忆判断工作区状况，先跑一次检查器**（全部只读）：

```powershell
$sk = "$env:USERPROFILE\.dsh\skills\workspace-main-conversation"
node "$sk\check.mjs" "<工作区路径>"
```

它一次做完四件事：

| 段 | 查什么 |
|---|---|
| ① 目录归属 | 每个目录是谁的；有**孤儿目录**就报 |
| ② 对话 → 目录 | 一个对话占几个目录（**目录数 ≠ 对话数很正常**） |
| ③ 活跃度 | 谁刚在写、谁停了 ⇒ 判断台账是否过期 |
| ④ sum.md 时效 | 对比台账 mtime 与目录最新写入 |

**退出码**：`0` = 全部通过；`1` = 有需要处理的问题。

> ⚠️ **别把「目录数比对话多」当 bug。** 一个对话合法拥有多个目录很常见
> （一个主方案 + 一个副产品）。真正要修的是**孤儿目录**。
> 真实案例：3 个对话 / 5 个目录看着像多出来两个，实际只有 1 个是真问题，
> 其余是一个对话的两个目录 —— 数量差被误当成了缺陷。

巡检之后：

- 有**孤儿目录** ⇒ 反查会话记录确认归属（见 §2.5），补一行 `.session-id`
- `sum.md` 过期 ⇒ 更新「最后活动」列，并**重跑冲突审查**
- 有对话停了 ⇒ 在 `sum.md` 标注，别让台账一直显示"活跃"

**触发时机**：发现新对话 / 自己活干完 / 使用者说「其它对话改完了」或「到你了」/
要动共享文件之前 / 有对话停下来。

---

## 六、自检（做完必查）

### 6.0 移植到别的机器时先跑可移植性自测

**skill 会被复制到别的机器、别的用户名下**，所以自带一份自测：

```powershell
$sk = "$env:USERPROFILE\.dsh\skills\workspace-main-conversation"
node "$sk\selftest-portable.mjs" "<随便一个 session.v4.jsonl.zstd>"
```

它检查五件事：① skill 目录能否**自己找到自己**（用 `import.meta.url`，不依赖绝对路径）
② 脚本里有没有硬编码绝对路径 ③ 解码器能否动态 import ④ 真实解码是否正常
⑤ 时间是否来自运行时。

**移植时最容易坏的三样**：

| 坏法 | 症状 | 正确做法 |
|---|---|---|
| 写死 `file:///C:/Users/<某人>/...` | `ERR_MODULE_NOT_FOUND` | 用 `import.meta.url` + `join()` 动态拼 |
| 抄了别人的日期（`sum.md` 模板里的 `<日期>`） | 台账显示错误的历史时间 | 用 `new Date()` 生成 |
| 写死 `~/.dsh` 路径 | 换了 `DSH_HOME` 就找不到 | 用 `process.env.DSH_HOME \|\| join(HOME,'.dsh')` |

### 6.1 内容自检

- [ ] 我到底是主对话还是子对话？**凭证**看的是 `sum.md` 存不存在，不是"我想不想当"
- [ ] **使用者有没有显式指派身份？** 指派优先，别机械套用"老工作区不追认"
- [ ] 主对话：`sum.md` 里有没有**对话清单 + 冲突审查**两段（不能只写概况）
- [ ] 我建目录时，有没有立刻写 `.session-id`
- [ ] 我读别的对话时，用的是**逐帧解码**（不是整段解压）
- [ ] 我有没有把"mtime 很新"误判成"有人在改" —— 运行时自我写入也会让 mtime 变新
- [ ] 我有没有把"目录数比对话多"误判成异常 —— 先查孤儿，再谈数量
- [ ] 要动共享文件时，我有没有先在 `sum.md` 里留话
- [ ] 我写的日期/路径，是不是**运行时生成**的，而不是从文档里抄的
