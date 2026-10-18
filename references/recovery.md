# 会话检查与任务恢复

删除应用里的子对话不会修改工作区任务。`planned/doing/blocked` 仍占用共享写入资源；`done/cancelled` 才释放。产物目录保留历史归属，不因取消而变为可任意认领。

## 检查线索

主对话运行 `context` 时，CLI 若得到 `DSH_HOME`，就检查该目录下的 `sessions/`；只有 `DSH_SESSION_ID` 时使用用户目录的 `.dsh`。也可显式指定，优先于环境：

```text
node scripts/workspace.mjs context --workspace WORKSPACE --session MAIN_SESSION --sessions-home DSH_HOME
node scripts/workspace.mjs session-check --workspace WORKSPACE --session MAIN_SESSION --sessions-home DSH_HOME --limit 5
```

只检查未完成任务的子对话 owner；最多遍历 10000 个目录项，仅看目录名与日志文件类型，不解析聊天正文。不读取 settings.yaml。`session-check` 逐 owner 分页，`context` 只把异常放进 alerts，结果参与 `--since` 的变化比较。子对话不扫描其他 owner。

- `record_present`：本地记录存在，不能证明会话仍在运行或仍显示在应用里。
- `owner_record_missing` / `record_missing`：完整扫描中未找到记录，需要用户或平台会话列表核实；不等于已删除。
- `session_check_incomplete` / `unverified`：记录根不可用、链接、扫描期间变化或达到上限；不能据此宣告 owner 丢失。
- `sessionCheck.status=not-configured`：未配置记录源。Codex 等非 DSH 环境可用当前平台列会话工具核实，或以用户明确告知为依据。

检查仅在命令执行时发生，不监听删除事件。应用若保留已删会话的日志，也可能仍显示 `record_present`。发现异常只提示核实，不自动取消、转交或删文件。

## 用户确认后恢复

先 `detail --task ID` 取得当前 owner 和 rev。用户确认原对话已删除或不可恢复，并明确取消任务或指定接手对话后，由当前主对话执行：

```text
node scripts/workspace.mjs recover-task --workspace WORKSPACE --session MAIN_SESSION --task TASK_ID --from OLD_SESSION --expect-rev REV --action cancel --confirm-unavailable --reason "用户确认原对话已删除，取消遗留任务"
node scripts/workspace.mjs recover-task --workspace WORKSPACE --session MAIN_SESSION --task TASK_ID --from OLD_SESSION --expect-rev REV --action reassign --to NEW_SESSION --confirm-unavailable --reason "用户确认原对话不可恢复，并指定新对话接手"
```

同一次用户确认可覆盖其明确指定的多项任务，逐项执行时不用重复询问。`--confirm-unavailable` 记录该确认，不由“日志缺失”推导。

- 只允许当前主对话操作，且 `--from`、`--expect-rev` 必须与记录一致；普通子对话仍不能改别人的任务。
- `cancel` 把未完成任务改成 `cancelled`，保留 owner、目录标记和全部文件，只释放共享写入占用。文件本身丢失或归属异常仍由 `check` 报告。
- `reassign` 在原任务上转交 owner 与 `.session-id`，保留目录、写入清单、目标和证据。原 `doing/planned` 变为 `planned`；原 `blocked` 保持阻塞。旧 owner 不能继续更新，新 owner 按新 rev 接手。
- 若有未结束的归拢计划，先用 `scripts/organize.mjs detail` 检查；主对话可用 `cancel --plan PLAN_ID --expect-rev REV --session MAIN_SESSION` 取消，已复制文件保留。若报 `PARTIAL_MOVE`，先核对并恢复已开始移除源文件的计划，不跳过证据直接换 owner。
- `handoff` 仍只交接主对话；不用于转交子任务。

## 中断与审计

每次成功恢复增加一次任务 rev，命令返回 `.workspace/recoveries/TASK_ID-r新版本号.json` 的审计路径，记录操作人、原因及恢复前后快照。审计独立保存，不增加任务输入字段；日常简报只显示任务变化。对话使用的脚本应统一更新后再恢复任务；同一工作区的命令串行执行，遇到 `BUSY` 等另一命令结束后再重试。

写入前保存 `.workspace/recovery-pending.json`。中断时主对话简报报告 `recovery_pending`，登记、归拢和主对话交接暂停，避免在两份归属状态间继续写入。续做：

```text
node scripts/workspace.mjs recover-task --workspace WORKSPACE --session MAIN_SESSION --resume pending
```

续做会核对任务和标记仍等于恢复前或恢复后的快照；任何额外变化都保留现场并报 `RECOVERY_CHANGED`。完成后重复 `--resume RECOVERY_ID` 返回完成状态，不再次增加 rev。进程崩溃若遗留 `.write-lock`，核对记录中的 PID，确认该写入进程已结束后才能清理陈旧锁再续做；不凭时间长短删除活动锁。
