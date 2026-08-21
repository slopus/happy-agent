# Happy Agent event reference

Happy Agent emits session events for transcript changes, run lifecycle, configuration,
interactive input, tasks, goals, subagents, and workflows. This document lists
every event in the session protocol and every lower-level event carried by
`agent_event`.

## Event delivery and persistence

Every session event uses the same envelope:

```ts
{
    id: string;
    sessionId: string;
    createdAt: number;
    type: string;
    data: object;
}
```

Clients can read a session's events from `GET /sessions/{sessionId}/events` or
follow them with server-sent events from `GET /sessions/{sessionId}/stream`.
These per-session interfaces deliver every event below while the server is
running, including streaming `agent_event` updates. High-volume provider stream
updates are live-only: completed messages and run outcomes remain durable.

When the durable global event queue is enabled, non-streaming events are also
assigned a monotonic UUIDv7 global cursor and exposed through `GET /events` and
`GET /events/stream`. A stream without a cursor replays the retained log in
bounded pages before following newly published stored and live events; a stream
with a cursor resumes after it. Current entity snapshots are loaded through the
catalog and entity endpoints instead of being replayed by the event stream. The
global queue does not persist or publish `agent_event`; completed messages and
terminal run outcomes are delivered by `agent_message`, `run_finished`, and
`run_error` instead.

## Session events

“Global” indicates whether an event is persisted to the enabled durable global
event queue. Durable events remain available after a server restart.

| Event                           | Emitted when                                                                                          | `data` payload                                                                                             | Global |
| ------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------ |
| `session_created`               | A primary or subagent session is created.                                                             | `session`: complete `ProtocolSession` snapshot                                                             | Yes    |
| `session_updated`               | API-managed session settings change.                                                                  | `session`: complete updated `ProtocolSession` snapshot                                                     | Yes    |
| `message_submitted`             | A user message, steering message, or notification is accepted.                                        | `displayText`, `message`, `runId`                                                                          | Yes    |
| `steering_applied`              | One or more accepted steering messages are incorporated into an active run.                           | `messageIds`, `runId`                                                                                      | Yes    |
| `run_started`                   | A queued run begins executing.                                                                        | `runId`                                                                                                    | Yes    |
| `agent_event`                   | Inference streams, tools execute, permissions are reviewed, or background process state changes.      | `event`: one `AgentLoopEvent`; `runId`                                                                     | **No** |
| `agent_message`                 | The agent loop commits an assistant, tool-result, compaction, or inference-error message.             | `message`, `runId`                                                                                         | Yes    |
| `run_finished`                  | A run reaches a provider-reported terminal stop reason.                                               | `runId`, optional `agentRunId`, `modelLocked`, `stopReason`                                                | Yes    |
| `provider_quota_observed`       | An account quota snapshot is captured before or after a primary-session provider run.                 | `observationId`, `phase`, `providerId`, `quota`, `runId`                                                   | **No** |
| `run_error`                     | A run fails outside the normal completion path, or an accepted queued run is stopped before starting. | `runId`, `errorMessage`, `modelLocked`                                                                     | Yes    |
| `abort_requested`               | An active or queued run is asked to stop.                                                             | Optional `runId`                                                                                           | Yes    |
| `subagents_suspended`           | Descendant agents are retained when their parent goal is paused.                                      | `displayText`                                                                                              | Yes    |
| `session_reset`                 | The transcript and active session work are reset.                                                     | `snapshot`: reset `AgentSnapshot`                                                                          | Yes    |
| `session_rewound`               | The transcript is rewound to before a selected user message.                                          | `messageId`, `snapshot`: resulting `AgentSnapshot`                                                         | Yes    |
| `session_title_changed`         | Delayed session metadata generation starts, succeeds, or fails, or a goal supplies a title.           | `status`, optional `title`, `recap`, `metadataUpdatedAt`, `metadataRunId`, or `errorMessage`               | Yes    |
| `session_configuration_changed` | The model, reasoning effort, or inference service tier changes, together or separately.               | `changed`: the fields that moved; `modelId`, `serviceTier` (tier or `null`), optional `effort`, `snapshot` | Yes    |
| `permission_mode_changed`       | The session permission mode is applied.                                                               | `permissionMode`                                                                                           | Yes    |
| `session_draft_changed`         | A client stores or clears the session's unsent composer text.                                         | `updatedAt`; optional `draft` and `origin`                                                                 | **No** |
| `secrets_changed`               | A secret bundle's session or project attachment changes.                                              | `secretIds`: effective union; `sessionSecretIds`, `projectSecretIds`: source lists                         | Yes    |
| `user_input_requested`          | The agent opens a structured question for the user.                                                   | Complete `UserInputRequest`, including `requestId` and `questions`                                         | Yes    |
| `user_input_resolved`           | A structured question is answered or cancelled.                                                       | `requestId`, `status`, optional `answers`                                                                  | Yes    |
| `mcp_servers_changed`           | The session's active MCP server set changes.                                                          | `servers`                                                                                                  | Yes    |
| `tasks_changed`                 | Session tasks are created, updated, linked, or cleared.                                               | `tasks`: complete current task list                                                                        | Yes    |
| `goal_changed`                  | A goal is created, changes status, completes, or is cleared.                                          | `goal`: current `SessionGoal` or `null`                                                                    | Yes    |
| `subagent_changed`              | A child agent's summary changes and its parent is notified.                                           | `subagent`: current `SubagentSummary`                                                                      | Yes    |
| `workflow_changed`              | A workflow starts, advances, logs, completes, errors, or stops.                                       | `update`: incremental `WorkflowRunUpdate`                                                                  | Yes    |

