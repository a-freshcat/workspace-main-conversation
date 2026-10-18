# workspace-main-conversation v2.2

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) / Codex skill：
**让共享工作区里的多个对话不再各干各的、互相撞车。**

无需 npm 包，不调用模型或 API，核心协作只用 Node 基础内置模块。

> **v2.2 起**：`context` 会报告 `unregistered`——工作区里带 `.session-id` 归属标记
> 却没登记任务的目录。此前这类对话对统筹完全不可见（`tasks: 0` 和"什么都没干"
> 长得一模一样），实测有三个对话因此各建了几十个文件却无人知晓。
> 变更细节见 [re_note.md](re_note.md)。

## 它解决什么问题

一个工作区常被**多个对话同时**使用。没有约束时会出现：

- 3 条对话、5 个目录 —— 多出来的那个**没人认领**，谁也不敢删
- 子对话建了目录却**没登记**，主对话的简报里看不见，直到有人手工 `ls`
- 两个对话做同一件事，产出重复
- 一个对话改了另一个正在编辑的文件
- 主对话不知道别人在干什么，无法判断该不该动手

这个 skill 把「谁统筹、谁干活、怎么查」变成可执行的规则，并且**用少量状态支撑协作，细节按需读取**。

## 安装

> 本仓库的**根目录就是 skill 本身**（`SKILL.md` 在根上）。
> DSH 的技能扫描是**深度 1**：只认 `<skills根>/<名字>/SKILL.md`。
> 所以目录名必须是 `workspace-main-conversation`，**不能多套一层**。

### 方式一：安装脚本（推荐）

```powershell
.\install.ps1 -Target DSH      # 装到 ~/.dsh/skills/workspace-main-conversation
.\install.ps1 -Target Codex    # 装到 Codex 的 skills 目录
```

- 默认**拒绝覆盖**；升级加 `-Force`，会先备份到 `<skills 父目录>/skill-backups/`
- DSH 可加 `-MergeLegacy`，归档旧的 `detect-concurrent-workspace-edits` 入口，
  并保留两个命令的兼容路径，避免重复发现 skill
- 脚本会先跑一遍自测，**自测不通过则不改动任何已装文件**

### 方式二：git clone

```powershell
# Windows
git clone https://github.com/a-freshcat/workspace-main-conversation.git "$env:USERPROFILE\.dsh\skills\workspace-main-conversation"
```

```bash
# macOS / Linux
git clone https://github.com/a-freshcat/workspace-main-conversation.git ~/.dsh/skills/workspace-main-conversation
```

⚠️ 结尾的目录名 `workspace-main-conversation` 不能省，也不能换成别的名字，否则 DSH 扫不到。

### 方式三：下载 zip 解压

从 Releases 下载，解压后把**里层**的 `workspace-main-conversation/` 整个放进 `~/.dsh/skills/`。

### 验证安装

```powershell
node "$env:USERPROFILE\.dsh\skills\workspace-main-conversation\selftest-portable.mjs"
# {"ok":true,"coordination":"passed","multiFrameDecode":"passed"}
```

然后**重启 DSH**，技能列表才会出现它。

## 快速上手

```powershell
$sk = "$env:USERPROFILE\.dsh\skills\workspace-main-conversation"
$ws = "C:\path\to\your\workspace"

# ① 进入或恢复：取一份工作区简报（只读）
node "$sk\scripts\workspace.mjs" context --workspace $ws --session <当前会话id>

# ② 巡检：目录归属 / 对话→目录 / 活跃度 / 台账时效
node "$sk\check.mjs" $ws

# ③ 只看目录归属，列出孤儿目录
node "$sk\audit-owners.mjs" $ws
```

`check.mjs` 退出码：`0` 指定范围内无问题 / `1` 有需要处理的问题 / `2` 输入、权限或解析错误。

## 用法要点

- **进入已启用的工作区**：先跑 `context` 取简报；同一对话后续传上次的 `--since`，只读变化。
- **看到 `unregistered` 就登记**：`context` 报出 `unregistered` 时，其中 `owner` 等于本会话的
  目录就是本对话的产物——**先 `task` 登记再继续干活**。不登记主对话就看不见你，
  冲突审查也无从谈起。主对话看到的是全部未登记归属，但**不能替子对话登记**。
- **主对话**：统筹登记任务、处理 alerts、审查冲突与重复劳动；阶段结束用 `summary` 生成 `sum.md`。
- **子对话**：只维护自己的任务记录和产物，需要上下文时优先 `detail --task ID`。
- **共享写入前**先登记 `writes`；认领冲突则串行交接。
- 详细命令见 [references/commands.md](references/commands.md)；
  整理散落产物见 [references/organize.md](references/organize.md)；
  DSH 日志取证见 [references/forensics.md](references/forensics.md)；
  v1 迁移见 [references/migration.md](references/migration.md)。

