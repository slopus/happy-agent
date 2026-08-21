# Agent Instructions

## Master plans

Read [`master-plans/00-master-plan.md`](master-plans/00-master-plan.md) first, before any other work. It explains how master plans are used and maintained. Then find every plan in [`master-plans/`](master-plans/) relevant to your task and read each one in full before starting.

Master plans are dictated by the user and describe where the product is going, in what order, and what counts as done. They outrank conclusions drawn from the existing code. Do not create, edit, rename, or delete a file in `master-plans/` unless the user explicitly asks for that change in the current task. When the code contradicts a master plan, report the contradiction instead of revising the plan.

All persistent plans must live in `master-plans/` and follow the master-plan rules above. Do not create design documents, implementation plans, slash-command plan artifacts, or planning directories anywhere else in the repository, including `docs/plans/`.

Discussion notes that support or contextualize master plans must live only in
`master-plans/notes/`. Do not create these notes in the `master-plans/` root,
in another documentation directory, or anywhere else in the repository.

## API specification

Do not create, edit, rename, or delete any `API.md` file without direct human
input in the current task that explicitly authorizes the specific API
specification change.

`packages/happy-agent/API.md` is the authoritative Happy Agent API contract. Client types,
runtime schemas, daemon behavior, tests, and documentation must conform to it exactly. Never
invent, implement, preserve, or release behavior that deviates from the specification; stop and
request a human-directed specification change when the desired behavior is not already described.

Happy Agent API compatibility begins with protocol version 22. From version 22 onward, every API
change must be backward-compatible and additive: never remove or rename an existing field, and
never add a required field. New fields must be optional so older clients and daemons can ignore
them safely. If a desired change cannot be made within those constraints, stop and request direct
human guidance rather than breaking compatibility.

Rig must support every Happy Agent API version from protocol version 22 onward and must be able to
work with any Happy Agent CLI version in that compatibility range. Do not couple Rig to only its
bundled or current CLI version; negotiate or tolerate protocol-version differences so users can
select and run any compatible CLI release.

## Modules

A module is a self-contained feature. It carries everything that feature needs to work: it extends the agent loop through its own hooks, owns its tools, starts and supervises its background processes, and holds its connections to third-party services. Adding a module to an agent is the whole installation — nothing elsewhere should have to be wired up, registered, or branched on for the feature to function.

A module may take only other modules as arguments. Not configuration objects, path strings, clients, callbacks, or loose handles. When a module needs something, it takes the module that owns that thing and asks it. This keeps the dependency graph a graph of features, and keeps a module's collaborators visible in its constructor rather than assembled by whoever happens to build it.

Modules do not import from each other beyond the seam that joins them. A module may import another module's class and the public types that module exports from its `index.ts` — enough to declare it as a constructor dependency and to speak about the values it returns. Nothing else crosses the boundary: helper functions, `impl/` internals, stores, schemas, migrations, and prompt text belong to the module that owns them. A module that needs such behavior asks the owning module instance for it instead of importing the file, and when there is no method to ask, the method is added to the owning module rather than reached past.

The config module is what that rule leans on most. It is not merely parsed configuration: it resolves and owns the paths the product runs against, and it instantiates the providers. A module that needs a path or a provider depends on the config module and takes it from there, instead of deriving paths itself or constructing a provider of its own.

There is no host object, and none may be introduced. A module is never handed a `HappyHost`, `McpHost`, `GoalHost`, `WorkspaceHost`, a resolver, a broker, a backend, a scheduler, or any other object standing in for the application around it. If a module needs to reach the filesystem, Git, a process, a socket, a clock, or a third-party API, it reaches it itself. A capability that a module cannot perform on its own is a capability that module does not have — the answer is to give it what it needs to do the work, not to inject something that does the work on its behalf and calls back.

The host concept came from the Rig v2 migration plan written for the module rewrite, since deleted. It made Rig the host — owner of paths, providers, Git, files, processes, media, and clocks — and modules pure state machines over the database that received all external reach through injected structural contracts. That split is no longer the design. The `*Host` interfaces still present in `packages/happy-agent-modules/sources` are residue from it: remove one when its module is revisited, and never add, extend, or copy one.

## Module learnings: LEARNINGS.md

