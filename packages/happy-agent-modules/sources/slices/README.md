# Slices

A slice is a gitignore-style mask an agent lays over a workspace's files for one question — "the
changed files that are not tests", "everything under the API schema". It is a rule, not a list, so
it keeps answering as the working tree changes, and it is never stored: the `create_slice` call in
the conversation is the slice. Its transcript card carries the whole definition and the workspace
it was evaluated against, and a client evaluates it again through
`POST /v0/workspaces/:workspaceId/files/match` whenever it shows it.

```ts
import { SlicesModule } from "@slopus/happy-agent-modules";

const slices = new SlicesModule(config, bots, projects, workspaces, files);
```

The module takes the modules that know where an agent lives and the files module that evaluates
masks. A slice belongs to the workspace the acting agent is placed in — its bot, its workspace, or
its project root, walking up to the parent for a collaborator with no placement of its own — never
to a workspace ID a model names. Nothing here assumes one root or one workspace per conversation:
the card names the workspace and the folder the mask was evaluated against, and a bot or subtask
with another placement simply gets another card.

## Tool it provides to the model

`create_slice` is a common tool, the same for every vendor. It never needs Auto review: a slice is
a reading aid, not an action on the machine. Its description carries the rule syntax and the
ranking guidance — core logic, schemas, and persistence are signal; tests, generated code, and
formatting-only edits are noise. The daemon evaluates the mask at once through the files module
and answers the first twenty matched paths, the full count, and every rule that matched nothing.
A mask that holds no files fails the call with the reason, so the agent rewrites it instead of
leaving an empty card. A successful result carries the `slice` presentation — workspace, root,
title, note, source, include, exclude, pinned paths with their reasons and line ranges, and the
file count — which History retains beside the result.

## What it does not do

There is no slice table, no list, get, or delete route, no `slice.*` event, no retention cap, and
no cleanup on workspace removal. Hiding or pinning a slice is the client's own view state.
