# Claude Agent driver

Drives Claude Code through the Claude Agent SDK and presents it to [`protocol/acp`](../../protocol/acp/README.md)
as an `AcpAgentConnection`, so the `claude` ACP agent needs no adapter process.

- Each ACP session is one `query()` fed by an input queue; restores use `resume`.
- `steer` pushes a user message with `priority: "next"`, so it lands inside the running turn.
  `cancel` calls `interrupt()`.
- Config options (model with efforts, effort, permission mode) come from `supportedModels()` and
  map onto `setModel`, `applyFlagSettings` and `setPermissionMode`.
- Tool permission asks go to the client's `requestPermission`.
- A side question (Claude Code's `/btw`) goes to the session's `Query.askSideQuestion`, which the SDK ships without public types. Claude Code answers it as its `side_question` control request, beside a running turn and without adding to the conversation. For a stored session no process here runs, `claudeAgentStoredSideQuestion` starts a separate Claude Code that resumes it as a fork that is never written to disk (`forkSession`, `persistSession: false`), with no MCP servers (`strictMcpConfig`) and the person's hooks off (`disableAllHooks`), sets the session's model and effort, asks, and ends; stopping the question closes it at once, also while it starts. An API error, such as a rate limit, comes back as Claude Code's canned reply saying so (`synthetic: true`). A side question that gets no answer at all fails with a sentence a person can act on, such as a conversation Claude Code no longer has; Claude Code's own words can name paths, so they travel only as the error's `cause`.

## Files

- `claudeAgentConnect.ts` — the connection, its sessions, and side questions about them.
- `impl/AsyncInputQueue.ts` — the prompt stream fed to `query()`.
- `impl/claudeAgentUpdates.ts` — SDK messages → ACP `session/update`.
