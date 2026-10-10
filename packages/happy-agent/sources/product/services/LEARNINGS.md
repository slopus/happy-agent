# Native service learnings

The original service catalog belongs to the main root AgentKV under
`agentSystem.modules.services`. Preserve its records, immutable pages, owner placement and closed
admission header. A restored catalog is not a request to run its commands again.

`services.execution` owns each process through Durable Functions. The exact call-scoped
`spawn-attempted!` checkpoint commits before spawning. A claimed or previous-daemon execution
reconciles its native controls and never replays the stored command. Transient metadata or cleanup
failures remain owed until cancellation rather than deleting the cleanup intent.

Archival closes admission and records revocation in the caller's transaction. Signals run after
commit, so rollback preserves the live execution. Folder removal requires a separate positive
proof: every recorded native owner identity is gone, the cgroup is empty and the private bridge is
closed. Ambiguous or incomplete startup controls retain the execution directory and workspace.
Recovered cleanup never signals a reusable numeric PID.

Exact-agent archival snapshots only that owner's active executions, including executions already
stopping, and records stop intent atomically. It then waits for each execution's existing teardown
proof. Other owners remain live; a repeated archival does not revive or repeat a cleaned execution.

An absent execution directory proves cleanup only when no controller can still create it. Startup
and removal share one bounded per-execution lease, and stop decisions are checked after installing
the live handle. This closes the gap between a committed spawn claim and process registration,
including a stop whose commit preceded the live handle.

A terminal catalog row and released capacity require that same proof. A shell exit, timeout,
abort signal or missing live handle is insufficient. Independent native cleanup may later finish
an execution that remained stopping; restore admits new identities without reviving an old one.

The supervisor confirms exec admission with the ASCII byte `1` in its private `started` control.
Service startup and exit classification use the same reader for that marker. Comparing it with
binary byte 1 left admitted workloads in startup and could misclassify application exit 125 as an
exec failure; an empty marker or `E` still does not prove admission.

Service input uses a real controlling PTY when requested. Each output reader advances its own
bounded cursor over the same capture, discloses retirement or truncation, and never replays stdin.
Gateway credentials establish only one principal, workspace, service and execution for five
minutes. The issuer key belongs to the daemon lifetime. Revocation shuts down existing bridge
descriptors and cancels pending attachment, even if their signed credentials have not expired.

Strict service startup is supported only by the Linux namespace and delegated cgroup backend,
as in the original compute provider. Unsupported platforms reject before creating controls or
launching a workload. Unix PTY and descriptor-revocation code is compiled only for its platform;
the public endpoint connection keeps the same stream interface, while unsupported connections
return the specific missing isolation boundary. Compiling the Windows product does not establish
Windows service isolation.
