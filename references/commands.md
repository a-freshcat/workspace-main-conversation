# 命令参考

公共参数：`--workspace` 为已存在的工作区；修改操作的 `--session` 必须来自当前运行环境。只读的未知身份可用 `unknown`。参数值以实际值替换下文大写单词，路径有空格时加引号。Node 需具备 zstd API；核心协作不依赖 zstd 或外部 skill。

```text
node scripts/workspace.mjs init --workspace WORKSPACE --session SESSION
node scripts/workspace.mjs context --workspace WORKSPACE --session SESSION
node scripts/workspace.mjs context --workspace WORKSPACE --session SESSION --since STAMP
node scripts/workspace.mjs detail --workspace WORKSPACE --task ID
node scripts/workspace.mjs task --workspace WORKSPACE --session SESSION --file INPUT.json
node scripts/workspace.mjs task --workspace WORKSPACE --session SESSION --file INPUT.json --expect-rev REV
node scripts/workspace.mjs migrate --workspace WORKSPACE --session SESSION --task ID --to DIRECTORY --expect-rev REV
node scripts/workspace.mjs migrate --workspace WORKSPACE --session SESSION --task ID --to DIRECTORY --expect-rev REV --move-files
node scripts/workspace.mjs archive --workspace WORKSPACE --session SESSION --task ID --expect-rev REV --reason TEXT
node scripts/workspace.mjs audit --workspace WORKSPACE
node scripts/workspace.mjs audit --workspace WORKSPACE --scope root --limit N
node scripts/workspace.mjs check --workspace WORKSPACE
node scripts/workspace.mjs owners --workspace WORKSPACE
node scripts/workspace.mjs summary --workspace WORKSPACE --session SESSION
node scripts/workspace.mjs handoff --workspace WORKSPACE --session SESSION --to NEW_SESSION --expect-epoch EPOCH
node scripts/workspace.mjs session-check --workspace WORKSPACE --session MAIN_SESSION --sessions-home DSH_HOME
```

`init` 只在用户要求启用管理并指定主对话时调用。已有 v1 的 `sum.md` / `main.md` 时额外传 `--ack-legacy`，先读迁移参考；不会导入或猜测旧 owner。

任务输入是完整的当前快照，UTF-8 JSON：

```json
{
  "id": "fix-export",
  "goal": "修复导出结果缺少末行",
  "state": "doing",
  "directory": "conversation-2026-10-19-fix-export",
  "writes": ["src/export.mjs"],
  "next": "补回归样例并验证",
  "result": "",
  "evidence": []
}
```

state 可选 `planned/doing/blocked/done/cancelled`。前三者保留资源认领；完成/取消后释放。创建任务不传 expect-rev；更新必须传当前版本，其他对话不能覆盖。产物目录不可交叉；已有未标记非空目录须用 `--adopt`，且须用户明确确认该目录归属。不要把代码库根或公共源码目录当成个人产物目录。

产物目录**平铺在工作区根目录**，一个对话一个目录，用 `conversation-<日期>-<任务>` 这类可读名字，不要套 `conversations/` 之类的容器层——根目录是所有人 `ls` 就能看到的共同面，多一层只会把每个对话的目录推出视野，认领和冲突审查反而更难。省略 `directory` 时默认用 `conversation-<任务id>`，需要日期或自定义命名就显式写。

`task` 不接受在更新时静默改产物目录，`DIRECTORY_CHANGED` 会在 `details.migrate` 里给出可直接执行的 `migrate` 调用。`migrate` 只由任务 owner 对自己任务发起，需要 `--to` 和最新 `--expect-rev`。**目标目录的接管规则与 `task` 完全一致**：带别的对话 `.session-id` 标记的目录直接拒绝（`OWNER_MISMATCH`），未标记但非空的目录必须显式 `--adopt`（`ADOPTION_REQUIRED`）——`migrate` 不是绕过认领要求的途径。冲突按迁移后**实际会认领**的内容判定（目录 + 改写后的 writes），与活动任务重叠即拒绝且不写任何记录；终态任务已释放目录。迁移会同步改写 `writes` 里位于旧目录内的条目，使「认领整个目录」的声明跟着走；无关声明原样保留。默认只改登记，加 `--move-files` 才把旧目录内容搬到新目录——目标是已存在且非空的真实目录时拒绝，搬到什么就保留什么，内容为空后的旧目录不会被删除。目录标记随内容走；目标没有标记时补写。

