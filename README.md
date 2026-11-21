# Codex Token Meter

实时查看 Codex 主 agent 和每个子 agent 的 token 用量：输入、缓存输入、输出、推理 token、所用模型、每次请求增量和趋势。提供两种界面：

- **终端 TUI**：在另一个终端里运行，按 agent 树实时刷新。
- **网页仪表盘**：`http://127.0.0.1:4399`，通过 SSE 实时推送。

不需要 API key，也不依赖第三方 npm 包（Node >= 18）。

## 原理

Codex 会把每个线程（包括每个子 agent）写入 `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`（默认 `~/.codex`）。Token Meter 持续 tail 这些文件：

| 数据 | 来源 |
| --- | --- |
| 父子关系、昵称、角色 | `session_meta.source.subagent.thread_spawn` |
| 模型、推理强度 | `turn_context.model` / `effort` |
| token 用量 | `token_usage_record`（新版），否则 `event_msg.token_count` |
| 状态 | `task_started` / `task_complete` / `turn_aborted` |

fork 出的子 agent 会继承父线程历史，继承部分（`subagent_history_start_ordinal` 之前的记录）不计入子 agent。

## 快速开始

```bash
git clone <this repo> && cd codex-token-meter

node plugins/codex-token-meter/bin/codex-token-meter.js          # 终端 TUI
node plugins/codex-token-meter/bin/codex-token-meter.js web --open  # 网页仪表盘
node plugins/codex-token-meter/bin/codex-token-meter.js both     # 同时启动两者
```

也可以 `npm link` 后直接使用 `codex-token-meter`。

| 命令 | 作用 |
| --- | --- |
| `tui`（默认） | 终端界面。`q` 退出，`a` 切换“只看活跃 / 全部会话” |
| `web` | 网页仪表盘（`/api/state`、`/api/events` SSE、`/api/health`） |
| `both` | TUI + 网页 |
| `summary` | 打印一次文字摘要 |
| `json` | 打印完整 JSON 快照 |
| `ensure-web` | 若网页服务未运行，则在后台启动（供 hook 使用） |

选项：`--codex-home <dir>`、`--port <n>`（默认 4399）、`--host <addr>`（默认 127.0.0.1）、`--since <小时>`（默认 24）、`--open`、`--all`。

## 作为 Codex 插件安装

```bash
codex plugin marketplace add /path/to/codex-token-meter   # 或 Git 地址
codex plugin add codex-token-meter@codex-token-meter
```

插件提供：

- **SessionStart hook**：每次启动 Codex 时自动确保网页仪表盘在后台运行。Codex 要求首次审核插件 hook；在交互式 Codex 启动时的 hook 审核界面里信任它即可（`codex exec` 下未信任的 hook 不会运行）。
- **`token-meter` skill**：在 Codex 里问“子 agent 用了多少 token”时，Codex 会调用 `summary` / `json` 回答并给出仪表盘地址。

## 开发

```bash
npm test                 # node:test，含真实 Codex rollout 作为 fixture
npm run mock             # 本地 mock Responses API（:18080），用于无 key 生成父子 agent 会话
```

mock 用法：在 `$CODEX_HOME/config.toml` 中配置 `model_provider = "mock"`，`base_url = "http://127.0.0.1:18080/v1"`，然后 `codex exec "SPAWN_TEST"` 会生成一个主 agent 和两个子 agent（explorer / worker），子 agent 会多轮请求，便于观察实时变化。`MOCK_CHILD_DELAY_MS`、`MOCK_CHILD_STEPS` 可调节节奏。

## 限制

- 只统计 token，不计算费用。
- 只读取本机 rollout 文件；网页服务默认只监听 127.0.0.1。
