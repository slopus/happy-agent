# Skill discovery learnings

## Catalog size is not prompt size

Discovery used to stop silently at 256 skills and 4,096 directory entries, so a skill omitted from
the prompt was also unreachable by search or exact read. Steve asked for thousands of installed
skills, a small stable prompt selected from per-user use, and all available skills in the API.
Discovery now scans the full catalog within explicit resource budgets, with deterministic bounded
parallel directory walks. Search uses BM25 and prioritizes exact names. The API returns every
discoverable skill; only the prompt is a 12,000-character shortlist. Global management assigns
file ownership by nearest installed ancestor instead of repeatedly scanning every file for every
skill, and runner copying no longer stops at 256 small skills. Copy byte and per-file limits still
produce explicit skipped-skill diagnostics.

The shortlist is persisted per agent after its first genuine user is known, with shipped skills,
that user's frequency history, and deterministic cold-start ordering. Successful skill-tool reads
and explicit invocations update bounded per-user aggregates once per run. Search, failed reads,
and raw filesystem reads are not activations. Shared tasks attribute use to the actual accepted
sender, not their owner. Usage affects future task snapshots, not every inference. Existing
snapshots retain order without filling vacancies, but refresh selected descriptions and remove
disabled, missing, unauthorized, or user-only entries promptly. This keeps context stable without
turning a saved shortlist into authority to read an unavailable skill.

## Native skills ship with the product and yield to installed ones

Every skill used to have to be installed into `~/.agents/skills` or a repository before any agent
could use it, so a skill meant for every agent on every project had to be copied around by hand.
Happy Agent now ships native skills: the repository-root `skills/` directory is copied into the
package and embedded in the standalone binary exactly like `docs/`, and every daemon start
installs it read-only in `<happy home>/skills`, the config module's `paths.skillsHome`. Discovery
scans that folder last, as source `builtin`, only for the daemon's native compute, because like
the machine-wide folders it names a path on the daemon's own filesystem. A builtin skill has the
lowest priority, so a project or user skill of the same name replaces it: a shipped skill is a
default the person can override, never something that hides their own. Unlike documentation, the
install removes everything the running release does not ship, so a renamed or retired native skill
stops being discovered instead of lingering from an older release. An empty release is refused
before anything is removed.

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

Refusing every `read_skill` of a user-only skill made the user's own `/deploy` look blocked. There
are two ways a user invokes a skill, and both used to hit that refusal. The slash-command
endpoint injects the document into instructions, but models often call `read_skill` anyway. Happy
Desktop does not use that endpoint for skills. It sends `/deploy` as an ordinary user message
carrying a `tool_call_request` for `read_skill`, which Agent Base runs as a normal tool call before
inference, so the tool cannot tell it apart from a model's call. `read_skill` now succeeds for a
user-only skill the user invoked in the current run: one recorded by the slash-command endpoint
(same name and location), or one named by a `read_skill` request in an accepted message stamped
`messageOrigin: "user"`. An unstamped or agent-origin message unlocks nothing, since agents and
system paths also send user-role messages. Both records live in the run store, so reads in any
later run and `list_skills` still exclude the skill. The injected prompt also says the content is
complete, so a re-read is unnecessary.

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

## A missing machine leaves skill discovery empty

Discovery builds the agent's machine to read its skill folders. A machine that cannot be built
yet, such as one whose workspace folder provisioning has not made, threw out of discovery, so an
agent's slash-command catalog failed and every reply that carried it failed with it, including
replies to mutations that had already committed. Discovery now logs that the machine is
unavailable and offers no skills; the catalog is discovered again before the agent's next turn.
A machine that exists but cannot be read still reports its own failure.

## Agents on runners get the skills too, as copies on their machine

Discovery on a runner used to find only the runner's own `~/.agents/skills` and the repository's
`.agents/skills`: the builtin skills, the installed global skills, and configured folders are
paths on the daemon's disk, so they were skipped, and the prompt pointed at documentation the
agent could not read. A skill is a set of files the agent reads and runs where it works, so
pointing at the daemon would not help. Steve asked for skills to reach the runner. The daemon now
copies its documentation, native skills, and the installation's enabled skills into
`<home>/.happy-agent/` on the runner with ordinary filesystem calls, content-addressed so
unchanged files are never resent. The private `~/.happy-runner` was not used because agents
cannot read it. Both sides derive the paths from the home the runner reports, so no protocol
field was added.

Letting the runner install its own release's docs and native skills at startup was tried first.
The daemon copying them is better: it works with every runner version, the documentation matches
the daemon the agent actually talks to, and a stdio runner started by a test no longer writes
into the real account's home. Copying hands a runner whatever the person put in their skills, so
it is on by default and `sync_skills = false` turns it off for a runner that should not have them;
the documentation and native skills are the product's own and always go.
