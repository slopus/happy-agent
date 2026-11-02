# Skills module

```ts
const skills = new SkillsModule(computeModule, globalSkillsModule, configModule);
```

The daemon additionally installs `new GlobalSkillsModule(configModule, durableFunctionsModule)`
and passes it to `SkillsModule` as the optional second module dependency. Global management owns
the daemon's native `~/.agents/skills` catalog; it never inspects a separate compute's filesystem.
The optional third dependency, the config module, supplies the extra skill folders configured in
`[skills] directories`: the user `happy.toml` list, already resolved to absolute paths, and the
parser for the same table in a project's root `happy.toml`. Without it only the standard roots
are scanned.

`SkillsModule` takes the compute module and asks it for the exact cached compute belonging to the
current agent, and for the permissions that machine is read under. It recursively discovers user
skills under `~/.agents/skills` and project skills under `.agents/skills` from the nearest Git root
down to `compute.cwd`. A deeper project skill with the same name replaces an earlier one. Configured
folders come after those: the project root's `happy.toml` is read through the compute and its
`[skills] directories` entries are resolved against the project root and scanned as project skills;
the machine's configured folders are scanned as user skills, but only on the daemon's native
filesystem, since they name paths on this machine. A configured folder never outranks a standard
root for a same-named skill, and a missing or invalid project file simply adds nothing. The native
skills Happy Agent ships, which daemon startup installs in the config module's `paths.skillsHome`,
are scanned last as `builtin` skills, again only on the daemon's native filesystem; any project or
user skill of the same name replaces one. Apart from
that, a skill is a file on the agent's own machine, so an agent with no machine has no skills and
is given no skill tools.

The catalog and skill documents are read live through `compute.fs`, bounded, and exposed through
model instructions plus `list_skills` and `read_skill`. Both tools read inside Happy Agent's own filesystem
boundary, so neither is reviewed in Auto. Agent discovery owns no persistent index.
Overlapping scans share work only for the same filesystem identity, cwd, home, and full operation
permissions. Compute supplies native boundary identity; alternate providers use filesystem object
identity. Sharing retains at most 128 in-flight scans and drops each on completion, so later refreshes
immediately see edits, additions, removals, and recovered files. Directory metadata is batched through
the backend, which owns bounded parallelism and permission checks. Completed catalogs are not cached.
Discovery skips dot-directories, `node_modules`, and malformed or unreadable skills without hiding
the rest of the catalog; `list_skills` uses its returned cursor to continue a bounded page.
Frontmatter metadata is parsed as YAML-compatible mapping data, including flow maps, aliases,
quoted values, and block scalars.

A skill whose frontmatter says `disable-model-invocation: true` is reserved for the user, as in
Claude Code. It is still discovered and still offered as a slash command, and invoking it carries
its content into the run as usual, but it is left out of the model's instruction catalog and
`list_skills`, and `read_skill` refuses it with a message saying only the user may invoke it. Only
the plain YAML boolean counts; a quoted `"true"` is an ordinary string and does not set the flag.

## Skills on a runner's machine

A machine a runner serves — another computer, or a workload user's runner on this one — cannot
read the daemon's folders, so discovery scans copies there instead, found through
`ComputeModule.productFiles` under `<runner home>/.happy-agent/`. `SkillMirrorModule` writes them:

- `docs/` and `skills/` hold this daemon's documentation and native skills. Every runner gets them;
  the skills are scanned as `builtin`, and the prompt points at the documentation there.
- `synced-skills/` holds this installation's enabled global skills and configured skill folders,
  scanned as user skills after the runner's own `~/.agents/skills`, so a skill installed on the
  runner wins a name collision.

`SkillMirrorModule` takes the config, runners, global skills, and Durable Functions modules. A
durable loop syncs each connected runner, and the workload user's runner, when it connects, when
the installed skills change, and every five minutes, which also notices edits to configured
folders. The documentation and native skills are each copied as a whole folder carrying a hash of
its content, so an unchanged folder costs one small read. Each of the installation's skills lands
in a folder named for its content (`<name>-<hash>`), so only a skill the runner lacks is sent.
New content is assembled under a dot-name discovery skips and moved into place, its files made
read-only with their executable bits kept, and everything else in `synced-skills/` is removed. A
name already taken by a higher-ranked source is not copied, disabled skills are left out, and a
skill with more than 512 files, a file over 8 MiB, or that would take the total past 64 MiB or 256
skills is skipped with a warning. `[runners.<id>] sync_skills = false` keeps a runner from
receiving the installation's skills, and removes a copy it had. Bots that run as a Linux user of
their own get none of these copies: only the default workload user's home receives them.

## Public operations

- `list(ctx, agentId, input?)` — a bounded, optionally filtered page of the current catalog.
- `read(ctx, agentId, { name })` — the complete document for one currently discoverable skill.

## Installed global skill management

`GlobalSkillsModule` owns a bounded persistent catalog with stable IDs, retained installation-path
identities, UUIDv7 versions, parsed documents, and non-destructive enablement. Runtime preferences
are mirrored to generated `runtime.toml` through Durable Functions after the catalog transaction
commits. Removed installations retain their identity and preference for reinstallation.

Its management operations are `list`, `read`, `files`, `readFile`, and `setEnabled`. They are used by
the matching `/v0/skills` API routes, including disabled or broken installations. File reads stay
inside the installation's canonical directory and enforce document and binary size limits.
`onUpdated` publishes bounded committed invalidations into the existing API journal and SSE feed.

A Durable Functions execution owns native directory watches and a bounded periodic reconciliation
fallback. It watches missing-root ancestors and directory-symlink targets, handles atomic file and
root replacements, and continues watching disabled skills. Unchanged scans do not produce versions
or notifications. Root scan failures remain errors rather than false removals.

Native agent discovery excludes unavailable global locations before resolving name precedence and
rechecks enablement after shared discovery. Project skills and alternate compute filesystems remain
independent. Prompt refresh also filters pending skill invocations against the current catalog;
ordinary filesystem tools and already-sent history are unaffected.

## Live skill folders for admin bots

`SkillFoldersModule` takes the config and bots modules and gives active admin bots three tools:
`list_skill_folders`, `add_skill_folder`, and `remove_skill_folder`. Other agents do not receive
them, and every operation checks the caller's bot record again when it runs. Adding a folder or
removing one writes the machine `[skills] directories` list in generated `runtime.toml` through the
config module, which merges it with the user `happy.toml` list. Discovery reads that merged list on
every scan, so a change reaches every agent's next turn without a restart. A folder must be an
existing directory given as an absolute path; `~/` and relative paths are rejected. Folders from the user `happy.toml` are listed
but cannot be removed live. Repeating an add or remove leaves the list unchanged and succeeds, so
the tools are durable.
