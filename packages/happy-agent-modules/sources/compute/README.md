# Compute

A machine to work on. An agent that can only talk cannot build anything, so this module gives it
one: a filesystem to read and change, and a shell to run commands in. It offers that machine as
**each vendor's own tools** — Claude's `Read`/`Write`/`Edit`/`Bash`, Codex's `exec_command` and
`apply_patch`, Grok's `read_file`/`write`/`run_terminal_command` — rather than one provider-neutral
surface, so a model sees the tool names, argument names, and escalation syntax it was trained on.

```ts
import { AgentSystemLocal } from "@slopus/happy-agent-base";
import {
    ComputeModule,
    SecretsModule,
    SystemPromptModule,
    createComputeModules,
} from "@slopus/happy-agent-modules";

const secrets = new SecretsModule();
const created = createComputeModules(new ComputeModule(config, secrets));
const systemPrompt = new SystemPromptModule({ compute: created.computeModule });
const system = await AgentSystemLocal.create(ctx, storage, {
    ...systemOptions,
    modules: [secrets, systemPrompt, ...created.modules],
});
const agent = await system.create(ctx, {
    modules: {
        compute: {
            cwd: projectDirectory,
            providerId: "host", // Optional: host is the default.
        },
    },
});
```

`createComputeModules` pairs the one `ComputeModule` with the `SkillsModule` that reads its
machines, as the set the whole agent system installs. `ComputeModule` takes `ConfigModule` and
`SecretsModule`. It derives its host policy — the agent's private directories, the project files a
write must be reviewed for — from configuration, and resolves selected attached secret bundles
through the secrets module immediately before spawning a command. It creates the published host
compute around a process manager it retains for the agent's whole machine lifetime. Retaining that
manager is what lets abort signal every process group directly, including a detached tree whose
launching shell already exited.
`ComputeModule.withProvider(config, secrets, provider)` is the one alternate construction, for a
test or a deployment that genuinely swaps how a machine is created. The first time a configured
agent needs compute, it creates a separate host compute for that agent, caches it by agent ID, and
gives that exact instance to the compute tools and skills discovery. A host injects the same
`ComputeModule` into `SystemPromptModule` for AGENTS.md discovery. This package depends on
`@slopus/happy-agent-compute@0.1.9` and uses its `Compute`, `ComputeFileSystem`, and `ComputeShell`
types directly; it does not maintain a second filesystem or process contract. Docker and
just-bash compute creation remain owned by that package and are not selected by this module's host
integration.

One `ComputeModule` instance serves every agent in a collection, but machines are not shared:
every configured agent gets its own cached compute and its own file-read log.

Every filesystem and shell operation receives the Agent Base permission mode from its current
context as an immutable `ComputePermissions` value. The published compute backend remains
responsible for host policy, symlink checks, and native sandbox enforcement.

## Which surface an agent gets

`computeToolVendor` (`ComputeToolVendor.ts`) answers that from the agent itself. It reads
`scope.agent.model` through `providerModelFamily` from `@slopus/happy-providers`, so
`anthropic/opus-5` is Claude, `openai/gpt-5.6-sol` is Codex, and `xai/grok-4.5` is Grok — whichever
provider happens to be serving that model. A Claude model served over Bedrock still gets Claude's
tools. Only when the model says nothing does it fall back to `scope.agent.providerKind`, and only
when that says nothing either does it default to Codex.

`assembleComputeTools` (`tools/assembleComputeTools.ts`) then switches exhaustively over the vendor
and builds that vendor's array. `instructions()` picks its text the same way: each vendor's rules
are written in terms of that vendor's own tool names, since instructions that name `write_file` to
a model holding `Write` are worse than no instructions at all.

## The vendor surfaces

Each directory under `tools/` has its own README describing every tool it ships.

| Vendor | Tools                                                                                                                                                                  | Details                                              |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Claude | `BashOutput`, `Bash`, `Read`, `Edit`, `Write`, `Glob`, `Grep`, `BashStop`, `BashInput`                                                                                 | [`tools/claude/README.md`](./tools/claude/README.md) |
| Codex  | `exec_command`, `write_stdin`, `kill_session`, `apply_patch`, `view_image`                                                                                             | [`tools/codex/README.md`](./tools/codex/README.md)   |
| Grok   | `run_terminal_command`, `read_file`, `write`, `search_replace`, `list_dir`, `grep`, `get_command_or_subagent_output`, `kill_command_or_subagent`, `send_command_input` | [`tools/grok/README.md`](./tools/grok/README.md)     |

The vendor descriptors under `packages/happy-providers/sources/vendors/*/tools/` are the truth these
surfaces are matched against — names, argument names, defaults, and the wording models were trained
on. Three departures from that truth are deliberate:

- **Claude's `Task*` tools are `Bash*` here.** The descriptors define one `TaskOutput`/`TaskInput`/
  `TaskStop` family covering "a background shell task, agent, or workflow" — one handle for three
  unrelated kinds of work. This module owns only the shell, so it ships that half under its own
  names, taking `bash_id`, describing only shells. Agents and workflows are other modules' work and
  name their own handles.
