# 文件认领与归拢

只在用户要求整理散落产物、归属不明或 context 出现 claims 待办时读取。本流程把旧文件纳入已有任务目录，日常回复无需运行。

## 先认领，再归拢

1. `inventory` 只盘点工作区根目录的普通文件，不读取正文，不按名字/时间/调用次数认定 owner。明确的项目元数据被排除；目录不递归搬动。需要线索时，按 [取证命令](forensics.md) 查具体文件。
2. 目标对话先用常规 `task` 注册自己的任务与目录。主对话或目标对话提交显式清单，形成 proposed 认领请求；主对话不能代替目标对话接受。
3. 目标对话恢复时，普通 context 会显示属于自己的 claims。逐页读完整份 detail，核对 source→target、证据和引用候选，再用当前真实 session 和 digest 接受。主对话按现有工具及授权转交请求；没有消息通道时保留待办，告知用户让对应对话恢复，不自动唤醒或代发消息。
4. `copy` 逐文件复制并核对哈希，旧文件仍在。目标对话修正新位置的相对引用，运行适合这些产物的验证。
5. 验证通过且用户任务已授权迁移时，用 `finish --remove-originals` 清理旧位置。未授权迁移或证据不足时停留在复制阶段，说明缺少什么。不要因为启用了技能就整理全部现有文件。

## 命令

以下命令相对 skill 目录执行，WORKSPACE 为绝对路径。修改操作需要已启用的 v2 工作区；inventory 可在未启用时只读运行。

```text
node scripts/organize.mjs inventory --workspace WORKSPACE
node scripts/organize.mjs propose --workspace WORKSPACE --session SESSION --file PLAN.json
node scripts/organize.mjs detail --workspace WORKSPACE --plan PLAN_ID
node scripts/organize.mjs accept --workspace WORKSPACE --session OWNER_SESSION --plan PLAN_ID --expect-rev REV --digest DIGEST
node scripts/organize.mjs copy --workspace WORKSPACE --session OWNER_SESSION --plan PLAN_ID --expect-rev REV
node scripts/organize.mjs finish --workspace WORKSPACE --session OWNER_SESSION --plan PLAN_ID --expect-rev REV --checks CHECKS.json --remove-originals
node scripts/organize.mjs cancel --workspace WORKSPACE --session SESSION --plan PLAN_ID --expect-rev REV
```

PLAN.json：

```json
{
  "id": "collect-export-notes",
  "task": "fix-export",
  "files": [{"source": "export-notes.md", "target": "notes/export-notes.md"}],
  "evidence": ["对应对话确认；或具体日志位置，仅作为候选线索"]
}
```

source 只接受根目录文件名，target 相对目标任务目录。每计划 1～50 文件，单文件至多 16 MiB、合计至多 64 MiB。已跟踪的项目文件、未知 Git 状态、README/配置等、链接、目标重名及跨目录逃逸会被拒绝，应走项目级迁移流程。本版本不自动归类或搬动未认领的整个目录。

CHECKS.json 必须反映目标对话实际完成的核对，不是让脚本替代验证：

```json
{
  "referencesReviewed": true,
  "checks": [{"name": "引用和产物检查", "result": "passed", "evidence": "实际执行的检查与结果，或验证记录路径"}]
}
```

finish 不会执行这里的自由文本命令。它会核对源文件仍与认领时一致、目标文件与验证时一致，再删除旧副本，并将 task.writes 中指向旧文件的精确路径改到新位置，把计划记录加入 task.evidence。它不自动改写其他文件的链接或猜测如何修复引用。

## 输出、引用与恢复

输出默认最多 5 项，limit 最大 20，offset 分页；detail 的 files 和 references.files 都需读完。日常 context 只给出计划 id、owner、状态、数量和版本，没有待办时不增加 claims 字段，状态未变仍返回短响应。

propose 用可用的 rg 搜索文件名文本候选，排除常见元数据/依赖目录；缺少 rg、超时或结果太多会显示不完整。文本命中不等于真实依赖，无命中也不能排除动态引用；目标对话必须核对适当范围和实际可用性。

元数据与原 v2 共用 `.write-lock`；计划保存到 `.workspace/claims/`。待处理计划会预留源/目标路径，其他登记任务不能抢占。每步都核对 rev、目标对话身份、主对话 epoch 和文件指纹；这仍是协作约定，不是安全认证或阻止外部程序写入的系统锁。

复制中断可 detail 取最新版本后重试，不覆盖内容不同的目标；删除中断保留逐文件日志和验证哈希，用同一 CHECKS.json 续做。出现 SOURCE_CHANGED/TARGET_CHANGED 时重读并核查，不自动用新内容覆盖旧证据。尚未删除旧文件时可以取消；已有副本会保留，不擅自删除。主对话交接会使未完成计划失效：未开始的计划取消后重新提案；已有复制或部分删除时保留记录和双方副本，先人工恢复核对。
