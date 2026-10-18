# v2.2.1 修订记录

此前 v2.2 的修订记录保留在下方「附：v2.2 修订记录」中。

## 缺陷

子对话在新工程调用本 skill 后，看起来「什么都没动」。

时间线（同一台机器，2026-10-18）：

| 时刻 | 子对话做了什么 |
|---|---|
| 21:24:18 | 用户直接调用 skill，内容已注入 |
| 21:24:26 | 运行 `env \| grep -i '^DSH'`，**结果为空** |
| 21:24:29 | 改用 `--session unknown` 跑 `context`，得到 `role=unknown`、0 个任务 |
| 21:24–21:29 | 按「身份不可得就保留 unknown、不猜身份」的规则，决定什么也不登记 |
| 21:29–21:55 | 为「猜出自己是谁」，翻 `list-sessions`/`peek-session`/缓存文件 |
| 21:55:57 | 才用真实 id 登记，rev 2 |

skill 被调用了、也正常工作了，但**第一步就空转半小时**。

## 两个根因（都是 skill 的问题，不是使用者或模型的问题）

### 1. bash 里没有 `DSH_*`，skill 却要求「从运行环境取 id」

`pwsh` 能看到 `DSH_SESSION_ID`，`ops_bash`/bash 一个都没有（实测 85 个环境变量，
0 个以 `DSH` 开头；`cmd.exe` 与 `node` 的 `process.env` 同样是空）。

这是执行器差异：`pwsh` 由 DSH 运行时注入这些变量，`dsh-ops` 的 bash IPC 层只拿到
一条 `PATH`。排查过 `dsh-ops/lib/bash-ipc.js` 与 `session-shells.js`，没有漏传的
bug 可修——是两条 shell 通路的既有差异。

但 skill 只写「SESSION 使用运行环境给出的当前对话 id」，没有说**哪个工具给**。
子对话在 bash 里查是合理选择，查到空也合理，于是只能填 `unknown`。

### 2. `role=unknown` 的输出和「一切正常」字节相同

```
$ node scripts/workspace.mjs context --workspace ... --session unknown
{"role":"unknown",...,"taskCount":0,"alerts":{"total":0,...},"tasks":{"total":0,...}}
```

`taskCount: 0` 对一个还没登记的对话**本来就是正常的**。skill 又规定
「不猜身份、不认领」，于是「照规则不动」和「无事可做」在输出上无法区分——
这正是 v2.2 修过的同一个坑（`tasks: 0` 无法区分「没干」与「干了很多没登记」），
只是换了个字段。

## 改了什么

### 1. `context` 在 `role=unknown` 时输出 `identity`

```json
{"role":"unknown","identity":{"status":"unknown","hint":"Pass the session id explicitly, or pick it up automatically by running this command under pwsh, where the DSH runtime exports DSH_SESSION_ID ($env:DSH_SESSION_ID). ops_bash/bash receives no DSH_* variables, so `env` there shows nothing. Until the id is known this view cannot tell your tasks from another conversation's, and nothing may be registered or claimed."},"taskCount":0}
```

字段只在坏的情况下出现，所以**它的存在本身就是信号**。身份正常时不含该字段。

### 2. CLI 用 `DSH_SESSION_ID` 兜底

`pwsh` 下不传 `--session` 也能识别身份。显式 `--session` 优先。

**兜底对所有需要身份的命令生效**，不只 `context`。否则会出现半修状态：子对话
看到 `role=child`（知道自己有归属），却因为手上没有 id 字符串而依然无法 `task` 登记
或认领——只是把空转的位置往后挪了一步。`task`/`summary`/`init`/`handoff` 一并覆盖。

**导出的 `execute()` 不读环境**，只有 CLI 入口读。否则在 `pwsh` 里跑测试套件时，
进程内的 `execute()` 会继承真实会话 id，`run(ws,'context').role === 'unknown'`
这类既有断言会随运行环境而变——测试必须与调用者身份无关。

