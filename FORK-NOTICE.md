# Sia-Codex Fork Notice

## Identity

**Sia-Codex** is an unofficial downstream build maintained by `shiziluk`.
It is not an official release of CodexPlusPlus, BigPizzaV3, OpenAI, Anthropic,
xAI, or any other upstream vendor.

## Upstream

- Upstream project: `https://github.com/BigPizzaV3/CodexPlusPlus`
- Latest published upstream release: `v2.1.4`
- Reviewed upstream tip: `d33d59c9bd6220a1406c2fd3d7e7be830c1f3cf8`
- Upstream source version at the reviewed tip: `2.2.0`
  (not published as a tag or GitHub Release)
- Upstream license: AGPL-3.0-only

## License

This repository remains licensed under the GNU Affero General Public License,
version 3 only (`AGPL-3.0-only`). See `LICENSE`.

Corresponding source for distributed binaries must remain available from the
same repository and release. If a modified version is provided as a network
service, its Corresponding Source must be offered to network users as required
by AGPL section 13.

No permission is granted to use the names, logos, application icons, or other
trademarks of CodexPlusPlus, OpenAI, ChatGPT, Codex, Anthropic, Claude, xAI, or
Grok except for factual attribution and nominative reference.

## Local Changes

The Sia-Codex downstream primarily adds:

- Sansheng workflow planning, independent review, execution, and final acceptance.
- Dependency-aware parallel task scheduling and isolated Git worktrees.
- Automatic merge, squash, and cherry-pick integration with recoverable conflicts.
- Per-subtask conflict previews, manual resolution, retry, and cleanup.
- A versioned orchestration protocol and cursor/SSE event feeds.
- A graphical dependency canvas and conflict editor in the manager UI.
- Informational-only upstream update checks without automatic installation.
- Local adapters and routing policy for WorkBuddy, Trae CN, DeepSeek Harness, and
  Claude Code.

The detailed downstream workflow is documented in:

- `docs/LOCAL-DOWNSTREAM.md`
- `docs/sansheng-orchestration-protocol-v1.md`
- `docs/agent-collaboration.md`

## Third-Party Material

Third-party dependencies, fonts, sponsor artwork, screenshots, application
icons, and names remain subject to their own licenses and rights. The repository
license does not grant rights to proprietary application resources or trademarks.
