# workspace-main-conversation v2.1（合并版）

DSH / Codex 的文件协作 skill。保留短入口、独立状态与增量简报，新增散落文件认领、核对和归拢。DSH 取证工具已内置，异常时才读取相关日志；日常不解析日志。无需 npm 包，不调用模型/API。

## 安装

PowerShell：`./install.ps1 -Target Codex` 或 `./install.ps1 -Target DSH`。默认拒绝覆盖；升级加 `-Force` 会先备份。DSH 可加 `-MergeLegacy` 归档旧 detect-concurrent-workspace-edits 入口，并保留两个命令的兼容路径，避免重复发现 skill。安装不会启用工作区或整理实际产物。Codex 未显示新版时重启；DSH 以实际版本的刷新方式为准。

## 使用

读 [SKILL.md](SKILL.md)，常规命令在 [references/commands.md](references/commands.md)。用户指定主对话后 init，各对话登记自己的任务。主对话统筹并审查冲突与重复劳动，具体任务分工以用户指派为准。context 是日常入口。散落文件整理才读 [认领与归拢](references/organize.md)，DSH 日志线索才读 [取证参考](references/forensics.md)。

测试：`node --test tests/*.test.mjs`。冒烟检查：`node selftest-portable.mjs`，可额外传一个 zstd 文件。已在 Node v24.21.0 验证；zstd 功能需当前 Node 提供相应 API，协作命令本身只用基础内置模块。

v1 差异与迁移见 [references/migration.md](references/migration.md)。安全边界：资源认领只约束本工作区合作方，无法阻止外部写入；扫描有明确范围、排除项和上限；不会根据“没检测到”推断全局无冲突。

节省量需针对实际模型计量；字符数、文件字节数和真实 token 数不能混为一谈。本包的自测与报告分别记录入口体积、简报体积及实际功能验证。
