# Native agent resource learnings

Full resources previously returned an empty subtask tree and treated every managed child as
hidden and unable to receive user messages. Projection now asks the Subtasks, Bots, Projects
and Workspaces owners for visibility, sibling ordering and workspace ancestry. Active direct
subtasks recurse through the existing two-level limit; archival prunes a branch. Each nested
record keeps its own event version. Counts include hidden children and durable running history,
including a run that has no message yet.

Focused responses previously exposed only a hardcoded compaction command. They now compose
the original compaction descriptor and profile catalog with Skills' public discovery method.
A skill disabled for model invocation remains available to the person. Request profiles are
intentionally empty in the original implementation, whose request-profile codec accepts null.

The original projection used a durable internal event cursor as the last cursor, while the
public journal creates its own cursors. Replaying after a focused snapshot could therefore
fail with an unavailable cursor; an eventless agent also returned null despite the published
schema requiring a string. Native resources ask Events for the latest public cursor for the
agent, or the journal's valid current cursor when no frame names it. Independent resource
versions still come from durable agent events or the original deterministic fallback.