# 命令参考

公共参数：`--workspace` 为已存在的工作区；修改操作的 `--session` 必须来自当前运行环境。只读的未知身份可用 `unknown`。参数值以实际值替换下文大写单词，路径有空格时加引号。Node 需具备 zstd API；核心协作不依赖 zstd 或外部 skill。

```text
node scripts/workspace.mjs init --workspace WORKSPACE --session SESSION
node scripts/workspace.mjs context --workspace WORKSPACE --session SESSION
node scripts/workspace.mjs context --workspace WORKSPACE --session SESSION --since STAMP
node scripts/workspace.mjs detail --workspace WORKSPACE --task ID
node scripts/workspace.mjs task --workspace WORKSPACE --session SESSION --file INPUT.json
node scripts/workspace.mjs task --workspace WORKSPACE --session SESSION --file INPUT.json --expect-rev REV
node scripts/workspace.mjs check --workspace WORKSPACE
node scripts/workspace.mjs owners --workspace WORKSPACE
node scripts/workspace.mjs summary --workspace WORKSPACE --session SESSION
node scripts/workspace.mjs handoff --workspace WORKSPACE --session SESSION --to NEW_SESSION --expect-epoch EPOCH
```

`init` 只在用户要求启用管理并指定主对话时调用。已有 v1 的 `sum.md` / `main.md` 时额外传 `--ack-legacy`，先读迁移参考；不会导入或猜测旧 owner。

任务输入是完整的当前快照，UTF-8 JSON：

```json
{
  "id": "fix-export",
  "goal": "修复导出结果缺少末行",
  "state": "doing",
  "directory": "conversations/fix-export",
  "writes": ["src/export.mjs"],
  "next": "补回归样例并验证",
  "result": "",
  "evidence": []
}
```

state 可选 `planned/doing/blocked/done/cancelled`。前三者保留资源认领；完成/取消后释放。创建任务不传 expect-rev；更新必须传当前版本，其他对话不能覆盖。产物目录不可交叉，后续不可更换；已有未标记非空目录须用 `--adopt`，且须用户明确确认该目录归属。不要把代码库根或公共源码目录当成个人产物目录。

`writes` 声明文件或目录，路径相对工作区，也接受明确的绝对路径（含工作区外资源）。脚本仅读取外部资源；所有实际编辑仍使用原工具与权限。目录前缀、大小写（Windows）、已存在的真实路径都参与重叠检查。认领仅协调**本工作区已登记且遵约的任务**，不提供跨工作区互斥或操作系统锁。

`context` 默认每组最多 5 项，`--limit` 最大 20，`--offset` 分页。main 看到所有登记任务，child 看到自己的任务及相关冲突。摘要不含写入清单和全文证据，`detail` 按任务展开。新上下文不带 since；缓存丢失则返回 reset=true 的完整视图。缓存只保留每个会话最近两版，未处理完的分页不能把新 stamp 当成已读。

`owners` 只验证登记产物的显式归属标记，不扫描文件正文。`check` 递归检查登记产物和 writes，比较内容哈希与上次 summary 的扫描快照，检测新增/修改/删除；根目录共享文件须在 writes 里登记。默认每组 5 项，可用 limit/offset 分页。扫描不跟随符号链接，跳过 `.git/.workspace/node_modules/.venv/venv/dist/build/__pycache__`，这些目录若被直接登记为资源仍扫描根目录本身。上限为 5000 文件、20000 路径、单文件 16 MiB、合计 64 MiB；达到上限、读取错误、链接或扫描期间变更都明确标为 incomplete，不能给出无冲突保证。

首次没有扫描基线会提示 baseline_missing；主对话检查后用 summary 建立基线。summary 保存的是内容哈希，不靠 mtime 判断，内容相同不会反复重写。只生成 v2 维护的 sum.md；遇到手工/v1 文件保留原件并拒绝覆盖。

输出为单行 JSON。退出码：0 操作成功或指定检查范围内无问题；1 有待处理的问题；2 输入/权限/身份/解析问题。`more` 表示输出尚未显示全部，不会静默丢掉异常；增加 offset 获取后续。failed/unknown/incomplete 不等于正常。资源冲突和占用任务返回错误；拿到对方最新状态后再协调。

元数据目录 `.workspace/`：config.json 是唯一主身份；tasks/ 每任务一个文件；cache/ 是可丢弃的简报缓存；summary.json 保存汇总基线。claims 待办按需读取 [认领与归拢](organize.md)。修改通过临时文件替换，并用排他创建的 `.write-lock` 串行协调。锁竞争返回 BUSY，不自动抢锁；崩溃遗留时先确认没有管理命令在运行，再人工移走锁。会话身份是协作约定，不是安全认证。
