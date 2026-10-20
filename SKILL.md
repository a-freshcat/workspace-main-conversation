---
name: workspace-main-conversation
description: 管理共享工作区的对话分工、文件归属与认领归拢；进入已启用的工作区、共享写入或整理散落产物时使用。
---

# 工作区协作 v2.5.0

目标：用少量状态支持协作，细节按需读取。具体任务分工以用户指派为准。脚本路径相对本 skill 目录；工作区参数用绝对路径。适用于 Codex 和 DSH。

## 进入或恢复

先解析当前对话身份，再运行 `node scripts/workspace.mjs context --workspace WORKSPACE --session SESSION`。
DSH 使用运行时提供的 `DSH_SESSION_ID`；Codex 使用当前任务的 Codex thread ID，并传 `codex:<threadId>`。
未启用时继续用户原任务；用户明确指定本对话为主对话时执行 `init`，不要再要求重复授权。
用户同时要求创建本对话目录时，`init` 成功后立即登记当前任务；`task` 会创建目录并写入归属标记。
新上下文先取完整简报；同一上下文后续传上次完整处理过的 `--since STAMP`，只读变化。
`scope=declared-metadata` 只检查登记信息；它不证明源文件未变。

**取 SESSION：**在 DSH 中用 DSH 提供的 `pwsh` 环境；CLI 可从 `DSH_SESSION_ID` 自动取值。不要从 bash 查找该变量，也不要为了查它另开 PowerShell。
在 Codex 中使用 Codex 当前任务的 thread ID，并显式传 `--session codex:<threadId>`；可用 Codex 任务上下文或应用任务工具确认当前 ID，不要按标题或最近活动猜其他对话。
只有当前平台确实没有提供当前对话 ID 时，才请求用户提供；不能用 `unknown` 执行登记、认领或 `init`。`role=unknown` 是身份未解析的诊断，不代表没有任务。

## 执行

- `role=main`：默认负责统筹登记任务、审查冲突与重复劳动；阶段结束用 `summary` 生成根目录的 `AGENTS.md`。具体执行任务听从使用者指派，不按 bug 大小预设分工。
- `role=child`：按使用者指派执行任务，只维护自己的任务记录和产物；需要上下文时优先 `detail --task ID`。
- 接任务、状态变化、结果交接时用 `task --file INPUT.json` 登记；字段和命令见 [命令参考](references/commands.md)。普通回复无需改台账。
- 用户明确要求创建本对话自己的文件夹时，把当前指派登记为本对话任务，设置独立 `id` 与 `directory`，并通过 `task` 创建目录；不要只运行 `init` 后结束。
- 共享写入前先登记 `writes`；认领冲突则串行交接。`check` 核对已登记路径，编辑前重读目标文件。
- `context` 报 `undeclaredCount` 时说明有没被任何任务声明的文件，值得跑一次 `audit` 盘点（只读）。未声明文件不是错误，不会让 `check` 失败；公共项目文件属于项目基线，不要因为未声明就搬进个人目录。
- 产物目录默认平铺在根目录，名字用任务 id，不加前缀不套容器。需要集中到容器才用 `init --artifacts NAME` 或 `move-artifacts`（仅主对话）。
- 主对话可以搬动或修正任何任务的**位置与写入声明**（需 `--reason`，会记进 `lastActor`/`lastReason`），但不能改别人的目标与状态；内容始终归 owner。
- `AGENTS.md` 由主对话脚本生成，会被 agent 在进入本目录时自动读入；它属于产物而非手写文档，不要编辑或在末尾追加内容，改了下次 `summary` 会覆盖。子对话更新各自记录，相同内容不增加任务版本。
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
