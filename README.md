# Codex Token Meter

实时查看 Codex 主 agent 和每个子 agent 的 token 用量和费用估算：输入、缓存输入、输出、推理 token、所用模型、每次请求增量和趋势。提供五种界面：

- **桌面版内嵌面板**（原型）：Codex 桌面版和 **ChatGPT 桌面版**（Work 模式 / 桌面版里的 Codex）里的一个小窗口——会话旁边的面板或侧边栏入口，自动显示当前对话，数据来自本地 MCP 服务，不走浏览器。见「桌面版内嵌面板」和「在 ChatGPT 桌面版里使用」。
- **悬浮小窗**：约 360×480 的小页面，可置顶浮在 Codex 桌面版 / IDE / 终端上方，**自动跟随你正在使用的 Codex 会话**。
- **Codex CLI 状态栏**：直接显示在 Codex 终端底部，跟随当前线程（Codex 0.171+ 实验功能）。
- **终端 TUI**：在另一个终端里运行，按 agent 树实时刷新。
- **网页仪表盘**：`http://127.0.0.1:4399`，通过 SSE 实时推送。

<img src="docs/mini-window.png" width="320" alt="悬浮小窗">

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

## 费用估算

每个 agent、每个模型、每个会话和全部会话都会显示一个**预估费用（USD）**，出现在 TUI 的「费用」列、网页仪表盘和悬浮小窗、CLI 的 `summary` / `json` 输出，以及 MCP `token_usage` 工具和 Codex CLI 状态栏里。

### 怎么算的

按 OpenAI API 官方定价（美元 / 每百万 token）换算，定价日期 **2026-11-22**，来源：<https://platform.openai.com/docs/pricing>。

| 模型 | 输入 | 缓存输入 | 输出 |
| --- | --- | --- | --- |
| gpt-5 / gpt-5-codex / gpt-5.1 / gpt-5.1-codex / gpt-5.1-codex-max | $1.25 | $0.125 | $10 |
| gpt-5-mini / gpt-5.1-codex-mini | $0.25 | $0.025 | $2 |
| gpt-5-nano | $0.05 | $0.005 | $0.40 |
| gpt-5.2-codex / gpt-5.3-codex | $1.75 | $0.175 | $14 |
| gpt-5.4 / gpt-5.4-mini / gpt-5.4-nano | $2.50 / $0.75 / $0.20 | $0.25 / $0.075 / $0.02 | $15 / $4.50 / $1.25 |
| gpt-5.5 | $5 | $0.50 | $30 |
| gpt-5.6-sol（促销价，至少到 2026-11-30）/ gpt-5.6-terra / gpt-5.6-luna | $4 / $2 / $0.20 | $0.40 / $0.20 / $0.02 | $20 / $12 / $1.20 |
| gpt-4.1 / gpt-4.1-mini / gpt-4.1-nano | $2 / $0.40 / $0.10 | $0.50 / $0.10 / $0.025 | $8 / $1.60 / $0.40 |
| gpt-6.1-sol / gpt-6.2-sol / gpt-6-astra / gpt-6.2-astra | $2 / $2 / $10 / $8 | $0.10 / $0.10 / $1 / $0.40 | $10 / $10 / $50 / $40 |

计费规则（都在 `plugins/codex-token-meter/src/pricing.js` 里，有注释）：

- **缓存输入按缓存价算，未缓存的输入按输入价算**：`input_tokens` 已包含缓存 token，所以未缓存输入 = 输入 − 缓存。
- **推理 token 按输出价算，不另收费**：`output_tokens` 已包含推理 token。
- **写入缓存的 token 不重复收费**：`cache_write_input_tokens` 已包含在 `input_tokens` 里，按输入价包含在输入那一项中，不再单独计费（rollout 里没有缓存有效期，无法按 OpenAI 的缓存写入价单独计费）。
- **未知模型不显示费用，绝不显示 $0**：定价表里没有的模型会显示 `—`，部分模型未定价的合计会带 `~` 前缀（如 `~$0.12`），表示这只是已定价部分的合计。

