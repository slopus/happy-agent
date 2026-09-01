# Team deployment mode

Team mode runs one Happy Agent daemon for multiple members of one WorkOS organization. It keeps the
existing Happy Agent HTTP contract while changing the transport, authentication, and profile
storage behind it.

## Enable it

Add the deployment settings to the machine-wide `happy.toml`:

```toml
[feature.team]
enabled = true
host = "0.0.0.0"
port = 3000
workos_organization_id = "org_01EXAMPLE"
owner_workos_user_id = "user_01EXAMPLE"
```

The configuration file is `~/Happy/Config/happy.toml` on macOS and
`~/happy/config/happy.toml` on Linux unless the configuration directory was overridden. A
repository's `happy.toml` cannot enable or configure team mode.

The default WorkOS client is Happy Cloud's production client,
`client_01KZD3XE9YAFAMT0P8TD4HP73E`. To use another WorkOS project, set it explicitly:

```toml
workos_client_id = "client_01EXAMPLE"
```

Start the service in the foreground under the deployment's process supervisor:

```sh
happy-agent run
```

Team mode defaults to `0.0.0.0:3000`. The listener is plain HTTP; terminate TLS at a trusted
reverse proxy or ingress before exposing it outside a trusted network.

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
