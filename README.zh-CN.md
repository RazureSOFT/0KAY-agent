# 0KAY-agent

> **Language / 语言**: 简体中文 · [English](README.md)

> [0KAY](https://github.com/RazureSOFT/0KAY) 的组成部分——一个本地优先、会记住你的 AI 伴侣，底下是一个真正的 Agent。

本仓库是 0KAY 平台的 **Agent**：任务执行插件。当伙伴需要真正「动手」——查看仓库、改文件、跑命令、上网、操作桌面——就是这个进程在执行任务与工具，并向 Core 回报。

它通过 gRPC 连接 0KAY Core，注册为 `agent` 插件，带着工具注册表、审批门、任务台账与 MCP/LLM 集成来执行派发的任务。

## 它做什么

- **多步任务执行**：文件系统、shell、网页与桌面工具，配实时 todo 清单。
- **所有模型调用走 mocr**（`ChooseModels` + 流式），模型选择与凭据集中一处。
- **审批门**：`normal` 模式下特权工具调用（和 `question` 工具）暂停等你决定；`full_access` 直接执行。
- **返回 diff**：`edit`/`apply_patch` 不只返回文本，还有逐文件统一 diff，WebUI 能精确展示改动。
- **技能与 MCP 扩展**：内置 `code` / `research` / `general` 技能 + `skills/*.md`，以及 Core 暴露的任意 MCP 服务器。
- **大模型定方案、小模型写实现**（可选 duet 模式）：think 模型起草方案与自包含实现提示词，主循环钉在 output 模型上实现。

## 任务类型：计划 / 智能体 / 工作

| 类型 | `agent_type` | 行为 |
|---|---|---|
| **计划（Plan）** | `plan` | 只做规划：只读调研后产出结构化方案文档，不修改文件。 |
| **智能体（Agent）** | 子类型 | 自主多步执行。唯一有二级子选项的类型，子类型映射到技能文件：`general`、`code`、`code_explore`、`research`、`science`。 |
| **工作（Work）** | `work` | 单遍专注执行：直接修改、少提问、廉价验证。 |

详细说明见 [English README 的 Task kinds / Duet 章节](README.md#task-kinds-plan--agent--work) 与 [docs/zh-CN/agent-service.md](https://github.com/RazureSOFT/0KAY/blob/main/docs/zh-CN/agent-service.md)。

## 它是 0KAY 的组件

这不是独立应用——请通过安装 0KAY 平台（或 `0kay-pm`）获得。先读[主仓库 README](https://github.com/RazureSOFT/0KAY/blob/main/README.zh-CN.md) 了解全貌。

## 环境要求

- Node.js 20+（构建与冒烟测试在 Node 26 上完成）
- 运行中的 0KAY Core（gRPC 50051）与 MOCR（gRPC 50052）
- Protobuf 定义与 `@0kay/mcp` 客户端（安装器按 `mcp/`、`proto/` 兄弟目录布局）

## 安装与运行

```powershell
# 0kay-pm 方式
0kay-pm install @razuresoft/0kay-agent@0.1.1
0kay-pm update @razuresoft/0kay-agent@<version>
0kay-pm start @razuresoft/0kay-agent

# 源码方式
npm ci
npm run build
node dist/index.js      # 或 npm run dev（tsx 热加载）
npm test
```

进程注册为 `agent` 插件，每 10 秒心跳、断线自动重注册。发布版本以
`manifest.json` 为唯一来源。

## 配置

环境变量全部可选（默认值见 [English README](README.md#configuration)）：
`CORE_ADDRESS`、`AGENT_GRPC_PORT`（50054）、`AGENT_ADDRESS`、`AGENT_BIND_HOST`、
`MOCR_ADDRESS`、`CORE_HTTP_ADDR`/`CORE_HTTP`、`AGENT_DATA_DIR`（任务台账与
执行器身份）、`AGENT_EXECUTOR_ID`、`AGENT_SKILLS_DIR`、`PROTO_DIR`、
`SEARXNG_URL`、`CORE_PAIR_TOKEN`/`CORE_API_TOKEN`、`CORE_TLS_CA`/`CORE_TLS_NAME`。

`0kay-pm` 安装时会把它们（含配对结果）写入 `runtime-env.json` 并在启动时注入。

### 命名工作区（项目）

用 `projects_admin` 直接工具保存目录：`{action:'save', name, path}`、
`{action:'list'}`、`{action:'delete', name}`、`{action:'use', name}`；
任务元数据传 `{"project": "<名称>"}` 即在该目录运行（显式 `workdir` 优先）。
存储于 `data/agent/projects.json`。

## 许可证

作为 0KAY 平台仓库的一部分提供。