### 这只是估算，不是账单

- 定价会变，模型会退役：内置定价表是 2026-11-22 的快照，实际账单以 OpenAI 为准。Codex 订阅（ChatGPT / Codex 订阅价）和 API 按量价是两回事，这里按 API 定价估算。
- 不含批量（Batch）折扣、区域附加费、工具调用等其他费用。

### 自定义定价

内置定价过时或模型不在表里时，可以覆盖，优先级：`--pricing-file` > `CODEX_TOKEN_METER_PRICING` 环境变量 > 内置定价。

```bash
# pricing.json：模型 -> { 输入, 缓存输入, 输出 }（美元 / 每百万 token）
# { "gpt-5": { "input": 1.25, "cached": 0.125, "output": 10 },
#   "my-model": { "input": 1, "cached": 0.1, "output": 5 } }
codex-token-meter summary --pricing-file ./pricing.json
CODEX_TOKEN_METER_PRICING='{"gpt-5":{"input":1.25,"cached":0.125,"output":10}}' codex-token-meter web
```

没提到的模型沿用内置定价；格式写错会直接报错，不会悄悄用旧价格。

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
| `mini` | 打开悬浮小窗（Chrome/Edge 无边框小窗口，地址 `http://127.0.0.1:4399/mini`） |
| `ensure-web` | 若网页服务未运行，则在后台启动（供 hook 使用）；`--focus` 时从 stdin 读取 hook 输入并切换悬浮窗跟随的会话 |
| `mcp` | stdio MCP 服务：Codex 状态栏 + `token_usage` 工具 + 桌面版内嵌面板（`token_meter_panel`，插件自动启动） |

选项：`--codex-home <dir>`、`--port <n>`（默认 4399）、`--host <addr>`（默认 127.0.0.1）、`--since <小时>`（默认 24）、`--open`、`--all`、`--pricing-file <文件>`（自定义定价，见「费用估算」）。

## 作为 Codex 插件安装

```bash
codex plugin marketplace add /path/to/codex-token-meter   # 或 Git 地址
codex plugin add codex-token-meter@codex-token-meter
```

插件提供：

- **SessionStart / UserPromptSubmit hook**：启动 Codex 时自动在后台运行仪表盘；每次你在某个会话里发消息，都会把该会话设为悬浮窗的“当前会话”。Codex 要求首次审核插件 hook；在交互式 Codex 启动时的 hook 审核界面里信任它即可（`codex exec` 下未信任的 hook 不会运行）。
- **MCP 服务 `token-meter`**：提供 Codex CLI 状态栏和 `token_usage` 工具（模型可直接查询当前会话的 token）。
- **`token-meter` skill**：在 Codex 里问“子 agent 用了多少 token”时，Codex 会调用 `summary` / `json` 回答并给出仪表盘地址。

### 悬浮小窗

```bash
node plugins/codex-token-meter/bin/codex-token-meter.js mini
```

或在网页仪表盘右上角点“悬浮窗”，或直接打开 `http://127.0.0.1:4399/mini`。

- 下拉框默认“自动跟随当前 Codex 会话”：在哪个 Codex 窗口/会话里发消息，小窗就切到哪个会话；也可以选中某个会话固定显示。
- 点“置顶”会弹出画中画窗口（Document Picture-in-Picture，Chrome / Edge 116+），始终浮在 Codex 等其他窗口上方，可拖动、缩放；关闭画中画后回到普通页面。

在终端 / IDE 里没有桌面版内嵌面板时，置顶悬浮窗仍是首选的“一直可见”方案（见下一节）。

### 桌面版内嵌小组件

`token_usage` 工具带有 `openai/outputTemplate` 元数据（MCP App）。在 ChatGPT 桌面版 / Codex Desktop 里，当模型调用 `token_usage`（比如你问“现在用了多少 token”）时，会在会话中内嵌渲染一个实时面板：随调用所在会话定位、每 1.5 秒从本地仪表盘拉取最新数据、仪表盘不在线时回退为调用时的快照并提示。小组件支持 inline / fullscreen / pip 显示模式。

