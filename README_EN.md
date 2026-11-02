# Sia-Codex

Sia-Codex is a downstream custom build of [CodexPlusPlus](https://github.com/BigPizzaV3/CodexPlusPlus). It is not an upstream official release and is not affiliated with OpenAI. It is distributed under AGPL-3.0-only; upstream copyrights, third-party dependencies, and trademarks remain with their respective owners. See [FORK-NOTICE.md](FORK-NOTICE.md).

This README focuses on downstream differences. General provider, gateway, session, MCP, Skills, plugin market, and extension documentation remains upstream-based.

## Current Baseline

- Upstream code is integrated through `d33d59c9`, including the v2.2.0 extension package kernel, extension market, publishing and curation tools, DSH plugin import, and built-in extensions.
- The downstream Sansheng orchestration, Worker Control Center, Windows Computer Use, and browser-extension status management have been replayed onto that baseline.
- This fork never auto-downloads or auto-installs upstream releases. Updates are reviewed from release notes and source diffs.

## Downstream Additions

### Sansheng Agent Orchestration

- The Zhongshu planner builds a dependency-aware task graph.
- The Menxia reviewer independently reviews plans and results.
- The Shangshu executor routes work by capability, cost, and workspace.
- The chancellor retains conflict resolution, automatic merge, and final acceptance.
- Supports dependencies, concurrency limits, cancellation, retries, SSE events, isolated worktrees, manual conflict resolution, and automatic merge.

### Worker Control Center

The Agent orchestration page includes a unified worker view for:

- Codex, DeepSeek Harness, Claude Code, WorkBuddy, Trae CN, and Doubao Work.
- Executable availability, enabled state, model, concurrency, live queue state, and latest task.
- Authentication and quota status. When no stable query API exists, the UI says “verified at execution time” instead of inventing a status.
- **Test connection**, which submits a read-only `WORKER_OK` probe.
- **Dispatch a test task**, which submits a read-only `WORKER_TASK_OK` task.
- **View logs**, including progress, answer, error, and a link back to task details.

A queued, timed-out, `handed_off`, or uncertain task is not success.

### Low-Cost Worker Policy

- Routine separable work prefers WorkBuddy, Trae CN, native subagents, and idle free-model channels.
- WorkBuddy starts with `hy3`, may use `hy4-preview` during early morning, and falls back to `GLM-5.3-Flash`.
- Trae prefers `GLM-5.3-Flash`.
- Doubao Work is launched with `--headless=new` and controlled through local CDP using its existing login. The client must be signed in once before use; unauthenticated tasks fail explicitly.
- DeepSeek Harness and Claude Code use paid online models and are not default workers.
- WorkBuddy and Trae do not currently expose a stable thinking-effort API. Using Flash models reduces cost, but the adapters do not claim to forward a minimum thinking level. Use an API/provider with explicit effort controls when that guarantee is required.

### Windows Computer Use and Browser Extensions

- macOS supports JS and native discrete-tool modes.
- Windows supports JS mode for desktop windows and logged-in Chrome or Edge tabs.
- Windows does not provide the macOS floating preview; screenshots still appear in tool results and the UI explains the alternative.
- Linux does not enable Computer Use.
- The ChatGPT browser extension is optional. Desktop-only automation does not need it; browser automation can open the correct Chrome Web Store or Microsoft Edge Add-ons page.
- Extension detection reports installed files as “detected,” not as an active browser tool. Restart the browser and Agent session, then run the connectivity check.
- Managed request headers support `@oai/browser-desktop@0.1.1` and add `x-browser-agent` only for supported Chrome or Edge extensions.

### Upstream Extension System

This build includes the full upstream extension system:

- Package manifests, generated configuration forms, bundled assets and icons, tools, slash commands, hooks, background processes, cross-process services, UI slots, side panels, and manager pages.
- Local, community, curated, official, and self-published extensions.
- One-click GitHub publishing, review, listing/unlisting, and pinned-version installs.
- DSH plugin import through managed MCP, Skills, MCP configuration, prompt mapping, and supported event bridges.
- Typing effects, backgrounds, the Agent Pet, usage status, and request status as extension packages.

Extension code runs with the current user's permissions and without a sandbox. Install only trusted sources and never publish API keys, cookies, account identifiers, or private local paths.

## Platform and Cost Boundaries

| Capability | Windows | macOS | Linux |
| --- | --- | --- | --- |
| Sansheng orchestration | Supported | Supported | Supported |
| Worker Control Center | Supported | Supported | Supported |
| Computer Use | JS mode | JS + native tools | Not enabled |
| Chrome / Edge extension detection | Supported | Chrome supported; Edge depends on installation | Not a default path |
| macOS floating preview | Not available | Supported | Not available |
| Full extension system | Supported | Supported | Supported |

Costs depend on each worker's account, model, and quota. Codex++ does not guarantee free quota and does not bypass third-party daily claim or risk-control flows.

WorkBuddy's daily 100-credit entry is `Buddy加油站 → 每日可领 100 积分 → 立即领取`, backed by `/billing/meter/checkin-status` and `/billing/meter/daily-checkin`. Trae exposes its daily reward in the account menu as `每日签到得 100 积分 → 签到`. Both scripts are idempotent and return success only after an explicit claimed state:

```powershell
$env:WORKBUDDY_EXE = "F:\智能体\WorkBuddy\app\WorkBuddy.exe"
npm.cmd run claim:workbuddy --prefix apps/codex-plus-manager
npm.cmd run claim:trae --prefix apps/codex-plus-manager
```

## Update Policy

1. Fetch upstream release notes, commits, and source diffs only.
2. Review compatibility, cost, and platform risk in a separate upgrade branch.
3. Preserve Sansheng orchestration, the Worker Control Center, Windows adaptations, and downstream security boundaries.
4. Merge only after frontend, Rust, build, and real launch verification.

Upstream automatic download and install behavior remains disabled or notification-only.

## Verification

On Windows, keep Cargo targets and runtime dependencies on D: when possible:

```powershell
$env:CARGO_TARGET_DIR = "D:\dev-tools\cargo-target\codexplusplus"
npm.cmd ci --prefix apps/codex-plus-manager
npm.cmd run check --prefix apps/codex-plus-manager
npm.cmd test --prefix apps/codex-plus-manager
npm.cmd run vite:build --prefix apps/codex-plus-manager
cargo test -p codex-plus-core --lib
npm.cmd run build --prefix apps/codex-plus-manager
```

## Privacy and Support

- Never commit API keys, cookies, account identifiers, private local paths, or unredacted logs.
- Report downstream issues to [Sia-Codex Issues](https://github.com/shiziluk/Sia-Codex/issues).
- Use the upstream repository for inherited upstream behavior; downstream build issues must not be presented as official upstream answers.

## License

Distributed under [AGPL-3.0-only](LICENSE).
