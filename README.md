# Sia-Codex

Sia-Codex 是 [CodexPlusPlus](https://github.com/BigPizzaV3/CodexPlusPlus) 的下游定制版，不是上游官方版本，也不代表 OpenAI。当前下游分支以 AGPL-3.0-only 分发；上游版权、第三方依赖和商标仍归各自权利人所有。来源与修改边界见 [FORK-NOTICE.md](FORK-NOTICE.md)。

本仓库只记录 Sia-Codex 相对上游的差异。通用供应商管理、网关、会话、MCP、Skills、插件市场和完整拓展系统仍以上游说明为基线。

## 当前基线

- 上游代码已整合到 `d33d59c9`，包括 v2.2.0 的「万物皆拓展」拓展包内核、拓展市场、发布/审核工具、DSH 插件导入和内置拓展拆包。
- 下游三省六部编排、Worker 控制中心、Windows Computer Use 和浏览器扩展状态管理已重放到新基线上。
- 下游分支继续维护自己的更新策略：上游有新版本时只检查说明和源码差异，不自动下载、安装或覆盖本分支。

## Sia-Codex 的差异

### 三省六部 Agent 编排

- 中书省负责目标拆解和带依赖的任务图。
- 门下省独立审核方案与结果，不参与执行。
- 尚书省按能力、费用和工作目录调度 Worker。
- 宰相保留任务裁定、冲突处理、自动合并和最终验收职责。
- 支持任务依赖、并发上限、取消、重试、SSE 实时事件、worktree 隔离、冲突编辑和自动合并。

相关文档：

- [三省编排协议](docs/sansheng-orchestration-protocol-v1.md)
- [Agent 协作说明](docs/agent-collaboration.md)
- [本地下游维护方式](docs/LOCAL-DOWNSTREAM.md)

### Worker 控制中心

Agent 编排台新增独立的 **Worker 控制中心**，统一显示：

- Codex、DeepSeek Harness、Claude Code、WorkBuddy、Trae CN、豆包工作的可执行文件与启用状态。
- 模型、并发数、当前排队/运行数和最近一次任务。
- 认证与额度的实际状态。没有稳定查询接口时明确显示“执行时验证”，不会伪造已登录或剩余额度。
- **测试连接**：提交 `WORKER_OK` 只读探针任务。
- **派一个测试任务**：提交 `WORKER_TASK_OK` 只读任务。
- **查看日志**：查看最近任务的进度、回答或错误，并可跳回任务详情。

测试任务只有真正完成并返回预期标记才算成功；排队、超时、`handed_off` 或不确定结果都不算成功。

### 低成本 Worker 策略

- 日常可拆分工作优先使用 WorkBuddy、Trae CN、原生子代理和空闲的免费模型通道。
- WorkBuddy 默认从 `hy3` 开始；凌晨可加入 `hy4-preview`；不可用时切到 `GLM-5.3-Flash`。
- Trae 优先使用 `GLM-5.3-Flash`。
- 豆包工作通过 `--headless=new` 和本地 CDP 接入，复用客户端登录态；首次使用前需在豆包工作中登录一次，未登录时任务会明确失败。
- DeepSeek Harness 和 Claude Code 使用付费在线模型，不作为默认 Worker。
- WorkBuddy 与 Trae 当前没有公开的思考强度 API。选择 Flash 快速档可降低推理成本，但适配器不会伪称已透传“最低思考强度”；需要严格强度控制时使用支持该参数的 API/供应商。

### Windows Computer Use 与浏览器扩展

- macOS 支持 JS 和原生离散工具两种操作方式。
- Windows 支持 JS 操作方式，可操作桌面窗口和已登录的 Chrome / Edge 标签页。
- Windows 不支持 Codex++ 的 macOS 悬浮预览；Computer Use 截图仍会随工具结果显示，界面会给出平台替代说明。
- Linux 当前不启用 Computer Use。
- ChatGPT 浏览器扩展是可选安装项。只操作桌面窗口时不需要安装；需要操作已登录浏览器标签页时，可分别打开 Chrome Web Store 或 Microsoft Edge Add-ons。
- 扩展状态页只检测 Chrome / Edge 的安装文件并显示“检测到安装”，不会把文件存在误报为浏览器工具已经可用。重启浏览器和 Agent 会话后，需再运行连接性检查。
- 已适配 `@oai/browser-desktop@0.1.1` 的 managed request headers；只对受支持的 Chrome / Edge 扩展附加 `x-browser-agent` 请求头。

### 上游拓展系统

当前版本已经包含上游完整拓展体系：

- 拓展包清单、配置表单、包内资源、图标、工具、斜杠命令、钩子、后台进程、跨进程服务、界面插槽和管理器页面。
- 本地拓展、社区拓展、精选拓展、官方拓展和「我发布的」管理。
- 一键发布到 GitHub、审核、上架/下架和锁定版本安装。
- DSH（DeepSeek Harness）插件导入：工具插件经托管 MCP 使用，Skill、MCP 配置、提示词和可映射事件按支持矩阵转换。
- 打字特效、背景图、Agent 桌宠、用量状态栏和请求状态条作为拓展包运行。

拓展代码以当前用户权限在本机运行，没有沙箱。只安装可信来源；发布前必须检查包内代码、权限和资源，不提交 API Key、Cookie、账号标识或本机私有路径。

## 平台与费用边界

| 能力 | Windows | macOS | Linux |
| --- | --- | --- | --- |
| 三省六部编排 | 支持 | 支持 | 支持 |
| Worker 控制中心 | 支持 | 支持 | 支持 |
| Computer Use | JS 模式 | JS + 原生离散工具 | 不启用 |
| Chrome / Edge 扩展检测 | 支持 | 支持 Chrome，Edge 取决于本机安装 | 不作为默认路径 |
| macOS 悬浮预览 | 不提供 | 支持 | 不提供 |
| 完整拓展系统 | 支持 | 支持 | 支持 |

费用由各 Worker 自己的账号、模型和额度决定。Codex++ 不保证免费额度始终存在，也不会绕过第三方客户端的每日领取或风控流程。

WorkBuddy 的每日 100 积分入口已定位为 `Buddy加油站 → 每日可领 100 积分 → 立即领取`，底层对应 `/billing/meter/checkin-status` 与 `/billing/meter/daily-checkin`。Trae 的入口是账号菜单中的 `每日签到得 100 积分 → 签到`。两个脚本都做幂等检查，只有看到“领取成功 / 签到成功 / 已领取 / 已签到”才返回成功：

```powershell
$env:WORKBUDDY_EXE = "F:\智能体\WorkBuddy\app\WorkBuddy.exe"
npm.cmd run claim:workbuddy --prefix apps/codex-plus-manager
npm.cmd run claim:trae --prefix apps/codex-plus-manager
```

## 更新策略

Sia-Codex 不自动跟随上游 Release：

1. 只获取上游 Release notes、提交记录和源码差异。
2. 在独立升级分支中判断每项改动的兼容性、费用和平台风险。
3. 保留三省编排、Worker 控制中心、Windows 适配和本仓库安全边界。
4. 通过前端、Rust、构建和真实启动验证后再合入。

上游自动下载与自动安装接口保持关闭或仅提示。

## 验证

Windows 建议把 Cargo 目标目录和运行时依赖放在 D 盘：

```powershell
$env:CARGO_TARGET_DIR = "D:\dev-tools\cargo-target\codexplusplus"
npm.cmd ci --prefix apps/codex-plus-manager
npm.cmd run check --prefix apps/codex-plus-manager
npm.cmd test --prefix apps/codex-plus-manager
npm.cmd run vite:build --prefix apps/codex-plus-manager
cargo test -p codex-plus-core --lib
npm.cmd run build --prefix apps/codex-plus-manager
```

## 隐私与支持

- 不提交 API Key、Cookie、账号标识、本机私有路径或未脱敏日志。
- 下游问题请使用 [Sia-Codex Issues](https://github.com/shiziluk/Sia-Codex/issues)。
- 上游继承功能的通用说明请查阅上游仓库；下游构建问题不要伪装成上游官方答复。

## 许可

本仓库按 [AGPL-3.0-only](LICENSE) 分发。上游代码、第三方依赖和商标仍归各自权利人所有。