A module may carry a `LEARNINGS.md` beside it. When working on a specific module, always read that module's `LEARNINGS.md` in full before making changes.

`LEARNINGS.md` records human feedback on the module and the decisions that came out of it. Models must always write learnings there as they arise, and must keep the document nice and tidy and on point — consolidate, prune, and rewrite for clarity rather than appending noise. A learning stands on its own: state what was wrong, what the module does now, and why, without pointing at another document to be understood.

## Product direction

Build the best combined coding-agent experience from Codex and Claude Code, with a strong focus on simplicity, thoughtful defaults, and a polished user experience. Prioritize important, widely useful workflows over obscure features or exhaustive parity.

## Deliberate non-goals

Do not implement a dedicated Plan mode, Vim or other modal editing modes, Jupyter notebook parsing or editing, durable command allow/deny history, dedicated IDE integrations, a separate Rig login flow, or niche compatibility features whose primary value is exhaustive upstream parity. Rig uses the credentials managed by the system Codex and Claude Code installations, so users should sign in through those assistants instead. Planning should remain part of the normal agent workflow. Auto permissions should review the current action and user authorization without learning a persistent command-execution policy. Skills should follow Codex behavior and scope, not Claude Code's expanded skill runtime. Only reconsider these boundaries when the user explicitly changes the product direction.

## Permissions and security

Rig has one permission model for every provider. Codex, Claude, Pi, Grok, MCP, and future tool surfaces must execute through the same `AgentContext`, filesystem boundary, shell sandbox, and `PermissionContext`. Provider differences belong in tool names, argument schemas, result formatting, and model guidance; they must not create provider-specific security paths in the agent loop.

The permission modes are:

- Read only permits inspection and non-mutating commands while blocking workspace changes and shell network access. On macOS and Linux, restricted filesystem reads follow Codex and may inspect the host filesystem.
- Workspace write permits changes inside the workspace while keeping shell network access and writes outside the workspace blocked.
- Auto uses the Workspace write shell sandbox by default. A tool may request review for one exact action, and an allowed tool may receive a temporary Full access override only when its own policy explicitly requires it. Review is automatic; it never becomes a question to the user.
- Full access removes Rig's filesystem, shell, and network restrictions.

Every tool definition must own its Auto behavior. `shouldReviewInAutoMode` is required. Define `shouldRunInFullAccessInAutoMode` only for reviewed actions that must cross the sandbox; review alone must not imply elevation. Use `requiresAutoOrFullAccess` for tools such as MCP operations whose external execution boundary cannot be enforced by Rig's local sandbox. Use `autoPermissionInstructions` for provider-specific model guidance and `describeAutoPermissionAction` when an approval must disclose a specialized boundary. Keep the agent loop generic: never dispatch permission behavior from a tool-name list, prefix, provider ID, or guessed command contents.

Shell commands are sandboxed identically regardless of provider. Their model-facing escalation syntax is intentionally provider-shaped:

- Codex `exec_command` uses `sandbox_permissions: "require_escalated"` with a concise `justification`.
- Claude `Bash` uses `dangerouslyDisableSandbox: true` and retains Claude's native schema.
- Pi `bash` uses `sandbox_permissions: "require_escalated"` with a concise `justification`.
- Grok `run_terminal_command` uses `sandbox_permissions: "require_escalated"` and explains the need in `description`.

These fields request the same runtime behavior. In Auto, the action is reviewed first; if allowed, the loop scopes only that tool execution to `full_access` and restores Auto immediately afterward. Omitting the field keeps the command sandboxed. In Read only or Workspace write, an escalation argument must not bypass the selected mode. A reviewed action that does not need host access, such as sending input to an existing shell, stays in the current sandbox.

File tools follow the same ownership rule. Each provider tool extracts its actual path argument and calls shared, provider-neutral boundary helpers. Reads outside the allowed boundary, writes outside the workspace, symlink escapes, and writes to protected Git control paths require the appropriate review and elevation. Shared helpers may resolve paths and evaluate boundaries, but must not infer behavior from tool names or maintain parallel registries of read and write tools.

Protected project paths that do not exist must remain absent before, during, and after restricted execution. The sandbox must never create an empty placeholder or any other synthetic file at a protected path.