- **`secrets` is a Happy Agent extension.** Every vendor's shell command accepts an optional array
  of secret IDs from the shared installation catalog that are attached to the current agent. The
  default host compute resolves those IDs at command start and exposes their values only as
  environment variables in that process. Omitted or empty means none. Any
  attached secret environment-variable name is removed case-insensitively from the ambient
  environment before selected values are added, so an unselected bundle cannot leak in by ambient
  inheritance. Selecting a bundle is reviewed but does not leave the sandbox. The vendor's explicit
  escalation argument is a separate permission choice: secrets and Full access may each be used
  alone or together. Later input to a secret-bearing background command is reviewed and continues
  under the process's existing boundary.
- **`apply_patch` takes JSON.** Codex's real `apply_patch` is a freeform tool whose whole argument
  string is the patch. Agent Base parses every tool call's arguments as JSON before a tool sees
  them (`AgentBase.ts`) and exposes no argument-parse hook, and `happy-agent-base` is frozen, so
  this `apply_patch` is an ordinary JSON tool taking `{ patch, workdir? }`. Its description says so
  plainly instead of repeating the vendor's "do not wrap in JSON" sentence.

## What every surface shares

The vendors differ in names and shapes, not in what the machine does. Every tool is a thin
vendor-shaped skin over one shared helper in `impl/`, so behavior cannot drift between surfaces:

- `readComputeTextFile`, `listComputeDirectory`, `findComputeFiles`, `searchComputeFileContents` —
  paged, size-bounded reads that report their own truncation.
- `writeComputeTextFile`, `editComputeText`, `deleteComputeFile`, `moveComputeFile` — the write
  path, each checking remembered freshness unless a caller proves current contents another way.
- `startComputeCommand`, `readComputeCommand`, `writeComputeCommandInput`, `stopComputeCommand` —
  the command lifecycle, including the background grace period and delta-only reads.
- `shouldReviewComputePath`, `canonicalComputePath`, `boundOutputText` — permission and bounding
  mechanics. `FileReadLog` is shared beyond this module and lives in the package's `sources/impl/`.

A vendor tool's own `impl/` directory holds only what is genuinely that vendor's: parsing Claude's
shell IDs, Codex's patch format, Grok's task IDs. Nothing there is shared across vendors.

## Principles

Two rules govern every file tool and are stated to the model directly in `instructions()`, in that
vendor's vocabulary, since tool descriptions alone cannot carry them:

- **Unremembered files may be changed; remembered files must still be current.** `FileReadLog`
  remembers, per agent, which files it has read or written and at what `mtimeMs`. With no entry, a
  write proceeds. With an entry, a change refuses a different timestamp rather than silently
  discarding work saved after the agent last saw the file.
- **A command that outlives its wait is not killed.** It keeps running under an ID, and every later
  read of it returns only what is new since the last read.

Codex's patch context is its own freshness proof. An update or move whose hunks quote current lines
does not also consult the remembered timestamp. An append-only hunk and a delete consult any
remembered timestamp, but proceed when no read-log entry exists. That is what the helpers'
`requireRead` option controls, and no other vendor turns it off.

Permissions are decided per path or per command, not per tool. `shouldReviewComputePath` resolves
the proposed path, checks it stays inside `compute.cwd`, and — following every symbolic link with
`canonicalComputePath` — checks it still stays inside once resolved; anything unresolved or leaving
the workspace is reviewed. Writes to `.git` control files and the root `happy.toml`, `mcp.toml`, or
`AGENTS_SECURITY.md` are reviewed even when they remain inside the workspace. The host compute
receives the reviewed Agent Base mode on the actual operation and applies its own configured host
policy. Shell commands take the opposite default — sandboxed unless the model explicitly asks to
leave, in that vendor's own syntax (`dangerouslyDisableSandbox` for Claude,
`sandbox_permissions: "require_escalated"` for Codex and Grok) — since an ordinary command is the
common case and a reviewer has nothing useful to weigh over it.

Every read tool returns paged, size-bounded results and states, in its own `truncated` and count
fields, when more exists than was shown, rather than letting a short answer be read as a complete
one. `boundOutputText` is the shared mechanism: it cuts text to a character budget and always
leaves a note behind saying how much was left out, keeping the head for a file (read from the
top) and the tail for a command (whose newest lines say how it went).

## External functions

`ComputeModule` (`ComputeModule.ts`) implements `AgentModule`:

- `constructor(config: ConfigModule, secrets: SecretsModule)` — takes the configuration it derives
  its host policy from and the secret catalog it resolves command attachments through.
- `static withProvider(config, secrets, provider)` — the same module over a caller-supplied host
  provider. Alternate providers receive selected secret IDs and own their environment integration.
