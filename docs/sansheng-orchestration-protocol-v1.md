# Sansheng Orchestration Protocol v1

Protocol identifier: `sansheng.orchestration.v1`

This protocol is the shared boundary between Codex++ and external clients such
as the DeepSeek Harness implementation. It does not require a shared database.

## Task Envelope

```json
{
  "protocol": "sansheng.orchestration.v1",
  "workflowId": "uuid",
  "objective": "user goal",
  "cwd": "D:/absolute/workdir",
  "allowedAgents": ["workbuddy", "trae"],
  "constraints": ["no network writes"],
  "acceptance": ["tests pass"],
  "metadata": {}
}
```

Required semantics:

- `workflowId` is stable for the entire run.
- `cwd` may be omitted only by a transport that already has an explicit
  workspace binding.
- Agent routing remains a local policy decision; the envelope never contains
  credentials.
- `acceptance` must be independently verifiable.

## Event Envelope

```json
{
  "protocol": "sansheng.orchestration.v1",
  "workflowId": "uuid",
  "seq": 12,
  "kind": "task_terminal",
  "phase": "executing",
  "taskId": "uuid",
  "role": "execution",
  "message": "trae task finished: completed",
  "data": { "status": "completed" },
  "createdAtMs": 1790000000000
}
```

`seq` is monotonically increasing per workflow. Consumers resume with
`afterSeq` and must tolerate duplicate delivery. Events are audit data, not a
substitute for `sansheng_status`.

Current event kinds include `workflow_created`, `task_submitted`,
`task_terminal`, `phase_changed`, `merge_conflict_resolved`, and
`merge_retry_requested`.

Current Codex++ transport:

```text
sansheng_events { workflowId, afterSeq, limit } -> { nextSeq, events[] }
GET /sansheng/events?token=...&workflowId=...&afterSeq=...  (text/event-stream)
```

The SSE endpoint binds to `127.0.0.1` on an ephemeral port and requires a
per-process random token returned by the manager command
`agent_collaboration_event_stream`. EventSource clients reconnect with
`Last-Event-ID`; the server sends the same event envelopes as the cursor API.
The manager only keeps an SSE connection open for an active workflow. Completed,
failed, or cancelled workflows load one cursor snapshot and close the stream.

## Control Envelope

```json
{
  "protocol": "sansheng.orchestration.v1",
  "action": "accept",
  "workflowId": "uuid",
  "controllerId": "uuid",
  "payload": { "approved": true, "notes": "accepted" }
}
```

Supported control actions:

- `dispatch`
- `accept`
- `cancel`
- `resolve_conflict`
- `retry_merge`

`resolve_conflict` carries
`payload: { "file": "src/app.ts", "choice": "ours" }`.
`choice=ours` keeps the current integration version; `choice=theirs` takes the
current task branch version; `choice=custom` also requires UTF-8 `content` and
writes that content as the final resolution. The workflow exposes
`mergeConflictPreviews[]` with base, integration, and task versions plus
binary/truncation flags. Up to 5 files with 32 KiB per side are embedded with
the workflow; clients can request any file through the read-only manager command
`agent_collaboration_conflict_preview` without changing the protocol envelope.
The on-demand preview reads at most 512 KiB per side and marks truncation.
Resolve every conflicted file before calling
`retry_merge`. The main branch remains unchanged until the complete merge
succeeds. Decisions are scoped by `mergeConflictTaskId` plus file path, so a
choice for one subtask is never silently reused when a later subtask conflicts
on the same filename.

Controller credentials are scoped per workflow and must not be reused as agent
credentials.

## Merge Semantics

- `mergeMode=none`: keep worktree artifacts for review.
- `mergeMode=auto`: merge only after explicit acceptance.
- `mergeStrategy=merge`: preserve the worktree branch history.
- `mergeStrategy=squash`: one integration commit per worktree.
- `mergeStrategy=cherry-pick`: replay commits from the worktree branch.
- Any conflict leaves the main branch unchanged and enters `merge_conflict`.

## Compatibility

Clients must reject unknown protocol versions. Additive optional fields are
allowed within v1; semantic or breaking field changes require v2.
