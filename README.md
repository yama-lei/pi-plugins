# pi-packages
My pi packages for daily development. Some of the packages are forked and some of they are built from scratch. Star the repo if you like it. 
You can also find some awesome pi/dsh plugins in my star list [Pi&&Dsh Plugins](https://github.com/stars/yama-lei/lists/%E5%8E%9F%E7%A5%9E%E6%8F%92%E4%BB%B6)

## Packages

| Package| Desc | README File |
| --- | --- | --- |
| `pi-profile` | 项目级 Pi profile 初始化与全局 JSON 模板 | [packages/pi-profile/README.md](packages/pi-profile/README.md) |
| `pi-better-ai` | 增强 AI 认证、模型发现与 Provider → Models 选择 | [packages/pi-better-ai/README.md](packages/pi-better-ai/README.md) |
| `pi-monitor` | 持续监听命令输出 / WebSocket，并把事件批量送入对话 | [packages/pi-monitor/README.md](packages/pi-monitor/README.md) |
| `pi-subagent` | 可观察、持久化的 tmux 子代理（基于上游 earendil-works/pi-subagent 二开） | [packages/pi-subagent/README.md](packages/pi-subagent/README.md) |
| `pi-skill-foundations` | 基础 skills：`agents-md`、`communication`、`skill-creator`（源自 howaboua/pi-skill-foundations） | [packages/pi-skill-foundations/README.md](packages/pi-skill-foundations/README.md) |

## Development

需要 Node.js 22.19+ 和 Pi。本地安装请使用包目录，不要使用仓库根目录：

```bash
pi -e ./packages/<name>/index.ts                      # 临时加载
pi install /absolute/path/to/pi-packages/packages/<name>   # 长期注册
```

```bash
npm run check
npm test                              # 运行所有工作区的测试
npm --prefix packages/<name> test     # 只测某个包
npm pack --dry-run ./packages/<name>
```

