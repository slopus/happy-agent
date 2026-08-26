# System prompt

`SystemPromptModule` owns the shared instruction foundation for an agent. It selects the native
prompt for the model in force, substitutes Happy Agent's own runtime identity, appends truthful
host environment details, and supplies the global, security, and project `AGENTS.md` instruction
chain. Feature modules may append their own scoped instructions after this foundation; for
example, the bots module adds a bot's persistent identity only to that bot's agent.

```text
vendor/model prompt
        │
        ├── # Environment (when Agent Base carries one)
        │
        └── AGENTS.md specification
              ├── global AGENTS.md
              ├── project-root AGENTS_SECURITY.md
              └── project AGENTS.md files, Git root → working directory
```

```ts
const created = createComputeModules(new ComputeModule(config));
const systemPrompt = new SystemPromptModule(config, created.computeModule);
```

The constructor takes modules and nothing else. Configuration owns the model catalog and the
person's global `AGENTS.md`, and compute owns which machine an agent runs on, so neither a
catalog, an identity, a path, nor a reader callback is passed in.

There is one identity and it is Happy Agent's own (`DEFAULT_SYSTEM_PROMPT_IDENTITY`): an installation that
renamed itself would be telling the model it is something the rest of the product is not.
`systemPromptIdentitySchema` still describes that value — a non-blank name of at most 128
characters free of NULs, carriage returns, line feeds, `{`, and `}`, and a non-blank prompt of at
most 4,096 characters free of NULs and of the `{{identity}}` and `{{name}}` markers.

## Prompt selection and assembly

`promptFor(selection)` synchronously selects and renders the vendor prompt:

1. An exact model entry wins.
2. Otherwise a recognized model prefix (`anthropic/`, `openai/`, or `xai/`) selects its family.
3. Otherwise `providerKind` selects the Claude, Codex, or Grok family.
4. Everything else receives the simple fallback prompt.

The prompt sources live under `prompts/`; `impl/systemPromptForModel.ts` owns selection and
`impl/trimIndent.ts` keeps template indentation out of model-facing text. Identity replacement is
literal, so replacement-string metacharacters are not interpreted. `promptFor` replaces every
`{{name}}` marker with the trimmed identity name, but only the first `{{identity}}` marker with
the trimmed identity prompt, matching the legacy substitution order.

`instructions(ctx, scope)` is asynchronous because AGENTS.md files are discovered live. Its exact
order is the selected vendor prompt, the optional environment section, then the AGENTS.md
specification and documents. The environment contains working directory, platform, shell, OS
version, the current model and provider IDs, scratch-directory guidance, final-message visibility,
workspace/worktree guidance, the extracted Happy Agent documentation location, the `DESIGN.md`
rule for temporary pages and Happy-designed pages, and the model catalog `ConfigModule.models`
reports.

The catalog is read from configuration the first time the environment section is assembled and
kept from then on, so every agent sees the same routes for the life of the installation. It
accepts at most 1,000 routes, each with a non-empty name, model ID, and provider ID of at most 256
characters, and its rendered UTF-8 section is capped at 512,000 bytes. A catalog that breaks
either bound fails that assembly with a stable message —
`"System prompt available models are invalid."` or
`"System prompt available models exceed the configured UTF-8 byte bound."` — rather than at
construction, so a bad catalog cannot stop the agent from starting.

The complete UTF-8 output is capped by `MAX_SYSTEM_PROMPT_OUTPUT_BYTES`. AGENTS.md discovery caps
each document, total bytes, document count, paths, and rendered characters. Oversized instruction
documents become explicit bounded truncation records, and the final AGENTS.md instruction chain is
truncated again at assembly when its UTF-8 bytes would exceed the remaining system-prompt budget.
This keeps the live instruction chain from turning an otherwise valid turn into a permanent
output-bound failure.

## AGENTS.md discovery and changes

The compute module selects the current agent's machine, so one shared module instance can safely
serve agents in different workspaces. Discovery reads from the nearest Git root down to the compute
working directory. It refuses symbolic links at instruction document paths and reads through the
compute filesystem with the current permission context. `readAgentsMd(ctx, agentId)` exposes the
same validated snapshot to host callers, and works with no machine at all: an installation with
only global instructions still has instructions.

The person's own instructions come from `ConfigModule.readGlobalInstructions(ctx, maxBytes)` on
every inference, so editing that file reaches the next turn. Configuration owns the path and the
reading; this module owns the byte bound and checks what comes back, encoding only a bounded
prefix and dropping a code point split at the boundary. A missing, blank, or whitespace-only
document is no document at all.

`readAgentsMd` accepts agent IDs up to `MAX_AGENTS_MD_AGENT_ID_LENGTH`, rejects blank IDs and
control-line characters, and validates the ID before reading configuration or looking up a machine.

After first delivery, the module stores the last instruction fingerprint in its per-agent module
KV. If a document changes or disappears, `beforeTurn` also persists a pending transition with a
random notice ID, then emits one hidden durable steering notice. The ID remains stable while that
transition retries but changes when the same content or removal recurs later, so Agent Base's
permanent message-ID deduplication cannot suppress a later cycle.
`messageAcceptedTransact` advances the fingerprint and clears the pending transition only when
Agent Base durably accepts that exact hidden notice. `beforeTurn` also stores the validated
instruction snapshot in `runKV`; every inference in that turn uses that same snapshot. A file edit
after the turn boundary is therefore delivered coherently on the following turn rather than
mixing one notice version with another system-prompt version.

## Tools, storage, and concurrency

The module exposes no tools and owns no database or filesystem. Its durable Agent Base KV state is
the per-agent fingerprint plus any pending change notice. The module holds no tuning and takes no
lock, so any number of agents may ask at once; live per-agent values are resolved from `ctx`,
`scope`, KV, configuration, and compute on every call.

Public operations are:

- `promptFor(selection)` — render a vendor prompt with identity substitution.
- `instructions(ctx, scope)` — assemble the complete system prompt.
- `readAgentsMd(ctx, agentId)` — return the current validated instruction snapshot.
- `readAgentsMdInstructions(ctx, agentId)` — the same snapshot formatted for the automatic
  permission reviewer, without touching per-turn delivery state.
- `systemPromptForModel(selection)` — select the raw prompt template without constructing the
  module.
