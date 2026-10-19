---
name: workspace-main-conversation
description: 管理共享工作区的对话分工、文件归属与认领归拢；进入已启用的工作区、共享写入或整理散落产物时使用。
---

# 工作区协作 v2.3.3

目标：用少量状态支持协作，细节按需读取。具体任务分工以用户指派为准。脚本路径相对本 skill 目录；工作区参数用绝对路径。适用于 Codex 和 DSH。

## 进入或恢复

运行 `node scripts/workspace.mjs context --workspace WORKSPACE --session SESSION`。
SESSION 使用运行环境给出的当前对话 id；不可获取时保留 unknown，不猜身份、不认领。
未启用时继续用户原任务；只有用户明确指定主对话并启用管理时才执行 `init`。
新上下文先取完整简报；同一上下文后续传上次完整处理过的 `--since STAMP`，只读变化。
`scope=declared-metadata` 只检查登记信息；它不证明源文件未变。

**取 SESSION：`pwsh` 里有 `DSH_SESSION_ID`，`ops_bash`/bash 里没有任何 `DSH_*`。**
用 bash 跑 `env` 找 id 一定是空的——那是执行器的差异，不是你不在会话里。
CLI 会自己读 `DSH_SESSION_ID` 兜底，所以在 `pwsh` 下不传 `--session` 也能识别身份。
已启用的工作区仍取不到时 `role=unknown`，输出会带 `identity.status=unknown` 与原因，**不要把它当正常结果**：
此时什么都登记不了，也不要为了拿到 id 去翻会话日志或猜。先在 `pwsh` 下重跑一次、
或让用户把 id 告诉你，再继续。

## 执行

- `role=main`：默认负责统筹登记任务、审查冲突与重复劳动；阶段结束用 `summary` 生成 `sum.md`。具体执行任务听从使用者指派，不按 bug 大小预设分工。
- `role=child`：按使用者指派执行任务，只维护自己的任务记录和产物；需要上下文时优先 `detail --task ID`。
- 接任务、状态变化、结果交接时用 `task --file INPUT.json` 登记；字段和命令见 [命令参考](references/commands.md)。普通回复无需改台账。
- 共享写入前先登记 `writes`；认领冲突则串行交接。`check` 核对已登记路径，编辑前重读目标文件。
- `sum.md` 由主对话脚本生成；子对话更新各自记录。相同内容不增加任务版本。
- 主对话重新分派前看 `sessionCheck` 与 alerts；出现 `owner_record_missing`、用户告知子对话已删除，或需要接管遗留任务时，读 [会话检查与任务恢复](references/recovery.md)。记录缺失只提示核实；用户确认原 owner 不可用后，主对话才能取消或转交已登记任务。

## 看到 unregistered 就要处理

`context` 返回 `unregistered` 时，说明工作区里有带 `.session-id` 归属标记、却没有登记任务
的目录。**这是本对话自己的事，不要留给用户提醒。**

- `role=child` 且 `unregistered` 有内容：其中 `owner` 等于本会话的那些就是你的产物。
  **先登记再继续干活**——写 [任务输入](references/commands.md)，`directory` 指到该目录，
  已有内容的目录按命令参考加 `--adopt`。不登记的话主对话看不见你，冲突审查也无从谈起。
  目录其实不是你的（标记被别处复制过等），就在回复里说明，不要默默忽略。
- `role=main`：`unregistered` 列出全部未登记归属，用它替代手工 `ls` 盘点。
  **不能替子对话登记**，只能把 `owner` 告知用户，或等该对话恢复时自行认领。

判据是 `.session-id` 标记，不是"目录存在"：`src/`、`docs/` 这类普通目录不会出现在
`unregistered` 里；名字相近或修改时间也不代表归属。扫描有上限（深度 4、50 个目录、
5000 文件），超出时结果不完整，仍要和 `ls` 对照。

## 信息不足时

`more=true` 用同一 `--since` 和 `--offset NEXT` 读完相关页，再保存 stamp。
unknown、扫描不完整或解析错误都保留为问题；详细文件检查用 `check --offset N`。
发现散落产物、归属不明或待认领 claims 时，读 [认领与归拢](references/organize.md)。
需要 DSH 日志线索时才读 [取证命令](references/forensics.md)；旧工作区启用见 [迁移](references/migration.md)。日常只读简报。
只依赖当下可用的状态；接管主对话用显式 `handoff`。文件时间不代表对话是否运行。
这些记录协调合作，不替代工具权限，也不阻止未遵守约定的外部写入。
