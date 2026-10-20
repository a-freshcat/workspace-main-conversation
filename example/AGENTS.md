<!-- workspace-main-conversation:agents:v1 -->
# 工作区说明与统筹

> 以下对话、任务与检查结果均为合成示例，不代表真实工作记录。

本目录是**共享工作区**：多个对话按任务分工，各自产物放在自己的目录里，登记与归属由 `.workspace/` 维护。
本页由 `summary` 命令生成，因此任何进入本目录的 agent 都会先看到它；内容以 `.workspace/tasks/` 为准，手改会在下次 `summary` 时被覆盖。

## 本目录的约定

- `.workspace/config.json` 是唯一主身份（schema 2）；`.workspace/tasks/` 每个任务一份记录；`.workspace/summary.json` 是 `check` 的汇总基线。
- 归属靠任务目录里的 `.session-id` 标记跟随任务：任务内容（`goal`/`state`/`next`/`result`）归 owner，协调者只能改位置与 `writes`（需 `--reason`）。
- 共享写入前先登记 `writes`；未声明文件不是错误，但值得跑一次 `audit` 盘点。
- 目录默认平铺在根目录、名字用任务 id；不要自行加前缀或套容器。

## 当前任务

| 任务 | 对话 | 状态 | 目标 | 产物 | 版本 |
|---|---|---|---|---|---|
| report | demo-a | doing | 整理示例报告 | report | 2 |
| docs | demo-b | done | 更新示例文档 | docs | 1 |

## 检查状态

- 主对话：demo-main；交接版本：1。
- 声明资源：无重叠；扫描 12 个文件。
- 未声明文件：0 个（详见 audit 命令）。
- 检查范围与排除项见 skill 命令参考；本页不代表未登记活动已被检查。