`stopReason` is one of `stop`, `length`, `toolUse`, `error`, or `aborted`.
`SessionTitleStatus` is one of `idle`, `generating`, `ready`, or `error`.

`session_draft_changed` carries the session's unsent composer text so every
attached terminal and external client shows the same draft. Write it with
`PUT /sessions/{sessionId}/draft`, sending `draft: null` to clear it and an
optional `origin` that identifies the writing client, which lets that client
ignore the echo of its own keystrokes. Drafts change as the user types, so the
event is delivered live but never written to the durable event log: the current
draft is a field on `ProtocolSession` and `SessionSummary`, and a client that
connects or reconnects reads it from the session instead of replaying edits.
Drafts are limited to 100,000 characters and survive a daemon restart.

The newest message wins, not the last write to arrive. A client sends
`updatedAt`, the moment the user typed the draft, and the daemon discards a
write whose stamp is older than the draft it already holds — including a stale
clear. Because the stamp comes from the writing machine's clock, the daemon
clamps it before trusting it: a draft is never dated in the future, and one from
a clock more than five minutes behind is held at the edge of that window so it
loses to recent drafts instead of never being able to win. The clamped value is
published as `updatedAt` and exposed as `draftUpdatedAt` on the session, so every
client orders drafts by the same numbers. Omitting `updatedAt` means now.

## Daemon events

These describe the whole daemon rather than one session, project, or workspace.
They arrive on the global stream only.

| Event              | Emitted when                                                                      | `data` payload                             | Global |
| ------------------ | --------------------------------------------------------------------------------- | ------------------------------------------ | ------ |
| `presence_changed` | The user switches presence.                                                       | `presence`: current `PresenceSnapshot`     | **No** |
| `plugins_changed`  | Plugins finish loading at startup, one is installed or uninstalled, or one stops. | `plugins`: every installed `PluginSummary` | **No** |
| `slots_changed`    | A slot entry is created, updated, or removed.                                     | `entries`: every current `SlotEntry`       | **No** |
| `applets_changed`  | An applet is imported, updated with a new version, or reverted.                   | `applets`: every current `Applet`          | **No** |

All four are live-only and carry the complete current state, so a client that
reconnects reads what is there now instead of replaying past changes.

`plugins_changed` reports each installed plugin's `name`, `description`,
`folder`, the `directory` Happy Agent installed it into, the `dataDirectory` it writes
to, and whether it is `running`. Installing a plugin starts it and uninstalling
one stops it before its code is removed, so a client never has to poll or wait
for a daemon restart to show the current set.

`slots_changed` carries every slot entry — agent-authored content plugged into
the Happy app's fixed UI slots — with each entry's slot, scope, TypeBox-typed
content, author session, description, and purpose. `applets_changed` carries
every applet with its description, purpose, author session, version history,
and which imported version is current. Entries are read and changed through
`GET`/`POST /slots` and `PATCH`/`DELETE /slots/{id}`; applets through
`GET`/`POST /applets`, `POST /applets/{name}/versions`,
`POST /applets/{name}/revert`, and `GET /applets/{name}/files/{path}` for the
current version's static files.

## `agent_event` subtypes

All events in this section are wrapped as
`{ type: "agent_event", data: { runId, event } }`. They are streamed through
the per-session interfaces, but they are not persisted to the durable global
queue.

### Inference message stream

| `event.type`     | Meaning                                                         | Additional fields                     |
| ---------------- | --------------------------------------------------------------- | ------------------------------------- |
| `start`          | Assistant message generation started.                           | `partial`                             |
| `block_start`    | A tentative provider response block started.                    | None                                  |
| `block_stop`     | The current provider response block committed.                  | None                                  |
| `block_reset`    | The current tentative provider response block was rolled back.  | `partial`                             |
| `retrying`       | The provider is retrying inference.                             | `attempt`, `reason`                   |
| `text_start`     | A text content block started.                                   | `contentIndex`, `partial`             |
| `text_delta`     | More text arrived for a content block.                          | `contentIndex`, `delta`, `partial`    |
| `text_end`       | A text content block completed.                                 | `contentIndex`, `content`, `partial`  |
| `thinking_start` | A reasoning content block started.                              | `contentIndex`, `partial`             |
| `thinking_delta` | More reasoning content arrived.                                 | `contentIndex`, `delta`, `partial`    |
| `thinking_end`   | A reasoning content block completed.                            | `contentIndex`, `content`, `partial`  |
| `toolcall_start` | A model-generated tool call started.                            | `contentIndex`, `partial`             |
| `toolcall_delta` | More serialized tool-call arguments arrived.                    | `contentIndex`, `delta`, `partial`    |
| `toolcall_end`   | A model-generated tool call completed.                          | `contentIndex`, `toolCall`, `partial` |
| `done`           | The provider completed an assistant message normally.           | `reason`, `message`                   |
| `error`          | The provider ended an assistant message with an error or abort. | `reason`, `error`                     |

