# workspace-main-conversation v2

DSH / Codex 的文件协作 skill。短入口 + 每任务独立状态 + 按会话过滤和增量简报。无需 npm 包，不调用模型/API，不读取完整会话日志。

## 安装

PowerShell：`./install.ps1 -Target Codex` 或 `./install.ps1 -Target DSH`。默认拒绝覆盖；升级加 `-Force` 会先备份。安装不会启用任何工作区，也不会改原始产物。Codex 可在下一轮发现新 skill，未出现时重启；DSH 的技能列表刷新方式以实际版本为准。

## 使用

读 [SKILL.md](SKILL.md)，具体命令在 [references/commands.md](references/commands.md)。用户指定主对话后 init，再由各对话登记各自任务。context 是日常入口，check 是明确的文件核验，summary 为人生成台账。

测试：`node --test tests/*.test.mjs`。冒烟检查：`node selftest-portable.mjs`，可额外传一个 zstd 文件。已在 Node v24.21.0 验证；zstd 功能需当前 Node 提供相应 API，协作命令本身只用基础内置模块。

v1 差异与迁移见 [references/migration.md](references/migration.md)。安全边界：资源认领只约束本工作区合作方，无法阻止外部写入；扫描有明确范围、排除项和上限；不会根据“没检测到”推断全局无冲突。

节省量需针对实际模型计量；字符数、文件字节数和真实 token 数不能混为一谈。本包的自测与报告分别记录入口体积、简报体积及实际功能验证。