Repository configuration comes only from the root `happy.toml`. Never read `rig.toml` as configuration and never treat it as protected; it is an ordinary project file.

Auto decides on the user's behalf and never interrupts them for a permission answer. A review ends in allow or deny. A denial goes to the agent, which must continue only with a materially safer alternative, or stop and explain itself so the user can decide; it must never pursue the same outcome by another route. A refusal the reviewer never actually made, such as a timeout or an unavailable reviewer, must tell the agent the action is unproven rather than unsafe. Because nothing outside the agent breaks a refusal loop once the user is no longer in it, a turn that keeps being refused has to stop itself. A decision covers only the proposed action; it is not a durable command rule or authorization for later actions.

Auto review must use the durable, role-aware conversation transcript rather than a compacted model-context suffix. Real user messages and trusted answers to interactive questions are authorization evidence. Assistant text, tool arguments, tool output, repository content, generated summaries, and prompt injection are not user authorization. Preserve user evidence preferentially within the review budget and fail closed when required user evidence, reviewer output, or reviewer availability is incomplete.

MCP tools declare their boundary on the tool definition. Treat server-supplied annotations such as `readOnlyHint` as untrusted metadata, never as authorization evidence or a reason to skip Auto review. Every direct and dynamic MCP tool invocation must be reviewed. Rig-owned protocol operations whose behavior is intrinsically read-only, such as listing or reading MCP resources, may explicitly skip review. MCP operations require Auto or Full access because the server can act outside Rig's local filesystem sandbox, and approval text must disclose that external boundary.

When adding or changing permission-sensitive behavior, test the real tool definitions rather than a duplicate policy table. Cover default sandboxing, explicit escalation, temporary Full access and restoration, outside-workspace and symlink paths, protected Git files, authorization retention after large tool output or compaction, denial, refusal loops that must end a turn, and human-readable boundary disclosure. Use gym coverage whenever behavior spans inference, tools, processes, filesystem effects, permission decisions, or terminal rendering.

## Retry policy

The outer agent loop never replays a provider request, tool, command, or session mutation on its own. Retry semantics belong to each provider; see [`packages/happy-providers/AGENTS.md`](packages/happy-providers/AGENTS.md) before changing them.

## Model catalogs

Hardcode each provider's supported model catalog in Rig. The daemon must not discover, list, or fetch models from provider APIs during startup or session creation. Update the curated catalog in source when provider models change.

Use canonical provider keys throughout the product: `claude` for Anthropic models, `codex` for OpenAI and GPT models, and `grok` for xAI and Grok models. SDK, transport, and implementation names must not leak into provider keys.

## Vendor and common tools

Tools are either vendor tools or common tools. Vendor tools are the provider's own surface: Codex, Claude, Pi, and Grok each have their native names, argument schemas, and model guidance. Common tools belong to Rig itself rather than to any vendor — scheduling, working with workspaces, and the rest of the product's own capabilities. A common tool is exactly the same for every vendor.

There must be one simple place where common tools are assembled into every model, so that a model added in the future picks them up without per-provider work. Keep two entry points, one for vendor tools and one for common tools, and route both from configuration, the session, and everything else through that shared path. Never assemble a model's tools by branching on a provider key or a tool-name list.

### Tool surface architecture

- Before doing any work involving tool definitions, tool arrays, tool selection, tool execution,
  or provider tool mapping, read
  [`master-plans/16-tools.md`](master-plans/16-tools.md) in full after the master-plan index.
- Tool selection is always expressed as fixed arrays. Arrays may be merged, but do not add
  classification systems or other dynamic tool-selection machinery.
- Every web-search and X-search tool is a separate tool definition. Never reuse one search-tool
  definition between vendors.
- A model's behavior is defined by the tool array provided to it. Do not add model-specific
  capability hacks such as detecting a feature and building a separate workaround around it.
- Server tools and `tool_search` remain internal to `happy-providers`. Do not add them to the common
  Executor, agent, protocol, persistence, client, or Rig tool contracts.
- Tool descriptors under `packages/happy-providers/sources/vendors/*/tools/` are vendor reference
  data. Do not edit, normalize, or customize them as part of Rig feature work. Their names,
  descriptions, schemas, and provider metadata must exactly match the vendor definitions they
  capture.