The terminal `done` and `error` stream events are not global queue entries. The
fully materialized message is subsequently emitted as `agent_message`, and the
run outcome is emitted as `run_finished` or `run_error`.

A `retrying` update is live progress, but its failure is also committed as an
`agent_message` with `role: "error"`, `outcome: "retried"`, `attempt`, and
human-readable text blocks. A terminal run failure uses the same message role
with `outcome: "failed"`. These messages remain in visible history and in
the active model context after restart; run boundary events carry the terminal
status but are not a second source of failure history.

The active model context is persisted independently from visible history as
ordered rows in `session_context_messages`. Compaction, internal context, and
durable errors are restored from those rows; compaction and error messages
update them in the same transaction as their committed `agent_message` event.

Presentation-only inference message stream events are not written to
`session_events`. A `block_reset` is retained so reconnecting clients can erase
rolled-back output. Restoring completed turns uses the canonical
`agent_message`, transcript message, and run lifecycle records as its durable
history.

Session event IDs are ordered UUIDv7 cursors. After a restart, a cursor that
identified a live-only inference stream event resumes at the first later
durable event. Earlier durable events are not replayed, and later durable events
are not hidden. Malformed cursors, cursors older than retained history, and
cursors beyond the session's last issued event remain invalid and return 409.

### Agent loop, tool, and process updates

| `event.type`                   | Meaning                                                                | Additional fields                                                                        |
| ------------------------------ | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `context_compacted`            | Older model context was summarized automatically.                      | `compactedMessageCount`, `estimatedTokensBefore`, `estimatedTokensAfter`, `reason`       |
| `inference_iteration_start`    | A new model inference iteration started within the run.                | `iteration`                                                                              |
| `steering_applied`             | Queued steering messages were incorporated into the model context.     | `messageIds`                                                                             |
| `tool_execution_start`         | Execution of a model-requested tool began.                             | `toolCall`                                                                               |
| `tool_execution_end`           | Tool execution finished.                                               | `result`, containing `type`, `toolCallId`, `toolName`, `display`, and optional `isError` |
| `tool_execution_progress`      | A running tool reported new human-readable progress.                   | `toolCallId`, `display`                                                                  |
| `tool_execution_status`        | A running tool reported a status label.                                | `toolCallId`, `status`                                                                   |
| `tool_batch_rejected`          | A batch of tool calls was rejected, such as for duplicate identifiers. | `toolCallIds`                                                                            |
| `permission_review`            | Auto permissions reviewed a proposed tool action.                      | `toolCallId`, `action`, `decision`, `reason`, `risk`, `userAuthorization`                |
| `background_processes_changed` | The number or details of active managed background processes changed.  | `running`, optional `processes`                                                          |
| `background_processes_stopped` | Active background processes were stopped after a permission reduction. | `count`                                                                                  |

`decision` is `allow` or `ask`. `risk` and `userAuthorization` are each `low`,
`medium`, or `high`.

## Timelines

`POST /timeline` derives when each agent in a scope worked, waited for the person, or asked them
something. It writes nothing: the answer is folded from the durable lifecycle events above —
`message_submitted`, `run_started`, `run_finished`, `run_error`, `user_input_requested`, and
`user_input_resolved` — narrowed in SQL before any payload is read. Clearing session history
therefore clears the timeline with it, and no separate span table can disagree with the events.

A scope is global, a project, a workspace, or a session; a session scope includes its subagents at
any depth. A global scope covers every agent Happy Agent knows about, across every project, and is
deliberately unfiltered: it grows with everything Happy Agent has ever run, so callers bound it with `since`
when only recent work is wanted. The response carries the live-stream cursor it reflects, so a
client can tell whether a later event is already included and then keep the chart current from the
same global stream.

Because a run's start and end are durable but its interior is not, a timeline reports run
granularity rather than individual inference and tool calls. A run with no recorded ending, on a
session that is no longer working, is reported as `interrupted` rather than `completed`.

## Source of truth

The public contract is defined in `packages/happy-agent/API.md` and implemented by the TypeBox
schemas under `packages/happy-agent-client/sources/protocol/`. The daemon's durable event journal
is owned by `packages/happy-agent-modules/sources/events/`.
