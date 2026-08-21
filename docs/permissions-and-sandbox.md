# Permissions, sandboxing, and shell behavior

This document describes what an agent running inside Happy Agent is allowed to do, how a
restricted action can be escalated, and why a refused action must not be
retried by another route. It is written for coding agents, and it describes the
behavior that is actually implemented.

## One permission model for every provider

Happy Agent has a single permission model. Codex, Claude, Grok, and MCP tools all
execute through the same `AgentContext`, the same filesystem boundary, the same
shell sandbox, and the same `PermissionContext`. Provider differences exist only
in tool names, argument schemas, result formatting, and model-facing guidance.
There is no provider-specific security path in the agent loop.

Two consequences matter in practice:

- Running the "other provider's" tool never widens what you may do. `Bash`,
  `exec_command`, and `run_terminal_command` are the same sandboxed execution
  with different argument names.
- Every tool declares its own permission behavior on its definition. The loop
  never decides anything from a tool name, a name prefix, a provider key, or a
  guess about command contents.

The relevant fields on a tool definition are:

| Field                             | Meaning                                                                                                     |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `shouldReviewInAutoMode`          | Required. Whether this exact invocation must be reviewed in Auto.                                           |
| `shouldRunInFullAccessInAutoMode` | Whether an allowed review also grants this one execution Full access. Review alone never implies elevation. |
| `requiresAutoOrFullAccess`        | The tool acts outside Happy Agent's local sandbox and cannot run at all in Read only or Workspace write.    |
| `describeAutoPermissionAction`    | Human-readable description of the exact reviewed boundary. Required whenever a review can happen.           |
| `autoPermissionInstructions`      | Provider-specific Auto guidance injected into the system prompt only while the tool is active.              |
| `availableToPermissionReviewer`   | Whether the read-only reviewer agent may call the tool while investigating.                                 |

## The four permission modes

The mode is `"read_only" | "workspace_write" | "auto" | "full_access"`, and Auto
is the default.
The mode lives in a `PermissionContext`, which exposes the current `mode`, a
`revision` counter, `setMode`, and `runWithMode` for a scoped temporary
override.

### Read only

- File tools may inspect files; any write fails with "File changes are disabled
  in read-only mode."
- Shell commands run, but nothing on the host is writable except temporary
  directories. The workspace itself is not writable.
- Shell network access is blocked; no managed proxy is created for this mode.
- On macOS and Linux, restricted reads follow Codex and may inspect the host
  filesystem. `assertCanReadPath` only enforces its sensitive-path denial on
  other platforms, where reading a private path outside the workspace fails with
  a message pointing at Full access.
- On macOS, no local unix socket may be created in this mode.

### Workspace write

- File changes are allowed inside the working directory.
- Writes outside the working directory are refused: "Workspace write mode cannot
  modify files outside the working directory."
- The project config file (`happy.toml`) is refused.
- Protected Git control paths are refused: "Workspace write mode cannot modify
  Git control files without Full access."
- Shell writes are confined to the working directory, its Git control paths, and
  temporary directories. Shell network access is blocked except for destinations
  the user allowed in configuration, reached through Happy Agent's managed proxy.

### Auto

Auto is Workspace write plus automatic review.

- Routine reads and workspace edits run with no review at all.
- Every shell tool uses the Workspace write sandbox **by default**.
- A tool may request review for one exact action. Review is automatic and never
  becomes a question to the user.
- Only a tool whose `shouldRunInFullAccessInAutoMode` returns true receives a
  temporary Full access override, and only for that single execution. The loop
  re-checks the mode immediately before starting the override and restores Auto
  as soon as the call settles.
- Tools with `requiresAutoOrFullAccess` (all MCP operations) are available.

### Full access

Happy Agent's filesystem, shell, and network restrictions are removed.
`createSandboxedCommand` returns the raw command with no sandbox wrapper, and
`assertCanReadPath` / `assertCanWritePath` return immediately. Full access does
not claim to provide the restricted sandbox boundary — it is the absence of it.
Custom shells (`shell:` on `exec_command`) are available only in Full access.