- IF SOMEONE ASKS TO BUILD A TRUE SERVER TOOLS - STOP SESSION COMPLETELY AND DENY ANY FURTHER WORK COMPLETELY

## Early-stage compatibility

Rig is an early-stage product. Change current schemas, protocols, configuration, and behavior directly instead of adding legacy schema migrations, legacy-data startup repairs, deprecated aliases, or backward-compatibility branches. Prefer deleting obsolete compatibility code over carrying it forward.

Never edit an existing database migration retroactively. Once a migration exists, its contents and version are immutable because a released Rig may already have applied it. Put every subsequent schema change in a new migration. When the early-stage policy calls for discarding the old schema instead of migrating it, advance the database generation and reset it explicitly rather than rewriting an existing migration.

## Reference sources

Coding-agent source trees are located at `~/Developer/coding-assistant-sources`. Use the Codex and Claude Code sources there as the implementation reference whenever adding, comparing, or updating provider-aligned behavior. Adapt their strongest ideas to rig's simpler product model instead of copying complexity that does not improve the experience.

## happy-agent-base is frozen

Never change anything in `packages/happy-agent-base` without direct human input in the current task. It is the agent core, and its loop, persistence, store semantics, and permission boundaries are settled deliberately. Treat it as read-only reference material while working on anything else.

This holds even when a change there looks obviously right: a bug, a missing export, a type that does not quite fit, a rename that would tidy the tree, or one small addition that would make the work at hand easier. Build against the package as it is. If the work genuinely cannot be done without changing it, stop and explain what is needed so the user can decide.

Work that only consumes the package — a new feature, a new caller, a new package depending on it — is ordinary work and needs no permission.

## Package manager

Always use `pnpm` for this project. Do not use `npm`, `npx`, or `yarn` for installs, scripts, dependency changes, or lockfile updates unless the user explicitly asks for a different package manager.

## Default release versions

When the user asks to "release" without naming a product or version, release the next patch
version of Happy Agent. Do not treat an unqualified release request as a Happy Terminal or library
release.

Happy Agent releases are always the next patch version. Release Happy Agent only by manually
dispatching [`.github/workflows/release-happy-agent.yml`](.github/workflows/release-happy-agent.yml)
from `main`; do not create or push its release tag locally. Supply the workflow's required
`version` and `release_notes` inputs. Build the release notes from every commit included since the
previous Happy Agent release, and write a polished, user-facing Markdown summary that explains the
changes clearly rather than pasting commit subjects or a raw changelog. Monitor the workflow to
completion and verify the resulting GitHub Release and its assets before reporting success.

Happy Terminal releases are always stable patch releases. Never release Happy Terminal as a beta
or any other prerelease. When the user asks to "release terminal", release the next patch version
of `@slopus/happy-terminal`. Release Happy Terminal only by manually dispatching
[`.github/workflows/release-happy-terminal.yml`](.github/workflows/release-happy-terminal.yml) from
`main`; do not create or push its release tag locally. Supply the workflow's required `version` and
`release_notes` inputs. Build a polished, user-facing Markdown changelist from every commit included
since the previous Happy Terminal release, monitor the workflow to completion, and verify both the
npm package and GitHub Release before reporting success.

When the user explicitly names another product or library but does not name a version:

- Release libraries as the next patch version.

Use an explicitly requested version or release channel instead whenever the user provides one,
except that Happy Terminal always releases as its next stable patch version.

Always release through trusted publishing by pushing the release Git tag. Never publish directly
from local npm credentials. If a tagged patch release fails before publication, it may remain
unpublished; advance to the next patch version and push a new release tag instead of reusing or
moving the failed tag.

## Published SDK dependencies

`@slopus/happy-providers`, `@slopus/happy-agent-base`, `@slopus/happy-agent-client`, and
`@slopus/happy-agent-compute` are always consumed from their published npm versions, even though
their sources live in this repository. Every package that depends on one of them pins the published
version. Never change such a dependency to `workspace:*`, and never add a new one as a workspace
link.

More generally, whether a dependency comes from npm or from this workspace is an explicit human
decision. Never change a dependency from a published version to `workspace:*`, or from `workspace:*`
to a published version, without direct human input in the current task.