主对话用 `archive` 清理**自己的**终态任务记录：需要最新 `--expect-rev` 和非空的 `--reason`，记录连同归档时间与操作者写入 `.workspace/archive/` 后从登记表移除。未完成任务必须先取消（或走 `recover-task`），否则返回 `INVALID_STATE`；子对话不能归档（`NOT_MAIN`）。**`archive` 不碰任何产物文件**，返回 `directoryKept` 说明目录是否还在。`recover-task` 仍只用于子对话失联的任务，不处理主对话任务。

子对话已删除或不可恢复时，用户确认后由主对话用 `recover-task` 取消或转交已登记任务；参数、记录源检查及中断续做见 [会话检查与任务恢复](recovery.md)。普通任务输入字段不变，恢复审计单独保存。

`writes` 声明文件或目录，路径相对工作区，也接受明确的绝对路径（含工作区外资源）。脚本仅读取外部资源；所有实际编辑仍使用原工具与权限。目录前缀、大小写（Windows）、已存在的真实路径都参与重叠检查。认领仅协调**本工作区已登记且遵约的任务**，不提供跨工作区互斥或操作系统锁。

`context` 默认每组最多 5 项，`--limit` 最大 20，`--offset` 分页。main 看到所有登记任务，child 看到自己的任务及相关冲突。摘要不含写入清单和全文证据，`detail` 按任务展开。新上下文不带 since；缓存丢失则返回 reset=true 的完整视图。缓存只保留每个会话最近两版，未处理完的分页不能把新 stamp 当成已读。

主对话的 `sessionCheck` 说明会话记录是否检查；配置了 DSH 记录源时，scope 为 `declared-metadata+session-record-presence`。日志存在性不等于会话活跃性；核心导出函数只使用显式参数，不读取调用者环境。

`unregistered` 是登记表之外的另一条线索：工作区里带 `.session-id` 归属标记、却不属于任何登记任务的目录。每项给出 `path`（相对工作区）、`owner`（标记里写的会话）、`files`（该目录下普通文件数）。main 看到全部，child 只看到 `owner` 等于自己的那些；没有内容时整个字段省略。判据是归属标记而不是目录存在，因此 `src/`、`docs/` 这类普通目录和没有标记的目录永不被报告；挂载点、链接和 `.git/.workspace/node_modules/.venv/venv/dist/build/__pycache__` 不参与。扫描上限为深度 4、50 个目录、每目录 5000 文件，达到上限时结果不完整，不能当作"没有更多"。该字段只读，登记任务后对应目录自然消失；它不替代 `check` 的文件内容比对。

`identity` 在已启用工作区且 `role=unknown` 时出现，形如 `{"status":"unknown","hint":"…"}`。它说明本次调用没能确定会话身份：此时 `taskCount: 0` 不代表你没有任务，任何登记和认领都会失败。取 id 的可靠来源是 `pwsh` 的 `DSH_SESSION_ID`；`ops_bash`/bash 不传任何 `DSH_*` 变量，在那里 `env` 查不到。CLI 在缺少 `--session` 时用 `DSH_SESSION_ID` 兜底，对所有需要身份的核心命令生效，显式 `--session` 优先；导出的 `execute()` 不读环境，只有 CLI 入口读。

`audit` 是只读盘点：列出工作区里没有任何**活动**任务声明的文件，按目录聚合，可用 `--limit/--offset` 分页，`--scope root` 只看根目录一层。`hint` 只描述路径形态（`root-level-file` / `undeclared-tree`），不做归属判断；未声明文件**永不导致 `check` 失败**，也不参与冲突判定。`complete: false` 表示扫描触达上限，此时清单不完整，不能当作「没有更多」。

