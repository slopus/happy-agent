# Code Mode learnings

## The module selects an engine; it does not implement one

Code Mode's root module owns enablement, ordered hook replacement, the one engine-selection seam,
and orderly startup and shutdown. Engine-specific prompts, tool schemas, execution, state,
recovery, and host bridges live together under `engines/<engine>/`. Do not add another interpreter
by branching through `CodeModeModule` or sharing Monty's checkpoint and Python machinery; implement
the `CodeModeEngine` lifecycle and select it at the one seam instead.

## The selected interpreter is available, not mandatory

Code Mode replaces the ordinary tool surface with its selected interpreter, but it does not
require a tool call for every response. The model may answer directly when execution would not
help the user's request.

Code Mode tools are explicitly eager and carry capability text. The override removes every other
tool, including provider discovery, so deferring the sole interpreter would leave the model with no
direct execution surface. Keep Code Mode in the eager-tool policy alongside compute and user input.

## The Bun proof of concept is a stateless system process

The Bun engine intentionally starts with the smallest boundary that can validate the experience:
each `javascript` call runs TypeScript directly through `bun -e` on the agent's Compute shell. It
depends on `bun` being present on `PATH`, retains no globals or snapshots, and does not reuse the
Monty worker or checkpoint machinery. Compute supplies the current permission sandbox, working
directory, process-tree cancellation, output bounds, and a per-invocation wall timeout. A future
bundled or continuous Bun kernel should replace this engine internally without widening the root
Code Mode module.

## Monty OS access is an explicit compute seam

Code Mode answers Monty's date and datetime calls from the daemon clock and lets environment APIs
behave normally over an intentionally empty mapping: `os.getenv` returns its supplied default and
`os.environ` is empty. Filesystem calls go through the agent's `ComputeModule`, not a Monty host
mount, so host, scripted, and remote machines all see the same paths and every operation carries
the tool call's current permission mode. Network, shell, and the daemon environment remain absent.

The one Python argument can calculate paths dynamically, so Auto cannot review a particular path
before the tool begins. Keep the Python tool sandboxed in Auto and let compute refuse paths that
would require Full access; never elevate the entire interpreter because its source might contain
one such path. Monty's JavaScript conversion currently has no return marker for `Path` or
`os.stat_result`: path-returning calls use strings, while stat uses one fixed frozen dataclass
marker so normal named metadata fields remain available. Compute also has no race-safe empty
directory removal primitive, so `Path.rmdir()` remains unhandled rather than emulating it with a
recursive delete.

Filesystem writes are external side effects and cannot commit atomically with the snapshot file.
The stable call journal prevents replay after the completed checkpoint is durable, but a process
death after a file mutation and before that checkpoint can still rerun the Python program. Keep
whole-file writes idempotent where possible; append is implemented as one bounded read followed by
one whole-file write and is not a concurrency primitive.

## Continuity belongs to opaque session dumps, not checked-out workers

Keeping a Monty session checked out would bind one subprocess to every active agent and make
shutdown, cancellation, and crash recovery fragile. Code Mode instead serializes Monty's opaque
idle-session dump after each call and restores it into a fresh checkout for the next call. A
per-agent async lock makes the read-run-dump transition atomic while still allowing different
agents to use the shared pool concurrently.

Monty's execution-duration counter is cumulative and is part of a restored dump. A session-wide
`maxDurationSecs` therefore turns into a shrinking lifetime budget across calls rather than a
per-call limit. Code Mode keeps memory and recursion limits and relies on the pool's
`requestTimeout` as the per-call crash watchdog.

The shared pool starts with no prewarmed workers and grows on the first checkout. Warming a worker
inside the module startup hook can take longer than the daemon launcher's readiness window even
though checkout itself is fast, making a healthy daemon look like it failed to start.

## The tool result and Python state need one write-ahead order

Persisting only after the turn left a crash window: Base could durably publish a tool result while
the state that produced it still existed only in module memory. Retrying the durable call could
then execute its mutation twice. Every call now writes one versioned checkpoint before
`AgentToolCall.commit`. The checkpoint carries the final dump and a bounded journal of stable call
IDs paired with their exact structured results. A replayed ID commits and returns its recorded
result without entering Monty.

Base may start several tool calls concurrently. Code Mode holds its per-agent lock across
checkpoint replacement and `call.commit`, while the journal retains all records until `afterTurn`
proves the batch settled and compacts them. Thus even a failed commit followed by a sibling write
keeps both replay identities. Commit is the final action because a successful commit aborts its
call context. The filesystem checkpoint is a deliberate feature-specific exception to the usual
AgentKV guidance: the requested contract fixes the ConfigModule-owned location at
`.happy/agent/state/<agentId>/snapshot.bin`.

An ordinary Python exception does not make a session unusable: mutations before the exception are
dumped and checkpointed. Cancellation, a worker crash, a protocol failure, or a dump failure cannot
prove a replacement state, so the prior snapshot remains authoritative. There is no dirty snapshot
map. Four global permits bound the number of concurrently loaded checkpoints to the pool's four
workers, preventing many different agents from each retaining a maximum-sized dump while queued.

## Atomic replacement includes directory durability

The checkpoint uses a unique same-directory private temporary file, file fsync, atomic rename, and
directory fsync. When recursive state directories are created for the first time, their entries and
existing parent are synced as well. Directory sync ignores only explicit unsupported-operation
codes; I/O and capacity failures propagate, so the call cannot publish a result whose checkpoint is
not durable.

## Incompatible bytes are evidence worth keeping once

Snapshot bytes are version-specific. Empty, oversized, corrupt, or incompatible bytes are moved
to `snapshot.invalid.bin`, replacing the previous invalid copy, and the affected agent starts
fresh. Transient filesystem and worker failures do not quarantine or overwrite the last snapshot.
