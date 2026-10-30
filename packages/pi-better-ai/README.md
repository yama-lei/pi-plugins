# Pi Better AI

增强 Pi 的 AI 认证、模型发现，以及 Provider → Models 选择界面。

这是独立扩展，不依赖其他包，安装其他包也不会自动启用它。需要 Pi 和 Node.js 22.19+。

## 安装

```bash
pi install npm:@yama-lei/pi-better-ai
# 本地开发
pi install /absolute/path/to/my-pi-extensions/packages/pi-better-ai
```

## Web 搜索 / 抓取

当至少有一个渠道可用时，自动启用 `web_search`；有支持读取网页的渠道时再启用 `web_fetch`。没有任何渠道时两个工具都不会激活。

渠道（按已有登录/凭据判断）：

- **OpenAI Codex**：Codex 独立搜索端点（`chatgpt.com/backend-api/codex/alpha/search`，非公开 alpha 接口，可能随时变化）。搜索 + 抓取（`open` 命令）。
- **DeepSeek**：`POST https://api.deepseek.com/v1/tools/search` 与 `/v1/tools/fetch`。搜索 + 抓取。
- **自定义 provider**：对 `<endpoint>/tools/search` 探测一次（DeepSeek 格式，new-api 等中转可能支持），成功才启用；仅搜索。

优先级：当前模型所属 provider 的渠道优先，其余按 Codex → DeepSeek → 自定义；失败自动回退到下一个。

可选配置 `~/.pi/agent/pi-better-ai.json`（Pi agent 目录）：

```json
{ "web": { "order": ["deepseek", "openai-codex", "custom"], "disabled": ["custom"], "preferCurrentProvider": true } }
```

`order` 中未列出的渠道排在其后；无效内容会被忽略并使用默认值。`/web-status` 显示当前可用渠道及顺序。会话启动和切换模型时刷新；新登录后请切换一次模型或运行 `/web-status`。

注意：DeepSeek/自定义渠道的搜索按次计费。

## 开发

```bash
npm --prefix packages/pi-better-ai test
```

测试复用本机已安装的 Pi（或由 `PI_HOST_DIR` 指定），不修改个人 Pi 配置。
