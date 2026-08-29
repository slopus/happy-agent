# Codex compute tools

Codex's own filesystem and shell surface: `exec_command`, `write_stdin`, `kill_session`,
`apply_patch`, and `view_image`, assembled in that order by
[`assembleCodexComputeTools.ts`](assembleCodexComputeTools.ts).

## Why none of this is shared

These are the names, argument schemas, and wording a Codex model was trained on. They are not a
Happy Agent abstraction with a Codex label on it, so nothing in this directory is imported by
`tools/claude/` or `tools/grok/`, and nothing in those directories is imported here. The result
schema, the model-facing text, the defaults, the error wording, and the Auto-permission
declarations all belong to Codex alone. Two vendors ending up with near-identical files is the
intended outcome; a shared factory that produces both is not.

What _is_ shared is behavior: path resolution, permission review, the per-agent file read log,
image reading, and command-session plumbing all live in `sources/compute/impl/` and are called
from here. One agent has one read log whichever vendor's tools it is holding, so a conversation
that switches models does not lose the right to change a file it already read.

## What each tool does

| Tool           | Backed by                                        | Notes                                                                                                     |
| -------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `exec_command` | `startComputeCommand`                            | Reaching `yield_time_ms` does not kill the command. It is detached and the answer carries a `session_id`. |
| `write_stdin`  | `writeComputeCommandInput`, `readComputeCommand` | Empty `chars` is a poll with a long default wait; non-empty is typed input with a short one.              |
| `kill_session` | `stopComputeCommand`                             | Stopping a session that already ended is reported, not refused.                                           |
| `apply_patch`  | `impl/applyCodexPatch.ts`                        | Every file goes through the shared write, move, and delete helpers.                                       |
| `view_image`   | `readImageForModel`                              | `detail` is carried into the result; the module never rescales.                                           |

`exec_command` and `write_stdin` answer with Codex's own unified exec shape, defined in
[`impl/unifiedExecOutput.ts`](impl/unifiedExecOutput.ts). That schema is Codex's, not the module's.

## Deliberate departures from vendor truth

**`apply_patch` is an ordinary JSON tool here.** Codex ships it as a freeform lark-grammar tool
whose whole body is the patch. `@slopus/happy-agent-base` parses every tool call's arguments as
JSON before a tool sees them and offers no hook to change that, so a freeform call could never
arrive. The tool therefore takes `{ patch, workdir? }` and sets no `grammar`. The patch format
itself — `*** Begin Patch`, `*** Add File:`, `*** Update File:`, `*** Delete File:`,
`*** Move to:`, `@@` anchors, `*** End of File` — is exactly Codex's, and the description tells
the model to put the patch in the `patch` field instead of repeating the vendor's "do not wrap the
patch in JSON", which would be false in this runtime.

**`secrets` is a Happy Agent extension.** `exec_command` accepts attached secret bundle IDs. The
host resolves them immediately before spawning and exposes only their environment variables to
that process; the model and tool result never receive values. Omitted or empty means none.

## Auto permissions

- `exec_command` is reviewed for `sandbox_permissions: "require_escalated"` or a non-empty
  `secrets` selection. Only `sandbox_permissions` changes the execution boundary. Secret
  provisioning stays sandboxed unless both are present; either may be used alone.
- `write_stdin` is reviewed when it types something and continues under the session's existing
  boundary, including when that process carries selected secrets. An empty poll is not reviewed.
- `kill_session` is never reviewed. It ends work Happy Agent itself started.
- `apply_patch` is reviewed, and elevated, when any path the patch names would be reviewed for
  writing — including a patch whose paths cannot be read at all.
- `view_image` mirrors an ordinary read of its path.
