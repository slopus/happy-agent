# Managed workspace initialization debt

The non-blocking managed-workspace contract is implemented and has no known
Critical or Major review findings.

The completed contract is:

- Workspace creation immediately returns a durable `initializing` reservation.
- Sessions and idempotent message submissions are accepted during initialization.
- Queued runs persist atomically and survive daemon restart.
- Runtime creation and provider inference wait for a `ready` workspace with a
  present checkout.
- Existing realtime workspace events automatically release queued runs in each
  session's submission order.
- Initialization failure, disappearance, archival, and exhausted availability
  checks append a durable `run_error` while preserving the session and user
  message.
- Files, terminals, shell operations, forks, transfers, and agents remain gated
  on checkout readiness.
- Local, remote, and plugin clients use the same server lifecycle.
- Plugins can subscribe reactively to workspace lifecycle events.
- Workspace-agent creation waits through the existing event lifecycle.
- Git initialization is bounded and serialized where the shared repository
  requires it, without blocking durable reservation.

## Deferred debt

1. A native provider `session()` construction that never resolves cannot be
   force-cancelled. A late resolution is destroyed correctly, but a permanently
   hung construction can retain its isolated executor.
2. Force-closed executors reject ordinary inference and late session resolution,
   but not every auxiliary entry point applies the same closed-state guard.
3. Optional metadata teardown failures are deliberately contained so they cannot
   fail a user run, but they have no bounded diagnostic reporting.
4. During an internal checkout-readiness retry, the in-memory waiting flag can
   temporarily be ahead of its conservative durable value. Restart remains safe,
   but the two representations are not updated on every timer tick.
5. Workspace-agent readiness waiters trust durable workspace presence. Runtime
   and session admission still recheck the checkout and fail closed if it
   disappeared.
6. Structured debug request content is not restored for a queued debug run after
   daemon restart.
7. Git reftable repositories are not inspected for managed branch collisions.
8. Packed-ref collision inspection is bounded, but still performs synchronous
   Git metadata reads before durable reservation.
9. Plugin workspace event subscriptions do not reconnect or resume after a
   dropped event stream, and the server stream needs an explicit backpressure
   strategy.
10. FIFO execution is guaranteed within each session. There is no single global
    provider-start order across multiple sessions waiting on one workspace.
11. Per-project initialization locks are retained for the lifetime of the
    repository rather than evicted after inactivity.

## Validation record

- The complete Rig test suite passed after the final lifecycle changes.
- The `rig-execution` suite passed.
- Focused Happy plugin contract tests and all relevant typechecks passed.
- The Docker gym scenario for reservation, queued inference, setup completion,
  and automatic release passed against the final code.
- Independent GPT and Opus reviews iterated until both reported no Critical or
  Major findings.

The managed-workspace changes shipped in `@slopus/rig@0.0.141`. The companion
client release is `@slopus/rig-connect@0.0.38`; `happy-plugins` remains
`0.0.5`.
