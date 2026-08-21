# Agents and collaboration

Happy Agent runs many agents at once: the conversation the user is talking to, subagents
it spawned, agents working in other workspaces, and agents the user connected by
hand. This document describes how they are started, how they talk to each other,
how work is scheduled in time, and what the human sees while it happens.

One rule underpins the rest: **agents never die**. A subagent that finished its
task is not gone — its parent can send it a follow-up and it resumes with its
full context.

## Sessions and subagents

- A **primary session** is a conversation the user can see and talk to. It owns
  the workspace tools, `schedule_message`, and `cancel_ask`.
- A **subagent** is an agent spawned and driven by another agent rather than by a
  person. It is not human-visible in the ordinary session list.

Subagents are limited by depth and by concurrency:

| Limit                                   | Default |
| --------------------------------------- | ------- |
| Nesting depth                           | 3       |
| Concurrently running subagents per tree | 8       |
| Same, for Codex v2 collaboration models | 10      |

A subagent at maximum
depth is told to finish the task itself, and a subagent may only delegate further
when its parent explicitly said so in the assigned task. Having collaboration
tools is not permission to use them for nested delegation.

## Spawning a subagent

Each provider keeps its own tool names and schemas; the behavior underneath is
the same.

| Provider          | Spawn            | Follow-up                       | Wait / read                                                    | Stop                       |
| ----------------- | ---------------- | ------------------------------- | -------------------------------------------------------------- | -------------------------- |
| Claude            | `Agent`          | `SendMessage`                   | `TaskOutput`                                                   | `TaskStop`                 |
| Codex (v2 models) | `spawn_agent`    | `followup_task`, `send_message` | `wait_agent`, `list_agents`                                    | `interrupt_agent`          |
| Codex (v1 models) | `spawn_agent`    | `resume_agent`, `send_input`    | `wait_agent`                                                   | `close_agent`              |
| Grok              | `spawn_subagent` | `followup_subagent`             | `wait_commands_or_subagents`, `get_command_or_subagent_output` | `kill_command_or_subagent` |

Which Codex set a model gets is decided per model.

The Claude-shaped tool shows every argument that matters:

```json
{
    "description": "Audit retry semantics",
    "prompt": "Read the provider layer and report where retries are replayed...",
    "provider": "claude",
    "model": "anthropic/sonnet-5",
    "effort": "medium",
    "run_in_background": true,
    "context": "task",
    "read_only": true,
    "service_tier": "priority"
}
```

**Model and effort are required, and are never inherited.** Write the model ID
exactly as it appears in the _Available models_ section of the system prompt, and
pick an effort from that model's allowed levels. Use the model's default effort,
or lower, for research, review, and other bounded work; reserve `xhigh`, `max`,
and `ultra` for work the user asked to run that way. `provider` is optional and
is otherwise inferred from recent successful use, the current provider, or the
first available match.

**Context inheritance** is the `context` argument, a Happy Agent extension:

- `"task"` (default) — the child starts with only the delegated prompt. Prefer
  this; it keeps the child's context small and its task unambiguous.
- `"parent"` — the child continues with the parent thread's context.

**Background versus foreground**: `run_in_background` defaults to `true`. A
background spawn returns immediately with `status: "async_launched"` and a task
name; a foreground spawn (`run_in_background: false`) blocks and returns the
child's final output. Choose foreground only when you cannot continue without the
result.

**Permissions**: `read_only: true` runs the child in Read only; omitting it means
the child inherits the parent's permission mode. The same flag on `SendMessage`
and `agent_send` can tighten or restore a child's mode later.

**Service tier**: `service_tier: "priority"` requests priority service when the
selected provider supports it.

### Waiting for background work — do not poll

A background subagent notifies its parent when it finishes, even while the parent
is idle. `TaskOutput` therefore defaults to a one-hour wait for agents (30 seconds
for shell tasks and workflows). Wait once for a long time, or simply end the turn.
Every short wait that times out costs a full model turn over the whole context and
teaches you nothing.

```json
{ "task_id": "<sessionId>" }
```

`TaskStop` stops a running or suspended agent; `TaskOutput` with `block: false`
peeks at its status without waiting.

### Follow-up work

A finished subagent is still reachable. `SendMessage` resumes it with its context
preserved:

```json
{
    "to": "audit-retry-semantics",
    "message": "Now check the Grok provider too and update your report.",
    "summary": "Extend the audit",
    "effort": "high"
}
```

`to` accepts the task name, the path, or the agent ID. `effort` changes the
child's effort for the continued work; `read_only` changes its permission mode.
Codex uses `followup_task` and Grok uses `followup_subagent` for the same thing.

