# Claude's compute tools

The machine as a Claude model expects to find it: `Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash`,
`BashOutput`, `BashInput`, and `BashStop`, with Claude's own names, argument names, wording, and
defaults. `assembleClaudeComputeTools` returns them as one fixed array in Claude's own order.

## Why nothing here is shared

A vendor tool is the provider's own surface, not a Happy Agent abstraction wearing a vendor's name. Claude's
`Read` takes `file_path` and numbers its output `cat -n` style; Codex reads through `exec_command`
and patches through `apply_patch`; Grok's `read_file` takes `target_file`. The names collide, the
argument shapes disagree, and the models were trained on their own. So each vendor directory owns
its tool names, descriptions, argument schemas, result schemas, `toLLM` rendering, error wording,
durability flags, and permission text outright. There is no cross-vendor tool factory, no borrowed
schema, and no shared command-result shape. Near-identical files across the three directories are
the intended outcome.

What _is_ shared is behavior, and it lives one level up in `../../impl/`: path resolution, the Auto
review predicate and its action text, the per-agent file-read log, output bounding, image reading,
directory walking, and the command-session plumbing. These tools own only the surface.

The file-read log is per agent rather than per vendor, so a conversation that switches models keeps
the read authorization it has already earned.

## Deviations from the vendor descriptors

Two, both deliberate:

- **`Grep` does not claim to be ripgrep.** The search behind it is this module's own bounded
  file-content search, so the description states the limits it actually enforces — 100 entries by
  default, 40 000 characters, 400 characters per line — instead of ripgrep's, and drops the
  ripgrep-specific pattern advice. Every argument, including `-A`, `-B`, `-C`, `context`, `-n`,
  `-i`, `type`, `glob`, `output_mode`, `head_limit`, `offset`, and `multiline`, is Claude's.
- **`BashOutput`, `BashInput`, and `BashStop` instead of `TaskOutput`, `TaskInput`, and
  `TaskStop`.** Claude's descriptors name one `Task*` family that reads, stops, and reports on "a
  background shell task, agent, or workflow" — three unrelated kinds of work behind one identifier.
  This module owns only the shell. Rather than ship a tool whose description promises agents and
  workflows it cannot reach, and whose `task_id` means something different depending on who created
  it, the shell half is its own family: named for the tool that starts it, taking `bash_id`, and
  saying nothing about agents or workflows. Agents and workflows belong to the collaboration and
  workflow modules, which name their own handles. The identifier stays a string, as Claude's surface
  has it, and is parsed into the machine's numeric command ID by `impl/parseClaudeBashId.ts`.

`Bash` supports Happy Agent's `secrets` selection. The IDs must already be attached to this
agent's command scope; the host resolves them immediately before spawning and adds their values as
environment variables only to that process. Omitted or empty means none. A non-empty selection is
reviewed but remains sandboxed. `dangerouslyDisableSandbox` independently requests Full access, so
either option may be used alone or both together. Later `BashInput` is reviewed and continues under
the shell's existing boundary, including when it carries secrets. Values never enter the
arguments, results, or transcript.

## `impl/`

Two small Claude-owned helpers that had no shared equivalent: the shell-identifier parser above, and
`boundClaudeShellOutput.ts`, which holds Claude's own shell-output character budget.
