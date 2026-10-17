---
name: workspace-main-conversation
description: 管理共享工作区的对话分工、产物归属与共享文件认领；进入已启用的工作区、准备共享写入或交接任务时使用。
---

# 工作区协作 v2

目标：用少量状态支持协作，细节按需读取。脚本路径相对本 skill 目录；工作区参数用绝对路径。适用于 Codex 和 DSH。

## 进入或恢复

运行 `node scripts/workspace.mjs context --workspace WORKSPACE --session SESSION`。
SESSION 使用运行环境给出的当前对话 id；不可获取时保留 unknown，不猜身份、不认领。
未启用时继续用户原任务；只有用户明确指定主对话并启用管理时才执行 `init`。
新上下文先取完整简报；同一上下文后续传上次完整处理过的 `--since STAMP`，只读变化。
`scope=declared-metadata` 只检查登记信息；它不证明源文件未变或未登记对话不存在。

## 执行

- `role=main`：汇总登记任务，处理 alerts；阶段结束用 `summary` 生成 `sum.md`。
- `role=child`：只维护自己的任务记录和产物；需要上下文时优先 `detail --task ID`。
- 接任务、状态变化、结果交接时用 `task --file INPUT.json` 登记；字段和命令见 [命令参考](references/commands.md)。普通回复无需改台账。
- 共享写入前先登记 `writes`；认领冲突则串行交接。`check` 核对已登记路径，编辑前重读目标文件。
- `sum.md` 由主对话脚本生成；子对话更新各自记录。相同内容不增加任务版本。

## 信息不足时

`more=true` 用同一 `--since` 和 `--offset NEXT` 读完相关页，再保存 stamp。
unknown、扫描不完整或解析错误都保留为问题；详细文件检查用 `check --offset N`。
历史归属或 DSH 日志取证才读 [迁移与取证](references/migration.md)；日常不加载完整日志、历史台账或脚本源码。
只依赖当下可用的状态；接管主对话用显式 `handoff`。文件时间不代表对话是否运行。
这些记录协调合作，不替代工具权限，也不阻止未遵守约定的外部写入。
