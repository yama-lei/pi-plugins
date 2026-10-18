# Pi Profile Initialization

本工具在 Pi 当前会话内选择或创建资源清单，并初始化项目。不管理运行环境切换、共享资源存储、Git 修订或版本合并。

## Language

**Profile**：
一份项目初始化清单，声明 npm plugins、skills 来源与名称，以及可选的 AGENTS.md 下载地址。
_Avoid_：完整 Pi home、隔离环境

**项目 Profile（Project Profile）**：
当前项目实际采用、可由用户独立编辑的资源清单。
_Avoid_：共享工作副本

**全局模板（Global Template）**：
用户显式注册的、可用于初始化其他项目的命名 profile 配置。它只包含配置，不共享已安装的资源。
_Avoid_：全局安装、中央资源缓存

**初始化（Init）**：
从已有全局模板或 LLM 引导创建项目 profile，并在用户确认后安装资源。已有项目 profile 不会被替换。
_Avoid_：切换环境

**同步安装（Sync）**：
按照项目 profile 安装资源并报告已有资源的跳过情况，不删除清单外内容。它不是双向同步、升级服务或版本合并。
_Avoid_：Git sync、共享资源链接

**LLM 引导（LLM Setup）**：
在当前对话中了解用户工作流、检索和核对候选资源，再经用户确认生成项目 profile 的过程。可选择将配置另存为全局模板。
_Avoid_：独立 Agent、内置搜索引擎

**Global**：
Pi 原生的用户级运行配置与资源环境，不等同于全局模板。本工具不修改或屏蔽它，仍遵循 Pi 原生加载规则。
_Avoid_：profile 缓存、模板安装目录
