# Sia-Codex

**Sia-Codex 是 [CodexPlusPlus](https://github.com/BigPizzaV3/CodexPlusPlus) 的非官方下游定制版。**

它侧重“多 Agent 编排与本地 Worker 管理”，不是 OpenAI、CodexPlusPlus、Anthropic、
xAI 或其他上游厂商的官方版本。当前源码基线为 `d33d59c9`，对应上游 `v2.2.0`
之后的 `main`；本仓库以 `AGPL-3.0-only` 分发。

本 README 只介绍 Sia-Codex 的入口和相对上游的差异。通用供应商管理、网关协议、
会话、MCP、Skills 和拓展市场仍以上游 CodexPlusPlus 文档为基线。

## 与上游的差异

| 方面 | Sia-Codex 的下游改动 |
| --- | --- |
| 任务编排 | 增加三省六部工作流：中书省规划、门下省审核、尚书省执行、宰相验收 |
| 任务调度 | 支持依赖任务图、并发上限、取消、重试、SSE 事件和隔离 worktree |
| 合并流程 | 支持开发分支合并、冲突预览、人工裁定、重试和清理 |
| Worker 管理 | 集中显示 Codex、DSH、Claude Code、WorkBuddy、Trae CN、豆包工作的状态 |
| Windows | 增加 Computer Use JS 模式、Chrome / Edge 扩展检测和 Windows 适配 |
| 更新策略 | 只提示上游变化，不自动下载或安装；详见下方“维护与更新” |
| 上游能力 | 完整拓展系统、网关、模型路由和插件市场继续保留 |

这不是“另起炉灶”的重写版本：上游能力仍在，Sia-Codex 在其上维护自己的编排层和
Windows 工作流。

## 快速开始

仓库目前没有独立发布的安装包，需要从源码构建。Windows 支持最完整，开发环境至少需要：

- Node.js 与 npm
- Rust 1.85 或更高版本
- Microsoft Edge WebView2 Runtime
- Visual Studio C++ Build Tools 和 Windows SDK

获取源码并构建前端和管理器：

```powershell
git clone https://github.com/shiziluk/Sia-Codex.git
cd Sia-Codex
git switch codex/sansheng-orchestration
npm.cmd ci --prefix apps/codex-plus-manager
npm.cmd run vite:build --prefix apps/codex-plus-manager
cargo build --release -p codex-plus-manager --bin codex-plus-plus
```

默认输出位于 `target\release\codex-plus-plus.exe`。如果设置了
`CARGO_TARGET_DIR`，则位于对应的 `release` 目录。

首次运行建议按这个顺序检查：

1. 启动构建出的 `codex-plus-plus.exe`，确认网关和模型供应商可用。
2. 打开「Agent 编排台」。
3. 在「Worker 控制中心」检查 Worker 可执行文件和登录状态。
4. 用「测试连接」提交只读探针，确认返回预期标记后再派真实任务。

详细构建和本地替换流程见 [本地下游维护方式](docs/LOCAL-DOWNSTREAM.md) 和
[贡献指南](CONTRIBUTING.md)。macOS 和 Linux 的依赖与构建步骤以上游项目为准。

## 核心能力

### 三省六部编排

- 中书省拆解目标并生成带依赖的任务图。
- 门下省独立审核计划和产物，不参与执行。
- 尚书省按能力、费用、并发和目录调度 Worker。
- 宰相保留冲突处理、整合、重试和最终验收职责。

编排协议和工具接口见 [三省编排协议](docs/sansheng-orchestration-protocol-v1.md)
与 [Agent 协作说明](docs/agent-collaboration.md)。

### Worker 控制中心

在同一个页面查看 Worker 的可执行文件、模型、并发数、排队和最近任务状态，并执行：

- **测试连接**：提交 `WORKER_OK` 只读探针。
- **派一个测试任务**：提交 `WORKER_TASK_OK` 只读任务。
- **查看日志**：查看完成、失败或等待中的结果。

排队、超时、`handed_off` 和不确定结果都不会被算作成功。

### Windows Computer Use

- Windows 支持 JS 操作模式，可操作桌面窗口和已登录的 Chrome / Edge 标签页。
- 只控制桌面时不需要安装浏览器扩展。
- 扩展检测只确认安装文件，不把“检测到扩展”误报为“浏览器控制已经可用”。
- Windows 不提供 macOS 的悬浮预览；Linux 当前不启用 Computer Use。

### 上游拓展系统

上游完整拓展体系已经保留，包括拓展包、配置表单、工具、命令、钩子、后台进程、
界面插槽、社区市场和发布流程。拓展说明不再在 README 中重复，见
[EXTENSIONS.md](EXTENSIONS.md)。

拓展代码以当前用户权限运行，没有内置沙箱。只安装可信来源，并在发布前检查权限、
资源和依赖。

## 平台与费用

| 能力 | Windows | macOS | Linux |
| --- | --- | --- | --- |
| 三省六部编排 | 支持 | 支持 | 支持 |
| Worker 控制中心 | 支持 | 支持 | 支持 |
| Computer Use | JS 模式 | JS + 原生离散工具 | 不启用 |
| Chrome / Edge 扩展检测 | 支持 | 支持 Chrome，Edge 视安装情况 | 不作为默认路径 |
| 完整拓展系统 | 支持 | 支持 | 支持 |

日常可拆分任务优先使用 WorkBuddy、Trae CN、原生子代理或空闲免费模型通道。
DeepSeek Harness 和 Claude Code 使用付费在线模型，不作为默认 Worker。

免费额度、每日领取、模型回退和思考强度边界见
[Worker 额度与每日领取](docs/worker-quotas.md)。

## 维护与更新

Sia-Codex 不自动跟随上游 Release：

1. 获取上游 Release notes、提交记录和源码差异。
2. 在独立升级分支中评估兼容性、费用和平台风险。
3. 只移植需要的改动，不覆盖三省编排和 Windows 适配。
4. 通过前端、Rust、构建和真实启动验证后再合入。

上游更新检查只提供信息，不触发下载、安装或替换现有程序。

## 文档

- [Agent 编排协议](docs/sansheng-orchestration-protocol-v1.md)
- [Agent 协作说明](docs/agent-collaboration.md)
- [本地下游维护方式](docs/LOCAL-DOWNSTREAM.md)
- [Worker 额度与每日领取](docs/worker-quotas.md)
- [拓展系统说明](EXTENSIONS.md)
- [安全策略](SECURITY.md)
- [贡献指南](CONTRIBUTING.md)

## 隐私与反馈

- 不提交 API Key、Cookie、账号标识、本机私有路径或未脱敏日志。
- 下游构建和编排问题请使用 [Sia-Codex Issues](https://github.com/shiziluk/Sia-Codex/issues)。
- 上游继承功能的通用说明请查阅 CodexPlusPlus 仓库。
- 本分支问题不要描述成上游官方答复。

## 许可

本仓库按 [AGPL-3.0-only](LICENSE) 分发。上游代码、第三方依赖、商标和应用资源
仍归各自权利人所有。来源与修改边界见 [FORK-NOTICE.md](FORK-NOTICE.md)。
