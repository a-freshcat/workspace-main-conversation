# 命令参考

取证脚本已合并进 workspace-main-conversation；下面命令相对其根目录执行，平时不运行。DSH_HOME 默认取环境变量，否则为用户目录的 `.dsh`，可用 `--home ABSOLUTE_PATH` 指定隔离的记录根。只读 `sessions/`，不读取 settings.yaml。

```text
node list-sessions.mjs --workspace WORKSPACE --limit 5 --offset 0
node list-sessions.mjs --workspace WORKSPACE --since ISO_TIME
node list-sessions.mjs --all --limit 5
node peek-session.mjs SESSION --workspace WORKSPACE --path TARGET --limit 5
node peek-session.mjs SESSION --path TARGET --since ISO_TIME --include-args
```

- workspace、path 建议使用绝对路径。list 默认工作区是当前 cwd，只显示 cwd 路径相交的会话；`--all` 才列全机范围。
- limit 为 1～20，默认 5；offset 是当前结果集的偏移。输出包含总数及 more/nextOffset。记录若继续追加，重新开始查询，不把分页结果当成固定快照。
- since 接受 ISO 时间或 Unix 秒/毫秒；list 用记录文件更新时间筛选，peek 用事件时间。无法识别时间的事件在指定时间窗口时不被默默排除，会标注 timeUnknown。
- SESSION 优先精确匹配，否则按 id 片段查找；多个候选报 ambiguous，省略时报错。兼容旧 `peek-session.mjs SESSION MAX` 形式，但不再输出用户聊天正文。
- path 先匹配结构化工具参数的已识别路径字段，再匹配参数中的字面文本。文本命中只是候选，路径相交不证明有写入。通过脚本间接修改文件、变量或链接形成的路径，可能无法从参数推导，未命中不能证明没改。
- 默认只输出工具名、推测类别、路径、记录行号、callId、是否见到结果。include-args 才显示最多 240 字符的参数片段；只在有具体目标时使用，片段可能含业务敏感内容。

支持带 `cwd/type/time/data` 的 DSH JSONL 事件，结构化对象中的 `name/arguments` 或 `function.name/function.arguments` 工具调用；结果通过同一 callId/toolCallId/tool_call_id 关联。只有显式 isError/success/ok 或 error 字段才能判断结果成功或失败，否则保留 unknown。未知结构不会被当作已经审完。

日志按结构拆分 zstd 帧，不扫描 magic 盲目跳过坏数据；跳过帧按长度处理。list 只读前 256 KiB 压缩数据、最多 60 帧和 1 MiB 解压数据来找 cwd/title，输出 headerOnly；无法分类的会话单列 issues。peek 最多读 32 MiB 压缩数据、32 MiB 解压数据，并返回扫描完整性；截断、坏帧、坏 JSON、读取期间变化都明确标 incomplete。

`complete` 表示指定范围内读取和解析是否完成，不代表每种 DSH 版本/任意 shell 的所有副作用都已识别。默认不打印用户消息和历史全文。输出为单行 JSON，退出码 0 成功、1 有不完整数据、2 参数/运行环境/会话选择错误。

## 与工作区协调 v2 的边界

同一个 skill 的常规模式管理任务与资源，归拢模式收集认领确认，取证模块只提供 DSH 记录线索。归属不明仍需目标对话确认，不能用调用次数或文件时间猜 owner。
