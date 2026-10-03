# Slices learnings

## The card is the slice; there is no stored resource

The first design stored every slice in a per-workspace table with list, get, and delete routes,
`slice.created` and `slice.deleted` events, a retention cap, and workspace cleanup, and the tool
handed the model a list of paths to name. That was a second source of truth for something the
conversation already held, and a list of paths went stale the moment the working tree moved. A
slice is now a gitignore-style mask — source, include, exclude, and any paths pinned by name —
carried whole in the `create_slice` presentation. Nothing else stores it: the card never expires
and never falls back to a different slice, and a client evaluates the mask again through the
stateless file-match route whenever it shows it, so hide and pin are the client's own view state.

## One evaluator, and it sees the whole change list

The tool and the app must never disagree about what a slice holds, so the files module is the one
place a mask is evaluated, over the daemon's complete list of changed files rather than the
bounded snapshot clients page, or over Git's ignore-aware file list with a plain walk for a folder
that is not a repository. The tool validates through the same evaluation and refuses a mask that
holds nothing, naming the rules that matched nothing, so the agent hears it and writes a mask that
holds something.

## Placement is walked, not assumed

An agent's workspace is its bot, its workspace, or its project root, walking up to its parent for
a collaborator with no placement of its own — the same walk services use. Bots can hold several
repositories and subtasks can have their own workspaces, so the card carries the workspace ID and
the folder the mask was evaluated against rather than assuming one root per conversation.