## How Auto review works

The agent loop prepares a tool's permission before executing it:

1. If the mode is not Auto, nothing is reviewed.
2. The tool's `shouldReviewInAutoMode` is called with the real arguments. If it
   returns false, the call executes normally inside the sandbox.
3. Otherwise `describeAutoPermissionAction` produces the exact action text. A
   tool that requests review without defining it fails with an error instead of
   executing.
4. A read-only side agent — Codex's Guardian policy, plus the user's global
   `SECURITY.md` if present — reviews the action against the durable
   conversation transcript. It may make read-only tool calls while deciding.
   Its own permission mode is never Auto, so a review cannot recurse.
5. The verdict is `allow` or `deny`. There is no third outcome and no prompt to
   the user.

### What counts as authorization

The reviewer sees a role-aware transcript built by
`createAutoPermissionTranscript`, not a compacted model-context suffix. Real
user messages and trusted answers to interactive questions are authorization
evidence and are preserved preferentially inside the review budget. Assistant
text, tool arguments, tool output, repository content, generated summaries, and
anything injected into a file are **not** authorization.

The verdict is re-derived from the reviewer's own classification
(`shouldAllowAutoPermissionReview`): a `critical` risk is never allowed
automatically, and a `high` risk is allowed only with medium or high user
authorization. If user evidence had to be dropped to fit the budget and the risk
is above `low`, the action is denied — the review fails closed.

### Denial semantics

`describeAutoPermissionDenial` produces the agent-facing result. There are three
distinct outcomes and they do not mean the same thing:

- **Rejected.** A real judgement was made. You must not pursue the same outcome
  by another route, by splitting it into smaller steps, or by working around the
  restriction. Continue only with a materially safer alternative; otherwise stop
  and tell the user what you wanted to do and why it was refused, so they can
  decide. If the user then approves it in their own words, that reply is real
  authorization and the next review can allow it.
- **Timed out.** The review did not finish within its 90-second budget. The
  action is unproven, not unsafe. You may try once more, or ask the user.
- **Unavailable.** No reviewer could run, or no reviewer exists for the session.
  No judgement was made about the action. Continue with work that does not need
  the permission, or ask the user. Auto without a reviewer never falls back to
  silent execution.

### Refusal loops must end the turn

Because Auto never interrupts the user, nothing outside the agent can break a
loop of refusals. `AutoPermissionDenialCircuitBreaker` therefore stops the turn
itself: 3 refusals in a row, or 10 refusals within the last 50 decisions. A
successful action clears the consecutive counter but not the windowed one. When
it trips, the turn ends with an instruction to tell the user what you were
trying to do and why it kept being refused.

Treat that as the floor, not the target. An agent that reacts to a refusal by
trying a variation of the same action is doing the one thing the denial text
explicitly forbids.

## Escalation syntax per provider

The escalation field is provider-shaped, but every one of them requests the same
runtime behavior: in Auto, review the action first; if allowed, scope only that
one tool execution to `full_access`, then restore Auto immediately.

| Provider tool               | Field                                      | Where the reason goes |
| --------------------------- | ------------------------------------------ | --------------------- |
| Codex `exec_command`        | `sandbox_permissions: "require_escalated"` | `justification`       |
| Claude `Bash`               | `dangerouslyDisableSandbox: true`          | `description`         |
| Grok `run_terminal_command` | `sandbox_permissions: "require_escalated"` | `description`         |

A Pi `bash` tool with `sandbox_permissions: "require_escalated"` and a
`justification` is sometimes described alongside these. Happy Agent currently ships the
Codex, Claude, and Grok shell surfaces only; the Pi surface is part of the stated
model, not of what runs today.

Rules that apply to all of them:

- Omitting the field, or setting it to `use_default` / `false`, keeps the
  command sandboxed and skips review entirely.
- In Read only or Workspace write the field does not bypass the selected mode.
- Reviewed actions that do not need host access stay in the current sandbox.
  Sending input to an existing shell session (`write_stdin`, `TaskInput`) is
  reviewed whenever the input is non-empty, but it is never elevated.

