# Kimi compute tools

This is the production Kimi surface, separate from the internal provider reference assets.
Names and native argument spellings come from MoonshotAI/kimi-code agent-core-v2 at commit
`21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3`. Descriptions document the implemented subset;
they do not claim complete native harness behavior.

The ordinary array is fixed: Bash, Read, Write, Edit, Glob, Grep, ReadMediaFile, TaskOutput,
TaskInput, TaskStop. The reviewer array omits Write, Edit, and TaskStop. Its shell operations
still run under the reviewer's Read only boundary.

- Bash uses seconds for its foreground wait, default 60 and maximum 300. Outliving the wait
  returns a task ID without killing the command. Background starts use the shared three-second
  startup grace period. The shell comes from the compute environment, including PowerShell on
  native Windows; the Kimi tool name remains Bash.
- TaskOutput and TaskStop use native `task_id`. They manage only shell tasks. TaskOutput returns
  delta output without waiting; no native full-log `output_path` is promised. TaskStop's optional
  native reason field is omitted because compute does not record task-stop reasons. TaskInput
  is a product extension for stdin, with a wait in milliseconds. Input is reviewed without
  elevating the process's existing execution boundary.
- Read supports forward and negative line offsets, line ranges, character budgets, and long-line
  continuation through column_offset. Next Read arguments reuse the same path. Source reads are
  bounded to 8 MiB and require valid UTF-8. Pure CRLF displays LF; Edit translates the view back
  to CRLF. Other carriage returns display as `\r` and require actual carriage returns in edits.
  No attachment URL, UTF-16 decoder, notebook parser, or PDF renderer is provided.
- Write supports overwrite and append without adding a newline. Edit supports unique exact
  replacements and replace_all. Both keep stale remembered-file checks and structured diffs.
  Their actual mutation reread is bounded, checked against the inspected source, and followed
  by a timestamp check before writing; resulting UTF-8 bytes must fit 8 MiB. This does not provide
  an atomic filesystem compare-and-write operation. Edit bounds replacement counts to 10000 and
  checks expansion before allocating the replacement output.
- Glob uses bounded filesystem traversal, supports native head_limit and offset, and returns
  complete paths with continuation offsets. Ignored files are included. Grep uses bounded
  JavaScript regex search with the shared `.gitignore` subset and counts individual occurrences
  for count_matches. These are explicit departures from native ripgrep. The native include_ignored
  and deprecated include_dirs arguments are omitted. Neither tool promises spill files.
- ReadMediaFile uses Sharp to decode PNG, JPEG, WebP, and GIF images. Source reads are bounded
  to 20 MiB and decoding to 40 million pixels. Default delivery resizes to at most 2048 pixels
  per edge; regions and full_resolution retain native pixel dimensions. PNG output must fit
  3 MiB. Animated images show their first frame. Bedrock K3 video and native session attachments
  are unsupported.

Optional sandbox_permissions and justification are Happy's one-call elevation extensions.
Actual paths use the shared canonical permission checks, including symlink escapes and protected
writes. Bash also accepts product extensions tty and secrets. Selecting secrets is reviewed but
stays sandboxed unless the same call explicitly requests elevation. Read only and Workspace write
never elevate.