### 3. `SKILL.md` 写明取 id 的正确工具

新增一段：`pwsh` 有 `DSH_SESSION_ID`，bash 没有；取不到时输出带 `identity`，
**不要当正常结果**，也不要去翻会话日志猜——先在 `pwsh` 重跑或问用户。

明确禁止复现这次绕路：原文只要求「不猜身份」，没说「猜不到时该怎么办」，
子对话于是把「猜」理解成可做的事。

### 4. 版本 v2.2 → v2.2.1

只修缺陷、不加功能，因此升补丁位。新增的 `identity` 字段对外可见，但它只在
`role=unknown` 这个本就不可用的状态下出现，不引入需要迁移的新语义；老调用方
读不到该字段，行为不变。

## 测试

新增 3 条，全量 73/73 通过：

```
✔ an unresolved identity is reported as a problem, not as an empty clean view
✔ the runtime session variable is used by the CLI, and never by in-process callers
✔ the session fallback also reaches mutating commands
```

第 2 条钉住三件事：CLI 兜底生效、显式 `--session` 优先、`execute()` 忽略环境。
第 3 条钉住「兜底不能只修 `context`」——用环境里的 id 真的 `task` 登记一次，
再确认任务归属于该 id。

三条都做了**变异验证**：分别去掉环境兜底、去掉 `identity` 输出、把兜底缩回只对
`context` 生效，对应测试各自失败（71 pass / 2 fail 等），恢复后回到 73/73。
不是写完就算通过。

## 没做的

- **没让 skill 自己去猜 id**。从会话日志、`mtime` 或缓存反推身份会引入错误归属，
  而归属错误比没有归属更难纠正。`SKILL.md` 里「文件时间不代表对话是否运行」这条
  不能被自己违反。
- **没改 `dsh-ops` 给 bash 补 `DSH_*`**。那是执行器语义变更，影响所有 bash 调用方，
  不该由一个 skill 的需求驱动；skill 侧写清差异即可。
- **没把 `identity` 做成错误**。`context` 在未启用工作区、或调用方只想窥探一眼时
  仍应成功返回；用字段而非抛错表达「没拿到身份」，才不会被当成命令失败去重试。

## 遗留

`DSH_SESSION_ID` 只保证在 `pwsh` 中存在。若将来 DSH 改了注入方式或改了变量名，
兜底会静默失效——但此时 `identity.status=unknown` 会显式报出来，不会被误读为正常。

---

## 附：v2.2 修订记录

本次修订保留版本号 v2.2，修复发布内容与用户确认规则之间的冲突，并清理公开样例中的真实会话资料。

### 功能变更

context 新增 unregistered，用于发现带有会话归属标记、但尚未登记任务的目录。

- 主对话可查看所有未登记归属；子对话只查看归属标记对应自己的项目。
- 扫描有目录深度、数量和文件数上限；结果不完整时继续标记为不完整。
- 检测只提供待登记线索，不替其他对话伪造任务记录。
- 该字段是协作提示，不是身份认证或操作系统权限。

### 职责规则

主对话默认负责统筹、维护工作区摘要、查看进展并审查冲突与重复劳动。具体执行任务听从使用者明确指派，不按 bug 大小预设分工。示例只展示合成工作区，不构成额外职责规则。

### 隐私处理

公开样例已改为合成会话名、任务与路径。开发过程中的会话标识、真实事项标题、活动记录和内部调试信息不纳入发布包。

### 验证记录

测试集合共 70 项。在本次 Windows 沙箱执行中，68 项通过；2 项链接防护测试因创建 junction 被系统以 EPERM 拒绝而跳过，未把跳过计为通过。portable 自测通过。

在允许创建 junction 的环境中，两个链接防护测试会照常执行原有断言。运行完整检查可使用 Node 24 的 node --test tests/*.test.mjs；受限 Windows 环境应检查输出中的 SKIP 原因，并在具备链接创建能力的环境补跑这两项。
