# Grok's compute tools

Grok's own filesystem and shell surface over the shared `Compute` implementation: `read_file`,
`write`, `search_replace`, `list_dir`, `grep`, `run_terminal_command`,
`get_command_or_subagent_output`, `kill_command_or_subagent`, and `send_command_input`.

## Why none of this is shared

A model behaves well on the tools it was trained on. Grok reaches for `search_replace` and
`read_file`, not `Edit` and `Read`, and its arguments have Grok's names: `target_file`,
`old_string`, `task_id`. So every name, description, argument schema, result schema, rendering,
default, bound and permission sentence in this directory belongs to Grok alone. Nothing here is
imported from `../claude/` or `../codex/`, and nothing here may be imported by them. The
duplication between the three directories is the point.

What _is_ shared is behavior, not surface: path resolution, the Auto-review predicate, the
remembered-file freshness log, output bounding and the command-session plumbing all live in
`../../impl/`. A tool in this directory owns its wording and its schemas and calls those helpers
for everything else.

## Where this surface departs from vendor truth

- **No image tool.** Grok has no vendor descriptor for viewing a local image and Happy Agent gives Grok
  none, so this surface has none either. `read_file` reads text.
- **`read_file` has no `pages` or `format`.** Those two arguments exist on the vendor descriptor
  for paging through PDFs, which this module cannot render.
- **`task_ids` is required** on `get_command_or_subagent_output`, as it is in Happy Agent. The vendor
  descriptor makes it optional with an empty default, which is a call with nothing to answer.
- **Subagents are not here.** `get_command_or_subagent_output` and `kill_command_or_subagent` keep
  Grok's names, because that is what the model calls, but this module runs commands only. Their
  descriptions say so rather than promising output they cannot produce.

Happy Agent extends `run_terminal_command` with `secrets`: attached secret bundle IDs the host
resolves immediately before spawning and exposes as environment variables only to that process.
Omitted or empty means none. A non-empty selection is reviewed but remains sandboxed.
`sandbox_permissions` independently requests Full access, so either option may be used alone or
both together. Later `send_command_input` is reviewed and continues under the command's existing
boundary, including when it carries secrets. Values never enter tool arguments, results, or
transcripts.

## Task IDs

Grok talks about background work as string task IDs; a command on this machine is numbered.
`impl/parseGrokTaskId.ts` converts between them and refuses anything that is not a whole number
above zero, in words the model can act on.
