# Pi Profile

一个轻量的 Pi 扩展：从 `profile.json` 初始化当前项目的 **npm 插件、skills 和 AGENTS.md**，也可以让当前 LLM 帮你挑选资源、生成配置。

**全局只保存可复用的 JSON 模板。** 不共享已安装资源，不切换运行环境，不管理 Git、版本合并或 MCP。不替代 `pi` 启动命令，也不修改或屏蔽原有的全局资源。

## 安装扩展

需要 Pi、Node.js 22.19+、npm/npx；skills 的 Git 来源还需要 Git。已在 Pi 1.3.0、Linux 环境验证扩展加载与命令交接；macOS/WSL 尚未实测，不承诺原生 Windows 命令兼容性。

发布到 npm 后：

```bash
pi install npm:@yama-lei/pi-profile
```

尚未发布时，在仓库根目录临时加载开发版：

```bash
pi -e ./packages/pi-profile/index.ts
```

或长期注册本地开发包：

```bash
pi install /absolute/path/to/my-pi-extensions/packages/pi-profile
```

仓库根目录是不可发布的 npm workspace，不是 Pi 扩展包。两个扩展分别位于 `packages/pi-profile/` 和 `packages/pi-better-ai/`，独立安装、独立发布；安装 profile 包不会自动加载仓库的 `skills/` 或 `pi-better-ai`。后者说明位于 `packages/pi-better-ai/README.md`。npm 名称暂用 `@yama-lei` scope；发布前必须确认你拥有该 npm 用户/组织。

## 三个操作

### `/profile init [name]`

- 列出用户全局注册的 profiles，选择一个后生成项目 `.pi/profile.json`。
- 同时提供“通过 LLM 创建”选项；没有模板时也可直接走该流程。
- 预览确认后直接执行安装，成功后调用 Pi 原生 reload。
- 已知模板名时，可以直接输入 `/profile init howaboua`（需先注册该模板）。
- 项目已有 `.pi/profile.json` 时不覆盖；修改它后用 `/profile sync`。

### `/profile sync`

读取当前工作目录的 `.pi/profile.json`，预览资源及作用范围，确认后：

1. 通过 `pi install <npm:source> --local` 安装插件。
2. 通过 `npx --yes skills add <source> --skill <names...> --agent pi --copy --yes` 安装 skills，不传 `--global`。
3. 下载 AGENTS.md 到项目根目录。
4. 报告结果，成功后 reload。

这里的 sync 是“按清单安装”，不是双向同步、切换、全局安装或自动升级服务。npm 来源不锁版本，再次显式 sync 时由 npm/Pi 决定解析的版本。

### `/profile-setup-with-llm [需求描述]`

向当前会话发送配置引导，不另开 Agent、不调用独立模型 API、不内置搜索引擎：

