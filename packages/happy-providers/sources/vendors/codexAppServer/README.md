# Codex app-server driver

Drives Codex through `codex app-server` (JSON-RPC over stdio) and presents it to
[`protocol/acp`](../../protocol/acp/README.md) as an `AcpAgentConnection`.

- Sessions are threads (`thread/start`, `thread/resume`); prompts are `turn/start` with the
  selected model, effort and sandbox policy.
- `steer` is `turn/steer` against the running turn; `cancel` is `turn/interrupt`.
- Models and efforts come from `model/list`.
- `account/rateLimits/updated` carries no thread; its account limits go to `onAccountUsage`.
- Happy tools are an `mcp_servers` entry in the thread config, pre-approved; command and file
  approvals go to the client's `requestPermission`.

## Files

- `codexAppServerConnect.ts` — the app-server process, its threads and turns.
- `impl/codexItemUpdates.ts` — app-server items → ACP tool call updates.
- `resolveCodexExecutable.ts` — which `codex` to start: pinned, on PATH, or through `npx`.
