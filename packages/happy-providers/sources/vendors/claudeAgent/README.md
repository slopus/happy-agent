# Claude Agent driver

Drives Claude Code through the Claude Agent SDK and presents it to [`protocol/acp`](../../protocol/acp/README.md)
as an `AcpAgentConnection`, so the `claude` ACP agent needs no adapter process.

- Each ACP session is one `query()` fed by an input queue; restores use `resume`.
- `steer` pushes a user message with `priority: "next"`, so it lands inside the running turn.
  `cancel` calls `interrupt()`.
- Claude Code starts a turn by itself when a background command finishes: a fresh `system/init` and the model's output arrive after the previous result, with no user message. The driver announces such a turn with `_happy/turn_started` before its first update and ends it at its result with `_happy/turn_ended`, so it can be shown, steered and stopped like any other. A prompt sent while it runs joins it with `priority: "next"` and is answered at its result.
- Config options (model with efforts, effort, permission mode) come from `supportedModels()` and
  map onto `setModel`, `applyFlagSettings` and `setPermissionMode`.
- Tool permission asks go to the client's `requestPermission`.

## Files

- `claudeAgentConnect.ts` — the connection and its sessions.
- `impl/AsyncInputQueue.ts` — the prompt stream fed to `query()`.
- `impl/claudeAgentUpdates.ts` — SDK messages → ACP `session/update`.
