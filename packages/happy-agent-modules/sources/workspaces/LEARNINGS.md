# Workspaces — learnings

Feedback and decisions gathered while building this module.

## Archiving stops the work, not just the record

Archiving used to move the row out of the active list, cancel setup, and delete the folder while
leaving the agents standing in it running. One of them kept working for twenty-five minutes after
its worktree was deleted, then asked the person a question — and because its workspace was archived
it was no longer listed anywhere, so the question could not be reached and never got an answer. The
agent stayed in its durable tool stage, which meant every later daemon restart drained forever
waiting for an agent nobody could see.

Archival now prepares the cancellation of every agent attached to the workspace inside the
transaction that records the decision, and each cancellation carries the subagent tree and
background processes below it. Preparing it there is what ties the two together in the direction
that matters: work that cannot be cancelled fails the archival, so a workspace is never archived
while its agents were left alone. A repeat of an archive already made cancels nothing, so an
idempotent retry cannot reach into agents that have since moved on.

Be careful about how strongly this is stated. The cancellation is _prepared_ transactionally, not
recorded durably: Agent Base registers an in-memory post-commit callback, and Compute persists a
notice only when it already has processes to name. A crash between the commit and the signal can
therefore leave an archived workspace whose agent was never told. Closing that gap needs a durable
cancellation intent and startup reconciliation, which this change does not add — so the documents
say _prepared in the transaction, signalled after commit_, and must not say "one durable fact".

The other half is the arriving agent. Attaching to a workspace whose archival has committed is
refused, because the decision has already scanned the attachments and would never see a later one.

The archival of a _folder_ is still background cleanup that never rolls the decision back. Stopping
the work is not cleanup; it is half of the decision itself.

## An interrupted removal resumes at startup

A graceful shutdown racing an archive stranded the workspace in `archiving` forever. `close()`
raises the closed flag before waiting for cleanup, and an in-flight folder removal that observes
the flag returns without completing the archival — correctly, because a closing daemon must not
keep deleting. But nothing ever came back for the row: startup reconciled only `initializing`
workspaces, so the stranded one was hidden from every default list, refused agents through the
attach gate, kept its folder on disk, and never published the `workspace_archived` event — while
reading as "removal is still running" for the life of the installation.

`open` now sweeps every row still `archiving` and hands it back to `removeArchivedWorkspace` on
the cleanup lifetime. Resuming is safe because the state is terminal: nothing can move an
`archiving` row anywhere but `archived`, no restore transition exists that could have resurrected
the workspace in between, and the managed path cannot have been reused while its folder still
exists. The keep-on-archive settings are read fresh at resume time, exactly as on the normal path,
and completion publishes the event the interrupted run still owed. `archiving` is a window, never
a resting state.

## Deferred work needs its lifetime taken before the transaction ends

`archive_workspace` is a transactional tool, so archiving often runs inside a caller's transaction
that may still roll back. Deleting a folder cannot be undone, so the removals moved behind
`afterCommit`. Reaching for the module's background lifetime from inside that callback then failed:
a post-commit callback still runs on the context that carried the transaction, and reading storage
from an ended transaction throws. The failure was invisible from the outside, because it surfaced
as a swallowed post-commit warning while the archival itself looked entirely successful.

Derive the background lifetime while the caller's context is still live, then let the callback use
only what it was handed. The rule generalizes: whatever an `afterCommit` callback needs from the
transaction's context must be read before the callback is registered, never inside it.

## Catalog pages and model pages have different bounds

The workspace list shown to a model is deliberately shortened to a bounded amount of prose. That
shortening is not a catalog query: reconciliation, startup recovery, and other module-owned work
use `listCatalogPage` and follow every cursor so a long workspace identity cannot silently hide
another workspace. Helpers that mean “all workspaces” do the same rather than reading one fitted
page.

## Setup failure does not erase a valid checkout

Workspace setup commands run only after the worktree or copied folder exists. An install failure
therefore means the project is not fully prepared, not that workspace creation failed. The module
logs the setup error and marks the workspace ready so the person or agent can inspect and repair it.
Failures that prevent the folder or checkout from existing remain initialization failures, and
archive or shutdown cancellation still stops setup without marking the workspace ready.

## A catalog root can still have an Agent Base parent

An agent managing work in another workspace needs a top-level row in that destination's catalog
without losing the Agent Base ancestry that lets its parent supervise it. The ordinary attachment
method still accepts only parentless agents, so ordinary subagents cannot become visible by
accident. Cross-workspace managed roots use a separate explicit attachment method after the API
has verified that the parent belongs to a different workspace.

## Child creation follows the caller's workspace

The `create_child_workspace` tool requires a human-readable name and accepts the same optional
`baseRef` choice as `create_workspace`, but resolves the parent from the workspace that owns its
calling agent. A project-owned agent therefore creates below the project root, while an agent owned
by a nested workspace creates at that exact depth. Without `baseRef`, a nested child inherits its
parent's branch. The child returns its explicit `parentId`, so the ordinary flat API list preserves
the complete tree without a second hierarchy representation.

## Advertised page limits match execution limits

Workspace list and detail tools return at most 50 rows. Their TypeBox schemas use that same bound
so models paginate from the returned cursor instead of repeatedly requesting an advertised 100-row
page that execution must reject.