## Talking to any agent: `agent_me`, `agent_info`, `agent_send`

Subagent tools only reach your own children. To reach _any_ agent in the system —
a delegated workspace session, another primary conversation, an agent on another
machine — Happy Agent uses agent IDs.

An agent ID is unguessable. There is no discovery and no listing by design: the
user shares IDs by hand, or you obtain one from a tool that returns it, such as
`delegate_to_workspace` or `list_workspace_sessions`.

The handshake is three steps:

1. **`agent_me`** — your own ID and title. Show it to the human so they can hand
   it to another agent.

    ```json
    {}
    ```

2. **`agent_info`** — inspect an exact, already-known ID. This _cannot_ search or
   list. It answers with the target's title and either `diskShared: true` plus a
   `path` you can actually use, or `diskShared: false` with a notice that you
   cannot reach its folder.

    ```json
    { "agent_id": "agt_..." }
    ```

3. **`agent_send`** — deliver a steering message. Calling `agent_info` for that
   exact ID first is enforced: without it, the send is rejected with "Call
   agent_info with this agent ID before sending it a message."

    ```json
    { "agent_id": "agt_...", "message": "Please rebase on origin/main and re-run the suite." }
    ```

The receiver is told who sent the message — the sender's agent ID and title, and
the sender's folder when the disks are shared — so it can answer through the same
handshake. `agent_send` also accepts `read_only` for a child this agent started:
`true` restricts it to Read only, `false` restores the sender's current mode.

## Delegating into a workspace

Two tools start work in another workspace; see
[`workspaces.md`](workspaces.md) for the workspace side.

- **`spawn_workspace_agent`** — a hidden managed subagent whose working directory
  is the workspace. Appears under your session, reports its result to you, and is
  driven with the ordinary subagent tools.
- **`delegate_to_workspace`** — a visible conversation with its own place in the
  user's session list. It keeps your session as its parent and returns an
  `agentId`, so you keep talking to it with `agent_info` + `agent_send`.

A delegated session sends the run's completion status and result back to its
delegator. Messages the user writes in that conversation stay in that
conversation.

Only a primary session can delegate, and never into its own workspace.

## Scheduling

Every model on every provider gets `wait` and `wait_until`. Agents that are not
subagents also get `schedule_message`; subagents never do.

### Durable waits

```json
{ "duration": "1h 30m" }
```

`wait` accepts `seconds`, `hours`, `days` (fractional allowed) or a human-readable
`duration`, up to about 24 hours. `wait_until` takes a date at most 24 hours away
as ISO 8601, RFC 2822, Unix seconds, or Unix milliseconds:

```json
{ "at": "2026-08-01T18:30:00Z" }
```

Both are **durable**: the wait survives a daemon restart, and while it runs the
session state shows the session as waiting. Any new message in that chat ends the
wait early. The result says what actually happened:

```json
{
    "started_at": "...",
    "due_at": "...",
    "ended_at": "...",
    "elapsed_seconds": 412,
    "interrupted": true,
    "reason": "message_received"
}
```

Use a wait for real elapsed time — a rate limit, a scheduled event, a deployment
window. Do not use it as a polling loop over a background subagent.

### Scheduled messages

`schedule_message` sends a message at a future time to any agent whose exact
agent ID you know, including yourself:

```json
{
    "agent_id": "agt_...",
    "message": "Check whether the nightly build went green and summarize it.",
    "hours": 8
}
```

Use either `at` (a date) or a delay (`duration`/`seconds`/`hours`/`days`), never
both. The tool returns `{ id, due_at, status: "pending", target_agent_id }`. If
delivery fails, the scheduled message stays with the sender. Scheduled messages
and their updates synchronize on reconnect so the UI can show them, they remain
in history when an agent stops, and the user can cancel one by hand.

Scheduling a message to yourself is the ordinary way to pick work back up later
without holding a session open.

## The Inbox

The Inbox is the durable place where agents reach the human. When a model asks a
question — `AskUserQuestion` for Claude, `request_user_input` for Codex — the
question appears in the chat _and_ in the Inbox as one shared state. Answering it
in either place closes it in both; a question answered in the terminal still shows
in the Inbox, as answered.

Because a human may not be looking, a question can hang for a long time, so ask
well: include the context the person needs to decide without opening the chat, not
an abstract one-liner.

When presence stops the wait before the human answers, the tool returns a
description that names the presence, says how long it waited, and gives an **ask
id**. The question stays in the Inbox. You then either continue on your own
judgement, or withdraw it:

```json
{ "ask_id": "ask_...", "reason": "I went with the safer default and no longer need this." }
```

`cancel_ask` is available to primary sessions, not to subagents.

## Presence

