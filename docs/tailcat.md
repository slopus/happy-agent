# Tailcat internet exposure

Happy Agent release binaries embed Tailcat v0.4.0 so a standalone or team daemon can be reached
from another machine through an encrypted, NAT-traversing Tailcat connection.

Tailcat is its own account-free transport. Despite living in the `tailscale/tailcat` GitHub
repository, using it does not require the Tailscale app, a Tailscale account, a tailnet, or
Tailscale access controls. Happy Agent does not add a Tailcat login or client allowlist either.
Anyone who knows the unguessable Tailcat address can reach the Happy Agent authentication boundary.
They cannot pass that boundary without the appropriate Happy Agent credential.

| Happy Agent mode | Local API wrapped by Tailcat | Required Happy Agent credential |
| ---------------- | ---------------------------- | ------------------------------- |
| Standalone       | Owner-only Unix socket       | Local bearer token              |
| Team             | Configured HTTP listener     | WorkOS access token             |

## Enable Tailcat

There are two ways to enable it.

To enable it before startup, add this to the machine-wide `happy.toml`, then start or restart Happy
Agent:

```toml
[feature.tailcat]
enabled = true
port = 24779
```

The configuration file is `~/Happy/Config/happy.toml` on macOS and
`~/happy/config/happy.toml` on Linux unless the configuration directory was overridden. A
repository's `happy.toml` cannot enable Tailcat.

`port` defaults to the fixed, IANA-unassigned port `24779`. Override it with any nonzero TCP port
when the default conflicts with another local service. Happy Agent binds the configured loopback
port exactly and never substitutes a random one, so both the Tailcat address and port remain stable
for another node's configuration. Changing the port requires restarting the daemon.

To change it while the daemon is running, ask the active admin bot—initially the built-in Chief of
Staff—to enable or disable Tailcat. Admin bots receive these tools:

- `set_tailcat_enabled` persists the requested state and opens or closes the connection
  immediately.
- `get_tailcat_status` reports `disabled`, `starting`, `open`, `stopping`, or `failed`; an open
  result includes the address and forwarded port.

The tools are intentionally absent from ordinary bots, archived admin bots, human-owned root
agents, and subagents. Changing the setting through the admin tool writes the daemon-owned
`~/.happy/agent/runtime.toml`. That runtime value takes precedence over the default in global
`happy.toml` on later starts until an admin bot changes it again.

Enabling Tailcat is an internet-exposure action. In Auto permission mode, Happy Agent reviews the
exact enable or disable operation before the admin bot's tool runs.

## Stable identity and process lifetime

On first enablement, Happy Agent generates
`~/.happy/agent/tailcat/default.private.json`. It reuses that private key so the Tailcat address
stays stable across daemon restarts and disable/enable cycles. The configured Tailcat port is fixed
across those cycles too. Do not copy or share the private key.

Happy Agent starts Tailcat after its local API transport has bound and keeps Tailcat open until it
is disabled or the daemon stops. If the Tailcat process exits unexpectedly, Happy Agent supervises
and restarts it with the same identity.

An unexpected failure changes its status to `failed` and includes a human-readable error. It does
not silently turn off the persisted setting.

## Read and share the endpoint

Ask an active admin bot for Tailcat status. When it reports `open`, share its `address` and `port`
with the intended client through a private channel.

The same live values are available on the server machine:

```sh
cat ~/.happy/agent/tailcat/address
cat ~/.happy/agent/tailcat/port
```

Those two files exist only while Tailcat is open. Disabling Tailcat or stopping Happy Agent removes
them but keeps `default.private.json`, preserving the identity for the next start.

## Install the remote client