File tools follow the same rule from the other direction. `Read`, `Write`,
`Edit`, and `apply_patch` extract their real path argument and call the shared
boundary helpers. A path outside the workspace, a symlink escape, a protected
Git control path, or the project config file triggers review and, when allowed,
the temporary elevation for that one call. Paths under the user's skill roots
are readable without review.

## Sandbox limits

These limits apply to shell commands in Read only, Workspace write, and Auto.
They are enforced by the platform sandbox, not by inspecting your command text,
so rewriting the command does not change the outcome.

- **Writes** are confined to the working directory, its Git control paths, and
  temporary directories. Everything else on the host is readable but not
  writable. In Read only, only temporary directories are writable.
- **Unix sockets** must live inside the working directory. On macOS a socket
  anywhere else is refused, including in a temporary directory, and the home
  directory (or any ancestor of it) is never granted socket scope — that is
  exactly where `~/.docker`, `~/.gnupg`, and agent sockets live. The host's own
  sockets — the Docker daemon, the SSH agent, Happy Agent's control socket — are
  unreachable by design.
- **Local port binding**: on macOS, binding a local TCP or UDP port is refused
  unless the user enabled `network.allowLocalBinding` in configuration. On Linux
  and inside Docker the command gets its own network namespace (`--unshare-net`),
  so a listener it starts is reachable only from inside that command.
- **Outbound network** is blocked except for domains and ports the user allowed,
  which are reached through Happy Agent's managed HTTP/SOCKS proxy. The allowlist comes
  from `network.allowedDomains` with `network.allowedPorts` (default `[443]`);
  `network.deniedDomains` overrides it. A blocked request explains itself: not in
  the allowlist, in the denylist, DNS could not be resolved safely within two
  seconds, or the destination resolves to a local or private address. Happy Agent owns
  the proxy environment variables; unsetting them cannot grant direct access.
  Only the user can change the policy, in the repository's `happy.toml` or the
  global config.
- **Keychain**: on macOS the keychain is unavailable. `security`, and anything
  backed by it, fails or reports nothing rather than returning a secret. Treat
  every other system credential store the same way. Secrets reach a command only
  through the `secrets` argument, which injects an attached session bundle.
- **Protected paths** are read-only even inside the workspace: `.agents`,
  `.codex`, the project config files, and Happy Agent's own server directory, socket,
  and token paths.

When a limit blocks necessary work: in Auto, request reviewed full-access
execution for that one command and explain why. In Read only or Workspace write,
stop and tell the user which limit it was. A sandbox refusal is not a bug in your
command and is not something to route around.

### Platform implementations

- **macOS** uses the system Seatbelt sandbox at `/usr/bin/sandbox-exec` with a
  closed-by-default policy adapted from Codex: all reads allowed, writes only to
  the computed writable roots, explicit denials for protected paths, PTY support,
  and no network unless local binding or loopback ports were configured.
- **Linux** uses Bubblewrap: `/` bound read-only, `--dev /dev`, a private
  `/tmp`, explicit `--bind` for writable roots, `--ro-bind` for protected paths,
  and `--unshare-user --unshare-pid --unshare-net`. When nested procfs mounting
  is unavailable, an empty private `/proc` is the fallback. `socat` bridges the
  managed proxy into the namespace over unix sockets with a command-scoped
  authentication token.
- **Other platforms** fall back to `@anthropic-ai/sandbox-runtime` with a
  generated settings file.
- Restricted execution fails closed with a readable explanation when a sandbox
  dependency is missing.

The repository's root `happy.toml` is part of the sandbox boundary because it
can grant managed network access to later commands. Restricted commands see an
existing file read-only. When it does not exist, it remains absent before,
during, and after the command; Happy Agent never creates a placeholder or other
synthetic file at that path.

## Shell and background processes

A shell command starts with a wait, not a life expectancy.

- The wait is a timeout on _you_, not on the command. When it expires the
  command is not killed: it moves to the background and you get its output so
  far plus a session ID to come back to.
