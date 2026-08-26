# Workspaces — learnings

Feedback and decisions gathered while building this module.

## Archiving stops the work, not just the record

Archiving used to move the row out of the active list, cancel setup, and delete the folder while
leaving the agents standing in it running. One of them kept working for twenty-five minutes after
its worktree was deleted, then asked the person a question — and because its workspace was archived
it was no longer listed anywhere, so the question could not be reached and never got an answer. The
agent stayed in its durable tool stage, which meant every later daemon restart drained forever
waiting for an agent nobody could see.

Archival now commits the lifecycle decision and a Durable Functions archive call in one
transaction. That call retries cancellation of every attached agent, including each subagent tree
and its background processes, before removing the folder. Its operation ID makes repeated archive
requests converge, and its call KV checkpoints each completed cancellation. A daemon exit leaves
the call pending for recovery instead of losing an in-memory post-commit callback.

The other half is the arriving agent. Attaching to a workspace whose archival has committed is
refused, because the decision has already scanned the attachments and would never see a later one.

The archival of a _folder_ is still asynchronous work that never rolls the logical decision back.
Stopping the work is not optional cleanup; it is the first durable archive step.

## Durable Functions own provisioning and archive recovery

Workspace reservation and its provisioning call commit together. Provisioning checkpoints folder
creation, initial sync, and each setup command; setup checkpoints include the command text so fresh
settings at the same index are not mistaken for completed work. Archiving cancels that provisioning
operation and creates its archive replacement in the archival transaction, under the same workspace
lock. Recovery comes only from the pending Durable Functions row: `open` does not sweep
`initializing` or `archiving` records, and the module has no setup-controller or cleanup-task
registry. `archiving` remains a window, never a resting state.

Archive retries use stdlib `backoff` and durable checkpoints rather than module-owned timers. When
provisioning recovery finds that archival already superseded it, the durable result is an expected
no-op instead of an executor error.

The live sync debounce does not retain a caller or transaction context. Scheduling records only the
project ID; when the timer fires, the module creates work on its pinned sync lifetime. Both ready and
archived completion re-schedule the pass so the last ready workspace disappearing also disarms its
watch.

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