Every package must resolve the same published version of each of these, because pnpm gives a
`workspace:*` link and a version pin two separate copies of the same package. Two copies mean two
copies of every class, so `instanceof` fails across the seam and errors thrown by one copy are not
recognized by the other. When a dependency must be upgraded, upgrade it in every package that
declares it, in the same change.

## Happy Agent API release flow

When changing the Happy Agent API, use this sequence:

1. Update `packages/happy-agent/API.md` first. The specification is the source of truth for the
   entire change and must describe the complete intended contract before implementation begins.
2. Implement the matching public types, runtime schemas, and client behavior in
   `@slopus/happy-agent-client`. Test those changes, sync them to `main`, and release the client
   through trusted publishing.
3. Only after the client is published, update every package that depends on
   `@slopus/happy-agent-client` to the newly published exact version and update the lockfile in the
   same change.
4. Implement all remaining daemon, module, protocol, product, and test changes against that
   published client version. The implementation must not extend or reinterpret the API beyond the
   approved specification.
5. Run the relevant tests and typechecks, then sync the remaining implementation and dependency
   changes to `main`.

Do not begin the client implementation before the specification is updated. Do not begin the
remaining implementation before the client is published. Do not point consumers at an unpublished
client version or combine the client release sync with the post-release dependency and
implementation sync.

## Runtime validation

Use TypeBox schemas for every runtime type validation. Derive TypeScript types from those schemas
with `Static`; do not hand-write parallel interfaces, object-key checks, type predicates, or other
ad hoc validation.

## Code organization

A file should hold one coherent piece of behavior. Most product code lands at one function per file; keep small helpers alongside the thing they serve rather than splitting every function out on principle. Match the surrounding package — `happy-providers` deliberately keeps larger files and documents why.

## Context and lifetimes

`Context` is an immutable carrier for cross-cutting execution state. This includes the current database scope and, while a transaction is active, the transaction available through `ctx.tx`. Never mutate a context in place. Derive another context with its namespace or `with...` helper, such as `withTransaction`, and pass the derived context through the work that should see that value.

Every persistent operation must be transaction-composable. When its caller supplies a context
carrying an active transaction, the operation must participate in that transaction: reads use its
snapshot, writes commit or roll back with it, and notifications publish only after it commits. A
public operation must never reject merely because `ctx.tx` exists, discard that context, or open an
independent transaction for work that belongs to the caller's atomic change. If an external or
long-lived side effect cannot execute inside the transaction, persist its intent atomically and
start it after commit rather than weakening the durable boundary.

Initialize the application with one root context, then create a new named context at every independently owned lifetime. A context name describes the conceptual point where that lifetime was created and who owns it, such as an API request, worker, connection, or process; it is not merely the name of the next low-level function. Bounded operations owned by that lifetime remain on its context and may create ordinary child spans.

Do not let a short-lived caller own work that can outlive it. If an HTTP request, route, tool call, or other operation starts an independent service, actor-like loop, or process, start that work in its own named context derived from the application root. Keep only caller-owned work—such as waiting for startup or collecting the first few seconds of output—inside the caller's context. The independent work's lifetime and internal operations use its own context. Later external interactions with it, such as polling, writing input, or stopping it, use the context of the caller performing that interaction.

A background process started by a tool call is the canonical example: the tool's initial bounded wait belongs to the tool or turn context, while the process lifetime belongs to a separate named process context. The process must not retain the completed tool, turn, or HTTP request context.

## Change discipline

Treat behavior that crosses the TUI, protocol, daemon, persistence, and provider layers as one end-to-end contract. Trace the full path before editing, keep stable run, message, tool-call, and event identities across asynchronous boundaries, and test delayed, duplicated, reordered, rejected, and already-applied outcomes. Model multi-step asynchronous behavior with explicit states and terminal transitions instead of accumulating loosely related booleans and best-effort callbacks.

Compatibility migrations and startup repair must be atomic, idempotent, and selective at the storage boundary. Filter to the required rows in SQL before deserializing payloads, do not materialize unrelated or potentially large historical events, and derive ordering or cursor provenance independently when filtering would otherwise hide the true latest event. Publish external or in-memory notifications only after the durable transaction commits.