**自动显示（不需要主动问）**：插件的 `UserPromptSubmit` hook 会向模型上下文注入一条指令，让模型每轮回复时自动调用一次 `token_usage`——每条回复里都带一个实时 token 面板。想关掉这个自动注入，把环境变量 `CODEX_TOKEN_METER_NUDGE=0` 设上即可。

### 桌面版内嵌面板（0.3.0 原型）

和上面那个每条回复自动出现的小组件不同，这个面板是你主动从侧边栏或会话里打开的。这是“把插件做成 Codex 软件内部的小窗口”的第一版，基于 OpenAI 的 Plugin Extensions / MCP Extensions（2026-09-29 DevDay 发布）：

- **这是什么**：MCP 服务新增一个 `token_meter_panel` 工具，带两个入口（entrypoint）——`thread`（会话内的内容页 / 侧边面板，离“内部小窗口”最近）和 `global`（桌面版侧边栏入口）。两个入口打开的是同一个紧凑面板（复用悬浮小窗的界面：每 agent 的 token + 费用、会话切换、刷新）。
- **怎么打开**：在 Codex 桌面版里安装插件后，从侧边栏找到 Token Meter，或在某个会话里打开它的面板（具体入口位置以你那版桌面应用为准；入口由桌面应用按 `_meta["openai/ui"]["entrypoints"]` 渲染）。
- **数据怎么来**：面板在沙箱里运行，**不联网、不读本地文件、不访问 `http://127.0.0.1:4399`**。所有数据都来自 MCP 工具的 `structuredContent`（整份快照：会话、每 agent 用量与费用、定价日期），面板每 5 秒重新调一次 `token_meter_panel` 刷新。下拉框默认“自动：当前对话”，按这个顺序决定显示哪个会话：① 宿主在工具调用里带的会话 ID（`_meta.threadId`）；② 你最近一次发消息的会话（插件 hook 记录在本地仪表盘里）；③ 最新的会话。面板标题下方会写明用的是哪一种；也可以在下拉框里手动选。
- **需要什么**：Codex 桌面版 + 本插件的本地 MCP 服务（插件装好后自动启动）。只读本机 rollout 数据，不上传任何东西。

**诚实的限制（请先读这段）**：

- 这是**原型**，**没有在真实 Codex 桌面版里测试过**——本机没有可装桌面版的环境，只在本地用 `npm test` 验证了入口元数据、UI 资源和工具返回（见 `test/desktop-panel.test.js`）。真实桌面版里入口是否出现、面板是否渲染、刷新是否正常，都需要你在自己的桌面版上手动验证。
- 按 MCP Extensions 规范，**入口打开的应用一律全屏显示**（`ChatGPT uses fullscreen for all entrypoints`），所以它**不是**一个可以置顶、可以拖来拖去的悬浮窗；它是在 Codex 应用内部打开的一页。想要“一直浮在所有窗口上面”时，仍用悬浮小窗。
- 不用装任何新依赖：没引入 `@openai/mcp-extensions` SDK——那个 SDK 是给用 `@modelcontextprotocol/sdk` 写的服务准备的包装，本插件的 MCP 服务是手写 stdio JSON-RPC，直接按 MCP Apps 协议实现就够了。

**手动测试步骤（在你的桌面版上）**：

1. 更新插件到 0.3.0（或切到 `feat/desktop-panel` 分支），重启 Codex 桌面版，确认插件已加载。
2. 在 Codex 桌面版里开一个会话，先发一条消息产生 token 用量。
3. 找侧边栏的 Token Meter 入口打开面板；再在会话里找面板入口打开一次。确认两种入口都能打开同一张面板。
4. 面板应显示：总 token、费用估算、输入 / 缓存 / 输出 / 推理四格、主 agent + 子 agent 列表（每个带模型和费用）。
5. 再发一条消息，5 秒内面板数字应变化；点「刷新」应立即更新；在面板下拉框里切到另一个会话应显示那个会话的数据。
6. 如果某个入口没出现或面板空白，请把桌面版版本号和当时的表现告诉我（也可能只是该版本的桌面版还没支持 thread/global 入口）。

