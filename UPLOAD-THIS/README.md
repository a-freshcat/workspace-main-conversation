# workspace-main-conversation

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) skill：
**让共享工作区里的多个对话不再各干各的、互相撞车。**

---

## 它解决什么问题

一个工作区常被**多个对话同时**使用。没有约束时会出现：

- 3 条对话，5 个目录 —— 多出来的那个**没人认领**，谁也不敢删
- 两个对话做同一件事，产出重复
- 一个对话改了另一个正在编辑的文件
- 主对话不知道别人在干什么，无法判断该不该动手

这个 skill 把「谁统筹、谁干活、怎么查」变成可执行的规则。

---

## 核心机制

### 1. 主对话 / 子对话

**身份凭证是文件，不是意愿**：

| 文件 | 含义 |
|---|---|
| `<工作区>/sum.md` | 主对话的统筹台账（存在 ⇒ 主对话已定） |
| `<工作区>/main.md` | 主对话的自我声明（可选，冗余更保险） |

**判定优先级（从上到下）**：

1. **使用者显式指名**（「你这条对话命名为主对话」）⇒ 最高，直接生效
2. `main.md` 的 `owner` 是本对话
3. `sum.md` 的 `owner` 是本对话
4. 都没有，且本对话是第一个产出文件的 ⇒ 主对话
5. `sum.md` 存在但 `owner` 不是本对话 ⇒ **子对话**

### 2. 主对话要做什么

- 建并**持续维护** `sum.md`：对话清单 + **冲突审查**
- 查看其它对话在干什么（读会话记录，不靠猜）
- 审冲突与重复劳动
- 另负责**小 bug**（使用者的分工：大 bug 另开对话）

### 3. 子对话要做什么

只四件事：**知道自己不是主对话**、只写自己的目录、不动别人的文件、动共享文件前留话。

> 子对话**不需要**审查别人 —— 那是主对话的活，越界只会制造重复劳动。

### 4. 目录归属必须可查

每个目录放一个 `.session-id`（一行，内容是创建者的会话 id）。
**谁建目录谁立刻写。** 主对话用审计脚本查孤儿。

---

## 安装

> 本仓库的**根目录就是 skill 本身**（`SKILL.md` 在根上）。
> 所以克隆时**目录名必须是 `workspace-main-conversation`** ——
> DSH 的技能扫描是**深度 1**：只认 `<skills根>/<名字>/SKILL.md`。

### 方式一：git clone（推荐）

```powershell
# Windows
git clone https://github.com/a-freshcat/workspace-main-conversation.git "$env:USERPROFILE\.dsh\skills\workspace-main-conversation"
```

```bash
# macOS / Linux
git clone https://github.com/a-freshcat/workspace-main-conversation.git ~/.dsh/skills/workspace-main-conversation
```

> ⚠️ 注意结尾的 `workspace-main-conversation` 不能省。
> 少了它，git 会建成 `~/.dsh/skills/` 下的仓库名目录 —— 那也对；
> 但如果克隆到别的名字（比如 `skills/my-skill`），DSH 就扫不到。

### 方式二：下载 zip 解压

从 Releases 或仓库里的 `workspace-main-conversation-skill.zip` 下载，
解压后把**里层**的 `workspace-main-conversation/` 整个放进 `~/.dsh/skills/`。

### 方式三：用自带脚本

```powershell
.\install.ps1            # 装到 ~/.dsh/skills/
.\install.ps1 -Force     # 已存在则覆盖
```

### 验证安装

```powershell
$sk = "$env:USERPROFILE\.dsh\skills\workspace-main-conversation"
node "$sk\selftest-portable.mjs"
```

应输出 `✅ 可移植性自测通过`。然后**重启 DSH**，技能列表里才会出现它。

> 💡 DSH 的技能扫描是**深度 1**：只认 `<根目录>/<名字>/SKILL.md`。
> 所以目录名必须是 `workspace-main-conversation`，不能多套一层。

---

## 包含的文件

| 文件 | 作用 |
|---|---|
| `SKILL.md` | **主规则**（skill 本体，DSH 读的就是它） |
| `check.mjs` | 一键巡检：目录归属 / 对话→目录 / 活跃度 / 台账时效 |
| `audit-owners.mjs` | 单独的目录归属审计，列出孤儿目录 |
| `selftest-portable.mjs` | 可移植性自测（复制到新机器后先跑这个） |
| `zstd-frames.mjs` | 多帧 zstd 解码器（读会话记录必需，见下） |
| `example/` | 一份真实的 `sum.md` / `main.md` 样例 |

---

## 快速上手

```powershell
$sk = "$env:USERPROFILE\.dsh\skills\workspace-main-conversation"

# ① 巡检当前工作区
node "$sk\check.mjs" "C:\path\to\your\workspace"

# ② 只看目录归属
node "$sk\audit-owners.mjs" "C:\path\to\your\workspace"
```

`check.mjs` 退出码：`0` 全部通过 / `1` 有需要处理的问题。

---

## 为什么需要 `zstd-frames.mjs`

DSH 的会话记录是 `session.v4.jsonl.zstd`，**多帧 zstd**。

用 `zstdDecompressSync` 整段解**只出第一帧** —— 实测一个 1082 帧的文件只解出 249 字符。
于是你会得出「这个对话什么都没写」的**错误结论**。

自带解码器按 zstd 帧结构逐帧解，实测 1082 帧全解、488 万字符。

```powershell
node "$sk\zstd-frames.mjs" "<某个 session.v4.jsonl.zstd>"
# frames=1082 ok=1082 failed=0 chars=4887590
```

---

## 设计取舍

**为什么不自动扫描所有对话做审计？**
会话记录的读取成本不低（单文件可达数 MB），每次对话都全量扫会拖慢启动。
折中：主对话在**巡检时**按需查，而不是子对话每次启动都查。

**为什么用文件当凭证，不用数据库？**
文件是**跨工具、跨版本**都能读的。DSH 升级、换机器、手工编辑都不失效。

**为什么孤儿目录比"目录数不对"更重要？**
一个对话合法拥有多个目录（主方案 + 副产品）很常见。
真正的问题是**没人认领的目录** —— 那才是混乱的开始。

---

## 已知限制

- 依赖 DSH 的会话记录格式（`session.v4.jsonl.zstd`）。格式大改时解码器需同步更新。
- `.session-id` 是**约定**，不是强制：老目录可能没有，需要主对话补齐。
- 会话间**没有消息通道**，只能靠读记录 + 留文件沟通。

---

## License

MIT
