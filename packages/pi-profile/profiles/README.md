# Profile 示例

这四份 JSON 是本项目格式的资源清单，不是上游的 settings.json，也不是作者完整运行环境的备份。

| 示例 | 原始仓库 | 收录范围 |
| --- | --- | --- |
| [howaboua.json](howaboua.json) | [IgorWarzocha/howaboua-pi-stuff](https://github.com/IgorWarzocha/howaboua-pi-stuff) | 13 个独立扩展包，另列 15 个源码 skills |
| [ben-vargas.json](ben-vargas.json) | [ben-vargas/pi-packages](https://github.com/ben-vargas/pi-packages) | 10 个维护中的 extension/theme 包 |
| [narumiruna.json](narumiruna.json) | [narumiruna/pi-extensions](https://github.com/narumiruna/pi-extensions) | 28 个 npm 扩展包，避开已知互斥组合和上游源码安装限定 |
| [gotgenes.json](gotgenes.json) | [gotgenes/pi-packages](https://github.com/gotgenes/pi-packages) | 全部 9 个公开 Pi 包，保留依赖顺序 |

本次已核对上游 README、package.json 和 npm registry 的包名及 Pi 资源声明；未实际安装这些资源，也未验证它们在当前 Pi 上的运行兼容性。npm 来源不锁版本，后续使用前仍需核对。

## 收录取舍

### Howaboua

将上游 [pi-stuff 通用 bundle](https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/main/packages/pi-stuff) 拆为扩展和 skills 两份明确清单，方便按需删选。

- `plugins` 只列 13 个独立通用扩展；不再安装 bundle 或 `pi-skill-*` npm 包。
- `skills` 明确列出 15 个可共享 skill 名称，按 Chrome CDP、Code、Foundations、Harness and Agent Engineering 的 4 个源码目录分组。通过 Skills CLI 的项目 copy 模式安装，不重复安装 npm skill 包。
- 来源 URL 限定到上游公开 skill 包的目录，避免仓库其他目录里同名的开发专用 skills 被一并发现。

遵循上游 bundle 的边界，不额外加入 Browser、Codex 集成、Guardian、Agent Board、Sites、Notes Compaction、Sandbox、嵌套 AGENTS loader、Omarchy 专用支持或已退休包。需要这些功能时，可自行审阅上游独立包并加入清单。

### Ben Vargas

收录上游维护中的 10 个包，包括 `pi-themes`。`plugins` 在本格式中是 Pi npm 包安装清单，因此也能承载主题包。该仓库没有可单独收录的 skills，保留 `skills: []`。

不收录 [pi-antigravity-image-gen](https://github.com/ben-vargas/pi-packages/tree/main/packages/pi-antigravity-image-gen)：上游已明确停用，并警告第三方 Antigravity 接入存在 Google 账号风险。

### Narumiruna

- footer 选择 `pi-starship`，不同时加载 `pi-statusline`；需要后者时替换前者。
- compaction 选择 `pi-codex-compact`，不同时加载 `pi-context-management` 或 `pi-typesafe-compact`。若更换压缩方案，应移除现有方案，而不是直接追加；已有 opaque checkpoint 的会话还需按上游说明先处理恢复。
- 不收录 `pi-subagents`、`pi-inspect`、`pi-notify`：上游 README 仍要求源码安装，或提示 npm 与源码功能不同。虽然 registry 已有同名包，本示例保守地不将其视为文档所述源码功能的等价安装。
- 不收录扩展开发库 `pi-tui-kit`、私有 showcase 或 `deprecated/` 内容。

已收录的 npm 包自带 `herdr`、`configure-pi-starship`、`configure-pi-sync`、`typesafe-ai` 四个 skills，由 Pi 原生加载，不再放入 `skills` 重复复制。`using-pi-subagents` 对应的扩展未收录，亦不单独添加。

互斥和安装要求见[上游总览](https://github.com/narumiruna/pi-extensions)、[TypeSafe Compaction 说明](https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-typesafe-compact)。

### Gotgenes

保留全部 9 个包；`pi-permission-system` 排在 `pi-permission-model-judge` 前面，`pi-subagents` 排在 `pi-subagents-worktrees` 前面。后者依赖 core 先加载，见[上游安装说明](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-subagents-worktrees)。

`pi-colgrep` npm 包自带 `colgrep` skill，由 Pi 原生加载，不再放入 `skills` 重复复制。仓库 `.pi/skills/` 中的开发维护指令不作为通用资源安装。

## 使用与限制

- 示例不会自动注册、安装或修改全局配置。审阅并删减后，可将一份 JSON 复制为项目 `.pi/profile.json`，再执行 `/profile sync`；项目已有清单时不要直接覆盖。
- 若想作为命名模板使用，可将 JSON 复制到 `~/.pi/agent/profile-templates/`（遵循 `PI_CODING_AGENT_DIR`）；不要覆盖同名模板。注册后才能使用如 `/profile init howaboua` 的命令。
- `skills` 声明需要额外通过 Skills CLI 复制的 skills。Howaboua 的 15 个 skills 在此单独列出；其他示例中的 `skills: []` 不代表完全没有 skills，Narumiruna 和 Gotgenes 的部分 npm 扩展自带 skills，由 Pi 原生加载，避免重复复制。
- 不下载上游仓库根部的 `AGENTS.md`，也不复制其开发专用 skills、prompts、settings 或凭据；这些是上游项目自身的维护约定，不是通用用户配置。
- 安装不等于配置完成。Synthetic、Firecrawl、TypeSafe、Langfuse 等需要相应服务凭据；Herdr、LSP、Starship 配置、ColGrep、GitHub CLI 等有各自的工具或配置前提。权限系统及模型 judge 也应按上游说明审阅策略和模型设置。不要把凭据写进 profile。
- 部分包提供远程调用、追踪、同步、自动执行或权限拦截功能。请先审阅其数据流和默认行为；profile 只负责经确认后安装，不配置或约束扩展运行时行为。
- 四份清单是独立示例，不建议直接叠加启用：不同作者的扩展可能争用命令、工具、模型处理或 compaction hooks。Pi 原有全局资源仍会加载，sync 不会卸载清单之外的包。
