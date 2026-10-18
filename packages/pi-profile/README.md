# Pi Profile

从项目的 `.pi/profile.json` 初始化 npm 插件、skills 和可选的 AGENTS.md，也可让当前 LLM 帮你选择资源、生成清单。

需要 Pi、Node.js 22.19+、npm/npx；Git 来源的 skills 还需要 Git。

## 安装

```bash
pi install npm:@yama-lei/pi-profile
```

本包只加载 profile 扩展，不自动加载 `pi-better-ai`、示例清单或其他 skills。

## 命令

- `/profile init [name]`：选择全局 JSON 模板，预览确认后生成项目配置并安装；也可以选择通过 LLM 创建。
- `/profile sync`：读取当前项目的配置，预览确认后安装；修改配置后可再次执行。
- `/profile-setup-with-llm [需求描述]`：询问工作流、核对资源来源，展示 JSON 并征求批准，可选注册全局模板。没有搜索能力时不会声称已完成检索。

保存和安装都需要交互确认。安装成功后使用 Pi 原生 reload；无 UI 的 print/JSON 模式不会静默安装。

## 配置

项目清单位于 `.pi/profile.json`：

```json
{
  "plugins": ["npm:@pi-archimedes/diff", "npm:pi-gpt-search"],
  "skills": [
    {
      "source": "vercel-labs/agent-skills",
      "skills": ["web-design-guidelines"]
    }
  ]
}
```

- `plugins` 和 `skills` 是必填数组，可以为空。plugins 仅接受不带版本的 npm 来源。
- skill 来源支持 `owner/repo`、HTTPS 和 Git SSH；skill 名称必须明确，不支持通配符。
- 可选 `AGENTS.md` 字段接受原始 Markdown 的 HTTPS 下载 URL，不接受 GitHub HTML 页面；下载有超时、重定向和 1 MiB 大小限制。
- 未知字段会报错；不要放入 API key 或其他敏感信息。

示例在 [`profiles/`](profiles/) 中：`howaboua.json`、`ben-vargas.json`、`narumiruna.json`、`gotgenes.json`，分别改写自四个上游 Pi 包仓库，不会自动注册或安装。来源、收录取舍和配置要求见[示例说明](profiles/README.md)；使用前请审阅并删减，不建议叠加启用全部示例。

## 安装范围与保护

npm 插件使用 Pi 的 `--local` 安装；skills 使用 Skills CLI 的项目 copy 模式；AGENTS.md 下载到项目根目录。

全局模板默认保存在 `~/.pi/agent/profile-templates/`（遵循 `PI_CODING_AGENT_DIR`），只保存 JSON，不保存已安装资源、凭据或运行时设置。

不覆盖已有项目清单或同名模板。已有 skills 和 AGENTS.md 会跳过并报告；冲突的部署符号链接会被拒绝。安装失败不回滚已完成的资源，应修复问题后重试。

本包不是 profile 切换器、隔离沙箱或自动升级服务；不管理 MCP、Git 修订或共享资源存储，也不屏蔽 Pi 原生全局资源及项目可信机制。
