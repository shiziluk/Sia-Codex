# Local downstream maintenance

This repository is maintained as a downstream custom build. It does not follow
upstream releases automatically.

## Branch model

- Long-lived custom branch: `codex/sansheng-orchestration`.
- The upstream tag used as the last reviewed base is recorded in local release
  notes or checkpoint files.
- Never run `git pull`, merge, rebase, or an in-app installer directly on the
  long-lived custom branch.
- Create a temporary branch for each upstream review, for example
  `upgrade/v2.1.5`, so the custom branch remains recoverable.

## Upstream review workflow

1. Fetch upstream tags and release metadata without modifying the custom branch.
2. Read `CHANGELOG.md`, the GitHub Release body, and the full diff between the
   current base tag and the new tag.
3. Classify changes into:
   - security and data-integrity fixes that must be ported,
   - compatibility fixes that affect our changed modules,
   - new features that may be useful,
   - changes that conflict with the local orchestration model,
   - cosmetic or unrelated changes.
4. Review the affected source files, not only release notes.
5. Port selected commits or reimplement the behavior on the temporary upgrade
   branch. Never replace the custom modules wholesale.
6. Run Rust, frontend, manager, and targeted workflow tests.
7. Compare the custom executable and release artifact behavior before replacing
   the installed binary.
8. Back up the current custom binary, install the new build, restart, and run an
   end-to-end smoke test.

## Local integration points

Review conflicts carefully around:

- `crates/codex-plus-core/src/agent_collaboration/pipeline.rs`
- `crates/codex-plus-core/src/agent_collaboration/mod.rs`
- `crates/codex-plus-core/src/agent_collaboration/mcp.rs`
- `apps/codex-plus-manager/src-tauri/src/agent_collaboration_commands.rs`
- `apps/codex-plus-manager/src/AgentCollaborationPage.tsx`
- `apps/codex-plus-manager/src/AgentCollaborationPage.css`

These files contain the local Sansheng workflow, role/phase persistence,
independent review gate, MCP tools, and manager UI.

## Update behavior

- Background and manual update checks remain as informational notices.
- Release notes may be displayed to help decide what to port.
- The custom build must not download or launch an upstream installer.
- The backend must reject `perform_update` even if an old UI or external caller
  tries to invoke it.
- The installed binary path must not be overwritten by an upstream updater.

## Build

Use `.codex-plus-recovery.json` for local build settings and set
`SHERPA_ONNX_LIB_DIR` to the cached Windows static library when GitHub downloads
are unavailable:

```powershell
$env:SHERPA_ONNX_LIB_DIR = '<cached sherpa-onnx static library directory>'
cargo build --release -p codex-plus-manager --bin codex-plus-plus
```

Build frontend first with:

```powershell
npm.cmd run vite:build --prefix apps/codex-plus-manager
```

## Native browser service compatibility

The real-service fixture test is opt-in because the browser runtime is
proprietary and changes with Codex Desktop. Discover installed service modules
and run only those that match the structural contract:

```powershell
npm.cmd run test:native-browser-local --prefix apps/codex-plus-manager
```

The command parses files only; it does not execute browser services and does not
copy them into the repository. A nonzero exit with
`Unsupported constructor arguments` means the installed runtime changed shape
and the inspector needs an explicit compatibility review before enabling the
native-browser enhancement for that version.

Before replacing the installed binary, copy the current executable to a
timestamped backup. Keep the corresponding source branch available.

## Licensing

CodexPlusPlus is AGPL-3.0-only. When distributing a modified build, provide the
corresponding source and preserve license notices. The separate
`cft0808/edict` project is an MIT-licensed reference; copying code from it
requires retaining its license notice.
