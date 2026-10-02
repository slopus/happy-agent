# Sanitized native Context window fixtures

These files contain invented test content in the native formats of Happy Agent revision
`115be1c248985b823491f852dbde47ea7e6a76fd`. They contain no account data or private transcripts.
They are fixtures, not live authenticated acceptance evidence.

`context-records.json` follows `AgentRecord` in
`packages/happy-agent-base/sources/AgentPersistence.ts` and `SessionMessage` in
`packages/happy-providers/sources/core/SessionContext.ts`. `context-response.json` is the exact
existing machine-RPC response for those records persisted with `JSON.stringify`. The reader tests
compare it with real SQLite persistence; browser consumers may reuse the same response fixture.
The opaque checkpoint string is deliberately synthetic, never a claimed decrypted summary.

The fixture includes a retained replacement context, a recorded system injection with
`metadata.hideFromUser`, full assistant output, and a paired native tool call/result with 80 lines.
Its `context.*` kinds describe raw records, not an invented assembled model request. Compaction
records also install forked initial contexts; their presence alone cannot prove a compaction ran.
The separate lifecycle test therefore runs the real Agent loop with scripted provider inference,
performs two actual compactions, checks physical predecessor replacement, accepts a hidden system
injection, and compares the RPC content against the real stored sequence. Another test creates an
actual child with native `initialContext` and a distinct remote-session binding. Database rollback
coverage proves that uncommitted writes are absent; it does not claim conversation-rewind behavior.

No reader reconstructs discarded context from the presentation History archive, regenerates system
instructions/tools, decrypts opaque fields, or accesses another state home. Responses over the
existing `HAPPY_RPC_MAX_JSON_BYTES` relay ceiling return `unreadable`; they are never truncated and
cannot count as full-content acceptance. Offline transport is unavailable at the caller; Retry
reissues the same encrypted machine method.