### 在 ChatGPT 桌面版里使用（0.4.0）

ChatGPT 桌面版和 Codex 共用同一套插件格式，同一个插件不用改就能装。插件清单里声明了 `requires_local_executor`，因为它要在你电脑上运行本地 MCP 服务、读取本机 Codex 会话文件。

1. 把仓库加成插件来源（二选一）：
   - 命令行：`codex plugin marketplace add /path/to/codex-token-meter`（或 Git 地址）；
   - 或者把仓库放在项目里，ChatGPT 桌面版会读取 `.agents/plugins/marketplace.json`。
2. 重启 ChatGPT 桌面版，打开 Plugins Directory，选择 “Codex Token Meter” 来源，安装插件。
3. 在**本地运行的对话**（Work 模式，或桌面版里的 Codex）里打开 Token Meter 面板：会话旁边的面板入口（`thread`），或侧边栏入口（`global`）。
4. 面板显示当前对话的总 token、输入 / 缓存 / 输出 / 推理 token、每个 agent 的模型和费用估算，以及子 agent 树，每 5 秒刷新一次。

限制：

- 只能用在本地运行的对话里。本地 MCP 插件只能在 ChatGPT 桌面版安装；普通云端聊天不会在本机写会话文件，文档里也没有给插件读取其 token 用量的接口，所以看不到普通聊天的 token。
- ChatGPT 只支持 `inline` / `fullscreen` 显示模式，不支持画中画。想让面板一直浮在窗口上方，用「悬浮小窗」。
- 如果 ChatGPT 打开面板时没有带会话 ID，面板会显示你最近发消息的会话（需要插件 hook 已信任并运行），否则显示最新会话。
- 插件故意没有改用根目录的 `plugin.json`（Agent Plugins 格式）：实测 Codex 0.171 对这种格式的插件不加载 hook，会丢掉自动启动仪表盘和会话跟随。`.codex-plugin/plugin.json` 仍是官方支持的兼容格式。
- 尚未在真实的 ChatGPT 桌面版里验证（需要 macOS / Windows 和登录账号）；协议层用 `npm test` 和真实 Codex 0.171 验证过。

### Codex CLI 状态栏

在 `~/.codex/config.toml` 中开启实验功能并选择本插件作为状态栏：

```toml
features.tui_extensions_statusline = true

[tui]
status_line_provider = { server = "token-meter", tool = "token_usage" }
```

重启 Codex 后底部会显示：当前线程的 total、输入（缓存）、输出（推理）、费用估算、最近一次请求增量、模型，以及子代理数量、子代理合计和会话合计，每秒刷新，切换线程时自动跟随。也可以在 Codex 里用 `/statusline` 选择。

## 开发

```bash
npm test                 # node:test，含真实 Codex rollout 作为 fixture
npm run mock             # 本地 mock Responses API（:18080），用于无 key 生成父子 agent 会话
```

mock 用法：在 `$CODEX_HOME/config.toml` 中配置 `model_provider = "mock"`，`base_url = "http://127.0.0.1:18080/v1"`，然后 `codex exec "SPAWN_TEST"` 会生成一个主 agent 和两个子 agent（explorer / worker），子 agent 会多轮请求，便于观察实时变化。`MOCK_CHILD_DELAY_MS`、`MOCK_CHILD_STEPS` 可调节节奏。

## 限制

- 费用是按 OpenAI API 定价的估算，不是账单；定价以 <https://platform.openai.com/docs/pricing> 为准，内置定价表见「费用估算」。
- 只读取本机 rollout 文件；网页服务默认只监听 127.0.0.1。
- 桌面版内嵌面板是原型，**未在真实 Codex 桌面版 / ChatGPT 桌面版里验证过**（见「桌面版内嵌面板」的手动测试步骤）；入口打开的应用按规范是全屏页，不是置顶悬浮窗。
