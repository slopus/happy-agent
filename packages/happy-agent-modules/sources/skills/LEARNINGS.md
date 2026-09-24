# Skill discovery learnings

## Disablement means unavailable, not uninstalled

The human-directed management contract uses the existing `~/.agents/skills` root and returns
parsed skills, not parsed agent definitions. A disabled skill remains installed, visible in the
human-facing catalog, readable through management APIs, and monitored for file changes. Its
preference must not be implemented by deleting or moving files. Agent skill discovery, prompt
contributions, skill-specific reads, and invocation exclude it; ordinary filesystem permissions
are unchanged. The global management module owns installation state and watching, while native
agent discovery consults its availability without applying local preferences to another compute.
Management remains feature-detected through its endpoint; this additive API does not raise
protocol 25.

If a repository contains the home directory, walking project ancestors must not rediscover
`~/.agents/skills` as a project root. It remains the global installation, so its disabled state
cannot be bypassed by source classification. Separate project installations keep their own
availability even when they share a name.

## Concurrent agents share scans, not stale catalogs

Startup used to scan the same skill files separately for every restored agent. Discovery now
coalesces overlapping loads with the same filesystem identity, working directory, home, and complete
operation permissions. Compute identifies native filesystems with identical boundaries; alternate
providers share only the exact filesystem object, never an advertised provider name or path.
At most 128 scans are retained for sharing, and every entry is removed when its scan settles.

Completed catalogs are deliberately not cached. The API requires discovery on creation,
restoration, each turn, and invocation, and a removed command must not be dispatched from stale
data. Later calls rescan immediately, including after partial filesystem failures. Directory
metadata uses the backend's bounded batch operation, and canonical non-symlink child directories
do not need another realpath lookup. Symbolic links still resolve through the permission-aware
backend; individual unreadable or disappearing files do not hide other skills.

## A user-only skill is hidden from the model, not from the user

`disable-model-invocation: true` used to be documented as parsed but was neither parsed nor
honored, so a skill written to run only on explicit request was listed to the model with its
description and could be picked up whenever a task matched. Claude Code treats the flag as
"user-invocable only": the skill stays a slash command but leaves the model's catalog. Codex
ignores the frontmatter field and expresses the same intent through a sidecar
`agents/openai.yaml` with `policy.allow_implicit_invocation: false`. Skill discovery now follows
Claude Code: the flag is read as a plain YAML boolean, flagged skills stay in `slashCommands` and
`invokeSlashCommand`, and are excluded from the instruction catalog, `list_skills`, and
`read_skill`. The model is told that only the user may invoke such a skill rather than that it
does not exist, so it asks instead of hunting for another name. The invoked-skill prompt is still
matched against the complete catalog, otherwise a user's own `/deploy` would drop its content.

## Admin bots change machine skill folders live, in runtime.toml only

Extra machine skill folders could only be set by editing the user `happy.toml` and restarting.
Active admin bots can now list, add, and remove them with tools, and the changes are saved in the
`[skills] directories` list in generated `runtime.toml`. The config module used to read that list
once, from values merged at load. It now merges the user list with its live runtime list every time
it is asked, so discovery sees a change on the next turn. The user's `happy.toml` stays theirs: a
folder named there is shown as `user` and refused on removal rather than hidden with a runtime
override. Only absolute paths are accepted. A relative path has no working directory everyone would agree
on, and `~` depends on which home the daemon resolves, so the saved entry is always the exact path. A missing folder or a file path is also rejected, so a typo cannot be saved and
then quietly find nothing. There is no database intent to recover. The runtime file write is atomic
and adding or removing is idempotent, so the tools are marked durable without Durable Functions.
