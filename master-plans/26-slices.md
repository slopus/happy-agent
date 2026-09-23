# Master plan 26: slices

## Big picture

A slice is an attention mask over files and changes that an agent builds from
the meaning of a request. The lead's phrase is "you know how no one cares about
tests": the job is not to show code but to take the noise away and leave what
actually needs reading. The user asks in words — "show the changes in the API
schema", "show the core data structures", "the top 20% of substantive changes
from the past couple of turns" — and gets a named selection that Happy renders
in its Files tab beside Changes and All Files.

Rig owns slices: it stores every slice, exposes the API the app reads them
through, gives every model the tool that creates one, and pushes changes to the
client. Rig only validates shape and bounds — it does not judge content. The
ranking ("tests, generated code, and formatting are noise; core logic, schema,
and persistence are not"; "top 20%") is the model's work, guided by the tool's
instructions.

A slice belongs to a workspace, not to one conversation. It is a list of paths
with a title, an optional note, and an optional per-file reason and line
ranges. It never carries file content: the app reads content live through the
existing file and diff routes, so a slice is a live mask over the working tree,
not a snapshot. Every slice records the agent that made it.

A slice is never edited. The person may remove one that is no longer needed,
and Rig keeps only the newest hundred per workspace, dropping the oldest
silently. Its id is the id of the tool call that made it, so a retried or
replayed call finds the slice it already created instead of making a second
one.

## The steps

**A. Storage and API.** The slice resource — id, workspace, author agent,
title, note, files with path, reason, and line ranges, created time —
validated with TypeBox and bounded in file count and text length, persisted in
Rig's database, `GET /v0/workspaces/:workspaceId/slices`,
`GET /v0/workspaces/:workspaceId/slices/:sliceId`,
`DELETE /v0/workspaces/:workspaceId/slices/:sliceId`, the `slice.created` and
`slice.deleted` events on the global stream, and the additive `API.md` change
describing all of it.

**B. Tool and presentation.** A common tool, available to every model, that
creates a slice in the agent's workspace. Its description carries the ranking
rules. Paths are validated against the workspace. The tool result carries a
`slice` presentation — the slice id, title, and file count — so the transcript
row is the clickable thing that opens the slice in the app.

**C. Client.** Types, list, get, and delete methods, and both event payloads in
`@slopus/happy-agent-client`, and a published client version Happy can build
on.

## What done looks like

- A slice survives a Rig restart, and an invalid one — unknown workspace,
  empty title, path outside the workspace, or over the bounds — is rejected at
  the API and at the tool with a typed error.
- The app can list a workspace's slices and learns about every new one without
  polling.
- Every slice carries its author agent, title, and created time; files carry
  a path and may carry a reason and line ranges; no slice carries content.
- An agent in a normal session can create a slice through the common tool, and
  the resulting tool-call message carries a `slice` presentation pointing at it.
  Running the same call again returns the same slice rather than a duplicate.
- The app can remove a slice; the route answers with the removed slice once
  and with 404 afterwards, and every client learns of the removal through
  `slice.deleted` without polling.
- The `API.md` change is additive and older clients ignore it safely.