- `readonly name = "compute"`.
- `hostPolicy` — the private directories and protected project files this installation's
  configuration asks for, which is what every machine it creates is created behind.
- `resolve(ctx, agentId)` — validates `AgentConfig.modules.compute`, creates once, and returns the
  exact cached compute for that agent.
- `instructions(ctx, scope)` and `tools(ctx, scope)` — return nothing when the agent has no
  compute configuration; otherwise they use its cached compute and the vendor its model selects.
- `runningCommands(agentId)` — lists commands on one agent's already-resolved compute.
- `readCommand(agentId, commandId)` — reads a
  command's state and output without consuming it (`peek: true`), so a person watching does not
  take output the model has not been given yet.
- `stopCommand(agentId, commandId)` — stops a command by hand; answers whether
  there was one still running to stop. These two together are how a module that tightens an
  agent's permission mode ends what is still running under the wider one: it asks for the commands
  and asks for them to be stopped, rather than being handed a way to end them.
- `abortSnapshot(agentId)` — captures the live sessions and retained process-tree count used to
  write an abort notice.
- `recordAbortNotice(ctx, agentId)` — writes one validated one-shot notice to the agent's scope in
  Compute's shared KV inside the abort transaction. The instructions hook prepends it to the next
  inference, and the inference-start transaction consumes that exact notice without putting it in
  public history.
- `hardKillAgentProcesses(ctx, agentId)` — immediately marks public process records exited and
  sends `SIGKILL` to every retained operating-system process group. It advances an abort generation
  so a session whose spawn finishes across that boundary is killed as well.
- `reviewerTools(ctx, scope)` — the fixed read-only tool array the automatic permission reviewer
  investigates local state with, built for the vendor the reviewer's own model route selects. The
  reviewer's machine is one per installation, created in this installation's working folder on
  first use, cached here, and disposed with everything else; it is not any agent's, so it is never
  reachable through `resolve`. There is no writing tool in the array, and every reviewer send is
  `read_only`, so a review can look but never change the workspace.
- `permissionsForContext(ctx)`, `resolvePath(compute, path)`, `parentPath(path)`, `pathName(path)`,
  `shouldReviewPath(ctx, compute, path, { write })`, `describePathAction(compute, path, operation)`
  — the boundary a machine is worked through, for the modules that hold one. A sibling asks for
  these rather than reaching into `impl/`.
- `dispose(ctx)` — disposes every cached compute at host shutdown.

Also exported from the package: `computeToolVendor`, `computeToolSelectionSchema`,
`computeToolVendorSchema`, `assembleComputeTools`, and the three per-vendor assemblers
(`assembleClaudeComputeTools`, `assembleCodexComputeTools`, `assembleGrokComputeTools`) for a host
that needs one vendor's array directly.

Archiving one agent disposes only that agent's cached compute. An explicit abort keeps the compute
cached for later turns but hard-kills every process it owns; an ordinary settled or idle turn does
not dispose it.

## Storage

The module persists `FileReadLog` (`../impl/FileReadLog.ts`) in the per-agent `AgentKV` supplied
through `scope.kv`, and keeps every agent's one-shot abort notice in the one collection-wide
`scope.sharedKV` owned by Compute. It holds these keys:

- `"reads"` → an array of `{ path: string, mtimeMs: number }`, oldest first, validated against a
  TypeBox schema on read (`Value.Check`); anything that fails validation, such as a log written by
  an older version, is treated as empty and therefore places no restriction on an edit.
- `"abort-notices.<agent ID>.pending"` in shared KV → the validated process-tree count and bounded
  live-session descriptions from the most recent abort that killed something. It is overwritten
  by a newer abort, prepended by the instructions hook, and deleted in the transaction that starts
  that inference. Creation and archival also clear that identity's scope so a reused ID cannot
  inherit an old notice.

`record(ctx, path, mtimeMs)` removes any existing entry for `path`, appends the new one, and keeps
only the most recent 512 entries (`MAX_REMEMBERED_READS`) — the log guards against changing stale
remembered state, not a transcript, so only recently-observed files are worth keeping.
The Agent Database's owned-operation boundary keeps the `AgentKV.update` read-decide-write step
together without opening another SQL transaction, and an existing tool transaction is reused. The
database boundary is entered before the module's keyed lock serializes concurrent updates for the
same agent. Keeping that order avoids a cycle between a transactional file read and a
nontransactional edit recording its new state. A custom store without the production database
boundary falls back to an `AgentKV.transaction` with the same order. File mutations themselves are
not serialized per path: frozen Agent Base exposes no tool lock, and this module does not add a
module-level heap lock. Concurrent edits to one path remain future host-coordination debt.
The log belongs to the agent's conversation rather than to a single run, so a write interrupted by
a restart can simply be retried — the file it left behind is already the state this agent recorded.

Command state itself is not persisted by this module at all: a running command's output, status,
and delta cursor live in the compute's own `ComputeShell`, which is the host's to keep or drop when
it disposes the compute.
