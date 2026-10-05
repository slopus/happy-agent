# Add and pool provider accounts

Use this recipe when someone asks the Chief of Staff to add a second Claude, Codex, Grok, or
Bedrock account, or to pool their accounts. An extra account becomes a named provider instance in
the user `happy.toml`. A smart provider can then rotate between same-type accounts. The
[Providers](../configuration.md#providers) and
[Hiding providers](../configuration.md#hiding-providers) sections are the reference for every
setting used here.

## Inspect and back up

The file is `~/Happy/Config/happy.toml` on macOS and `~/happy/config/happy.toml` on Linux. Read
its `[providers]` and `[providers.*]` tables without printing credentials. Redact values before
showing them, for example:

```sh
sed -E 's/^([[:space:]]*(oauth_token|api_key)[[:space:]]*=).*/\1 "<redacted>"/' ~/Happy/Config/happy.toml
```

Note the provider IDs that already exist and which agents and `defaults.provider` use them. Before
editing, copy the file beside itself with its permissions intact, such as
`cp -p happy.toml happy.toml.bak-<timestamp>`. The file is outside the workspace, so writing it
needs reviewed full access.

## Add the account

Choose a short, descriptive ID such as `claude_work`. That ID is what the model picker shows.
Every custom instance sets `type`:

- **Claude:** `type = "claude"` with `oauth_token`. Signing in is interactive. Ask the user to run
  `claude setup-token` while signed in to the additional account. Ideally they paste the token into
  the file themselves rather than into chat.
- **Codex:** `type = "codex"` with `auth_file` pointing at that account's `auth.json`, for example
  one created by `CODEX_HOME=~/.codex-work codex login`.
- **Grok:** `type = "grok"` with `auth_file` pointing at that account's Grok auth file.
- **Bedrock:** `type = "bedrock"` with `profile` (an AWS profile) and `region`.

Keep any `include_models` or `exclude_models` the user wants on that account. Do not copy
credentials between accounts or from another machine.

## Optionally pool them

Add a smart provider that lists the accounts, and hide the members so new work goes through the
pool:

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

Round robin works like this:

- Each new agent, including subagents, starts on a random member.
- It stays on that member across turns.
- It moves to the next member only after an authentication or quota-exhaustion error.
- A failure after the model has started producing output is not replayed on another account.

Weights, usage-aware or priority routing, time windows, and any UI or API for pools are not
supported. Pools are configured only in `happy.toml`.

## Pitfalls

- Hiding an account stops agents and bots that are pinned to it from starting new turns. Switch
  them to the pool, and update `defaults.provider` if it names a hidden account.
- Per-account `include_models` and `exclude_models` still apply inside a pool. A model offered by
  only some accounts routes only to those.
- `hidden = true` only removes direct selection. `enabled = false` also stops routed inference.
- A hidden account that no pool lists goes unused.
- A pool combines only accounts of the same type, and Bedrock accounts only within the same
  region. Other members are silently skipped.

## Apply the change

Parse the edited file with a TOML parser, such as Python 3.11's `tomllib`. Check that every pool
member ID exists. A daemon cannot start with a file it cannot parse. If validation fails, fix the
file or restore the backup.

The daemon reads providers only at startup, and you cannot reload it from your own session. See
[Applying configuration changes](../configuration.md#applying-configuration-changes). Tell the user
that a reload drains running work and stops background terminals and services. Then ask them to
run `happy-terminal daemon reload` from a terminal outside Happy and to pick the pool (or the new
account) in the model picker afterward.

## Completion checks

- The backup exists, and no credential was printed or sent anywhere.
- The file parses, and every pool member exists and has the same type.
- After the user's reload, the pool or the new account appears in the model picker, and hidden
  accounts do not.
- Agents that were pinned to hidden accounts now use the pool or another visible provider.