Install Tailcat v0.4.0 from the
[upstream Tailcat releases](https://github.com/tailscale/tailcat/releases) on the remote machine.
The Happy Agent release binary contains the server-side executable; it does not install a
`tailcat` command on other machines.

The embedded executable is specific to standalone Happy Agent release binaries. A source checkout
or the Node-compatible npm package instead resolves `tailcat` from `PATH`; development runs may set
`HAPPY_AGENT_TAILCAT_PATH` to an explicit executable.

## Connect to a standalone daemon

In standalone mode, securely transfer these three values to the intended client:

- the Tailcat `address`;
- the fixed forwarded `port`;
- the local Happy Agent bearer token from `~/.happy/agent/token`.

Never publish the token or store it in a shared shell history. A one-command health request through
Tailcat looks like this:

```sh
TAILCAT_ADDRESS="tc..."
TAILCAT_PORT="24779"
HAPPY_TOKEN="..."

tailcat socks "$TAILCAT_ADDRESS" curl \
  -H "Authorization: Bearer $HAPPY_TOKEN" \
  "http://server.tailcat:$TAILCAT_PORT/v0/health"
```

Replace the example values with those transferred from the server. `server.tailcat` is the default
host name inside the Tailcat connection.

For a persistent local SOCKS5 listener, provide a local port instead of a command:

```sh
tailcat socks "$TAILCAT_ADDRESS" 1080
```

Then point a proxy-aware client at it and let the proxy resolve `server.tailcat`:

```sh
curl \
  --socks5-hostname 127.0.0.1:1080 \
  -H "Authorization: Bearer $HAPPY_TOKEN" \
  "http://server.tailcat:$TAILCAT_PORT/v0/health"
```

## Connect to a team daemon

Tailcat can wrap the team HTTP listener as well. Use the same Tailcat address and port, but send a
valid WorkOS access token for the configured client and organization instead of a standalone
token:

```sh
tailcat socks "$TAILCAT_ADDRESS" curl \
  -H "Authorization: Bearer $HAPPY_ACCESS_TOKEN" \
  "http://server.tailcat:$TAILCAT_PORT/v0/health"
```

When Tailcat should be the team server's only network path, bind the team listener to loopback:

```toml
[feature.team]
enabled = true
host = "127.0.0.1"
port = 3000
workos_organization_id = "org_01EXAMPLE"
owner_workos_user_id = "user_01EXAMPLE"

[feature.tailcat]
enabled = true
```

Happy Agent relays Tailcat traffic to the loopback listener without exposing the team server on a
LAN interface. Tailcat supplies only the transport; every API request, including health, still
passes through team mode's WorkOS authentication and onboarding rules.

To advertise this connection through Happy Cloud, combine the stable connection address and fixed
configured port into one discovery URL:

```sh
TAILCAT_ADDRESS="$(cat ~/.happy/agent/tailcat/address)"
TAILCAT_PORT="$(cat ~/.happy/agent/tailcat/port)"
printf 'tailcat://%s:%s\n' "$TAILCAT_ADDRESS" "$TAILCAT_PORT"
```

Pass that value as `endpoint` to `create_happy_team`, or use `update_happy_team` with an existing
`team_id`. Both values survive restarts. If the default port conflicts during initial deployment,
override `[feature.tailcat].port` before registering the team; changing it after registration
requires publishing the new endpoint with `update_happy_team`. See [team-mode.md](team-mode.md) for
the complete binary deployment and organization bootstrap sequence.

## Disable Tailcat

Ask an active admin bot to disable Tailcat. `set_tailcat_enabled` closes the live connection,
removes the `address` and `port` files, and persists `enabled = false` in `runtime.toml`. The stable
private key remains so enabling it later restores the same Tailcat identity.

If no admin bot is available, set `[feature.tailcat] enabled = false` in global `happy.toml`, remove
the conflicting Tailcat override from the daemon-owned `runtime.toml`, and restart Happy Agent.
Normally the admin tool should own runtime changes; do not edit `runtime.toml` while the daemon is
running.

## Troubleshooting

- If the status is `starting`, the local API transport may not have finished binding yet. Check it
  again after the daemon is ready.
- If the status is `failed`, read the returned error and `~/.happy/agent/daemon.log`. Fix the cause,
  then disable and re-enable Tailcat to reconcile it immediately.
- If port `24779` is already in use, choose another fixed `port` under `[feature.tailcat]`, restart
  the daemon, and use that same port in the remote-node configuration.
- If `address` or `port` is missing, Tailcat is not currently open. Ask an active admin bot for the
  authoritative status rather than relying only on files.
- Resolve `server.tailcat` through Tailcat. For a local SOCKS listener, use SOCKS5 hostname
  resolution such as curl's `--socks5-hostname` option.
- A Tailcat connection followed by `401 Unauthorized` means the transport works but the Happy
  Agent credential is absent, expired, or invalid for that deployment.
- Tailcat requires outbound internet access from both machines. Check local firewalls and the
  daemon log when the connection cannot be established.

See [team-mode.md](team-mode.md) for WorkOS onboarding and the complete behavior of a multi-user
server, and [configuration.md](configuration.md) for all machine-wide settings.
