# Slices

A slice is an attention mask over a workspace's files: the files an agent picked out for one
question, under a title that says what the selection is. It is a list of paths, never content, so
a client reads the files and their diffs live through the workspace file and git routes.

```ts
import { SlicesModule } from "@slopus/happy-agent-modules";

const slices = new SlicesModule(config, bots, projects, workspaces);
```

The module takes the modules that know where an agent lives. A slice belongs to the workspace
the acting agent is placed in — its bot, its workspace, or its project root, walking up to the
parent for a collaborator with no placement of its own — never to a workspace ID a model names.

## What it stores

Every slice is kept under its workspace, newest first, in the module-owned
`happy_agent_slice_state` table. A workspace retains at most `MAX_SLICES_PER_WORKSPACE` (100)
slices; creating one beyond that drops the oldest. A slice is immutable once created and carries
its author agent, title, optional note, files with optional reason and line ranges, a version
minted once, and its creation time. The module validates shape and bounds only; which files matter
is the model's judgement.

## Tool it provides to the model

`create_slice` is a common tool, the same for every vendor. It is `durable` and `transactional`
and never needs Auto review: a slice is a reading aid, not an action on the machine. Its
description carries the ranking rules — core logic, schemas, and persistence are signal; tests,
generated code, and formatting-only edits are noise. A successful result carries a `slice`
presentation naming the slice, its title, and its file count; History retains that beside the
result so the transcript row can open the slice in the app.

## Reading and watching

`list(ctx, workspaceId)` returns the retained slices newest first and `get(ctx, workspaceId,
sliceId)` one of them. `onEvent` reports every durable creation; the API module turns that into
`slice.created` on the global stream and serves the two `GET /v0/workspaces/:workspaceId/slices`
routes.
