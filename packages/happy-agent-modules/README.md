# @slopus/happy-agent-modules

Everything an agent can _do_, as separately composable features.

[`@slopus/happy-agent-base`](https://www.npmjs.com/package/@slopus/happy-agent-base) owns only the
durable loop: context, queued messages, inference, tool dispatch, permission mode, storage, and
per-agent key-value scopes. It deliberately knows nothing about files, shells, goals, people, or
Git. This package is where all of that lives. Pick the modules you want and you get an agent whose
capabilities are exactly that list.

```ts
import { AgentSystemLocal } from "@slopus/happy-agent-base";
import {
    ComputeModule,
    ConfigModule,
    GoalModule,
    HistoryModule,
    ModelSwitchModule,
    SystemPromptModule,
    createComputeModules,
} from "@slopus/happy-agent-modules";

const config = await ConfigModule.load();
const compute = createComputeModules(new ComputeModule(config));
const history = new HistoryModule();

const system = await AgentSystemLocal.create(ctx, storage, {
    models,
    provider,
    providers,
    modules: [
        config,
        new SystemPromptModule(config, compute.computeModule),
        history,
        new ModelSwitchModule(history),
        new GoalModule(),
        ...compute.modules,
    ],
});
```

`packages/happy-agent/sources/start/startHappyAgent.ts` is the reference composition: it builds every
standard module, in dependency order, over one SQLite database and one host compute.

## What a module is

A module is a self-contained feature. It carries everything that feature needs to work: it extends
the agent loop through its own hooks, owns its tools, starts and supervises its background
processes, and holds its connections to third-party services. Adding a module to an agent is the
whole installation — nothing elsewhere has to be wired up, registered, or branched on for the
feature to function.

**A module takes only other modules as arguments.** Not configuration objects, path strings,
clients, callbacks, or loose handles. When a module needs something, it takes the module that owns
that thing and asks it. The dependency graph stays a graph of features, and a module's collaborators
are visible in its constructor rather than assembled by whoever happens to build it.

**There is no host.** No module is handed a `HappyHost`, `McpHost`, `GoalHost`, `WorkspaceHost`, a
resolver, a broker, a backend, or a scheduler. A module that needs the filesystem, Git, a process, a
socket, a clock, or a third-party API reaches it itself. A capability a module cannot perform on its
own is a capability that module does not have; the answer is to give it what it needs, never to
inject something that does the work on its behalf and calls back. The `*Host` interfaces still in
`sources/goal`, `sources/happy`, and `sources/mcp` are residue from an earlier design — remove one
when its module is revisited, and never add, extend, or copy one.

**Config is the module the rule leans on most.** `ConfigModule` is not merely parsed configuration:
it resolves and owns the paths the product runs against, and it instantiates the providers. A module
that needs a path or a provider depends on the config module and takes it from there, instead of
deriving paths itself or constructing a provider of its own. `ConfigModule.load()` resolves the
`.happy` root and reads the layered `Happy/Config/happy.toml` and `.happy/agent/runtime.toml` files;
load it first and place the same instance first in the module array.

## How a module works

A module is one shared instance serving an entire agent collection — never one instance per agent.
It contributes any of: model-facing **tools**, system-prompt **instructions**, lifecycle **hooks**,
ordered database **migrations**, and a **public API** any caller can use directly without an agent
running at all. The tools and the public API are the same implementation; a tool is a thin
model-facing wrapper over the method a direct caller would use.

- **State** lives in the agent database carried on `ctx.db`, in module-owned tables created by the
  module's own migrations, or in the Agent Base `kv` / `sharedKV` / `runKV` scopes. Never in
  instance fields, except for the live processes, connections, and timers a module supervises.
- **Context comes first.** Almost everything takes `ctx` as its first argument: it carries the
  database scope, the active transaction, the logger, and the tracer. Log through `ctx.log` and
  instrument with `ctx.span` rather than reaching for a module-level logger or a global tracer.
  A context is immutable — derive a new one instead of mutating it.
- **Transactions** come from Agent Base. A mutating tool sets `transactional: true` so the base owns
  one transaction across execution, validation, rendering, and result settlement; a direct public
  mutation uses `ctx.inTx`. `inTx` nests freely: an inner call joins the transaction already on the
  context instead of opening a second one, so a public method never has to know whether its caller
  already started one. Concurrency control is the database's, not the application's — SQLite runs
  one writer at a time, so a transaction there is effectively a global write lock, while a database
  with real row-level concurrency takes no application-level lock at all. A module may keep locks of
  its own, but it has to hold them with those mechanics in mind: a lock taken inside a transaction is
  held until the outermost commit, and waiting on one while inside a transaction can stall every
  other writer behind it.
- **Compose transactionally.** Because `inTx` nests, most public methods should be callable inside
  someone else's transaction, so that creating an agent, sending it a message, and marking the tool
  call complete all commit or all fail together. Write a method to take the caller's `ctx` and do
  its work there; do not open a private transaction, commit early, or perform a mutation whose
  effect the caller cannot roll back.
- **Events** arrive twice: `onEventTransactional` inside the committing transaction, and `onEvent`
  after the outermost commit. `afterCommit` work is the one place a context carries no transaction —
  everywhere else there is one, and the effect of a post-commit failure is that it is reported,
  never converted into a failed tool call the database has already committed.
- **Lifetimes.** Work that outlives the call that started it runs on its own named context derived
  from the application root, never on a tool call or request context that will be gone before it
  finishes.
- **Isolation.** A module imports Happy Agent from nowhere and reaches for no global. Where two capabilities
  must meet, one module takes the other: `ModelSwitchModule` takes `HistoryModule`, `WorkspacesModule`
  takes `ProjectsModule`, `TerminalsModule` takes both, `WorkflowsModule` takes `CollaborationModule`.

[NICE_TO_HAVE.md](./NICE_TO_HAVE.md) records Agent Base improvements that would make modules smaller
— none are blockers, and none may be worked around inside a module.

## Module catalog

Every module has its own README covering its exact tools, their permission and durability behavior,
its public methods, and its storage and event contracts.

### The conversation

| Module                                          | What it adds                                                                                                                              |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| [Config](sources/config/README.md)              | One frozen filesystem layout and layered Happy Agent settings snapshot shared by every other module.                                      |
| [Provider scan](sources/providerScan/README.md) | Local credential discovery, durable provider overrides, live enablement, and bounded account verification.                                |
| [Observation](sources/observation/README.md)    | What the agent records about itself: a pino log file, optional OpenTelemetry traces, and a readable per-agent history dump.               |
| [System prompt](sources/systemPrompt/README.md) | Native per-vendor instructions, environment context, and live global/security/project AGENTS.md guidance.                                 |
| [History](sources/history/README.md)            | The agent's own durable record of what happened, separate from the compactable model context, readable back through `read_agent_history`. |
| [Model switch](sources/modelSwitch/README.md)   | An honest notice when switching models resets a context that cannot be replayed, with a bounded excerpt of what was lost.                 |
| [Skills](sources/skills/README.md)              | User and project skills discovered live under `.agents/skills`, exposed as `list_skills` and `read_skill`.                                |
| [Events](sources/events/README.md)              | A bounded, cursor-addressable journal of what happened, shared by every agent in the collection.                                          |
| [Titles](sources/titles/README.md)              | The names a first message settles — the chat's title, and the workspace and branch it works in.                                           |

### The machine

| Module                                                | What it adds                                                                                                                                    |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| [Compute](sources/compute/README.md)                  | One machine offered as each vendor's own filesystem and shell tools, with stale-file detection and background commands that outlive their wait. |
| [Permissions](sources/permissions/README.md)          | The permission mode turned into behavior: per-call review, temporary elevation, refusal handling, and mode-change notices.                      |
| [Tool discovery](sources/toolDiscovery/README.md)     | Provider-owned native search for deferred tools, with eager fallback on unsupported provider/model routes.                                      |
| Auto (`sources/auto`)                                 | The automatic reviewer permissions asks in Auto mode, running on its own private database and its own read-only compute.                        |
| [MCP](sources/mcp/README.md)                          | MCP servers, tools, resources, and prompts, always reviewed in Auto.                                                                            |
| [Search](sources/search/README.md)                    | A bounded common `web_fetch` plus explicit per-vendor search tool wrappers.                                                                     |
| [Image generation](sources/imageGeneration/README.md) | Prompt-to-PNG on the configured Codex accounts, including edits from local paths or recent conversation images.                                 |
| [Gemini](sources/gemini/README.md)                    | Image and music generation and questions about local media files, on a Gemini key of its own.                                                   |
| [Git](sources/git/README.md)                          | Reading, probing, and watching repositories, and the worktree and clone actions the catalogs perform. No hooks, no tools.                       |

### Work

| Module                                            | What it adds                                                                                               |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [Goal](sources/goal/README.md)                    | One durable long-running objective per agent, kept moving until complete, blocked, paused, or cleared.     |
| [Tasks](sources/tasks/README.md)                  | A durable task list with dependencies, priority, ordering, and acyclicity validation.                      |
| [Scheduling](sources/scheduling/README.md)        | Durable waits an agent can take, and messages it asks to be delivered to itself later.                     |
| [Workflows](sources/workflows/README.md)          | Run a sandboxed Python script that orchestrates agents, and inspect, wait for, resume or cancel it.        |
| [Usage](sources/usage/README.md)                  | Advisory token and timing accounting for one agent and its tree, which never fails a turn.                 |
| [Provider usage](sources/providerUsage/README.md) | Memory-only vendor quota readings for every configured provider, refreshed independently every 15 minutes. |
| [Compactions](sources/compactions/README.md)      | Durable manual and automatic context-compaction lifecycle, run association, recovery, and measurements.    |

### People and other agents

| Module                                           | What it adds                                                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| [Abort](sources/abort/README.md)                 | Transactional subtree cancellation with one-shot compute notices and immediate process-tree hard kills. |
| [Collaboration](sources/collaboration/README.md) | Create collaborators and message them asynchronously, with a report to the creator when one stops.      |
| [User input](sources/userInput/README.md)        | Questions an agent asks a person, and a durable wait for the answer that survives a restart.            |
| [Presence](sources/presence/README.md)           | Configured versus effective availability, custom and temporary states, schedules, and status events.    |
| [Profile](sources/profile/README.md)             | The one person this installation belongs to, and the machine that may speak for them.                   |
| [Murmur](sources/murmur/README.md)               | Contacts over one Murmur identity, and the requests either side is waiting on.                          |

### Places and things

| Module                                     | What it adds                                                                                    |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| [Files](sources/files/README.md)           | Fast physical file trees, FFF-backed autocomplete, guarded writes, and live change events.      |
| [Projects](sources/projects/README.md)     | Repositories registered on demand, with bounded settings and durable rename and archival.       |
| [Workspaces](sources/workspaces/README.md) | Isolated worktrees cut from a project, created, inspected, and archived.                        |
| [Secrets](sources/secrets/README.md)       | Safe secret metadata and attachments; a value is resolved without ever showing it to the model. |
| [Terminals](sources/terminals/README.md)   | Real pseudo-terminals on a project or workspace folder, shared by everyone looking at it.       |

### Storage ownership

Modules owning tables through their own migrations: auto, collaboration, compactions, events, goal,
history, mcp, murmur, presence, profile, projects, scheduling, secrets, tasks, usage, user input,
workflows, and workspaces. The rest own none: abort, compute, config, files, gemini, git, image
generation, model switch, observation, permissions, search, skills, system prompt, and titles.
Compute uses per-agent and shared Agent KV, while system prompt and titles use Agent KV only;
terminals stores nothing anywhere because a terminal ends with the process behind it, and
collaboration's migrations exist only to retire the tables it used to keep.

Murmur owns three tables: a single row saying which person its identity belongs to, the key–value
table Murmur itself writes its cryptographic state into, and the authoritative public projection
plus its private recovery intents. They share a database so reset can stage a replacement first,
then atomically install its keys, binding, and public snapshot while enrollment and version
ordering survive restarts.

Migrations are immutable once released. A schema change is a new keyed migration, never an edit to
an existing one.

## Design rules

- Runtime validation is TypeBox, with TypeScript types derived through `Static`. No parallel
  hand-written interfaces or predicates.
- A mutating tool is durable when its whole effect fits one database transaction, and explicitly
  non-durable when it crosses an external boundary that cannot commit atomically — a filesystem
  write, a process, a network delivery. Each module README says which of its tools are which and
  why.
- Every model-facing list, log, summary, and artifact has explicit item and character bounds, and
  says in its own result when it truncated something.
- Reads are bounded at the storage boundary, not at format time.
- Cross-agent access is denied by default.
- Provider-specific behavior lives in its own complete tool definition. Common tools are shared
  without capability detection or provider-key branching.
- `@slopus/happy-agent-base` is consumed exactly as published. Modules never change or extend it.

## Development

```sh
pnpm --filter @slopus/happy-agent-modules check   # typecheck
pnpm --filter @slopus/happy-agent-modules test    # vitest
pnpm --filter @slopus/happy-agent-modules build   # tsc to dist/
```

Tests live in [`tests/`](./tests), mirroring the module folder names.
