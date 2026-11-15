# Claude Agent driver

Drives Claude Code through the Claude Agent SDK and presents it to [`protocol/acp`](../../protocol/acp/README.md)
as an `AcpAgentConnection`, so the `claude` ACP agent needs no adapter process.

- Each ACP session is one `query()` fed by an input queue; restores use `resume`.
- `steer` pushes a user message with `priority: "next"`, so it lands inside the running turn.
  `cancel` calls `interrupt()`.
- Config options (model with efforts, effort, permission mode) come from `supportedModels()` and
  map onto `setModel`, `applyFlagSettings` and `setPermissionMode`.
- Tool permission asks go to the client's `requestPermission`.
- Fresh or switched sessions restore structured messages through the SDK's session store.
  Tool calls and results stay paired; a long working exchange is not flattened into one user
  prompt. Native compaction checkpoints replay their exact retained content, including opaque
  reasoning and attachments. The portable projection is checked before replacement.
- Before the first inference of a restored context, the native full context report budgets the
  assembled instructions, tools, messages, attachments and reserve. Deferred schemas do not
  occupy the input window. Diagnostics contain only numeric counts and known category labels;
  message subtotals are not added to the total again.
- If the context does not fit, the provider reports that compaction is required; the outer agent
  loop owns the single recovery attempt through native `/compact`. The replacement must reduce
  the input and fit before it is adopted. An oversized fixed
  context, unavailable budget, or ineffective compaction produces a terminal actionable error;
  repeating Continue or changing to a compatible account cannot bypass that check.
- Recovery changes the inference view only. Happy's durable transcript, permission evidence,
  pending operations and workspace remain with their existing owners. An outstanding tool
  result must settle before a new native transcript can be seeded.

## Files

- `claudeAgentConnect.ts` — the connection and its sessions.
- `impl/AsyncInputQueue.ts` — the prompt stream fed to `query()`.
- `impl/claudeAgentUpdates.ts` — SDK messages → ACP `session/update`.
- `impl/claudeContextBudget.ts` — validated, redacted native context accounting.
- `impl/readClaudeNativeCompaction.ts` — complete native checkpoint validation and replay.
