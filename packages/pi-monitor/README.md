# Pi Monitor

持续监听命令 stdout 或 WebSocket 文本消息，把事件主动送入 Pi 对话，不需要模型轮询。每批事件都能触发模型处理，适合跟踪错误日志、部署事件和 PR 状态流。

## 加载与试用

在仓库根目录临时加载：

```bash
pi -e ./packages/pi-monitor/index.ts
```

长期注册本地开发包：

```bash
pi install /absolute/path/to/pi-packages/packages/pi-monitor
```

移除时对同一路径运行 `pi remove`。这不会删除已经保存的监听输出文件。

对模型说：

> 用 Monitor 演示持续通知。每 2 秒输出一个 tick，输出三次后打印 done 并退出，超时 60 秒。

工具调用与通知按下面的结构呈现，颜色跟随 Pi 主题：

```text
Monitor(演示：每2秒输出一次计时并最终结束)
└ Monitor started · task a1b2c3d4 · timeout 60s

● Monitor event: tick 1 · 演示：每2秒输出一次计时并最终结束
● Monitor event: tick 2 · 演示：每2秒输出一次计时并最终结束
● Monitor event: tick 3 · 演示：每2秒输出一次计时并最终结束
● Monitor event: done · 演示：每2秒输出一次计时并最终结束
● Monitor "演示：每2秒输出一次计时并最终结束" stream ended
```

模型的回复由当前模型生成，不固定复刻示例截图中的解说。展开工具结果或通知可以查看任务 ID 和输出文件路径。

## Monitor 参数

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `description` | string | 是 | 每条通知的标签，单行非空，最多 200 字符。 |
| `timeout_ms` | number | 是 | 默认 300000。非持久任务接受 1000–3600000 的整数毫秒，包含连接建立时间。`persistent: true` 时忽略。 |
| `persistent` | boolean | 是 | 默认 false。true 时一直运行到当前会话关闭、reload、切换会话或手动停止。不会跨会话恢复。 |
| `command` | string | 二选一 | 在当前工作目录执行的 shell 命令。每个 stdout 行是一个事件，进程退出且输出排空后结束。 |
| `ws` | object | 二选一 | `{ url, protocols? }`。URL 使用 `ws://` 或 `wss://`，protocols 是不重复的协议字符串数组。不能同时指定 command。 |

工具立即返回 `task_id`、`output_file` 和 `stderr_file`。schema 中前三项为必填，并声明默认值。底层程序化接口省略超时和持久标记时也使用上述默认值。

```javascript
Monitor({
  command: "tail -f app.log | grep --line-buffered -E 'ERROR|Traceback|FATAL'",
  description: "app.log 中的错误",
  timeout_ms: 300000,
  persistent: true
})
```

```javascript
Monitor({
  ws: { url: "wss://events.example.com/stream", protocols: ["v1"] },
  description: "部署事件",
  timeout_ms: 600000,
  persistent: false
})
```

WebSocket 使用 Node.js 原生客户端。每个完整的文本消息是一个事件，包括包含换行的消息。二进制消息不进入事件流。连接关闭就结束，不重连，不发送额外订阅消息，也不支持自定义认证请求头。不要在 URL 中嵌入用户名或密码。

## 查看监听列表与详情

```text
/monitor                 # 默认打开列表，与 /monitor ls 相同
/monitor ls
/monitor stop a1b2c3d4    # 立即停止指定任务，不经过模型
```

原来的 `/monitor-stop` 已替换为 `/monitor stop <id>`。命令支持补全子命令，以及当前正在运行的任务 ID。

TUI 列表显示 `ID`、`STATUS`、`DURATION`、`EVENTS` 和 `TITLE`。TITLE 使用启动时的 `description`，不新增工具参数。运行中的任务排在前面，已结束的任务按结束时间从新到旧排列。持续时间从任务启动开始计算，结束后冻结。

- `↑`、`↓` 选择任务，Enter 打开详情。
- 详情显示状态、持续时间、事件数、启动时间、结束时间、命令或 WebSocket 地址、结束原因和日志路径。
- 默认查看 stdout，Tab 切换 stderr。`↑`、`↓` 滚动，PageUp、PageDown 翻页，Home 回到顶部，End 回到底部并跟随新输出。
- 列表和详情每 250 毫秒刷新。向上滚动时暂停跟随，便于回看；重新到达底部或按 End 恢复跟随。
- Esc 从详情返回列表，再按 Esc 关闭。关闭浏览器不会停止监听，也不会把查看的日志发给模型。

详情按需读取每个日志文件最后 64 KiB，超出时明确标记，避免大日志卡住终端。完整原始输出仍在详情列出的文件中。stderr 仅在查看详情时展示，不因此进入事件通知流。

当前会话最多保留 100 个已结束任务的元数据，另加最多 8 个正在运行的任务。淘汰旧元数据不会删除日志文件。reload、退出或切换会话会清空这份列表，不恢复旧监听任务。