1. 询问项目类型、偏好的 skills/plugins、日常工作流与限制。
2. 复用可用的搜索工具，参考 [Pi Packages](https://pi.dev/packages)、[Awesome Skills](https://awesome-skills.com/)、[skills.sh](https://skills.sh/) 及原始仓库。
3. 核对 npm 包、skill 名称和 Pi 兼容性，说明推荐理由并给出来源；没有搜索能力时明确说明，不能编造检索结果。
4. 展示最终 JSON，征求用户批准，并询问是否注册一个全局模板名。
5. 调用扩展的 `profile_save` 工具。工具再次校验并确认后保存项目配置、可选全局模板，排队运行 `/profile sync`。

`profile_save` 只保存配置和排队，不把“排队成功”当成“安装成功”。安装仍有独立的预览确认。全局模板先于安装保存，不依赖资源是否已下载成功；失败时可修正项目配置再 sync。

这些有写入/安装行为的入口需要交互确认：支持 TUI 或具备 Pi 对话能力的 RPC 客户端；无 UI 的 print/JSON 模式不会静默安装。

## profile.json

```json
{
  "plugins": ["npm:@pi-archimedes/diff", "npm:pi-gpt-search"],
  "skills": [
    {
      "source": "vercel-labs/agent-skills",
      "skills": ["web-design-guidelines"]
    }
  ],
  "AGENTS.md": "https://example.com/project-instructions.md"
}
```

这是我们自己的清单格式，不是 Vercel 的 `skills-lock.json`：

- `plugins` / `skills` 是必填数组，允许 `[]`。
- plugins 只接受不带版本号的 `npm:name` / `npm:@scope/name`。
- skill 来源支持 `owner/repo`、HTTPS URL、Git SSH URL；下载和发现交给 [Vercel Skills CLI](https://github.com/vercel-labs/skills)。本工具只接受明确的、小写连字符 skill 名称，不支持 `*`、本地路径或完整的上游 CLI 选项集。
- `AGENTS.md` 可省略；填写时只接受无内嵌认证信息的 HTTPS 下载 URL。应使用原始 Markdown，不是 GitHub HTML 页面。下载有超时、1 MiB 上限和 HTTPS 重定向限制。
- 未知字段会报错，MCP 暂不支持。不要放入 API key、认证文件或项目敏感信息。

上面的 Markdown 地址只是占位示例，使用前替换或删除该字段。

## 文件位置与全局模板

```text
项目/
├── .pi/
│   ├── profile.json           # 项目实际使用的清单
│   ├── settings.json          # Pi 管理的项目包声明
│   └── npm/                   # Pi 下载的插件及依赖
├── .agents/skills/            # Skills CLI 的 Pi 原生支持位置；项目独立副本
├── skills-lock.json           # Skills CLI 自行管理的记录（若生成）
└── AGENTS.md                  # 可选的项目指令

~/.pi/agent/profile-templates/
└── howaboua.json              # 可复用的 JSON，不是安装目录
```

`PI_CODING_AGENT_DIR` 决定模板目录的上级 Pi agent 目录。注册模板只影响 `profile-templates/`，不改 Pi 的全局 settings/auth/trust，不把资源装到全局。

可以通过 LLM 引导注册，也可审阅后手工复制 JSON 到模板目录。示例在 [`packages/pi-profile/profiles/`](packages/pi-profile/profiles/) 中，不会自动注册或安装。

当前提供 `howaboua`、`ben-vargas`、`narumiruna`、`gotgenes` 四份示例，分别根据对应上游仓库的 Pi npm 包编写，遵循本项目的 profile 格式。来源、收录范围、互斥包取舍和额外配置要求见[示例说明](packages/pi-profile/profiles/README.md)。这些是独立的资源清单，不是建议叠加启用的组合；使用前请审阅并删减。

## 保护与限制

- 不覆盖项目配置或同名全局模板；注册冲突时请选新名称。
- 已有的 skills（`.agents/skills/` 或 `.pi/skills/`）和项目 AGENTS.md 会保留并报告跳过，包括失效链接。需要替换时请先自行审阅、备份、移走。
- 拒绝通过部署目录/设置文件的符号链接写入外部位置，避免旧共享安装目录被当成本地安装。
- 不卸载项目额外资源，不清理现有全局包，不更改项目信任。Pi 的全局资源仍按原生规则加载；这是初始化工具，不是隔离或沙箱。
- 安装不是事务。一个资源失败时，之前成功安装的资源会保留；修复后重跑 sync，插件安装委托 Pi，已存在的 skills 不会重写。
- 包和 skills 中的代码/指令有真实权限，搜索排名不等于安全或兼容性保证。npm/npx/Skills 自身的缓存和安装记录遵循上游行为。同一项目里其他支持 `.agents/skills/` 的工具也可能发现这些 skills。
- 如果全局也装了同一包，Pi 原生包身份与项目优先级规则仍生效；用户自己配置的资源排除不由本工具清除。

旧的 `install.sh` / `install.mjs` 及“中央目录链接到项目”的逻辑已移除。旧项目中的已有链接不会被自动迁移或删除；在旧目录上操作前，请审阅、备份并手动解除旧安装，再建立新清单。

## 开发与测试

```bash
npm run check
npm test
npm pack --dry-run ./packages/pi-profile
npm pack --dry-run ./packages/pi-better-ai
```

根目录的 `npm test` 运行两个工作区的测试。各包测试位于自己的 `tests/` 中，也可用 `npm --prefix packages/pi-profile test` 或 `npm --prefix packages/pi-better-ai test` 单独运行。profile 测试使用临时目录及模拟的 Pi/npm/Skills/下载响应，不安装真实资源、不修改个人 Pi 配置。`pi-better-ai` 测试另外复用本机 Pi 安装。

历史方案与来源调研保留在 `docs/research/`，不是当前功能规格；以本 README 和代码为准。
