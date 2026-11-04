# Claude Agent driver

Drives Claude Code through the Claude Agent SDK and presents it to [`protocol/acp`](../../protocol/acp/README.md)
as an `AcpAgentConnection`, so the `claude` ACP agent needs no adapter process.

- Each ACP session is one `query()` fed by an input queue; restores use `resume`.
- `steer` pushes a user message with `priority: "next"`, so it lands inside the running turn.
  `cancel` calls `interrupt()`.
- Config options (model with efforts, effort, permission mode) come from `supportedModels()` and
  map onto `setModel`, `applyFlagSettings` and `setPermissionMode`.
- Tool permission asks go to the client's `requestPermission`.
- Claude Code keeps its own auto-compaction. The privacy environment Happy's own Claude loop uses
  turns it off because that loop compacts for Claude Code; nothing compacts this one, and without
  it every turn past the window fails with "Prompt is too long".
- A turn's usage is its last main-thread API call, cached prompt included, so input is the context
  the conversation fills. The SDK result sums the turn's calls and counts only uncached input.
- `rate_limit_event` reports go to `onAccountUsage`, as Happy's own Claude loop reports them.

## Files

- `claudeAgentConnect.ts` — the connection and its sessions.
- `impl/AsyncInputQueue.ts` — the prompt stream fed to `query()`.
- `impl/claudeAgentUpdates.ts` — SDK messages → ACP `session/update`.
- `impl/claudeAgentUsage.ts` — a turn's usage from its last main-thread API call.
