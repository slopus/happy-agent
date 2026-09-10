# Team deployment mode

Team mode runs one Happy Agent daemon for multiple members of one WorkOS organization. It keeps the
existing Happy Agent HTTP contract while changing the transport, authentication, and profile
storage behind it.

For the end-to-end setup sequence, use [Create and deploy a Happy team](recipe/deploy-happy-team.md).
It includes Happy Social sign-in, creating the named team, verifying a local connection, and asking
for invitation emails only after the deployment works. [Happy teams](happy-teams.md) explains the
account and membership model.

## Before you begin

You need:

- a Linux or macOS machine that can make outbound Internet connections;
- first-party Codex, Claude Code, Grok, or AWS credentials available to the service account for the
  models the team should run;
- a standalone Happy Agent connected to the intended owner's Happy Cloud account, with an active
  admin bot available to report that account's WorkOS configuration.

The management agent and deployed server may be different machines. Team-management tools are
available only on standalone installations because a team server's organization is fixed by its
deployment configuration.

Before managing teams, the user must authenticate through **Settings → Account → Join Happy
Social** and bind an email address. Any email address they can access works; a company domain is
not required. Complete any email verification requested by that flow.

Check `get_happy_workos_state` first: a successful result with the WorkOS user and client IDs
confirms login, so do not ask the user to confirm or repeat sign-in. Request the interactive flow
only if the tool reports missing or invalid authentication; permission and connectivity failures
are separate blockers.

The walkthrough below uses a dedicated Linux service account with `/var/lib/happy-agent` as its
home. That puts machine configuration at `/var/lib/happy-agent/happy/config/happy.toml` and private
daemon state at `/var/lib/happy-agent/.happy/agent`.

## 1. Install the release binary

Choose the released version and the matching `linux-x64` or `linux-arm64` target. Every release
contains a self-contained Happy Agent binary with the matching Tailcat v0.4.0 server executable
embedded in it.

```sh
VERSION="0.0.0"
TARGET="linux-x64"
ARCHIVE="happy-agent-$VERSION-$TARGET.tar.gz"
BASE_URL="https://github.com/slopus/happy-agent/releases/download/v$VERSION"

curl -fLO "$BASE_URL/$ARCHIVE"
curl -fLO "$BASE_URL/$ARCHIVE.sha256"
sha256sum --check "$ARCHIVE.sha256"
tar -xzf "$ARCHIVE"
sudo install -m 0755 "happy-agent-$TARGET" /usr/local/bin/happy-agent
happy-agent --version
```

Replace `0.0.0` with an actual released version. macOS uses `darwin-arm64` or `darwin-x64` and can
verify the checksum with `shasum -a 256 -c "$ARCHIVE.sha256"`.