Presence tells every agent whether the human can be reached and what to do when
they cannot.

| State     | `answerWaitMs` | Meaning                                                                                                                               |
| --------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Online 🟢 | `null`         | The user is at the keyboard; a question may wait indefinitely.                                                                        |
| Away 🌙   | `0`            | The user cannot be reached; never wait. Decide with your best judgement, keep working, and record anything they should look at later. |

The user can define custom states in configuration. A state carries a title, an
emoji, a model-facing prompt, and a wait budget that may be unlimited (`null`),
immediate (`0`), or finite — for example fifteen minutes, after which the agent is
told to continue on its own. A state can also be temporary, with a fallback state
to return to when it expires.

The current presence is injected into every model, and when it changes mid-run the
model receives a system notice with the new state and its instructions. Follow the
active presence's instructions until Happy Agent says they changed. In practice: under
Away, never block on a human — ask if it is genuinely useful, note it in the
Inbox, and carry on.

## Concurrency model

Happy Agent's concurrency is built from a few small lowercase functions, not from classes
or ad-hoc promise chains:

- `asyncLock` / `asyncQueue` — an object with `runInLock`. A lock already
  guarantees order, so the two are functionally identical and the name is chosen
  for readability at the call site. Semaphores are almost never needed.
- `delay` — a plain wait, and an aborting variant that throws an abort exception
  when the program starts shutting down. That exception is normal, not a failure;
  it is handled or rethrown at the level that cares.
- `backoff` — exponential retry, infinite by default, honouring an abort signal.
- `retry` — a backoff bounded in time; it throws when the time runs out.
- `forever` — a named loop of `backoff` with a delay between passes, running until
  shutdown. The name is what tells you which loop is holding up a shutdown.
- `gracefulShutdown` — a named map of async handlers the daemon awaits, so a slow
  shutdown can be attributed to a name.

Provider usage polling is the model case: one named `forever` per provider, every
fifteen minutes, providers polled in parallel, answers kept in memory with their
capture time and handed out by an endpoint that clients poll. Nothing there is
durable or pushed. `get_provider_usage` reads these values, so they may be up to
fifteen minutes old.

### What actually runs in parallel

- **Tool calls within one turn.** Independent tool calls issued in the same
  response run together; dependent ones must wait for the value they need.
- **Subagents.** Up to the active limit above, per agent tree. Background spawns
  return immediately; the parent should keep doing useful work rather than idling.
- **Delegated sessions and workspace agents.** Each runs in its own workspace, so
  their file changes cannot collide.
- **Waits and scheduled messages.** Durable, daemon-owned, and independent of
  whether a session is currently rendering.

### Identity across asynchronous boundaries

Run IDs, message IDs, tool-call IDs, session IDs, and agent IDs stay stable across
async boundaries, and Happy Agent relies on that: durable waits are keyed by tool-call and
batch identity so a restart resumes the same call, delegation notifications name
the delegate's session ID and agent ID, and workspace creation reconciles to one
entity across the local result, the response, live events, refresh, and reconnect.
When you write code in this area, treat delayed, duplicated, reordered, rejected,
and already-applied outcomes as expected, and publish notifications only after the
durable transaction commits.

The outer agent loop never replays a provider request, tool, command, or session
mutation on its own; retry semantics belong to each provider.

## Observing a tree of agents

- **`get_agent_tree_usage`** — exact lifetime token usage for this session and
  every recursively linked descendant, including hidden subagents, delegated
  sessions, and finished ones, each counted once.
- **`read_agent_history`** — read or search Happy Agent's durable low-level inference
  history for this agent or another agent in the tree (`target` accepts a task
  path, task name, or session ID; `/root` is the parent). Useful after a model
  change or when earlier context was summarized. Responses are simplified and
  capped, so page with the returned cursors.
- **`list_workspace_sessions`** — what conversations exist and which agent started
  each one.

## Practical guidance

1. Do simple work yourself. Delegate concrete, bounded work that is genuinely
   independent or benefits from separate context.
2. Give each child one clear task and complete instructions; a child started with
   `context: "task"` knows only what you wrote.
3. Pick the model and effort deliberately for the child's task — defaults are not
   inherited, and cheap bounded work does not need a top-tier model at high
   effort.
4. Spawn in the background, keep working, and let the completion notification come
   to you.
5. Use follow-ups instead of respawning: a finished subagent still holds its
   context.
6. Use `agent_info` before `agent_send`, always — it is enforced.
7. Under Away presence, never block on the human. Ask in the Inbox with full
   context, continue on your best judgement, and withdraw the question with
   `cancel_ask` if it stops mattering.
8. Isolate parallel work in separate workspaces; keep subtasks of one task in the
   current workspace.
