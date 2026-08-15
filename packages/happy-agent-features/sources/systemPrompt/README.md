# System prompt

The instructions a model is written for. Coding models are trained differently, and each one is
told how to behave in its own words: Claude, Codex, and Grok were each shipped with a system
prompt tuned to how that vendor's model was trained. `SystemPromptFeature` is what puts the right
one in front of the model an agent is actually running, and keeps it right when the agent switches
models mid-conversation, because it reads the model from the scope it is handed on every
`instructions` call rather than deciding once at construction time.

```ts
import { Agent } from "@slopus/happy-agent-base";
import { SystemPromptFeature } from "@slopus/happy-agent-features";

const feature = new SystemPromptFeature({
    identity: { name: "Scout", prompt: "You are Scout, built by Happy" }, // optional
});
const agent = await Agent.create(ctx, { ...options, features: [feature] });
```

`identity` is optional; a feature built without one uses `DEFAULT_SYSTEM_PROMPT_IDENTITY`, which
names the agent Rig (`name: "Rig"`, `prompt: "You are Rig, built by Happy"`). `identity.name` must
be non-blank, at most 128 characters, and free of NULs, `\r`, `\n`, `{`, and `}`.
`identity.prompt` must be non-blank, at most 4,096 characters, free of NULs, and must not itself
contain a `{{identity}}` or `{{name}}` marker, so a host cannot leave an unresolved template or
smuggle another substitution through its own text. The constructor validates both the outer
options object and the identity against their TypeBox schemas and throws
`"System prompt feature options are invalid."` if either fails; it also deep-clones and freezes
the identity it is given, so later mutation of the object the host passed in has no effect.

## Prompt selection

Selection is driven by `AgentFeatureScope.agent.model` and `AgentFeatureScope.agent.providerKind`,
read fresh on every `instructions(ctx, scope)` call, in this order (`impl/systemPromptForModel.ts`):

1. **Model** — if the model ID is an exact key in `promptsByModel`, that model's own prompt wins.
   Today that covers `anthropic/opus-5`, `anthropic/sonnet-5`, `anthropic/fable-5`, and
   `anthropic/opus-4-8`.
2. **Family** — otherwise, the model ID's prefix names its vendor even when the serving provider
   does not (a Claude model served through Bedrock is still a Claude model): `anthropic/` →
   `claude`, `openai/` → `codex`, `xai/` → `grok`. That vendor's prompt is used.
3. **Provider kind** — if the model is absent or its prefix is unrecognized, `providerKind` is
   consulted as a fallback only; it is never allowed to override a known model family. A
   `providerKind` of `"claude"`, `"codex"`, or `"grok"` gets that vendor's prompt.
4. **Fallback** — anything else (`providerKind` of `"bedrock"` or `"gym"`, an unrecognized model
   with no matching `providerKind`, or no model and no `providerKind` at all) gets
   `simple_system_prompt`, so there is always a prompt.

Every prompt is exposed publicly through `SystemPromptFeature.promptFor(selection)`, which validates
`selection` against `systemPromptSelectionSchema` (`model` is a string of at most 256 characters
with no NUL/CR/LF, or `undefined`; `providerKind` is one of `"bedrock" | "claude" | "codex" |
"grok" | "gym"`) before delegating to `systemPromptForModel`.

Every prompt carries a `{{identity}}` marker, and the Codex prompt additionally carries `{{name}}`
markers. `promptFor` replaces every `{{name}}` occurrence with `identity.name.trim()` and the
first `{{identity}}` occurrence with `identity.prompt.trim()`, then checks the UTF-8 byte length of
the result against `MAX_SYSTEM_PROMPT_OUTPUT_BYTES` (1,000,000 bytes), throwing `"The system
prompt exceeds the configured output bound."` if it is over. Substitution is literal string
replacement (`replaceAll`/`replace` with a function argument), so an identity containing
replacement-string metacharacters such as `$&` is inserted as written rather than interpreted.

The prompt source files themselves live under `prompts/`, one per vendor directory: `claude/`
(`claude_opus_5_system_prompt.ts`, `claude_sonnet_5_system_prompt.ts`,
`claude_fable_5_system_prompt.ts`, `claude_opus_4_8_system_prompt.ts`), `codex/`
(`codex_agent_instructions.ts`), `grok/` (`grok_4_5_system_prompt.ts`), and `simple/`
(`simple_system_prompt.ts`), which is the fallback and is documented in its own source as adapted
from Pi's prompt. All but the Codex prompt are built with `impl/trimIndent.ts`, which strips a
template literal's common leading indentation and its first and last blank lines so the prompts can
be written indented in source without that indentation leaking into the model-facing text.

## Tools it provides to the model

None. The feature contributes no tools; it installs one hook, `instructions`, which
`@slopus/happy-agent-base` calls to obtain the agent's system prompt text for the model in force.
The feature holds no state and takes no lock, so any number of agents may ask at once.

## External functions

- `new SystemPromptFeature(options?: SystemPromptFeatureOptions)` — constructs the feature; throws
  on invalid options as described above.
- `SystemPromptFeature.promptFor(selection: SystemPromptSelection): string` — the public,
  model-neutral way to render a prompt for an arbitrary `{ model, providerKind }` selection,
  including identity substitution and the output-size bound.
- `SystemPromptFeature.instructions: (ctx: Context, scope: AgentFeatureScope) => string` — the
  `AgentFeature` hook Agent Base invokes each turn; it builds a `SystemPromptSelection` from
  `scope.agent.model` and `scope.agent.providerKind` and calls `promptFor`.
- `systemPromptForModel(selection: SystemPromptSelection): string` — the standalone selector
  function used internally by `promptFor`, exported from `sources/index.ts` for callers that want
  the raw, unsubstituted prompt text for a model without constructing a feature.

No events or listeners are exposed; every call above is synchronous and stateless.

## Storage

Nothing is persisted. The feature reads only what the agent scope hands it on each call
(`scope.agent.model`, `scope.agent.providerKind`) and the identity it was constructed with, which
lives in a private, frozen, in-memory field (`#identity`) for the lifetime of the `SystemPromptFeature`
instance. There is no store, no key, and no value shape to document; switching an agent's model
takes effect on the very next `instructions` call because the feature never caches a previous
answer.
