# Worker 额度与每日领取

本文说明本地 Worker 适配器的额度策略。通用模型路由和供应商配置仍以
CodexPlusPlus 上游文档为准。

## 使用策略

- 日常、可拆分的工作优先使用有每日免费额度的 Worker。
- WorkBuddy 默认从 `hy3` 开始；本地时间 00:00 至 05:59 可尝试 `hy4-preview`。
- 每日免费模型不可用时，再切换到已配置的 `GLM-5.3-Flash` 等备用模型。
- DeepSeek Harness 和 Claude Code 使用付费在线模型，不作为默认 Worker。
- 不保证免费额度始终存在，也不绕过客户端的签到、限流或风控流程。

## 每日领取

先为当前机器设置 WorkBuddy 可执行文件路径，再运行领取脚本：

```powershell
$env:WORKBUDDY_EXE = "<path to WorkBuddy.exe>"
npm.cmd run claim:workbuddy --prefix apps/codex-plus-manager
npm.cmd run claim:trae --prefix apps/codex-plus-manager
```

只有客户端明确显示 `领取成功`、`签到成功`、`已领取` 或 `已签到` 时，
脚本才返回成功。超时、界面不明确或没有可靠回执时，不得报告为成功。

## 思考强度

WorkBuddy 和 Trae CN 当前没有稳定、公开的思考强度 API。选择 Flash 模型可以降低
推理成本，但适配器不会伪称已经传入“最低思考强度”。需要严格控制该参数时，
应使用明确支持该参数的 API 或供应商。
