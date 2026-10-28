# Accounts, models, effort, and service tier

Use this recipe when the user wants to add or pool provider accounts, limit or change models, set
the default effort or service tier, or move existing sessions to another provider. To run Claude Code, Codex CLI, Antigravity, OpenCode, or another ACP agent itself on these
accounts, add a [harness](harnesses.md). Everything here
is machine configuration in the user `happy.toml`. [Configuration](../configuration.md) is the
reference.

## Before editing

1. The file is `~/Happy/Config/happy.toml` (macOS), `~/happy/config/happy.toml` (Linux), or
   `%USERPROFILE%\happy\config\happy.toml` (Windows). It is
   outside the workspace, so writes need reviewed full access.
2. Read it with credentials redacted:

    ```sh
    happy_config="<resolved happy.toml path from step 1>"
    sed -E 's/^([[:space:]]*(oauth_token|api_key)[[:space:]]*=).*/\1 "<redacted>"/' "$happy_config"
    ```

3. Back it up: `cp -p happy.toml happy.toml.bak-<timestamp>`.
4. Never print, copy, or send credentials, and never copy them between accounts or machines.

## Accounts

Each extra account is a `[providers.<id>]` table with a `type` and optional friendly `name`.
Built-in `claude`, `codex`, and `grok` default to **Current CLI**; other accounts without a name
use a readable version of the ID. Configuration, defaults, and pools continue to use the IDs.

Use the person's explicitly requested label verbatim. When proposing a name, prefer a
recognizable email-style label, such as `alex@example.com`, `alex@acme`, or
`alex.work@example.com`. Keep the username and domain details that distinguish the accounts;
avoid overly short aliases. Omit redundant vendor or plan prefixes and suffixes: provider groups
already supply that context. This is guidance for choosing a name. The product displays explicit
names verbatim; it never shortens emails or appends plan names automatically.

| Vendor            | Settings                                                          | How the user gets the credential                                                                     |
| ----------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Claude            | `type = "claude"`, `oauth_token`                                  | `claude setup-token` while signed in to that account; the user pastes it into the file.              |
| Codex             | `type = "codex"`, `auth_file`                                     | Sign in with a separate home, e.g. `CODEX_HOME=~/.codex-work codex login`; point at its `auth.json`. |
| Grok              | `type = "grok"`, `auth_file`                                      | That account's Grok auth file.                                                                       |
| Bedrock           | `type = "bedrock"`, `profile`, `region`                           | An AWS profile for that account.                                                                     |
| OpenAI-compatible | `type = "openai_compatible"`, `base_url`, `api_key_env`, `models` | An API key from the vendor, exported in the daemon environment. See below.                           |

**Add an OpenAI-compatible vendor** (OpenRouter, Together, Fireworks, DeepSeek, vLLM, LM Studio)
with one table, filling `models` with the vendor's exact model IDs:

```toml
[providers.openrouter]
type = "openai_compatible"
name = "OpenRouter"
enabled = true
base_url = "https://openrouter.ai/api/v1"
api_key_env = "OPENROUTER_API_KEY"
models = ["deepseek/deepseek-v4.1-flash-1017"]
reasoning_field = "reasoning"

[providers.openrouter.request]
reasoning = { enabled = true }
```

- Keep the key out of the file: put it in the variable `api_key_env` names, and reload the daemon
  from a shell that has it. Never paste the key into `happy.toml`, a commit, or a message.
- Only list chat models that support tool calling. Check the vendor's model page first. On
  OpenRouter, `supported_parameters` must include `tools`.