Keep optional work off correctness and interaction critical paths. Telemetry, quota observation, debug logging, metadata, discovery, and status enrichment must have explicit time and size bounds, must release listeners and resources, and must not turn a successful agent run into a failure. Do not create unbounded promise chains, event buffers, transcript caches, image stores, debug directories, or live-work rows without an explicit retention, compaction, or backpressure strategy.

Keep provider discovery and runtime construction on one shared path, so every model shown as available can actually be instantiated with the same configuration, credentials, filters, and routing. Provider-native prompts, tools, and schemas may differ, but lifecycle, persistence, permissions, retry safety, and error semantics remain shared contracts.

For bug fixes, first add the smallest deterministic test that reproduces the failure at the layer where the broken contract is observable. Preserve that test unchanged while fixing production code, then add lower-level tests only where they clarify an invariant. Keep each commit coherent and green; avoid follow-up commits whose only purpose is repairing timing assumptions, lint, or incomplete coverage that could have shipped with the original change.

## Gym end-to-end tests

The gym exercises the built Rig agent through a real PTY in a fresh Docker container. Only model inference is mocked; the filesystem, shell, processes, daemon, tools, and terminal behavior remain real, with `libghostty-vt` providing user-visible screen and scroll state.

Use gym tests for behavior spanning terminal input or rendering, inference, tools, processes, filesystem effects, interruption, or concurrency. Put them in `packages/gym-tests/tests` with descriptive behavior-based file names. Always use `createGym`, interact at the terminal boundary, wait for observable state instead of sleeping, dispose every instance, and keep scenarios isolated. When fixing a bug, reproduce it in the gym before changing production code, then make the same test pass unchanged.

Run the suite with `pnpm test:gym`. Read [`packages/gym-tests/README.md`](packages/gym-tests/README.md) before writing or debugging a gym test; it is the source of truth for architecture, APIs, inference scripts, fixtures, terminal snapshots, scroll tracking, examples, and targeted test commands.

The complete Happy Agent API gym, `pnpm test:gym:api`, is an exhaustive gate with
663 scenarios, 120 deterministic chaos seeds, and 9,640 chaos actions. It takes
about 45 minutes on the unprivileged Linux runner. Do not run it as routine
verification or automatically on every push or pull request. Run targeted API
gym files while developing. Run the complete gate only when a human explicitly
requests it or when closing a release or API-contract milestone. In GitHub
Actions, dispatch `Verify Happy Agent API` manually and enable
`Run the exhaustive API gym`.

## User-facing text

All strings displayed to users must be human-readable English. Prefer natural, human-like labels and messages over raw identifiers, internal enum values, file names, protocol names, or placeholder text. Convert technical values into clear display text before rendering them in the UI or CLI.

## Terminal layout stability

Treat the logical transcript as append-only. Once a timeline row has rendered, do not remove it, replace it, or mutate it after later stable content appears. Ephemeral background-terminal polling belongs only in the live tail and must not create waiting or waited history rows. Keep actual terminal input and terminal completion as durable history.

Use Pi TUI's authoritative full-frame redraw behavior for terminal resizes. Clearing and rebuilding native terminal scrollback from the logical transcript during a resize is acceptable. Do not maintain a parallel partial-resize renderer, infer emulator reflow, or reach into Pi TUI's private render state.

Keep above-composer live UI compact and predictable, with at most one truncated summary row per active-work category. Live components may grow downward, but shrinking or completing work must not pull transcript content downward or make the composer jump upward. Pair the removal of a final live status row with its corresponding history event in the same render so the occupied height moves into history instead of collapsing.

When an agent turn completes, move its live working timer into an immutable history row. Measure elapsed time from the most recent composer-submitted user message; permission decisions and other interactive answers must not reset that clock.

## Remote pushes

Never push to any remote unless the user explicitly requests a push or sync in the current task. Do not infer push permission from completed local work.

## Sync to main

When the user says `sync to main`, treat it as an explicit instruction to upstream the current work directly to `main`.

Do the following:

1. Review the current changes.
2. Commit the current changes.
3. Rebase the current branch on `origin/main`.
4. Push directly to `main`.
5. Do not force push.
6. If the push or rebase is rejected because `main` moved, fetch/rebase and retry the non-force push.
7. Repeat until the current branch changes are upstreamed to `main`, or until a real conflict/blocker requires user input.

Do not open a pull request for `sync to main` unless the user explicitly asks for one.