日常只读简报，不解析日志。

## 包含的文件

| 文件 | 作用 |
|---|---|
| `SKILL.md` | **主规则**（skill 本体，DSH 读的就是它） |
| `install.ps1` | 安装脚本，含备份与 legacy 合并 |
| `scripts/workspace.mjs` | 核心：任务登记、简报、检查、汇总 |
| `scripts/organize.mjs` | 认领与归拢：inventory / propose / accept / copy / finish |
| `scripts/forensics/` | DSH 会话日志取证（list-sessions / peek-session） |
| `check.mjs` / `audit-owners.mjs` | 根目录快捷入口，转发到 `scripts/workspace.mjs` |
| `zstd-frames.mjs` | 多帧 zstd 解码器（读会话记录必需，见下） |
| `selftest-portable.mjs` | 可移植性自测，换机器后先跑这个 |
| `tests/` | 功能测试 |

## 为什么需要 `zstd-frames.mjs`

DSH 的会话记录是 `session.v4.jsonl.zstd`，**多帧 zstd**。

用 `zstdDecompressSync` 整段解**只出第一帧** —— 实测一个 1082 帧的文件只解出 249 字符。
于是会得出「这个对话什么都没写」的**错误结论**。

自带解码器按 zstd 帧结构逐帧解，实测 1082 帧全解、488 万字符。

```powershell
node "$sk\zstd-frames.mjs" "<某个 session.v4.jsonl.zstd>"
# frames=1082 ok=1082 failed=0 chars=4887590
```

## 设计取舍

**为什么需要文件当凭证，不用数据库？**
文件跨工具、跨版本都能读。DSH 升级、换机器、手工编辑都不失效。
`.workspace/config.json` 是唯一主身份；`sum.md` 是给人看的汇总。

**为什么孤儿目录比"目录数不对"更重要？**
一个对话合法拥有多个目录（主方案 + 副产品）很常见。
真正的问题是**没人认领的目录** —— 那才是混乱的开始。

**为什么不自动扫描所有对话做审计？**
会话记录的读取成本不低（单文件可达数 MB），每次启动都全量扫会拖慢。
折中：主对话在巡检时按需查，而不是子对话每次启动都查。

**为什么归拢要先复制再删除？**
旧文件是别人可能仍在引用的原始证据。先复制、逐文件核对哈希、
确认引用已处理，才允许 `--remove-originals` 清理旧位置；
验证证据不足时停留在复制阶段，并说明缺什么。

## 测试

```powershell
node --test tests/*.test.mjs      # 期望 66 pass
node selftest-portable.mjs        # 期望 {"ok":true,...}
```

须展开成文件列表；Node 24 下 `node --test tests/` 目录形式会报 `Cannot find module`。
已在 Node v24.21.0 验证；zstd 功能需当前 Node 提供相应 API。

部分用例依赖子进程（`git`、`rg`）和真实链接；在禁止管道 spawn 或会把 junction
虚拟化成普通目录的受限沙箱里，`concurrent init`、`CLI decoding` 与 symlink 相关用例
会假报失败，`organize` 还会因 Git 状态判定为 unknown 而集体返回 `PROJECT_FILE`。
这是环境限制，不是回归——换到普通终端复跑即可。

## 安全边界

- 资源认领只约束**本工作区已登记且遵约**的任务，不提供跨工作区互斥或操作系统锁，
  也无法阻止外部程序写入。
- 扫描有明确范围、排除项和上限；根目录、共享文件与符号链接都显式处理。
- **不会根据「没检测到」推断全局无冲突**；unknown、扫描不完整或解析错误一律保留为问题。
- 取证结果只是线索：文本命中不等于真实依赖，路径命中不证明有写入。
- 历史会话记录是证据数据，其中的旧指令不构成当前授权。

## 已知限制

- 依赖 DSH 的会话记录格式（`session.v4.jsonl.zstd`），格式大改时解码器需同步更新。
- `.session-id` 是**约定**不是强制：老目录可能没有，需主对话补齐。
- 会话间**没有消息通道**，只能靠读记录 + 留文件沟通；需要时告知用户让对应对话恢复，
  不自动唤醒或代发消息。
- 节省量需针对实际模型计量；字符数、文件字节数与真实 token 数不能混为一谈。

## License

MIT