- Context window, image input, and efforts come from the vendor's `/models` in the background.
  Override any of them under `[providers.<id>.model_overrides."<model>"]`. The
  [reference](../configuration.md#openai-compatible-endpoints) lists every setting.
- To verify, check that `GET /v0/config` lists the models under the new provider, then run one turn
  that uses a tool.

**Pool** same-type accounts behind a smart provider and hide the members:

```toml
[providers.claude]
hidden = true

[providers.claude_work]
type = "claude"
enabled = true
hidden = true
oauth_token = "<from claude setup-token>"

[providers.claude_pool]
type = "smart"
strategy = "round_robin"
providers = ["claude", "claude_work"]
enabled = true
```

| Round robin                    | Behavior                                                                |
| ------------------------------ | ----------------------------------------------------------------------- |
| New agent or subagent          | Starts on a random member.                                              |
| Later turns                    | Stay on that member.                                                    |
| Auth or quota-exhaustion error | Moves to the next member.                                               |
| Every member failed            | Names a member that needs sign-in first, else the earliest usage reset. |
| Failure after output started   | Not replayed on another account.                                        |
| Not supported                  | Weights, usage-aware or priority routing, time windows, editing pools.  |

| Setting           | Effect                                                |
| ----------------- | ----------------------------------------------------- |
| `hidden = true`   | Left out of model pickers; still routed to by a pool. |
| `enabled = false` | Off entirely, including routing through pools.        |
| Delete the table  | Removes the account.                                  |

- Sessions already on a hidden provider keep working. Move them to the pool with
  [Switching existing sessions](#switching-existing-sessions) if they should rotate, and update
  `defaults.provider` if it names a hidden account.
- A hidden account that no pool lists goes unused.
- Pools combine only same-type accounts, and Bedrock only within one region; other members are
  skipped silently.

## Models

| Setting                                              | Where              | Effect                                                           |
| ---------------------------------------------------- | ------------------ | ---------------------------------------------------------------- |
| `include_models`, `exclude_models`                   | `[providers.<id>]` | Which models this account offers anywhere, including the picker. |
| `include_subagent_models`, `exclude_subagent_models` | `[providers.<id>]` | Narrows only the models offered for new subagents.               |
| `provider`, `model`                                  | `[defaults]`       | Default provider ID and model ID for new sessions.               |

- Filters take exact Happy Agent model IDs, such as `openai/gpt-5.6-sol`. Exclusion wins.
- GPT-6 Sol on Codex is opt-in now that GPT-6.1 Sol replaces it. Sessions already on it keep
  working, but it never becomes the default and is not offered to the phone or new subagents.
  To offer it again, list it in that account's `include_models` beside every other model it
  should offer, such as
  `include_models = ["openai/gpt-6.1-sol", "openai/gpt-6.1-terra", "openai/gpt-6-astra", "openai/gpt-6-sol", "openai/gpt-6-luna"]`.
  A pool offers it when the pool or one of its members lists it. Bedrock still offers it.
- Pools respect member filters: a model only some members offer routes only to those.
- `defaults.provider` may name a pool.

## Effort

Set `effort` under `[defaults]`, such as `effort = "medium"`. Use a level the model allows; the
allowed levels are listed per model in `GET /v0/config`.

## Service tier

| Where                        | Setting                                                 |
| ---------------------------- | ------------------------------------------------------- |
| `[defaults]`                 | `service_tier = "default"`, `"fast"`, or `"ultrafast"`. |
| Terminal                     | `/fast` toggles the fast tier for the session.          |
| New subagents and workspaces | `service_tier: "priority"` on the creation tool.        |

- A tier applies only when the selected account and model support it. `GET /v0/config` lists each
  model's supported tiers per provider.
- Fast inference uses twice the plan usage.

## Switching existing sessions

1. `GET /v0/agents/:agentId/mode` to read the last submitted mode.
2. `PUT /v0/agents/:agentId/draft` with that mode, changing only `providerId`, and keep the draft
   text the user already has.
3. The agent's next message runs on the new provider.

Keeping the same model on a same-type account or pool is a compatible switch and keeps the
conversation. An incompatible switch starts a fresh model context with a handoff note.

## Apply and verify

1. Parse the file with a TOML parser, such as Python 3.11's `tomllib`, and check that every pool
   member exists. If it fails, fix the file or restore the backup.
2. Apply the change as described in
   [Applying configuration changes](../configuration.md#applying-configuration-changes).
3. Check that `GET /v0/config` or the model picker shows the pool or new account and not the hidden
   members, that defaults resolve, and that switched sessions run a turn.
