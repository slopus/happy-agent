# Claude Agent driver

Drives Claude Code through the Claude Agent SDK and presents it to [`protocol/acp`](../../protocol/acp/README.md)
as an `AcpAgentConnection`, so the `claude` ACP agent needs no adapter process.

- Each ACP session is one `query()` fed by an input queue; restores use `resume`. Opening or restoring a session ends the connection's other sessions, and their Claude Code processes with whatever they still run: the client has moved on from them, and their output would reach nobody.
- `steer` pushes a user message with `priority: "next"`, so it lands inside the running turn.
  `cancel` calls `interrupt()`.
- Claude Code starts a turn by itself when a background command finishes: a fresh `system/init` and the model's output arrive after the previous result, with no user message. The driver announces such a turn with `_happy/turn_started` before its first update and ends it at its result with `_happy/turn_ended`, so it can be shown, steered and stopped like any other. A prompt sent while it runs joins it with `priority: "next"` and is answered at its result.
- Claude Code lists every background task it keeps running — background commands, monitors, subagents and workflows — in `system/background_tasks_changed` whenever that set changes. The driver sends how many there are with `_happy/background_work`, leaving out the `ambient` ones that Claude Code says are not activity, so a session whose turn has ended can still be shown as working. Nothing is sent when a process starts: a new Claude Code process has no background tasks.
- Config options (model with efforts, effort, permission mode) come from `supportedModels()` and
  map onto `setModel`, `applyFlagSettings` and `setPermissionMode`.
- Tool permission asks go to the client's `requestPermission`. A refusal's
  `happy/refusalReason` metadata, such as Happy's Auto reviewer's reason, becomes the message
  Claude is told.

## Files

- `claudeAgentConnect.ts` — the connection and its sessions.
- `impl/AsyncInputQueue.ts` — the prompt stream fed to `query()`.
- `impl/claudeAgentUpdates.ts` — SDK messages → ACP `session/update`.
