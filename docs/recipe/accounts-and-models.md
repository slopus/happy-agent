# Accounts, models, effort, and service tier

Use this recipe when the user wants to add or pool provider accounts, limit or change models, set
the default effort or service tier, or move existing sessions to another provider. Everything here
is machine configuration in the user `happy.toml`. [Configuration](../configuration.md) is the
reference.

## Before editing

1. The file is `~/Happy/Config/happy.toml` (macOS) or `~/happy/config/happy.toml` (Linux). It is
   outside the workspace, so writes need reviewed full access.
2. Read it with credentials redacted:

    ```sh
    sed -E 's/^([[:space:]]*(oauth_token|api_key)[[:space:]]*=).*/\1 "<redacted>"/' ~/Happy/Config/happy.toml
    ```

3. Back it up: `cp -p happy.toml happy.toml.bak-<timestamp>`.
4. Never print, copy, or send credentials, and never copy them between accounts or machines.

## Accounts

Each extra account is a `[providers.<id>]` table with a `type`. The `<id>` is what the model picker
shows.

| Vendor  | Settings                                | How the user gets the credential                                                                     |
| ------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Claude  | `type = "claude"`, `oauth_token`        | `claude setup-token` while signed in to that account; the user pastes it into the file.              |
| Codex   | `type = "codex"`, `auth_file`           | Sign in with a separate home, e.g. `CODEX_HOME=~/.codex-work codex login`; point at its `auth.json`. |
| Grok    | `type = "grok"`, `auth_file`            | That account's Grok auth file.                                                                       |
| Bedrock | `type = "bedrock"`, `profile`, `region` | An AWS profile for that account.                                                                     |

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

| Round robin                    | Behavior                                                                     |
| ------------------------------ | ---------------------------------------------------------------------------- |
| New agent or subagent          | Starts on a random member.                                                   |
| Later turns                    | Stay on that member.                                                         |
| Auth or quota-exhaustion error | Moves to the next member.                                                    |
| Failure after output started   | Not replayed on another account.                                             |
| Not supported                  | Weights, usage-aware or priority routing, time windows, UI or API for pools. |

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