`owners` 只验证登记产物的显式归属标记，不扫描文件正文。`check` 递归检查**活动任务**的产物和 writes，比较内容哈希与上次 summary 的扫描快照，检测新增/修改/删除；终态（done/cancelled）任务不再占用资源，其目录按历史对待，不参与扫描和归属校验——目录被正常清理不会让基线失效。根目录共享文件须在 writes 里登记。默认每组 5 项，可用 limit/offset 分页。扫描不跟随符号链接，跳过 `.git/.workspace/node_modules/.venv/venv/dist/build/__pycache__`，这些目录若被直接登记为资源仍扫描根目录本身。上限为 5000 文件、20000 路径、单文件 16 MiB、合计 64 MiB；达到上限、读取错误、链接或扫描期间变更都明确标为 incomplete，不能给出无冲突保证。

首次没有扫描基线会提示 baseline_missing；主对话检查后用 summary 建立基线。summary 保存的是内容哈希，不靠 mtime 判断，内容相同不会反复重写。只生成 v2 维护的 sum.md；遇到手工/v1 文件保留原件并拒绝覆盖。

输出为单行 JSON。退出码：0 操作成功或指定检查范围内无问题；1 有待处理的问题；2 输入/权限/身份/解析问题。`more` 表示输出尚未显示全部，不会静默丢掉异常；增加 offset 获取后续。failed/unknown/incomplete 不等于正常。资源冲突和占用任务返回错误；拿到对方最新状态后再协调。

元数据目录 `.workspace/`：config.json 是唯一主身份；tasks/ 每任务一个文件；cache/ 是可丢弃的简报缓存；summary.json 保存汇总基线。claims 待办按需读取 [认领与归拢](organize.md)。修改通过临时文件替换，并用排他创建的 `.write-lock` 串行协调。锁竞争返回 BUSY，不自动抢锁；崩溃遗留时先确认没有管理命令在运行，再人工移走锁。会话身份是协作约定，不是安全认证。


## 共享项目与公共文件

一个工作区常常同时是「共享项目」和「多个对话的产物场」。两者混用会出现：项目文件没人负责，而两个对话同时改同一个入口文件，`check` 仍报无冲突——因为 `check` 只看已声明的东西。

1. **公共项目文件不必逐个预先声明**，但**改动前**必须把它们加进任务的 `writes`。声明是「我要写它」的意图，不是所有权证书。
2. 同一路径被两个**活动**任务声明即冲突（`RESOURCE_CONFLICT`）。这不是禁止协作，而是逼出一次显式交接。
3. 项目级基线文件（入口页、构建配置、根 `README`）建议由**一个**对话统一认领，免得每个对话都以为自己该改。
4. 声明整个目录会覆盖其下所有文件。只想碰一个文件就逐条写文件，不要图省事声明目录——那会把别人的改动一起据为己有，也会掩盖真正未声明的文件。

### 未声明文件不是错误

`audit` 只读盘点没有被活动任务声明的文件，按目录聚合。它是盘点工具，不是校验器：未声明文件永远不让 `check` 失败。刚接手的工作区本来就会有大量未声明文件，它们多半是项目基线，不是谁写了一半的产物。

判断顺序：

1. 在公共项目里（`src/`、`tests/`、构建配置）→ 是项目基线，**不要**搬进个人目录；需要改时按上面第 1 条声明。
2. 是某个对话的输出却留在根目录 → 让该对话认领，或用 `migrate` 收进它的产物目录。
3. 认不出归属 → 用 `hint` 和 `docs/` 的项目说明判断，**不要**按修改时间或名字猜。

`context` 会向主对话报告未声明文件数（仅大于 0 时出现），`summary` 把数量写进 `sum.md`，因此这个数字不会长期无人过问。看到它就值得跑一次 `audit`。