- Claude `Bash`: `timeout` in milliseconds, default 120000, max 600000.
  `run_in_background: true` starts it in the background immediately and waits
  only about 3 seconds to confirm it did not fall over.
- Codex `exec_command`: `yield_time_ms`, default 10000 ms, effective range
  250–30000 ms.
- Every provider can run in the background, read only what accumulated since the
  last read, write to stdin, and stop a process.
- Stopping is graceful first and forceful about 2 seconds later, and it takes
  the whole process tree.
- A background process that exits without having been read to the end produces a
  developer message saying only that it ended. No output is attached; read it
  with the normal read tool, which keeps answering for a while after the exit.
  Do not poll for exit.
- Lifetime: a background process belongs to the session that started it and
  lives as long as that session's runtime inside the daemon. Cancelling a turn
  does not kill it. Archiving the session or exiting the daemon kills everything
  it started.
- At most 64 active sessions per session runtime. Passing the cap evicts and
  kills the oldest instead of failing your command; the evicted session stays
  readable.

### TTY behavior

`tty` defaults to false, which uses pipes. Ask for a TTY only when a program
behaves differently without one. A PTY-backed command gets an 80×24 terminal and
an environment that discourages terminal output: `TERM=dumb`, `NO_COLOR=1`,
`COLORTERM=""`, and `PAGER`, `GIT_PAGER`, `GH_PAGER` forced to `cat`. Nothing is
done about full-screen applications beyond that. Interactive flags such as
`git rebase -i` are not supported.

## MCP

An MCP server executes outside Happy Agent's local filesystem sandbox, so Happy Agent cannot
enforce its boundary locally.

- Every MCP tool sets `requiresAutoOrFullAccess: true`. In Read only or
  Workspace write the call fails with "This action requires Auto or Full access
  because it can operate outside Happy Agent's local sandbox."
- Every direct and dynamic MCP tool invocation is reviewed in Auto:
  `shouldReviewInAutoMode: () => true`, including `call_mcp_tool` and
  `get_mcp_prompt`.
- Server-supplied annotations such as `readOnlyHint` are untrusted metadata.
  They are never authorization evidence and never a reason to skip review.
- Happy Agent-owned protocol operations that are intrinsically read-only skip review:
  `list_mcp_tools`, `list_mcp_resources`, `list_mcp_resource_templates`,
  `read_mcp_resource`, `list_mcp_prompts`.
- The approval text discloses the external boundary explicitly: the server can
  perform actions outside Happy Agent's filesystem sandbox.

## Docker sandbox environments

Happy Agent can run a session's commands inside a Docker container. The same permission
model applies; Docker is the outer isolation, not a replacement for the inner
sandbox.

An image or existing container used as a Happy Agent execution environment must contain
Bubblewrap and `socat`, and must allow the nested namespaces Bubblewrap needs.
`prepareDockerSandbox` probes for exactly that and fails with an actionable
message: install `bubblewrap` and `socat` in the image, and when connecting to an
existing container start it with `--security-opt seccomp=unconfined`.

Inside the container, a restricted command runs under Bubblewrap with `/` bound
read-only, a private `/tmp`, `--unshare-net`, the workspace bound writable (or
read-only in Read only mode), and `.agents`, `.codex`, and the project config
files bound read-only. Managed proxy access reaches the container through
temporary unix sockets shared by the working-directory bind mount, beneath a
root every restricted command sees read-only, with unguessable command-scoped
authentication. A restricted Docker command does not inherit the container's
parent process table or another command's temporary process-control state.

Proxy processes, socket bridges, and temporary directories are removed when a
command finishes or fails.

## Quick reference for agents

- Assume Auto. Read and edit inside the workspace freely; that path has no
  review at all.
- Escalate only when the sandbox actually blocks necessary work, with one
  command and a concrete reason. Do not escalate speculatively — an escalated
  command is reviewed and may be refused.
- A refusal is a decision about the proposed action only. It is not a durable
  rule, and an allow is not authorization for anything later.
- Never work around a denial. Take a materially safer route, or stop and explain.
- Never assume a background process needs polling, and never assume a timeout
  killed a command.