On Ubuntu 24.04, complete the administrator-approved
[AppArmor namespace allowance](permissions-and-sandbox.md#ubuntu-apparmor-host-prerequisite)
for the trusted daemon executable before starting the service. Keep the system-wide restriction
and Happy's sandbox enabled; the team's HTTP health check alone does not test shell startup.

Create the service account and its configuration folder:

```sh
sudo useradd --system --create-home --home-dir /var/lib/happy-agent \
  --shell /usr/sbin/nologin happy-agent
sudo install -d -m 0750 -o happy-agent -g happy-agent \
  /var/lib/happy-agent/happy/config
```

Install the desired first-party coding assistants and complete their normal sign-in flow as the
`happy-agent` service user. Happy Agent reads that user's existing provider credentials; it has no
separate provider login and should not share another operating-system user's credential files. The
built-in providers are enabled by default when their credentials are present. See
[configuration.md](configuration.md#providers) for custom provider instances and model filters.

## 2. Bootstrap the Tailcat identity

The WorkOS organization ID does not exist yet, so start the binary in standalone mode first. Put
this initial configuration in `/var/lib/happy-agent/happy/config/happy.toml`:

```toml
[feature.tailcat]
enabled = true
port = 24779
```

Install `/etc/systemd/system/happy-agent.service`:

```ini
[Unit]
Description=Happy Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=happy-agent
Group=happy-agent
WorkingDirectory=/var/lib/happy-agent
Environment=HOME=/var/lib/happy-agent
ExecStart=/usr/local/bin/happy-agent run
Restart=on-failure
RestartSec=2
UMask=0077

[Install]
WantedBy=multi-user.target
```

Start the binary and wait for Tailcat to report both parts of its live endpoint:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now happy-agent

TAILCAT_DIR="/var/lib/happy-agent/.happy/agent/tailcat"
for attempt in $(seq 1 90); do
  if sudo test -s "$TAILCAT_DIR/address" && sudo test -s "$TAILCAT_DIR/port"; then
    break
  fi
  if ! sudo systemctl is-active --quiet happy-agent; then
    sudo journalctl -u happy-agent -n 100 --no-pager
    exit 1
  fi
  if [ "$attempt" -eq 90 ]; then
    echo "Happy Agent did not open Tailcat within 90 seconds" >&2
    exit 1
  fi
  sleep 1
done

TAILCAT_ADDRESS="$(sudo cat "$TAILCAT_DIR/address")"
TAILCAT_PORT="$(sudo cat "$TAILCAT_DIR/port")"
TEAM_ENDPOINT="tailcat://$TAILCAT_ADDRESS:$TAILCAT_PORT"
printf '%s\n' "$TEAM_ENDPOINT"
```

The `tailcat:` value is the endpoint stored by Happy Cloud. It contains the unguessable Tailcat
connection address and the fixed configured port. Both remain stable across daemon restarts, so the
team can be registered once after this initial deployment. Treat the endpoint as private discovery
information.

Tailcat defaults to the fixed, IANA-unassigned port `24779`. A conflict should be unusual. If the
service nevertheless reports that the port is already in use, override `port` under
`[feature.tailcat]` with another nonzero TCP port and restart while this deployment is still being
bootstrapped. Settle on that port before registering the team; changing it later changes the
published endpoint.

## 3. Create the Happy team and register its endpoint

On the standalone management Happy Agent connected to Happy Cloud, first ask an active admin bot to
call `get_happy_workos_state`. It takes no arguments and returns:

```json
{
    "workos_client_id": "client_01KZD3XE9YAFAMT0P8TD4HP73E",
    "workos_user_id": "user_01EXAMPLE"
}
```

Save both exact values for the team configuration. The state lookup is deliberately separate from
team creation and is available only to an active admin bot.

Then ask a human-owned root agent or admin bot to create the team with the exact `TEAM_ENDPOINT`
printed by the deployed server. The tool input is:

```json
{
    "name": "Acme Engineering",
    "endpoint": "tailcat://tcEXAMPLE:24779"
}
```

`create_happy_team` requires both fields. It creates the WorkOS organization, gives the connected
WorkOS user its `admin` role, and registers the endpoint before returning. Save the returned
`org_...` team ID.

If organization creation succeeds but the endpoint write does not, the error includes the new team
ID. Do not create another organization. Call `update_happy_team` with that ID and the endpoint to
finish setup.

The other management tools are:

- `list_happy_teams`, which pages through the connected user's teams and their endpoints;
- `update_happy_team`, which currently changes a team's endpoint and requires `team_id` plus
  `endpoint`.

A non-admin bot cannot use the team-management tools. A human-owned root agent may manage teams,
but does not receive the WorkOS state lookup. Happy Cloud also checks the connected WorkOS identity
and allows an endpoint update only for an active organization administrator.

## 4. Enable team mode

Replace the server's `happy.toml` with the final configuration. Use the organization ID returned by
`create_happy_team` and both WorkOS identifiers returned by `get_happy_workos_state`:

```toml
[feature.team]
enabled = true
host = "127.0.0.1"
port = 3000
workos_organization_id = "org_01EXAMPLE"
owner_workos_user_id = "user_01EXAMPLE"
workos_client_id = "client_01KZD3XE9YAFAMT0P8TD4HP73E"

[feature.tailcat]
enabled = true
port = 24779
```

Set `owner_workos_user_id` and `workos_client_id` to the values returned by
`get_happy_workos_state`. Do not infer the client from the environment or rely on the configuration
default; the tool reports the exact Happy Cloud setup that authenticated the intended owner.

Restart the service and wait for Tailcat again:

```sh
sudo systemctl restart happy-agent

TAILCAT_DIR="/var/lib/happy-agent/.happy/agent/tailcat"
for attempt in $(seq 1 90); do
  if sudo test -s "$TAILCAT_DIR/address" && sudo test -s "$TAILCAT_DIR/port"; then
    break
  fi
  if ! sudo systemctl is-active --quiet happy-agent || [ "$attempt" -eq 90 ]; then
    sudo journalctl -u happy-agent -n 100 --no-pager
    exit 1
  fi
  sleep 1
done

TAILCAT_ADDRESS="$(sudo cat "$TAILCAT_DIR/address")"
TAILCAT_PORT="$(sudo cat "$TAILCAT_DIR/port")"
TEAM_ENDPOINT="tailcat://$TAILCAT_ADDRESS:$TAILCAT_PORT"
printf '%s\n' "$TEAM_ENDPOINT"
```

The Tailcat identity key and configured port both survive the move into team mode, so this endpoint
must match the value registered during creation. If an operator intentionally changes the Tailcat
port or replaces the identity key later, call `update_happy_team` from the standalone management
agent to publish the replacement endpoint:

```json
{
    "team_id": "org_01EXAMPLE",
    "endpoint": "tailcat://tcEXAMPLE:24780"
}
```

At this point the server is in team mode. It no longer creates or accepts the standalone Unix
socket and local bearer token. Tailcat provides end-to-end WireGuard encryption, NAT traversal, and
DERP fallback, but it does not replace WorkOS authentication.

## 5. Verify a team connection

For normal setup, first check the service and live Tailcat endpoint, then have the active local
admin bot register a WorkOS-authenticated connection with `set_remote_connection` and verify it
with `check_remote_connection_health`. Follow
[the local connection walkthrough](recipe/deploy-happy-team.md#5-add-the-local-connection-and-verify-it)
for exact inputs and completion checks. This path manages organization-scoped tokens without
manual credential extraction. The commands below are an optional low-level diagnostic, not a
required token-transfer step.

Install Tailcat v0.4.0 on a client machine, obtain a WorkOS access token for the configured client
and organization, then run:

```sh
TAILCAT_ADDRESS="tcEXAMPLE"
TAILCAT_PORT="24779"
HAPPY_ACCESS_TOKEN="eyJ..."

tailcat socks "$TAILCAT_ADDRESS" curl \
  -H "Authorization: Bearer $HAPPY_ACCESS_TOKEN" \
  "http://server.tailcat:$TAILCAT_PORT/v0/health"
```

The registered `tailcat:` endpoint is discovery metadata; HTTP inside the encrypted connection goes
to `server.tailcat` at its encoded port. Tailcat supplies transport only. Every request still has to
pass WorkOS authentication and the team's onboarding rules.

For a conventional deployment, register an absolute `https:`, `http:`, `wss:`, or `ws:` endpoint
instead. The team listener is plain HTTP, so a directly Internet-accessible deployment should put it
behind trusted TLS termination. When Tailcat is the only network path, keep `host = "127.0.0.1"` as
shown above.

See [tailcat.md](tailcat.md) for live Tailcat control through an admin bot, endpoint discovery, and
remote client commands.

## What changes

Standalone mode serves its API over an owner-only Unix socket and checks a generated local bearer
token. Team mode instead:

- serves HTTP, server-sent events, WebSocket upgrades, and API tunnels on the configured TCP host
  and port;
- does not create, read, or retain the local API socket or token file;
- disables local clients and daemon commands that depend on that socket;
- does not start the socket-dependent macOS menu bar app;
- authenticates every request, including health, with a WorkOS access token.

Use `happy-agent run` for team deployments. `happy-agent start`, `stop`, `status`, and `reload`, and
helpers such as `ensureAgentDaemon`, are local-socket workflows and are intentionally unavailable
in this mode.

## WorkOS authentication

Send the WorkOS access token as a bearer token:

```http
Authorization: Bearer eyJ...
```

Happy Agent verifies the token's RS256 signature and required claims locally. The token must have:

- the issuer and `client_id` for the configured WorkOS client;
- an `org_id` exactly equal to `workos_organization_id`;
- a valid WorkOS user ID in `sub`;
- valid `exp`, `iat`, and `sid` claims.

The verifier retrieves signing keys from the configured client's WorkOS JWKS endpoint and caches
them. Invalid, expired, wrong-client, and wrong-organization tokens all receive the same generic
`401 Unauthorized` response.

## Users and onboarding

Team mode stores one durable Happy Agent user per WorkOS identity. Startup never prepopulates users,
including the configured owner. A valid organization member who does not have a local user can
access only:

- `GET /v0/health`;
- `GET /v0/onboarding`;
- `GET /v0/profile`;
- `PATCH /v0/profile`.

`GET /v0/profile` initially returns the existing empty profile shape. The first
`PATCH /v0/profile` must include a non-null `name`; it creates the user's row. The profile API stays
compatible with standalone mode: clients continue sending one combined `name`, while storage uses
the first whitespace-delimited token as `firstName` and the trimmed remainder as `lastName`. A
single-token name has no last name.

Installation setup and personal setup are separate inside the daemon but appear as one onboarding
flow to clients. `GET /v0/onboarding` reports `completed: false` for a member without a local
profile, even if the installation is already onboarded. Saving that member's profile completes
the combined flow when installation setup is complete. On a fresh installation, the existing
`POST /v0/onboarding/complete` finishes installation setup after the caller has saved their
profile. Completing installation setup never lets another member skip their own profile.

The new user receives `isOwner = true` only when the token's WorkOS user ID matches
`owner_workos_user_id`. Clients cannot set or change that flag. Once the user exists, that WorkOS
identity can use the rest of the API.

Each stored user has:

- a Happy Agent CUID2 ID;
- its unique WorkOS user ID;
- first name and optional last name;
- optional email;
- an owner flag derived from configuration;
- optional normalized WebP photo data and ThumbHash metadata.

These storage details do not change the current-profile HTTP representation. Profile reads and
writes still return `name`, `email`, `photo`, `version`, and `updatedAt`.

## Shared profile updates

When any team member changes their profile or photo, `profile.updated` is published through the
server-wide event stream to every connected member. Its team-mode payload contains only the changed
Happy Agent `userId` and the mutation ID when one was supplied. It never broadcasts that member's
name, email, or photo metadata. Clients use the event as an identity-specific invalidation.

The authoritative endpoint and event schemas are in the Happy Agent HTTP API contract. Installed
releases ship that contract as `API.md` beside this page; in a source checkout it lives at
`packages/happy-agent/API.md`.
