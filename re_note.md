# re_note — v2.1.1 → v2.2

改于 2026-10-18。触发原因：四个子对话都执行过本 skill，其中三个建了产物目录却没登记，
主对话完全看不见——直到有人手工 `ls` 才发现工作区里躺着 90+ 个无人认领的文件。

## 一、先认账：原 skill 是真的缺一环

不是子对话"忘了"。原 `SKILL.md` 只写了一句：

> `role=child`：只维护自己的任务记录和产物

以及：

> 接任务、状态变化、结果交接时用 `task --file INPUT.json` 登记

这两句都在"执行"里，没有任何机制在对话没登记时提醒它。更关键的是 **`context` 只读登记表**：

```json
{"role":"child","tasks":{"total":0,...},"alerts":{"total":0,...}}
```

一个建了 28 个文件却没登记的对话，`context` 返回的就是上面这样——**`tasks: 0` 和
"什么都没干"长得一模一样**。对话没有理由认为自己有问题，用户也不知道该叫谁去补。

原 `SKILL.md` 那句"`scope=declared-metadata` 只检查登记信息；它不证明源文件未变或
未登记对话不存在"其实已经承认了这个边界，但**承认边界不等于提供发现手段**。

## 二、实测证据（2026-10-18 19:0x）

| 对话 | skill 提及 | `task` 调用 | 产物目录 | 登记 |
|---|---|---|---|---|
| 43b39b12（主） | 1505 | 有 | `main_repai/`、`past_bug/` | ✅ 2 个任务 |
| 17d0109e | 64 | 5 | `conversation-...-ops-bash-ipc-fix` | ✅ 1 个任务 |
| **b49ea65d** | **1798** | **0** | `conversation-...-市场更新失败排查`（19 文件） | ❌ |
| **c2910ae5** | 29 | **0** | `conversation-...-归档插件修复`（28 文件） | ❌ |
| **ceb2e37a** | 107 | **0** | `conversation-...-刷B站插件修复`（37 文件） | ❌ |

`b49ea65d` 的 1798 次提及是它在**开发这个 skill 本身**：57 次 `workspace.mjs`/`organize.mjs`
调用里，50 次指向 `$TEMP/wmc-beta`、`C:\wmc-legacy` 等测试沙盒，7 次是 `grep`/`sed` 看源码，
**0 次**在真实工作区给自己登记。数据量大不等于在协作。

## 三、改了什么

### 1. `context` 新增 `unregistered`

判据是 **`.session-id` 归属标记**——skill 自己规定的归属凭证，`task` 在认领目录时会写它。
因此"有标记但不在登记表里"精确等于"这个目录有主，但主没登记"。

```
$ node scripts/workspace.mjs context --workspace ... --session session-b49ea65d-...

{"role":"child","taskCount":0,
 "unregisteredCount":1,
 "unregistered":{"total":1,"items":[
   {"path":"conversation-2026-10-17-市场更新失败排查",
    "owner":"session-b49ea65d-015c-4b75-9069-5cfda6883e58","files":19}]}}
```

`tasks: 0` 旁边现在跟着一条指名道姓的 `unregistered`，对话没法再把它读成"一切正常"。

**可见性按角色分配**：`main` 看到全部（找人是它的活），`child` 只看到 `owner` 等于自己的。
别人的未登记目录不该出现在我的简报里——那既没用，也会变成噪音。

**为什么用标记而不是"目录存在"**：`src/`、`docs/` 这类普通项目目录从不参与；名字相近、
修改时间新旧都不代表归属。原有测试「ordinary project directories are outside registered
ownership audit」继续通过。

**有界**：深度 4、最多 50 个目录、每目录 5000 文件，`.git/.workspace/node_modules/.venv/
venv/dist/build/__pycache__` 不参与，链接跳过，标记超过 1 KiB 或不可读不算认领。

### 2. `SKILL.md` 新增「看到 unregistered 就要处理」

这是"自动去执行"的关键。原来只有"执行"里一句被动要求，现在是一节主动指令：

> `role=child` 且 `unregistered` 有内容：其中 `owner` 等于本会话的那些就是你的产物。
> **先登记再继续干活**……不登记的话主对话看不见你，冲突审查也无从谈起。

并明确 `main` **不能替子对话登记**，只能把 `owner` 告知用户或等对话恢复。

### 3. `references/commands.md` 补字段说明

`path` / `owner` / `files` 三个字段、可见性规则、扫描上限、以及"该字段只读，登记后自然消失"
——避免有人把它当成需要清理的待办队列。

### 4. 版本号 v2.1.1 → v2.2

新增输出字段属于兼容性变更（老调用方读不到该字段，但行为不变），按语义化版本升 minor。

## 四、测试

新增 4 条，全量 70/70 通过：

```
✔ a marked but unregistered directory is reported to the coordinator
✔ an unregistered claim is visible only to the conversation named in its marker
✔ registration clears the claim; ordinary directories and unmarked ones are never reported
✔ a claim is reported once, not per file, and excluded roots stay excluded
```

第 3 条是反向保证：登记后字段消失，且 `src/`、无标记目录永不误报。
第 4 条钉住"一个目录一条"，同时验证 `node_modules` 里的标记不会被当成认领。

## 五、同步了 example

用户在 GitHub 上按其它模型建议删掉的错误内容，本机安装版还是旧的，已同步：

| 文件 | 改动 |
|---|---|
| `example/main.md` | 主对话职责删掉末尾「具体任务以使用者指派为准」 |
| `example/sum.md` | 同上；「管理其它工作区遇到的 bug」→「由用户而定」；「统筹」→「统筹 + 小 bug」 |

其余 5 个文件与 GitHub 只差行尾（CRLF/LF），内容一致。

## 六、没做的

- **没做自动登记**。检测到未登记就替对话写 `task` 记录，会让"登记"这个动作失去意义——
  归属是对话自己的声明，脚本代写等于伪造。`main` 替 `child` 登记同样被 `references/
  organize.md` 明确禁止。
- **没改 `check`**。它比较的是已登记路径的内容哈希，未登记目录不在其职责内；
  两件事混在一起会让 `check` 的 `ok` 语义变模糊。
- **没动 `example/` 之外的文件时改行尾**。CRLF/LF 差异是 Windows 检出造成，
  统一它会制造一个纯噪音的 diff。

## 七、遗留

未登记目录的**存在**现在可见了，但"该目录属于谁"仍只依赖 `.session-id`。标记可以被复制、
可以缺失、也可以写错会话 id。这是协作约定，不是认证——`SKILL.md` 末尾那句
"会话身份是协作约定，不是安全认证"依然成立，本次改动没有改变这个性质。
