import { Type } from "@sinclair/typebox";

import type { SessionTool } from "@/core/SessionTool.js";

export const kimi_bash_tool: SessionTool = {
    name: "Bash",
    description:
        'Execute a `bash` command. Use this for shell semantics — pipes, env, processes, git, package managers, build/test runners, anything genuinely interactive or multi-step.\n\n**Translate these to a dedicated tool instead:**\n- `cat` / `head` / `tail` (known path) → `Read`\n- `sed` / `awk` (in-place edit) → `Edit`\n- `echo > file` / `cat <<EOF` → `Write`\n- `find` / recursive `ls` to locate files by name pattern → `Glob` (plain `ls <known-directory>` is fine for listing a directory)\n- `grep` / `rg` (search file contents) → `Grep`\n- `echo` / `printf` (talk to the user) → just output text directly\n\nThe dedicated tools render in the per-tool permission UI and keep raw stdout out of the conversation; that is why they are worth reaching for whenever one fits.\n\n**Output:**\nThe stdout and stderr will be combined and returned as a string. The output may be truncated if it is too long. If the command exits non-zero, the output ends with a `Command failed with exit code: N` line; a command killed by its timeout or interrupted by the user ends with its own message instead.\n\nIf `run_in_background=true`, the command will be started as a background task and this tool will return a task ID instead of waiting for command completion. When doing that, you must provide a short `description`. Background commands default to a 600s timeout and `timeout` is capped at 86400s; set `disable_timeout=true` only when the task should run without a timeout. You will be automatically notified when the task completes. After starting one, default to returning control to the user instead of immediately waiting on it. Use `TaskOutput` only for a non-blocking status/output snapshot — do not wait on a task you just launched, since its completion arrives automatically. Use `TaskStop` only if the task must be cancelled. If a human user wants to inspect background tasks themselves, point them to the background-task panel.\n\n**Guidelines for safety and security:**\n- Each shell tool call will be executed in a fresh shell environment. The shell variables, current working directory changes, and the shell history is not preserved between calls. To run a command in a particular directory, pass the `cwd` argument (or use absolute paths) rather than relying on a `cd` from an earlier call.\n- The tool call will return after the command is finished. You shall not use this tool to execute an interactive command or a command that may run forever. For possibly long-running foreground commands, set the `timeout` argument in seconds. Foreground commands default to 60s and allow up to 300s. When a foreground command hits its timeout it is moved to the background instead of being killed, and you will be automatically notified when it completes. The user can also move a running foreground command to the background at any time.\n- Avoid using `..` to access files or directories outside of the working directory.\n- Avoid modifying files outside of the working directory unless explicitly instructed to do so.\n- Never run commands that require superuser privileges unless explicitly instructed to do so.\n- Run git-mutating commands such as `git commit`, `git push`, `git reset`, and `git rebase` only when the user asks for them.\n\n**Guidelines for efficiency:**\n- Use `&&` to chain commands that genuinely depend on each other, e.g. `npm install && npm test`. Independent read-only commands (separate `git show`, `ls`, or status checks) should be issued as separate parallel Bash calls in one response, not chained into a single call — chaining serializes their execution and mixes their output. Do not stitch outputs together with `echo` separators.\n- Use `;` to run commands sequentially regardless of success/failure\n- Use `||` for conditional execution (run second command only if first fails)\n- Use pipe operations (`|`) and redirections (`>`, `>>`) to chain input and output between commands\n- Always quote file paths containing spaces with double quotes (e.g., cd "/path with spaces/")\n- Compose multi-step logic in a single call with `if` / `case` / `for` / `while` control flows.\n- Prefer `run_in_background=true` for long-running builds, tests, watchers, or servers when you need the conversation to continue before the command finishes.\n\n**Commands available:**\nThe following common command categories are usually available. Availability still depends on the host, so when in doubt run `which <command>` first to confirm a command exists before relying on it.\n- Navigation and inspection: `ls`, `pwd`, `cd`, `stat`, `file`, `du`, `df`, `tree`\n- File and directory management: `cp`, `mv`, `rm`, `mkdir`, `touch`, `ln`, `chmod`, `chown`\n- Text and data processing: `wc`, `sort`, `uniq`, `cut`, `tr`, `diff`, `xargs`\n- Archives and compression: `tar`, `gzip`, `gunzip`, `zip`, `unzip`\n- Networking and transfer: `curl`, `wget`, `ping`, `ssh`, `scp`\n- Version control: `git`; for GitHub-hosted work (PRs, issues, CI runs, API queries) prefer the `gh` CLI when installed — it carries the user\'s GitHub auth and can return structured JSON\n- Process and system: `ps`, `kill`, `top`, `env`, `date`, `uname`, `whoami`\n- Language and package toolchains: `node`, `npm`, `pnpm`, `yarn`, `python`, `pip` (use whichever the project actually relies on)\n',
    parameters: Type.Object(
        {
            command: Type.String({ minLength: 1, description: "The command to execute." }),
            cwd: Type.Optional(
                Type.String({
                    description:
                        "The working directory in which to run the command. When omitted, the command runs in the session's working directory.",
                }),
            ),
            timeout: Type.Optional(
                Type.Integer({
                    default: 60,
                    description:
                        "Optional timeout in seconds for the command to execute. Foreground default 60s, max 300s. Background default 600s, max 86400s. Ignored for background commands when disable_timeout=true.",
                    exclusiveMinimum: 0,
                    maximum: 9007199254740991,
                }),
            ),
            description: Type.Optional(
                Type.String({
                    description:
                        "A short description for the background task. Required when run_in_background is true.",
                }),
            ),
            run_in_background: Type.Optional(
                Type.Boolean({ description: "Whether to run the command as a background task." }),
            ),
            disable_timeout: Type.Optional(
                Type.Boolean({
                    description:
                        "If true, do not apply a timeout to the command. Only applies when run_in_background is true.",
                }),
            ),
        },
        { $schema: "http://json-schema.org/draft-07/schema#", additionalProperties: false },
    ),
};