RPC 客户端使用原生选择对话框展示列表，选中后查看 stdout、stderr 和任务详情，再返回列表。RPC 对话框不实时刷新，返回列表时更新快照。无 UI 的 print/JSON 模式不支持浏览器。

## 停止与结束

除了 `/monitor stop <id>`，模型仍然可以调用：

```javascript
TaskStop({ task_id: "a1b2c3d4" })
```

`TaskStop` 和 `/monitor stop <id>` 只管理本扩展在当前会话中启动的任务，不接管其他扩展的后台任务。已结束或不存在的 ID 会报错，但已结束任务仍可在列表中回看。

正常退出、非零退出、WebSocket 错误、超时、手动停止和超量停止都会发送结束通知。退出码和 WebSocket 关闭码会出现在相应通知中。会话关闭、reload 或切换时静默清理，不把旧任务通知发送到新会话。

命令在 POSIX 系统中使用独立进程组，停止时杀掉整个进程组。主动脱离进程组的守护进程不受此保证。Windows 使用 `taskkill /F /T`，尚未实机验证。监听不是系统级守护服务，无法保证强制杀掉 Pi 或断电时完成清理。

## 过滤、缓冲与通知

- 只输出需要处理的事件，过滤条件同时覆盖成功与失败。例如 `Ready|Traceback|Error|FAILED`，避免过滤掉崩溃信号。
- 管道要及时刷新。`grep` 使用 `--line-buffered`，`awk` 使用 `fflush()`，Python 可以使用 `-u`。`head` 会在达到行数后关闭管道，不适合持续订阅。
- stderr 只写入 `stderr_file`，不会成为事件。需要错误进入事件流时，把命令写成 `your-command 2>&1`。
- 保留空行作为事件，合并 CRLF，按 UTF-8 增量解码。命令结束时，最后一个没有换行的片段也作为事件发送。
- 从本批第一条事件起计时，200 毫秒内的事件合为一条通知。结束时立即发送未满 200 毫秒的最后一批，再发送结束通知。
- Pi 正在处理其他工作时，通知通过 `followUp` 排队，模型完成当前工作后接收。200 毫秒是采集窗口，不是模型响应时间保证。
- 通知可能触发新的模型请求并产生费用。模型看到的外部内容明确标为数据，不是指令。终端控制字符会被清除，但这不是提示注入隔离机制。
- stdout 原始字节和 stderr 分开保存在临时目录的 `stdout.log`、`stderr.log`，文件权限为 0600。停止后保留，便于排错，需要时自行删除。原始日志可能包含敏感信息，不要把密钥输出到流中。

如果只需要完成时通知一次，应使用宿主提供的后台完成工具。本扩展不增加或依赖 Bash 的 `run_in_background` 参数。

### 自动停止阈值

每个任务独立计数，达到允许量后再有超额输出就停止，并报告原因。

| 项目 | 上限 |
| --- | --- |
| 同时运行的任务 | 8 个 |
| 滚动 1 秒事件数 | 100 条 |
| 任务累计事件数 | 1000 条 |
| 单个事件或未换行 stdout 片段 | 16 KiB |
| 单批事件内容 | 32 KiB |
| 滚动 1 秒文本输出，含 stderr | 1 MiB |
| 任务累计落盘输出，stdout 与 stderr 合计 | 10 MiB |

原生 WebSocket 在交付完整文本消息后才检查大小，本扩展不是恶意 WebSocket 服务的内存隔离边界。输出超限时日志最多保留到落盘上限，导致停止的最后一块输出不保证进入事件流。`persistent` 不绕过这些限制。

## 测试

```bash
npm --prefix packages/pi-monitor run check
npm --prefix packages/pi-monitor test
npm pack --dry-run ./packages/pi-monitor
```

常规测试使用临时目录、本地命令、模拟 WebSocket 和回环 WebSocket 服务。渲染测试复用本机 npm 安装的 Pi，可以用 `PI_HOST_DIR` 指定宿主包目录。测试不安装资源，不修改个人 Pi 配置，也不调用付费模型。

显式运行真实模型集成测试：

```bash
npm --prefix packages/pi-monitor run test:live
```

该测试调用真实 `pi` RPC 进程，强制选择 `openai-codex/gpt-6-luna` 并断言模型 ID，不自动回退。它会产生模型请求费用。认证和模型缓存复制到临时 agent 目录，临时项目、会话及认证副本在结束后清理，不修改个人配置。测试涵盖逐次事件、批量通知、WebSocket、stderr 分离、非零退出、超时、`TaskStop`、`/monitor stop`，以及 `/monitor` 和 `/monitor ls` 的列表、详情与返回流程。回环连接在测试进程中显式绕过代理。失败时将事件记录路径打印出来，供排查。
