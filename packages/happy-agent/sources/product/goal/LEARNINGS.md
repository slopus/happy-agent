# Native goal learnings

A goal and its lifecycle sidecar are one authoritative state. An active goal requires the exact
matching goal in that sidecar; paused, blocked, completed, and cleared goals retain neither a
lifecycle nor a failed-turn count. Mutation and event publication share the caller's transaction.

The owning agent observes the lifecycle at each loop opening. A continuation is allowed only for
that same active lifecycle. Creating a goal inside a tool also records the lifecycle immediately,
so the current loop can continue it. External activation enqueues a deterministic wake; external
pause, block, and clear persist cancellation for the current agent lifetime. In-agent mutations
do not cancel the turn that requested them.

Every wake and continuation uses the user role required by providers and carries explicit agent
origin and sender attribution. Goal text is escaped as objective data and grants no human authority.
Failed or aborted turns pause an active goal before its closing hook. Preserve that shipped hook
ordering, including its effect on the later failure-budget branch, rather than inventing retries.
