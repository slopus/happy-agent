# Happy Agent HTTP API

This document specifies the HTTP API served by the Happy agent daemon. It describes the intended
contract, written endpoint by endpoint. It is informed by the current implementation but is the
target design, not a description of legacy behavior.

## Basics

### Transport

The daemon has two mutually exclusive primary deployment transports:

- Standalone mode serves HTTP/1.1 over a Unix domain socket. The socket
  path comes from the agent configuration (`paths.socketPath`); the socket file and its parent
  directory are created with owner-only permissions (`0600` / `0700`).
- Team mode serves HTTP/1.1 over TCP at the host and port configured by `[feature.team]`. It does
  not create or listen on the Unix socket. The defaults are `0.0.0.0:3000`, suitable for a
  container or service whose external boundary is controlled by its deployment platform.
  A configured port of `0` selects an ephemeral port.

Either mode may also serve the same API over Tailcat: `[feature.tailcat]` exposes the deployment
transport. Without a public endpoint, the mobile connector has a separate Tailcat socket for
paired phones with credentials of their own.

The optional machine setting `[api] public_url` configures this daemon's public HTTPS origin,
independently of mobile pairing. `[api] public_port` selects its loopback HTTP port, default
`24782`, in 1–65535. Only machine configuration may set either value, never a repository's
`happy.toml`. An omitted or empty machine URL disables the public transport; a runtime
`public_url = ""` explicitly overrides a machine URL with no public endpoint. URL normalization
is specified under `PATCH /v0/config`.

When a public origin is configured, the daemon owns one HTTP/1.1 listener on
`127.0.0.1:<public_port>`. It serves both ordinary API clients and mobile connections. It starts
independently of paired devices and remains available even when the mobile connector is disabled.
The mobile connector does not start its own listener, forwarding listener, or Tailcat exposure in
public mode. The primary Unix socket or team listener remains available with its existing
authentication boundary. The separate `[feature.tailcat]` exposure is unchanged by this setting.

The operator supplies DNS, a publicly trusted certificate, and a trusted TLS-terminating proxy
forwarding the complete HTTP/1.1 stream to that loopback listener. The proxy must preserve request
targets and Authorization, streaming responses, WebSocket upgrades, and arbitrary bidirectional
bytes after CONNECT. A TLS-terminating TCP proxy supports the complete API. An ordinary HTTP proxy
or load balancer that rejects CONNECT still supports every tunnel through its WebSocket twin,
described under "WebSocket tunnels"; only the CONNECT form is unavailable through it. The proxy
can observe credentials and plaintext; its final loopback hop is unencrypted. Configuring an origin
does not configure or probe DNS, TLS, a firewall, or a proxy, and never binds a public interface
itself.

Clients use normal platform TLS trust and hostname verification, map HTTPS to WSS for WebSockets,
and never downgrade to HTTP, ignore certificate errors, forward bearer credentials through a
redirect, or silently substitute Tailcat when the public endpoint fails.

### Load balancers and edge authentication

A deployment may place the team listener or the public listener behind an HTTPS load balancer or
gateway that authenticates requests itself before they reach the daemon, for example by verifying
the same JWT access token. Such an edge must:

- forward `GET /v0/authentication` without authentication, because it is how a signed-out client
  learns where to sign in;
- authenticate API requests with the `Authorization` bearer token alone, never with a browser
  session cookie or a redirect to a sign-in page, since native clients follow no redirects on API
  calls;
- forward the `Authorization` header unchanged, stream responses without buffering, and pass
  WebSocket upgrades;
- keep its idle timeout at 20 seconds or more, and below the daemon's 60-second idle keep-alive
  timeout, so that it never reuses a connection the daemon is about to close.

The runner and exported-bot bridge connection routes use their own credentials, not member tokens,
and are not served on the public listener. They belong on a private network rather than behind
the member-facing edge. When an edge does carry them, it must forward them without its own
authentication.

### Keepalive

Every long-lived stream carries traffic at least every 15 seconds, so an intermediary's idle
timeout never ends a healthy stream:

- Server-Sent Events streams, `GET /v0/events/stream` and the artifact data change stream, write a
  comment frame at least every 15 seconds. Clients ignore comment frames.
- The daemon sends a WebSocket ping at least every 15 seconds on every WebSocket it serves,
  including terminal attachments, bridges, WebSocket tunnels, and live voice control. Clients
  answer with a pong, as WebSocket implementations do on their own, and may send pings of their
  own at any interval.

A client treats 45 seconds without receiving any bytes on a stream, or any message, ping, or pong
on a WebSocket, as a dead connection. It closes the connection and reconnects with backoff,
resuming as the stream defines: the event stream from its last cursor, a terminal by attaching
again. Tunnels and bridges are not resumable; a client opens new ones. CONNECT tunnels carry only
the bytes of their destinations and have no keepalive of their own.

### Credentials on the public transport

The shared public listener verifies the credential's identity before selecting its authority:

- The existing standalone API bearer, or the deployment's configured WorkOS/JWT authentication,
  retains its ordinary user and authorization rules.
- A paired mobile device retains exactly its pairing owner's authority, revocation behavior, and
  mobile route restrictions. Its token never becomes a standalone API or team sign-in credential.
- Pairing tokens and handshake credentials reach only their own mobile handshake routes. Ordinary
  API credentials do not authorize a mobile handshake.

Credential classes are established by verification, not guessed from token shape. Invalid,
ambiguous, or revoked credentials are refused. Mobile credentials remain unavailable when the
mobile connector is disabled. Runner and exported-bot bridge credentials and their dedicated
upgrade routes are not accepted on this public listener.

For every public caller, `/v0/drain`, `/v0/shutdown`, and `/v0/debug` and its descendants return
`403 forbidden` after authentication, regardless of method. These operations remain available
only through existing non-public transports with their existing authorization. Every request,
WebSocket upgrade, and CONNECT otherwise requires its appropriate credential. The sole
unauthenticated exception is the existing `GET /v0/authentication` sign-in discovery: it returns
only `authenticated: false`, the configured sign-in methods, and `userId: null` when no credential
verifies, never user or daemon data. Mobile management restrictions are unchanged.

Clients construct request URLs against an arbitrary authority — the daemon ignores the `Host`
header. Only the path and query string matter.

### Authentication

Every request requires a bearer token:

```
Authorization: Bearer <token>
```

In standalone mode, the token is a 43-character base64url string generated by the daemon on first
start and persisted at `paths.tokenPath` with mode `0600`. A machine deployment may instead set
`[api] token` to a fixed 43-character base64url token. On startup that configured value becomes
the socket token and is written to the same private token file so local clients use the same
credential. Project configuration cannot set it. Team mode rejects a configured standalone token.

In team mode, `[feature.team] authentication` selects one team authentication method: `"workos"`
(the default) or `"jwt"`. Methods are an extensible set; further methods may be added without
changing the others. Team mode does not create or read `paths.tokenPath` with either method.

With WorkOS team authentication, the token is a WorkOS access token issued for the production
Happy Cloud client `client_01KZD3XE9YAFAMT0P8TD4HP73E`. The daemon verifies the RS256 signature and
the required WorkOS claims locally against the WorkOS JWKS, with issuer
`https://api.workos.com/user_management/client_01KZD3XE9YAFAMT0P8TD4HP73E`. Its `org_id` claim must
equal `[feature.team] workos_organization_id`. The organization and
`owner_workos_user_id` are required team settings. A deployment may override the WorkOS client
with `[feature.team] workos_client_id`; the expected issuer and JWKS URL are derived from that
client ID. The user ID is the token's `sub` claim.

With JWT team authentication, an enterprise deployer operates an OAuth 2.0 authorization server
that signs members in and issues JWT access tokens for this daemon. It may be the organization's
identity provider itself or a small application in front of it. Clients obtain tokens with the
authorization code flow and PKCE for native apps (RFC 6749, RFC 7636, RFC 8252), talking to the
authorization server directly. The daemon only verifies access tokens and takes the user ID from
a configured claim. The settings live only in machine configuration, never in project
configuration:

```toml
[feature.team]
enabled = true
authentication = "jwt"
owner_user_id = "user-123"

[feature.team.jwt]
name = "Acme SSO"
authorization_url = "https://sso.acme.example/oauth/authorize"
token_url = "https://sso.acme.example/oauth/token"
refresh_url = "https://sso.acme.example/oauth/token"
client_id = "happy"
scope = "happy"
resource = "https://happy.acme.example"
issuer = "https://sso.acme.example"
audience = "https://happy.acme.example"
user_id_claim = "sub"
algorithms = ["RS256"]
jwks_url = "https://sso.acme.example/.well-known/jwks.json"
jwks_refresh_interval_sec = 3600
```

- `owner_user_id` — required; the user ID whose local user is created with the owner flag.
- `name` — required; 1–64 printable characters naming the sign-in method for people.
- `authorization_url` — required; the authorization endpoint opened in the system browser.
- `token_url` — required; the token endpoint that exchanges an authorization code.
- `refresh_url` — optional; the endpoint that exchanges a refresh token, usually the token
  endpoint. Without it, clients do not refresh and sign in again when an access token expires.
- `client_id` — required; the public OAuth client identifier, 1–256 printable characters.
- `scope` — optional; the space-separated scope requested during authorization, 1–1,024
  printable characters.
- `resource` — optional; an RFC 8707 resource indicator that clients send to the authorization
  server so it can issue tokens for this deployment directly. An absolute URI of 1–2,048
  characters without a fragment, usually equal to `audience`. The daemon does not compare it with
  any token claim; tokens are still verified against `audience`.
- `issuer` — required; the exact `iss` claim value.
- `audience` — required; a value the `aud` claim must equal or contain. It is the deployment's
  public base URL, as described below.
- `user_id_claim` — optional, default `"sub"`; the top-level claim holding the user ID. Its value
  must be a string of 1–256 printable characters.
- `algorithms` — required, non-empty; the accepted `alg` header values. `none` is never accepted.
- Exactly one key source:
    - `jwks_url` — a JWKS URL publishing the asymmetric public keys. The daemon downloads it
      rather than having keys written into configuration, as described below.
    - `public_key` — one PEM-encoded SPKI public key for asymmetric keys.
    - `secret_env` — the name of an environment variable of the daemon process holding a shared
      secret for symmetric keys. The secret is read at startup and must contain at least 32 bytes.
- `jwks_refresh_interval_sec` — optional, only with `jwks_url`; an integer from 60 through 86,400,
  default 3,600. How often the daemon downloads the key set again.

Every endpoint URL must be absolute and use `https`; `http` is accepted only for a loopback host
(`localhost`, `[::1]`, or an IPv4 address in `127.0.0.0/8`). Asymmetric key sources accept only
`RS256`, `RS384`, `RS512`, `PS256`, `PS384`, `PS512`, `ES256`, `ES384`, `ES512`, and `EdDSA`.
`secret_env` accepts only `HS256`, `HS384`, and `HS512`. A mixture, a missing or invalid setting, a
missing or short secret, or any WorkOS setting under JWT authentication fails configuration
loading with a human-readable message.

`token_url` and `refresh_url` must have the same origin — scheme, host, and port — as
`authorization_url`, so an authorization code, its PKCE verifier, and a refresh token only ever
reach the authorization server that issued them. Configuration loading fails otherwise.

`audience` must be the deployment's public base URL, the `https` URL members connect to, such as
`https://happy.acme.example`. Clients send an access token only to the server its `aud` claim
names, so a token issued for this deployment is never handed to another server that copied this
deployment's sign-in method. The daemon cannot check this setting; a deployment whose `audience`
is not its public base URL cannot be signed in to. The daemon never exposes the secret, the public key, or the
JWKS through the API, errors, or logs.

A JWT is accepted only when its signature verifies with the configured key source and one of the
configured algorithms, its `iss` equals `issuer`, its `aud` equals or contains `audience`, and it
carries an unexpired `exp`. `nbf` and `iat` are honored when present. Time comparisons allow 30
seconds of clock skew. A bearer token longer than 16,384 characters is rejected without
verification.

With `jwks_url`, the daemon owns a cached copy of the key set:

- It downloads the key set when the agent system starts, and again every
  `jwks_refresh_interval_sec` after each successful download. A failed download is retried after
  60 seconds.
- A token whose key is not in the cached set, or a token arriving before any download succeeded,
  triggers one immediate download, at most once every 30 seconds. This picks up a rotated key
  without waiting for the interval. Verification never waits on more than one download.
- A successful download replaces the whole set, so a key removed from the JWKS stops verifying
  tokens at the next successful download. A failed download keeps the last successful set.
  Without any successful download, every token is rejected.
- Each download sends `GET` with `accept: application/json`, does not follow redirects, times out
  after 5 seconds, and accepts at most 1 MiB and 100 keys. A response that is not a valid JWKS
  counts as a failed download.
- Downloads stop when the daemon shuts down. Their failures are logged without key material and
  never stop the daemon.

#### Signing in with the authorization code flow

The daemon is not trusted with sign-in credentials. It never receives an authorization code, a
PKCE verifier, or a refresh token, and it has no endpoint that accepts them. A client:

1. Reads an `oauth` method from `GET /v0/authentication` or from a `401`.
2. Refuses the method unless `tokenUrl` and, when present, `refreshUrl` have the same origin as
   `authorizationUrl`. Then generates a random `state` and a PKCE verifier of 43–128 characters,
   both kept only in the client, and opens `authorizationUrl` in the system browser with the query parameters
   `response_type=code`, `client_id`, `redirect_uri`, `state`, `code_challenge` (the base64url
   SHA-256 of the verifier), `code_challenge_method=S256`, `scope` when the method has one, and
   `resource` when the method has one.
   The redirect URI is the application's private-use URI scheme callback, as RFC 8252 describes.
   Happy's desktop, iOS, and Android applications all use exactly `happy://oauth/callback`, so a
   deployer allow-lists that one value with its authorization server.
3. Receives `redirect_uri?code=<code>&state=<state>`, or `error` and optional
   `error_description` on failure, and rejects the result unless `state` matches.
4. Sends `POST tokenUrl` with an `application/x-www-form-urlencoded` body carrying
   `grant_type=authorization_code`, `code`, `redirect_uri`, `client_id`, `code_verifier`, and
   `resource` when the method has one.
   A successful JSON response carries `access_token` and `token_type` `Bearer`, and optionally
   `expires_in` in seconds and `refresh_token`.
5. Reads the `aud` claim of `access_token` without verifying it, and discards the token unless
   one `aud` value names the server the client is signing in to: an absolute URL with that
   server's origin whose path, with a trailing `/` added when missing, equals the server URL's
   path. The client then uses `access_token` as its bearer token for that server only.

When the method advertises `refreshUrl` and the client holds a refresh token, the client may send
`POST <refresh URL>` with `grant_type=refresh_token`, `refresh_token`, `client_id`, and the
`resource` recorded at sign-in when there was one, in the same form encoding, and receives the
same response, whose `access_token` is checked against the same server as in step 5. A new
`refresh_token` replaces the old one; its absence keeps the old one. The
client sends a refresh token only to the refresh URL, client ID, and resource recorded when that
token was issued, never to a URL a daemon advertises afterwards. When refresh fails or is
unavailable, the client signs in again. Clients may keep credentials only in memory; a client that
keeps a refresh token across launches stores it in the operating system's credential store, such
as the macOS or iOS Keychain, Android Keystore-protected storage, or Windows Credential Manager.
Token requests follow no redirects.

Because a server sees every access token sent to it, each deployment's `audience` is its own
public base URL and clients check it before sending a token, so a server cannot obtain a member's
token for another deployment. A daemon
configured with `secret_env` can mint tokens itself; a shared secret must never be shared with any
other deployment or service, and asymmetric keys are required whenever the daemon is not fully
trusted.

User IDs are scoped to their authentication method. The same user ID from WorkOS and from JWT names
two different identities, and switching an installation's method never merges them.

A member without a local user may access health, onboarding status, and the profile routes needed
to onboard. Other routes remain unauthorized until saving the profile creates that user. The user
whose user ID equals `owner_workos_user_id` (WorkOS) or `owner_user_id` (JWT) is created with the
owner flag.

A missing, invalid, expired, or wrong-organization token yields `401` with body
`{ "error": "Unauthorized", "code": "unauthorized" }`. In JWT team mode, every `401` additionally
carries an `authentication` object whose `methods` are the same as those returned by
`GET /v0/authentication`, so a client can discover how to sign in from any rejected request:

```json
{
    "error": "Unauthorized",
    "code": "unauthorized",
    "authentication": {
        "methods": [
            {
                "type": "oauth",
                "id": "jwt",
                "name": "Acme SSO",
                "authorizationUrl": "https://sso.acme.example/oauth/authorize",
                "tokenUrl": "https://sso.acme.example/oauth/token",
                "refreshUrl": "https://sso.acme.example/oauth/token",
                "clientId": "happy",
                "scope": "happy",
                "resource": "https://happy.acme.example"
            }
        ]
    }
}
```

#### Credentials on the wire and signing in again

A client sends its credential only in the `Authorization` header: on JSON requests, event streams,
WebSocket upgrades, and CONNECT alike. It never puts a credential in a query string, a cookie, or
a WebSocket subprotocol, and the daemon accepts it from nowhere else. A client never follows a
redirect on an API request and never sends its credential to another origin.

A request through `/v0/connections/:id/api/*` to a server connection by URL carries a second
credential: the person's access token for that server, in `Happy-Remote-Authorization: Bearer
<token>`, next to the daemon's own credential in `Authorization`. The same rules apply to it. It
travels only in that header, on JSON requests, event streams, WebSocket upgrades, and CONNECT
alike, and never in a query string, a cookie, or a WebSocket subprotocol.

Every error the daemon writes is a Happy error: a `content-type` of `application/json`, with any
parameters, and a body that is a JSON object whose `error` and `code` are strings. Anything else
came from something in front of the daemon, such as a load balancer or an identity-aware proxy.

A client signs in again when a request, an event stream, or a WebSocket upgrade is answered with:

- a redirect: any `3xx` status other than `304 Not Modified`, including a redirect the client's
  HTTP stack reports as opaque;
- `401`, after the check below; or
- `403` that is not a Happy error.

A `403` that is a Happy error is an ordinary refusal; the client shows it and keeps its sign-in.
A `401` that is not a Happy error came from the edge, and the client signs in again at once,
trying its refresh token first when it has one. A `401` that is a Happy error may instead be the
team profile gate: before treating it as an expired sign-in, the client calls
`GET /v0/authentication` with the same token. `authenticated: true` with a `null` `userId` means
the member must save a profile, not sign in; `authenticated: true` with a user ID means the
credential is still good; `authenticated: false` means it expired, and the client refreshes or
signs in. A client that checks discovery right after each sign-in and saves the profile before
using other routes never meets the gate. Paired mobile device credentials keep their own
revocation rules, described under Mobile connector.

A runner token from `[runners.<id>] token` authenticates only `GET /v0/runners/connect` on the
primary transports, in both standalone and team mode. No other credential is accepted on that
route, and the public listener does not expose it. See Runners.

A bridge token authenticates only `GET /v0/exported-bots/connect` on the primary transports, in both
standalone and team mode. No other credential is accepted on that route, and the public listener
does not expose it. See Exported bots. Exported-bot guests
have no credentials: no sign-in method, bearer token, or bridge token authenticates as a guest.

`GET /v0/authentication` is the only unauthenticated endpoint. Every other endpoint, health
included, requires a valid bearer token.

The dedicated mobile Tailcat socket accepts none of these credentials, only a paired phone's device
token and the pairing credentials, and has no unauthenticated endpoint. The primary transports
accept none of the mobile credentials. The daemon-owned public listener serves ordinary and
mobile credentials with separate authority, as specified under "Credentials on the public transport".

### Versioning

All routes are prefixed with `/v0`. Independently of the path version, every daemon advertises
its identity through the health endpoint as a single `version` object: a numeric `protocol`
(integer, currently 35) and the `daemon` product version string. Protocol versions from 22 onward
are backward-compatible and additive. Clients support that compatibility range for existing
capabilities instead of requiring equality with their own protocol number. A client may require
a newer protocol for a capability it needs and must explain that an upgrade is required when the
daemon is too old. The `daemon` product version is for display and diagnostics only.

The retired GitHub credential selector on project cloning is an explicit compatibility exception:
clients must omit `secret` from `POST /v0/projects/clone`.

Protocol 24 guarantees bot creation without a supplied name and the automatic naming behavior
described below. A client that depends on unnamed bot creation requires protocol 24 or newer;
with an older compatible daemon it must supply a deliberate name or leave that feature unavailable.
Named bot-creation requests remain valid, including requests sent by older clients. Applications
that require this feature throughout their interface may set their minimum protocol to 24 without
changing the daemon's support for older clients' existing requests.

Protocol 25 adds optional `workspaceId` and `agentId` to bot creation. Clients relying on these
identities require protocol 25 or newer; older daemons may ignore or reject them.

Protocol 26 adds runners: the `"runner"` compute on projects, workspaces, and bots, the optional
`runnerId` on project registration and cloning, `GET /v0/runners`, and `runners.updated`. It also
runs Docker workspaces in their containers, adding the optional `path` and `runnerId` to the
`"docker"` compute. Clients
that show runners or create projects on them require protocol 26 or newer. An older compatible
daemon answers `GET /v0/runners` with `404` and never returns a runner compute. A client that meets
a compute `type` it does not recognize treats the folder as being on another machine and offers no
local-path actions for it.

A runner machine's optional `osVersion` and `shell`, and keeping this machine the default with
`[runners] default = "local"`, are additive and do not increment the protocol version. Older
daemons and older runners omit the two machine fields. A client that decides whether this machine
still runs work reads it from the runner list: when no runner object has `default: true`, folders
that name no runner are on this machine.

Protocol 27 adds the mobile connector: `GET /v0/mobile-connector`, the pairing and device routes
under `/v0/mobile-connector`, `mobile_connector.updated`, and the connector's socket with its
handshake routes and credentials. Clients that offer direct phone connections require protocol 27
or newer. An older compatible daemon answers these routes with `404`, which clients treat as the
feature being unavailable, and never emits the event.

Protocol 28 adds agent networks: `GET /v0/workspaces/:workspaceId/agents/:agentId/proxy`, which
names the network an agent's connections leave from, and `CONNECT /v0/networks/:networkId/proxy`.
Clients that keep browser state per network require protocol 28 or newer. An older compatible
daemon answers the read with `404`, which cannot be told apart from an unknown agent, so clients
check the protocol instead of probing, and offer no network-scoped browsing on an older daemon.

Protocol 29 adds pushed provider-account usage: the `provider.usage.updated` event,
`POST /v0/usage/refresh`, the always-present `refreshedAt`, `refreshError`, `retryAt`, and
`refreshing` fields on every `GET /v0/usage` provider entry, and the optional per-window
`capturedAt`. Clients that follow usage live require protocol 29 or newer. A client that only has
a usage response can tell the same thing from the entry itself: an entry without `refreshedAt`
comes from an older compatible daemon, which never emits the event and answers the refresh route
with `404`, so the client keeps polling `GET /v0/usage` instead.

Protocol 30 adds typed failures: the optional `failure` and `notice` objects on service
messages, the optional `retrying` field on agents, and the failed-turn `retry` and `switch`
routes, all described under [Typed failures](#typed-failures). A client that offers those actions
requires protocol 30 or newer. With an older compatible daemon, `failure` is absent and the
client renders the error text and legacy `error` details as before; the two routes answer `404`.

Protocol 31 guarantees default team membership for Surfaces and the independent per-person
`surfaces.autoJoin` preference described under Surface catalog and members. Clients that offer
this preference require protocol 31 or newer: older daemons may accept the opaque setting without
applying a membership policy. Existing Surface and generic user-settings requests remain valid.

Protocol 32 stops typed failures from carrying switch targets. `fallbackProviders` stays on every
failure for older clients but is always empty, including on failures stored earlier, and the
`switch` route accepts any provider and model the live model catalog offers. Clients offering
Switch on protocol 32 or newer take its targets and usage from the same live sources as their
model picker. An older daemon accepts only targets from the failure's own `fallbackProviders`.

Protocol 33 adds permanent deletion by admin bots, described under [Permanent deletion](#permanent-deletion),
and the removal events that announce it: `project.removed`, `workspace.removed`, `bot.removed`,
`task.removed`, and `agent.removed`. A client on protocol 33 or newer drops the named resource when
it sees one. An older client ignores these event types as it does every type it does not recognize,
keeps showing the deleted resource as archived, and finds it gone with `404` on its next read or
resync. No request or response schema changes.

Chat UI and suggested replies are retired. The daemon exposes neither `show_ui` nor
`suggest_replies`, advertises no `capabilities.chatUi`, and answers
`POST /v0/agents/:agentId/actions` with `404`. There is no component catalog or action execution.
Historical calls remain ordinary tool calls with their original names, arguments, and results;
clients must not replace them with fallback text, hide them, or render interactive controls.
Legacy presentation payloads and message fields are passive historical data only. A legacy
`quickReply` on a send is accepted and ignored; it neither validates a suggestion nor grants
authority. Structured user-input questions and permission requests are unaffected.

Clients may encounter historical `ui`, `action`, and `quick_replies` message blocks, `ui` and
`quick_replies` presentations, and `quickReply` message provenance. They tolerate these as opaque
data. Clients send `Happy-Protocol: 35` or newer on requests, including event streams, so older
compatible daemons preserve the original historical calls rather than projecting fallback text.
Current daemons preserve historical calls regardless of that header. Protocol 35 also adds the
optional `kind` on run metadata, which marks a run stored outside any turn; it is additive, and
an older client ignores it.

Account provenance, configuration history blocks, and structured error details are additive output
and do not increment the protocol version. Clients tolerate their absence and older clients keep
their existing text rendering. Existing sends and idle-only compaction remain unchanged.

The global skills catalog, parsed skill documents, enablement, file reads, and live
`skills.updated` invalidations are additive and do not increment the protocol version. Clients
detect this feature through `GET /v0/skills`: `404` or `501` means skill management is unavailable,
not that the catalog is empty. Protocol 25 alone does not guarantee this feature. Existing
protocol-22 capabilities remain usable without it.

Plugins are additive and do not increment the protocol version: the routes under `/v0/plugins`,
the `plugins.updated` event, and the optional `plugin` attribution on global skill summaries.
Clients detect plugins through `GET /v0/plugins`: `404` or `501` means plugins are unavailable,
not that nothing is installed. Older daemons never emit the event and omit the attribution.

Authentication discovery, JWT team authentication, and the `authentication` field on `401`
bodies are additive and do not increment the protocol version. `404` from
`GET /v0/authentication` means discovery is unavailable; clients then use their existing bearer
token configuration. Older daemons omit the `401` field.

By explicit product decision, the `browser` sign-in method that returned a JWT in the redirect
fragment, and the `redirectUri` and `state` parameters of `GET /v0/authentication`, are removed
as a one-off exception to additive compatibility. No daemon release served them. Daemons advertise
the `oauth` method instead and ignore any query string on discovery.

WebSocket tunnels, WebSocket keepalive pings, and the sign-in `resource` are additive and do not
increment the protocol version. A daemon that serves the WebSocket twins of the proxy tunnels
reports `capabilities.webSocketTunnels: true` from health. Older daemons omit it and refuse the
twin routes, and a client then uses `CONNECT`. When a `CONNECT` through an HTTPS endpoint is
refused with something other than a Happy error, or the connection closes without an answer, the
endpoint does not carry CONNECT: the client leaves browser previews, agent networks, live-URL
artifacts, and local-to-workspace forwarding unavailable for that daemon, says so in human
terms, and does not retry in a loop. Older daemons omit the authentication method's `resource`;
clients then send none.

Server connections by URL, the `Happy-Remote-Authorization` header, the `oauth` roster entry,
the roster's `instanceId`, health's `instanceId`, and instance links are additive and do not increment the
protocol version. Older daemons never list an `oauth` entry. Older daemons omit `instanceId`;
clients then offer no instance links for them.

Workspace bridges are additive and do not increment the protocol version. A daemon that serves
them reports `capabilities.workspaceBridges: true` from health. Older daemons omit it and answer
`GET /v0/workspaces/:workspaceId/bridges` with `404`; clients then offer no USB, Bluetooth, or
workspace-to-local forwarding. Forwarding from the client into a workspace through the workspace
proxy is unchanged.

The model definition's `autoCompactWindow` is additive and does not increment the protocol
version. Older daemons omit it; a client that shows remaining context counts down to
`contextWindow` when the field is absent.

Tasks are additive and do not increment the protocol version. Clients detect them through
`GET /v0/tasks`: `404` means the daemon has no tasks, not that the list is empty. The bootstrap
`tasks` and `taskMemberships` fields and the `task.*` events are absent on older compatible
daemons. Task agents and their workspaces appear in no project or workspace listing and emit no
`workspace.*` events, so a client that does not know about tasks never encounters one. The
workspace `kind` value `"task"` and the workspace `taskId` field appear only on a task's
workspace, which a client reaches only through a task.

Surfaces are additive and do not increment the protocol version. Clients detect them through
`GET /v0/surfaces`: `404` or `501` means Surface support is unavailable. The desktop bootstrap
`surfaces` field and the `surface.*` and `todo.*` events are absent on
older compatible daemons. Surface IDs are CUID2s and types are extensible strings; clients leave
unknown types unavailable while retaining the rest of the catalog.
Surface `creatorUserId` and todo `authorUserId` are optional additive response fields; older
compatible daemons may omit them. Clients treat an absent attribution field as `null`.
Surface `chatAgentId`, reference `target`, and dedicated-workspace `surfaceId` are optional
additive fields. A missing `chatAgentId` is treated as null. Surface chat workspaces have
`kind: "surface"` and are discovered only through their Surface chat, never ordinary workspace
listings. An older daemon may reject new Surface types or return `404`/`501` for document or
chat routes; clients leave those features unavailable without disabling existing todo lists.
Calendar Surfaces are additive and do not increment the protocol version. A daemon that serves
them reports `capabilities.calendarSurfaces: true` from health. Older daemons omit it, reject
`{ "type": "calendar" }` creation with `400`, and answer calendar routes with `404`; clients
then offer no calendar creation. A calendar Surface listed by a daemon a client does not
support is left unavailable like any unknown type. The `calendar_event.*` events are absent on
older compatible daemons.

System Monitor Surfaces are additive and do not increment the protocol version. Supporting
daemons report `capabilities.systemMonitorSurfaces: true` from health. Older daemons omit it,
reject `{ "type": "system_monitor" }` creation with `400`, and answer its read route with
`404`. Clients leave an unknown Surface type unavailable and offer creation only when supported.

Chat Surfaces are additive and do not increment the protocol version. Supporting daemons report
`capabilities.chatSurfaces: true` from health. Older daemons omit it, reject `{ "type": "chat" }`
creation with `400`, and answer message routes with `404`; clients then offer no chat creation.
A chat Surface listed by a daemon a client does not support is left unavailable like any unknown
type. The `surface_message.*` events are absent on older compatible daemons.

Vault Surfaces are additive and do not increment the protocol version. Supporting daemons report
`capabilities.vaults: true` from health. Older daemons omit it, reject `{ "type": "vault" }`
creation with `400`, and answer vault and vault-upload routes with `404`; clients then offer no
vault creation. A vault Surface listed by a daemon a client does not support is left unavailable
like any unknown type. The `vault.*` events are absent on older compatible daemons.

Search is additive and does not increment the protocol version. Supporting daemons report
`capabilities.search: true` from health. Older daemons omit it and answer `POST /v0/search` with
`404`; clients then show local search results only.

Editing a Surface's name and image is additive and does not increment the protocol version.
Supporting daemons report `capabilities.surfaceEditing: true` from health. Older daemons omit it
and answer `PATCH /v0/surfaces/:surfaceId` with `404`; clients then offer no renaming or image
changes. The optional `name` and `image` fields of `surface.updated` `changes` are absent on
older compatible daemons. A client that does not know them keeps showing the earlier name or
image until it next reads the catalog.

Important documents are additive and do not increment the protocol version. The optional Surface
`promptDocument` field is absent on older compatible daemons; clients treat a missing field as a
document that is not an important document. The admin-bot tools that manage the list are agent
tools with no HTTP route or event.

Collaborative documents and the removal of the `separator` Surface type are a one-off exception
to additive compatibility, approved for client and daemon together; the protocol number does not
change. A daemon that serves collaborative documents reports `capabilities.collaborativeDocuments:
true` from health. Without it, clients show a document's Markdown read-only and offer no editing.
Against a current daemon, an older client that saves through the withdrawn document `PUT`
receives `405` and stops; it can still open and read every document through `GET`, but no longer
sees content changes live because `surface.document.updated` is no longer emitted. Creating a
separator returns `400`, and separators created earlier are no longer listed.

Happy links in agent text, described under "Message content", are additive and do not increment
the protocol version. Request and response schemas are unchanged; a client that does not render
them treats them as Markdown links with an unknown scheme. The `surface` kind is additive on the
same terms: a client that does not know it shows such a link's label as inert text. File links,
described in the same section, are additive on the same terms, in both their `happy://` and
`happy-file://` forms. Legacy reference tags stay readable; a client that does not render them
shows the tag text as written.
Settings links and the `button` title are additive on the same terms: a client that does not know
the `settings` host shows such a link's label as inert text, and one that does not know the
`button` title shows an ordinary link.

Artifacts are additive and do not increment the protocol version. Clients detect them through
`GET /v0/artifacts`: `404` means the daemon has no artifacts, not that the catalog is empty. The
`artifact.*` events are absent on older compatible daemons, which also serve none of the artifact
routes.

Artifact backgrounds are additive and do not increment the protocol version. A daemon that has
them always includes `background` on artifact and version objects, `null` when unset, and in the
`changes` of `artifact.updated`. Older compatible daemons omit it and ignore a `background` sent to
them; a client then shows every artifact on a transparent slot.

Artifact display preferences are additive and do not increment the protocol version. A daemon that
has them always includes `display` on artifact and version objects, `null` when unset, and in the
`changes` of `artifact.updated`. Older compatible daemons omit it; a client then decides on its own
how to show every artifact. Agent-written artifact directories change only the agent tools'
arguments and how an agent's versions are made; no request or response schema changes for them.

Live-URL artifacts are additive and do not increment the protocol version. A daemon that supports
them includes `live` on artifact and version objects and in `artifact.updated` changes: either
`{ "url", "networkId" }` or `null` for file content. Older daemons omit it. Existing file fields
remain unchanged: live artifacts have an inert HTML entry for older clients. Clients that
understand `live` use the recorded URL and network instead of that entry.

User settings are additive and do not increment the protocol version. A daemon that serves them
always includes `userSettings` in desktop bootstrap and never answers `GET /v0/user-settings` with
`404`. Older compatible daemons omit the bootstrap field, answer the user-settings routes with
`404`, and never emit `user_settings.updated`; clients then keep those preferences on the device.

User environments are additive and do not increment the protocol version. A daemon that serves
them reports `capabilities.userEnvironment: true` from health, accepts `PUT /v0/environment`,
accepts `deviceId` on `POST /v0/agents/:agentId/send`, and emits `user_environment.updated`.
Older compatible daemons omit the capability, answer `PUT /v0/environment` with `404`, and refuse a
send carrying `deviceId` with `400 invalid_request`, because the send body is closed. A client
sends `deviceId` only to a daemon that reports the capability or has answered one of its reports
with `200`.

Secret requests are additive and do not increment the protocol version. Older daemons never send a
question prompt's optional `secretRequest`. A client that does not recognize it renders the prompt
as an ordinary free-text question; the daemon rejects any answer to it that is not the ID of an
existing secret available to agents, so a value typed into that field is never stored.

Question context is additive and does not increment the protocol version. A daemon that supports
it includes the question's `context`; older compatible daemons omit it, and clients then show only
the prompts.

Permission requests are additive and do not increment the protocol version. Older daemons never
send a question's optional `permissionRequest`. A client that does not recognize it renders the
question as an ordinary question, and answering it works the same way.

Secret deletion through `DELETE /v0/secrets/:secretId` is additive and does not increment the
protocol version. An older compatible daemon answers that route with `404` even for a secret that
`GET /v0/secrets/:secretId` still returns; clients then treat deletion as unavailable. The
`secret.removed` event is unchanged.

Subtasks are additive and do not increment the protocol version. The agent's optional `subtask`
boolean defaults to `false` when absent; the workspace's optional `subtaskAgentId` defaults to
`null`. Clients use the explicit capability flags for interaction, not ancestry alone.

The optional additive agent field `subtasks` contains full agent objects for direct non-archived
subtasks, recursively. Current daemons emit it on every full agent object, including empty arrays
on leaves; older daemons may omit it. Omission means the tree was not supplied, not that a client
should discard already-known children. This addition does not increment the protocol version.

Subtask sibling order is additive and does not increment the protocol version. The optional agent
field `subtaskOrderKey` and `POST /v0/agents/:agentId/subtask-reorder` let a person arrange a
coordinator's subtasks. Until someone reorders them, `subtasks` keeps its previous newest-first
order, so older clients see the same arrays they always did. Older daemons omit the field and
answer the route with `404`; clients then keep the order the daemon supplies and offer no
subtask reordering.

By explicit product decision, the unused managed-root creation option is removed from both the
client and daemon as a one-off exception to additive compatibility. `POST /v0/agents` rejects
`parentAgentId` as an unknown request field with `400 invalid_request`; it creates only
user-controlled roots. Agent response parent relationships, ordinary subagents, and subtasks
remain unchanged. Existing stored agents are not deleted or rewritten.

Agent status lines are deprecated. Current daemons no longer offer `set_status` and always emit
`statusLine: null`, including for stored agents with an earlier status. The optional object-or-null
field remains compatible with released clients and older daemons, which may emit a status or omit
the field. Pending `stories.set-status` durable calls complete without changing agent metadata.

Last activity is additive and does not increment the protocol version. Current daemons emit the
agent's `lastActivityAt` on every full agent object and in `agent.updated` changes when it moves.
Older daemons omit it; clients then fall back to what they used before, such as `updatedAt`.

Provider CLIs are additive and do not increment the protocol version. A daemon that serves the
routes under `/v0/provider-clis` and the `provider_cli.updated` event reports
`capabilities.providerClis: true` from health. Older daemons omit it and answer the routes with
`404`; clients then offer only the manual terminal path for installing and signing in.

Stories is retired. Current daemons omit `capabilities.storyFeed`, answer every `/v0/stories`
route with `404 not_found`, and emit no new `story.changed` or `story.removed` events. Stored
personal or bot Stories settings cannot enable it. Published client types remain readable for
older daemons, and historical message quotes and their still-frame route remain available.

The Feed is additive and does not increment the protocol version. A daemon that serves the routes
under `/v0/feed` and the `feed.*` events reports `capabilities.feed: true` from health and
includes `feedUnread` in desktop bootstrap. Older daemons omit both, answer the routes with
`404`, and never emit the events; clients then show no Feed. `POST /v0/tasks/:taskId/read` and
`POST /v0/agents/:agentId/read` keep their requests and responses; on a daemon with the Feed they
also mark the subject seen.

Feed entries carry references only. This change departs from the additive rule above, as Steve
directly instructed: the first Feed daemons sent a `snapshot` on every feed item and peek entry,
and a `name` on every cluster, copied from the subject when the change happened, so a rename or a
task naming itself left the Feed showing a stale title. Current daemons send neither field, and
send `latest` on every entry instead. Clients render every entry from the entities they sync (see
"Showing an entry" in the Feed chapter) and never read `snapshot` or a cluster's `name`. A client
that reads them breaks against a current daemon. One that does not works with both: the first
daemons send no `latest`, and their extra fields are ignored like any other unknown field.

Provider routes are additive and do not increment the protocol version. A daemon that serves
`GET /v0/provider-routes` and `POST /v0/provider-routes/:routeId/use` reports
`capabilities.providerRoutes: true` from health. Older daemons omit it and answer the routes with
`404`.

Daily usage is additive and does not increment the protocol version. A daemon that serves
`GET /v0/usage/daily` reports `capabilities.dailyUsage: true` from health. Older daemons omit it
and answer the route with `404`; clients then show no activity grid.

By explicit product decision, three experiments are removed as a one-off exception to additive
compatibility: Spaces (the sidebar document, stem cells, sidebar proposals, and Prioritizing),
Stories with their stickers, and onboarding in Happy's conversation with its inline actions and
action messages. The protocol number does not change. The daemon answers their routes with `404`,
emits none of their events, no longer serves the `sidebar`, `sidebar_proposal`, or `story` artifact
types, and no longer reports `stemCellIdentities`, `sidebarOperations`, `sidebarAttachments`,
`sidebarProposals`, `sidebarSeparatorPins`, `stories`, `agentStories`, `stickers`, `onboarding`, or
`chatActions` from health. Clients treat it as a daemon that never had them: they draw the sidebar
from bots, tasks, and Surfaces, and run their own onboarding against `GET /v0/onboarding` and
`POST /v0/onboarding/complete`.

Artifact covers and summaries are additive and do not increment the protocol version. A daemon
that has them reports `capabilities.artifactCovers: true` from health and always includes `cover`
and `summary` on artifact and version objects, `null` when unset, and in the `changes` of
`artifact.updated`. Older compatible daemons omit both fields and the capability, and ignore a
`cover` or `summary` sent to them; a client treats a missing field as `null` and shows every
artifact without a cover or summary.

Artifact media metadata and previews are additive and do not increment the protocol version. A
daemon that has them includes `width`, `height`, `durationMs`, `thumbhash`, and `preview` on the
artifact file objects it measured, as described under "Media metadata" in Artifacts, and serves
`GET /v0/artifacts/:artifactId/versions/:number/previews/*path`. A cover with a preview repeats
it as the cover object's own `preview`. Older compatible daemons omit the fields and answer the
preview route `404`; a client then falls back to the whole file or the type's glyph.

The Feed subject filter is additive and does not increment the protocol version. A daemon that has
it reports `capabilities.feedSubjectFilter: true` from health, accepts `subjects` on `GET /v0/feed`
and `POST /v0/feed/read-all`, and adds `filteredUnread` to a filtered page. Older compatible
daemons omit the capability, ignore the query parameter, and refuse `subjects` in the read-all body
with `400`. A client that meets such a daemon filters the pages it already holds itself, keeps
paging until it fills a screen, and closes a filtered view's entries with `POST /v0/feed/seen`
instead of read-all.

Drain intent is additive and does not increment the protocol version. A daemon that supports it
accepts the optional `POST /v0/drain` body and includes `drain` in the drain response, health, the
`hello` frame, and the `daemon.draining` event, as described under Daemon lifecycle. Older
compatible daemons ignore the request body and omit every `drain` field; clients then cannot tell a
restart from a shutdown and treat the drain as they did before.

### Requests and responses

- Request and response bodies are JSON, `content-type: application/json; charset=utf-8`.
- Responses carry `Cache-Control: no-store` unless an endpoint explicitly documents a cacheable
  response. Avatar, profile-photo, and slash-command image responses are private-cacheable as
  described below, and artifact files, vault content, and tool-call media document their own caching; JSON and
  error responses remain non-cacheable. Remote API proxies preserve the upstream caching headers.
- Timestamps are Unix epoch milliseconds unless stated otherwise.

### Image caching

Project avatars, node avatars, bot avatars, the authenticated user's profile photo (in standalone
and team mode), and slash-command artwork share one caching policy. Both `200` and `304`
responses carry `Cache-Control: private, max-age=3600, stale-while-revalidate=86400`,
`Vary: Authorization`, and the content-derived `ETag`.

The image may be reused from the browser's private cache for one hour after fetching or
successful validation. During the following 24 hours, a request may serve the stale cached
image immediately while revalidating it in the background with `If-None-Match`. Beyond that
window, the cached image must be validated before reuse. Shared caches must not store it, and
private caches must distinguish requests by authorization. This policy does not schedule
requests or automatically replace an image already displayed by the client.

Clients should invalidate displayed images after a known change and clear them after removal
rather than waiting for cache expiry. ThumbHashes are placeholders, not content identities.
Missing images return `404`, even when a conditional request names the removed image. All error
responses retain `Cache-Control: no-store`. Older compatible daemons may continue to return
`Cache-Control: no-store` for successful image responses.

### Errors

Failed requests return an appropriate 4xx/5xx status with a JSON body:

```json
{ "error": "Human-readable message.", "code": "not_found" }
```

- `error` — a human-readable English message, for display and logs. Never match on its text.
- `code` — a stable, machine-readable snake_case string naming the failure. Clients branch on
  `code`; the set grows with the product, and an unrecognized code is treated by its status
  class. Common codes: `invalid_request` (400), `unauthorized` (401), `not_found` (404),
  `conflict` (409, the generic `If-Match` and state conflicts), `cursor_unavailable` (the
  events `409`), `hash_mismatch` (the file-write `409`), `not_initialized` (a workspace still
  building), `forbidden` (403), `cloud_not_authenticated` (409), `cloud_unauthorized` (409),
  `cloud_unavailable` (503), `draining` (503, the daemon no longer
  admits mutations), `runner_unavailable` (503, the folder's runner is not connected or no longer
  configured), `local_execution_disabled` (409, runners are configured, so nothing runs on the
  daemon's own machine),
  `method_not_allowed` (405, a withdrawn write method on a resource that remains readable),
  `too_large` (413), `range_not_satisfiable` (416, an artifact or vault file `Range` outside the
  file), `name_taken` (409, a vault folder or file name already used in its folder),
  `settings_full` (409, a person's user settings are at their limit), `unsupported` (501),
  `internal` (500).

An error body may carry additional fields alongside `error` and `code` when the endpoint
documents them. A `401` may carry `authentication`, described under Authentication. Unexpected
internal failures return `500` with a generic message; internal details (paths, tokens, provider
diagnostics) are never exposed through error bodies.

### Identifiers

Nearly every identifier in this API — project, workspace, agent, message, run, and terminal IDs
among them — is a [CUID2](https://github.com/paralleldrive/cuid2): a lowercase alphanumeric string
that is opaque, URL-safe, and carries no embedded meaning. Secret IDs are the named-credential
exception described in the secrets chapter. In particular, CUID2s do not sort by creation time.
Clients compare IDs for equality and nothing else; when an ID is used as a paging cursor, the
daemon resolves its position — the client never needs to order IDs itself.

A client-supplied ID in a request body — a project's `projectId`, an agent's or message's `id`,
and the agent, workspace, and run IDs that requests name — must be a lowercase ASCII letter
followed by lowercase ASCII letters and digits, 2–96 characters in all (`^[a-z][a-z0-9]+$`). A
new workspace's own `id` is limited to 32 characters. Anything else, including a UUID, uppercase
letters, hyphens, or underscores, is `400 invalid_request`. A freshly generated CUID2 always
qualifies.

The two version-like identifier kinds are both **UUIDv7** — time-ordered, so greater means newer:
event cursors (defined in the events chapter) and resource versions (next section).

### Resource versions and `If-Match`

Every resource that appears in version-chained `*.updated` events — projects, workspaces,
terminals, agents, bots, tasks, artifacts, secrets, surfaces, todos, vault folders, files, and settings, questions, processes, and the profile — carries a `version`
field: a **UUIDv7** minted at the moment of the change. Because versions are time-ordered, a
client holding two copies of the same resource compares their versions and keeps the greater
one; this is how a REST snapshot and the event stream reconcile without bookkeeping. Versions
also chain updates together: every `*.updated` event names the version it replaced, so a client
can tell whether its cached copy is current or dirty (see the events chapter).

Mutations of projects, workspaces, bots, tasks, artifacts, secrets, todos, calendar events, chat
Surface messages, vault folders and files, and the profile additionally require an `If-Match` header carrying the version
the client last saw. Creation is excepted, and so are per-person memberships and their order, such
as joining, leaving, and reordering a task. Two mutations of things that are not event-chained
resources also require it, each with the version its own section names: enabling or disabling a
global skill, and reordering remote connections. The header carries the version alone:

```
If-Match: 01991f3a-5c1e-7000-8000-2f9a1b3c4d5e
```

A missing or malformed header is `400`. A stale version is `409` carrying the authoritative
resource, so the client can catch up without another request:

```json
{
    "error": "The project has changed.",
    "code": "conflict",
    "currentVersion": "01991f3a-6d2f-7000-8000-3a0b2c4d5e6f",
    "project": {
        /* current row */
    }
}
```

The other versioned resources (agents, terminals, questions, processes) change mostly
on the daemon's own initiative, so their mutations do not use `If-Match`; their versions exist for
event chaining and newer-copy comparison.

The `agents` arrays embedded in projects and workspaces contain independently versioned,
user-visible root-agent resources. An owner's version covers the active membership and order of
that series; each embedded agent's version covers its own state. Creating, reordering, archiving,
or unarchiving an agent changes the visible owner series and advances the owner, while the
permanent owner association and fractional key survive archival. Other agent-only state changes
use `agent.updated` without advancing the owner. Clients merge nested agents by their own versions.
Ordinary subagents are absent. A root managed by an agent in another workspace is included and
identifies that exceptional ancestry through its agent capability flags.

### `mutationId`

Every state-changing mutation emits a change event to all connected clients, including the one
that made the change. Mutation bodies therefore accept an optional `mutationId`: an opaque client-chosen
string the daemon echoes verbatim in the change events that mutation produces. A client doing
optimistic updates checks arriving events against its in-flight mutation IDs — a match means
"that is my own change coming back," no match means someone else's. The daemon never interprets
it; it is not an idempotency key, and it does not dedupe retries.
Document revisions additionally retain this value as immutable metadata for recognizing a committed
save after its response and change event were lost; this does not change its echo-only semantics.

User messages do not need this dance at all: the client names the message itself by supplying
its `id` to `send`, so the optimistic copy and the durable message are one message from the
start — see `POST /v0/agents/:agentId/send`.

### Archival, and permanent deletion

Clients never permanently delete anything durable through this API. Projects, workspaces, agents,
bots, and tasks **archive**: they leave the active lists but keep their history and can be
inspected. Only agents, bots, and tasks can be unarchived for now; an archived project is revived
by registering its path again, and an archived workspace or subtask stays archived. There are no
hard-delete endpoints. The only things that end through the API are runtime state — a terminal, a
background process — and the transcript resets described under `message.deleted`. Artifacts are
the one resource a client deletes rather than archives, and their deletion is a tombstone: the
artifact leaves the lists and stops serving its content, but its record stays readable and its
stored content stays on the daemon's disk. Todo deletion also records a tombstone: every version
remains readable and can be reverted or unarchived.

Vaults are the one place where durable data ends on the daemon's own schedule. A vault's
retention policy, which its people set, removes old file versions, and Trash items are removed
after the policy's Trash period; see [Vault Surfaces](#vault-surfaces). No route deletes a
version or an entry directly.

#### Permanent deletion

From protocol 33, an active admin bot can permanently delete one bot, task, subtask, project, or
workspace, archived or still active, through its own agent tools; there is still no HTTP endpoint
for it. Deletion is irreversible. It removes:

- every agent that belongs to the item, at any depth, hidden subagents included, with its whole
  conversation: messages, runs, pending messages, and agent state;
- for a bot or task, its catalog row, memberships, picture, and folder;
- for a workspace, its row, its agent placements, its child workspaces, its resident subtask, its
  folder or worktree whatever the folder's keep-on-archive settings say, and the Git branch the
  worktree was cut as;
- for a project, every workspace cut from it, its root agents, its settings, picture, and row,
  and the folder the daemon cloned it into. A folder a person registered as a project is never
  removed;
- for a subtask, the workspace it is the resident subtask of, if any.

The admin previews the deletion first, which lists everything above and changes nothing, then
confirms it with the preview's confirmation code. The confirmation is refused when what would be
removed has changed since. A deletion that would reach the admin bot's own agent, or any agent it
runs inside, is refused, and so is deleting the home project. Confirming stops every agent
involved and archives whatever is still active in one transaction, so clients first see the usual
`*.updated` archival events; the removal itself then completes durably in the background and
announces each removed resource with its `*.removed` event.

## Endpoints

### Node configuration

A node is this Happy Agent installation, not a conversation agent, bot, human profile, or
daemon process. Its display name and optional avatar are installation-wide and survive restart.
They are available in standalone and team deployments through the same authenticated API.

The installation's display information belongs to `config.node`, returned by `GET /v0/config`
and included through `config` in desktop bootstrap:

```json
{
    "config": {
        "node": {
            "name": "Steve's Mac",
            "avatar": { "thumbhash": "3OcRJYB4d3h3iIeHeEh3eIhw+j2w" }
        }
    }
}
```

- `name` — this installation's own display name, independent of `config.p2p.name`, the hostname,
  and any connection-roster label. It accepts 1–128 printable characters, including spaces and
  emoji. An unconfigured installation detects a useful machine display name, preferring the friendly
  device name where available, and persists that default in generated runtime configuration.
- `avatar` — `null` without an image, otherwise an object containing its base64 `thumbhash`
  placeholder. This nullable value alone indicates whether an avatar exists; there is no separate
  presence flag. Image bytes and local filesystem paths never appear in this snapshot.

There is no separate node snapshot, resource version, or node-information event. These are additive
capabilities: an older protocol-22-or-later daemon may omit `config.node` and return `404` for the
avatar endpoint.
Clients treat that as unavailable node information, not as an incompatible daemon or proof that
an avatar is absent. They must not substitute `config.p2p.name` as the node's own name.

#### `GET /v0/node/avatar`

Serves the current avatar's image bytes with the correct image `Content-Type`, the normal bearer
authentication, and a content-derived `ETag`. `If-None-Match` matching the current image returns
`304` with no body. No avatar returns `404` with `code: "not_found"`, even when a conditional
header names a removed image. Successful and conditional responses use the shared image-caching
policy above.

Clients show the ThumbHash while fetching the image. After `config.updated`, they refetch config
and conditionally refetch the image when one is present, even if the ThumbHash is unchanged.
The ThumbHash is a placeholder, not a content identity. Clients serialize config refreshes and
repeat a refresh when an invalidation arrives during an in-flight read, so a stale response cannot
consume a newer change. Follow events from desktop bootstrap's cursor and refetch on a cursor gap
or daemon replacement.

#### Changing node information

The node name is a machine setting, not a project setting: `[node] name` may be configured in
global `happy.toml`, and live changes are persisted in generated `runtime.toml`. It never aliases,
reads, or writes `p2p.name`. Rename it through `PATCH /v0/config` with
`{ "node": { "name": "Studio Mac" } }`, using the existing config mutation and notification path
without `If-Match`. The response is the normal full `config` response. Omitting `node.name`
leaves it unchanged. Invalid names or unsupported fields inside `node`, including `avatar`, return
`400` with `code: "invalid_request"`. Team callers changing `node.name` must be the configured
owner; another onboarded member receives `403` with `code: "forbidden"`, and the entire patch is
rejected without applying other fields. Standalone callers use the normal bearer authorization.

Active admin bots additionally have `set_node_name` and `set_node_avatar` tools. The former takes
`name` and uses the same name-setting operation. The latter takes `path`, an absolute local image
path, or `null` to clear the avatar. Both return the current `{ "name": ..., "avatar": ... }`
configuration object, exactly as it appears at `config.node`.
Admin-bot authority is checked again at execution; ordinary agents, non-admin bots, and archived
admin bots cannot mutate this installation information through these tools. Both tools use the
shared permission review boundary; reading an image outside the workspace requires the normal
filesystem review and elevation. There are no HTTP avatar-upload or avatar-delete routes.

Images must be valid PNG, JPEG, or WebP, at most 8 MiB of input and at most 40 million decoded
pixels. Image decoding is bounded. The daemon normalizes the image and computes the ThumbHash
itself; tools never accept a caller-supplied ThumbHash. It retains its own durable image bytes,
so moving or deleting the source file does not remove the avatar. Invalid or oversized images,
unreadable paths, denied permissions, and failed mutations leave the current configuration,
avatar bytes, and event stream unchanged.

A name change, avatar replacement, or avatar removal publishes the existing `config.updated`
event with its unchanged empty payload after committing. Setting the current name, reapplying
identical normalized bytes, or clearing an absent avatar is a no-op. Avatar bytes and metadata
commit together. Changes are serialized, transaction-composable, and publish only after commit;
concurrent changes cannot lose the name or pair one image's ThumbHash with another image's bytes.

### Remote connections

The main daemon owns a roster of remote Happy Agent installations and their connections: Tailcat
connections from machine configuration, and HTTPS server connections added by URL. These are separate daemons, not Agent Base subagents: each remote owns its
projects, agents, profile, event journal, and lifecycle. The same connection API serves team
deployments and standalone secondaries. Tailcat provides encrypted connectivity, not application
authorization. Managed connections use WorkOS or fixed bearer authentication; they do not require
the former invitation/emoji pairing flow.

Machine configuration and tools restricted to active admin bots may add, replace, or remove
roster entries. Tool authority is rechecked at execution.
Public HTTP callers may reorder existing entries. The standalone owner may also add and remove
server connections by URL through the routes below, but cannot mutate managed Tailcat entries.
Project configuration cannot register connections or supply credentials. Live changes are
persisted in generated `runtime.toml`; configured connections are restored after restart.
Removing a connection closes its transport and active requests, but never deletes remote data.

Machine configuration uses `[connections.<id>]`, with `name`, `address` (a case-sensitive Tailcat
address blob), and optional `port` (default `24779`). Each entry has exactly one authentication
setting: `token` for a standalone remote, or `workos_organization_id` for a team remote. An entry
may instead have `url`, the normalized HTTPS URL of a server connection by URL; it takes no
`address`, `port`, or credential setting, because the person signs in to it. IDs match
`[a-z][a-z0-9_-]{0,63}`, names contain 1–256 printable characters, tokens use the standalone token
format, and ports are integers from 1 through 65535. At most 100 entries may be configured.
Runtime entries override global entries by ID; a runtime entry with `enabled = false` hides that
global connection. An enabled entry is complete rather than merging credential fields.

Every public connection has a required, opaque fractional `orderKey`, compared lexicographically
as on projects. Ordering is daemon-owned, persists across restarts, and is independent of
transport configuration. A new migration fills missing keys for existing connections in their
previous ascending ID order before the roster is served. Newly enabled connections append after
the last existing connection; adding several together uses ascending ID order among those new
connections. Renaming or replacing an enabled connection preserves its key. Removing and later
re-adding a connection appends it to the end. Existing database migrations remain unchanged.

#### `GET /v0/connections`

Returns the enabled configured roster in ascending `orderKey` order, with ID as the tie-breaker,
without probing remote health. This
read remains available when a remote is unreachable or Cloud is disconnected. Response — `200`:

```json
{
    "version": "01991f3a-6d2f-7000-8000-3a0b2c4d5e6f",
    "connections": [
        {
            "id": "build-mac",
            "name": "Build Mac",
            "authentication": "bearer",
            "orderKey": "00000000000000000001"
        },
        {
            "id": "engineering",
            "name": "Engineering",
            "authentication": "workos",
            "organizationId": "org_01H...",
            "orderKey": "00000000000000000002"
        },
        {
            "id": "happy-example-com",
            "name": "happy.example.com",
            "authentication": "oauth",
            "url": "https://happy.example.com/",
            "instanceId": "k3x9q2m7p0a4b8c1d5e6f7g2",
            "orderKey": "00000000000000000003"
        }
    ]
}
```

Tokens, raw configuration, and Tailcat addresses are never returned. An `oauth` entry is a server
connection by URL, and its `url` is returned because it is the address the person entered, not a
secret. Every entry kind may carry an optional `instanceId`: the remote's own health `instanceId`,
once the main daemon has read a health response from that remote, whether its own probe or one it
relayed. The daemon persists it, and learning or changing it advances the roster version like any
other roster change. Clients use it to open instance links, described under Happy links. `version` is an additive,
optional UUIDv7 for compatibility with older daemons; current daemons always include it. It names
the complete public roster, advances monotonically only when that roster changes, and persists
across restarts. Credential or transport changes that leave the public roster identical do not
advance its version or emit a roster update. The roster is not included in bootstrap.
`connections.updated` carries the complete versioned roster, not an invalidation or diff.
Older protocol-22-or-later daemons may return `404`; clients treat that as an unavailable feature,
not an incompatible daemon. Older daemons that serve the unversioned endpoint but do not emit the
additive event may still be polled.

To close the initial snapshot/stream race, clients first obtain an event cursor (for example,
desktop bootstrap's cursor), then fetch the roster, then follow events after that cursor. On
`connections.updated`, they replace the entire roster if its version is greater than their stored
version. Equal or older versions are ignored, including a delayed list response that arrives
after a newer event. On a cursor gap or daemon replacement, clients refetch the roster and resume
the stream using the normal snapshot/cursor rules. A restart with unchanged configuration keeps
the same roster version; startup reconciliation incorporates offline machine-configuration edits
before serving the roster. The event carries no health status. The authentication discriminator says how the main daemon
authenticates to the remote: `workos` identifies a team remote, `bearer` a standalone remote, and
`oauth` a server connection by URL that the person signs in to. A client that does not know a
discriminator value shows the entry as an ordinary remote.

#### `POST /v0/connections/:id/reorder`

Moves an enabled connection in the installation-wide roster. Requires normal API authentication
and local profile onboarding in team mode, but not admin-bot authority: this changes only display
order, never membership, credentials, or transport settings. Requires `If-Match` with the current
roster version returned by `GET /v0/connections`.

Request: `{ "afterId": "build-mac", "mutationId": "..." }` — the enabled connection to place this
one after, or `null` to move it first. `mutationId` is optional and has the usual echo-only meaning.

Response — `200`: `{ "connections": [ ... ], "version": "..." }`, the complete ordered roster.
Reordering assigns only the moved connection a fractional `orderKey` between its destination
neighbours. Neighbour keys remain unchanged. An actual move advances the roster version and
publishes one `connections.updated` event with the same complete snapshot and mutation echo after
commit. Moving a connection to its current position is a no-op, preserving its key and roster
version and emitting no event. Reordering never closes transports or interrupts active requests.

An unknown or disabled target or `afterId` is `404 not_found`; placing a connection after itself
or supplying an invalid body is `400 invalid_request`. A missing or malformed `If-Match` is
`400 invalid_request`. A stale version is `409 conflict` with `currentVersion` and the current
ordered `connections`. Rejected operations change no keys, version, transport, or events.
Concurrent roster changes and reorders are serialized and transaction-composable; persistence
commits before memory or notifications change. The response and event expose no credentials or
transport addresses. Older daemons without this endpoint return `404`; callers leave reordering
unavailable there. Older daemons may omit `orderKey`; this required field is guaranteed by the
ordering-capable daemon after migration, not synthesized by clients for older daemons.

#### Server connections by URL

A server connection by URL connects a standalone daemon to a team server by its HTTPS URL, with no
Tailcat, Happy Cloud, or WorkOS dependency. The team server may sit behind a load balancer that
enforces single sign-on, as described under Load balancers and edge authentication.

The main daemon holds no credential for the server. It is a proxy: the app signs in to the server
itself, keeps the tokens, and sends the current access token with every request it makes through
`/v0/connections/:id/api/*`, as described there. The daemon passes that token to the server and
forgets it when the request ends. It never stores, refreshes, logs, or returns a token, and never
includes one in an event or error.

The app signs in with the rules under Sign-in flow. It reads the server's discovery directly from
`<url>v0/authentication`, uses its first `oauth` method with the redirect URI
`happy://oauth/callback`, sends `resource` when the method advertises one, and refreshes when the
method has a `refreshUrl`. Where the app keeps its tokens follows the same section.

Only a request that carries the header reaches the server. Agents on the main daemon cannot use a
server connection by URL: their requests carry no `Happy-Remote-Authorization` and are answered
`403 remote_sign_in_required`. Phones do not use server connections by URL at all; they connect to
the team server directly and keep their own tokens.

Server connections by URL exist only in standalone mode. A person adds one by asking an active
admin bot, such as the Chief of Staff, whose tool takes the server's URL, or by listing it in
machine configuration as a `[connections.<id>]` entry with a `url`; like every other entry, it is
removed the same ways. The standalone owner may also use the HTTP routes below. Added entries
are persisted in generated `runtime.toml`. In team mode a `url` entry is a configuration error, reported at
startup like any invalid entry, and an admin bot cannot add one.

A URL is normalized before use. It must be absolute and use `https`, or `http` with a loopback
host (`localhost`, `127.0.0.1`, or `[::1]`) for local testing. It must have no user information,
query, or fragment. The scheme and host are lowercased, a default port is removed, and the path
always ends in `/`, so `https://Happy.Example.com/team` becomes `https://happy.example.com/team/`.
API paths are resolved against it: the server's health is `<url>v0/health`. Two entries never
share one normalized URL.

Before adding a server, both the HTTP route and the admin bot's tool read
`<url>v0/authentication` without a credential, following no redirects. They add the server only
when discovery is a Happy response that lists an
`oauth` method, so a redirect or an edge sign-in page is refused. The ID is generated from the
URL's host, such as `happy-example-com` for `happy.example.com`, appending `-2`, `-3`, and so on
when the ID is taken, and the entry is appended to the end of the roster. Adding or removing one
publishes `connections.updated` after commit, like any roster change. Removing one closes its open
requests, streams, WebSockets, and tunnels and never deletes data on the server; the app discards
the tokens it kept for that server.

The roster learns the server's `instanceId` from its health: when the server is added, and from
every health response the daemon relays from it. An app reads
`GET /v0/connections/:id/api/v0/health` after signing in, so the roster has it from then on.

#### `POST /v0/connections/servers`

Protocol 34 adds a server by URL for the authenticated standalone owner. Body:
`{ "url": "https://team.example.com/", "name"?: "My team" }`. Unknown fields are refused.
`url` is a string of 1–2048 characters; optional `name` is 1–256 characters and defaults to the
normalized URL's host. Normalization, OAuth discovery, unique URLs, immutable server IDs, the
100-entry roster limit, persistence, and events follow the server rules above.

Response `200`: `{ "connections": [ ... ], "version": "..." }`, the complete current roster,
as returned by `GET /v0/connections`. The app signs in separately; no token is accepted or stored.

Errors: `401 unauthorized` without authentication; `403 forbidden` for a guest or non-owner;
`501 unsupported` for a team owner because URL connections are standalone-only;
`400 invalid_request` for an invalid body, URL, name, duplicate URL, full roster, or discovery
that does not offer OAuth (including redirects); `503 remote_unavailable` when discovery cannot
be reached or connections have stopped; `504 remote_timeout` when discovery times out.

#### `DELETE /v0/connections/:id`

Protocol 34 removes an enabled server connection by URL for the authenticated standalone owner.
No body or `If-Match` header is required. Response `200` is the complete current roster with its
`version`, as above. It closes the connection's streams and preserves the server's data and the
permanent reservation of its ID. It cannot remove managed Tailcat connections.

Authentication and team-mode errors are the same as addition. A missing, malformed, disabled,
or non-URL connection ID returns `404 not_found`. Stopped connections return
`503 remote_unavailable`.

#### `/v0/connections/:id/api/*`

This prefix exposes the selected remote's complete HTTP API. For example,
`GET /v0/connections/build-mac/api/v0/health` reaches that daemon's `GET /v0/health`; a trailing
`/api/` reaches its `/`. Methods, query strings, request bodies, conditional headers, response
statuses and bodies, SSE streams, terminal WebSocket upgrades, and workspace `CONNECT` tunnels
retain their remote semantics. The proxy strips only its routing prefix and transport-specific
hop-by-hop headers. It preserves upstream end-to-end response headers, including `Cache-Control`,
`ETag`, `Vary`, `Date`, `Age`, and `Expires` when present; it does not replace or synthesize an
upstream caching policy. Conditional requests and `304` responses retain these same semantics.
It does not follow redirects, buffer complete streams, replay requests, or
merge remote events into the main daemon's journal. Remote identifiers and cursors remain opaque
and belong to the selected client instance.

Every request first authenticates to the main daemon normally. Team callers must have completed
local profile onboarding. The main daemon replaces that request's authorization with the configured
remote bearer credential for a standalone secondary. For a team remote reached through a standalone
main, Cloud mints and verifies an organization-scoped WorkOS access token for the connected user
once, then reuses it from a bounded in-memory cache keyed by organization until its actual
expiration. Shortly before expiry, a request starts a background refresh and immediately uses the
still-valid cached token. Cached requests never wait for minting or refresh; only requests without
a token or with an expired token wait. Concurrent requests for the same organization share one
in-flight mint or refresh, including its failure; a later request may try again. A failed background
refresh does not prevent reuse of a still-valid token. Actual refresh-token rotations
remain serialized across organizations and are persisted through the existing authentication
boundary before verification. Cached tokens and in-flight results cannot cross a committed
sign-out, account or environment change, authoritative credential rejection, or daemon shutdown.
This internal reuse does not change `POST /v0/cloud/access-token`. For a team main,
the caller's authenticated bearer token is forwarded: a WorkOS access token must also authorize the
destination organization, and a JWT is accepted only by a remote with matching JWT team
authentication. The proxy never substitutes the team's owner identity. The remote independently
checks authentication, organization membership, and profile onboarding. Secrets are never returned
to clients, included in URLs, or exposed in errors or logs.

For an `oauth` connection, the main daemon carries the request over HTTPS to the connection's
`url`, with the remote path resolved against it. It removes `Happy-Remote-Authorization` and sends
its token to the server as `Authorization: Bearer <token>`, replacing the app's credential for
the main daemon. It sends the token nowhere else and follows no redirects. For any other
connection, `Happy-Remote-Authorization` is removed and ignored. The daemon applies the sign-in
rule under Credentials on the wire and signing in again to every remote answer, including
WebSocket upgrades:

- A request without `Happy-Remote-Authorization`, or with a value that is not `Bearer` and a
  token, is answered `403 remote_sign_in_required` without contacting the server.
- A redirect other than `304`, a `401` that is not a Happy error, or a `403` that is not a Happy
  error is never passed through, because the app would read it as its own daemon asking it to
  sign in. The request is answered `403 remote_sign_in_required` instead. The daemon never
  replays it; the app refreshes or signs in, then sends its own request again.
- A `401` that is a Happy error is checked as the rule describes, with `GET /v0/authentication`
  and the same token. `authenticated: false` is handled as in the previous item. Otherwise the
  `401` passes through unchanged, so the app sees the remote's profile gate and saves its profile
  through this proxy. A `401` on this prefix is therefore either the main daemon refusing the
  app's own credential or the remote's profile gate, never an expired remote token.
- Every other remote answer, including a `403` that is a Happy error, passes through unchanged.

`403 remote_sign_in_required` is a Happy error, so the app's own sign-in is unaffected; the app
refreshes its token for that server or asks the person to sign in to it. Terminal WebSocket upgrades are carried over `wss`.
The daemon pings the remote WebSocket every 15 seconds and closes the app's WebSocket with `1011`
after 45 seconds without a frame from the remote. An event stream from the remote that sends
nothing for 45 seconds ends, and the app resumes it from its cursor. Workspace, agent, network,
and artifact `CONNECT` tunnels and their WebSocket twins are carried over the remote's WebSocket
twin when the remote's health reports `capabilities.webSocketTunnels: true`. Against an older
remote they are answered `501 unsupported`, and the daemon never sends `CONNECT` to the remote.
Each request is still forwarded immediately and in parallel, as above.

An unknown or disabled connection is `404 not_found`. A transport failure before response headers
is `503 remote_unavailable`; a connection/header deadline of 30 seconds is
`504 remote_timeout`. After headers, a transport failure terminates the stream rather than
inventing a successful response or replaying a mutation. Cloud authentication failures retain
their existing stable Cloud error codes. Remote HTTP rejections pass through unchanged.
Cancellation, connection replacement/removal, and daemon shutdown close associated streams and
release resources. A connection does not limit concurrent requests or attachments: each one is
forwarded immediately over its own carrier stream, in parallel, and never waits behind another
request or an open stream. This is additive and does not increment the protocol version; an older
daemon may still reject overflow with `503 remote_busy`. Streams use backpressure and bounded
buffers. Reconnecting the carrier never replays an in-flight request; clients reconnect SSE using
the remote cursor.

`HappyAgentClient.listConnections()` reads the roster. `reorderConnection(id, request, options)`
moves one connection using the roster version as `options.ifMatch`.
`client.connection(id, options)` creates an independent client rooted at this proxy prefix,
reusing only the main endpoint, bearer token, and fetch transport. Its optional `remoteToken`, a
string or a function called for every request like `token`, is sent as
`Happy-Remote-Authorization`. All existing methods and attachment URLs then address the remote. The child has
no local replica state in common with its parent; consumers create a separate reducer when needed.
Child creation performs no network request and validates the connection ID. Protocol compatibility
is checked against the remote's health response, independently of the main daemon.

### Runners

A runner is a separate machine that does this installation's work. It holds project folders and
runs everything that touches them — agent file tools and commands, Git, workspace checkouts,
terminals, and the workspace proxy — while the daemon keeps the database, provider
credentials, and inference. A runner holds no provider credentials, no Happy data, and no API
token; it reaches the daemon only through `GET /v0/runners/connect`. Runners are optional. Once any
runner is configured, the daemon runs nothing on its own machine, unless `default = "local"` keeps
this machine the default.

Runners are machine configuration, like remote connections. Whoever deploys a node generates each
runner's token and writes it both to the node's machine `happy.toml` and to the runner machine, so
a runner can be provisioned before the node first starts and without an API call. There is no
invitation or join step. Project configuration cannot declare runners or tokens.

```toml
[runners]
default = "build-box"

[runners.build-box]
name = "Build box"
token = "REPLACE_WITH_FRESH_43_CHARACTER_BASE64URL_TOKEN"
```

- `[runners.<id>]` — one entry per runner. IDs match `[a-z][a-z0-9_-]{0,63}` and are not `local`;
  `name` has 1–128 printable characters; `token` uses the standalone token format and must differ
  from `[api] token`, every connection token, and every other runner's token. At most 32 runners.
- `default` — the runner used for a project registration or clone that names none, for the home
  project, and for bot, task, and Surface chat folders. Optional when exactly one runner is
  configured, which is then the default; required when there are several. It must name a
  configured runner, or be `"local"` to keep this machine the default.

An invalid entry fails configuration loading with a human-readable message. Tokens never appear
in the API, events, errors, or logs. Removing an entry and restarting the daemon revokes that
runner: the daemon refuses its token and tells the runner to stop everything it held. Replacing a
token likewise disconnects the runner until it is given the new one.

The runner software is given the daemon's endpoint and its own token. It dials the daemon, so it
needs no inbound port and works behind NAT; a standalone daemon is reached through its Tailcat
exposure, a team daemon through its listener. It keeps one connection open and reconnects when it
drops. Nothing a daemon starts on a runner outlives the daemon process: when the daemon restarts,
removes the runner, or stays away longer than the runner's lease, the runner stops everything it
held for it.

With `default = "local"`, this machine keeps running its own work exactly as with no runners: no
runner object is the default, a project registration or clone that names no runner, the home
project, and bot, task, and Surface chat folders stay on this machine, and nothing here fails with
`local_execution_disabled`. Only a project registered or cloned with a `runnerId` goes to that
runner, and everything below about work on a runner applies to it.

While runners are configured and one of them is the default:

- Projects, workspaces, bot folders, and the home project live on runners. The home project is the
  default runner's home directory.
- Registering or cloning a project without a runner, or using a folder that lives on this machine,
  fails with `409 local_execution_disabled`. Projects registered on this machine before runners
  were configured remain listed so they can be archived; their work fails the same way.
- Work on a folder whose runner is not connected, or is no longer configured, fails with
  `503 runner_unavailable`, naming the runner. Nothing falls back to this machine.
- Repository tokens never reach a runner. Git on a runner reaches the remote through a loopback
  address on the runner that leads back over the runner connection to the daemon, which adds the
  token itself, exactly as it does for Git on this machine. Attached secrets are resolved on the
  daemon: an agent command on a runner that selects attached secrets receives exactly the selected
  values with that one command, and the runner forgets them once the process has started. A
  runner too old to receive them refuses the command, asking for the runner to be updated. A
  command in a container, on a runner or here, that selects attached secrets is refused.
- A runner may run another operating system than the daemon. Paths on it follow its own rules, such
  as `C:\Users\happy\happy\workspaces\...` on a Windows runner under a Linux daemon, and folders
  are laid out as that system lays out its own. An agent working in a folder on a runner is told
  the runner's platform rather than the daemon's, and its operating system release and shell when
  the runner reports them.
- A runner project can run its workspaces in containers on the runner: with
  `defaultWorkspaceCompute` `{ "type": "docker", "image": "..." }`, every new workspace's agent
  file tools and commands run in a container of that image on the runner, with the workspace
  folder mounted at the same path. Git, terminals, and the workspace proxy work on the runner's
  copy of the same folder. The runner needs Docker; without it the agent's first tool call fails
  with a message naming the runner.

#### The runner object

```json
{
    "id": "build-box",
    "name": "Build box",
    "default": true,
    "status": "connected",
    "machine": {
        "version": "2026.11.1",
        "platform": "linux",
        "arch": "x64",
        "hostname": "build-1",
        "home": "/home/happy-runner",
        "osVersion": "6.8.0-60-generic",
        "shell": "/bin/bash"
    },
    "protocol": 1,
    "since": 1755300000000,
    "reason": null
}
```

- `default` — whether this is the configured default runner. Every runner reports `false` while
  `default = "local"` keeps this machine the default.
- `status` — `"connected"` or `"disconnected"`.
- `machine` — what the runner reported when it last connected, kept across daemon restarts, or
  `null` before it has ever connected. For display and diagnostics, except `home`, which places
  the home project and bot folders, and `platform`, whose path rules name the runner's folders.
  `osVersion` — the operating system release, as an agent working on that machine is told it —
  and `shell` — the shell its commands run in — are optional; a runner too old to report them
  omits them.
- `protocol` — the runner protocol version in use, or `null` while disconnected.
- `since` — Unix milliseconds of the last status change.
- `reason` — a human-readable reason for the last disconnection, or `null`.

#### `GET /v0/runners`

Returns the configured runners in ascending ID order. Requires normal API authentication and, in
team mode, local profile onboarding. Response — `200`:

```json
{
    "version": "01991f3a-6d2f-7000-8000-3a0b2c4d5e6f",
    "runners": [
        /* runner objects */
    ]
}
```

`version` is a UUIDv7 that advances whenever any runner object changes, including connection
status. `runners.updated` carries the same complete list after every change. To close the
snapshot/stream race, clients obtain an event cursor first, then fetch the list, then follow events
after that cursor, replacing their list only with a greater version. On a cursor gap or daemon
replacement they refetch. Tokens and transport addresses never appear. Older compatible daemons
answer `404`; clients treat runners as unavailable.

`HappyAgentClient.listRunners()` reads the list.

#### `GET /v0/runners/connect`

A WebSocket upgrade used only by the runner software. `Authorization: Bearer <runner token>`
identifies the runner; no other credential is accepted on this route, and a runner token is
accepted on no other route. An unknown token is refused with `401` before the upgrade. Binary
frames carry the runner protocol specified in `@slopus/happy-agent-compute`
(`sources/runner/README.md`), which is versioned independently of this API; a text frame closes
the connection. A newer connection with the same token replaces the older one.

### Exported bots

An exported bot is a Happy bot that people reach from an outside chat service. Admin bots export
a bot, change or pause its export, and stop exporting it with their own tools; this API has no
exported-bot management routes. Exports are additive and do not increment the protocol version;
older daemons answer `GET /v0/exported-bots/connect` with `404`.

Telegram is built in: the daemon talks to the Telegram Bot API itself. Any other service is
reached through a bridge: a program that runs on the daemon's machine, talks to the chat
service, and connects to the daemon. Exporting a bot through a bridge, or rotating its token,
writes a new random bridge token to a file the admin bot names. The daemon stores only the
token's SHA-256 digest. A bridge token identifies exactly one exported bot and grants nothing
else.

Each person an admin bot lets in becomes a guest user (see Team users) and talks to the bot in
their own subtask under it. Their messages are user messages attributed to that guest through
`metadata.userId`. A guest's message is the guest's own request: it is never the installation
owner's or a team member's instruction or authorization, including in Auto permission review,
and it always runs in `auto` permission mode, whatever mode earlier messages in that subtask
selected.

#### `GET /v0/exported-bots/connect`

A WebSocket upgrade used only by bridges. `Authorization: Bearer <bridge token>` identifies the
exported bot; no other credential is accepted on this route, and a bridge token is accepted on no
other route. A standalone bridge connects through the daemon's Unix socket and a team bridge
through its TCP listener.

The optional `protocol` query parameter selects the bridge protocol version and defaults to `1`.
Before the upgrade the daemon answers:

- `400 unsupported_protocol`: the requested version is not one this daemon speaks.
- `401 unauthorized`: the token is unknown, was rotated, or its bot is no longer exported.
- `503 exported_bot_unavailable`: the export is turned off or its bot is archived.
- `503 not_initialized`: the daemon is still starting.

After the upgrade, UTF-8 JSON text frames carry the bridge protocol specified in
`docs/exported-bot-protocol.md`, which is versioned independently of this API. A newer
connection with the same token replaces the older one, which is closed with code `4000`.

### `GET /`

A friendly greeting confirming the caller reached a Happy agent. It carries no state and no
identity; use health for anything machine-readable.

Response — `200`:

```json
{ "text": "Welcome to Happy Agent!" }
```

### `GET /v0/health`

Reports whether the daemon is alive and whether it is ready to serve the full API, and carries
enough identity for a client to decide whether it can talk to this daemon at all.

The standalone daemon opens its socket before the agent system finishes loading, so health has two
readiness states. The team TCP listener is opened only after the user database and agent system are
ready, but reports the same ready representation:

- **Starting** — the socket is up but the agent system is not loaded. Only health is served;
  every other route returns an error. `ready` is `false` and `status` is `"starting"`.
- **Ready** — the agent system is loaded and all routes are available. `ready` is `true` and
  `status` is `"ready"`.

Graceful shutdown is reported separately from readiness. While graceful shutdown is in progress,
the socket and API remain available, `ready` stays `true`, and `status` stays `"ready"`.
`shuttingDown` is `true`, and `waitingFor` names the shutdown handlers that have not finished yet.
The list shrinks as handlers complete. Once no handlers remain, the daemon closes the socket and
exits the process without waiting for unrelated computations that still hold the Node.js event
loop open.

Draining is a separate phase before shutdown. A draining daemon remains healthy and ready for
reads, keeps `status` equal to `"ready"` for protocol-22 compatibility, and sets `draining` to
`true`. `drainWaitingFor` names the stable drain handlers that have not reached a safe edge yet;
each row includes the exact number of operations still holding that component open. Agent-system
rows also carry a bounded view of the individual agents and stages still running. The list shrinks
as handlers finish and an empty list means the daemon is drained. Draining does not stop the
daemon by itself. The daemon remains in read-only draining mode until a caller asks it to shut
down.

Response — `200`:

```json
{
    "healthy": true,
    "ready": true,
    "status": "ready",
    "version": { "protocol": 22, "daemon": "2026.11.1" },
    "instanceId": "k3x9q2m7p0a4b8c1d5e6f7g2",
    "draining": true,
    "drainWaitingFor": [
        { "name": "api-mutations", "count": 1 },
        {
            "name": "agent-system",
            "count": 2,
            "agents": [
                { "id": "abc123", "stage": "inference" },
                { "id": "def456", "stage": "tools" }
            ]
        }
    ],
    "drain": {
        "intent": "restart",
        "cause": "reload",
        "currentVersion": "2026.11.1",
        "targetVersion": "2026.11.1",
        "startedAt": 1755400000000
    },
    "shuttingDown": true,
    "waitingFor": ["agent-system", "main-database"]
}
```

Fields:

- `healthy` — always `true`; a daemon that cannot answer does not answer.
- `capabilities` — optional feature support. `desktopLiveControl: true` advertises the
  window-scoped GPT-Live control contract; missing or false means unavailable, independently
  of protocol version or provider entitlement. `workspaceBridges: true` advertises the local
  bridges described under Workspaces. Optional `desktopLiveCapabilities` lists the additive
  voice desktop capability names the daemon accepts; see Live voice sessions.
  `collaborativeDocuments: true` advertises collaborative document Surfaces, described under
  Document Surfaces. `calendarSurfaces: true` advertises calendar Surfaces, described under
  Calendar Surfaces. `systemMonitorSurfaces: true` advertises System Monitor Surfaces.
  `chatSurfaces: true` advertises chat Surfaces, described under Chat Surfaces.
  `vaults: true` advertises vault Surfaces and vault uploads, described under Vault Surfaces.
  `surfaceEditing: true` advertises renaming Surfaces and changing their images, described under
  Surface catalog and members. `providerClis: true` advertises the routes under
  `/v0/provider-clis` and the `provider_cli.updated` event, described under Provider CLIs.
  `providerRoutes: true` advertises the routes under `/v0/provider-routes`, described under
  Provider routes. `webSocketTunnels: true` advertises the WebSocket twins of the proxy tunnels,
  described under WebSocket tunnels, and the WebSocket keepalive pings described under Keepalive.
  `artifactCovers: true` advertises artifact `cover` and `summary`, described under Artifacts.
  `search: true` advertises `POST /v0/search`, described under Search.
  `feedSubjectFilter: true` advertises `subjects` on `GET /v0/feed` and
  `POST /v0/feed/read-all`, described under Feed. `dailyUsage: true` advertises
  `GET /v0/usage/daily`, described under Usage.
  `userEnvironment: true` advertises `PUT /v0/environment`, `deviceId` on agent sends, and the
  `user_environment.updated` event, described under User environment.
- `instanceId` — optional; this installation's identity, used by instance links under Happy links.
  It is a CUID2 of exactly 24 characters matching `^[a-z][a-z0-9]{23}$`, generated once and
  persisted with the installation's data, so it survives restarts and upgrades. It is reported
  while starting too. Older daemons omit it, and clients then offer no instance links for that
  daemon.
- `ready` — `false` while starting, `true` once the agent system is loaded.
- `status` — `"starting"` or `"ready"`; the human-readable form of `ready`.
- `version` — one identity object. `protocol` is the wire protocol number, the client's
  compatibility check; `daemon` is the product version string, for display and diagnostics.
- `draining` — optional for protocol-22 compatibility; `true` after draining begins and `false`
  otherwise. It remains `true` after the drain finishes, until the daemon exits.
- `drainWaitingFor` — optional for protocol-22 compatibility; structured progress for drain
  handlers that have not reached a safe edge. It is empty before draining, after draining
  completes, and when no draining support is installed. Every row carries a stable extensible
  `name` and an exact positive `count`. The `agent-system` and `auto-agent-system` rows also carry
  `agents`, sorted by ID and capped at 100 entries, each with `id` and the durable Base stage
  (`"inference"`, `"tools"`, `"compaction"`, or `"settlement"`). When more agents are waiting than
  fit, `truncated` is `true` while `count` remains exact. Non-agent rows omit `agents` and
  `truncated`.
- `drain` — optional for compatibility; the drain object described under Daemon lifecycle, saying
  whether this daemon process is going away to be restarted or to stay stopped. It is `null` until
  draining or graceful shutdown begins, and then stays the same object until the process exits.
  Older daemons omit it.
- `shuttingDown` — optional for protocol-22 compatibility; `true` while graceful shutdown is in
  progress and `false` otherwise.
- `waitingFor` — optional for protocol-22 compatibility; the stable names of graceful-shutdown
  handlers that have not finished. It is empty outside shutdown.

Health is the only endpoint guaranteed to answer during startup; clients should poll it until
`ready` is `true` before using the rest of the API.

### `GET /v0/authentication`

Checks the request's authentication and lists the ways a person can sign in. It is the only
endpoint that does not require a bearer token. It never rejects a missing or invalid token with
`401`; it reports it instead. It takes no parameters and ignores any query string. It has no side
effects, creates no user, emits no events, and contacts no authorization server.

Response — `200`:

```json
{
    "authenticated": false,
    "userId": null,
    "methods": [
        {
            "type": "oauth",
            "id": "jwt",
            "name": "Acme SSO",
            "authorizationUrl": "https://sso.acme.example/oauth/authorize",
            "tokenUrl": "https://sso.acme.example/oauth/token",
            "refreshUrl": "https://sso.acme.example/oauth/token",
            "clientId": "happy",
            "scope": "happy",
            "resource": "https://happy.acme.example"
        }
    ]
}
```

- `authenticated` — `true` only when the request carries a valid bearer token for this daemon.
- `userId` — the installation-local Happy user ID of an authenticated team member who has
  onboarded; otherwise `null`. Standalone requests always report `null`. It is never a WorkOS ID
  or a JWT user ID.
- `methods` — the available sign-in methods in display order, returned whether or not the request
  is authenticated. Each method has a stable `type` discriminator, a stable `id`, and a
  human-readable `name`. Clients ignore methods whose `type` they do not recognize. Standalone and
  WorkOS team deployments return an empty list.

An `oauth` method is completed with the authorization code flow and PKCE described under
Authentication. Its fields come from machine configuration unchanged:

- `authorizationUrl` — `authorization_url`, opened in the system browser.
- `tokenUrl` — `token_url`, where the client exchanges the authorization code.
- `refreshUrl` — `refresh_url`; present only when configured.
- `clientId` — `client_id`.
- `scope` — `scope`; present only when configured.
- `resource` — `resource`; present only when configured. Clients send it on the authorization,
  token, and refresh requests as described under Authentication.

These URLs come from the daemon, which clients do not trust with credentials. Clients refuse a
method whose `tokenUrl` or `refreshUrl` is on a different origin from `authorizationUrl`, show the
authorization server's host to the person before or during sign-in, send the code only to the
`tokenUrl` of the method they started with, refresh only as described under Authentication, and
send an access token only to the server its `aud` names.

### `GET /v0/config`

Returns a sanitized snapshot of the daemon's effective configuration — the merged result of
defaults and configuration files, not any one file. Secrets never appear: provider entries are
stripped of credentials and carry only their declared shape.

The response carries a top-level `models` map holding **every model the daemon knows** — the
curated catalog is source code, so the daemon always knows the full list. A model definition
carries everything a client needs to present it: display name, context window, allowed effort
levels, default effort, and supported service tiers. Provider entries do not repeat definitions; they reference
model IDs and say whether each is enabled on that provider. A model is enabled when its provider
is enabled and the provider's include/exclude filters admit it. The raw filter lists are
configuration input; the response carries only the derived answer.

Response — `200`:

```json
{
    "config": {
        "defaults": {
            "providerId": "codex",
            "modelId": "openai/gpt-5.6-sol",
            "effort": "medium",
            "permissionMode": "auto"
        },
        "features": {
            "crossWorkspace": false,
            "workflows": true,
            "workspaces": true
        },
        "mcpServers": {
            "linear": { "enabled": true, "transport": "http" },
            "playwright": { "enabled": false, "transport": "stdio" }
        },
        "network": {
            "allowedDomains": ["registry.npmjs.org", "github.com"],
            "deniedDomains": [],
            "allowedPorts": [443],
            "allowedLoopbackPorts": [3000],
            "allowLocalBinding": false
        },
        "node": {
            "name": "Steve's Mac",
            "avatar": { "thumbhash": "3OcRJYB4d3h3iIeHeEh3eIhw+j2w" }
        },
        "p2p": {
            "name": "steves-macbook",
            "role": "primary",
            "enableIroh": true,
            "enableDirect": false,
            "enableSsh": false,
            "exposeApi": false
        },
        "permissions": {
            "protectedPaths": ["master-plans", ".env"]
        },
        "presence": {
            "current": "online",
            "fallback": "online",
            "states": {
                "online": {
                    "title": "Online",
                    "emoji": "🟢",
                    "prompt": "The user is at the keyboard.",
                    "answerWaitMs": null
                },
                "away": {
                    "title": "Away",
                    "emoji": "🌙",
                    "prompt": "The user is away; do not wait for answers.",
                    "answerWaitMs": 0
                }
            }
        },
        "models": {
            "openai/gpt-5.6-sol": {
                "name": "GPT-5.6 Sol",
                "contextWindow": 272000,
                "autoCompactWindow": 244800,
                "efforts": ["low", "medium", "high", "xhigh", "max"],
                "defaultEffort": "medium",
                "serviceTiers": ["priority"]
            },
            "openai/gpt-5.6-terra": {
                "name": "GPT-5.6 Terra",
                "contextWindow": 272000,
                "autoCompactWindow": 244800,
                "efforts": ["off", "low", "medium", "high", "xhigh", "max"],
                "defaultEffort": "medium",
                "serviceTiers": ["priority"]
            },
            "openai/gpt-5.6-luna": {
                "name": "GPT-5.6 Luna",
                "contextWindow": 272000,
                "autoCompactWindow": 244800,
                "efforts": ["off", "low", "medium", "high", "xhigh", "max"],
                "defaultEffort": "medium",
                "serviceTiers": ["priority"]
            },
            "anthropic/opus-5": {
                "name": "Opus 5 1M",
                "contextWindow": 1000000,
                "autoCompactWindow": 400000,
                "efforts": ["off", "low", "medium", "high", "xhigh", "max"],
                "defaultEffort": "medium",
                "serviceTiers": []
            },
            "anthropic/sonnet-5": {
                "name": "Sonnet 5",
                "contextWindow": 1000000,
                "autoCompactWindow": 400000,
                "efforts": ["off", "low", "medium", "high", "xhigh", "max"],
                "defaultEffort": "medium",
                "serviceTiers": []
            },
            "anthropic/fable-5": {
                "name": "Fable 5",
                "contextWindow": 1000000,
                "autoCompactWindow": 400000,
                "efforts": ["off", "low", "medium", "high", "xhigh", "max"],
                "defaultEffort": "medium",
                "serviceTiers": []
            },
            "anthropic/opus-4-8": {
                "name": "Opus 4.8 1M",
                "contextWindow": 1000000,
                "autoCompactWindow": 400000,
                "efforts": ["off", "low", "medium", "high", "xhigh", "max"],
                "defaultEffort": "medium",
                "serviceTiers": []
            },
            "xai/grok-4.6": {
                "name": "Grok 4.6",
                "contextWindow": 500000,
                "autoCompactWindow": 450000,
                "efforts": ["low", "medium", "high", "xhigh"],
                "defaultEffort": "high",
                "serviceTiers": []
            },
            "xai/grok-build": {
                "name": "Grok Build",
                "contextWindow": 500000,
                "autoCompactWindow": 450000,
                "efforts": ["medium"],
                "defaultEffort": "medium",
                "serviceTiers": []
            },
            "xai/grok-4.5": {
                "name": "Grok 4.5",
                "contextWindow": 500000,
                "autoCompactWindow": 450000,
                "efforts": ["low", "medium", "high"],
                "defaultEffort": "high",
                "serviceTiers": []
            },
            "xai/grok-composer-2.5-fast": {
                "name": "Composer 2.5",
                "contextWindow": 200000,
                "autoCompactWindow": 180000,
                "efforts": ["off"],
                "defaultEffort": "off",
                "serviceTiers": []
            }
        },
        "providers": {
            "claude": {
                "name": "Current CLI",
                "type": "claude",
                "enabled": true,
                "hidden": false,
                "models": [
                    { "id": "anthropic/opus-5", "enabled": true },
                    { "id": "anthropic/sonnet-5", "enabled": true },
                    { "id": "anthropic/fable-5", "enabled": true },
                    { "id": "anthropic/opus-4-8", "enabled": false }
                ]
            },
            "codex": {
                "type": "codex",
                "enabled": true,
                "hidden": false,
                "models": [
                    { "id": "openai/gpt-5.6-sol", "enabled": true },
                    { "id": "openai/gpt-5.6-terra", "enabled": true },
                    { "id": "openai/gpt-5.6-luna", "enabled": true }
                ]
            },
            "grok": {
                "type": "grok",
                "enabled": false,
                "hidden": false,
                "models": [
                    { "id": "xai/grok-build", "enabled": false },
                    { "id": "xai/grok-4.5", "enabled": false },
                    { "id": "xai/grok-composer-2.5-fast", "enabled": false }
                ]
            }
        },
        "settings": {
            "compactCompletedTurns": false,
            "completionChime": false,
            "inferenceMaxRetries": 10,
            "showReasoning": false,
            "showUsage": false,
            "toolResultRetentionDays": 7
        },
        "theme": {
            "primary": "default",
            "secondary": "dim",
            "accent": "cyan",
            "brand": "ansi:202",
            "success": "green",
            "warning": "yellow",
            "error": "red"
        },
        "workspace": {
            "keepCopiesOnArchive": true,
            "keepWorktreesOnArchive": false,
            "setupCommands": ["pnpm install"],
            "sync": [".env.local"],
            "protectedSync": []
        }
    }
}
```

Field groups:

- `providers.<id>.name` — optional friendly account name. Built-in `claude`, `codex`, and `grok`
  default to `Current CLI`; other accounts without a configured name use a readable version of
  their ID. Explicit names are trimmed, nonblank, and at most 256 characters, then displayed
  verbatim without inferred identity, email shortening, or plan suffixes. Names affect no account
  ID, provider type, credentials, defaults, or routing. Clients tolerate absent names on older
  daemons and may use a readable ID fallback. Account-usage entries continue to reference IDs;
  clients join them to this configuration for display names.

- `defaults` — what a new agent gets when it names nothing: provider, model, effort, and
  permission mode.
- `features` — feature flags.
- `mcpServers` — configured MCP servers by name. Only `enabled` and the transport kind
  (`"stdio"` or `"http"`) are exposed; commands, URLs, headers, and environment stay private.
- `network` — the sandbox network policy: allowed and denied domains, allowed ports.
- `node` — this installation's own display name and nullable avatar ThumbHash metadata, separate
  from P2P identity. Optional for older compatible daemons; current daemons include it. See node
  configuration for name mutation, image serving, and admin-tool behavior.
- `p2p` — peer-to-peer identity and transports. The advertised `name` and `role` are here.
- `permissions` — permission configuration, including project-relative protected paths.
- `presence` — the defined presence states and which one is current.
- `models` — every known model, keyed by model ID. Each definition carries the display `name`,
  `contextWindow` in tokens (`null` only for a custom model whose limit is unknown), the allowed
  `efforts`, the `defaultEffort`, and the supported `serviceTiers` (empty when the model has none).
  Optional `serviceTierOptions` is the complete ordered speed menu, with each option carrying
  a unique opaque `id` and a human-readable English `label`. Exactly one option has `id: null` to
  clear the service tier and select the default route; each non-null ID is a supported
  `serviceTiers` value. Clients display these labels and submit these IDs unchanged through
  `mode.serviceTier`, without inferring labels or supported choices from tier strings.
  Older daemons may omit the field; clients must not invent a speed menu when it is absent.
  A definition may also carry `autoCompactWindow`: the measured conversation size in tokens at
  which the daemon compacts automatically, always below `contextWindow`. It is optional, so
  older daemons omit it, and `null` when a model has no curated threshold. A client that shows
  how much context remains counts down to `autoCompactWindow` when present and to
  `contextWindow` otherwise, so the indicator reaches zero at the moment compaction happens.
  Definitions live only here; everything else refers to models by ID.
- `providers` — one entry per configured provider: its `type` (canonical provider key),
  whether the provider is `enabled`, and its model list as references — `id` into the top-level
  `models` map plus a per-provider `enabled` flag. A disabled provider still lists its known
  models, all disabled. When a provider serves a model with narrower capabilities than the
  shared definition (Bedrock resells other vendors' models without service tiers, for example),
  the reference entry overrides just those fields, such as `"serviceTiers": []`.
  A reference may also override `serviceTierOptions`, replacing the shared menu in full with
  that account/model's currently eligible choices, including its default option. Current
  daemons supply the complete menu on every provider model reference, independently of shared
  definition inheritance, and keep its non-null IDs identical to the effective `serviceTiers`;
  eligibility changes use the existing configuration-change notification.
  A reference also carries `hidden`, `true` when the account serves the model without offering
  it. The curated catalog makes a model opt-in when a successor replaces it, such as GPT-6 Sol
  after GPT-6.1 Sol; it is hidden unless the account's `include_models` names it, and a smart
  provider's copy is hidden unless the pool names it or a member offers it unhidden. Like a
  hidden provider it is display-only: clients leave hidden models out of model pickers unless
  the current selection already uses one, the daemon leaves them out of new-subagent choices and
  never picks one as the default stand-in, and messages, turns, and compaction for an agent
  already on one are accepted as usual. A default model the configuration names explicitly is
  still honored. `enabled` never includes `hidden`. `hidden` is additive and does not increment
  the protocol version; older daemons omit it, and clients treat a missing value as `false`.

    A provider entry also carries `hidden`, `true` when the machine configuration sets
    `hidden = true` for that provider. It is display-only: clients omit hidden providers and their
    models from model pickers, and the daemon omits them from the model choices offered for new
    subagents. `enabled` never includes `hidden`; it says only whether the account is on and may be
    routed to. Messages, turns, and compaction for an agent already on a hidden provider are
    accepted exactly as on a visible one, and a smart provider keeps routing through enabled hidden
    members. Removing an account entirely means deleting it from the configuration. Hiding is
    file-only configuration; there is no mutation for it. `hidden` is additive and does not
    increment the protocol version. Older daemons omit it and instead report hidden providers as
    disabled; clients treat a missing value as `false`.

    A provider whose configured type is `"smart"` also carries `pool`, the accounts it routes
    through:

    ```json
    "pool": { "strategy": "round_robin", "members": ["codex", "codex_work"] }
    ```

    `strategy` is the configured routing strategy. `"round_robin"` is the only strategy today; the
    set may grow, and clients treat an unknown strategy as an opaque pool. `members` lists the
    accounts the pool can route at least one of its models to, in configured order, which is the
    order the pool fails over through. Each member is the ID of another entry in `providers`,
    hidden and disabled accounts included. Configured IDs the pool can never route to, such as
    unknown IDs, other smart providers, or accounts of a different type than its first member, are
    left out, so `members` may be empty. Clients show a pool's members by joining each ID to its own
    entry here and in `GET /v0/usage`. Only smart providers carry `pool`. It is additive and does
    not increment the protocol version; older daemons omit it.

- `settings` — daemon behavior toggles and tunables.
- `api` — optional daemon-wide public connectivity settings. Supporting daemons return
  `{ "publicUrl": null, "localPort": 24782 }`. `publicUrl` is the configured canonical HTTPS origin,
  or `null` when the daemon has no public endpoint. `localPort` is the read-only loopback HTTP port
  configured by `[api] public_port` (default `24782`). Both fields are optional for compatibility;
  older daemons omit the object. This is configuration, not proof that public DNS, TLS, or the proxy
  is reachable. The URL is an address, not a credential.
- `mobileConnector` — the existing optional `{ "publicUrl", "localPort" } projection remains
available to compatible clients. On a daemon supporting `api`, both objects describe the same
daemon-owned endpoint; this object does not own a separate listener or configuration value.
New clients use `api` for daemon reachability, independently of mobile pairing.
- `theme` — terminal color assignments.
- `voice` — optional machine-level voice settings, present when the daemon supports voice:

    ```json
    {
        "controller": { "providerId": null, "modelId": null, "effort": null, "fastMode": false },
        "effectiveController": {
            "providerId": "codex",
            "modelId": "openai/gpt-6.1-sol",
            "effort": "low",
            "serviceTier": null,
            "notice": null
        },
        "defaultSystemPrompt": "You are Happy, a calm, friendly voice companion…",
        "systemPromptOverride": null,
        "effectiveSystemPrompt": "You are Happy, a calm, friendly voice companion…"
    }
    ```

    `controller` holds the stored controller selection; `null` means the default. The default
    provider is the configured default provider or account pool, the default model is
    `openai/gpt-6.1-sol`, the default effort is `low` when the model accepts it and the model's
    default effort otherwise, and fast mode is off. `effectiveController` is what a call starting
    now would use: `providerId` is `null` when no default provider is configured, and
    `serviceTier` is `"priority"` only when fast mode is on and that route offers the priority
    tier. `notice` is a human-readable explanation, or `null`, for a setting that is currently
    ignored or unusable, such as fast mode on a model without the priority tier or a selected
    model that is no longer enabled. `defaultSystemPrompt` is the built-in voice model prompt, which
    is never persisted; `systemPromptOverride` is the stored replacement or `null`; and
    `effectiveSystemPrompt` is the prompt a new call uses. The controller is the person's Voice
    agent (see Live voice sessions); these settings choose the route of its requests in each new
    call, and its own instructions are fixed and not configurable.

    The settings live in the machine configuration's `[voice]` table: `controller_provider`,
    `controller_model`, `controller_effort`, `controller_fast_mode`, and `system_prompt`. Values
    written through `PATCH /v0/config` or the admin-bot voice settings tools are stored in the
    daemon-owned runtime configuration and take precedence over the user-authored file.

- `workspace` — workspace lifecycle configuration: archive behavior, setup commands, and
  files synced into new workspaces.

Tokens, API keys, environment values, and paths to credential files are never returned.

### `PATCH /v0/config`

Requests a runtime settings change. The body is validated against the mutable subset:

```json
{
    "providers": {
        "codex": { "enabled": false }
    },
    "p2p": { "name": "my-machine" },
    "node": { "name": "Studio Mac" },
    "settings": {
        "inferenceMaxRetries": 3
    }
}
```

A provider `enabled` value written through this route is an explicit, durable user override.
Both `true` and `false` take precedence over provider scans. Enabling takes effect for new work
immediately. Disabling takes effect immediately and aborts every in-flight inference and
compaction using that provider, including internal inference, while leaving the affected agents
available for a later message on an enabled provider. The response is the same sanitized effective
configuration shape as `GET /v0/config`, after the change has taken effect, and the change emits a
`config.updated` event.

The optional `defaults` object sets the default model for new conversations:

```json
{ "defaults": { "providerId": "codex", "modelId": "openai/gpt-6.1-sol", "effort": "high" } }
```

`providerId` and `modelId` are required and must name a model an enabled provider offers;
`effort`, optional, must be one the model accepts and defaults to the model's own default effort.
Otherwise the request is `400 invalid_request` with an explanation. The choice is stored in the
generated runtime configuration's `[defaults]`, so it lasts across restarts, and takes effect at
once: `GET /v0/config` `defaults` reports it, it is first among the models, and new conversations
and clients without a last composer mode start on it. Conversations that already ran keep their
own mode. A model that later stops being offered is ignored until it is offered again. The change
emits `config.updated`. In team mode only the team owner may change it; anyone else receives
`403 forbidden`.

The optional `api` object changes this daemon's public endpoint:

```json
{ "api": { "publicUrl": "https://agent.example.com" } }
```

`publicUrl` is optional: omission leaves it unchanged; `null` explicitly removes the public endpoint,
including when the machine file supplies a URL. A string is 1–2,048 characters, is trimmed, and a bare hostname (with an optional
port) gets `https://`. Only an HTTPS origin is accepted: no user information, non-root path,
query, fragment, whitespace, or port outside 1–65535. The returned URL uses the URL-standard
ASCII hostname, lowercase scheme and hostname, no trailing slash, and omits the default port 443.
Invalid input returns `400 invalid_request` before changing any field of the patch. The setting
is saved in generated `runtime.toml`, overrides the machine file, survives restart, and emits
`config.updated`. In team mode only the owner may change it; otherwise the entire patch is
`403 forbidden`. No port, certificate, DNS, or reverse proxy is configured by this request.

The existing `mobileConnector.publicUrl` patch remains accepted and writes this same daemon-owned
setting. If both objects supply a value, normalize and compare them before any mutation: equivalent
origins or two nulls are accepted as one change; conflicting values return `400 invalid_request`
and change nothing. Neither object accepts a mutable `localPort`. Runtime changes are saved under
`[api]` in generated `runtime.toml`; the old projection never creates an independent setting.

A changed URL cancels unfinished mobile pairings. The next QR advertises the daemon's current
origin. Enabling the endpoint starts the daemon-owned listener and closes the separate mobile
listener and mobile Tailcat exposure. Removing it closes the public listener and restores the
mobile connector's ordinary on-demand Tailcat behavior. Changing one non-null origin to another
updates the advertisement without changing the local listening port; the operator separately
updates DNS and the TLS proxy. Paired device credentials are never revoked by an endpoint change.
An unavailable loopback port is reported as a public transport error, and the enabled mobile
connector reports `failed`; the primary local/team transport remains usable for repair. The setting
remains saved, with no insecure or Tailcat fallback. Correct the port conflict and restart to retry.
Machine-file changes, including the file-only public port, take effect after restart.

#### Authenticated endpoint discovery

Clients may adopt a daemon's endpoint from authenticated `GET /v0/config` or the same config in an
authenticated bootstrap. `config.updated` tells them to refresh it. A missing `api` object or missing
`api.publicUrl` means an older daemon has supplied no update; it must not erase an already stored
endpoint. An HTTPS origin selects that endpoint. Explicit `null` removes the public endpoint and
permits a client to restore its original transport, if it retained one. Invalid advertisement values
are rejected rather than normalized by the client. An unauthenticated response, redirect, error,
or failed TLS connection never authorizes an endpoint or credential-routing change.

Phones preserve their device token and any original Tailcat address and port when adopting an
authenticated origin. Future HTTP, event streams, WebSockets, and CONNECT use the selected
endpoint; reconnecting streams and sockets does not change user identity or broaden authority.
An HTTPS failure alone never selects the retained Tailcat route.

This is not an out-of-band discovery service. In public mode there is no mobile Tailcat listener
to inform an offline Tailcat-only phone of the new origin. A client that receives an authenticated
advertisement while its old route is still reachable can migrate without re-pairing; otherwise it
needs a new pairing QR or another trusted provisioning path. Likewise, removing or replacing an
unreachable public origin cannot notify disconnected clients. A v2-only pairing has no original
Tailcat coordinates to restore. Do not promise transparent migration when no previously trusted
route can deliver the advertisement, and do not silently guess a fallback.

The optional `voice` object changes the voice settings:

```json
{
    "voice": {
        "controller": {
            "providerId": "claude",
            "modelId": "anthropic/sonnet-5",
            "effort": null,
            "fastMode": false
        },
        "systemPrompt": null
    }
}
```

`controller` and each of its properties, and `systemPrompt`, are optional. An omitted property
is unchanged. `null` removes the stored value, so the setting falls back to the user-authored
configuration file when it sets one, and otherwise to the default. A `systemPrompt` identical to
`defaultSystemPrompt` also removes the stored value; the default itself is never stored. A
supplied `systemPrompt` is 1–32,768 characters and not blank. The daemon validates the resulting
selection before storing anything: the provider must be configured, it must offer the model, and
the effort must be one the model accepts; otherwise the request is `400 invalid_request` with an
explanation. Fast mode is always accepted and reported through `effectiveController`. Disabling a
provider later does not delete the setting; new calls then fail with an explanation. Changes
apply to calls that start afterwards, never to an active call. In team mode only the team owner
may change voice settings; anyone else receives `403 forbidden`, and the entire patch is
rejected without applying other fields.

Active admin bots additionally have `get_voice_settings` and `set_voice_settings` tools. The
former takes no arguments; the latter takes the same `controller` and `systemPrompt` properties
as `voice` above, with the same semantics and validation. Both return the current `voice` object
exactly as it appears at `config.voice`, and a change emits `config.updated`. Admin-bot authority
is checked again at execution; ordinary agents, non-admin bots, and archived bots do not receive
or cannot use these tools.

A daemon that does not support runtime reconfiguration answers `409` with
`{ "error": "This daemon cannot change its settings at runtime." }`. Settings outside the
daemon's mutable subset are changed by editing the configuration files and restarting the daemon.

### `POST /v0/providers/scan`

Runs the system provider scan. The automatic startup scan and this route perform bounded local
credential discovery only: they do not make an inference request or require network access. A call
made while a scan is already running joins that scan and receives the same completed result.

Providers are disabled by default until the startup scan completes. An explicit provider setting
from configuration or `PATCH /v0/config` always wins. Otherwise, finding credentials enables the
provider and records that positive discovery durably. Once any scan has found a provider configured,
a later missing credential or scan error does not automatically disable it. An explicit user
disable still does. Scan results never include tokens, credential-file paths, environment values,
or raw provider errors.

Response — `200`:

```json
{
    "completedAt": 1755400000000,
    "providers": [
        {
            "providerId": "codex",
            "credentials": "available",
            "remembered": true,
            "enabled": true,
            "enablement": "scan"
        },
        {
            "providerId": "grok",
            "credentials": "missing",
            "remembered": false,
            "enabled": false,
            "enablement": "default"
        }
    ]
}
```

`providers` is sorted by provider ID. `credentials` is `"available"`, `"missing"`, or `"error"`
for this scan. `remembered` says whether this or an earlier scan has found the provider configured.
`enablement` is `"explicit"` when a user setting controls the provider, `"scan"` when current or
remembered discovery enables it, and `"default"` when the disabled default applies.

### `POST /v0/providers/:providerId/verify`

Performs one bounded provider verification without changing an explicit enable or disable. The
request chooses the strength of verification:

```json
{ "level": "authentication" }
```

- `"credentials"` performs the same local credential discovery as a scan.
- `"authentication"` makes the least expensive provider-specific authenticated request available.
  When the provider has no authentication-only request, it falls back to the inference check.
- `"inference"` makes a minimal request using a curated inexpensive model for that provider.

A successful verification records the provider as discovered and applies normal scan enablement,
unless an explicit user setting controls it. A failed verification does not erase an earlier
positive discovery and does not automatically disable the provider. Verification failure is a
normal `200` result; an unknown provider ID returns `404`.

Response — `200`:

```json
{
    "providerId": "codex",
    "requestedLevel": "authentication",
    "performedLevel": "inference",
    "status": "passed",
    "checkedAt": 1755400000000,
    "modelId": "openai/gpt-5.6-luna"
}
```

`performedLevel` reports the check that actually ran. `modelId` is the model used for an inference
check and is `null` otherwise. `status` is `"passed"` or `"failed"`. The response never carries
credential material, credential-file paths, environment values, model output, or raw provider
errors.

### `GET /v0/config/instructions`

Returns the global instructions document — the user's global agent instructions text. A missing
document reads as empty.

Response — `200`: `{ "instructions": "<text>" }`

### `PUT /v0/config/instructions`

Replaces the global instructions document. The write is atomic and the file is created with
owner-only permissions. Maximum size is 256 KB; a larger body is rejected with `400`.

Request: `{ "instructions": "<text>" }`

Response — `200`: `{ "instructions": "<text>" }` — the document as persisted, read back after
the write. The change also emits a `config.updated` event.

### `GET /v0/config/security`

Returns the security policy document (the AGENTS_SECURITY.md text). A missing document reads as
empty.

Response — `200`: `{ "policy": "<text>" }`

### `PUT /v0/config/security`

Replaces the security policy document. Same atomic-write and permission behavior as
instructions. Maximum size is 32 KB; a larger body is rejected with `400`.

Request: `{ "policy": "<text>" }`

Response — `200`: `{ "policy": "<text>" }` — the document as persisted. Recording the change
also emits a `config.updated` event.

## Global skills

The installation's global skills live in the existing `~/.agents/skills` directory on the daemon's
machine. This catalog is independent of any project or active agent. It does not include project
skills, another connection's skills, or skills on a container's separate filesystem. A desktop
uses the selected connection's API and journal, never its own local filesystem, to manage them.
In team mode this is the shared daemon-machine catalog: onboarded members may read it, but only
the configured owner may change enablement (`403 forbidden` for another member).

The daemon monitors the directory recursively for additions, edits, renames, and removals,
including supporting files and disabled skills. It notices creation of an initially missing root,
atomic file replacement, root replacement, and changes made while the daemon was stopped. A
missing root is an empty catalog; a failed root scan returns `503`, not a false empty snapshot.
Watching is installation-owned, not tied to an open agent or a client's polling lease. Watcher
work, scans, queued notifications, file reads, and output are bounded. Overflow or an unidentified
change causes a broad invalidation and reconciliation rather than silently losing changes.

### Skill records and parsing

Each directory containing a `SKILL.md` is one installed skill. Discovery follows the existing
skill-root rules, including directory symlinks, skipping dot-directories and `node_modules`.
The root itself is a container, not a skill. Duplicate names remain separate installed records;
agent discovery retains its existing project-versus-global precedence.

One summary has this shape:

```json
{
    "id": "s1a2b3c4",
    "path": "code-review",
    "name": "code-review",
    "description": "Review the current changes.",
    "enabled": true,
    "status": "ready",
    "error": null,
    "version": "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e",
    "updatedAt": 1755400000000
}
```

- `id` is an opaque CUID2, persisted for this installation-relative directory path. Editing its
  name or replacing files in place does not change its ID. Moving the directory is removal at the
  old path and installation at the new path. Reinstallation at the same path retains its ID and
  enablement preference; removed records are absent from list/read responses.
- `path` is the directory path relative to the global skills root, using `/` separators.
- `name` and `description` are parsed from the YAML frontmatter using the same rules as agent
  discovery, including quoted strings and block scalars. A missing name falls back to the directory
  basename. A valid name matches `[a-zA-Z0-9][a-zA-Z0-9._-]*` and is at most 128 characters; a valid
  description is nonempty and at most 1,024 characters. Other frontmatter does not configure hooks,
  execution, model selection, or permissions.
- `status` is `"ready"`, `"invalid"`, or `"unreadable"`. Invalid or unreadable installed skills
  remain visible in desktop but are not offered to agents. `error` is a human-readable diagnostic
  or `null` for a ready skill. When parsing fails, `name` is the directory basename and
  `description` is empty; never return stale parsed metadata as current.
- `enabled` is the persisted user preference, initially `true`, independent of parsing status.
- `version` is a UUIDv7, advanced when metadata, document bytes, supporting files, status, or
  enablement changes. `updatedAt` is when the daemon observed that change, not a file's mtime.
  Unchanged rescans do not advance either field or emit events.
- `plugin` is optional. It names the installed plugin a skill came from, or is `null`; see
  "Plugin skills" under Plugins.

All relative paths in this chapter are nonempty, at most 4,096 characters, and contain no absolute
prefix, backslash, NUL, or empty, `.` or `..` segment. A skill ID is resolved from the catalog, not
interpreted as a path. Installed directory symlinks may establish a canonical skill directory;
subsequent file access must remain within that directory, enforce the filesystem boundary, and
recheck symlinks at access time. These routes are not arbitrary host-file reads.

### `GET /v0/skills`

Lists installed global skills, including disabled and broken ones, ordered by relative directory
path. Query: optional `limit` (default 50, maximum 100) and opaque `pageCursor` (at most 512
characters). Response — `200`:

```json
{ "skills": [], "nextPageCursor": null, "cursor": "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e" }
```

`skills` contains summaries. `nextPageCursor` is `null` at the end. Page cursors are distinct from
event cursors and bind to a catalog revision; a concurrent catalog change invalidating pagination
returns `409 conflict`, and the client restarts the list. `cursor` is the journal position captured
before the snapshot read. Follow from the first page's cursor while loading subsequent pages, so
concurrent changes cannot disappear between the snapshot and subscription.

### `GET /v0/skills/:skillId`

Returns the summary and parsed instruction document, including when disabled. Response — `200`:

```json
{
    "skill": { "...": "summary above" },
    "content": "---\nname: code-review\ndescription: Review changes.\n---\nReview the diff.\n",
    "instructions": "Review the diff.\n"
}
```

`content` is the complete UTF-8 `SKILL.md`; `instructions` is its Markdown body with frontmatter
removed. Parsing normalizes CRLF/CR to LF for the body, but `content` retains the original text.
Documents are limited to 256 KiB. An unreadable, oversized, or non-UTF-8 document has `content`
and `instructions` both `null`; malformed metadata may retain readable `content` but returns
`instructions: null`. Its summary explains the failure. A removed or unknown ID returns `404`.

### `PATCH /v0/skills/:skillId`

Changes only enablement. Requires `If-Match` with the skill's last observed version.

Request: `{ "enabled": false, "mutationId": "optional-client-echo" }`.

Response — `200`: `{ "skill": { ... } }`, the committed summary. A stale version returns
`409 conflict` with `currentVersion` and the current `skill`. Missing/malformed `If-Match` is
`400`; a removed/unknown skill is `404`. Repeating the current value with a current version is a
no-op, returning the existing summary without advancing its version or emitting an event.

Disabling is not deletion: it does not rename, move, rewrite, or remove installed files. The
record and its files remain available to the human-facing API and continue to be watched.
Enablement is daemon-owned runtime state, survives restart, and cannot be overridden by skill
frontmatter. A successful change emits `skills.updated` after persistence, echoing `mutationId`.

A disabled global skill is absent from newly assembled system prompts, agent skill listings, and
slash commands. Skill-specific reads and invocation check current enablement and refuse it, even
if a caller knows its name or retained an old command. An active agent applies the change at its
next instruction refresh; it does not interrupt an in-flight inference or erase previous messages
or already-read content. Pending skill-specific prompt contributions must also respect disablement
on refresh. Re-enabling restores normal discovery if the skill is valid. This is skill availability,
not a filesystem permission boundary: ordinary file and shell tools retain their usual permissions.
It does not disable a separate project skill with the same name.

### `GET /v0/skills/:skillId/files`

Lists regular files recursively inside this installed skill, including `SKILL.md`, ordered by
skill-relative path. Uses the same optional `limit` and `pageCursor` bounds as the catalog.
Response — `200`:

```json
{
    "files": [{ "path": "SKILL.md", "size": 105, "modifiedAt": 1755400000000 }],
    "nextPageCursor": null,
    "version": "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e"
}
```

`size` is a non-negative byte count; `modifiedAt` is the file's modification time in epoch
milliseconds. `version` is the containing skill's version. Pagination binds to that version;
intervening changes return `409 conflict` and require restarting the listing. Missing skills
return `404`; an unreadable tree returns an error, never a silently partial successful list.
Nested installed skills own their own files and are not traversed as part of their parent skill.

### `GET /v0/skills/:skillId/file?path=...`

Reads one regular file by skill-relative `path`, including for disabled skills. Response — `200`:
the original bytes with `Content-Type: application/octet-stream` and `Cache-Control: no-store`.
Maximum file size is 8 MiB (`413 too_large` above that limit). Unknown skills/files return `404`,
invalid paths `400`, and paths outside the skill boundary `403`. Directories and special files
are not readable through this route. No skill installation, file editing, or deletion operation
is introduced by this feature.

### Live synchronization

`skills.updated` is a bounded invalidation, not a resource diff. Its payload is:

```json
{
    "skillIds": ["s1a2b3c4"],
    "paths": ["code-review/SKILL.md"],
    "mutationId": "optional-client-echo"
}
```

`skillIds` identifies affected installed or removed records, or is `null` when unknown or more
than 100 were affected. `paths` contains up to 100 root-relative changed file/directory paths, or
is `null` for an unknown, root-wide, or overflowing change. An enablement-only change uses
`paths: []`. Files not yet belonging to a valid skill still produce path invalidations. File
changes advance the owning skill's version even when its parsed name and description are unchanged.
Notifications may coalesce filesystem changes, but always follow publication of the corresponding
catalog state. No document contents appear in events.

The same event is delivered by journal pulls, SSE, and `HappyAgentClient.updates()`. Clients
refresh affected catalog pages, open skill details, and file views. An invalidation during a
refresh requires another refresh; an older response must not overwrite a newer summary version.
On journal loss or daemon replacement, reload the catalog and visible details from a fresh cursor.
Disabled skills remain in the management list throughout. These are synchronization events, not
desktop operating-system notifications or unsolicited messages to running agents.

## Plugins

A plugin is a versioned package from a plugin catalog, described by the `plugin.json` manifest
at the root of its archive. Happy Agent runs no plugin code. It installs one kind of plugin: an
external plugin whose only content is skills. Every other plugin is listed as available but cannot
be installed.

Plugins have no install scope. An installed plugin belongs to the whole installation and is
shared with everyone who uses it. A single-instance plugin is installed at most once; a plugin
whose manifest sets `multiInstance: true` may be installed several times. In team mode onboarded
members may read both lists, but only the configured owner may install or uninstall
(`403 forbidden` for another member).

Clients learn about plugins only from the daemon; they never read a catalog themselves. Clients
detect plugin support through `GET /v0/plugins`: `404` or `501` means plugins are unavailable,
not that nothing is installed.

### Catalog sources

The daemon keeps one cached list per catalog source and refreshes each in the background, when it
starts and about every 15 minutes after that. Two sources exist:

- `"public"` — the central catalog, read from `[plugins] catalog_url` in the user `happy.toml`.
  The default is `https://slopus.github.io/happy-plugins/catalog.json`.
- `"cluster"` — the plugins of the cluster this installation is linked to: its private,
  admin-created plugins and its internal plugins. This version of Happy Agent has no cluster link,
  so the cluster source always reports `status: "unavailable"` and contributes no entries.

The sources are separate and never merged into one list entry: the same plugin ID may appear once
from each source. A source that cannot be read keeps serving the last list it read successfully,
which survives daemon restarts, and reports the failure in its sync state instead of failing the
whole response. A catalog larger than 8 MiB, not valid JSON, or with a format version other than
`1` is a failed sync.

One source's sync state has this shape:

```json
{
    "source": "public",
    "status": "synced",
    "url": "https://slopus.github.io/happy-plugins/catalog.json",
    "lastSyncedAt": 1755400000000,
    "error": null
}
```

- `status` is `"synced"` when the most recent sync succeeded, `"syncing"` before the first sync
  has finished, `"failed"` when the most recent sync failed, and `"unavailable"` when the source is
  not configured.
- `url` is the address the daemon reads, or `null` when it has none.
- `lastSyncedAt` is when the source was last read successfully, in epoch milliseconds, or `null`
  when it never was. A failed source's entries are as old as this time.
- `error` is a human-readable English explanation of the most recent failure, or `null`.

### The catalog entry

`GET /v0/plugins/available` lists one entry per plugin version per source:

```json
{
    "source": "public",
    "pluginId": "nvidia-skills",
    "version": "1.0.0",
    "name": "NVIDIA Skills",
    "description": "Skills for building with NVIDIA tools.",
    "kind": "external",
    "multiInstance": false,
    "installable": true,
    "reason": null,
    "manifest": { "id": "nvidia-skills", "version": "1.0.0", "...": "the published plugin.json" }
}
```

- `source` is the catalog the entry came from, `"public"` or `"cluster"`.
- `pluginId`, `version`, `name`, `description`, `kind`, and `multiInstance` repeat the manifest's
  `id`, `version`, `name`, `description`, `kind`, and `multiInstance`.
- `installable` is `true` only for a plugin whose `kind` is `"external"`, that declares a
  `skills` directory, and that declares no `auth`, `mcp`, `entry`, or `settings` content. An
  empty `auth` or `settings` array counts as none. The rule is the same for both sources, so a
  cluster's internal plugins are never installable here and its private skills-only plugins are.
- `reason` is a human-readable English explanation when `installable` is `false`, such as "This
  plugin runs code, which Happy Agent cannot install yet.", and `null` otherwise.
- `manifest` is the catalog's manifest as published, including fields this daemon does not
  interpret. Clients may display what they understand and must ignore the rest.

A catalog entry whose manifest the daemon cannot read is left out of the list rather than shown
with invented details.

### The installation object

```json
{
    "id": "p1a2b3c4",
    "source": "public",
    "pluginId": "nvidia-skills",
    "version": "1.0.0",
    "name": "NVIDIA Skills",
    "description": "Skills for building with NVIDIA tools.",
    "status": "installed",
    "error": null,
    "path": "/Users/me/Happy/Plugins/nvidia-skills",
    "createdAt": 1755400000000,
    "updatedAt": 1755400000000
}
```

- `id` is the installation ID, a CUID2. Multi-instance installations of one plugin have
  different IDs.
- `source` is the catalog the plugin was installed from.
- `pluginId`, `version`, `name`, and `description` are copied from the manifest that was
  installed.
- `status` is `"installing"` while the daemon downloads and unpacks the plugin, `"installed"` once
  its skills are in place, and `"failed"` when installation stopped. Installing continues across
  daemon restarts.
- `error` is a human-readable English diagnostic for a failed installation and `null` otherwise.
- `path` is the absolute folder on the daemon's machine that holds the unpacked plugin. It sits in
  the user-visible `Plugins` folder (`~/Happy/Plugins` on macOS, `~/happy/plugins` elsewhere) and
  is named after the plugin, with a numeric suffix when that name is taken.
- `createdAt` is when the installation was requested and `updatedAt` when its status last changed,
  both epoch milliseconds.

### `GET /v0/plugins`

Lists the installation's plugins, including installing and failed ones, newest first. Response —
`200`:

```json
{ "plugins": [], "cursor": "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e" }
```

`plugins` contains installation objects, at most 256. `cursor` is the journal position captured
before the snapshot read; follow events from it so a concurrent change cannot be missed.

### `GET /v0/plugins/available`

Returns the cached catalog lists without contacting any catalog. Response — `200`:

```json
{
    "plugins": [],
    "sources": [
        {
            "source": "public",
            "status": "synced",
            "url": "https://...",
            "lastSyncedAt": 1755400000000,
            "error": null
        },
        {
            "source": "cluster",
            "status": "unavailable",
            "url": null,
            "lastSyncedAt": null,
            "error": null
        }
    ],
    "cursor": "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e"
}
```

`plugins` contains catalog entries, at most 2,000: the public source's entries in catalog order,
then the cluster's. `sources` holds the sync state of every source. `cursor` is the journal
position captured before the read. A source that has failed or not yet synced simply contributes
its last cached entries, or none.

### `POST /v0/plugins`

Installs one cached catalog plugin version. Request:

```json
{
    "source": "public",
    "pluginId": "nvidia-skills",
    "version": "1.0.0",
    "mutationId": "optional-client-echo"
}
```

`source` is optional and defaults to `"public"`, so `pluginId` and `version` always name one
entry. The daemon looks the entry up in that source's cached list, records the installation with
`status: "installing"`, and returns before downloading. Response — `202`: `{ "plugin": { ... } }`,
the new installation object. It then downloads the archive, refuses it unless its SHA-256 digest
equals the catalog's `sha256`, unpacks it into the installation's `path`, and checks that its
`plugin.json` names the requested `id` and `version`. Each status change emits `plugins.updated`.

Errors:

- `400 invalid_request` for a malformed body.
- `404 not_found` when that source's cached list has no such plugin version.
- `409` with code `not_installable` and the catalog entry's `reason` in `error` when the entry is
  not installable.
- `409` with code `already_installed` and the existing installation as `plugin` when a
  single-instance plugin with that ID already has an installing or installed installation, from
  either source. A failed installation does not count; uninstall it to tidy up.

A failed download, digest mismatch, unsafe archive entry, or mismatched manifest ends in
`status: "failed"` with an explanation in `error`, and leaves nothing behind in the `Plugins`
folder or the skills catalog. Archives are limited to 64 MiB compressed and 256 MiB unpacked.
Archive entries may only be regular files and directories inside the plugin root.

### `DELETE /v0/plugins/:installationId`

Uninstalls one plugin in any status. The optional JSON body is `{ "mutationId": "..." }`. Response
— `200`: `{ "plugin": { ... } }`, the removed installation's final object. The installation
disappears from `GET /v0/plugins` at once and emits `plugins.updated`. The daemon then removes
its skills and its folder, including any files a person added there; the departing skills are
announced by `skills.updated`. An unknown or already-removed ID returns `404`.

### Plugin skills

An installed plugin's skills join the global skills catalog. The daemon links the plugin's
`skills` directory into the global skills root as `~/.agents/skills/<folder>`, where `<folder>`
is the last segment of the installation's `path`. Each skill therefore has a `path` beginning with
that folder, and other assistants on the machine that read `~/.agents/skills` see the same
skills. If an entry with that name already exists in the skills root and is not the daemon's own
link to that plugin, the installation fails rather than replacing it.

A global skill summary carries an optional `plugin` attribution:

```json
{ "plugin": { "installationId": "p1a2b3c4", "pluginId": "nvidia-skills", "name": "NVIDIA Skills" } }
```

It is `null` for a skill that did not come from a plugin. Plugin skills are otherwise ordinary
global skills: they can be disabled and read the same way, and agents discover them like any
other. Older daemons omit the field; clients treat its absence as `null`.

### Live synchronization

`plugins.updated` is a bounded invalidation. Its payload is:

```json
{ "installationIds": ["p1a2b3c4"], "catalog": false, "mutationId": "optional-client-echo" }
```

`installationIds` names up to 100 affected installations, including removed ones, or is `null`
when more changed; it is `[]` when only the catalog changed. `catalog` is `true` when a source's
cached list or sync state changed, so clients showing `GET /v0/plugins/available` read it again;
when absent it means `false`. `mutationId` echoes the request that caused the change. The event
follows the committed change and contains no catalog or archive data. Clients refresh
`GET /v0/plugins` and any open installation.

## Daemon lifecycle

### `POST /v0/drain`

Puts the daemon into draining mode. The transition is permanent for this daemon process and the
endpoint is idempotent, so a caller may safely retry after losing the response. The response is
sent after draining mode has been published but before the drain necessarily finishes. Callers
poll health until `drainWaitingFor` is empty, then call `POST /v0/shutdown` when they want the
process to exit.

Request — optional JSON body naming why the daemon is going away:

```json
{ "intent": "restart", "cause": "update", "targetVersion": "2026.11.2" }
```

- `intent` — optional; `"restart"` when the caller will start a replacement daemon once this one
  exits, or `"shutdown"` when nothing will replace it. Defaults to `"shutdown"`.
- `cause` — optional; what brought the drain about. Defaults to `"api"`.
    - `"reload"` — a restart of the same installation, such as `happy-agent reload`.
    - `"update"` — a restart into a different installed version.
    - `"stop"` — a person stopped the daemon, such as with `happy-agent stop`.
    - `"signal"` — an operating-system signal, such as `SIGTERM`, `SIGINT`, or the local drain
      signal.
    - `"api"` — an API caller that gave no cause.
- `targetVersion` — optional; with `"restart"` only, the product version of the executable that
  will replace this daemon, when the caller knows it. A non-empty string of at most 128
  characters. Sending it with `"shutdown"` is rejected.

A body that does not match, including one with unknown fields, is rejected with
`400 invalid_request` before draining begins. No body, or an empty object, is the same as
`{ "intent": "shutdown", "cause": "api" }`.

Response — `202`:

```json
{
    "draining": true,
    "pid": 12345,
    "drain": {
        "intent": "restart",
        "cause": "update",
        "currentVersion": "2026.11.1",
        "targetVersion": "2026.11.2",
        "startedAt": 1755400000000
    }
}
```

`drain` is the drain object the daemon recorded. The first drain of a process decides it; a later
retry with a different body is still accepted, and its response returns the drain already
recorded. Older compatible daemons ignore the body and omit `drain`.

#### The drain object

The drain object tells every client why this daemon process is going away, before it stops
admitting work. It lives only in the process it describes, is never persisted, and is never
carried into the next process.

- `intent` — `"restart"` or `"shutdown"`, as above.
- `cause` — one of the five causes above. Clients decide what to show from `intent`; `cause`
  explains it.
- `currentVersion` — this daemon's own product version, as in health's `version.daemon`.
- `targetVersion` — the product version a restart will start, or `null` when it is unknown.
  Always `null` when `intent` is `"shutdown"`.
- `startedAt` — when draining, or graceful shutdown without a drain, began, in epoch
  milliseconds.

The daemon records the drain object at its single drain entry, whichever path triggered it: this
endpoint, the local drain signal (`"shutdown"`, `"signal"`), or graceful shutdown that begins
without a prior drain (`"shutdown"`, with `"api"` for `POST /v0/shutdown` and `"signal"` for
`SIGTERM` or `SIGINT`). It is recorded before the daemon stops admitting mutations. A drain then
appends the `daemon.draining` event carrying it, so every connected client learns the intent
before the daemon goes away. Shutdown without a prior drain appends no event; health still
reports the recorded object. Clients that connect later read it from health or the event
stream's `hello` frame.

A restart has finished, from a client's point of view, when the client reaches a daemon with a
different `daemonId` and, when `targetVersion` is set, health reports that version. The daemon
makes no promise about how long its replacement takes to start, or that one starts at all: the
replacement is started by the caller that announced the restart. Clients choose their own grace
period. Happy Desktop, for example, keeps showing a restart for 60 seconds after the old daemon
stops answering and then reports the daemon as unavailable; that is Desktop's policy, not a
guarantee from the daemon. A replacement whose version differs from `targetVersion` did not start
the announced version; a client shows that as a failed restart rather than waiting for the
announced version.

From the instant draining begins, the daemon admits no new mutation except shutdown. Reads,
health, event pulls and streams remain available. A repeated drain request is accepted as an
idempotent retry. Every other HTTP mutation and every new terminal WebSocket or workspace proxy
attachment is rejected with `503` and
`{ "error": "Happy Agent is draining and no longer accepts mutations.", "code": "draining" }`.
A mutation already admitted before the transition is allowed to finish. Existing terminal and
proxy attachments remain admitted and may continue. The `"api-mutations"` progress row reports
the exact number of admitted HTTP mutations still in flight.

Draining never cancels agent work. An inference already in flight finishes. If its response owes
a tool batch that has not started, the batch remains durable for the next daemon process. A tool
batch already running finishes and commits, but no following inference starts. Queue and steering
messages remain durable and do not reactivate a drained agent loop.

Drain completion waits only for admitted HTTP mutations, the main agent system, and the automatic
review agent system. It does not cancel or wait for terminal processes, background shell commands,
existing proxy streams, workspace setup, or other long-lived runtime services; ordinary graceful
shutdown owns those lifetimes after the drain is complete.

A daemon started without drain support answers `403` with
`{ "error": "Daemon draining is not enabled." }`.

### `POST /v0/shutdown`

Asks the daemon to shut down. The response is sent before the shutdown begins, so the caller gets
an answer rather than a dropped connection. The socket and API remain available during graceful
shutdown; callers can poll health to observe `shuttingDown` and `waitingFor` until the daemon exits.

Response — `202`:

```json
{ "shuttingDown": true, "pid": 12345 }
```

`pid` is the daemon's process ID, so the caller can confirm the process actually exited. A
daemon started without shutdown support answers `403` with
`{ "error": "Daemon shutdown is not enabled." }`.

### `POST /v0/debug/inspector`

Starts the Node.js inspector on the daemon process, for debugging the daemon itself.

Response — `200`: `{ "inspectorUrl": "<devtools websocket url>" }` — the URL a debugger
attaches to.

A daemon started without inspector support answers `409` with
`{ "error": "This daemon cannot start a debugger." }`.

### `DELETE /v0/debug/inspector`

Stops the inspector.

Response — `200`: `{ "stopped": true }` — `false` when no inspector was running. The same
`409` applies when inspector support is absent.

## Team users

### `GET /v0/users`

Resolve a batch of installation-local Happy user IDs, for example the authors in message
`metadata.userId`. In team mode it is available to authenticated, locally onboarded organization
members and resolves both members and guests. In standalone mode, where `GET /v0/profile`
describes the one person, it resolves only guests. Older compatible daemons return `404` with
code `not_found` in standalone mode.

Query `ids` is an optional comma-separated list of at most 100 CUID2 user IDs. Missing or empty
`ids` returns an empty list, never the whole user directory. Invalid IDs, repeated `ids` query
parameters, or more than 100 entries return `400` with code `invalid_request`. Duplicate IDs count
toward the limit but appear only once in the response. Unknown IDs are omitted. Results follow
the first occurrence of each requested ID.

Response — `200`: `{ "users": [ ... ] }`. Each user contains:

- `id` — the stable installation-local Happy user ID, not a WorkOS ID.
- `name` — the current non-null display name.
- `photo` — `null` or `{ "thumbhash": "..." }`, a photo placeholder.
- `version` — the current UUIDv7 profile resource version.
- `updatedAt` — the profile's last update timestamp.
- `kind` — optional: `"member"` for an organization member who signs in, or `"guest"` for a
  person who reaches an exported bot from an outside chat service. Clients treat a missing
  `kind` as `"member"`.
- `canLogIn` — optional boolean, `false` for a guest and `true` for a member. A guest has no
  credentials: they cannot sign in, call this API, or open any app, and nothing turns a guest
  into a member. Clients treat a missing `canLogIn` as `true`.
- `role` — optional: what the member does, such as `"Billing engineer"`, 1–64 characters, or
  `null` when unset. Guests have none.
- `follows` — optional: what the member follows, such as `"Stripe webhooks"`, 1–500
  characters, or `null` when unset. Agents read `role` and `follows` to decide whom a piece of
  work concerns (see Tasks, "Mentioning a teammate").

`role` and `follows` are additive and do not increment the protocol version; older daemons omit
them, and clients treat a missing value as `null`.

A guest is created when an admin bot approves a person on an exported bot, or when someone an
admin bot put on an export's allowlist first writes. Its `name` is the display name the chat
service gave. Every bot exported to Telegram shares one guest per Telegram user; a bridge's users
are guests of that one export. Removing a guest from an allowlist or turning them away keeps the
guest, so their messages stay attributed to them. In team mode, creating or renaming a guest
emits the identity-only `profile.updated` invalidation; standalone mode emits no event for
guests.

This read has no side effects and emits no events. It never returns email addresses, WorkOS IDs,
JWT user IDs, chat-service user IDs, or owner flags. Clients may resolve IDs again after a `profile.updated` invalidation. Older
compatible daemons may return `404` for this additive endpoint.

### `GET /v0/users/:userId/photo`

Serves one team member's photo bytes, for example a task owner's, with their content type and the
same content-derived `ETag`, conditional-request, and image-caching behavior as
`GET /v0/profile/photo`. Available to the same callers as `GET /v0/users`, in both modes. Guests
have no photo, so a guest's photo is `404`. An invalid user ID is `400 invalid_request`; an unknown
user or a user without a photo is `404`, including when a conditional request names a removed
photo. The `thumbhash` from `GET /v0/users` is the placeholder for these bytes. Additive: older
compatible daemons return `404`.

## Profile

In standalone mode, one installation is one person. In team mode, the profile routes address the
authenticated organization member's user. The wire contract is identical in both modes: a name,
an email, and a photo, with every field initially empty. Standalone persists one singleton; team
mode projects the current user at the same `/v0/profile` endpoint so existing clients retain the
single-current-person interaction model.

Before a team member has saved a profile, `GET /v0/profile` returns a stable empty onboarding
profile. The first `PATCH` must set a non-null `name` and creates the durable user. The first
whitespace-delimited token is stored as `firstName`; the trimmed remainder is stored as
`lastName`, or `null` when there is no remainder. Later profile and photo mutations update that
same user. The configured owner WorkOS user ID determines `isOwner`; the client cannot set it.
A member the machine configuration lists under `[feature.team.members]` already has a user, with
the name, email, role, and follows configured there, before they first sign in; startup fills only
the fields such a member has not set and never overwrites their own edits.

### The profile object

```json
{
    "userId": null,
    "name": "Steve Korshakov",
    "email": "steve@korshakov.com",
    "photo": { "thumbhash": "3OcRJYB4d3h/iIeHeEh3eIhw+j3A" },
    "version": "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e",
    "updatedAt": 1755400000000
}
```

- `userId` — optional additive field identifying the authenticated team member by their
  installation-local Happy CUID2, matching `metadata.userId` on messages and `id` from
  `GET /v0/users`. Current daemons always include it: it is `null` in standalone mode and before
  the authenticated team member has saved a local profile. Older compatible daemons may omit it.
  This is never a WorkOS ID, a JWT user ID, or the standalone profile's private identity. It is read-only and
  cannot be supplied in a profile update.
- `name` — display name, or `null`.
- `email` — email address, or `null`.
- `photo` — `null`, or an object with the photo's ThumbHash placeholder; the image itself is
  fetched from `GET /v0/profile/photo`, exactly like a project avatar.
- `version` — the UUIDv7 resource version for `If-Match` and event chaining, as in the basics.
- `role`, `follows` — team mode only: the member's own role and what they follow, each a string or
  `null`, as described for `GET /v0/users`. Before the member has a user both are `null`.
  Standalone mode, where the installation is one person, omits them, as do older daemons.

Every profile representation uses this same shape, including profile and photo mutation
responses, version-conflict responses, and `GET /v0/bootstrap/desktop`'s `profile`. In team mode
each response resolves the authenticated caller's own ID; it never substitutes the owner or
another member. Standalone `profile.updated` events include the same profile with `userId: null`;
team profile events remain identity-only invalidations rather than broadcasting profile fields.

### `GET /v0/profile`

Response — `200`: `{ "profile": { ... } }`. Always succeeds; a never-touched profile has every
field `null`.

### `PATCH /v0/profile`

Partial update. Any subset of `name` and `email`, and in team mode `role` (1–64 characters) and
`follows` (1–500 characters), each nonblank without control characters; a field set to `null` is
cleared. Standalone mode answers `400 invalid_request` to `role` or `follows`. Honors `If-Match`
with the usual `409`. Accepts `mutationId`.

In team mode, `name` cannot be cleared because every durable user has a first name. Before the
authenticated member has a durable user, the first update must include a non-null `name`.

Response — `200`: `{ "profile": { ... } }` and a `profile.updated` event.

### `GET /v0/profile/photo`

The authenticated user's photo bytes with their content type and content-derived `ETag`;
`If-None-Match` matching the current photo returns `304` without a body. Successful and conditional
responses use the shared image-caching policy in standalone and team mode. Returns `404` when no
photo is set, including when a conditional request names a removed photo.

### `PUT /v0/profile/photo`

The request body is the image itself (`Content-Type: image/png`, `image/jpeg`, or
`image/webp`). The daemon computes the ThumbHash. Response — `200`: `{ "profile": { ... } }`.

### `DELETE /v0/profile/photo`

Removes the photo. Response — `200`: `{ "profile": { ... } }`.

## User settings

User settings are a small key-value store of opaque preferences that belongs to one person, so an
application can keep a person's choices on the daemon and have them follow that person from device
to device. The settings store checks only the shape and size of keys and values. Preferences never
reach agents, tools, or model context. The daemon interprets the reserved `tasks.autoJoin` key as
described under Tasks and the reserved `stories` key as described under Stories; other keys remain
opaque.

**Owner.** In team mode, settings belong to the authenticated member, keyed by their
installation-local Happy user ID. A member reads, writes, and receives events for only their own
settings. In standalone mode, settings belong to the installation's one person. The routes and
shapes are the same in both modes, and clients never choose an owner. A team member who has not
saved a profile has no settings: these routes answer `401` like every other route outside
onboarding (see Authentication), and the member starts with no settings once the profile is saved.
Standalone settings are never assigned to a team member.

Through `/v0/connections/:id/api/*`, settings belong to the remote daemon and to the person it
authenticates. A standalone remote's one person is whoever reaches it through that connection. The
main daemon never stores, caches, or merges a remote's settings.

**Keys.** A key is 1–128 characters from `A–Z`, `a–z`, `0–9`, `.`, `_`, and `-`, starting with a
letter or digit. Keys are compared exactly and need no percent-encoding in a path. Everything after
`/v0/user-settings/` is the key; one that does not match this format is `400 invalid_request`.
Applications prefix their keys with their own name and a dot, such as
`happy-desktop.completionSound`, so that they do not collide.

**Limits.** A value is at most 64 KiB (65,536 bytes) as compact UTF-8 JSON, with arrays and objects
nested at most 32 deep. One person holds at most 1,000 keys with a value and at most 1 MiB
(1,048,576 bytes) of those keys and their compact JSON values together, counted in UTF-8.

**Clears.** A cleared key keeps its `updatedAt` and `version`, so a clear syncs like any other
change and an older write cannot bring the value back. The daemon keeps each person's 1,000 most
recent clears. When it forgets older ones, the newest forgotten `updatedAt` becomes a horizon: a
write carrying an `updatedAt` older than the horizon, to a key the daemon holds nothing for, is
ignored as stale. Forgetting a clear therefore never lets a stale device restore the value.

**Keeping a copy.** Read `userSettings` from desktop bootstrap, or read `GET /v0/user-settings`,
and follow events after that response's `cursor`. A snapshot replaces the whole local copy. For
each `user_settings.updated`, keep the entry with the greater `version` for its key. After a cursor
gap or daemon replacement, read the settings again. Send a change made while offline with the
`updatedAt` of when the person made it, and adopt the entry the response returns.

### The setting object

```json
{
    "key": "happy-desktop.completionSound",
    "value": "focused",
    "updatedAt": 1755400000000,
    "version": "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e"
}
```

- `key` — the setting's key.
- `value` — any JSON value, or `null` when the key holds no value because it was cleared or never
  set. A setting cannot hold a JSON `null` of its own. Values round-trip as JSON values, not bytes.
- `updatedAt` — the time of the last change that applied; last-write-wins compares it (see
  `PUT`). `null` only when the daemon holds nothing for the key.
- `version` — the UUIDv7 minted when that change applied. It is greater than every earlier version
  of the same person's settings, across restarts and clock changes. `null` only when the daemon
  holds nothing for the key.

### `GET /v0/user-settings`

Response — `200`:

```json
{
    "settings": [
        /* setting objects */
    ],
    "cursor": "01991f3a-6d2f-7000-8000-3a0b2c4d5e6f"
}
```

- `settings` — every key the daemon holds for the person, in ascending key order, including
  retained clears with `value: null`. It is bounded by the limits above and never paged.
- `cursor` — the event cursor captured before the settings were read. Follow events after it and
  no concurrent change is missed.

### `GET /v0/user-settings/:key`

Response — `200`: `{ "setting": { ... } }`. A key the daemon holds nothing for answers
`{ "setting": { "key": "...", "value": null, "updatedAt": null, "version": null } }`, not `404`.

### `PUT /v0/user-settings/:key`

Sets or clears one setting.

Request:

```json
{
    "mutationId": "...",
    "value": "focused",
    "updatedAt": 1755400000000
}
```

- `value` — required; the JSON value to store, or `null` to clear the key.
- `updatedAt` — optional; when the person made this change, by their device's clock. Settings are
  last-write-wins per key: a write whose `updatedAt` is older than the stored entry's is ignored,
  so a stale device cannot overwrite a newer change or clear made elsewhere. A time later than the
  daemon's own clock counts as the daemon's current time, so a device whose clock runs ahead cannot
  lock a key against later changes. Omitted, the write always applies at the daemon's current time.

Response — `200`: `{ "setting": { ... } }`, the authoritative entry: what this write stored, or the
stored entry unchanged when the write was ignored as stale. Every applied write, including one that
repeats the stored value or clears a key the daemon holds nothing for, mints a new `version` and
emits one `user_settings.updated` after commit, echoing `mutationId`. An ignored write changes
nothing and emits nothing. Writes to one person's settings are serialized, each compared with what
the previous one committed. Writes to different keys never affect each other.

A malformed key or body, or a value nested too deeply, is `400 invalid_request`. A value over
64 KiB is `413 too_large`. An applied write that would add a key beyond 1,000, or grow the person's
total past 1 MiB, is `409 settings_full`, and the message names the limit; nothing changes. Clears,
writes that do not grow the total, and writes ignored as stale are never refused as full.

## User environment

A person's devices report their environment so the person's agents know the time zone, language,
clock, week, and calendar the person is working in. Each device keeps its own record, so two
devices set up differently never overwrite each other. The environment never reaches tools or
user-visible history; agents receive it only as system notices, described below.

**Owner.** As with user settings: in team mode the authenticated member's installation-local
Happy user ID, standalone the installation's one person. Clients never choose an owner. A team
member without a saved profile receives `401` as on every route outside onboarding.

**Devices.** A client names its device with `deviceId`, an opaque ID matching
`^[A-Za-z0-9._:-]{1,64}$` that it generates once, such as a UUID, and keeps for as long as it is
installed. The ID is scoped to its owner and carries no authority; the same ID from two people
names two devices. A daemon forgets a person's devices that have not reported for 30 days, and
any beyond their 32 most recently reported, when that person next reports.

### The device environment object

```json
{
    "deviceId": "6f1c2a8e-3b7d-4e0a-9c55-1d2e3f4a5b6c",
    "deviceKind": "phone",
    "timeZone": "Europe/Berlin",
    "locale": "de-DE",
    "languages": ["de-DE", "en-US"],
    "hourCycle": "h23",
    "firstDayOfWeek": 1,
    "calendar": "gregory",
    "updatedAt": 1755400000000,
    "reportedAt": 1755400000000
}
```

- `deviceId` — the device's ID.
- `deviceKind` — `"phone"`, `"tablet"`, `"desktop"`, or `"web"`; omitted while never reported.
- `timeZone`, `locale`, `languages`, `hourCycle`, `firstDayOfWeek`, `calendar` — as described
  for the request; each is omitted while the device has never reported it.
- `updatedAt` — when this device's environment or kind last changed.
- `reportedAt` — when this device last reported, whether or not anything changed.

### `PUT /v0/environment`

Reports the calling device's environment. Every field but `deviceId` is optional; a field left
out was not reported and keeps its stored value. Nothing can be cleared, and `null` is refused.

```json
{
    "mutationId": "...",
    "deviceId": "6f1c2a8e-3b7d-4e0a-9c55-1d2e3f4a5b6c",
    "deviceKind": "phone",
    "timeZone": "Europe/Berlin",
    "utcOffsetMinutes": 60,
    "locale": "de-DE",
    "languages": ["de-DE", "en-US"],
    "hourCycle": "h23",
    "firstDayOfWeek": 1,
    "calendar": "gregory"
}
```

- `deviceId` — required, as described above.
- `deviceKind` — optional, one of `"phone"`, `"tablet"`, `"desktop"`, `"web"`.
- `timeZone` — an IANA time zone the daemon recognizes, 1–64 characters without control
  characters. Stored in its canonical spelling (`europe/berlin` becomes `Europe/Berlin`). A name
  for the stored zone by a tzdb link, such as `Asia/Calcutta` for `Asia/Kolkata`, is the same zone
  and keeps the stored name.
- `utcOffsetMinutes` — optional integer from −720 through 840. Advisory: validated, never stored.
  Offsets agents see are computed from `timeZone` when they are told.
- `locale` — the formatting locale, a well-formed BCP 47 tag of 1–64 characters, stored in
  canonical form (`de-de` becomes `de-DE`).
- `languages` — 1–16 preferred languages, most preferred first, each such a tag, stored in
  canonical form and in the order given.
- `hourCycle` — `"h11"`, `"h12"`, `"h23"`, or `"h24"`, as `Intl.Locale` names them.
- `firstDayOfWeek` — integer 1 (Monday) through 7 (Sunday), ISO numbering as `Intl.Locale` week
  information.
- `calendar` — one of the BCP 47 calendar identifiers `buddhist`, `chinese`, `coptic`, `dangi`,
  `ethioaa`, `ethiopic`, `gregory`, `hebrew`, `indian`, `islamic`, `islamic-civil`,
  `islamic-rgsa`, `islamic-tbla`, `islamic-umalqura`, `iso8601`, `japanese`, `persian`, `roc`.
- `mutationId` — optional, echo-only as everywhere.

Response — `200`: `{ "environment": { ... } }`, the device environment object as now stored.
Every accepted report moves `reportedAt`, emits one `user_environment.updated` after commit, and
echoes `mutationId`. A missing or malformed `deviceId`, an unknown field, a `null`, an unknown time
zone, a malformed language tag, or any value outside the ranges above is `400 invalid_request`;
nothing changes.

Clients report at launch, on returning to the foreground, and whenever the system's time zone,
languages, or region settings change.

### What agents are told

A message names the device it was sent from with `deviceId` on `POST /v0/agents/:agentId/send`.
Just before an accepted message joins the conversation of one of the person's agents, the daemon
picks that device's environment, or, when the message names no device the person has reported
from, the device that reported most recently in the last 30 days. It compares five aspects with
what that agent was last told: time zone, primary language (the first of `languages`, else
`locale`), hour cycle, first day of the week, and calendar. An agent never told receives the whole
environment once; an agent told something different receives one system notice naming what
changed, and which kind of device the person is now on when that changed too. Several changes
before the agent's next accepted message produce one notice, a committed notice is never repeated,
idle agents are never woken, and moving between devices that agree says nothing. In team mode an
agent belongs to the owner of the task at the root of its tree; bots are told nothing.

## Onboarding

Onboarding tells a client what is still needed before first use. The daemon owns two separate
states: installation onboarding and, in team mode, the authenticated member's user onboarding.
It combines them into the existing response below; clients do not select a scope, distinguish
installation setup from personal setup, or use a separate user-onboarding API.

Standalone onboarding remains advisory and installation-wide. Team mode retains the profile
access gate described under Authentication: a member without a local profile can read onboarding
but cannot access the rest of the product API until saving that profile.

### `GET /v0/onboarding`

Response — `200`:

```json
{
    "completed": false,
    "steps": {
        "providers": { "done": true, "signedIn": ["codex", "claude"] },
        "profile": { "done": false },
        "project": { "done": false }
    }
}
```

- `completed` — the combined client-facing flag. Standalone mode reports the durable installation
  completion marker, set explicitly when onboarding is finished or dismissed. Team mode reports
  `true` only when installation onboarding is complete **and** the authenticated member has a
  durable local profile. Installation completion never substitutes for that member's profile.
  User readiness is derived from their saved profile, not a second explicit completion marker:
  saving the profile completes their onboarding immediately if installation onboarding is already
  complete. Neither another member's profile nor their Happy Cloud account completes this step.
- `steps` — what the daemon observes, each with a `done` it derives itself:
    - `providers` — at least one provider has working credentials; `signedIn` lists the
      provider keys that do. Signing in happens through the assistants' own programs, never
      through a separate Rig login. Provider CLIs describes how a client finds, installs, and
      starts signing in those programs without a terminal.
    - `profile` — the profile has a name; in team mode this is the authenticated member's
      local profile.
    - `project` — at least one project exists.

Providers and projects remain installation-wide observations. The onboarding object returned by
desktop bootstrap uses the same combined state for the authenticated member. Computing the state
performs no provider or Happy Cloud request beyond ordinary request authentication.

### `POST /v0/onboarding/complete`

Marks installation onboarding finished. In team mode the authenticated member must already have
a local profile with a name; otherwise the existing profile gate returns `401` with
`{ "error": "Unauthorized", "code": "unauthorized" }` without recording completion or creating a
user. The same completion request works in both modes, and a successful team request cannot
complete onboarding for another member who lacks a profile. Idempotent. Response — `200`:
`{ "completed": true }` and a
`config.updated` nudge is **not** emitted — clients that care watch their own flow; others
read the flag on next bootstrap.

## Provider CLIs

Rig uses the credentials of the assistants installed on the daemon's machine: Claude Code, Codex,
Grok, and Antigravity. Provider CLIs let a client get one of them ready without the person opening
a terminal. The daemon finds each assistant's command-line program wherever it already lives,
including inside the vendor's desktop application. It reports whether that program is signed in,
can install a missing one from the vendor's official installer, and can start the vendor's own
sign-in. Before anything is downloaded, the daemon says exactly what it will run and where the
download comes from, so a client can disclose it and offer the manual path instead.

Installing and signing in are long-running operations. A request starts one and answers at once.
Progress, the sign-in URL to open, and the final result arrive as `provider_cli.updated` events
on the ordinary event stream. The daemon never stores, returns, or logs a credential, an
authorization code, or a token. It reports only whether the program is signed in, and the
account's email and plan when the vendor's program reveals them.

The CLIs belong to the daemon's machine and its operating-system user, so these routes are
unavailable in team mode: every route returns `501` with code `unsupported` before parsing a
request body. A daemon that serves them reports `capabilities.providerClis: true` from health.
Older daemons omit it and answer the routes with `404`; clients then show the manual terminal
instructions they showed before.

### The provider CLI object

```json
{
    "id": "claude",
    "name": "Claude Code",
    "vendor": "Anthropic",
    "website": "https://claude.com/product/claude-code",
    "providerId": "claude",
    "installation": {
        "status": "installed",
        "path": "/Users/ada/.local/bin/claude",
        "version": "2.1.312",
        "source": "standalone",
        "desktopApp": null
    },
    "installer": {
        "command": "curl -fsSL https://claude.ai/install.sh | bash",
        "sourceUrl": "https://claude.ai/install.sh",
        "sourceHost": "claude.ai",
        "vendorSite": "https://claude.com"
    },
    "commands": { "run": "claude", "signIn": "claude auth login" },
    "signIn": {
        "status": "signed_in",
        "account": { "email": "ada@example.com", "plan": "Max" },
        "methods": ["browser"]
    },
    "operation": null,
    "version": "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e",
    "updatedAt": 1755400000000
}
```

- `id` — the stable assistant key: `"claude"`, `"codex"`, `"grok"`, or `"antigravity"`. The set
  may grow; clients skip IDs they do not recognize.
- `name`, `vendor` — human-readable display names.
- `website` — the vendor's official page for the assistant.
- `providerId` — the built-in provider account this assistant's sign-in serves, as it appears in
  `GET /v0/config`, or `null` when no such account is configured.
- `installation` — where the program was found:
    - `status` — `"installed"` or `"missing"`.
    - `path` — the absolute path of the program the daemon uses, or `null` when missing.
    - `version` — the version the program reports, or `null` when missing or unknown.
    - `source` — how it was installed, or `null` when missing: `"standalone"` (the vendor's
      own installer), `"desktop_app"` (shipped inside the vendor's desktop application),
      `"package_manager"` (Homebrew, npm, or a version manager), or `"other"` (found on `PATH`
      or elsewhere). The set may grow; clients treat an unknown value as `"other"`.
    - `desktopApp` — the desktop application's display name, such as `"ChatGPT"` or `"Codex"`,
      when `source` is `"desktop_app"`; otherwise `null`.
- `installer` — what installing would do on this machine, or `null` when the vendor offers no
  installer for its operating system. It is present even when the program is already installed.
    - `command` — the exact command the daemon runs, which is also what a person would paste
      into a terminal to do it themselves. On macOS and Linux it is a POSIX shell pipeline; on
      Windows it is a PowerShell command.
    - `sourceUrl` — the HTTPS URL of the vendor's installer script that the command downloads.
      The script itself downloads the program from the vendor's own servers.
    - `sourceHost` — the host of `sourceUrl`, for the disclosure ("from claude.ai").
    - `vendorSite` — the vendor's official site.
- `commands` — what a person types to use the assistant in their own terminal: `run` starts it
  and `signIn` signs it in. When the program is installed somewhere that is not on the person's
  `PATH`, these may still name the bare program; clients present them as guidance, not as
  something the daemon runs.
- `signIn` — the sign-in as the program last reported it:
    - `status` — `"signed_in"`, `"signed_out"`, or `"unknown"`. `"unknown"` means the daemon
      could not tell, for example because the program is missing or its check timed out. On
      macOS, Claude Code keeps its sign-in in the keychain, which only the person's desktop
      session can read; a daemon running outside that session reports Claude Code as
      `"unknown"` rather than `"signed_out"`, so a client does not ask a signed-in person to sign
      in again.
    - `account` — `{ "email", "plan" }` while signed in, each a string or `null` when the vendor
      does not reveal it; `null` otherwise. `plan` is human-readable, such as `"Pro"` or `"Max"`.
    - `methods` — the sign-in methods the program supports, in the order the daemon prefers them:
      `"browser"` (a web page on this computer completes the sign-in by itself) and `"device"` (a
      web page on any device, confirmed with a short code). Empty when the program is missing.
- `operation` — the current or most recent install or sign-in, or `null` when there has been
  none. It is described below.
- `version` — a UUIDv7 minted whenever any field changes. Events carry the complete object, so
  a client reconciling a snapshot with an event keeps the greater version.
- `updatedAt` — when any field last changed, in epoch milliseconds.

Discovery checks the program on `PATH` and every place the vendor's installers, desktop
applications, and common package managers put it, and prefers the most specific: an installation
from the vendor's own installer, then one inside the vendor's desktop application, then one from
a package manager, then anything else on `PATH`. Inside desktop applications it checks, among
others, `/Applications/Codex.app/Contents/Resources/codex` and
`/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex`, and the Claude Code the
Claude desktop app keeps. Discovery and the sign-in check read the programs' own sign-in files
and run only their version and status commands, each bounded to ten seconds; the daemon makes
no network request of its own for them.

### The operation object

```json
{
    "id": "q7x0v2m9k3c1a8b4d6e5f0g1",
    "kind": "sign_in",
    "status": "waiting",
    "message": "Waiting for you to finish signing in to Claude in your browser.",
    "authorization": {
        "method": "browser",
        "url": "https://claude.com/cai/oauth/authorize?...",
        "userCode": null,
        "openedByProgram": false,
        "acceptsCode": true,
        "expiresAt": 1755400600000
    },
    "output": ["Opening browser to sign in…"],
    "error": null,
    "startedAt": 1755400000000,
    "finishedAt": null
}
```

- `id` — a CUID2 naming this operation.
- `kind` — `"install"` or `"sign_in"`.
- `status` — one of:
    - `"running"` — the daemon is working: downloading, installing, or starting the sign-in.
    - `"waiting"` — a sign-in is waiting for the person to finish it; `authorization` is present.
    - `"succeeded"`, `"failed"`, `"cancelled"` — terminal. `error` is present only on
      `"failed"`.
- `message` — one human-readable English sentence describing the current step or the outcome,
  suitable to show as is.
- `authorization` — present while a sign-in is `"waiting"`, otherwise `null`:
    - `method` — `"browser"` or `"device"`.
    - `url` — the vendor's page to open. A client opens it in the person's browser unless
      `openedByProgram` is `true`, and keeps it available to open again. A `"browser"` sign-in
      completes through a page served on this computer, so the browser must run on the daemon's
      machine. A `"device"` sign-in may be completed on any device.
    - `userCode` — the code the person confirms on a `"device"` page, or `null`.
    - `openedByProgram` — `true` when the vendor's program has already opened the system
      browser on the daemon's machine itself.
    - `acceptsCode` — `true` when the vendor's page may instead show a code for the person to
      paste back, which a client submits with `POST /v0/provider-clis/:cliId/sign-in/code`.
    - `expiresAt` — when the daemon gives up waiting, in epoch milliseconds. A sign-in waits at
      most ten minutes.
- `output` — the last lines the vendor's program printed, at most 20 lines of at most 500
  characters each, with terminal control sequences removed. URLs and codes the program prints are
  kept; credentials never appear there because the programs do not print them. It is held only
  in memory and is empty after the daemon restarts.
- `error` — `{ "code", "message" }` on a failed operation, otherwise `null`. `message` is
  human-readable English. Known codes are `install_failed` (the installer exited with an
  error), `not_found` (the installer finished but the program cannot be found), `sign_in_failed`
  (the vendor's program reported a failed sign-in), `expired` (the person did not finish in
  time), `interrupted` (the daemon restarted while it ran), and `unavailable` (the program could
  not be started). The set grows; clients tolerate unknown codes.
- `startedAt`, `finishedAt` — epoch milliseconds; `finishedAt` is `null` until terminal.

A provider CLI has at most one operation at a time. Its result stays on the object until the
next operation starts. Operations are durable: an install interrupted by a daemon restart runs
again when the daemon starts, because the vendors' installers are safe to repeat. A sign-in
cannot survive a restart, since the vendor's waiting program ended with the daemon, so it
becomes `"failed"` with code `interrupted`, and the person starts it again.

A successful install or sign-in runs the provider scan (see `POST /v0/providers/scan`), so the
newly usable account is discovered and enabled under the ordinary scan rules, and then emits
`config.updated`.

### `GET /v0/provider-clis`

Response — `200`: `{ "providerClis": [ { ... } ] }`, one provider CLI object for every supported
assistant in display order: Claude Code, Codex, Grok, Antigravity.

The read refreshes discovery and the sign-in check for every assistant without a running
operation, joining a refresh already in progress. A changed object emits `provider_cli.updated`.

### `GET /v0/provider-clis/:cliId`

Response — `200`: `{ "providerCli": { ... } }` after refreshing that one assistant as above.
An unknown ID returns `404`.

### `POST /v0/provider-clis/:cliId/install`

Starts installing the assistant with exactly the `installer.command` the object reports, from
the vendor's official installer. Request body, optional:

```json
{ "mutationId": "optional-client-value" }
```

The installer runs as the daemon's operating-system user, with no visible terminal or console
window, and with no prompt for input. Vendor installers put the program in the user's own
directories and need no administrator rights.

Response — `200`: `{ "providerCli": { ... } }` with the new `"running"` install operation. Each
step, each output line, and the final result emit `provider_cli.updated`. The install succeeds
only when the program is then found and reports its version.

- Starting while an install of the same assistant is running joins it and returns it unchanged.
- `409` with code `already_installed` and the current `providerCli` when the program is already
  installed and no install is running.
- `409` with code `busy` and the current `providerCli` while a sign-in is running.
- `409` with code `no_installer` and the current `providerCli` when `installer` is `null`.

### `POST /v0/provider-clis/:cliId/sign-in`

Starts the vendor's own sign-in with the installed program. Request body, every field optional:

```json
{ "method": "device", "mutationId": "optional-client-value" }
```

- `method` — one of the object's `signIn.methods`. Omitted, the daemon uses the first.

Response — `200`: `{ "providerCli": { ... } }` with the new `"running"` sign-in operation. It
becomes `"waiting"` with its `authorization` as soon as the vendor's program provides the page to
open, normally within seconds, and then `"succeeded"`, `"failed"`, or `"cancelled"`. Success is
decided by the program's own sign-in check, not by its exit alone. The successful object reports
`signIn.status: "signed_in"` and the account and plan when known.

Signing in while already signed in starts a new sign-in, which a person may use to change
accounts. Clients that only need a working sign-in check `signIn.status` first.

- Starting while a sign-in of the same assistant is running joins it and returns it unchanged.
- `400` with code `invalid_request` when `method` is not one of `signIn.methods`.
- `409` with code `not_installed` and the current `providerCli` when the program is missing.
- `409` with code `busy` and the current `providerCli` while an install is running.

### `POST /v0/provider-clis/:cliId/sign-in/code`

Hands the code the vendor's page showed to the waiting sign-in, for an `authorization` whose
`acceptsCode` is `true`. Request:

```json
{ "code": "the-code-from-the-page", "mutationId": "optional-client-value" }
```

`code` is 1–2,048 printable characters. The daemon writes it to the vendor's program and never
stores, returns, or logs it. Response — `200`: `{ "providerCli": { ... } }`. The outcome arrives
as for any sign-in. `409` with code `conflict` and the current `providerCli` when no sign-in is
waiting or it does not accept a code.

### `POST /v0/provider-clis/:cliId/cancel`

Cancels the running install or sign-in and stops the vendor's program. Request body, optional:
`{ "mutationId": "..." }`. Response — `200`: `{ "providerCli": { ... } }` whose operation is
`"cancelled"`. With no running operation, the object is returned unchanged. A cancelled install
may leave a partly installed program; the next discovery reports what is there.

## Provider routes

A provider route is one way the daemon's machine can already reach models: a vendor's own sign-in,
a sign-in inside a vendor's desktop app, an API key, a local proxy such as CLIProxyAPI, a router
such as Claude Code Router, an AWS profile for Bedrock, or a local model server such as LM Studio.
Provider routes let onboarding show what a person can use right away, and nothing else, and set a
chosen route up with its recommended configuration.

Detection only discovers. It never runs inference, never calls a vendor's or a cloud's API, and
never installs, starts, or signs in to anything. It reads local files and the daemon's own process
environment and reuses the checks described under Provider CLIs. It never runs a shell or any other
program to find more, and the daemon never reads the macOS keychain. Its only network requests are `GET /v1/models` to a model server on `127.0.0.1`, each
bounded to 1.5 seconds: at the port a detected program's configuration names, and at the default
ports of LM Studio (`1234`) and Ollama (`11434`). A local proxy's own client key from its
configuration is sent only there. Responses never include a key, a token, or a credential file's
contents.

Routes belong to the daemon's machine and its operating-system user, so these routes are
unavailable in team mode: every route returns `501` with code `unsupported` before parsing a
request body. A daemon that serves them reports `capabilities.providerRoutes: true` from health.
Older daemons omit it and answer with `404`; clients then rely on `GET /v0/provider-clis` and the
provider scan.

### The provider route object

```json
{
    "id": "cliproxyapi",
    "kind": "local_proxy",
    "name": "CLIProxyAPI",
    "vendors": ["Anthropic", "OpenAI"],
    "billing": "subscription",
    "account": { "label": null, "email": null, "plan": null, "count": null },
    "endpoint": "http://127.0.0.1:8317/v1",
    "status": "ready",
    "models": [{ "id": "claude-opus-5-5", "vendor": "Anthropic" }],
    "overlaps": ["claude", "codex"],
    "recommended": false,
    "warning": null,
    "providerId": null,
    "use": {
        "providerId": "cliproxyapi",
        "type": "openai_compatible",
        "summary": "Adds CLIProxyAPI on this computer with 12 models.",
        "restartRequired": true
    }
}
```

- `id` — stable for the same route across reads, 1–200 printable characters. Clients
  percent-encode it in paths. Current IDs are the built-in provider IDs `claude`, `codex`, `grok`,
  and `bedrock` for their default sign-in or credentials; `cliproxyapi`; `lmstudio`; `ollama`;
  `env:<VARIABLE>` for an API key in the daemon's environment; `ccr:<provider>` for one upstream
  provider of Claude Code Router; `aws_profile:<profile>` for an AWS profile; and
  `claude_home:<folder>` and `codex_home:<folder>` for another account's home folder in the
  person's home directory. Clients treat IDs as opaque.
- `kind` — `direct` (the vendor's own sign-in), `desktop_app` (a sign-in found through a vendor's
  desktop app), `api_key`, `local_proxy`, `router`, `cloud`, or `local_models`. Clients show
  unknown kinds as generic routes.
- `name` — display name, such as `"Claude Code"`, `"OpenRouter API key"`, or
  `"AWS profile work-bedrock"`.
- `vendors` — display names of whose models the route serves, sorted, possibly empty when the
  route does not say.
- `billing` — `subscription` when it spends a plan the person already pays for,
  `pay_per_token` for an API key or a cloud account billed by use, `local` for models running on
  this computer, or `unknown`.
- `account` — `null` when nothing is known. Otherwise `label` is display text, `email` and `plan`
  are set when a local file reveals them, and `count` is the number of accounts behind the route
  when it is more than one, such as a Grok sign-in holding several accounts.
- `endpoint` — the base URL of the server the route uses when that server runs on this computer;
  otherwise `null`.
- `status` — `ready` when it can be used now; `needs_sign_in` when its program is installed but
  signed out; `not_running` when a local server is installed but does not answer; `unauthorized`
  when a local server refused the key its configuration names; or `unknown` when detection cannot
  tell without a request it does not make, such as an AWS single-sign-on profile.
- `models` — models usable through the route now, at most 500: the server's own list for local
  routes, and the curated catalog for routes that are configured providers. `null` when unknown
  without a vendor request.
- `overlaps` — IDs of the other routes in this response that reach the same vendor. Using two
  overlapping routes spends the same vendor twice and leaves the choice between them to routing.
- `recommended` — the suggested initial selection: `true` for a `ready` `direct` or `desktop_app`
  route. Any other `ready` route is `true` when at least one of its vendors is served by no ready
  `direct` or `desktop_app` route and by no ready route before it in this order, so each vendor is
  reached one way by default. Every `local_models` route is `false`.
- `warning` — a display sentence when the route quietly changes what another route does, or
  `null`. For example, an `ANTHROPIC_API_KEY` in the daemon's environment takes precedence over
  the Claude Code sign-in, so Claude bills per token instead of using the plan.
- `providerId` — the configured provider this route already is, or `null`. A provider that `use`
  added and that takes effect after a restart is reported here too.
- `use` — `null` when the route is already configured and enabled, or cannot be set up
  automatically: a route whose `status` is `needs_sign_in`, `not_running`, or `unauthorized`, or a
  local server that lists no models. A route whose `status` is `unknown` can still be set up,
  because setting it up only writes configuration. Otherwise it describes what
  `POST /v0/provider-routes/:routeId/use` does: `providerId` and `type` of the provider it enables
  or adds, a display `summary`, and `restartRequired`, `true` when the provider is new and the
  daemon must restart before using it.

What choosing a route sets up, its recommended configuration:

| Route                                                 | Configuration                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude`, `codex`, `grok`, `bedrock`                  | Enables the built-in provider.                                                                                                                                                                                                                                                                                                                |
| `cliproxyapi`                                         | An `openai_compatible` provider `cliproxyapi` with `base_url` at the local proxy, the proxy's own client key as `api_key` (`local` when the proxy has none), and up to 200 models the proxy lists.                                                                                                                                            |
| `lmstudio`, `ollama`                                  | An `openai_compatible` provider with `base_url` at the local server, the placeholder `api_key = "local"` because it needs none, and up to 200 of the chat models it lists, leaving out embedding models. A server that does not answer is shown as `not_running` when its folder in the home directory shows it is installed.                 |
| `env:<VARIABLE>` for a known OpenAI-compatible vendor | An `openai_compatible` provider named after the vendor with its `base_url`, `api_key_env = "<VARIABLE>"`, and its models from the vendor's catalog in Happy Agent.                                                                                                                                                                            |
| `ccr:<provider>`                                      | An `openai_compatible` provider talking to that upstream directly, with its base URL, up to 200 of its models, and its key from Claude Code Router's `config.json`: copied as `api_key`, or as `api_key_env` when the router reads it from a variable the daemon also has. Only upstreams whose URL ends in `/chat/completions` can be added. |
| `aws_profile:<profile>`                               | A `bedrock` provider with that `profile` and its `region`.                                                                                                                                                                                                                                                                                    |
| `claude_home:<folder>`, `codex_home:<folder>`         | A `claude` provider with that `config_dir`, or a `codex` provider with that folder's `auth.json` as `auth_file`.                                                                                                                                                                                                                              |

The environment is read only for whether these variables are set: `CLAUDE_CODE_OAUTH_TOKEN`,
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `XAI_API_KEY`, which the built-in `claude`, `codex`, and
`grok` providers read when their configuration names no credentials; and `OPENROUTER_API_KEY`,
`DEEPSEEK_API_KEY`, `MISTRAL_API_KEY`, `GROQ_API_KEY`, `TOGETHER_API_KEY`, `FIREWORKS_API_KEY`, and
`MOONSHOT_API_KEY` for OpenAI-compatible vendors. A built-in key's route has that provider as
`providerId` only when the provider actually reads it. `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`,
and `XAI_API_KEY` take precedence over the vendor's CLI sign-in, so their route carries a `warning`
when that sign-in is ready. A vendor without a curated model catalog in Happy Agent is shown with
`models: null` and `use: null`.

AWS profiles come from the AWS config file, `AWS_CONFIG_FILE` or `~/.aws/config`: only each
profile's name, its `region`, and whether it uses single sign-on. The shared credentials file is
never opened. The `default` profile is listed as `bedrock` when the built-in provider finds local
AWS credentials, and as `aws_profile:default` only when the daemon has no built-in `bedrock`.

Other accounts' home folders are folders directly in the person's home directory named
`.claude-<name>` or `.codex-<name>` (or with `_` or `.` after the vendor), other than the one
`CLAUDE_CONFIG_DIR` or `CODEX_HOME` selects. A Claude folder holding a login in
`.credentials.json` is `ready`. One whose `.claude.json` only records a signed-in account is
`unknown`, because the macOS keychain keeps that login and is never read. A Codex folder is listed
when its `auth.json` holds a ChatGPT sign-in, billed as `subscription`, or an API key, billed as
`pay_per_token`. A provider already configured with the same folder is that route's provider.

New providers are written to the daemon-owned runtime configuration. A key copied there is stored
in plain text with the same exposure it had in the file it came from.

### `GET /v0/provider-routes`

Response — `200`:

```json
{ "routes": [{ "...": "provider route objects" }], "detectedAt": 1755400000000 }
```

Routes are ordered by `kind` in the order listed above, then by `name`. Each read detects again,
joining a provider CLI refresh already in progress.

### `POST /v0/provider-routes/:routeId/use`

Sets the route up as its `use` describes. Request body, optional:

```json
{ "mutationId": "optional-client-value" }
```

Response — `200`:

```json
{ "route": { "...": "the provider route object" }, "restartRequired": true }
```

The returned route has `providerId` set and `use` `null`. Enabling a built-in provider takes effect
at once. A new provider takes effect after the daemon restarts; until then `restartRequired` is
`true` and clients restart the daemon through the ordinary drain and restart. The change emits
`config.updated`.

- An unknown route returns `404`.
- `409` with code `conflict` and the current `route` when its `use` is `null`.

## Cloud

Cloud connects this Happy Agent installation to a person's Happy Cloud account. It is a separate
feature from the Happy mobile integration: Cloud uses WorkOS authentication and Happy Cloud HTTP
APIs, while the Happy integration manages the daemon's machine connection to the mobile app.
Cloud owns only authentication and organization (team) management.

The daemon owns Cloud authentication. It performs the WorkOS authorization-code flow with PKCE,
stores the rotating refresh token in its owner-only durable database, and mints short-lived access
tokens on demand. Refresh tokens, PKCE verifiers, and access tokens never appear in bootstrap,
status responses, events, logs, or error bodies. A minted access token appears only in the direct
successful response that requested it.

While connected, the daemon also refreshes the installation's main WorkOS session once per hour
in the background to prevent inactivity expiry. This refresh supplies no organization ID and
does not mint, enumerate, or populate cached tokens for teams or organizations. It uses the same
serialized refresh-and-verify boundary as on-demand minting, persists the replacement refresh
token before verification, and discards the resulting access token without exposing it.

The hourly schedule is durable, starts when sign-in commits, and resumes after daemon restart;
an overdue refresh runs once when the daemon resumes, without replaying missed hours. Existing
connected installations acquire the schedule on startup. Sign-out or authoritative credential
rejection cancels it transactionally. A rolled-back sign-out leaves the schedule intact. Temporary
refresh or verification failures preserve the connected session and leave the next hourly attempt
scheduled. Background refresh does not change the public snapshot or emit an event unless verified
user metadata changes or credentials are authoritatively rejected. Status reads remain local.
This requires the daemon to be running with network access; it cannot revive an expired or revoked
session, override WorkOS's maximum session length, or keep a stopped installation active.

### The Cloud object

Disconnected:

```json
{
    "status": "disconnected",
    "environment": null,
    "user": null,
    "authorization": null,
    "error": null,
    "version": "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e",
    "updatedAt": 1755400000000
}
```

Authorizing:

```json
{
    "status": "authorizing",
    "environment": "production",
    "user": null,
    "authorization": {
        "url": "https://api.workos.com/user_management/authorize?...",
        "expiresAt": 1755400600000
    },
    "error": null,
    "version": "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e",
    "updatedAt": 1755400000000
}
```

Connected:

```json
{
    "status": "connected",
    "environment": "production",
    "user": {
        "id": "user_01H...",
        "email": "person@example.com",
        "firstName": "Ada",
        "lastName": "Lovelace"
    },
    "authorization": null,
    "error": null,
    "version": "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e",
    "updatedAt": 1755400000000
}
```

- `status` — exactly `"disconnected"`, `"authorizing"`, or `"connected"`.
- `environment` — `"production"` or `"staging"` while authorizing or connected, and `null`
  while disconnected. These select Happy's fixed WorkOS client and Cloud deployment; clients
  cannot supply an endpoint or client ID.
- `user` — the verified WorkOS user while connected and `null` otherwise. `firstName` and
  `lastName` are each strings or `null`; `id` and `email` are strings.
- `authorization` — present only while authorizing. `url` is the complete WorkOS URL to open and
  `expiresAt` is its absolute ten-minute expiry. The client treats the URL as opaque.
- `error` — `null`, or `{ "code": "...", "message": "..." }` on a disconnected snapshot.
  Known codes are `authorization_expired`, `authorization_rejected`, and
  `credentials_rejected`; clients tolerate unknown values. Transient WorkOS or Happy Cloud
  availability failures are request errors and do not invalidate an otherwise connected
  snapshot.
- `version` — a UUIDv7 minted whenever the snapshot changes. `cloud.updated` carries the complete
  object, so clients reconciling a REST snapshot with an event keep the greater version.
- `updatedAt` — when any field in the snapshot last changed.

The daemon durably preserves the Cloud version high-water mark. Every replacement is greater than
every Cloud version that installation previously exposed, including across restarts and system
clock rollback.

### `GET /v0/cloud`

Response — `200`: `{ "cloud": { ... } }` with the current Cloud object.

This is a local status read. It performs no WorkOS refresh or Happy Cloud network request.

### `POST /v0/cloud/auth/start`

Unavailable in team mode: returns `501` with code `unsupported` before parsing the request body
or starting authorization. It changes no Cloud state and emits no event.

Starts or joins a WorkOS authorization-code flow with PKCE. Request:

```json
{
    "environment": "production",
    "redirectUri": "happy-auth://callback",
    "mutationId": "optional-client-value"
}
```

`redirectUri` is a valid absolute URI no longer than 2048 characters and must be registered for
the selected WorkOS client. This supports distinct callbacks for desktop and future applications;
the daemon passes the value to WorkOS unchanged and binds the PKCE attempt to it. The response
returns immediately. The client opens the opaque authorization URL and later submits the complete
URL received by that callback handler to the completion endpoint.

Starting while connected returns `409` with code `conflict` and the current `cloud`; disconnect
first to change accounts. Starting with the same environment and redirect URI while authorizing is
idempotent. Selecting different parameters replaces the pending attempt. A changed snapshot emits
one `cloud.updated`; an idempotent retry emits nothing.

Response — `200`: `{ "cloud": { ... } }` with the authorizing Cloud object.

### `POST /v0/cloud/auth/complete`

Unavailable in team mode: returns `501` with code `unsupported` before parsing the request body
or exchanging credentials, including for attempts started before enabling team mode. It changes
no Cloud state and emits no event.

Completes the one pending authorization attempt. Request:

```json
{
    "callbackUrl": "happy-auth://callback?code=...&state=...",
    "mutationId": "optional-client-value"
}
```

`callbackUrl` is at most 4096 characters. It must have no fragment or user information, exactly one
non-empty `state`, and either exactly one non-empty `code` or one OAuth `error`. Its scheme,
authority, and path must exactly match the attempt's stored redirect URI, and its `state` must
exactly match the state generated by the daemon. URI and state validation happen before the
attempt is consumed: a malformed or wrong-state callback leaves the legitimate attempt active.

A valid-state callback atomically consumes the attempt. An OAuth denial settles disconnected
`authorization_rejected`. Otherwise the daemon exchanges the code and PKCE verifier through the
WorkOS Node SDK, then calls the selected Happy Cloud deployment's authenticated `/v0/hello`. It
accepts the login only when that response is successful and its `userId` exactly matches the WorkOS
user ID. Only then does it durably store the refresh token and expose a connected snapshot.

Response — `200`: `{ "cloud": { ... } }` with the connected Cloud object and one
`cloud.updated` event.

Malformed callbacks and URI/state mismatches return `400` with code `invalid_request`, include the
current `cloud`, and leave an unexpired matching attempt untouched. An absent, expired, or
already-consumed attempt also returns `400`; an expired attempt settles disconnected
`authorization_expired`. An OAuth denial, WorkOS code rejection, or failed initial identity
verification returns `409` with code `cloud_unauthorized`. A transient WorkOS or Happy Cloud
failure returns `503` with code `cloud_unavailable`. These failures include the current `cloud`
object, never store the new login, and always settle a callback they consumed into a disconnected
snapshot. Authoritative rejection stores a display-safe error; transient failure leaves its
`error` null. A changed snapshot emits one `cloud.updated`, and clients may start a new attempt.

### `DELETE /v0/cloud/auth`

Disconnects Cloud locally. The optional JSON body is `{ "mutationId": "..." }`; an empty body is
equivalent to `{}`. In one local transaction it cancels any pending authorization expiry and hourly
session refresh, removes the stored session and refresh token, and persists a clean disconnected
snapshot. It performs no remote request or background teardown and does not revoke the person's
WorkOS browser session or affect other applications. Another authorization may begin as soon as
sign-out commits.

Response — `200`: `{ "cloud": { ... } }` with a clean disconnected Cloud object. A changed
snapshot emits one `cloud.updated`; an already-clean disconnected snapshot emits nothing.

### `POST /v0/cloud/access-token`

Mints a short-lived Cloud access token. The optional JSON body is
`{ "mutationId": "..." }`; an empty body is equivalent to `{}`. The daemon serializes minting so
a rotating WorkOS refresh token is never used concurrently. It stores WorkOS's replacement refresh
token before making the Happy Cloud verification request, then calls the selected deployment's
authenticated `/v0/hello` and checks the returned user ID before releasing the access token.

Response — `200`:

```json
{
    "accessToken": "eyJ...",
    "cloud": {
        /* current connected Cloud object */
    }
}
```

No configured account returns `409` with code `cloud_not_authenticated` and the current `cloud`.
An authoritative WorkOS refresh rejection removes the refresh token, replaces the snapshot with
disconnected `credentials_rejected`, emits `cloud.updated`, and returns `409` with code
`cloud_unauthorized` and the new `cloud`. A WorkOS transport failure, Happy Cloud transport or
server failure, `/v0/hello` rejection, or user-ID mismatch returns `503` with code
`cloud_unavailable` and preserves the replacement refresh token and connected snapshot. Happy
Cloud's rejection alone is not treated as proof of revocation because its token-verification
dependencies may themselves be temporarily unavailable. No access token is returned unless the
verification succeeds.

The minted token is not scoped to an organization: the daemon refreshes the session without one.
It is therefore not a bearer token for a WorkOS team daemon, which requires an `org_id` claim equal
to its organization. To reach a team remote, send requests through
`/v0/connections/:id/api/*`, which mints and caches the organization-scoped token internally
and never returns it.

### Cloud organizations

Cloud organizations are managed only by a standalone Happy Agent. They are the WorkOS
organizations associated with the currently connected Cloud user's WorkOS identity. An
organization is:

```json
{
    "id": "org_01H...",
    "name": "Analytical Engines"
}
```

`id` is an opaque WorkOS organization ID rather than a Happy Agent CUID2. `name` is non-empty
human-readable text of at most 512 characters. The daemon validates and bounds every Happy Cloud
response before returning it.

These endpoints are unavailable in team mode. Every organization request in team mode returns
`501` with code `unsupported` before parsing a mutation body, refreshing Cloud credentials, or
contacting Happy Cloud. A team deployment's configured organization is deployment-owned and cannot
be listed or changed through its own API.

Organization changes themselves emit no Happy Agent event. The daemon serializes the requests with
other Cloud authentication operations, stores a rotated refresh token before making the Happy
Cloud request, verifies the minted access token, and never returns that token. Authentication side
effects such as discovering changed WorkOS user metadata or rejected credentials may still replace
the normal Cloud snapshot and emit `cloud.updated`. The daemon does not automatically replay an
ambiguous organization mutation.

#### `GET /v0/cloud/organizations`

Lists every organization associated with the connected Cloud user. Response — `200`:

```json
{
    "organizations": [{ "id": "org_01H...", "name": "Analytical Engines" }]
}
```

The array contains at most 10,000 organizations and preserves Happy Cloud's order.

#### `POST /v0/cloud/organizations`

Creates a WorkOS organization and makes the connected Cloud user its administrator. Request:

```json
{
    "name": "Analytical Engines",
    "mutationId": "optional-client-value"
}
```

`name` must contain 1–255 Unicode characters after surrounding whitespace is trimmed and may not
contain control or format characters. `mutationId` is not sent to Happy Cloud and does not dedupe
the remote mutation; it tags any synchronous `cloud.updated` event caused by authentication side
effects while preparing the request. Response — `201`:

```json
{
    "organization": { "id": "org_01H...", "name": "Analytical Engines" }
}
```

#### `DELETE /v0/cloud/organizations/:id`

Deletes an organization only when the connected Cloud user is an active administrator. The
optional JSON body is `{ "mutationId": "optional-client-value" }`; an empty body is equivalent to
`{}`. Response — `200`: `{ "deleted": true }`.

For all three endpoints, no connected Cloud account returns `409` with code
`cloud_not_authenticated` and the current `cloud`. Invalid names, malformed IDs, and malformed
bodies return `400` with code `invalid_request` without performing the requested Happy Cloud
organization operation. Deleting an organization the connected user does not administer returns
`403` with code `forbidden`. WorkOS refresh rejection returns `409` with code
`cloud_unauthorized`; transient WorkOS failures, rejected or malformed Happy Cloud responses, and
Happy Cloud availability failures return `503` with code `cloud_unavailable`. Cloud errors include
the authoritative current `cloud` and never include credentials or upstream response bodies.

## Happy integration

The Happy integration connects this daemon to the Happy mobile app. It is separate from Cloud's
WorkOS authentication and organization management; personal mobile connections do not change
the Cloud API. Its state is runtime state rather than a durable resource guarded by `If-Match`:
the daemon exposes one current snapshot per connection owner and announces complete replacements
whenever it changes. Credentials, tokens, private keys, and server responses are never exposed
through this API.

In standalone mode, the connection remains installation-wide. In team mode, every locally
onboarded user owns a separate personal mobile connection, identified by their installation-local
Happy user ID. Authentication selects the owner for every integration endpoint and desktop
bootstrap; clients cannot supply an owner override. Even the installation owner can only manage
their own mobile connection through these endpoints.

This scoping is transparent to clients. Existing routes, request and response bodies, bootstrap
fields, and event payloads are unchanged. No owner field is added to the integration snapshot or
event payload, and no protocol-version bump, client capability check, or SDK release is needed.
Connection ownership and event visibility are daemon-internal state derived from authentication.

Team users pair independently and the daemon maintains their mobile connections in parallel.
Pairing attempts, credentials and encryption keys, remote machine and session bindings, sync
progress, connection status, and version high-water marks are isolated by owner. Starting,
cancelling, unlinking, re-pairing, or rejecting credentials for one user never replaces or closes
another user's connection. A slow or unavailable connection must not block another user's
pairing or synchronization. Restart reconnects each user's saved connection independently,
without requiring that user to have an open desktop connection.

Team mode never imports installation-wide or external Happy CLI credentials into a user's
connection and never assigns an existing installation-wide mobile link to a member. Each member
must explicitly pair their own account; unowned installation credentials remain unused and are
not deleted. A shared integration-disable setting still disables all mobile connections without
mixing their credentials or snapshots. Standalone credential adoption remains unchanged.

Personal connections do not change the team's existing access to shared projects, agents, or
bots. Each connection synchronizes the work its owner may access through the team API, using
its own remote bindings. Incoming mobile messages carry that connection owner's authenticated
Happy user ID in `metadata.userId`; the mobile payload cannot override it. Other incoming mobile
operations execute with the same team-user authority, not installation-owner authority.

### The Happy integration object

```json
{
    "status": "pairing",
    "configured": false,
    "authorization": {
        "kind": "qr",
        "data": "happy://terminal?MDEyMzQ1Njc4OWFiY2RlZg",
        "expiresAt": 1755400120000
    },
    "error": null,
    "version": "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e",
    "updatedAt": 1755400000000
}
```

- `status` — one of:
    - `"disabled"` — the Happy integration is disabled in this daemon's configuration.
    - `"disconnected"` — no Happy machine connection is live. `configured` distinguishes a
      daemon that still needs pairing from one that already has credentials and lost its
      connection.
    - `"pairing"` — the daemon is waiting for the person to authorize it from Happy. The
      `authorization` value is present.
    - `"connecting"` — usable credentials exist and the daemon is establishing its Happy machine
      connection.
    - `"connected"` — the Happy machine connection is live.
    - `"failed"` — a pairing or connection attempt reached a terminal failure and no automatic
      retry is active. The `error` value is present; starting again retries.
- `configured` — whether the daemon currently holds valid durable Happy credentials. It says
  nothing about network health and may remain `true` while the integration is disabled or
  disconnected. Credentials rejected by Happy are no longer valid, so the daemon reports
  `configured: false` and the next start creates a fresh pairing attempt.
- `authorization` — `null` except while `status` is `"pairing"`. `data` is the complete public
  payload a client encodes as a QR code or offers as a copyable deep link; it is opaque to the
  client and must not be parsed or rebuilt. `expiresAt` is the attempt's absolute expiry in epoch
  milliseconds. Pairing attempts expire after two minutes.
- `error` — `null`, or `{ "code": "...", "message": "..." }`. `code` is a stable snake_case
  machine value and `message` is human-readable English safe to display. Known codes are
  `happy_unavailable`, `authorization_expired`, `credentials_rejected`, and `invalid_response`;
  the set grows, and clients must tolerate unknown values. A transient connection problem may be
  present while `status` is `"disconnected"`; `status: "failed"` always has an error.
- `version` — a UUIDv7 minted whenever this snapshot changes. The event carries the complete
  object rather than a version-chain diff, so a client reconciling a REST snapshot with an event
  keeps the object with the greater version.
- `updatedAt` — when any field in this snapshot last changed.

The fields form a status-discriminated state rather than independent flags:

- `"disabled"` has no authorization or error and may be configured or unconfigured;
- `"disconnected"` has no authorization, may be configured or unconfigured, and may carry a
  transient connection error;
- `"pairing"` is unconfigured, has an authorization, and has no error;
- `"connecting"` and `"connected"` are configured and have neither authorization nor error;
- `"failed"` has an error and no authorization, and may be configured or unconfigured depending
  on which operation failed.

The daemon durably preserves the integration version high-water mark for each owner. Every
replacement is greater than every integration version previously exposed for that owner,
including across daemon restarts and system-clock rollback. Versions belonging to different
users are not compared. Clients switching authenticated users discard the previous user's
integration snapshot and reload the new user's bootstrap and event stream.

Pairing state and its ephemeral private key live only in this daemon process. A restart abandons
an unfinished attempt and returns to `"disconnected"`; durable credentials survive and the new
process proceeds through `"connecting"` as it reconnects.

When Happy rejects credentials, the daemon removes its owned copy and remembers the fingerprint of
the matching external Happy CLI credential. Restarting must not import that same rejected credential
again. A genuinely changed external credential may be imported, and successful pairing clears the
rejection marker. The same suppression applies when a person explicitly unlinks the integration;
unlinking never edits the external Happy CLI installation. These external-credential rules apply
only in standalone mode; team connections use only their individually paired credentials.

All operations below address the selected owner's connection. In team mode, reads, mutation
responses and errors, and desktop bootstrap contain only the authenticated user's integration.
`happy.integration.updated` is delivered only to that owner, both in event pulls and in live or
replayed SSE. Other members never receive its snapshot, authorization payload, or error. An old
installation-wide integration event with no owner is not delivered to team clients. This
privacy boundary is enforced by the daemon, not by client-side filtering.

### `GET /v0/integrations/happy`

Response — `200`: `{ "integration": { ... } }` with the current Happy integration object.

### `POST /v0/integrations/happy/start`

Starts or joins the current integration attempt and returns immediately. The operation is
idempotent and has no request body:

- an active pairing attempt returns the same authorization payload and expiry;
- a configured daemon starts or continues connecting without replacing its credentials;
- an already connected daemon remains connected;
- a disconnected, unconfigured daemon or a failed attempt without valid credentials creates a
  fresh two-minute pairing attempt;
- rejected credentials are invalidated before the state becomes `"failed"`, so a retry can always
  return to pairing rather than getting stuck with an unusable credential.

Response — `200`: `{ "integration": { ... } }`. Every state transition, including the one caused
by this request, emits one `happy.integration.updated`; retries that leave the snapshot unchanged
do not emit duplicates. When the integration is disabled, the request returns `503` with code
`unsupported` and includes the current `integration` object in the error body; reading its disabled
state still succeeds.

If the daemon cannot create the authorization request because Happy is unavailable, the request
returns `503` with code `happy_unavailable` and includes the current `integration` object. No
attempt was started, the snapshot is unchanged, and no event is emitted. Failures after a pairing
attempt has started settle through the integration snapshot and its update event instead.

### `POST /v0/integrations/happy/cancel`

Cancels an active pairing attempt without unlinking configured credentials. The operation is
idempotent and has no request body. A pairing snapshot becomes unconfigured `"disconnected"` with
no authorization or error. Every other state is returned unchanged, including `"disabled"`.

Response — `200`: `{ "integration": { ... } }`. A cancelled pairing emits one
`happy.integration.updated`; a no-op emits nothing.

### `DELETE /v0/integrations/happy`

Unlinks the selected owner's mobile connection from Happy and removes this computer from their
Happy account. The operation cancels pairing and closes that owner's live Happy connection, so
nothing is published while it runs. When the owner holds credentials and the integration is
enabled, the daemon then uses those credentials to delete, in order:

1. this daemon's own Happy machine registration. Happy deletes the sessions it attributes to that
   machine with it, the same as when the computer is deleted from Happy Mobile;
2. every remaining Happy session this daemon created for that owner on the current account, as
   recorded in its own synchronization state. This covers sessions published before Happy
   attributed sessions to machines and Happy servers that do not delete them with the machine.

Sessions the daemon did not record as its own, such as Happy CLI sessions or another computer's
sessions on the same account, are never deleted. A session or machine Happy no longer has counts
as already deleted. Once Happy confirms both steps, the daemon forgets its machine identity, so a
later pairing registers a new computer, and removes the owner's daemon-owned credentials. In
standalone mode it also suppresses re-import of the exact external credential present when the
person unlinked. It never changes or deletes external Happy CLI credentials or another team user's
credentials. The operation is idempotent and has no request body.

If Happy cannot confirm the removal because it is unreachable, times out, or answers with an
error, the request returns `503` with code `happy_unavailable` and the current `integration`
object. That snapshot is `"failed"`, still `configured`, and carries a `happy_unavailable` error.
The credentials and machine identity are kept and the connection stays closed while the daemon
runs. Repeating the request resumes the removal and skips what is already gone. Starting the
integration instead keeps the link and reconnects, which republishes this computer's sessions; a
daemon restart does the same. If Happy had already deleted the machine, reconnecting finds it
deleted and completes the unlink as described below. The daemon never falls back to a local-only
unlink on its own. If Happy rejects the credentials, they can no longer remove anything, so the
daemon completes the unlink locally and keeps the machine identity. When the integration is
disabled in configuration, unlinking makes no Happy requests and only removes the local
credentials.

Deleting this computer from Happy, for example from Happy Mobile, has the same effect as this
operation. A connected daemon learns of the deletion immediately, and a daemon that was not
running learns of it when it next connects with the same credentials. Either way it completes this
unlink and publishes the same unconfigured snapshot, without an error. Pairing again is the person
asking for the computer back, so a deletion never unlinks a connection that was just paired. This
relies on a Happy server that reports deleted computers; with an older server, a deletion made
elsewhere removes only the machine, and the daemon registers it again when it next connects.

The resulting snapshot of a completed unlink is unconfigured, with no authorization or error. Its
status is `"disabled"` when the integration is disabled in configuration and `"disconnected"`
otherwise.

Response — `200`: `{ "integration": { ... } }`. A changed snapshot emits one
`happy.integration.updated`; an already-unlinked snapshot emits nothing. A removal failure emits the
`"failed"` snapshot before the `503` response.

### `POST /v0/integrations/happy/re-pair`

Explicitly replaces the current Happy authorization. The operation has no request body. It first
performs the unlink behavior above—even when already connected or pairing—and then creates a fresh
two-minute pairing attempt. The returned authorization therefore differs from every attempt this
operation replaced.

Response — `200`: `{ "integration": { ... } }` with the fresh `"pairing"` snapshot. Unlinking and
starting the new attempt each emit their own complete `happy.integration.updated` snapshot when
they change state. When disabled, the request returns `503` with code `unsupported` and the current
integration. When Happy cannot confirm removing this computer, the request returns the unlink's
`503` `happy_unavailable` failure unchanged and starts no attempt. When Happy cannot create the
fresh authorization request, it returns `503` with code `happy_unavailable` and the now-unlinked
`"disconnected"` integration; the previous credentials remain removed so a later retry cannot
silently reconnect the account the person chose to replace.

## Mobile connector

The mobile connector lets a phone reach this daemon directly, without a relay. The phone scans a QR
code shown on the desktop, runs a key exchange with the daemon over a dedicated private Tailcat
socket or a configured public HTTPS endpoint, and derives a long-term device token from that
exchange. Both screens then show the same
four emoji. Pairing completes only when the person at the desktop and the person on the phone have
both confirmed that the emoji match, so a leaked QR code by itself never yields a paired device.
A paired phone then uses this same API over that socket with its device token.

Happy Agent ships no phone code. A phone implements its side from this section alone; the fixed
test vectors and the emoji table below are the reference it is checked against.

The machine setting `[feature.mobile_connector]` has `enabled`, default `true`, and `port`, default
`24781` (the Tailcat port). These are machine-only settings. Public reachability instead belongs to
the daemon's `[api] public_url` and `public_port`, as specified under Transport; the connector
consumes that endpoint and does not own another public URL or port.

In standalone mode the installation's one person owns the pairing and the paired phones. In team
mode each locally onboarded user has their own: authentication selects the owner for every route,
no route takes an owner, and a phone acts with the authority of the user who paired it. Each owner
has at most one pairing at a time.

Pairing state lives only in daemon memory and a restart abandons an unfinished pairing. Paired
phones are stored in the main database by the SHA-256 of their device token, never the token.

### The connector's socket

By default the connector's socket is a Tailcat exposure with its own stable identity, separate from
`[feature.tailcat]`. The phone dials `server.tailcat` on the port from the QR code through a
Tailcat client for the address from the QR code. Tailcat encrypts the traffic and authenticates the
server. The address carries the identity's WireGuard key and pre-shared key, so it is a secret:
phones keep it with the device token and never log it.

When the daemon has a public origin, mobile connections use its shared public listener with the
phone credential restrictions below. The connector starts no listener or Tailcat exposure of its
own. The daemon's public listener remains available independently of pairing demand and connector
enablement; disabling mobile pairing does not disable ordinary public API access. Phones use the
daemon's advertised HTTPS origin and the TLS requirements specified under Transport.

Behind the socket is this API: the same routes, Server-Sent Events, WebSocket upgrades, and
`CONNECT` tunnels as on the main transports, which are the Unix socket, the team TCP listener, and
the `[feature.tailcat]` exposure. The socket differs only in the credentials it accepts.

Without a public endpoint, the mobile socket is open only while a pairing is active, for three seconds after a pairing ends, or while
at least one phone is paired. The three seconds let the answer to the request that ended a pairing,
and a status read it woke, reach the phone. A restart reopens the socket when phones are paired.
When nothing needs it, or the feature is disabled, the mobile socket is not exposed. In public mode
the connector reports `open` while enabled and the daemon's shared public transport is ready, even
with no pairing or devices; `disabled` still means phone credentials are refused, not that the
daemon's public listener is closed.

### Credentials on the connector's socket

Every mobile request, WebSocket upgrade, and `CONNECT` is authenticated with one of three bearer
credentials, on either the dedicated Tailcat socket or the shared public listener:

```
Authorization: Bearer <credential>
```

- A **device token**, `base64url(deviceToken)`, authenticates a paired phone. It acts with the
  authority of the user who created the pairing, and may use every route that user may use, except:
    - daemon lifecycle and debugging: `/v0/drain`, `/v0/shutdown`, and `/v0/debug` and everything
      under it;
    - mobile connector management: `/v0/mobile-connector` and everything under it, so one phone
      can neither pair nor remove others.

    Those return `403` with code `forbidden`, whatever the method.

- The QR code's **pairing token** `t` authenticates only `POST /v0/mobile-connector/handshake`.
- A **handshake credential**, the `handshakeId` that start returned, authenticates only that
  handshake's own routes: `GET /v0/mobile-connector/handshake` and
  `POST /v0/mobile-connector/handshake/reveal`, `/confirm`, and `/reject`.

On the dedicated mobile Tailcat socket, anything else receives `401` with code `unauthorized` and no `authentication` field: a missing
header, an unknown or removed device's token, a used, replaced, or expired pairing token, a
handshake the daemon no longer knows, a pairing or handshake credential on any other route, and
every credential of the main transports, namely the standalone token, WorkOS and JWT access
tokens, runner tokens, and bridge tokens. On this socket no endpoint is unauthenticated,
`GET /v0/authentication` included.

The primary Unix/team transports and their `[feature.tailcat]` exposure never accept a device token,
a pairing token, or a handshake credential: they receive `401` like any unknown token. The handshake
routes are not served on a primary transport and return `404` with code `not_found`. The daemon-owned public listener is
the explicit exception: it accepts ordinary and mobile credentials with their separate authority
and handshake rules, as specified under Credentials on the public transport. The pairing routes
and cryptographic exchange are identical on both mobile-capable transports.

Removing a device from the desktop makes its token fail at once and closes every request, event
stream, WebSocket, and `CONNECT` tunnel it has open. The device's `lastSeenAt` moves forward at most
once a minute as the phone uses its token.

### The mobile connector object

```json
{
    "status": "open",
    "pairing": {
        "id": "pq7xk2m9r4t8w1y5z3a6b0c2",
        "status": "verifying",
        "qr": null,
        "expiresAt": 1755400420000,
        "device": { "name": "Steve's iPhone", "platform": "ios" },
        "emoji": ["🐶", "🎸", "🍕", "🚀"],
        "desktopConfirmed": false,
        "mobileConfirmed": true,
        "error": null
    },
    "devices": [
        {
            "id": "dv3n8k1m5q9r2t6w0y4z7a1c",
            "name": "Steve's iPhone",
            "platform": "ios",
            "createdAt": 1755400000000,
            "lastSeenAt": 1755400300000
        }
    ],
    "error": null,
    "version": "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e",
    "updatedAt": 1755400300000
}
```

- `status` — the transport available to the connector, one of:
    - `"disabled"` — `[feature.mobile_connector] enabled` is `false`;
    - `"closed"` — enabled without a public endpoint, but nothing needs the mobile socket;
    - `"starting"` — the socket is opening;
    - `"open"` — the local transport is ready for phones; this does not prove that public DNS,
      TLS, or the proxy works;
    - `"failed"` — the transport could not open; `error` says why. For the dedicated Tailcat
      socket, the next pairing or device change tries again. A failed public listener is owned by
      the daemon; repair its configuration or port conflict and restart.
- `pairing` — the caller's current or most recent pairing, or `null`. A finished pairing stays here
  until the next start or cancel, so the desktop can show how it ended.
    - `id` — a CUID2 naming this pairing in the desktop routes.
    - `status` — one of:
        - `"waiting"` — waiting for a phone. Before a phone uses the code, `qr` is set and `device`
          is `null`. Once a phone has used it, `qr` is `null` and `device` is set, until the
          phone's key arrives a moment later.
        - `"verifying"` — the keys are exchanged. `device` and `emoji` are set, and the pairing
          waits for both confirmations.
        - `"completed"` — both people confirmed and the phone is paired; it is in `devices`.
        - `"rejected"` — the person on the phone said the emoji do not match.
        - `"expired"` — five minutes passed before both confirmations arrived.
        - `"cancelled"` — the desktop cancelled it, or a newer pairing replaced it.
        - `"failed"` — the phone's key did not match the one it committed to, the phone's key
          could not be used, the phone's confirmation did not prove it derived the same keys, or
          the socket could not open. `error` says which, in English safe to display.
    - `qr` — the complete `happy://direct?…` text to show as a QR code while it can still be used;
      `null` otherwise. It contains a one-time secret token and the socket's secret address, so
      clients show it only on screen and never log or store it. Its format is specified under "The
      QR code"; desktop clients treat it as opaque.
    - `expiresAt` — epoch milliseconds five minutes after the pairing started. Everything, both
      confirmations included, must happen before it.
    - `device` — `{ name, platform }` as the phone described itself, or `null`. `name` is 1–128
      printable characters; `platform` is `"ios"`, `"android"`, or `"other"`. The phone chose
      these values, so they are for display and prove nothing.
    - `emoji` — the four emoji to compare, set from `"verifying"` on and kept on a finished
      pairing that reached it; `null` otherwise. Show them exactly as given.
    - `desktopConfirmed`, `mobileConfirmed` — which confirmations have arrived.
    - `error` — `null`, or an English message for a `"failed"` pairing.
- `devices` — the caller's paired phones, oldest first. `createdAt` is when pairing completed;
  `lastSeenAt` starts equal to it and afterwards moves forward, at most once a minute, when the
  phone uses its token.
- `error` — `null`, or an English message while `status` is `"failed"`.
- `version` — a UUIDv7 minted for the caller whenever this snapshot changes. The event carries the
  complete object, so a client keeps the one with the greater version.
- `updatedAt` — when the snapshot last changed.

### `GET /v0/mobile-connector`

Response — `200`: `{ "mobileConnector": { ... } }`. This also answers while the feature is
disabled, with `status: "disabled"`.

### `POST /v0/mobile-connector/pairing`

Starts a pairing, opening the socket if needed, and returns once the QR code is ready. It has no
request body. Any earlier pairing of the caller's is cancelled and replaced, so its code stops
working. If the socket cannot open, the response still succeeds and carries a `"failed"` pairing
and a `"failed"` status.

Response — `200`: `{ "mobileConnector": { ... } }`. When the feature is disabled, the request
returns `503` with code `unsupported`.

### `POST /v0/mobile-connector/pairing/confirm`

```json
{ "pairingId": "pq7xk2m9r4t8w1y5z3a6b0c2" }
```

The person at the desktop says the emoji match. If the phone has already confirmed, the phone is
paired and the pairing becomes `"completed"` in the response; otherwise the pairing stays
`"verifying"` with `desktopConfirmed: true` until the phone confirms.

Response — `200`: `{ "mobileConnector": { ... } }`. A `pairingId` that is not the caller's current
pairing returns `404` with code `not_found`. A pairing that is not `"verifying"`, including one
that has just expired, returns `409` with code `conflict`.

### `POST /v0/mobile-connector/pairing/cancel`

```json
{ "pairingId": "pq7xk2m9r4t8w1y5z3a6b0c2" }
```

The person at the desktop says the emoji do not match, or gives up. An active pairing becomes
`"cancelled"` and nothing is paired. A finished pairing is dismissed, so `pairing` becomes `null`.
Any other `pairingId` changes nothing, so a repeated cancel is harmless.

Response — `200`: `{ "mobileConnector": { ... } }`.

### `DELETE /v0/mobile-connector/devices/:deviceId`

Removes one of the caller's paired phones. Its token stops working at once, every request, stream,
WebSocket, and tunnel it has open is closed, and the socket closes if nothing else needs it. This
also works while the feature is disabled.

Response — `200`: `{ "mobileConnector": { ... } }`. A phone that is not one of the caller's returns
`404` with code `not_found`.

### Events

Every change to a caller's snapshot emits `mobile_connector.updated` with the complete object. It is
delivered only to that owner, in event pulls and in live or replayed streams, and never to another
team member.

### The QR code

```
happy://direct?<base64url(UTF-8 JSON)>
```

The scheme is Happy's existing `happy`, the host is `direct`, and the query is the whole bundle
with no `=` or padding. Happy's older relay pairing uses `happy://terminal?…`, so the host alone
tells the two apart: the app accepts `happy://direct?` alongside `happy://terminal?` and treats
each according to its host. The bundle is plain encoding, not encryption:

```json
{
    "v": 1,
    "a": "tcEXAMPLE…",
    "p": 24781,
    "t": "Ad3…43 characters…",
    "n": "Steve's Mac",
    "e": 1755400420000
}
```

| key | meaning                                                                  |
| --- | ------------------------------------------------------------------------ |
| `v` | format version, `1`                                                      |
| `a` | the connector's Tailcat address, exactly as Tailcat printed it; a secret |
| `p` | the port to dial on `server.tailcat`                                     |
| `t` | the one-time pairing token: base64url of 32 random bytes                 |
| `n` | the daemon's node name, for display only and untrusted                   |
| `e` | the pairing's expiry in epoch milliseconds, for display only             |

A reader ignores unknown keys. A bundle whose `v` is a number other than `1` asks the person to
update the app unless it supports that additional version. Anything else is not a pairing code.

#### Public HTTPS QR codes (version 2)

An HTTPS-configured connector emits the same `happy://direct?` envelope with this new variant:

```json
{
    "v": 2,
    "u": "https://agent.example.com",
    "t": "Ad3…43 characters…",
    "n": "Steve's Mac",
    "e": 1755400420000
}
```

`u` is the canonical HTTPS origin described above; the phone rejects noncanonical or non-HTTPS
values rather than correcting a scanned code. `t`, `n`, and `e` have the same meanings as version 1.
Version 1 and its required `a` and `p` fields are unchanged; version 2 is a separate opt-in format,
with no Tailcat address. Readers supporting version 2 must continue to accept version 1. Older
readers show their existing update-required message, never interpret `u` as a Tailcat identity.
After pairing, the phone stores the HTTPS origin alongside its device ID and device token and uses
that origin for every HTTP request, event stream, WebSocket, and tunnel.

The token exists only in daemon memory. It expires five minutes after the pairing started and is
consumed by the first start that presents it, whatever happens next. The daemon never logs it.

### Encoding

All binary values in JSON and in bearer credentials are base64url without padding, in canonical
form. A 32-byte value is exactly 43 characters. `‖` is concatenation, `lp(x)` is a 4-byte
big-endian length followed by `x`, and text labels are UTF-8 bytes with no length prefix. The
primitives are X25519, SHA-256, HMAC-SHA-256, and HKDF-SHA-256.

### Pairing

```
Phone                                                   Daemon
a, A = X25519 key pair; Nm = 32 random bytes
C = SHA256("happy-mobile-pair-v1/commit" ‖ A ‖ Nm)
POST /v0/mobile-connector/handshake          Bearer t
     {commitment: C, device}
                                                        consume the token
                                                        b, B = X25519 key pair; Nd = 32 random
                       ←  {handshakeId, publicKey: B, nonce: Nd, expiresAt}
POST /v0/mobile-connector/handshake/reveal   Bearer handshakeId
     {publicKey: A, nonce: Nm}
                                                        check C; derive the secrets
                       ←  {status: "verifying"}
both people compare the emoji
POST /v0/mobile-connector/handshake/confirm  Bearer handshakeId
     {mac: MAC("mobile")}
GET  /v0/mobile-connector/handshake?wait=25  Bearer handshakeId, until "completed"
                       ←  {status: "completed", deviceId, mac: MAC("daemon")}
check MAC("daemon"), then store {address, port, deviceId, deviceToken}
```

#### Derivation

Both sides compute, independently:

```
K           = X25519(own private key, peer public key)
TH          = SHA256("happy-mobile-pair-v1" ‖ lp(t) ‖ lp(C) ‖ lp(A) ‖ lp(B) ‖ lp(Nm) ‖ lp(Nd)
                     ‖ lp(utf8(address)) ‖ lp(u16be(port)))
PRK         = HKDF-Extract(salt = TH, ikm = K)
emojiKey    = HKDF-Expand(PRK, "happy-mobile-pair-v1 emoji", 32)
confirmKey  = HKDF-Expand(PRK, "happy-mobile-pair-v1 confirm", 32)
deviceToken = HKDF-Expand(PRK, "happy-mobile-pair-v1 device-token", 32)
emoji       = stringForEmojiHashOfData(SHA256(emojiKey), 4)
MAC(role)   = HMAC-SHA256(confirmKey, role ‖ TH), role "mobile" or "daemon"
```

- `t` is the token's 32 raw bytes, not its base64url text.
- The phone uses the address and port it dialed from the QR code, and the daemon uses the ones it
  serves, so a replaced QR code changes the transcript and the emoji.
- For HTTPS QR version 2, `address` is the exact canonical `u` string, including `https://` and any
  nondefault explicit port, and `port` is that URL's effective port (443 when omitted). The daemon
  freezes both values when it creates the QR code. The transcript label, HKDF labels, commitment,
  emoji algorithm, confirmation MACs, and all handshake routes are unchanged. The loopback proxy
  port is never used in this transcript.
- Either side refuses a shared secret `K` of all zeros, which every low-order public key produces.
- The daemon never sends emoji. The phone computes them itself.
- The device token never crosses the wire. Both sides derive it, and the daemon stores only
  `SHA256(deviceToken)` over its 32 raw bytes.

The commitment makes a relaying attacker choose the key it shows the phone before it learns the
phone's key, and the single-use token stops it retrying against the daemon. Its chance of matching
emoji is about 1 in 333⁴, roughly 1 in 1.2·10¹⁰.

#### Emoji

The emoji function is Telegram iOS's, from
`submodules/TelegramCallsUI/CallsEmoji/Sources/CallsEmoji.m` in TelegramMessenger/Telegram-iOS:

- `stringForEmojiHashOfData(data, count)` takes exactly 32 bytes. For `i` from `0` to `count - 1`,
  it reads bytes `[8i, 8i + 8)` as a big-endian 64-bit integer, clears its top bit, and takes the
  remainder modulo 333 as an index into `emojisArray()`. The value exceeds 2⁵³, so JavaScript uses
  `BigInt`.
- `emojisArray()` has 333 entries, with the exact strings including U+FE0F variation selectors
  such as `"✌️"`, `"⚡️"`, and `"1️⃣"`. The SHA-256 of the entries joined by `\n` in UTF-8, with
  no trailing newline, is `c22c3a00d5a68df075fecc8cb8b730a45817a246a5ca70fa3b75d248ac5b54e9`. The
  table is reproduced in full under "The emoji table" below; never normalize or reorder it.
- `stringForEmojiHashOfData(x, 4)` gives:
    - for `x` = 32 zero bytes: 😉 😉 😉 😉
    - for `x` = `000102…1f`: 💍 ☔️ 📅 🍞
    - for `x` = `SHA256(000102…1f)`: 🙉 🇷🇺 ☔️ ✈️

#### Test vectors

With phone private key `01`×32, daemon private key `02`×32, token `03`×32, phone nonce `04`×32,
daemon nonce `05`×32, address `tcFixedVectorAddress`, and port `24781`, every value in hex:

| value                 | hex                                                                |
| --------------------- | ------------------------------------------------------------------ |
| `A`                   | `a4e09292b651c278b9772c569f5fa9bb13d906b46ab68c9df9dc2b4409f8a209` |
| `B`                   | `ce8d3ad1ccb633ec7b70c17814a5c76ecd029685050d344745ba05870e587d59` |
| `C`                   | `ae75325169fe3b8d8571df1c5fd015ef9989051a0363e780322a09ebf2430caf` |
| `K`                   | `2ed76ab549b1e73c031eb49c9448f0798aea81b698279a0c3dc3e49fbfc4b953` |
| `TH`                  | `919140a78d542ec0999e8b045e9b368c94a5cc2d90d6c92e7f14e8d6d302eb08` |
| `emojiKey`            | `fa42488ee1ceadb6998e8d35792cdda1a1210a63153069fe67f1f1ce57404369` |
| `confirmKey`          | `152eb695974a86f350d777dd1a7e63abb327eb6af37ee465addbb46ea53cde3f` |
| `deviceToken`         | `05bf38156a0b81046b4e15f584760e0e8996efe81239e5efe4560fef29c20aeb` |
| `MAC("mobile")`       | `56562cd319819213d10c33fd9e508fffb19343d84b14882ecfc550c058181d85` |
| `MAC("daemon")`       | `81fa0f2f506f539f4ca3f22eeeac675850f3cd902719f14799fc6519266893c9` |
| `SHA256(deviceToken)` | `dd652c0915a809fbbdbedc963a8ddf0c940cff4bda204d9b9d886b3e661f67b1` |

The emoji for these values are 🌀 👗 ⏳ 👟.

### Handshake routes

These routes exist on the dedicated mobile Tailcat socket and the daemon-owned public listener,
never on the primary transports. Each takes only the pairing credential named for it, as described
under "Credentials on the connector's socket". A handshake's status is described by:

```json
{ "status": "completed", "deviceId": "dv3n8k1m5q9r2t6w0y4z7a1c", "mac": "…43 characters…" }
```

`status` is one of:

- `"verifying"` — the pairing is in progress, including while it waits for either confirmation;
- `"completed"` — both people confirmed. Only this status carries `deviceId` and `mac`, which is
  `MAC("daemon")`. The phone stores nothing until that MAC checks out.
- `"rejected"` — the pairing ended without a device: the phone or the desktop said the emoji do not
  match, the desktop cancelled, or a key or MAC was wrong;
- `"expired"` — five minutes passed first.

Every failure is immediate and final. A wrong commitment, an unusable key, or a wrong MAC ends the
pairing, and the single-use token cannot start another. A handshake the daemon no longer knows, for
example after a restart or after the desktop started a newer pairing, fails authentication with
`401`, which phones treat as `"expired"`.

### `POST /v0/mobile-connector/handshake`

Authenticated by the QR code's pairing token.

```json
{
    "commitment": "…C…",
    "device": { "name": "Steve's iPhone", "platform": "ios" }
}
```

`device.name` is 1–128 printable characters and `device.platform` is `"ios"`, `"android"`, or
`"other"`. The desktop shows them beside the emoji.

Response — `200`:

```json
{
    "handshakeId": "…43 characters…",
    "publicKey": "…B…",
    "nonce": "…Nd…",
    "expiresAt": 1755400420000
}
```

`handshakeId` is a separate random 32 bytes, not the desktop's pairing ID, and is the credential
for the rest of the handshake. It is a secret: phones send it only in the `Authorization` header
and never log it. A malformed body returns `400` with code `invalid_request` and still consumes the
token.

### `POST /v0/mobile-connector/handshake/reveal`

Authenticated by the handshake credential.

```json
{ "publicKey": "…A…", "nonce": "…Nm…" }
```

Response — `200`: a handshake status. It is `"verifying"` when the key matched the commitment, and
`"rejected"` when it did not or could not be used. Revealing twice returns `409` with code
`conflict`.

### `POST /v0/mobile-connector/handshake/confirm`

Authenticated by the handshake credential.

```json
{ "mac": "…MAC(\"mobile\")…" }
```

The person on the phone says the emoji match. Response — `200`: a handshake status. It is
`"completed"` when the desktop had already confirmed, `"verifying"` while the desktop has not, and
`"rejected"` for a wrong MAC. Confirming before revealing returns `409` with code `conflict`.

### `POST /v0/mobile-connector/handshake/reject`

Authenticated by the handshake credential. It has no request body.

The person on the phone says the emoji do not match. Response — `200`: a handshake status,
normally `"rejected"`. Nothing is paired.

### `GET /v0/mobile-connector/handshake?wait=25`

Authenticated by the handshake credential. Reads the handshake's status. With `wait`, an integer
number of seconds up to 25, a `"verifying"` handshake answers when its status changes or when the
wait runs out, whichever is first. A finished handshake answers at once. Response — `200`: a
handshake status.

### The emoji table

The 333 entries of Telegram iOS's `emojisArray()`, in order, as a JSON array. Index `0` is 😉 and
index `332` is 🔷. Implementations copy these exact code points and check the SHA-256 above.

<!-- emoji-table-begin -->

```json
[
    "😉",
    "😍",
    "😛",
    "😭",
    "😱",
    "😡",
    "😎",
    "😴",
    "😵",
    "😈",
    "😬",
    "😇",
    "😏",
    "👮",
    "👷",
    "💂",
    "👶",
    "👨",
    "👩",
    "👴",
    "👵",
    "😻",
    "😽",
    "🙀",
    "👺",
    "🙈",
    "🙉",
    "🙊",
    "💀",
    "👽",
    "💩",
    "🔥",
    "💥",
    "💤",
    "👂",
    "👀",
    "👃",
    "👅",
    "👄",
    "👍",
    "👎",
    "👌",
    "👊",
    "✌️",
    "✋️",
    "👐",
    "👆",
    "👇",
    "👉",
    "👈",
    "🙏",
    "👏",
    "💪",
    "🚶",
    "🏃",
    "💃",
    "👫",
    "👪",
    "👬",
    "👭",
    "💅",
    "🎩",
    "👑",
    "👒",
    "👟",
    "👞",
    "👠",
    "👕",
    "👗",
    "👖",
    "👙",
    "👜",
    "👓",
    "🎀",
    "💄",
    "💛",
    "💙",
    "💜",
    "💚",
    "💍",
    "💎",
    "🐶",
    "🐺",
    "🐱",
    "🐭",
    "🐹",
    "🐰",
    "🐸",
    "🐯",
    "🐨",
    "🐻",
    "🐷",
    "🐮",
    "🐗",
    "🐴",
    "🐑",
    "🐘",
    "🐼",
    "🐧",
    "🐥",
    "🐔",
    "🐍",
    "🐢",
    "🐛",
    "🐝",
    "🐜",
    "🐞",
    "🐌",
    "🐙",
    "🐚",
    "🐟",
    "🐬",
    "🐋",
    "🐐",
    "🐊",
    "🐫",
    "🍀",
    "🌹",
    "🌻",
    "🍁",
    "🌾",
    "🍄",
    "🌵",
    "🌴",
    "🌳",
    "🌞",
    "🌚",
    "🌙",
    "🌎",
    "🌋",
    "⚡️",
    "☔️",
    "❄️",
    "⛄️",
    "🌀",
    "🌈",
    "🌊",
    "🎓",
    "🎆",
    "🎃",
    "👻",
    "🎅",
    "🎄",
    "🎁",
    "🎈",
    "🔮",
    "🎥",
    "📷",
    "💿",
    "💻",
    "☎️",
    "📡",
    "📺",
    "📻",
    "🔉",
    "🔔",
    "⏳",
    "⏰",
    "⌚️",
    "🔒",
    "🔑",
    "🔎",
    "💡",
    "🔦",
    "🔌",
    "🔋",
    "🚿",
    "🚽",
    "🔧",
    "🔨",
    "🚪",
    "🚬",
    "💣",
    "🔫",
    "🔪",
    "💊",
    "💉",
    "💰",
    "💵",
    "💳",
    "✉️",
    "📫",
    "📦",
    "📅",
    "📁",
    "✂️",
    "📌",
    "📎",
    "✒️",
    "✏️",
    "📐",
    "📚",
    "🔬",
    "🔭",
    "🎨",
    "🎬",
    "🎤",
    "🎧",
    "🎵",
    "🎹",
    "🎻",
    "🎺",
    "🎸",
    "👾",
    "🎮",
    "🃏",
    "🎲",
    "🎯",
    "🏈",
    "🏀",
    "⚽️",
    "⚾️",
    "🎾",
    "🎱",
    "🏉",
    "🎳",
    "🏁",
    "🏇",
    "🏆",
    "🏊",
    "🏄",
    "☕️",
    "🍼",
    "🍺",
    "🍷",
    "🍴",
    "🍕",
    "🍔",
    "🍟",
    "🍗",
    "🍱",
    "🍚",
    "🍜",
    "🍡",
    "🍳",
    "🍞",
    "🍩",
    "🍦",
    "🎂",
    "🍰",
    "🍪",
    "🍫",
    "🍭",
    "🍯",
    "🍎",
    "🍏",
    "🍊",
    "🍋",
    "🍒",
    "🍇",
    "🍉",
    "🍓",
    "🍑",
    "🍌",
    "🍐",
    "🍍",
    "🍆",
    "🍅",
    "🌽",
    "🏡",
    "🏥",
    "🏦",
    "⛪️",
    "🏰",
    "⛺️",
    "🏭",
    "🗻",
    "🗽",
    "🎠",
    "🎡",
    "⛲️",
    "🎢",
    "🚢",
    "🚤",
    "⚓️",
    "🚀",
    "✈️",
    "🚁",
    "🚂",
    "🚋",
    "🚎",
    "🚌",
    "🚙",
    "🚗",
    "🚕",
    "🚛",
    "🚨",
    "🚔",
    "🚒",
    "🚑",
    "🚲",
    "🚠",
    "🚜",
    "🚦",
    "⚠️",
    "🚧",
    "⛽️",
    "🎰",
    "🗿",
    "🎪",
    "🎭",
    "🇯🇵",
    "🇰🇷",
    "🇩🇪",
    "🇨🇳",
    "🇺🇸",
    "🇫🇷",
    "🇪🇸",
    "🇮🇹",
    "🇷🇺",
    "🇬🇧",
    "1️⃣",
    "2️⃣",
    "3️⃣",
    "4️⃣",
    "5️⃣",
    "6️⃣",
    "7️⃣",
    "8️⃣",
    "9️⃣",
    "0️⃣",
    "🔟",
    "❗️",
    "❓",
    "♥️",
    "♦️",
    "💯",
    "🔗",
    "🔱",
    "🔴",
    "🔵",
    "🔶",
    "🔷"
]
```

<!-- emoji-table-end -->

## Secrets

Secrets are an installation-wide catalog of named environment bundles. They do not belong to the
agent that created them. A secret becomes usable by an agent only through an attachment to a
project, workspace, or exact agent.

Secret values are **write-only** through this API. They are accepted in the `environment` field of
create and update requests, but no response, event, conflict body, or bootstrap object ever contains
them. Safe metadata includes the description and environment-variable names. An update that rotates
a value without changing its variable name still advances the secret version and emits an update,
but does not disclose what changed inside the value.

### The secret object

```json
{
    "id": "s4e6c8r0e2t4i6d8",
    "description": "Deployment API credentials",
    "environmentVariables": ["DEPLOY_API_TOKEN", "DEPLOY_ORGANIZATION"],
    "managed": false,
    "availableToAgents": true,
    "version": "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e",
    "createdAt": 1755400000000,
    "updatedAt": 1755400000000
}
```

- `id` — the secret's installation-wide name: 2–32 characters matching
  `[a-z][a-z0-9_-]*`. A daemon-generated name is a CUID2, while a caller-supplied name may also
  contain underscores and dashes.
- `description` — human-readable text, 1–2,000 characters after trimming.
- `environmentVariables` — the bundle's variable names, sorted lexically. Names match
  `[A-Za-z_][A-Za-z0-9_]*`, are case-insensitively unique, and never reveal their values.
- `managed` — `false` for a secret created through this API; `true` when another daemon feature or
  integration owns its lifecycle. Managed secrets are visible here but cannot be updated or
  deleted through the public secret mutation endpoints.
- `availableToAgents` — whether an attachment may grant agents access to the secret. A secret set
  to `false` has no attachments.
- `version` — the UUIDv7 concurrency version used by `If-Match` and `secret.updated`.
- `createdAt`, `updatedAt` — lifecycle timestamps. Rotating a value changes `updatedAt` even when
  every safe metadata field remains the same.

One secret contains at most 256 variables. Each value is a string of at most 65,536 characters and
must not contain NUL. Variable names are safe metadata, but callers should still choose names that
do not themselves contain confidential information.

### Attachments and effective availability

An attachment is an immutable grant from one secret to one typed target:

```json
{
    "id": "a7t5t3a1c9h7m5n3",
    "secretId": "s4e6c8r0e2t4i6d8",
    "target": { "type": "workspace", "id": "w9x8y7z6" },
    "createdAt": 1755400000000
}
```

The allowed target types are `"project"`, `"workspace"`, and `"agent"`. The target type is part
of the identity: because a project and its root workspace share an ID, a project attachment and a
root-workspace attachment are distinct grants with different reach.

- A project attachment applies to agents in the project's root workspace and every descendant
  workspace.
- A workspace attachment applies to agents whose `workspaceId` is exactly that workspace. It does
  not flow into child workspaces.
- An agent attachment applies only to that exact agent, not to its subagents.

An agent's effective secrets are the union of those three sources. The grant follows current and
future agents that match it; updating a secret leaves every attachment intact. Archiving a target
preserves its attachments, but attaching to an archived or archiving target is a `409` conflict.
Detaching remains allowed. An unknown target is `404`.

Answering a secret request, described under Questions, also creates an exact-agent attachment for
the agent that asked. That answer is the person's direct client action, like the attachment
endpoint below, and does not pass through the agent's Auto reviewer.

An attachment only makes the secret eligible for explicit use. It does not inject the bundle into
every command. A shell tool call names the attached secret IDs it needs, and only those bundles are
added to that command's environment. In Auto permission mode, selecting any secret always triggers
review. Secret provisioning and sandbox elevation are separate decisions: the command may stay
sandboxed with a secret, run elevated without a secret, or request both. Agent tools that create,
update, attach, or detach secrets also require Auto review. Direct authenticated HTTP mutations are
client actions and do not pass through the agent's Auto reviewer.

### `GET /v0/secrets`

Lists the global catalog as safe metadata, oldest first. It may instead list the secrets directly
attached to one exact typed target; inherited project or workspace grants are not expanded by this
filter.

Query parameters:

- `cursor` — optional secret ID.
- `limit` — optional, `1`–`100`, default `50`.
- `targetType`, `targetId` — optional paired filter. Supply both or neither. `targetType` is
  `project`, `workspace`, or `agent`; an unknown target is `404`.

Response — `200`:

```json
{
    "secrets": [
        /* secret objects; never values */
    ],
    "nextCursor": null
}
```

`nextCursor` is the last returned secret ID when another page exists, otherwise `null`.

### `GET /v0/secrets/:secretId`

Returns one safe secret object.

Response — `200`: `{ "secret": { ... } }`; `404` when no such secret exists. Values are never
included.

### `POST /v0/secrets`

Creates one user-created global secret without attaching it anywhere.

Request:

```json
{
    "id": "optional-client-supplied-name",
    "description": "Deployment API credentials",
    "environment": {
        "DEPLOY_API_TOKEN": "raw-value",
        "DEPLOY_ORGANIZATION": "acme"
    },
    "availableToAgents": true,
    "mutationId": "optional-client-value"
}
```

`id` is optional and, when supplied, follows the secret-name syntax above; the daemon mints a
CUID2 name when omitted. `environment` contains 1–256 variables. `availableToAgents` is optional
and defaults to `true`. Client-created secrets always have `managed: false`. An existing explicit
ID is a `409` conflict; creation never replaces an existing secret.

Response — `201`: `{ "secret": { ... } }`, containing metadata only. The mutation emits
`secret.created` with the optional `mutationId`.

### `PATCH /v0/secrets/:secretId`

Partially updates one user-created secret. Requires `If-Match` with the secret version.

Request — at least one mutable field:

```json
{
    "description": "Rotated deployment credentials",
    "environment": {
        "DEPLOY_API_TOKEN": "new-raw-value",
        "DEPLOY_ORGANIZATION": null
    },
    "availableToAgents": true,
    "mutationId": "optional-client-value"
}
```

Omitted fields stay unchanged. In the `environment` patch, a string creates or replaces one value
and `null` removes that variable. The resulting bundle must contain 1–256 variables. Names in one
request must be case-insensitively unique. Setting `availableToAgents` to `false` while any
attachment exists is a `409` conflict; detach it everywhere first. A managed secret is also a
`409` conflict because its owner is responsible for rotation.

A stale `If-Match` returns the standard `409` with `currentVersion` and the safe current `secret`,
never its values. Response — `200`: `{ "secret": { ... } }`. A changed secret emits
`secret.updated`; a request that leaves description, environment, and availability identical does
not advance the version or emit an event.

### `DELETE /v0/secrets/:secretId`

Deletes one user-created secret together with all of its direct attachments, in one atomic change.
Requires `If-Match` with the secret version. The optional JSON body is `{ "mutationId": "..." }`;
an empty body is equivalent to `{}`.

Every project, workspace, and agent grant of the secret is removed with it, so no agent can select
the secret afterwards. Detaching alone revokes grants but leaves the catalog entry in place.

`404` when no such secret exists. A managed secret is a `409` conflict because the daemon feature
that owns it is responsible for its lifecycle. A stale `If-Match` returns the standard `409` with
`currentVersion` and the safe current `secret`, never its values.

Response — `200`: `{ "secret": { ... } }`, the deleted secret's final safe metadata. Values are
never included. The deletion emits `secret.removed` with the optional `mutationId`.

If a daemon feature retires a managed secret that it owns, the secret and its direct attachments
likewise disappear atomically through `secret.removed`.

### `GET /v0/secrets/:secretId/attachments`

Lists the secret's direct attachments, oldest first. This does not expand project or workspace
inheritance into one row per effective agent.

Query parameters: `cursor` (optional attachment ID), `limit` (optional, `1`–`100`, default `50`).

Response — `200`:

```json
{
    "attachments": [
        /* attachment objects */
    ],
    "nextCursor": null
}
```

`404` when the secret does not exist. `nextCursor` follows the same convention as the secret list.

### `PUT /v0/secrets/:secretId/attachments/:targetType/:targetId`

Attaches the secret directly to one `project`, `workspace`, or `agent`. The JSON body is optionally
`{ "mutationId": "..." }`; an empty body is equivalent to `{}`. No `If-Match` is needed because
the relation has one composite identity and the operation is idempotent.

Response — `201` for a new grant or `200` when it already existed:

```json
{
    "attachment": {
        /* attachment object */
    },
    "created": true
}
```

`created` is `false` for the idempotent case. A new grant emits `secret.attached`; a no-op emits
nothing. A secret with `availableToAgents: false` is a `409` conflict.

### `DELETE /v0/secrets/:secretId/attachments/:targetType/:targetId`

Detaches the exact direct grant. Inherited access from another matching attachment is unaffected.
The optional JSON body is `{ "mutationId": "..." }`; an empty body is equivalent to `{}`. No
`If-Match` is needed and the operation is idempotent.

Response — `200`:

```json
{
    "detached": true,
    "attachment": {
        /* the attachment that was removed */
    }
}
```

A removed grant emits `secret.detached`; a no-op returns `detached: false`, `attachment: null`, and
emits nothing.

## Cluster secrets

Cluster secrets are Happy Cloud's typed secret catalog. **Only a cluster serves this chapter.** The
Happy Agent daemon does not implement these routes and answers them with `404`. A cluster does not
serve `/v0/secrets`; it answers `404`. The environment bundles in the Secrets chapter above are the
daemon's, and the catalog below is the cluster's. A client picks the chapter by the server it talks
to.

This chapter is additive and does not change the protocol version, which describes the daemon. It
adds nothing to any daemon request, response, or event.

Each organization has one catalog. A secret has one of four types: `endpoint`, `ssh_key`,
`git_credential`, or `environment`. The cluster keeps other kinds of secrets, such as provider
credentials and plugin secrets, outside this catalog. To these routes their IDs are unknown.

Secret values are **write-only**. They go in the `material` field of create and update requests.
No response or conflict body contains them. The rest of a secret is metadata, which people who
cannot open the secret may still see.

### The cluster secret object

```json
{
    "id": "c1k2s3e4c5r6e7t8i9d0a1b2",
    "type": "endpoint",
    "name": "Stripe API",
    "description": "Live key for billing agents",
    "public": {
        "targets": [
            { "host": "api.stripe.com", "pathPrefixes": ["/v1"], "methods": ["GET", "POST"] }
        ],
        "algorithm": {
            "kind": "headers",
            "headers": [{ "name": "Authorization", "prefix": "Bearer " }]
        }
    },
    "uses": ["egress"],
    "owner": "team",
    "access": { "use": true, "manage": true, "attach": true },
    "roles": { "member": { "level": "use", "hidden": false } },
    "version": "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e",
    "createdAt": 1755400000000,
    "updatedAt": 1755400000000
}
```

- `id` — a 24-character CUID2 the cluster generates. Clients never choose one.
- `type` — `endpoint`, `ssh_key`, `git_credential`, or `environment`. It never changes.
- `name` — what people see: 1–100 characters after trimming, without control characters. Names
  need not be unique.
- `description` — 0–2,000 characters after trimming.
- `public` — the type's metadata, described below.
- `uses` — the parts of the system that may open the value, sorted and unique. An `endpoint` allows
  `egress` and `mcp`, an `ssh_key` allows `ssh`, a `git_credential` allows `git`, and an
  `environment` allows `environment` and `mcp`.
- `owner` — `"me"` for the caller's own secret, which no one else sees or uses; `"team"` for the
  organization's.
- `access` — what the caller may do. `use`: runs acting for the caller may receive it. `manage`:
  the caller may change, delete, and grant it. `attach`: the caller may grant it.
- `roles` — present only on a team secret the caller manages. It maps a role ID to that role's
  rule, `{ "level": "none" | "use" | "manage", "hidden": boolean }`. Roles without a rule hold
  `level: "none"` and `hidden: false`.
- `version` — the UUIDv7 used by `If-Match`. Every change to the secret, its rules, or its grants
  advances it.
- `createdAt`, `updatedAt` — timestamps. Replacing `material` changes `updatedAt` even when no
  metadata changes.

#### Public metadata by type

**`endpoint`** — `{ targets, algorithm }`. The cluster's egress proxy applies the value to matching
requests.

- `targets` — 1–16 objects of `{ host, ports?, pathPrefixes?, methods? }`. `host` is a name, an
  address, or `*.` and a name of at least two labels; a wildcard matches subdomains only. `ports`
  holds at most 16 ports and defaults to 443. `pathPrefixes` holds at most 16 paths starting with
  `/`; `/v1` admits `/v1` and `/v1/…`. `methods` holds at most 9 HTTP method names. An absent list
  means any path or any method.
- `algorithm` — `{ "kind": "headers", "headers": [{ "name", "prefix"? }] }` with 1–8 distinct
  headers. The proxy sets each header to `prefix` followed by the value. `prefix` is at most 32
  printable ASCII bytes.

**`ssh_key`** — `{ publicKey, fingerprint, hosts, ports?, knownHosts? }`. The cluster signs with the
key; the key never reaches a node.

- `publicKey`, `fingerprint` — derived from the private key. A request may omit them; a request
  that sends them must match the key.
- `hosts` — 1–16 names, addresses, or `*.name` patterns.
- `ports` — at most 8 ports besides 22.
- `knownHosts` — at most 32 plain `known_hosts` lines.

**`git_credential`** — `{ server, port?, method, repos?, operations }`. It authenticates git to one
server.

- `server` — one host name or address, never a pattern. `port` only when the server is not on 22
  (SSH) or 443 (HTTPS).
- `method` — one of:
    - `{ "kind": "ssh_key", "publicKey", "fingerprint", "knownHosts"? }`. The key fields are derived
      as for an `ssh_key` secret.
    - `{ "kind": "password", "username" }` for HTTPS basic authentication.
    - `{ "kind": "token", "username"? }` for an access token, as basic authentication with
      `username` or as a bearer token without one.
- `repos` — at most 64 patterns such as `owner/repo` or `owner/*`. An absent list means every
  repository on the server.
- `operations` — any of `read`, `write`, and `sign`. Only the `ssh_key` method may `sign`.

**`environment`** — `{ variables }`: the bundle's variable names, sorted. Derived from `material`; a
request may omit `public` entirely.

#### Material by type

- `endpoint` — an object with one string per header in `algorithm.headers`, keyed by header name.
  Each value is 16–4,096 printable ASCII bytes without `[` or `]`.
- `ssh_key`, and a `git_credential` with the `ssh_key` method — `{ "privateKey", "passphrase"? }`.
  The key is an OpenSSH private key of at most 16 KiB. `passphrase` is a string or `null`.
- `git_credential` with the `password` method — `{ "password" }`; with the `token` method —
  `{ "token" }`. Each is 16–4,096 printable ASCII bytes without `[` or `]`.
- `environment` — 1–256 variables, as in the Secrets chapter: names match
  `[A-Za-z_][A-Za-z0-9_]*` and are case-insensitively unique, and each value is at most 65,536
  characters without NUL.

### Visibility and errors

Lists and reads show only what the caller may see. A secret the caller may not see, an ID that is
malformed or unknown, and a provider or plugin secret's ID all answer the same `404`. The routes add
these errors to the common ones:

- `403 forbidden` — the caller sees the secret but lacks the access the mutation needs.
- `409 conflict` — a stale `If-Match`, carrying `currentVersion` and the current `secret` and never
  its values; or a grant to an archived target.
- `503` — the cluster cannot seal values.

### `GET /v0/cluster/secrets`

Lists the secrets the caller may see.

Query parameters: `cursor` (optional, the previous page's `nextCursor`), `limit` (optional,
`1`–`100`, default `50`). Any other parameter is `400`.

Response — `200`:

```json
{
    "secrets": [
        /* cluster secret objects; never values */
    ],
    "nextCursor": null
}
```

`nextCursor` is an opaque string when another page exists, otherwise `null`. A cursor stays valid
when the secret it ended on is deleted.

### `GET /v0/cluster/secrets/:secretId`

Response — `200`: `{ "secret": { ... } }`.

### `POST /v0/cluster/secrets`

Creates a secret. A team secret needs the `secrets.manage` permission; the caller's own secret needs
`secrets.own`.

Request:

```json
{
    "type": "git_credential",
    "name": "GitLab deploy token",
    "description": "Read access to infrastructure repositories",
    "public": {
        "server": "gitlab.com",
        "method": { "kind": "token", "username": "oauth2" },
        "repos": ["acme/infra/*"],
        "operations": ["read"]
    },
    "uses": ["git"],
    "owner": "team",
    "roles": { "member": { "level": "use" }, "viewer": { "hidden": true } },
    "material": { "token": "glpat-…" },
    "mutationId": "optional-client-value"
}
```

`type`, `name`, `uses`, and `material` are required; `public` is required for every type except
`environment`. `description` defaults to `""`. `owner` is `"me"` or `"team"` and defaults to
`"team"`. `roles` is optional and names at most 64 existing roles; in each rule, `level` defaults
to `"none"` and `hidden` to `false`. The caller's own secret takes no `roles`. Unknown fields are
`400`.

Response — `201`: `{ "secret": { ... } }`, with the new `id`.

### `PATCH /v0/cluster/secrets/:secretId`

Changes a secret the caller manages. Requires `If-Match` with the secret's version.

Request — at least one of `name`, `description`, `public`, `uses`, `roles`, and `material`:

```json
{
    "name": "Stripe API (live)",
    "public": {
        "targets": [{ "host": "api.stripe.com" }],
        "algorithm": {
            "kind": "headers",
            "headers": [{ "name": "Authorization", "prefix": "Bearer " }]
        }
    },
    "material": { "Authorization": "sk_live_…" },
    "mutationId": "optional-client-value"
}
```

Omitted fields stay unchanged. `public` replaces the whole metadata and must come with `material`,
so a value is entered again wherever it goes. `material` alone replaces the value and keeps
`public`, deriving its derived fields again. `uses` must suit the resulting `public`. `roles`
replaces every rule. Unknown fields, including `type`, are `400`.

Response — `200`: `{ "secret": { ... } }`.

### `DELETE /v0/cluster/secrets/:secretId`

Deletes a secret with its rules and grants. The optional JSON body is `{ "mutationId": "..." }`; an
empty body is equivalent to `{}`.

A manager of the secret sends `If-Match` with its version. A caller holding `secrets.manage` may
also delete another member's own secret, which it cannot see, without `If-Match`.

Response — `200`:

```json
{ "secretId": "c1k2s3e4c5r6e7t8i9d0a1b2", "deleted": true }
```

### Grants

A grant gives one secret to one `agent` or `workspace`. Each grant is identified by its secret,
target type, and target ID:

```json
{
    "secretId": "c1k2s3e4c5r6e7t8i9d0a1b2",
    "target": { "type": "workspace", "id": "w9x8y7z6" },
    "grantedBy": "u1s2e3r4",
    "createdAt": 1755400000000
}
```

Granting needs `access.attach`. Revoking needs `access.use` or `access.manage`. A target the caller
cannot see answers `404`, the same as one that does not exist. Any other target type is `400`.
Grants need no `If-Match`, and both mutations are idempotent. Their optional JSON body is
`{ "mutationId": "..." }`; an empty body is equivalent to `{}`.

#### `GET /v0/cluster/secrets/:secretId/grants`

Lists the secret's grants to targets the caller may see, without paging.

Response — `200`: `{ "grants": [ /* grant objects */ ] }`.

#### `PUT /v0/cluster/secrets/:secretId/grants/:targetType/:targetId`

Response — `201` for a new grant or `200` when it already existed:

```json
{
    "grant": {
        /* grant object */
    },
    "created": true,
    "version": "01991f3a-6d2f-7000-8000-3a0b2c4d5e6f"
}
```

`version` is the secret's version after the request. Granting to an archived target is `409`.

#### `DELETE /v0/cluster/secrets/:secretId/grants/:targetType/:targetId`

Response — `200`:

```json
{
    "revoked": true,
    "grant": {
        /* the grant that was removed */
    },
    "version": "01991f3a-6d2f-7000-8000-3a0b2c4d5e6f"
}
```

A request that finds no grant returns `revoked: false` and `grant: null`.

### Cluster secret events

The cluster publishes these events on its event stream after the change commits. Each payload
carries the request's `mutationId` when one was sent. No event carries a name, `public`, or
`material`, so clients read the secret or the list again for metadata. The daemon's `secret.*`
events are unrelated and unchanged.

A change to a team secret publishes only `cluster_secrets.changed`, with the payload
`{ "mutationId"?: "..." }`. It names no secret, so a secret hidden from a role, or the catalog
hidden from a member without `secrets.view`, is never revealed by an event. Clients read
`GET /v0/cluster/secrets` again.

A change to a member's own secret publishes one of these events to that member only, including
when a manager deletes it:

- `cluster_secret.created` — `{ "secretId", "version" }`.
- `cluster_secret.updated` — `{ "secretId", "previousVersion", "version" }`.
- `cluster_secret.attached`, `cluster_secret.detached` — `{ "secretId", "previousVersion",
"version", "target": { "type", "id" } }`. A grant or revoke that changes nothing publishes
  nothing.
- `cluster_secret.removed` — `{ "secretId", "previousVersion" }`.

## Projects and workspaces

A project is where work lives: a folder on this machine, registered with the daemon, or a
repository the daemon cloned into its managed storage. **Every project is itself a workspace** —
the root workspace of its tree. Workspaces can have a parent workspace and nest to any depth;
the project is simply the workspace at the top, and it carries the project-level facts (name,
avatar, ordering, archival) alongside its role as a place where agents run. The workspace
endpoints are specified in the next chapter; this one covers the project surface.

### The project object

Every project route answers with the same shape:

```json
{
    "id": "k2h4j5l6",
    "name": "rig",
    "nameSource": "folder",
    "compute": { "type": "host", "path": "/Users/steve/Developer/rig" },
    "status": "active",
    "initialization": { "status": "ready", "attempt": 1, "error": null },
    "git": {
        "branch": "main",
        "head": "4f2a1c9",
        "upstream": "origin/main",
        "ahead": 0,
        "behind": 2,
        "detached": false
    },
    "defaultBranch": "main",
    "worktreeSupport": "supported",
    "remoteSource": { "kind": "github", "repository": "slopus/rig" },
    "avatar": { "kind": "image", "thumbhash": "3OcRJYB4d3h3iIeHeEh3eIhw+j2w", "source": "user" },
    "description": null,
    "workspaceSetupCommands": ["pnpm install --frozen-lockfile"],
    "settings": {
        "defaultWorkspaceCompute": { "type": "host" },
        "workspaceInitialPrompt": null
    },
    "agents": [
        /* active user-visible root agents owned by this project, in order */
    ],
    "orderKey": "00000000000000000001",
    "version": "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e",
    "createdAt": 1755300000000,
    "updatedAt": 1755400000000,
    "archivedAt": null
}
```

Fields:

- `id` — stable project identifier. Because the project is the root workspace, this is also a
  workspace ID.
- `name`, `nameSource` — display name and where it came from: `"folder"` (derived from the
  path) or `"user"` (explicitly renamed). A user-chosen name is never overwritten by derivation.
- `compute` — where the project's files live and where work on them executes. A `"host"`
  compute is a folder on this machine and carries its `path`. A `"runner"` compute,
  `{ "type": "runner", "runnerId": "build-box", "path": "/srv/projects/rig" }`, is a folder on that
  runner, with `path` in the runner's own filesystem; the home project's `path` is `null` until its
  runner has first connected. Non-local computes (such as a Docker container) carry their own
  addressing instead of a host path; Git state is deliberately not part of compute — it describes
  the repository, not where it runs — so `git` stays a separate field.
- `status` — `"active"` or `"archived"`.
- `initialization` — the setup state: `status` is `"initializing"`, `"ready"`, or `"failed"`;
  `attempt` counts setup runs; `error` is a human-readable message when setup failed.
- `git` — a summary of the working tree: current branch (or `detached: true` with `head`),
  upstream, and ahead/behind counts. `null` when the folder is not a Git repository.
- `defaultBranch` — the repository's default branch, when known.
- `worktreeSupport` — `"supported"`, `"unsupported"`, or `"unknown"`; whether child workspaces
  can be created as Git worktrees. `worktreeUnsupportedReason` accompanies `"unsupported"`.
- `remoteSource` — where a cloned project came from: `{ "kind": "github", "repository":
"owner/name" }` or `{ "kind": "git", "url": "https://..." }`; `null` for a registered local
  folder.
- `avatar` — the project picture, or `null`. An `"image"` avatar carries a `thumbhash` — a
  ThumbHash placeholder the client renders before fetching the image bytes from
  `GET /v0/projects/:projectId/avatar` — and a `source` of `"user"` or `"generated"`. The
  built-in home project, which represents the user's machine outside any repository, carries
  `{ "kind": "home" }` instead: the client shows its home iconography, and there are no image
  bytes to fetch.
- `workspaceSetupCommands` — the ordered shell commands a new workspace of this project runs
  once its checkout exists, as the daemon last read them from the project's `happy.toml`
  (`[workspace] setup_commands`, over the machine-wide default). Read-only: the file is the
  source of truth, and the daemon re-reads it when it changes, publishing the new list through
  `project.updated`. Empty until the file has been read once or when it names no command.
- `settings` — per-project settings. `defaultWorkspaceCompute` chooses where new workspaces
  run (`{ "type": "host" }` or `{ "type": "docker", "image": "..." }`). A project on a runner
  reports `{ "type": "runner", "runnerId": "..." }` or `{ "type": "docker", "image": "...",
"runnerId": "..." }` here, and its workspaces are created on the same runner. Its settings accept
  either of those shapes, with `runnerId` optional on `"docker"` and equal to the project's runner
  when present; any other `defaultWorkspaceCompute` is `400 invalid_request`. `workspaceInitialPrompt` is the text a client sends as the first user
  message to the first agent in every new workspace of the project, or `null` when the project
  says nothing; the daemon stores it and does not send it itself.
- `agents` — active user-visible root agents owned by the project, in `orderKey` order. Because
  the project is also its root workspace, `GET /v0/workspaces/:projectId` exposes this same
  series. Archived agents and ordinary hidden subagents are excluded. A user-visible root managed
  by an agent in another workspace is included.
- `orderKey` — an opaque sort key; clients order projects by comparing these strings.
- `version` — the UUIDv7 concurrency version; see “Resource versions and `If-Match`” in the
  basics.
- `createdAt`, `updatedAt`, `archivedAt` — lifecycle timestamps; `archivedAt` is `null` while
  active.

### `GET /v0/projects`

Lists every project, archived ones included, in catalog order.

Response — `200`: `{ "projects": [ /* project objects */ ] }`

### `POST /v0/projects`

Registers an existing local folder as a project.

Request:

```json
{ "path": "/Users/steve/Developer/rig", "projectId": "k2h4j5l6" }
```

- `path` — the folder to register. Must exist and be a directory.
- `runnerId` — optional; the runner whose filesystem `path` belongs to, which then validates it.
  Without it, the default runner is used while runners are configured, and this machine otherwise.
  An unknown runner is `400 invalid_request`.
- `projectId` — optional client-supplied ID, for callers that need to know the ID before the
  daemon answers. Omitted, the daemon mints one.

Response — `200`: `{ "project": { ... } }`. Registering a path that is already a project returns
that existing project with `200` instead of creating a duplicate; an archived one is revived
first. The existing project keeps its ID, so a supplied `projectId` takes effect only for a new
folder, and a `projectId` that already names a different folder is `400 invalid_request`. Setup
(Git inspection, name derivation) runs in the background — the project may answer with
`initialization.status` `"initializing"` and settle via events.

### `POST /v0/projects/clone`

Creates a project by cloning a remote repository into the daemon's managed storage.

Request:

```json
{
    "name": "rig",
    "source": { "kind": "github", "repository": "slopus/rig" },
    "projectId": "k2h4j5l6"
}
```

- `name` — the folder name for the clone.
- `source` — `{ "kind": "github", "repository": "owner/name" }` or `{ "kind": "git", "url":
"https://..." }`. Only plain HTTPS remotes without embedded credentials are accepted.
- `runnerId` — optional; the runner to clone onto, chosen as in registration.
- `projectId` — optional client-supplied ID, as in registration.

Clones use ordinary Git authentication configured on the machine that runs Git. The former
`secret` selector is no longer accepted; requests containing it return `400 invalid_request`.

Response — `202`: `{ "project": { ... } }`. The clone runs in the background: the project row
exists immediately with `initialization.status` `"initializing"`, and settles through events
when the clone lands or fails.

### `GET /v0/projects/:projectId`

Returns one project.

Response — `200`: `{ "project": { ... } }`; `404` when no such project exists.

### `PATCH /v0/projects/:projectId`

Renames the project. Requires `If-Match`.

Request: `{ "name": "Rig", "mutationId": "..." }`

Response — `200`: `{ "project": { ... } }` with `nameSource` now `"user"`.

### `PUT /v0/projects/:projectId/settings`

Replaces the project settings. Requires `If-Match`.

Request:

```json
{
    "defaultWorkspaceCompute": { "type": "docker", "image": "ghcr.io/acme/dev:latest" },
    "workspaceInitialPrompt": "Run the test suite and report what fails before touching anything.",
    "mutationId": "..."
}
```

`workspaceInitialPrompt` is optional. Because the body replaces the settings, omitting it, sending
`null`, or sending blank text all leave the project with no initial prompt. A prompt is at most
32,000 characters.

Response — `200`: `{ "project": { ... }, "settings": { ... } }` — the row and the settings as
persisted.

### `POST /v0/projects/:projectId/refresh`

Re-runs project setup: Git inspection, name derivation, and the rest of initialization. Use it
when the folder changed underneath the daemon.

Response — `202`: `{ "project": { ... } }` with `initialization.status` back to
`"initializing"`; completion arrives through events.

### `POST /v0/projects/:projectId/reorder`

Moves the project in the catalog order. Requires `If-Match`.

Request: `{ "afterId": "b3c4d5e6", "mutationId": "..." }` — the project to place this one
after, or `null` to move it first.

Response — `200`: `{ "project": { ... } }`. Reordering assigns the moved project a fractional
`orderKey` between its destination neighbours. Neighbour keys and versions remain unchanged; only
the moved project emits its reorder update.

### `POST /v0/projects/:projectId/archive`

Archives the project. Requires `If-Match`; the body is `{}`. Archiving is idempotent — an
already archived project answers the same way.

Response — `202`: `{ "project": { ... } }` with `status` `"archived"`. The decision is durable
when the response is sent; removing the project's workspace folders and closing its terminals
is background work.

Archiving a project archives every workspace cut from it, in the same transaction, so the work
standing in each of them stops exactly as it does for a workspace archived on its own, and each
workspace's resident subtask is archived with it. Agents
attached to the project itself rather than to one of its workspaces are cancelled the same way,
and no new agent can be attached to an archived project; an attachment in flight is refused with
`409`. Archiving a project that is already archived changes nothing and stops nothing.

### `GET /v0/projects/:projectId/avatar`

Serves the project picture's image bytes. The response carries an `ETag` derived from the image
content and supports conditional requests, so a client that already holds the picture gets
`304`. Successful and conditional responses use the shared image-caching policy. A project without
a picture is `404`, including when `If-None-Match` names a removed picture. The `thumbhash` in the
project object is the placeholder when no cached image is available.

### `PUT /v0/projects/:projectId/avatar`

Sets the project picture. Requires `If-Match`. The body is the raw image bytes; the limit is
8 MB, and a larger upload is rejected with `413`.

Response — `200`: `{ "project": { ... } }` with the new `avatar`, including the freshly
computed `thumbhash`.

### `DELETE /v0/projects/:projectId/avatar`

Removes the project picture. Requires `If-Match`.

Response — `200`: `{ "project": { ... } }` with `avatar` `null`.

## Workspaces

A workspace is a place where agents run: a checkout with its own folder, its own branch, and
its own position in a tree. Workspaces are a top-level resource — they are addressed as
`/v0/workspaces/:workspaceId`, never through their project's path.

The tree works like this:

- **Every project is its root workspace, under the same ID.** Registering or cloning a project
  creates the root workspace implicitly; `GET /v0/workspaces/<projectId>` answers with it. The
  root workspace's folder is the project's folder, and its name is the project's name.
- **Every other workspace has a `parentId`** — the root workspace or any workspace beneath it —
  and workspaces nest to any depth. `projectId` always names the root of the tree, whatever the
  depth.
- A workspace's lifecycle is bounded by its parent: archiving a workspace archives everything
  beneath it, and the root workspace is archived by archiving the project, not through the
  workspace surface.

Bot workspaces are the one kind of workspace outside any tree: they have no project and no
parent — `projectId` and `parentId` are both `null` — and can have no children. Their lifecycle
belongs to their bot; see the bots chapter.

Workspaces are a versioned resource and follow the `If-Match` and `mutationId` conventions
from the basics. A daemon with workspaces disabled by configuration answers `503` on every
workspace route.

### The workspace object

```json
{
    "id": "w9x8y7z6",
    "projectId": "k2h4j5l6",
    "parentId": "k2h4j5l6",
    "name": "fix-login",
    "nameSource": "user",
    "kind": "worktree",
    "compute": { "type": "host", "path": "/Users/steve/.happy/workspaces/rig/fix-login" },
    "status": "active",
    "initialization": { "status": "ready", "attempt": 1, "error": null },
    "base": { "ref": "main", "commit": "4f2a1c9" },
    "git": {
        "branch": "fix-login",
        "head": "8b3d2e1",
        "upstream": null,
        "ahead": 3,
        "behind": 0,
        "detached": false
    },
    "botId": null,
    "creatorAgentId": "a1b2c3d4",
    "subtaskAgentId": null,
    "agents": [
        /* active user-visible root agents owned by this workspace, in order */
    ],
    "orderKey": "5",
    "version": "01991f3a-5d2b-7000-8000-4b1c3d5e6f70",
    "createdAt": 1755300000000,
    "updatedAt": 1755400000000,
    "archivedAt": null
}
```

Fields:

- `id` — stable workspace identifier. The root workspace's ID is the project's ID.
- `projectId` — the root of this workspace's tree; `null` on a bot, task, or Surface chat workspace, which
  belongs to no tree.
- `parentId` — the workspace this one was created under; `null` on the root workspace and on a
  bot, task, or Surface chat workspace.
- `name`, `nameSource` — display name and where it came from: `"user"` for a chosen name,
  `"generated"` for one the daemon derived. The name is also the branch name behind the
  checkout, so renaming moves the branch.
- `kind` — how the checkout was made: `"root"` for the project's own folder, `"worktree"` for
  a Git worktree, `"copy"` for a plain folder copy (used when the project cannot support
  worktrees), `"bot"` for a bot's plain created folder, `"task"` for a task's plain created
  folder, and `"surface"` for a Surface chat's plain created folder.
- `compute` — where the workspace's files live and where work executes, same shape as on the
  project. A workspace of a runner project is always on that project's runner. A workspace created
  while its project's `defaultWorkspaceCompute` was `"docker"` reports
  `{ "type": "docker", "image": "...", "path": "...", "runnerId": "..." }`: agent work runs in a
  container of that image with `path` mounted at the same place, and `runnerId` names the runner
  holding the folder, or is absent when it is on this machine. Older daemons omit `path`.
- `status` — `"active"`, `"archiving"`, or `"archived"`. `"archiving"` is the window where the
  decision is durable but folder removal is still running.
- `initialization` — the checkout state, same shape as on the project: a workspace answers
  immediately on creation and builds in the background.
- `base` — what the workspace was created from: the `ref` the caller named and the `commit`
  it resolved to at creation time. `null` on a bot, task, or Surface chat workspace, which is created empty
  rather than cut from anything.
- `git` — the same working-tree summary as on the project, for this workspace's checkout.
- `botId` — optional additive field, always emitted by current daemons. `null` for every
  ordinary workspace; the owning bot's ID on a bot's dedicated workspace. See the bots chapter
  for how bot workspaces behave.
- `taskId` — optional additive field, present only on a task's dedicated workspace, where it
  names the owning task. See the tasks chapter for how task workspaces behave.
- `surfaceId` — optional additive field, present only on a Surface chat's dedicated workspace,
  where it names the owning Surface. See shared Surface chats for its lifecycle.
- `creatorAgentId` — the agent that created this workspace, when one did; `null` when a
  person created it directly.
- `subtaskAgentId` — optional additive field, always emitted by current daemons. The resident
  workspace-bound subtask's ID, or `null` for an ordinary, project-root, or bot workspace. The
  resident agent's `parentAgentId` identifies its coordinator. The association survives archival;
  a shared-filesystem subtask does not change it.
- `agents` — active user-visible root agents owned by this workspace, in `orderKey` order. The
  root workspace exposes the project-owned root-agent series; every child workspace has its own
  independent series. Archived agents and ordinary hidden subagents are excluded. A user-visible
  root managed by an agent in another workspace is included.
- `orderKey`, `version`, timestamps — as on the project. `orderKey` orders a workspace among
  its siblings under the same parent.

### `GET /v0/workspaces`

Lists workspaces as a flat array; clients build the tree from `parentId`.

Query parameters:

- `projectId` — optional; only this project's tree.
- `includeArchived` — optional, default `false`; archived and archiving workspaces are history
  and only appear when asked for.

Response — `200`: `{ "workspaces": [ /* workspace objects */ ] }`. Root workspaces are
included: a project with no child workspaces still contributes one row. Bot workspaces are
excluded from this listing regardless of parameters; they are discovered through their bot and
remain addressable by ID.

### `POST /v0/workspaces`

Creates a workspace under a parent.

Request:

```json
{
    "parentId": "k2h4j5l6",
    "name": "fix-login",
    "baseRef": "main",
    "id": "w9x8y7z6",
    "agentId": "a1b2c3d4"
}
```

- `parentId` — the workspace to nest under: a project's root workspace or any workspace in a
  tree. Required.
- `name` — the workspace name, which is also its branch name.
- `baseRef` — optional; the ref to branch from. Defaults to the parent workspace's current
  branch.
- `id` — optional client-supplied ID, as with project creation.
- `agentId` — optional; records the creating agent as `creatorAgentId`.

Response — `202`: `{ "workspace": { ... } }`. The reservation is durable and immediate — the
row already carries the branch and folder the checkout will use — and the checkout itself runs
in the background, settling through events. Creating under an archived or nonexistent parent is
`404`. Creating under a bot workspace is `409` — bot workspaces have no children.

### `GET /v0/workspaces/:workspaceId`

Returns one workspace. Works for root workspaces too: passing a project ID answers with that
project's root workspace.

Response — `200`: `{ "workspace": { ... } }`; `404` when no such workspace exists.

### `PATCH /v0/workspaces/:workspaceId`

Renames the workspace. Requires `If-Match`. Because the name is the branch name, the daemon
records the new name immediately and moves the Git branch in the background.

Request: `{ "name": "fix-login-v2", "mutationId": "..." }`

Response — `200`: `{ "workspace": { ... } }`. The root workspace is renamed through its
project (`PATCH /v0/projects/:projectId`), not here; renaming it through this route is `409`.
A bot workspace's name is fixed by its bot's immutable username, so renaming it here is also
`409`.

### `POST /v0/workspaces/:workspaceId/archive`

Archives the workspace and everything beneath it. Requires `If-Match`; the body is `{}`.
Idempotent — an already archived workspace answers the same way.

Response — `202`: `{ "workspace": { ... } }` with `status` `"archiving"` or `"archived"`. The
decision is durable when the response is sent; removing checkouts and closing terminals
standing in them is background work. Whether the folder itself is kept follows the workspace
configuration: worktrees are removed by default, plain copies are kept. The root workspace
cannot be archived here — archive the project instead; trying is `409`. A bot workspace is
archived only through its bot; trying here is also `409`.

Archiving also stops the work standing in the workspace. Every agent in it is cancelled, together
with the subagents and background processes below it. The cancellation is prepared inside the
transaction that records the archival, so an archival that answers has always taken responsibility
for the work in it: if the preparation fails, the archival fails with it and the workspace stays
active. The signal itself is released once that decision is durable — a run learns it was cancelled
after the commit, its background processes are killed, and an open question it was waiting on is
canceled as that turn settles. No new agent can be attached to a workspace once its archival has
committed; an attachment that was in flight is refused with `409`. Archiving a workspace that is
already archived changes nothing and stops nothing.

A workspace whose `subtaskAgentId` names a resident subtask archives that subtask in the same
transaction, as `POST /v0/agents/:agentId/archive` would; this applies to each archived
descendant too. The subtask emits `agent.updated` with `archivedAt` set alongside the workspace's
`workspace.updated`. An already archived subtask is left as it is.

### `POST /v0/workspaces/:workspaceId/reorder`

Moves the workspace among its siblings — the workspaces sharing its `parentId`. Requires
`If-Match`.

Request: `{ "afterId": "w2b3c4d5", "mutationId": "..." }` — the sibling to place this one
after, or `null` to move it first.

Response — `200`: `{ "workspace": { ... } }`. Reordering assigns the moved workspace a fractional
`orderKey` between its destination siblings. Sibling keys and versions remain unchanged; only the
moved workspace emits its reorder update.

### Terminals

A workspace holds interactive terminals. They belong to the workspace, not to any agent:
everybody looking at the same folder sees the same terminals. Because a project is its root
workspace, terminals opened "in the project" are simply terminals of the root workspace.

Lifecycle is ordinary JSON — open, list, resize, stop. None of these calls carries screen
contents: the picture and everything typed into it travel over the attachment, which is a
stream, not a response body. A workspace holds at most 32 terminals.

The terminal object:

```json
{
    "id": "t5f6g7h8",
    "workspaceId": "k2h4j5l6",
    "status": "running",
    "exitCode": null,
    "cols": 80,
    "rows": 24,
    "colorScheme": "dark",
    "epoch": "01J5X0ABCDEF",
    "version": "01991f3a-5e3c-7000-8000-5c2d4e6f7081"
}
```

- `status` — `"running"` or `"exited"`; `exitCode` is set once exited.
- `colorScheme` — `"dark"` or `"light"`, settled at creation and never changed; it seeds the
  emulator every attachment replicates. Switching theme means opening a new terminal.
- `epoch` — changes whenever a new process backs the terminal, so scroll offsets taken against
  an older process are never replayed into a new one.

#### `GET /v0/workspaces/:workspaceId/terminals`

Lists the workspace's terminals. Response — `200`: `{ "terminals": [ ... ] }`

#### `POST /v0/workspaces/:workspaceId/terminals`

Opens a terminal in the workspace's folder.

Request (all fields optional):

```json
{
    "shell": "/bin/zsh",
    "command": "pnpm dev",
    "cwd": "packages/web",
    "cols": 120,
    "rows": 32,
    "maxScrollback": 10000,
    "colorScheme": "dark"
}
```

- `command` — what to run instead of an interactive shell; the shell still hosts it.
- `cwd` — where to start, absolute or relative to the workspace folder; defaults to the folder.

Response — `201`: `{ "terminal": { ... } }`. Opening a terminal past the per-workspace limit
is `409`.

#### `PATCH /v0/workspaces/:workspaceId/terminals/:terminalId`

Resizes the terminal. Request: `{ "cols": 120, "rows": 32 }`.
Response — `200`: `{ "terminal": { ... } }`

#### `DELETE /v0/workspaces/:workspaceId/terminals/:terminalId`

Stops the terminal and its process. Response — `200`: `{ "terminal": { ... } }` with `status`
`"exited"`.

#### `GET /v0/workspaces/:workspaceId/terminals/:terminalId/attach`

A WebSocket upgrade, on the same socket and bearer token as everything else. The attachment
carries the terminal's binary wire protocol: screen state, scrollback, input, and resizes, as
full-duplex binary frames. Text frames are a protocol violation and close the connection. Many
clients may attach to one terminal at once; each is a replica of the same canonical emulator.
An unknown terminal refuses the upgrade with `404`.

### `CONNECT /v0/workspaces/:workspaceId/proxy`

An HTTP tunnel into the workspace's network context. The daemon answers the `CONNECT` with
`200` and the connection becomes a raw byte stream; inside it the client speaks HTTP/1.1 to
whatever the workspace can reach:

- Plain requests (`GET http://localhost:3000/ ...`) reach services as the workspace sees them —
  a dev server bound to loopback inside a Docker compute, for example.
- A nested `CONNECT host:port` opens a raw TCP tunnel to that authority from inside the
  workspace.

This is what makes non-local compute transparent: a client previews a dev server the same way
whether the workspace runs on the host or in a container. For a host workspace the tunnel
simply reaches the machine's own network.

This route reaches the network of the machine the folder is on: this computer or the folder's
runner. A workspace whose agents work in containers, because its `compute` is `"docker"` or its
bot runs its agents in Docker, has no single network of its own; this route refuses its
`CONNECT` with `501 unsupported` instead of reaching another machine. Use the agent's proxy below.

Inside either proxy tunnel, the daemon behaves as a plain forwarding proxy:

- Requests and responses stream in both directions, with backpressure, for as long as both sides
  keep them open: server-sent events, long polls, and slow uploads and downloads are never cut
  off by a total time limit. Only establishing a connection is bounded, at 30 seconds, answered
  `504` when it passes.
- Headers reach the destination as the client sent them, including its own `Authorization` and
  `Cookie`. `Proxy-Authorization` and `Proxy-Connection` are removed, connection-management
  headers belong to each hop, and the daemon adds no header that names it, such as `Via` or
  `Forwarded`.
- After a nested `CONNECT` is answered `200`, the stream carries only the bytes of each side.
  Either side's end of stream half-closes the other direction, and a closed or reset connection
  closes the other side.
- Closing the outer tunnel, or abandoning a request on it, closes every connection opened for it.
- A destination that cannot be reached is answered `502`. The daemon never retries a connection
  from another network.

### `CONNECT /v0/workspaces/:workspaceId/agents/:agentId/proxy`

The same tunnel, opened in one agent's own network: the machine that agent's commands and file
tools run on. For an agent working in a container, `localhost` is that container's loopback, so a
dev server the agent started there is reachable exactly as the agent reaches it. For an agent on a
runner it is the runner, and for an agent on this computer it is this computer.

Every connection on the tunnel is opened from that agent's machine and nowhere else. The daemon
never falls back to its own network, to the folder's machine, or to another agent's container. A
connection that agent's machine cannot open is answered `502`.

The `CONNECT` is refused, before the tunnel opens, with:

- `404 not_found` — the workspace or agent is unknown, or the agent's `workspaceId` is not this
  workspace.
- `409 conflict` — the agent is archived, or the workspace is not available.
- `409 not_initialized` — the workspace is still initializing.
- `501 unsupported` — the agent's machine cannot open network connections.
- `503 runner_unavailable` or `409 local_execution_disabled` — the agent's machine cannot be
  started, as for its commands.
- `503 draining` — as for every new proxy attachment.

Opening the tunnel starts the agent's machine if it is not running yet, as the agent's first
command would, but never starts an agent turn. The tunnel does not end when an agent turn ends.
Archiving the agent closes every connection opened through its tunnels and answers later requests
on them with `502`. A tunnel ends when the client closes it or the daemon stops.

The route is additive and does not increment the protocol version. An older daemon closes such a
`CONNECT` without a response. A client that needs an agent's network then offers no preview, and
does not fall back to the workspace proxy.

### `GET /v0/workspaces/:workspaceId/agents/:agentId/proxy`

Names the network that agent's connections leave from, so a client can keep one browser profile,
with its cookies and storage, per network rather than per agent or workspace.

Response — `200`: `{ "networkId": "..." }`.

- `networkId` — an opaque identifier of 1 to 128 characters: lowercase letters and digits, plus
  `-` and `_` after the first character. Clients compare it for equality and never parse it.

Two agents have the same `networkId` exactly when their connections leave from the same network:

- Every agent working on this computer shares one, including agents whose work runs as another
  Linux user here. It stays the same across daemon restarts.
- Every agent on one runner shares that runner's. It stays the same while the runner reconnects
  and across daemon restarts.
- An agent working in a container has one of its own. It stays the same while the agent's
  container environment — its image and the machine holding its folder — stays the same,
  including across daemon restarts. When that environment changes, the agent gets a new
  `networkId` and the old one is no longer served.

A `networkId` names a logical compute environment, not an address or a particular machine
instance. It promises nothing about the public address connections arrive from: agents sharing one
may reach the internet from different addresses, and different ones may share an address. A
container recreated in the same environment, such as after its machine restarts, keeps its
`networkId`.

The network is the one the agent's machine actually runs with. A setting changed after the machine
started, such as its bot choosing another compute, takes effect only once the machine starts again.

The read is refused exactly as the agent's `CONNECT` above is. Reading it resolves the agent's
machine, as opening the agent's tunnel does, but never starts an agent turn. It does not promise
that a container is already running when it answers. The `networkId` is not part of the agent object, listings, or events.

### `CONNECT /v0/networks/:networkId/proxy`

The same tunnel, opened in the network a `networkId` names. Every connection on it leaves from that
network and nowhere else, and the tunnel behaves exactly like the workspace proxy above. It needs
the same authentication as every other route; there is no separate grant.

The `CONNECT` is refused, before the tunnel opens, with:

- `404 not_found` — the daemon does not serve this `networkId` right now: it is malformed or
  unknown, it names a runner that is no longer configured, it names this computer while work here
  is disabled, or it names an agent's container whose agent is archived, whose environment
  changed, or whose machine has not been resolved since the daemon started.
- `501 unsupported` — the network's machine cannot open network connections.
- `503 runner_unavailable` — the network is a runner's and that runner is away.
- `503 draining` — as for every new proxy attachment.

A client that receives `404` reads the agent's network again, which resolves its machine, and
opens the `networkId` it returns. When that is the same `networkId`, the client reopens it with the
same browser state. A different `networkId` is a different network: the client gives it a new
profile of its own and never moves the old profile, its cookies, or its storage to it. Archiving an agent that works in a container
closes every connection opened through its network's tunnels and answers later requests on them
with `502`. The daemon never opens such a tunnel in another network.

### `CONNECT /v0/artifacts/:artifactId/proxy`

A destination-restricted HTTP tunnel into a live artifact's recorded `live.networkId`. It uses
the same authentication, streaming, connection timeout, and network-failure behavior as the
network proxy above. The outer `CONNECT` is refused with `404 not_found` when the artifact is
missing, deleted, or not live; otherwise it has the same refusals as the network proxy.

The daemon owns one destination-policy boundary for every nested `CONNECT` and proxied HTTP
request on this tunnel. The client supplies only the artifact ID, never a network or an
allowlist. Before opening each destination connection, the daemon reads the artifact's current
`live.url`, resolves non-literal requested hosts on the daemon's host, and connects the recorded
network's machine to a checked IP literal:

- The destination is allowed when every resolved address is public.
- The only exception is for a recorded URL whose host is itself loopback, determined from the
  URL alone: `localhost` or a literal loopback IP in `127.0.0.0/8` or `::1`, including mapped
  forms. The requested hostname must equal the recorded hostname, case-insensitively as written,
  and the port must equal the URL's effective port (`80` for HTTP or `443` for HTTPS when omitted).
  Every resolved address must then be loopback. Equality is of hostnames, not resolved addresses;
  a different spelling or hostname resolving to the same address gets no exception.
  This exception needs no DNS: recorded `localhost` connects to `127.0.0.1` on the network's
  machine, then to `::1` only if the first connection is refused; a recorded literal loopback IP
  connects to exactly that literal.
- Everything else is refused before connecting. Private LAN addresses, including `10.0.0.0/8`,
  `172.16.0.0/12`, `192.168.0.0/16`, and `fc00::/7`, are never allowed, even as the recorded URL.
  Link-local addresses (`169.254.0.0/16` and `fe80::/10`) are never allowed either.

Public means a publicly routable unicast address; loopback, private, link-local, unspecified,
multicast, and reserved addresses are not public. IPv4-mapped and IPv4-translated IPv6 addresses
are classified as their embedded IPv4 address. `0.0.0.0` and `::` are non-public and are not
loopback exceptions. Numeric hostname spellings such as `2130706433` are classified as the IP
addresses they represent, not treated as public DNS names. An empty or failed resolution never
permits a connection. The daemon connects to exactly an address it checked, without a second
lookup. A policy refusal answers the nested request with `403`; resolution and connection
failures follow the network proxy's existing failure behavior.

Names resolvable only inside the recorded network are not supported. The daemon never asks that
network to resolve a hostname or falls back to its DNS.

A public recorded hostname gets no loopback exception: rebinding `attacker.com` to loopback
cannot authorize it, even when `attacker.com` is the recorded URL's host. Mixed public/non-public
DNS answers are refused.

There is no version selector. The current URL supplies the policy for every new destination
connection, even when a client is displaying a pinned artifact version. A URL update applies to
the next connection; a deleted or non-live artifact refuses further connections. Already-open
destination connections are not torn down by those changes.

Clients must use this route for live-URL artifacts and must not use the unrestricted network,
workspace, or agent proxy routes for them. If this additive route is unavailable on an older
daemon, the client shows the live page as unavailable rather than falling back. The existing
network and workspace proxy routes, including agent browser tabs using them, are unchanged.

### WebSocket tunnels

Every proxy tunnel above also has a WebSocket twin, for networks and load balancers that do not
carry `CONNECT`. The twin's path is the tunnel's path followed by `/websocket`:

| `CONNECT` tunnel                                            | WebSocket twin                                                    |
| ----------------------------------------------------------- | ----------------------------------------------------------------- |
| `CONNECT /v0/workspaces/:workspaceId/proxy`                 | `GET /v0/workspaces/:workspaceId/proxy/websocket`                 |
| `CONNECT /v0/workspaces/:workspaceId/agents/:agentId/proxy` | `GET /v0/workspaces/:workspaceId/agents/:agentId/proxy/websocket` |
| `CONNECT /v0/networks/:networkId/proxy`                     | `GET /v0/networks/:networkId/proxy/websocket`                     |
| `CONNECT /v0/artifacts/:artifactId/proxy`                   | `GET /v0/artifacts/:artifactId/proxy/websocket`                   |

Each twin is a WebSocket upgrade with the same bearer token as every other route, and no other
header or subprotocol. It is admitted exactly as its `CONNECT` twin is: the same authentication,
the same refusals with the same statuses and Happy error bodies, answered before the upgrade, and
the same network. A request to a twin path that is not a WebSocket upgrade is `404 not_found`.

One WebSocket is one tunnel. After the upgrade, binary messages carry exactly the bytes that flow
on the `CONNECT` tunnel after its `200`, in both directions: the client speaks HTTP/1.1 to the
daemon's forwarding proxy, sending absolute-form requests or a nested `CONNECT host:port`, and
everything said there about streaming, headers, destinations, failures, policy, archival, and the
artifact destination boundary applies unchanged. Message boundaries carry no meaning; either side
may split or join bytes freely.

- Every message is binary. A text message closes the WebSocket with `1003`.
- A message is at most 1 MiB. A larger one closes the WebSocket with `1009`.
- An empty binary message ends that direction's stream, as a TCP half-close does; the other
  direction stays open. Once both directions have ended, the daemon closes the WebSocket with
  `1000`. Either side may instead simply close it, which ends everything opened on the tunnel.
- The daemon closes with `1001` when it shuts down and `1011` on an internal failure.
- The daemon pings as described under Keepalive. A tunnel is not resumable; after a disconnect
  the client opens a new one.

A client uses the twins on an HTTPS endpoint whenever health reports
`capabilities.webSocketTunnels: true`, and may keep using `CONNECT` on a Unix socket or Tailcat.
Local-to-workspace forwarding through a bridge-capable client may use the workspace twin in
place of `CONNECT /v0/workspaces/:workspaceId/proxy`. The twins work unchanged through
`/v0/connections/:id/api/*`.

`HappyAgentClient.workspaceProxyWebSocketUrl(workspaceId)`,
`workspaceAgentProxyWebSocketUrl(workspaceId, agentId)`, `networkProxyWebSocketUrl(networkId)`,
and `artifactProxyWebSocketUrl(artifactId)` build their URLs.

### Local bridges

A bridge connects something on the person's own computer — a USB device, a Bluetooth adapter, or a
local TCP service — to a workspace's machine. The client that opens a bridge holds it: a bridge
lives exactly as long as the WebSocket that created it, and ends when that WebSocket closes, the
daemon stops, or the workspace is archived. Nothing about a bridge is durable or replayed after a
restart. The daemon never opens a bridge on its own initiative, for an agent, or for a peer.

There are two directions:

- **Local to workspace** needs no new route. The client listens on its own machine and, for each
  connection it accepts there, opens `CONNECT /v0/workspaces/:workspaceId/proxy` followed by a
  nested `CONNECT host:port`, and relays the bytes.
- **Workspace to local** uses bridges: a USB device attached to the kernel of the workspace's
  machine (`kind: "usb"`), or a loopback listener on that machine whose connections are relayed to
  the client (`kind: "port"`).

Bluetooth uses the USB path. A USB Bluetooth adapter attached through a USB bridge becomes an
ordinary Bluetooth controller on the workspace's machine, usable with BlueZ.

Bridges act on the machine, not inside the agent sandbox. An attached USB device belongs to the
whole kernel of the workspace's machine: any process there allowed to open its device node can use
it, and device-node permissions follow that machine's own udev rules. A port bridge is ordinary
loopback TCP on that machine. Terminals, Full access commands, and reviewed escalations in Auto can
reach it; restricted sandboxed commands have no direct network access and cannot.

In team mode a bridge is private to the user who opened it. Listing, events, closing, and accepting
connections are limited to that user.

#### `GET /v0/workspaces/:workspaceId/bridges`

Reports what this workspace can bridge, and its open bridges. Response — `200`:

```json
{
    "capabilities": {
        "usb": { "available": true, "reason": null },
        "bluetooth": { "available": true, "transport": "usb", "reason": null },
        "localToWorkspace": { "available": true, "reason": null },
        "workspaceToLocal": { "available": true, "reason": null }
    },
    "bridges": [
        /* open bridge objects, oldest first */
    ],
    "cursor": "01991f3a-6d2f-7000-8000-3a0b2c4d5e6f"
}
```

Each capability is either available with `reason: null`, or unavailable with
`reason: { "code": "...", "message": "Human-readable explanation." }`. Clients branch on the code,
show the message, and treat an unknown code as unavailable. `transport` names how Bluetooth is
carried; `"usb"` is the only value today. Codes:

- `unsupported_platform` — USB and Bluetooth need the workspace's machine to run Linux.
- `vhci_not_loaded` — the kernel has USB/IP support, but the `vhci-hcd` module is not loaded.
- `vhci_missing` — the kernel has no USB/IP virtual host controller.
- `permission_denied` — the daemon's user cannot write the virtual host controller's attach control,
  `/sys/devices/platform/vhci_hcd.0/attach`. Run the daemon as root, or grant its user write access
  with a udev rule.
- `bluetooth_driver_missing` — USB is available, but the kernel has no USB Bluetooth driver
  (`btusb`).
- `container_compute` — the workspace runs in a Docker container, which has neither the host's
  devices nor its loopback network.
- `runner_compute` — the workspace is on a runner. Reported on `usb` and `bluetooth` only, and
  permanent: runners do not support USB or Bluetooth, so clients hide those options for a
  workspace that reports this code rather than offering them disabled.

`localToWorkspace` is unavailable only with `container_compute`, and `workspaceToLocal` likewise:
a port bridge on a runner workspace listens on the runner. `cursor` is captured before the
read; follow events from it. The daemon repeats its machine probe about once a minute and
publishes `bridges.capabilities.updated` when the answer changes; clients then reread the
capabilities they show. Bot and task workspaces are addressable here. An unknown workspace is
`404`, and an initializing or archived workspace answers as on the other workspace routes.

#### The bridge object

```json
{
    "id": "b7k2m9q4",
    "workspaceId": "w9x8y7z6",
    "kind": "usb",
    "name": "Arduino Uno",
    "status": "open",
    "usb": {
        "busId": "1-2",
        "vendorId": "2341",
        "productId": "0043",
        "deviceClass": 2,
        "deviceSubclass": 0,
        "deviceProtocol": 0,
        "speed": "full",
        "port": 0
    },
    "port": null,
    "closeReason": null,
    "version": "01991f3a-6161-7000-8000-8f5061920314",
    "createdAt": 1755400000000,
    "updatedAt": 1755400000000,
    "closedAt": null
}
```

- `kind` — `"usb"` or `"port"`. Exactly the detail object of that kind is non-null.
- `name` — the client's display name, or a derived one such as `"USB device 2341:0043"` or
  `"Port 5432"`.
- `status` — `"open"` or `"closed"`. A bridge appears only once it is established, and is listed
  only while open.
- `usb` — the device as the client's exporter described it: the requested `busId`, lowercase
  four-digit hexadecimal `vendorId` and `productId`, the device class triple, `speed` (`"low"`,
  `"full"`, `"high"`, `"wireless"`, `"super"`, or `"super_plus"`), and the virtual host controller
  `port` it occupies on the workspace's machine.
- `port` — for a port bridge, `{ "host": "127.0.0.1", "port": 5432 }`: where programs on the
  workspace's machine connect.
- `closeReason` — `null` while open, then `{ "code": "...", "message": "..." }` with `code`
  `"client_closed"`, `"closed_by_request"`, `"workspace_archived"`, `"daemon_shutdown"`,
  `"device_detached"`, or `"failed"`.

#### `GET /v0/workspaces/:workspaceId/bridges/usb`

A WebSocket upgrade that attaches one USB device from the client's machine to the kernel of the
workspace's machine with USB/IP. Query parameters:

- `busId` — required; the device's bus ID as the client's USB/IP exporter names it, 1–31
  characters from `[0-9A-Za-z._:-]`.
- `id` — optional client-chosen CUID2 for the bridge, minted when omitted. An ID that is already
  open is `409 conflict`.
- `name` — optional display name of 1–128 printable characters.

Before the upgrade, the daemon checks the workspace, `capabilities.usb`, and its limits. Unavailable
USB is `409 bridge_unavailable`, carrying the capability's `reason`. More than 32 open USB bridges
on the daemon is `409 bridge_limit`. A draining daemon answers `503 draining`.

After the upgrade, every message is binary and carries the bytes of one USB/IP connection, split
arbitrarily across messages. The daemon is the USB/IP client; the client is the USB/IP server for
exactly one device:

1. The daemon sends `OP_REQ_IMPORT` (version `0x0111`) for `busId`.
2. The client answers with `OP_REP_IMPORT`. A non-zero status or a different bus ID closes the
   WebSocket with `4404`, no answer within 10 seconds closes it with `4408`, and a malformed
   answer closes it with `4400`.
3. The daemon attaches the device to a free virtual host controller port of the matching speed,
   creates the bridge, and relays the USB/IP data phase (`USBIP_CMD_SUBMIT`, `USBIP_RET_SUBMIT`,
   `USBIP_CMD_UNLINK`, `USBIP_RET_UNLINK`) unchanged in both directions. No free port closes the
   WebSocket with `4409`; a kernel refusal closes it with `4502`.

Closing the WebSocket detaches the device: the kernel removes it as soon as the daemon closes its
USB/IP connection. When the kernel ends the connection, for example because the port was detached
on that machine, the daemon closes the WebSocket with `1000` and the bridge closes with
`device_detached`.

#### `GET /v0/workspaces/:workspaceId/bridges/port`

A WebSocket upgrade that opens a loopback listener on the workspace's machine and relays each
connection it accepts to the client. Query parameters:

- `port` — required; 1–65535, or `0` to let the daemon choose.
- `id`, `name` — as for USB.

The listener binds `127.0.0.1` on the workspace's machine only, before the upgrade: a port in use
or not bindable there is `409 port_unavailable`. A runner too old for port bridges is
`409 bridge_unavailable`, asking for the runner to be updated, and a runner that is not connected is `503 runner_unavailable`. Other
rejections match USB; the limits are 32 open port bridges per workspace and 256 per daemon. On
Linux the listener accepts only connections from processes running as the OS user that serves the
workspace's machine — the daemon's own user, the workload user, or the runner's user — and closes
any other at once. On other platforms, every local user of that machine can connect. A runner that
comes back without the listener, for example after it restarted, ends the bridge with `failed`.

Every message on this control WebSocket is a JSON text message of at most 16 KiB. The daemon sends:

- `{ "type": "ready", "bridge": { ... } }` — once, first: the bridge is open.
- `{ "type": "connection", "connectionId": "..." }` — a program connected and is waiting.

The client accepts a waiting connection by opening
`GET /v0/workspaces/:workspaceId/bridges/:bridgeId/connections/:connectionId` and connecting it to
its own local target, or declines it with `{ "type": "reject", "connectionId": "..." }`, which
closes that connection at once. A connection not accepted within 30 seconds is closed. A bridge
holds at most 256 open connections, at most 64 of them waiting; a connection beyond either limit is
closed when it arrives. A binary message or an unknown message from the client closes the control
WebSocket with `4400`.

#### `GET /v0/workspaces/:workspaceId/bridges/:bridgeId/connections/:connectionId`

A WebSocket upgrade that carries one accepted connection as binary messages in both directions.
Only the bridge's owner may accept a waiting connection, and only once: an unknown, accepted, or
closed connection is `404`. Either side closing ends both the TCP connection and the WebSocket;
half-closed TCP connections are not represented. Closing the control WebSocket closes every
connection of its bridge.

#### `DELETE /v0/workspaces/:workspaceId/bridges/:bridgeId`

Closes an open bridge: its WebSocket closes with `1000`, a USB device detaches, and a listener stops
together with its connections. Optional body: `{ "mutationId": "..." }`. Response — `200`:
`{ "bridge": { ... } }` with `status: "closed"` and `closeReason.code: "closed_by_request"`. An
unknown or closed bridge is `404`.

#### Bridge lifetime

Archiving the workspace, or the project, bot, or task it belongs to, closes its bridges with
`workspace_archived`. A draining daemon refuses new bridges and keeps open ones. Graceful shutdown
closes every bridge with WebSocket code `1001`. After a restart no bridge exists.

Bridge WebSockets close with these codes, with a human-readable close reason:

- `1000` — the client, `DELETE`, archival, or the device or listener ended the bridge;
- `1001` — the daemon is shutting down;
- `1011` — an internal failure;
- `4400` — a protocol violation, such as a text message on a binary WebSocket;
- `4404` — the USB/IP exporter refused or misidentified the device;
- `4408` — the USB/IP import deadline passed;
- `4409` — no virtual host controller port of the needed speed is free;
- `4502` — the kernel refused the attachment.

Binary messages are at most 1 MiB. Every bridge route, including the WebSockets and their close
codes, works unchanged through `/v0/connections/:id/api/*`.

`HappyAgentClient.listWorkspaceBridges(workspaceId)` reads the snapshot and
`closeWorkspaceBridge(workspaceId, bridgeId, request)` closes one. `workspaceUsbBridgeUrl`,
`workspacePortBridgeUrl`, and `workspaceBridgeConnectionUrl` build the WebSocket URLs.

### Files

Read-mostly access to the workspace's folder, for pickers, previews, and the occasional edit.
Every path in this family is **relative to the workspace root**; absolute paths, `..`, and
symlinks escaping the root are rejected. All routes `404` when the workspace does not exist and
`409` while its checkout is still initializing. Since a project is its root workspace, project
files are read through the root workspace's ID.

#### `GET /v0/workspaces/:workspaceId/files`

Ranked fuzzy search over relative file paths in the selected workspace. Results are ordered from
best match to weakest match.

Query parameters: `query` (required, but may be empty), `limit` (optional, `1`–`50`, default `50`).
An empty query returns the first ranked workspace files, which lets a picker show suggestions for
a bare `@`.

Response — `200`: `{ "files": [ { "path": "sources/main.ts", "fileName": "main.ts" } ] }`

#### `GET /v0/workspaces/:workspaceId/file-tree`

One physical directory level, sorted by name, paginated. The listing is independent of fuzzy-file
indexing and includes ignored folders such as `node_modules`; opening a large folder reads only
that folder's immediate entries.

Query parameters: `path` (optional, default the root), `cursor`, `limit`.

Response — `200`:

```json
{
    "entries": [
        {
            "name": "sources",
            "path": "sources",
            "type": "directory",
            "size": 0,
            "modified": 1755400000000
        }
    ],
    "nextCursor": null
}
```

`type` is `"file"`, `"directory"`, `"symlink"`, or `"other"`.

#### `GET /v0/workspaces/:workspaceId/file`

Reads one file. Query parameter: `path` (required).

Response — `200`: `{ "content": "<base64>", "hash": "<sha256 hex>" }`. Content is base64
because files are bytes, not necessarily text; the hash is the write guard below. Files over
the daemon's size limit answer `413`.

Reading a file or file-tree page also places its containing directory in the daemon's bounded set
of recently viewed locations. Filesystem changes observed there emit `files.updated`, allowing a
client to refresh an open file or expanded tree branch without polling the whole workspace.

#### `PUT /v0/workspaces/:workspaceId/file`

Writes one file.

Request: `{ "path": "sources/main.ts", "content": "<base64>", "expectedHash": "<sha256 hex> | null" }`

`expectedHash` is the compare-and-swap: the sha256 the client read, or `null` to require that
the file **not** exist yet (create). A mismatch answers `409` (`hash_mismatch`) with the
file's current `hash` so the client can re-read and merge. Response — `200`: `{ "hash": "<new sha256>" }`.

#### `GET /v0/workspaces/:workspaceId/file-revision`

Reads one file as of a git revision, for diff views. Query parameters: `path` and `revision`
(a commit-ish). Response — `200`: `{ "content": "<base64>" }`; `404` when the path does not
exist at that revision.

### Git

Every workspace with a repository has a **git state**: branch and sync facts plus the working
tree's changes against a comparison base. Reading it is a snapshot; keeping it fresh is a
subscription.

The git state object:

```json
{
    "facts": {
        "branch": "main",
        "detached": false,
        "head": "9c2f1e7",
        "upstream": "origin/main",
        "ahead": 2,
        "behind": 0
    },
    "comparison": "ready",
    "base": "origin/main",
    "changedFiles": 3,
    "insertions": 120,
    "deletions": 14,
    "countsExact": true,
    "conflicted": false,
    "files": [
        {
            "path": "sources/main.ts",
            "status": "modified",
            "staged": false,
            "unstaged": true,
            "binary": false,
            "insertions": 100,
            "deletions": 10
        }
    ],
    "filesTruncated": false,
    "scannedAt": 1755400000000
}
```

- `facts` — where the repository stands: branch (absent when `detached`), `head`, the
  `upstream` it tracks, and how far `ahead`/`behind` it is.
- `comparison`, `base` — what the changes are measured against: the merge base with
  `origin/<default branch>`, else the merge base with the local default branch, else `HEAD`,
  else (no commits yet) the empty tree. `"unavailable"` only when the repository could not be
  read; then only `facts` are meaningful.
- `changedFiles`, `insertions`, `deletions`, `countsExact` — the summary numbers; `countsExact`
  is `false` when a large tree made the daemon estimate.
- `files` — per-file changes: `status` is `"added"`, `"modified"`, `"deleted"`, `"renamed"`,
  `"copied"`, `"untracked"`, `"conflicted"`, `"type_changed"`, or `"submodule"`; `staged` and
  `unstaged` say where the change sits. `filesTruncated` is `true` when the list was capped.
- `scannedAt` — when this state was computed.

#### `GET /v0/workspaces/:workspaceId/git`

The current git state, scanning if nothing fresh is cached. Response — `200`:
`{ "git": { ... } }`; `404` for a workspace without a repository.

#### `POST /v0/git/watch`

Subscribes workspaces to the daemon's one live git watcher. Watching is a subscription, not a
scan: each listed workspace is registered, the watcher keeps its own bounded set of
repositories and debounces filesystem events, and every state change it observes is a
`git.updated` event.

Request: `{ "workspaceIds": ["k2h4j5l6", "w9x8y7z6"] }`

Response — `200`: `{ "snapshots": { "k2h4j5l6": { /* git state */ } } }` — whatever the
watcher **already knows** for the requested workspaces. A repository it has not scanned yet is
simply absent, and its first `git.updated` event follows shortly. Watch registrations are held
per subscription set: a client re-`POST`s its current interest, and workspaces it stops
mentioning age out of the watcher.

## Agents

An agent is one conversation running in a workspace: its transcript and its activity. Agents
are a top-level resource at `/v0/agents/:agentId`. Every agent belongs to exactly one
workspace — possibly a project's root workspace — and works in that workspace's folder.

An agent does not hold a model, effort, or permission mode of its own. Those are chosen on
every message sent. The last submitted selection is current composer state rather than catalog
state, so it has its own `mode` endpoint and is composed into the agent bootstrap response.

Each agent has its own ordered request-profile catalog. A profile is only a choice the client can
put in the existing message `profile` field: an opaque `id`, a short human-readable `name`, and a
human-readable `description`. The catalog is empty by default and current daemons expose no
profiles. It is returned only by focused agent responses and agent bootstrap, not embedded in the
agent object copied through project, workspace, bot, activity, event, or desktop-bootstrap data.

Agent Base ancestry and user visibility are separate facts. An agent with `parentAgentId` is
managed by another agent. Ordinarily that makes it a hidden **subagent**: it has no place in a
project or workspace list, no mutable draft, no archival, and cannot be sent messages by the user.
It remains readable through `GET`, activity, and events.

The ordinary agent creation API creates only parentless, user-controlled roots. Parent-managed
delegation is created by the agent tools: ordinary hidden subagents or user-interactive subtasks.

A **subtask** is a distinct user-visible, parent-managed agent, identified by `subtask: true`.
Only an active bot's own agent, an active task's own agent, or an active subtask can create one,
through the `create_subtask` tool. An ordinary root or hidden subagent cannot create subtasks.
Every subtask chain is rooted at a bot or a task. There may be at most two subtask levels below
that root; this is a depth limit, not a sibling limit.
The ordinary `parentAgentId` links each subtask to its coordinator.

A shared-filesystem subtask runs in its parent's workspace. It appears in its parent's `subtasks`
tree, parent activity, and focused agent reads, but not in the workspace's ordered agent series;
its `orderKey` is `null`.
A workspace-bound subtask runs in a newly created ordinary project workspace, appears in that
workspace's ordered agent series, and is identified by the workspace's `subtaskAgentId`. A bot or
a task may create either form directly; a subtask may create either form within the depth limit. Several
workspace-bound siblings may target different projects. Workspace hierarchy still describes only
files and checkouts, independently of agent ancestry.

Subtasks accept user messages, drafts, read markers, and archival through the existing agent
routes. Archival is final for a subtask: `unarchive` on any subtask answers `409`, whether it is
workspace-bound or shares its parent's filesystem. They report `userVisible: true` and `managedByAnotherAgent: true`, and
`canSendMessages: true` while active. Reordering requires an owner-series entry, so a
shared-filesystem subtask returns `409` on `reorder`. Order among a coordinator's subtasks is
separate and moves with `subtask-reorder`, for either form. Archived subtasks accept no new messages or
child creation. Archiving a subtask keeps its history. A workspace-bound subtask and its workspace
archive together, in the same transaction, from either side: archiving the subtask through the
agent route or `archive_subtask` archives its workspace exactly as
`POST /v0/workspaces/:workspaceId/archive` does, and archiving that workspace — directly, through
an ancestor workspace, or through its project — archives the subtask. Archiving a
shared-filesystem subtask never archives the workspace it shares.
Subtask creation is asynchronous delegation: it never waits for completion. Existing agent
messaging tools deliver follow-ups, and `archive_subtask` exposes archival to the coordinator;
there is no subtask wait tool. Ordinary subagents
retain their existing restrictions.

Every agent therefore reports three independent capability facts: `userVisible`,
`managedByAnotherAgent`, and `canSendMessages`. New protocol-22 daemons always emit all three;
the fields are optional on the wire so clients remain compatible with older protocol-22 daemons.
When omitted, clients may use the old behavior as a fallback: `parentAgentId === null` was visible
and sendable, while a non-null parent was hidden and not sendable. `send`, `reorder`, `archive`,
`unarchive`, `read`, and `PUT draft` on any non-subtask agent managed by another agent answer
`409`.

Agents accept the optional `mutationId` from the basics — except `send`, whose message is
named by the client-supplied `id` instead — and carry a `version` like every
resource that appears in update events, but their mutations do not use `If-Match` — their
state changes continuously while a turn runs, so mutations name what they change instead of
guarding the whole row. The version exists for event chaining and newer-copy comparison.

### The agent object

```json
{
    "id": "a1b2c3d4",
    "workspaceId": "k2h4j5l6",
    "parentAgentId": null,
    "subtask": false,
    "subtasks": [],
    "subtaskOrderKey": null,
    "userVisible": true,
    "managedByAnotherAgent": false,
    "canSendMessages": true,
    "title": "Fix the login redirect loop",
    "titleStatus": "ready",
    "status": "idle",
    "wait": null,
    "subagents": { "total": 2, "running": 0 },
    "processes": { "running": 1 },
    "pendingQuestionId": null,
    "unread": { "reason": "turn_finished", "since": 1755400000000, "count": 2 },
    "lastActivityAt": 1755390000000,
    "orderKey": "5",
    "lastCursor": "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e",
    "version": "01991f3a-5f4d-7000-8000-6d3e5f708192",
    "createdAt": 1755300000000,
    "updatedAt": 1755400000000,
    "archivedAt": null
}
```

Fields:

- `id` — stable agent identifier.
- `workspaceId` — the workspace the agent runs in. This is where its shell commands execute
  and its file edits land. A bot's agent is no exception: it runs in the bot's dedicated
  workspace, and this field names that real workspace; see the bots chapter.
- `parentAgentId` — `null` when no agent manages this one; otherwise the agent that spawned and
  manages it. A subtask and an ordinary hidden subagent both retain this
  ancestry.
- `subtask` — optional additive boolean, always emitted by current daemons; absent means `false`.
  `true` identifies a user-interactive subtask, whether sharing its parent's filesystem or rooted
  in its own project workspace. The parent relationship remains `parentAgentId`.
- `subtasks` — optional additive array of full agent objects for this agent's direct children
  with `subtask: true` and `archivedAt: null`, in sibling order: children with a
  `subtaskOrderKey` first, by ascending key; then children without one, newest `createdAt` first;
  ascending `id` breaks any tie. Each child recursively carries its own `subtasks`. Idle and finished-but-unarchived
  subtasks are included; ordinary hidden subagents and archived children are not. Leaves emit
  `[]`; older daemons may omit the field. Every child's `parentAgentId` names the containing
  agent, and its `workspaceId` remains its actual workspace. The existing two-level bot-rooted
  limit bounds recursion, not sibling count. Do not flatten grandchildren across an archived
  child: archiving removes that branch from the containing tree without deleting its history
  or changing independently stored descendants. Focused reads and activity remain available.
- `subtaskOrderKey` — optional additive opaque sort key among the subtask's siblings under the
  same `parentAgentId`, compared like `orderKey`. Current daemons always emit it: a string on a
  subtask created by a current daemon or moved with `subtask-reorder`, and `null` on every
  non-subtask and on an older subtask that has never been ordered. A new subtask receives a key
  before every existing sibling's key, so it appears first. The key is independent of
  `orderKey`, which places a workspace-bound subtask in its workspace's agent series; moving one
  never moves the other. Archival keeps the key, so a restored subtask returns to its place.
- `userVisible` — optional additive flag, always emitted by current daemons. `true` when the agent
  is a subtask, a bot's own agent, a task's own agent, or explicitly attached to a project or
  workspace root-agent series. Ordinary subagents are `false`; subtasks are `true`.
- `managedByAnotherAgent` — optional additive flag, always emitted by current daemons. `true` when
  `parentAgentId` is non-null.
- `canSendMessages` — optional additive flag, always emitted by current daemons. `true` exactly
  when the user-facing `send` route accepts a message for this agent. It is `false` for ordinary
  non-subtask agents with a parent, and archived agents. Active subtasks are
  sendable despite their non-null parent.
- `title`, `titleStatus` — a generated human-readable title for the conversation.
  `titleStatus` is `"idle"` while none has been generated yet and `"ready"` once one has.
- `totalTokens` — optional additive non-negative integer or `null`. Emitted on every child in
  the activity response and the focused bootstrap's `subagents` list: this agent's lifetime
  recorded input plus output tokens, excluding separate cache counters and descendants' usage.
  `null` means no inference usage has been recorded; recorded zero usage is `0`. Other agent
  projections and older compatible daemons may omit it, meaning the total is unavailable.
- `status` — what the agent is doing right now, granularly:
    - `"idle"` — no run or maintenance work in progress.
    - `"thinking"` — the model is reasoning before it produces anything visible.
    - `"working"` — the model is producing output.
    - `"generating_tools"` — the model is emitting tool calls (streaming their arguments).
    - `"running_tools"` — tool calls are executing.

    During a run the status moves freely between the four working states, and every move is an
    `agent.updated` event, so a client can show "Thinking…" / "Running tools…" live. Compaction
    may also use `"working"`, but this generic status never identifies it. Clients render
    compaction only from the typed compaction block in history.
    Status is orthogonal to archival, which is `archivedAt`.

- `wait` — optional additive object, always emitted by current daemons. `null` means no active
  scheduled wait; otherwise `{ "startedAt": <Unix milliseconds>, "dueAt": <Unix milliseconds> }`
  is the interval owned by Scheduling for an active `wait` or `wait_until`. Waiting remains run
  work and does not make `status` idle. Every full agent object carries this field, including
  activity, owner responses, desktop and agent bootstrap, and nested subtasks. Older daemons may
  omit it, meaning wait information is unavailable; clients never reconstruct it from tool names,
  arguments, or transcript text.
  The interval appears when the durable wait starts and is replaced or cleared when it elapses
  or is interrupted by a message, abort, or archival. Restart preserves the original interval
  while the same durable wait remains active. With concurrent waits, expose the one due first,
  breaking ties by earliest `startedAt`, then ascending wait ID; its completion exposes the next
  active interval or `null`. `startedAt` never exceeds `dueAt`. Questions remain represented
  independently by `pendingQuestionId`. A scheduled message awaiting delivery does not make its
  sender or recipient a waiting agent.
- `retrying` — optional additive object, protocol 30 or newer. `null` means no automatic recovery
  is running; otherwise `{ "attempt": 3, "maxAttempts": 10, "kind": "provider_unavailable", "vendorName": "Claude" }`
  describes the recovery inside the current run; `vendorName` names the vendor being retried as
  in a sentence. `kind` is a failure kind from
  [Typed failures](#typed-failures): a provider retry carries the kind it is retrying, and the one
  retry after an automatic context reset carries `context_too_long` with `attempt` and
  `maxAttempts` both `1`. `attempt` never exceeds `maxAttempts`. Every change is an
  `agent.updated` event, and it is cleared when the attempt starts producing output or the run
  ends. Clients show it as the live working line and never reconstruct it from text. Older
  daemons omit it.
- `subagents` — how many child agents, including subtasks, this agent has spawned over its life (`total`) and how many
  are running right now (`running`). Changes to either count are `agent.updated` events. The
  subagents themselves are listed by `GET /v0/agents/:agentId/activity`.
- `processes` — how many background processes started by this agent are running right now.
  Process lifecycle detail travels in the `process.*` events and the activity endpoint.
- `pendingQuestionId` — the ID of the open question when the run is waiting on the person, or
  `null`. See "Questions" below.
- `unread` — set when the agent finished work the user has not looked at: why (`reason`) and
  since when. `null` when there is nothing unread. Cleared by `POST /v0/agents/:agentId/read`.
  `since` is when it first became unread: a later finished run keeps it. `count` is optional and
  additive: how many runs have finished at or after `since`, at most 100. It is derived when the
  agent is read, never stored, and every finished run while unread publishes it again with
  `agent.updated`. Clients show `100` as "99+". When `count` is missing or `0` they show a plain
  unread mark. Older daemons omit it.
- `statusLine` — deprecated optional object-or-null field, always `null` in current daemon
  projections. Older daemons and historical events may carry
  `{ "text": "Testing with a few friends", "updatedAt": 1755400000000 }`; `text` is 1–120 characters
  with at most one `\n` between non-empty lines and no `\r`. Clients keep accepting that earlier
  shape. A null or absent field shows no status line. Stored status metadata no longer affects
  `lastActivityAt`, which follows the person's last message, or `createdAt` before any message.
- `orderKey` — an opaque owner-local sort key, as on projects and workspaces; the list order is
  manual and moved with `reorder`. It is non-null for every user-visible root, including one
  managed from another workspace, and `null` for an ordinary hidden subagent or shared-filesystem
  subtask.
- `lastCursor` — the newest event cursor for this agent, so a client can open an event stream
  from exactly where the snapshot left off.
- `createdAt`, `updatedAt`, `archivedAt` — lifecycle timestamps; `archivedAt` is `null` while
  active.
- `compute` — optional additive object, sent only by Happy Cloud; Happy Agent never emits it.
  Where the agent's work runs: `{ "type": "none" }` when detached,
  `{ "type": "pool", "poolId": "…" }`, or `{ "type": "runner", "runnerId": "…" }`. A pool or
  runner may also carry `label`, a display name (the pool's name or the runner's hostname, or its
  ID once the pool or runner is gone), and `status`, `"online"` or `"offline"`. Changes arrive as
  `agent.updated` changes carrying the whole object. Absent means the server does not report
  compute. Clients tolerate additional properties.
- `enforcedCompute` — optional additive object or `null`, sent only by Happy Cloud. The pool or
  runner the agent is held to: `{ "type": "pool", "poolId": "…" }` or
  `{ "type": "runner", "runnerId": "…" }`, without `label` or `status`. `null` means none is
  enforced. Changes arrive as `agent.updated` changes.

### `POST /v0/agents`

Creates an agent in a workspace.

Request:

```json
{
    "workspaceId": "k2h4j5l6",
    "title": "Fix the login redirect loop",
    "id": "a1b2c3d4"
}
```

- `workspaceId` — required; the workspace the agent will run in. Must be active.
- `title` — optional. A titled agent keeps it: `titleStatus` is `"ready"` from birth and the
  daemon never generates one over it. Untitled, the daemon generates a title from the
  conversation once there is enough to summarize.
- `id` — optional client-supplied ID. Creating with the ID of an agent that already exists
  returns that agent unchanged, making creation safely retryable.

Creation always makes a user-controlled, parentless root in the destination workspace. There is
no parent-selection option: a request containing `parentAgentId` returns `400 invalid_request`,
even when its supplied `id` already exists. Ordinary hidden subagents are spawned by their
parents rather than through this endpoint. Bot agents are not created here either — a bot's one
agent is born with the bot through `POST /v0/bots`, and creating another agent in a bot's
workspace is refused with `409`: a bot has exactly one primary session. Subtasks are created
only through `create_subtask`, not this endpoint.

Response — `201`: `{ "agent": { ... }, "profiles": [ ... ], "slashCommands": [ ... ] }`.
Creation is complete when it answers: the agent exists, is `"idle"`, and is ready for a user message. The
owning project and its same-ID root workspace, or the owning child workspace, also advance and emit
their update with the new ordered `agents` series.

### `GET /v0/agents/:agentId`

Returns one agent.

Response — `200`: `{ "agent": { ... }, "profiles": [ ... ], "slashCommands": [ ... ] }`; `404`
when no such agent exists. `profiles` and `slashCommands` are the complete current catalogs
described here and below. Every focused agent mutation response that carries `agent` also carries
both fields, so a client never has to make another request merely to populate its composer.

The `profiles` array belongs to this exact agent. Every entry is:

```json
{
    "id": "coding-agent-v3",
    "name": "Coding agent",
    "description": "Use the coding-agent session configuration."
}
```

- `id` — the exact opaque string sent as a message's `profile`, unique within this agent's
  catalog and at most 512 characters.
- `name` — a short display name from 1 to 128 characters.
- `description` — a concise explanation from 1 to 1,024 characters.

The array is ordered for display. Only IDs in this catalog match the agent's active request-profile
codec. Sending an absent, unknown, or later-removed ID still follows the tolerant message contract:
it decodes to `null` instead of rejecting the message. Current daemons always emit `profiles: []`.
When the catalog changes, `agent.profiles.updated` replaces a client's cached list. The field is
optional on focused responses so clients remain compatible with older protocol-22 daemons.

### `GET /v0/agents/:agentId/mode`

Returns the complete mode carried by the last submitted message, whether that message is already
accepted or still pending. It is separate from the agent object because model choice, effort,
service tier, and permission mode are composer state rather than agent lifecycle state.

Response — `200`:

```json
{
    "mode": {
        "providerId": "codex",
        "modelId": "openai/gpt-5.6-sol",
        "effort": "medium",
        "serviceTier": null,
        "permissionMode": "auto"
    }
}
```

`mode` is `null` before the first message. `404` when no such agent exists.

An execution `MessageMode` in configuration history or structured error details may additionally
carry `account: { "id": "...", "label": "..." } | null` beside `providerId`. Account provenance
is output-only and is absent from requested modes, pending and accepted user-message modes,
drafts, and this mode endpoint. `id` is an opaque, installation-local account identity, not a token, token
hash, credential path, or provider-native account identifier. It is a nonempty string of at most
256 characters. `label` is optional, nonempty human-readable text of at most 256 characters. The daemon
resolves this provenance from the credential actually used. Execution snapshots may also carry
`providerType`, the canonical configured provider family at the time of that attempt, as a
nonempty string of at most 128 characters. It is output-only too, and remains absent when unknown.
Clients omit `account` and `providerType` from outbound
message and slash-command modes and saved drafts so reusing a snapshot remains compatible with older daemons. A
caller-supplied provenance field is never an account selector or evidence of identity and is ignored.
`null` means the account has not been
established at this point. Absence means the daemon supplied no account provenance. Clients show
an unknown account honestly rather than deriving an identity from a provider alias or token.

Pending modes describe the requested configuration, not a promise about the eventual account or
fallback route. Configuration history and error details below carry actual execution snapshots.
Captured snapshots are durable and are not reconstructed from today's credentials or settings.
In a submitted message, pending message, or composer mode, `providerId` remains the requested
provider or routing-group alias. In a configuration block's `before`/`after` and an error's `mode`,
`providerId` is the concrete provider entry actually selected for that execution attempt. These
execution snapshots do not overwrite the stored requested mode. A routing alias is never evidence
of an account identity; `account.id` is supplied only from observed identity.

### Slash commands

Modules may contribute slash commands for an agent alongside the instructions and tools they
already contribute. A command belongs to the module that returned it, and invoking it calls that
module directly; the command text is not sent to the model and the API does not switch on command
names. Names are unique within one agent's catalog and do not include the leading slash.

One command has this shape:

```json
{
    "name": "code-review",
    "hasArguments": true,
    "description": "Review the current changes.",
    "kind": "skill",
    "image": {
        "thumbhash": "1QcSHQRnh493V4dIh4eXh1h4kJUI"
    }
}
```

- `name` — the command itself, without `/`.
- `hasArguments` — whether text may follow the command name. Arguments are one opaque string for
  the owning module to interpret.
- `description` — concise human-readable help shown in command menus.
- `kind` — optional command category such as `"skill"` or `"compaction"`. It is presentation
  metadata, not a dispatch key.
- `image` — optional command artwork metadata. `thumbhash` is the base64 ThumbHash placeholder the
  client renders immediately; the image bytes are fetched separately from the focused command's
  `image` endpoint, exactly like a project avatar. A command without artwork omits `image`.

The catalog is complete and ordered: every available command is returned, including one command
for every currently discoverable skill. There is no command-count or aggregate encoded-JSON size
limit on the catalog. In particular, catalogs with thousands of skills must not be truncated,
rejected merely for exceeding 256 commands or 256 KiB, or replaced with the model's prompt
shortlist. Per-command validation remains bounded: a name is at most 128 characters, a description
1,024, a kind 128, arguments 1,000,000, and one command image 8 MiB. Resource or transport failures
must be reported as errors rather than successful partial catalogs. The daemon loads the catalog
when an agent is created or restored and again
immediately before every turn, alongside the turn's instructions and tools. It compares the
complete ordered descriptors and the content identity of their separately served images. When
either differs, the daemon replaces its cached copy and emits `agent.slash_commands.updated` with
the complete new list. Clients invalidate affected command images on that replacement event and
may revalidate them with `ETag`. A failed refresh fails the turn rather than silently running it
with an uncertain command surface. Invocation performs the same refresh before resolving the name,
so a removed command is never dispatched from stale cached data.

The built-in command contributions include:

- `compact` — `hasArguments: false`, `kind: "compaction"`; invokes the Compactions module and has
  the same durable manual-compaction behavior as `POST /v0/agents/:agentId/compact`.
- one command for every currently discoverable skill — `hasArguments: true`, `kind: "skill"`,
  using the skill's name and description. Invocation calls the Skills module, which reads the
  complete current skill and submits it with the optional arguments as the user's request under
  the supplied mode.

#### `GET /v0/agents/:agentId/slash-commands/:name/image`

Serves the current cached image bytes for one focused command. The response carries the image's
content type and a content-derived `ETag`, supports `If-None-Match` with `304`, and uses
the shared image-caching policy for successful and conditional responses. A command that does not
exist or has no image is `404`. The endpoint does not refresh command discovery by itself; agent snapshots, turns,
and command invocation refresh the catalog and announce changed image content through
`agent.slash_commands.updated`.

#### `POST /v0/agents/:agentId/slash-commands/:name`

Invokes one command directly on the module that contributed it. `name` is URL-encoded and omits
the leading slash.

Request:

```json
{
    "arguments": "focus on authentication",
    "mode": {
        "providerId": "codex",
        "modelId": "openai/gpt-5.6-sol",
        "effort": "medium",
        "serviceTier": null,
        "permissionMode": "auto"
    },
    "mutationId": "..."
}
```

- `arguments` — optional opaque text. Supplying it to a command whose `hasArguments` is `false`
  is `400`; an argument-capable command decides whether an omitted or empty value is meaningful.
- `mode` — the complete composer selection, required for every invocation so commands that start
  a turn do so under exactly what the person selected. It has the same fields and is checked
  against the model catalog exactly as in `send`, with the same `400 invalid_request`, even for
  commands such as compaction that do not run inference and otherwise ignore it.
- `mutationId` — optional mutation echo. Every event caused by the invocation carries it.

Response — `202` after the owning module has durably accepted the invocation:

```json
{
    "agent": { ... },
    "profiles": [ ... ],
    "slashCommands": [ ... ],
    "command": {
        "name": "code-review",
        "hasArguments": true,
        "description": "Review the current changes.",
        "kind": "skill"
    },
    "cursor": "01991f3a-6d2f-7000-8000-3a0b2c4d5e6f"
}
```

`cursor` is captured before refresh and dispatch, so following the event stream from it observes
the catalog replacement, message/run lifecycle, compaction lifecycle, or other durable effects the
command causes. `profiles` and `slashCommands` are the post-refresh catalogs and `command` is the
exact descriptor that was invoked. An unknown or just-removed command is `404`; a command that
cannot run in the agent's current state is `409`. A module failure is reported through the ordinary
error contract.

### Messages and runs

A message is one durable entry in the conversation; a **run** is the work the agent does in
response — inference, tool calls, compaction, and everything until the next explicit boundary.
Sending a message to an idle agent starts a run immediately; sending to a working agent queues the
message, and it starts its run when the current one ends. Steering does not cancel active inference
or tool execution. It waits for the current assistant response and its complete tool-call batch to
finish, then accepts every pending steering message before the next inference request. Only a
person's steering, a `user` message, is a boundary: it finishes the active run as
`aborted/steering` and starts its successor without first going idle. A steering message from
another agent or from the system reaches the model at the same point but joins the active run,
which continues as one run. A message accepted while no run is active starts one, whoever sent
it. Automatic compaction stays inside the active run. Explicit compaction starts its own
maintenance run because history is grouped by run; it never emits `run.boundary`.

Every run has the same metadata:

```json
{
    "id": "tz4a98xxat96iws9zmbrgj3a",
    "status": "running",
    "reason": null,
    "startedAt": 1755400000000,
    "endedAt": null,
    "usage": {
        "codex": {
            "openai/gpt-5.6-sol": {
                "input": 310000,
                "output": 21000,
                "cacheRead": 250000,
                "cacheWrite": 30000
            }
        }
    },
    "costUsd": null
}
```

- `status` — `"running"`, `"completed"`, `"aborted"`, or `"failed"`.
- `reason` — `null` while running, then exactly one of `"completed"`, `"steering"`, `"abort"`,
  or `"error"`. Status and reason answer different questions: `status` is the outcome; `reason`
  is why this run ended. Steering and explicit abort have status `"aborted"` with their
  respective reasons. Failure has status `"failed"` and reason `"error"`.
- `startedAt`, `endedAt` — the turn's bounds, used directly for elapsed time.
- `usage` — the inference usage accumulated inside this run, in the same provider-then-model
  shape as the usage endpoints. It grows while the run is live and is final when the run ends.
- `costUsd` — the provider-reported US-dollar cost accumulated inside this run, or `null` when
  its providers do not report monetary cost. The daemon never invents a price from a local
  table.
- `kind` — optional; protocol 35 or newer. Absent for a turn of the agent. `"standalone"` marks a
  run stored already finished, outside any turn: it never started and was never the agent's
  active run. The daemon stores a message it writes itself while no run is open this way.
  A client treats a value it does not know as absent.

A run whose `kind` is `"standalone"` only groups messages in history. Its `status` is
`"completed"`, its `startedAt` and `endedAt` are equal, and it has no usage and no cost. It emits
no `run.started` and no `run.boundary`: its one lifecycle event is `run.finished`, which precedes
the `message.created` of every message in it. It never changes whether the agent is working: an
agent that was working when it appeared is still working, and an idle one is still idle. A client
therefore leaves the agent's activity as it was and shows no end of a turn for it. A maintenance
run, such as explicit compaction's, starts and finishes like a turn and carries no `kind`.

The boundary transitions are atomic in the event journal:

- Accepting one or more queued or idle messages together emits `run.started` with the new run and
  the ordered IDs of its visible accepted messages. It does not also emit `message.updated` for
  those acceptances.
- A person's steering emits one `run.boundary` carrying the old run finished with reason
  `"steering"`, its newly started successor, and the ordered IDs of every visible steering message
  accepted into the successor.
- A steering message from another agent or from the system accepted while a run is active joins
  that run and emits no run lifecycle event. A visible one is announced by `message.created`
  carrying the active run's ID.
- A run that ends without an immediate successor emits `run.finished`.

These compound events let a client close the old group, move the accepted messages, open the
new group, and update activity in one frame without repeating message content.

Every message carries its own mode — the full model selection and permission mode. There is no
agent-level default; the client sends what its composer shows (typically prefilled from the
agent's `mode` endpoint or bootstrap response). A user message also carries its nullable
`profile`, the decoded opaque compatibility identity that decided whether accepting it reset the
model's private conversation context. Current daemons always emit `profile`; it remains optional
on the wire so clients stay compatible with older protocol-22 daemons.

### Message content

Every message is `id`, `role`, `createdAt`, `content` — an ordered array of blocks — and a
required `metadata` object. A user message may additionally carry `clientMetadata`, the freeform
JSON object supplied by the client that sent it. This one shape carries the whole conversation;
history, send acceptances, pending state, and events all speak it.

`metadata` carries typed public provenance rather than internal message metadata:

- `providerId` — the provider that produced the message, when it came from inference.
- `modelId` — the model that produced the message, when it came from inference.
- `senderAgentId` — the agent that sent a system-generated message, when one identified itself.
- `senderAgentExplanation` — that agent's one-line account of what the message is, at most 120
  characters, for a client to show beside the sender until the message is opened. Present only
  with `senderAgentId`, and only when the sender gave one: `send_agent_message` always does, and
  a collaborator's automatic settlement report says whether it finished with an answer or stopped.
  The field is additive and does not increment the protocol version.
- `userId` — the installation-local Happy CUID2 of the person who wrote a user message: the
  authenticated member who submitted it in team mode, or, in either mode, the guest who wrote it
  to an exported bot. The daemon derives it from authentication or from the export; clients
  cannot set it.

Each field is optional, but the object itself is always present. A message without public
provenance therefore carries `"metadata": {}`. Clients ignore metadata fields they do not
recognize as this object grows.

`userId` is captured when a team-mode user message is first durably submitted, for both queue and
steer delivery. It is retained in the agent's durable message metadata and conversation context,
pending and accepted history, send responses, bootstrap, and every full-message event or history
response, including after restart. Re-sending an existing message ID preserves its original
author even when a different member retries. Client-owned metadata cannot override this identity.
Standalone messages other than guests', older messages without recorded authorship, and
agent-generated messages omit `userId`; the daemon never backfills it from the current caller. This field does not change
user-message content or context-reset behavior.

In team mode, the Team module injects a separate, model-facing system notification identifying
the sender before the first authored user message and whenever the sender changes. The
notification includes the sender's installation-local Happy user ID, full name, and nullable
email address, but not WorkOS identity, owner privileges, or photo bytes. Profile values are
descriptive user data, not instructions or authorization. Consecutive messages from the same
sender with unchanged profile information do not repeat the notification. A changed name or
email is announced when that sender next speaks or before the next inference for that sender;
editing a profile does not itself wake an idle agent.

Notifications follow actual message-consumption order, including each sender transition within
a mixed-sender queue or steering batch. They commit with the message they describe, preserve
the original author on duplicate submissions, and remain consistent across rollback and restart.
When compaction or a context reset replaces the model's history, the current sender's profile is
reintroduced before inference as needed. A user message with missing or unresolvable authorship
clears any previously announced sender rather than inheriting another person's profile;
agent-generated and system messages do not impersonate or change the human sender. A guest's
message is announced in both modes, as an outside guest who is neither the owner nor a team
member and whose requests authorize nothing on anyone's behalf; the notification carries the
guest's Happy user ID and name. Standalone mode injects no other sender notification, except that
an owner's message following a guest's in the same conversation is announced as the owner's. These notifications belong to private model
context, not user-message content, public message metadata, or profile-update event payloads;
the HTTP request and response schemas are unchanged.

`clientMetadata` is separate from provenance. It is an optional object whose keys and nested
values may contain any JSON value. The daemon treats it as opaque: it does not interpret its
keys, merge it with daemon metadata, or send it to the model. When supplied, the complete object
is durably attached to that user message and returned unchanged in the send response, pending
bootstrap state, `message.created` and any later full-message event, and accepted history,
including after daemon restart. When omitted, the field is absent. Re-sending an existing message
ID returns the originally stored object and never replaces it with metadata from the retry.

A user message may also carry `quote`, what it replies to, set by the daemon and never by the
sending client. Its `content` holds only what the person wrote; clients show the quote above it.
The one kind today is a person's reply to a story:

```json
{
    "kind": "story",
    "storyId": "q2v7m4wfx0e8c1hg9kz3b6np",
    "agentId": "k8d2s0vqzj4m7ly1c5xh3rwe",
    "userId": null,
    "caption": "New onboarding is ready to try",
    "expiresAt": 1755486400000,
    "frame": { "mimeType": "image/png", "thumbhash": "1QcSHQRnh493V4dIh4eXh1h4kJUI" }
}
```

`agentId` is the story's agent, also this conversation's. `userId` is the person who reposted it
when the story is a repost, and its author; otherwise it is `null` and the agent is the author.
`caption` is the story's, or `null`. After `expiresAt` the story cannot be opened, but the quote
stays. `frame` is `null` or a still of the story's first frame, with an optional base64 ThumbHash
placeholder, served by `GET /v0/agents/:agentId/messages/:messageId/story-frame`: an image story's
own image, or for a video, a still taken when the agent posted it. Clients ignore a quote kind
they do not recognize. The field is additive and does not increment the protocol version.

A historical user message may carry `quickReply` provenance. Clients tolerate it as opaque data;
current daemons do not create it from sends.

`profile` is separate from both mode and metadata. On the wire it is `null` or an opaque string of
at most 512 characters. An internal request-profile codec decides which strings are currently
meaningful; it accepts only `null` today. A string that does not match the current codec is
converted to `null` rather than rejected. The daemon stores and returns only the decoded value on
every complete representation of a user message, and never sends the opaque string to the model.
See `send` for its context-reset semantics.

**Roles** say who produced the message:

- `user` — sent by a person. Also carries the `mode` it was sent with, its `delivery`, and a
  `status` of `"pending"` or `"accepted"` — pending until inference takes it up; see `send`.
- `agent` — produced by the model: its text, reasoning, and tool calls, as blocks in order.
- `system` — content the daemon injected into the model's context, when it is worth showing.
- `service` — typed operational records the model never saw: compaction, aborts, and similar
  housekeeping. Human-readable text never carries compaction lifecycle meaning.

#### Configuration history

A configuration record is an ordinary durable `service` message with one `configuration` block:

```json
{
    "type": "configuration",
    "before": {
        "providerId": "codex",
        "providerType": "codex",
        "account": { "id": "account-default", "label": "Default account" },
        "modelId": "openai/gpt-6-astra",
        "effort": "high",
        "serviceTier": null,
        "permissionMode": "auto"
    },
    "after": {
        "providerId": "claude",
        "providerType": "claude",
        "account": null,
        "modelId": "anthropic/opus-5-5",
        "effort": "high",
        "serviceTier": null,
        "permissionMode": "auto"
    },
    "beforeMessageId": "tz4a98xxat96iws9zmbrgj3a"
}
```

`before` and `after` are complete `MessageMode` snapshots, with `before: null` only for the first
resolved execution configuration. The first record establishes the durable baseline but is not
shown as a change. `beforeMessageId` is an existing message identity or `null`. A non-null value
must name a committed, visible message in this same history run, placing the record immediately
before that message, normally the first message affected by the
change. `null` keeps its ordinary chronological append position when there is no suitable user
message to anchor, such as a mid-run account switch or compaction. The enclosing message ID
is the configuration record's identity; no separate change ID, revision, event family, or incident
store is introduced. The ordinary history and `message.created` transport carry the same record.
Clients preserve the anchor when its message is outside the loaded history page instead of
guessing another position. Desktop may place the row by its anchor. An append-only terminal must
not move or rewrite stable transcript rows to insert it; it appends the configuration row at the
next safe chronological position when the anchor is already rendered.

Resolve the actual provider, model, and observed account before comparing with the previous
execution snapshot. A same-configuration execution emits no change record. A token refresh for
the same known account does not count as a change, nor does a display-label refresh. Several
requested changes before one execution coalesce to the configuration actually used: A → B → C
with no execution on B records A → C. A route change after output has begun belongs before the
next affected message, never retroactively before output produced by the old route. The baseline
survives compaction and restart. These records are display history, never model input or a reason
to reset provider context.

An unknown account becoming known, or a previously known account becoming unavailable, does not
prove an account switch. Such enrichment updates the comparison baseline without emitting a change
solely for that uncertainty. Two different observed account IDs do prove an account change.

Clients resolve human-readable model names from the existing model catalog. Provider family is
the snapshot's `providerType`, not
a provider ID prefix, routing alias, model ID prefix, or guessed model vendor. Bedrock is the
Bedrock provider family even when its models come from different model vendors; model names still
come from the model catalog independently. Do not reconstruct historical family from a changed
or removed provider in today's catalog. If a provider's type is unavailable, its family is
unknown and clients do not invent an account-only transition. They display an
account-only change when the before and after providers belong to the same known provider family;
when the family changes, the model change is sufficient and the account transition is hidden.
Missing labels or unknown identities never become invented account names.

A concrete `providerId` change within one known family remains a meaningful configured-connection
change even when both snapshots have `account: null`. Clients show that connection change using
available configured display labels or the exact provider-route identifiers, clearly presented
as connections rather than verified vendor accounts. They do not suppress it merely because
vendor identity is unknown. A native account change behind an unchanged provider entry requires
observed account identities; an unknown identity cannot prove such a change. No extra identity
field is needed: the existing `providerId` and optional `account` describe these distinct facts.

#### Structured error details

An ordinary error `service` message retains its existing full, user-safe text blocks and may
add an `error` object alongside `content` and `metadata`:

```json
{
    "code": "authentication",
    "mode": {
        "providerId": "claude_work",
        "providerType": "claude",
        "account": { "id": "account-work", "label": "Work" },
        "modelId": "anthropic/opus-5-5",
        "effort": "high",
        "serviceTier": null,
        "permissionMode": "auto"
    },
    "credentialSource": {
        "kind": "environment",
        "location": "CLAUDE_CODE_OAUTH_TOKEN",
        "host": "Mac mini"
    },
    "recovery": {
        "steps": [
            "Retry this chat first.",
            "If it still fails, check CLAUDE_CODE_OAUTH_TOKEN in this daemon's environment, replace it if needed, and reload that environment. Then retry this chat. Signing into the native assistant alone does not replace this environment override."
        ],
        "actions": ["ask_chief"],
        "commands": []
    }
}
```

All existing messages remain valid without `error`. From protocol 30, `error.credentialSource`,
`error.recovery.steps`, and `error.recovery.commands` are legacy: daemons still send them for older
clients, but clients at protocol 30 or newer render from `failure` when it is present. When
present:

- `code` is a nonempty stable machine-readable string of at most 128 characters. The set grows;
  clients treat unknown codes as generic failures and never classify errors by matching prose.
- `mode` is the actual failed attempt's complete `MessageMode`, or `null` when unavailable. It
  names the concrete attempted route, not a requested routing pool or a later successful retry.
- `credentialSource` is `null` when unknown or not authorized for this caller. Otherwise its
  `kind` is a nonempty string of at most 64 characters. Current kinds are `native_login`,
  `configuration`, and `environment`; future kinds are additive. Clients tolerate an unknown kind
  and show generic source information without inferring a native login or other remedy.
  `location` is a nonempty safe
  descriptor of at most 256 characters, such as a native assistant's sign-in, a configuration
  key, or an environment-variable name. `host` is a human-readable host label of at most 256
  characters, or `null` when unavailable or not authorized. These fields never contain token
  values, token fragments or hashes, credential-file paths, credential-file contents, or raw
  authorization headers. They are captured from the actual credential source, not guessed from
  current configuration after the failure.
- `recovery.steps` is an ordered array of at most eight user-safe instructions, each nonempty
  and at most 2,048 characters. Advice must match the observed source: native sign-in, configured
  credentials, and an environment override need different remedies. Unknown sources get honest
  diagnostic guidance, not an asserted cause. Authentication failure describes this attempt,
  not proof that a login was lost or that refresh cannot recover. An expired `401` alone never
  demands sign-in: the provider's normal recovery runs first. A terminal failure may suggest
  retrying this chat, then conditional manual recovery if retry still fails.
- `recovery.commands` is an optional array of at most eight copyable manual commands. Each entry
  has a nonempty `label` of at most 128 characters and a nonempty `command` of at most 2,048
  characters. Commands are safe daemon-curated instructions for the observed source, never
  provider diagnostics, token values, or shell text assembled from untrusted labels. Clients
  show the exact command and a Copy control; copying never runs it. Missing means no supplied
  commands, not permission to invent one from error text.

    For the default native Claude Code login only, the fallback command is `claude auth login`.
    A missing or rejected sign-in says to sign in first: its steps explain to run the command on
    the machine hosting the agent as the same operating-system user that runs the daemon, complete
    the browser sign-in, then retry the same chat. A remote daemon's machine is not necessarily the
    client's machine; the UI uses the supplied host label and never invents an SSH command. The command and steps
    remain usable with no working AI credentials. An explicit configured token, API key, environment
    override, or custom native configuration directory must not receive that default-login command.
    Custom native sources receive guidance to sign in using their selected configuration; configured
    and environment credentials receive guidance naming the safe configuration key or variable.
    Unknown sources receive inspection guidance without an asserted repair command.

- `recovery.actions` is a duplicate-free array of at most eight nonempty action names, each at
  most 64 characters. The current daemon emits only its closed allowlist, `ask_chief`;
  the wire set may grow additively. Clients ignore unknown action names rather than
  guessing their behavior, parsing them as commands, or rejecting the error message. Recognized
  actions are suggestions requiring a person to invoke them, never automatic execution.

Credential disclosure follows the authenticated caller principal on every ordinary read. Only
the standalone user and the team installation's existing owner identity may receive the observed
credential source and host, source-specific recovery steps, and supplied commands. Every other
caller receives the withheld projection: `credentialSource: null` (so no host is disclosed),
generic source-agnostic `recovery.steps`, and omitted `recovery.commands`. `recovery.actions`
remains unchanged because its suggestions are source-agnostic. Unknown authority fails closed.
Team membership, agent or Surface creation, bot or task ownership, Surface membership,
and peer or installation transport credentials are not evidence of the team owner's identity.
Apply this projection per caller at read time to history and any other message-bearing response,
including bootstrap, event pulls, live delivery, replay, pending-event flushes, and both
`message.created` and `message.updated`; never change the stored message or shared event journal.

The ordinary error text and other shared user-safe diagnostics must themselves be source-agnostic,
with one exception: for a default native login, the text and `failure.command` may name the
vendor's own sign-in command (`claude auth login`, `codex login`, `grok login`). They never contain
the credential location, configuration key or environment-variable name, host label, native
configuration directory, token, or path. Other source-specific advice belongs only in the
projectable structured fields. Preserve the complete remaining user-safe text,
including paragraphs and newlines; withholding structured fields must not leave the same details
exposed in prose.

An ordinary agent read opened from a Surface reference or contextual chat uses that same caller
rule, irrespective of the UI entry point. By contrast, any Surface-owned or other shared payload,
snapshot, or reference preview embedding messages or error details always uses the withheld
projection for every reader, including the installation owner. Any stored shared copy is created
from the withheld form; the original message remains unchanged. Surface membership and shared
view access never grant diagnostic authority. These rules also govern future message-bearing
Surface views. Peer-visible errors are limited to the withheld projection or existing safe
code/text diagnostics; credential source, host, source-specific recovery steps, and commands
never cross the peer boundary. This grants no new fields or operations to the separate
`API_P2P.md` contract; its existing safe admission and connection diagnostics remain unchanged.

Non-HTTP readers follow the same disclosure boundary. Agent-facing transcript tools, collaboration
reports, history excerpts, summaries, and `ask_chief` diagnostic context use the withheld form or
omit structured error details entirely, even when acting for the installation owner. Captured
credential source and host are display-only provenance and never become model input; neither
source-specific recovery steps nor supplied commands are inserted into model context. An
authenticated client session reached through a relay, including the mobile app, remains an
ordinary per-principal read. Generated outbound integration messages, notifications, push text,
and webhooks use the withheld form unless the destination is verified as a private channel
belonging only to the authorized standalone user or team installation owner. Telegram access or
a relay connection alone proves no such ownership. Uncertain destinations are withheld.
Project before persisting or sending an outbound copy; never copy authorized details into a
shared outbox and rely on its eventual reader to hide them.

Observation history dumps, logs, telemetry, crash reports, and other diagnostic exports omit
authorized credential details or use the withheld form unless written only to owner-private
local storage. Diagnostic data sent off the machine always uses the withheld form.

Clients preserve paragraphs and newlines, wrap the full user-safe error text, and do not use a
single-line scroller or clip it to a fixed-height row. Details supplement that text; they never
replace it with a shortened diagnostic. Existing history text bounds and credential redaction
still apply. The message's existing ID identifies the failure across history, events, restart,
and recovery; there is no separate incident database.

Every displayed error, including an unknown code, a legacy error without structured details, a
failed tool, or an API request failure, may expose manual inspection/copying and the same scoped
Chief of Staff help. These generic actions do not assert a cause or require invented metadata.
Clients use a failed tool's existing ID or the API failure's safe request context as the reference
when no error-message ID exists. They never classify those failures by matching error prose or
mistake a daemon authentication failure for a provider-account failure.

#### Typed failures

From protocol 30 an ordinary error `service` message may also carry `failure`, a typed
description the client renders the card from. The message's text block equals `failure.message`.
`failure` is a union discriminated by `kind`:

```json
{
    "kind": "usage_limit",
    "message": "Claude usage limit reached. It resets in about 2 hours.",
    "provider": { "id": "claude", "type": "claude", "vendorName": "Claude", "label": "claude" },
    "resetsAt": 1755407200000,
    "fallbackProviders": []
}
```

Every variant carries:

- `kind` — a nonempty string of at most 64 characters. The set grows; clients treat an unknown
  kind as a generic failure that shows `message` with Retry and the Chief of Staff action.
- `message` — one user-safe sentence of at most 512 characters, the plain-text fallback for
  agents, collaboration reports, and clients that do not know the kind. It never contains a clock
  time; a reset is a relative duration ("in about 2 hours") or omitted. Clients that know the kind
  write their own text from the typed fields instead.
- `fallbackProviders` — always an empty array from protocol 32. A failure names what failed, never
  what to switch to: alternatives and their usage go stale as soon as they are written, so the
  daemon neither sends nor stores them, and reads failures stored earlier with an empty array.
  Clients offering Switch take its targets, account labels, and usage from the live model catalog
  (`GET /v0/config`) and provider usage (`GET /v0/usage`, `provider.usage.updated`), the same
  sources as their model picker, and refresh usage when the person opens the switch menu as they
  do when the picker opens. Before protocol 32 the array held at most 16 ranked alternatives with
  `providerId`, `providerLabel`, `modelId`, `usedPercent`, `usageWindow`, and `group`; the
  element shape remains valid.
- `resolution` — absent until the person acts on the failure, then `{ "action": "retried",
"at": <Unix milliseconds> }` or `{ "action": "switched", "at": <Unix milliseconds>,
"providerId": "...", "modelId": "..." }`. The action set is extensible. The failed message is
  never removed or collapsed; it records what happened and the continued turn follows it.

Per kind:

| `kind`                                                                 | Additional fields                                                                                                                                                                       |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `signin_missing`                                                       | `provider`, `product` (the native assistant, such as "Claude Code", or `null`), `command` (`claude auth login`, `codex login`, or `grok login` for a default native login, else `null`) |
| `usage_limit`                                                          | `provider`, `resetsAt`                                                                                                                                                                  |
| `no_account_available`                                                 | `poolName`, `resetsAt`, `members` (optional)                                                                                                                                            |
| `rate_limited`, `provider_unavailable`, `network`, `provider_disabled` | `provider`                                                                                                                                                                              |
| `context_too_long`                                                     | `modelId`                                                                                                                                                                               |
| `internal`                                                             | `detail`, one sanitized sentence                                                                                                                                                        |

`provider` is `{ id, type, vendorName, label }`: the entry ID, the canonical family, the vendor as
named in a sentence ("Claude"), and the configured entry's display label. `resetsAt` is the
absolute Unix-millisecond instant the spent limit resets, or `null` when unknown. Clients format it
in the viewer's own locale and time zone, include a day or date when it is not today, and never
show UTC or a raw timestamp.

`signin_missing` covers both a missing credential and a rejected one (an expired `401` after the
provider's own refresh failed). `context_too_long` appears only after the automatic recovery: on
a context overflow before any visible output, the daemon resets the model's private context once,
exactly like an incompatible model switch, records a `service` message with
`notice: { "kind": "context_reset" }` and the text "Context reset", reports `retrying` with
`kind: "context_too_long"`, and retries the turn once. Only if that retry overflows too does the
failure appear. A cancelled run creates no failure.

`no_account_available` may carry `members`, what happened to each account of the pool:

```json
{
    "kind": "no_account_available",
    "message": "No Pool account is available. The first one resets in about 5 days.",
    "poolName": "Pool",
    "resetsAt": 1755832000000,
    "fallbackProviders": [],
    "members": [
        {
            "provider": { "id": "codex", "type": "codex", "vendorName": "Codex", "label": "codex" },
            "reason": "usage_limit",
            "command": null,
            "resetsAt": 1755832000000
        }
    ]
}
```

Each entry is one account the pool tried and set aside since the person's last message or retry,
listed in the pool's configured order, which is the order of `pool.members`:

- `provider` — the account, as `provider` above.
- `reason` — the kind of that account's own failure: `signin_missing`, `usage_limit`,
  `rate_limited`, `provider_unavailable`, or `network`. The set may grow; clients treat an
  unknown reason as an account that is unavailable for an unstated reason.
- `command` — exactly as on `signin_missing`: the default native login command, else `null`.
  Always `null` unless `reason` is `signin_missing`.
- `resetsAt` — exactly as on `usage_limit`. Always `null` unless `reason` is `usage_limit`.

Accounts that are turned off are left out, so a pool whose accounts are all off reports an empty
list. A pool in which any tried account's sign-in was rejected reports that account's
`signin_missing` instead of `no_account_available`, so today every listed member has
`usage_limit`. The list holds at most 64 entries. `members` is additive and does not increment the
protocol version. Older daemons and failures stored before it omit it, and clients then show only
`poolName` and `resetsAt`.

`failure` is identical for every reader. It contains no credential location, host, or
configuration key, so the per-caller projection above keeps withholding only the legacy
`credentialSource`, source-specific steps, and commands.

##### `POST /v0/agents/:agentId/messages/:messageId/retry`

Runs the failed turn again on the route it failed on. `messageId` names a service message
carrying `failure`. Request: `{ "mutationId": "..." }`, all optional. The daemon records
`resolution: { "action": "retried" }` on that message and starts a run that answers the same
request without adding a user message. Response — `202`: `{ "agent": { ... }, "message": { ... },
"cursor": "..." }`, where `message` is the failed message now carrying its resolution; the run
arrives through events from `cursor`. A message already resolved returns its current state
unchanged and starts nothing. `404` when the message does not exist or carries no `failure`;
`409` when the agent is not idle.

##### `POST /v0/agents/:agentId/messages/:messageId/switch`

Moves the chat to another route and continues the failed turn there. Request:
`{ "providerId": "claude_work", "modelId": "anthropic/opus-5-5", "mutationId": "..." }`. The pair
must be a model the live model catalog offers when the request arrives, the same catalog a send
accepts, so an enabled provider's model; otherwise `400` with `invalid_request`. Daemons before
protocol 32 accept only a pair from the failure's `fallbackProviders`. The daemon records
`resolution: { "action": "switched", "providerId", "modelId" }` and starts a run on that route with
the failed attempt's effort when the model supports it, else the model's default, and the same
permission mode. A switch to an incompatible model resets the private context with the usual
handoff. The response, idempotency, `404`, and `409` follow the retry route.

`ask_chief` resolves an active bot whose `systemKey` is `chief_of_staff` on the same daemon.
It may open a diagnostic draft for the person to review and send; a direct send requires an
explicit request and uses the existing `send` endpoint on the bot's embedded agent. The client
preserves the destination's existing draft and model choice. A sent diagnostic has one stable new
message ID reused if the response is lost. It names the source agent and error message and includes
only authorized, user-safe diagnostic data, quoted as evidence rather than instructions or broader
permission. No new bot endpoint is introduced. Normal tool permissions remain in force;
interactive login may still need the person. Manual instructions stay available when the bot is
absent, archived, cannot authenticate, or cannot perform the repair.

**Blocks** say what is in a message:

- `text` — `{ "type": "text", "text": "..." }`
- `configuration` — the before/after execution snapshot described above, only in a service message.
- `image` — `{ "type": "image", "mimeType": "...", "data": "<base64>" }`
- `tool_call_request` — an explicit request in a user message for Agent Base to execute one
  ordinary tool before inference:

```json
{
    "type": "tool_call_request",
    "name": "load_skill",
    "arguments": {
        "name": "agent-browser",
        "arguments": "Open example.com and take a screenshot."
    }
}
```

`name` is the exact tool name. `arguments` is the optional exact JSON object supplied to it and
defaults to an empty object when omitted. This block is valid only in a user message, and one user
message carries at most one. It is a
control input, not provider-visible prose: Agent Base does not serialize the block itself to
the provider. When the message is accepted, Base generates the stable tool-call ID, records a
normal agent `tool_call` block, and executes the requested call through the same tool lookup,
argument validation, permission review, hooks, durable dispatch, result recording, restart
recovery, and public lifecycle as a model-produced call. No inference runs before that call.
After its result is recorded, inference continues with the user's ordinary text and images,
the requested call, and its result in context. An unavailable tool, invalid arguments, denied
call, or tool failure produces the ordinary failed tool result and inference still follows so
the agent can explain or recover. Clients may submit this block through `send`; it does not
bypass the selected permission mode or any tool-owned Auto policy.

- `reasoning` — `{ "type": "reasoning", "text": "..." }` — the model's thinking summary, when
  the provider surfaces one.
- `tool_call` — one tool invocation:

```json
{
    "type": "tool_call",
    "id": "tz4a98xxat96iws9zmbrgj3b",
    "name": "exec_command",
    "status": "completed",
    "arguments": { "cmd": "pnpm test" },
    "result": { "output": "42 passed" },
    "elevated": true,
    "review": {
        "outcome": "allowed",
        "reason": "The user explicitly requested the release.",
        "risk": "high",
        "userAuthorization": "high"
    },
    "presentation": {
        "type": "exec_command",
        "command": "pnpm test",
        "output": "42 passed"
    }
}
```

`id` is the CUID2 identity Happy Agent Base assigns when the invocation first starts. The same
identity is used in every live update, permission decision, tool execution, result, and durable
history projection, including for tools the provider executes on its own backend. Provider-native
call identifiers remain only in the raw provider stream and Happy Agent Base's private provider-
context storage, where they preserve native replay and server-tool call/result correlation across
restarts. Base pairs each stored native ID with its CUID2 outside provider metadata and projects
only the CUID2 through hooks, execution, modules, durable public history, and this API.
Clients treat `id` as opaque and use it only to correlate the invocation across lifecycle updates.
`status` is `"running"`, `"completed"`, or `"failed"`; `arguments` and `result` are the raw tool
data; `presentation` is defined below.

- `compaction` — one complete context-compaction lifecycle, inside a `service` message:

```json
{
    "type": "compaction",
    "trigger": "automatic",
    "status": "completed",
    "tokensBefore": 201000,
    "tokensAfter": 43000,
    "failureReason": null,
    "startedAt": 1755400000000,
    "completedAt": 1755400001200
}
```

The enclosing message's `id` is the stable compaction ID, its history group supplies the `runId`,
and the route or event envelope supplies the `agentId`; these identities are not duplicated in the
block. `trigger` is `"manual"` or `"automatic"`. Every block starts as `"running"` and changes
exactly once to `"completed"` or `"failed"`. Context replacement is provider-owned state, not
person-visible history provenance; clients must not infer compaction scope from history message
identities.

`tokensBefore` is the exact provider-measured input context when available. `tokensAfter` is
`null` until the first subsequent inference measures the replacement, and that later measurement
produces another `message.updated` for the already-completed message. `failureReason` is non-null
only for `"failed"`; clients display it but never match its text. `completedAt` is null only while
running. The enclosing service message contains exactly one compaction block and no lifecycle
text block.

A tool call that crossed the automatic-review boundary additionally carries `elevated` and
`review` as one required pair. Calls that did not require review carry neither field.
`elevated` is `true` when the reviewed call was allowed to run with temporary Full access and
`false` when it remained in the current sandbox or did not run. `review` is exactly one of:

```json
{
    "outcome": "allowed | denied",
    "reason": "Human-readable explanation.",
    "risk": "low | medium | high | critical",
    "userAuthorization": "unknown | low | medium | high"
}
```

or, when no trustworthy decision could be established:

```json
{
    "outcome": "unproven",
    "kind": "timed_out | unavailable",
    "reason": "Human-readable explanation."
}
```

The discriminated shapes are exhaustive: allowed and denied reviews always carry `risk` and
`userAuthorization`; unproven reviews always carry `kind` and never claim a risk decision.

Both the role set and the block set will grow; clients must skip roles and blocks they do not
recognize.

#### Presentation

Raw tool arguments are a poor thing to render: every tool has its own schema, and clients should
not need vendor-specific rendering logic. A supported tool call therefore carries an optional
`presentation`: a **typed** rendering of what the call did. Vendors differ in tool names and
schemas; presentations are where their display shape converges.

A presentation describes the call while it runs and absorbs the outcome when it finishes — a
running `exec_command` has its `command`, and gains its `output` on completion. A block without
a `presentation` is rendered from its raw `arguments` and `result`; a block with one can be
rendered without ever reading them, which is what makes `omitToolData` on history loads
possible.

The daemon uses the same tool-call projection for live `message.updated` events and
`GET /v0/agents/:agentId/messages`. At the same lifecycle state, the complete `tool_call` block —
including `status`, raw data, and `presentation` — is identical on both paths and remains so after
a daemon restart. `omitToolData` is applied only after this shared projection.

The daemon emits the following presentation types from these exact tool names when their
expected arguments are present:

| Presentation   | Tool calls                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `exploration`  | `Read`, `read_file`, `view_image`, `list_dir`, `Glob`, `Grep`, `grep`                                                    |
| `exec_command` | `exec_command`, `Bash`, `run_terminal_command`                                                                           |
| `file_diff`    | `Edit`, `Write`, `apply_patch`, `search_replace`, `write`                                                                |
| `search`       | `bedrock_web_search`, `claude_web_search`, `codex_web_search`, `gemini_web_search`, `grok_web_search`, `grok_x_search`   |
| `agent_spawn`  | `create_agent`                                                                                                           |
| `media`        | `codex_imagegen`, `gemini_imagegen`, `present_files`, and completed image reads by `Read`, `view_image`, `ReadMediaFile` |
| `artifact`     | `create_artifact`, `update_artifact`                                                                                     |
| `user_input`   | `request_user_input`                                                                                                     |

**`exploration`** — one normalized directory listing, file read, or code search. The daemon
currently emits one operation per mapped tool call. A read that shows an image to the person is
`exploration` only while it runs: once it completes, it carries the `media` presentation described
below instead.

```json
{
    "type": "exploration",
    "operations": [{ "kind": "read", "name": "sources/auth/login.ts" }]
}
```

Each operation is `{ "kind": "list", "target" }`, `{ "kind": "read", "name" }`, or
`{ "kind": "search", "command", "query"?, "path"? }`.

**`exec_command`** — a shell command. While running it carries only `command`; on completion it
also carries the same bounded `output` as the raw result.

```json
{ "type": "exec_command", "command": "pnpm test", "output": "42 passed" }
```

**`file_diff`** — the files and lines changed by a successful compute file-edit call. This
presentation is outcome-derived, so it is absent while the call is running and appears when the
call completes.

```json
{
    "type": "file_diff",
    "files": [
        {
            "path": "sources/auth/login.ts",
            "kind": "update",
            "added": 1,
            "deleted": 1,
            "hunks": [
                {
                    "oldStart": 12,
                    "newStart": 12,
                    "lines": [
                        { "kind": "delete", "text": "return legacyLogin(user);" },
                        { "kind": "add", "text": "return login(user);" }
                    ]
                }
            ]
        }
    ]
}
```

Each file is
`{ "path", "kind": "add" | "delete" | "update", "added", "deleted", "hunks", "language"?, "omittedLines"? }`.
`added` and `deleted` are totals for the complete file diff, including lines omitted from `hunks`.
Each hunk is `{ "oldStart", "newStart", "lines" }`; starts are one-based when that side exists
and zero for the absent side of a whole-file add or delete. Each line is
`{ "kind": "context" | "add" | "delete", "text" }`. A move is represented as a delete at its
old path and an add at its new path.

The daemon retains at most 20 files and 500 diff lines shared across all retained files. Paths and
line text are each truncated to 2,000 Unicode characters. `omittedFiles` reports files beyond the
file limit, and each file's `omittedLines` reports lines beyond the shared line limit. Empty arrays
and zero totals are valid.

**`search`** — a web or X search, carrying the normalized `query` and a `target` of `"web"` or
`"x"`.

```json
{
    "type": "search",
    "target": "web",
    "query": "thumbhash spec"
}
```

**`agent_spawn`** — creation of a sub-agent. The enclosing tool call's `status` owns the lifecycle;
this presentation does not report the child's later progress or completion.

```json
{
    "type": "agent_spawn",
    "model": {
        "modelId": "xai/grok-4.6",
        "providerId": "grok",
        "name": "Grok 4.6"
    }
}
```

`model` and `agentId` are optional. When present, `model` contains all three fields: `modelId`,
`providerId`, and `name`. The daemon supplies this identity once the creation path has resolved
and validated the exact model/provider pair, before creating the child. `name` is the selected
model's human-readable catalog name, not the task title, raw arguments, or generated prose.
Each identity field is a non-empty string of at most 256 characters. An omitted provider follows
the same resolution as execution: the creator's provider when it serves the requested model,
otherwise the unique eligible provider. Unresolved, unavailable, or ambiguous selections leave
`model` absent; clients must not guess it.

Clients may display `Spawning Grok 4.6 sub-agent` while the call is running, or `Spawning sub-agent`
when no model name is available. Completion or failure uses the enclosing tool status, never a
separate inferred lifecycle. `agentId` is the created child's CUID2 and is supplied only after
creation and initial-task delivery succeed. The resolved model identity remains unchanged on
completion, failure, history loads, and restart, even if the catalog or configuration later
changes. Live updates and history use the same call identity and durable presentation.

This presentation is additive and does not increment the protocol version. Older daemons may omit
it. To preserve unknown-presentation fallback in older clients, `agent_spawn` blocks retain their
raw `arguments` and `result` even when `omitToolData=true`; other presentations keep their existing
omission behavior. Clients never need to parse these raw fields to render a recognized spawn.

**`media`** — images, videos, documents, and other files the call showed the person inline in
the chat: an image a generation tool made, an image the agent read, or files an agent presented
with `present_files`. This presentation is outcome-derived, so it is absent while the call is
running and appears only when the call completes successfully.

```json
{
    "type": "media",
    "items": [
        {
            "kind": "image",
            "name": "tz4a98xxat96iws9zmbrgj3b.png",
            "mimeType": "image/png",
            "size": 1843200,
            "width": 1024,
            "height": 1024,
            "thumbhash": "3OcRJYB4d3h/iIeHeEh3eIhw+j3A"
        },
        { "kind": "document", "name": "report.pdf", "mimeType": "application/pdf", "size": 482113 }
    ]
}
```

`items` holds one to ten items in the order they were presented; an item's zero-based position
is its `index` in `GET /v0/agents/:agentId/tool-calls/:toolCallId/media/:index`, which serves its
bytes. Every item carries `kind`, `name` (the file's base name, at most 255 characters, for
display and downloads only), `mimeType`, and `size` in bytes. `kind` is:

- `"image"` — a picture the daemon decoded: PNG, JPEG, GIF, WebP, or AVIF. It always carries
  `width` and `height`, the positive pixel dimensions as displayed (after EXIF orientation), and
  `thumbhash`, the standard base64 encoding of a [ThumbHash](https://evanw.github.io/thumbhash/)
  placeholder of at most 128 characters. `mimeType` names the decoded format rather than the file
  extension. Clients show the ThumbHash at the given aspect ratio until the bytes load.
- `"video"` — a file with a `video/*` media type, such as MP4, WebM, QuickTime, or Ogg video.
- `"document"` — a PDF.
- `"file"` — anything else, including an image the daemon could not decode.

Videos, documents, and files currently carry no `width`, `height`, or `thumbhash`; clients must
tolerate their presence on any kind. Media types of non-images come from the file extension, and
`application/octet-stream` when it is unknown. The set of kinds may grow; a client renders an
unknown kind as a `"file"`.

Any item may carry `source`, `{ "path", "absolutePath" }`, naming the file the item came from on
the agent's machine: `path` exactly as the agent wrote it, such as `Read`'s `file_path`,
`view_image`'s or `ReadMediaFile`'s `path`, or one of `present_files`' `filepaths`, and
`absolutePath`, the file that path resolved to. A generated image's `path` and `absolutePath` are
both the absolute path the generation tool reported to the agent. Each is 1–4,096 characters. A
layout block in the agent's text names the item by either one; see "Media layouts in text". The
daemon omits `source` when a path is longer, and records made before it carry none. `source` is
additive and does not increment the protocol version.

The daemon never stores the bytes in history. It keeps a private, content-addressed copy taken
when the call ran, so later edits to or deletion of the source file never change what the chat
shows. The presentation is recorded in the conversation of the agent that ran the call only;
the parent or child conversations of that agent show nothing for it.

`layout` is optional and says how to arrange the items. Absent, the client chooses its automatic
layout, as older daemons always expect. It is one of:

- `{ "type": "columns", "columns": 1 | 2 }` — the items in that many columns, in order. Image
  generation tools use one column; image reads use two.
- `{ "type": "tree", "root": [node, …] }` — an arrangement an agent wrote for `present_files`,
  as 1–500 typed nodes. The daemon parsed and checked it; clients never receive HTML.

Each node of a tree is one of:

- `{ "type": "element", "tag", "style"?, "children": [node, …] }`, where `tag` is `div`,
  `section`, `figure`, `figcaption`, `p`, `span`, `strong`, `em`, or `code`. The first five are
  block-level and the rest inline. No tag has default margins or padding; `strong` is bold, `em`
  italic, and `code` monospace.
- `{ "type": "item", "index", "alt"?, "style"? }` — the item at that zero-based `index` of
  `items`, rendered as that item's kind would be. `alt` is at most 1,000 characters.
- `{ "type": "text", "text" }` — 1–8,000 characters of plain text, with entities already decoded
  and runs of whitespace collapsed to one space.
- `{ "type": "break" }` — a line break.

`style` is an object whose optional fields are CSS properties under their camelCase names, each a
normalized CSS value as a string, such as
`{ "display": "grid", "gridTemplateColumns": "repeat(auto-fill, minmax(200px, 1fr))", "gap": "8px" }`.
The properties and the grammar of each are a subset of CSS:

- `display`: `block`, `inline`, `inline-block`, `flex`, `inline-flex`, `grid`, `inline-grid`, or
  `none`.
- Flexbox: `flexDirection`, `flexWrap`, `flexFlow`, `flex`, `flexGrow`, `flexShrink` (factors
  0–100), `flexBasis`, and `order` (−100 to 100).
- Alignment: `justifyContent`, `alignContent`, `placeContent`, `justifyItems`, `alignItems`,
  `placeItems`, `justifySelf`, `alignSelf`, and `placeSelf`, with every CSS keyword they take,
  including `normal`, `start`, `end`, `flex-start`, `flex-end`, `self-start`, `self-end`, the
  `space-*` distributions, `stretch`, and `first`/`last baseline`.
- Gaps: `gap`, `rowGap`, and `columnGap`.
- Grid: `gridTemplateColumns` and `gridTemplateRows` (`none`, or tracks of lengths, `fr` shares,
  `auto`, `min-content`, `max-content`, `minmax()`, `fit-content()`, and
  `repeat(N | auto-fill | auto-fit, …)`, at most 24 tracks), `gridAutoColumns`, `gridAutoRows`,
  `gridAutoFlow`, `gridColumn`, `gridRow`, `gridColumnStart`, `gridColumnEnd`, `gridRowStart`,
  and `gridRowEnd` (`auto`, a line from −24 to 24 other than 0, or `span N` up to 24, with `/`
  between start and end).
- Sizing: `width`, `height`, `minWidth`, `minHeight`, `maxWidth`, and `maxHeight` (a length,
  `auto`, `min-content`, `max-content`, `fit-content`, `fit-content(length)`, and `none` for the
  maximums), `aspectRatio` (`auto`, `N`, `N / M`, or `auto` with a ratio, where the ratio of width to
  height is from 1:10 to 10:1), and `boxSizing`.
- Box: `padding`, `paddingTop`, `paddingRight`, `paddingBottom`, `paddingLeft`, `margin`,
  `marginTop`, `marginRight`, `marginBottom`, `marginLeft` (lengths, and `auto` for margins),
  `borderRadius` (one to four `px` radii up to 999), and `overflow`, `overflowX`, and `overflowY`
  (`visible`, `hidden`, or `clip`).
- Media: `objectFit` (`fill`, `contain`, `cover`, `none`, `scale-down`) and `objectPosition` (one
  or two of `left`, `center`, `right`, `top`, `bottom`, or lengths).
- Text: `verticalAlign`, `textAlign` (`left`, `right`, `center`, `justify`, `start`, `end`),
  `fontWeight` (`normal`, `bold`, `bolder`, `lighter`, or 1–1,000), `fontStyle`, `lineHeight`
  (`normal`, a number up to 10, or a length), `fontSize`, and `tone`.

A length is `0` or a non-negative number with the unit `px` (at most 4,000), `%` (at most 100),
`em`, or `rem` (at most 100). An `fr` share is above 0 and at most 100. Two fields are not CSS:
`fontSize` is one of the theme's type steps `small`, `normal`, `large`, or `title`, and `tone` is
`default`, `muted`, or `accent`, a theme text tone in place of a colour. No value names a colour,
loads a resource, uses `calc()` or `var()`, or positions anything outside the layout. Values are
lowercase, single-spaced, and written with a space after each comma and on both sides of each
slash. `@slopus/happy-agent-client` exports the grammar as `mediaLayoutStyleValue(key, value)`,
which returns the normalized value or `undefined`; a client checks every value with it and drops
any it refuses, and ignores fields it does not recognize.

An item without a `width` or `height`, or with `width: auto`, shows at its natural size: an
image's `width` and `height` divided by its `scale`. It shrinks to fit its container and never
enlarges. `width: 100%` fills the container, enlarging if needed.

The daemon guarantees that a tree nests elements at most 12 deep, holds at most 500 nodes and
8,000 characters of text and `alt` together, and places every item exactly once. A client should
still skip an item node whose index is out of range or repeated, and show any item a tree leaves
out after it.

Clients use their automatic layout for a `layout` whose `type` or `columns` they do not recognize.
In every layout, including the automatic one and `columns`, an image item without explicit sizing
is shown at most at its natural size. `layout` is additive and does not increment the protocol
version.

`present_files` is a tool every agent with a machine has, whichever model it runs. It takes
`{ "filepaths": ["…"], "layout"? }` — one to ten paths on the agent's machine, absolute or
relative to its working directory — and presents those files exactly as above. A path outside the
agent's workspace follows the ordinary permission boundary for reading files. An image may be at
most 32 MiB, a video 256 MiB, and a document or other file 64 MiB, with at most 256 MiB per call; a
directory, an empty file, or a file over its limit fails the call.

Without `layout` the presentation has no `layout`. `layout` is a fragment of HTML with inline
`style` attributes, which the daemon parses with a standards-compliant HTML parser into the
`tree` above, using the same `parseMediaLayoutHtml` clients use for layout blocks in text. A layout never fails the call. The daemon keeps what it can use and ignores the
rest, and the call's result tells the agent in a short sentence what it ignored:

- Tags: the nine element tags above, `img`, and `br`, in any letter case. An unknown tag is
  unwrapped and its content kept. A tag that embeds, loads, or runs something — such as
  `script`, `style`, `link`, `iframe`, `object`, `embed`, `svg`, `math`, `video`, `audio`,
  `canvas`, `form` and its controls, `template`, and anything in `head` — is dropped with its
  content. Comments are dropped.
- Attributes: `style` on any tag except `br`, and `src` and `alt` on `img`. Every other attribute
  is dropped. `src` must be exactly one of the call's `filepaths` and names that item; an `img`
  without `src`, with any other `src`, or naming a file already placed is dropped. With a
  non-empty `layout`, `filepaths` must not repeat a path; a repeated path fails the call.
- `style`: each declaration whose property and value fall in the subset above is kept in
  normalized form; any other declaration is dropped on its own. A `style` attribute containing a
  backslash or a quote is dropped whole, so no escape, string, or `url()` reaches a client.
  `!important`, at-rules, `position`, `z-index`, colours and backgrounds, `content`, `cursor`,
  `pointer-events`, animations, transitions, transforms, and `var()` are never kept.
- Limits: kept elements nested more than 12 deep are unwrapped. Every element of the HTML counts
  toward its nesting, whether it is kept, unwrapped, or dropped, and anything nested more than 32
  deep is dropped with its contents. Every element and text counts toward 500 nodes, and nodes
  beyond 500 or text beyond 8,000 characters are dropped. A `layout` over 32 KiB is ignored whole.
  The parser never fails, whatever the input.
- A file the layout leaves out is appended to the end of the tree, and the result says so. A
  layout that places none of the files is ignored whole and the presentation has no `layout`.

An image item may carry `scale`, a number above 1 and at most 4: the file's own pixel density
as a multiple of a CSS pixel, so its natural size is `width / scale` by `height / scale`. The
daemon sets it to `2` or `3` when the file's PNG `pHYs` chunk, JPEG JFIF header, or EXIF
resolution records 144 or 216 pixels per inch, within 2%, the same on both axes. Absent means 1.
`scale` is additive and does not increment the protocol version.

`Read`, `view_image`, and `ReadMediaFile` show every image they read to the person as well. The
call snapshots the original file, not the copy the model receives, and its completed presentation
is `media` with one image item and `{ "type": "columns", "columns": 2 }`. A read whose snapshot
fails, such as an image the chat cannot show, still succeeds for the model and keeps its
`exploration` presentation. Reads of other files are unchanged.

**`artifact`** — an artifact the call created, changed, or took up for editing, for a client to
show in the chat. This presentation is outcome-derived: it appears only when the call completes
successfully.

```json
{
    "type": "artifact",
    "artifactId": "r7k2m9q4w1e5t8y3u6i0o2p5",
    "version": 3,
    "artifactType": "html",
    "title": "Q3 revenue report",
    "shows": "latest"
}
```

`artifactId` and `artifactType` are the artifact's `id` and `type`, `version` is the artifact's
latest version when the call completed, and `title` is the artifact's title at that version.
`shows` says which version the chat shows:

- `"latest"` — the artifact as it is now, following every later version. `create_artifact`
  presents this way. An agent can later write a file artifact with
  `write_artifact_file` and `edit_artifact_file`, or change a live artifact's URL with
  `update_artifact`; this presentation follows those versions. This is where a client shows an
  HTML artifact inline, by its `display` preference.
- `"version"` — exactly `version`. `update_artifact` presents this way, as a record of the change it
  made.

Absent, as from older daemons, means `"version"`, and so does a value a client does not
recognize. The presentation needs nothing else: a client reads the artifact's live title, latest
version, and display preference through the artifact routes and keeps them current from
`artifact.updated` events. A later deletion leaves the presentation unchanged; the artifact routes
then answer `404`.

**`page`** — a legacy web page presentation, retained for history and older daemons. The
`show_page` tool was removed. New live pages use `create_artifact` with `type: "html"` and `url`,
returning an `artifact` presentation with `shows: "latest"`. Old `page` presentations remain readable.

```json
{
    "type": "page",
    "url": "http://localhost:5173/",
    "title": "Checkout preview",
    "display": "inline_expanded"
}
```

`url` is an `http` or `https` URL of at most 4,096 characters, as the agent's own machine reaches
it: `localhost` names the agent's machine, not the client's. A client shows it the way it opens a
web page for that agent, through the agent's network, and never sends it the client's own cookies
or credentials. `title` is 1–256 characters naming the page for the reader. `display` is a display
preference exactly as for artifacts (see "Display" under "Artifacts"), or `null` for the client's
choice. The legacy presentation records the URL without the daemon fetching the page. A page shown inline reaches
the network like any other page the client shows. That is a potential vulnerability, so a client
gives it the same sandbox it gives every web page.

Media, artifact, and page presentations are additive and do not increment the protocol version.
Older daemons omit them and answer the media route with `404`. As with `agent_spawn`, these blocks
retain their raw `arguments` and `result` even when `omitToolData=true`, so older clients keep
rendering these calls through their unknown-presentation fallback. Clients never need to parse
the raw fields to render a recognized media, artifact, or page presentation.

**`user_input`** — the questions an answered `request_user_input` call asked and the answers the
person gave, so the conversation keeps both where the question was asked. This presentation is
outcome-derived: it appears only when the call completes with an answer, and a cancelled, away, or
timed-out request carries none.

```json
{
    "type": "user_input",
    "questions": [
        {
            "id": "escaped-quotes",
            "header": "Escaped quotes",
            "question": "How should the fix handle \"\" inside a quoted field?",
            "multiSelect": false,
            "options": [
                { "label": "RFC 4180", "description": "Turn \"\" into one quote." },
                { "label": "Leave literal", "description": "Keep both quote characters." }
            ]
        }
    ],
    "answers": { "escaped-quotes": ["RFC 4180"] }
}
```

`questions` and `answers` take the shapes of the question object's `questions` and `answers`: a
question without options was answered in free text, and a value matching an option label is a
selection while any other value is free text. The presentation is additive and does not increment
the protocol version; like `artifact`, its block keeps its raw `arguments` and `result` even when
`omitToolData=true`.

Other calls, including background-terminal-input calls, currently carry no presentation and keep
their raw data. The presentation set may grow; a client that meets an unknown presentation type
falls back to rendering the block's raw data, exactly as if the presentation were absent.

#### Happy links

An agent's `text` blocks are Markdown. Inside them an agent mentions a Happy entity with an
ordinary Markdown inline link to a `happy://` URL, written where the entity's name belongs:

```markdown
I published [Q3 revenue](happy://artifacts/r7k2m9q4w1e5t8y3u6i0o2p5) with the full breakdown.
```

A file is linked the same way, as described under "File links". The daemon stores and returns
message text exactly as written: links are part of `text`, not a block of their own, and no route
rewrites them.

**URLs.** Every host is a plural noun, or an instance ID as described under "Instance links". The
Happy mobile app registers `happy://` for its own deep links, such as `happy://session/…` and
`happy://terminal?…`, and none of its routes uses these hosts, so the two never collide.
`happy://oauth/callback` is the sign-in redirect URI and is never a Happy link.

| Kind        | URL                                                            | Names                                                         |
| ----------- | -------------------------------------------------------------- | ------------------------------------------------------------- |
| `artifact`  | `happy://artifacts/<id>`, `happy://artifacts/<id>?version=<N>` | an artifact, or one version of it                             |
| `agent`     | `happy://agents/<id>`                                          | an agent: a task's, a bot's, a subtask, or another root agent |
| `project`   | `happy://projects/<id>`                                        | a project                                                     |
| `workspace` | `happy://workspaces/<id>`                                      | a workspace                                                   |
| `service`   | `happy://workspaces/<workspaceId>/services/<id>`               | a service in a workspace                                      |
| `surface`   | `happy://surfaces/<id>`                                        | a Surface of any type, such as a todo list, document, or chat |
| `user`      | `happy://users/<id>`                                           | a person, by their Happy user ID                              |
| `settings`  | `happy://settings/<page>`                                      | a page of the client's settings; see "Settings links"         |

**Grammar.** In ABNF, with `ALPHA` and `DIGIT` as in RFC 5234:

```text
entity-url = "happy://" ( artifact / service / other / settings )
artifact   = "artifacts/" id [ "?version=" version ]
service    = "workspaces/" id "/services/" id
other      = ( "agents/" / "projects/" / "workspaces/" / "surfaces/" / "users/" ) id
settings   = "settings/" page
id         = 1*128( ALPHA / DIGIT / "_" / "-" )
version    = %x31-39 *8DIGIT
page       = "general" / "account" / "sharing" / "servers" / "instructions" / "secrets"
           / "providers" / "providers/import" / "usage" / "voice" / "mobile-access"
           / "members" / "roles" / "policy" / "mcp" / "computes"
```

- Matching is case-sensitive: the scheme, hosts, `services/`, and `?version=` are written exactly
  as shown. A URL is at most 4,096 characters.
- `version` is a positive decimal integer without leading zeros, at most nine digits, and only an
  artifact takes it.
- Anything else under `happy://` that is not a file URL as described under "File links" is
  malformed: an unknown or singular host, a trailing `/`, any other query or fragment, or a broken
  rule above. A malformed URL is never partly interpreted.

**Instance links.** A URL above names an entity on the daemon whose conversation shows it. An
**instance link** names the installation as well, so it keeps its meaning outside Happy: in a
browser, an email, a chat, or another app. It puts the installation's health `instanceId` in front
of a Happy URL:

```text
instance-url    = "happy://" instance-id "/" happy-rest
instance-id     = %x61-7A 23( %x61-7A / DIGIT )
happy-rest      = artifact / service / other / settings / happy-form-rest
happy-form-rest = target "/files/" path [ "#" lines ]
```

`happy-rest` is exactly a Happy URL without its `happy://`: an entity URL under "Grammar" above,
or the `happy-form` of a file URL, whose `target`, `path`, and `lines` are defined under "File
links". For example:

```text
happy://k3x9q2m7p0a4b8c1d5e6f7g2/artifacts/r7k2m9q4w1e5t8y3u6i0o2p5?version=2
happy://k3x9q2m7p0a4b8c1d5e6f7g2/agents/a1b2c3d4/files/packages/app/Foo.tsx#L42-L50
happy://k3x9q2m7p0a4b8c1d5e6f7g2/workspaces/k2h4j5l6/services/web
```

- An instance ID is exactly 24 lowercase letters and digits, starting with a letter, and is
  compared exactly. It never equals a plural-noun host or `oauth`, so the host alone tells the two
  forms apart. The rest is parsed with the rules above, and anything else is malformed.
- `happy-file://` has no instance form.
- An instance link names that installation and no other. A client opens it only on the
  installation whose `instanceId` matches: the daemon it is connected to, or a remote in that
  daemon's roster whose entry carries the same `instanceId`. When no connected installation
  matches, the client shows "This link belongs to a Happy server you're not connected to." and
  opens nothing. It never falls back to another installation.
- A `happy://` URL that reaches a client from outside, such as from the operating system, a
  browser, or another app, opens only when it is an instance link. One without an instance ID is
  not opened, because it does not say which installation it means.
- Inside a conversation, a Happy URL without an instance ID keeps naming an entity of the
  installation that conversation belongs to. An instance link in a conversation follows the rule
  above.
- A client that copies or shares a link to an entity writes its instance link, using the health
  `instanceId` of the installation the entity belongs to. When that installation reports no
  `instanceId`, the client offers no shareable link.

**Server links.** A desktop shows a **server link** as a QR code so that a phone can add a team
server it isn't connected to yet. It names a server, not an entity, so it is not a Happy link:
`parseHappyUrl` and every rule above treat it as malformed, and a server link in a conversation
is inert text.

```text
server-link = "happy://" instance-id "/server?url=" encoded-url
encoded-url = 1*( ALPHA / DIGIT / "-" / "." / "_" / "~" / "!" / "*" / "'" / "(" / ")" / pct-encoded )
pct-encoded = "%" HEXDIG HEXDIG
```

- `instance-id` is the server's health `instanceId`.
- `url`, percent-decoded as UTF-8, is the server's base URL in normalized form, exactly the
  `url` of an `oauth` roster entry: `https:` only, no user information, query, or fragment, a
  lowercase host, no default port, and a path ending in `/`. Writers encode it with
  `encodeURIComponent`. An invalid escape, a URL that is not normalized, any other query
  parameter, or a fragment makes the link malformed. A server link is at most 4,096 characters
  and carries no token, code, or secret.
- A client shows a server link only for a server with an `https:` base URL that reports an
  `instanceId`.
- A phone accepts a server link only from its own QR scanner. If a connected server already
  reports the `instanceId`, the phone opens that server. Otherwise it runs discovery against
  `<url>v0/authentication` and its own OAuth sign-in, then reads `<url>v0/health` with the new
  token. It keeps the server only when that `instanceId` equals the link's, and otherwise
  discards the credential. A health response without `instanceId` cannot be verified and is
  rejected.

Server links are additive and do not increment the protocol version.

**Links.** A Happy link is a CommonMark inline link, `[label](destination)` or
`[label](<destination>)` with an optional title, whose destination uses the `happy` or
`happy-file` scheme. Its label may hold balanced brackets, code spans, and backslash escapes, and
it cannot cross a blank line. An image, `![alt](happy://…)`, is a Happy link whose label is its alt
text. A link in an inline code span or a fenced code block, or one whose `[` is backslash-escaped,
is literal text, as in Markdown.

The label of an entity link is the writer's fallback: the name the agent knows. It may be empty,
`[](happy://artifacts/…)`, which asks the client to fill in the name.

**Buttons.** A Happy link whose CommonMark title is exactly `button`, quoted with `"`, `'`, or
parentheses and with no escapes, asks the client to show it as a button instead of inline text:

```markdown
[Add your team's tokens](happy://settings/providers "button")
```

Any Happy link kind may be a button, and the link means exactly what it means without the title. A
button opens what the link names, the same as the link would; it never performs an action of its
own. Any other title, or none, shows an ordinary link. A Markdown renderer that does not know Happy
links shows an ordinary link with a tooltip, and the fallback below is the same for both displays.
A malformed or inert link that asks for a button shows its label as inert text, not a button.

**Settings links.** `happy://settings/<page>` names a page of the client's own settings, so an
agent can send a person straight to where something is set up, such as adding provider
credentials during onboarding. A settings link names no entity: it never resolves through a route,
never shows a live title or busy state, and its label is what the client shows. It must therefore
have a non-blank label. The pages are a closed list; any other page is malformed:

| Page               | Settings it opens                                     |
| ------------------ | ----------------------------------------------------- |
| `general`          | general preferences                                   |
| `account`          | the person's own account                              |
| `sharing`          | sharing, such as shared Surfaces and tasks            |
| `servers`          | the Happy servers this client is connected to         |
| `instructions`     | instructions, such as the global `AGENTS.md`          |
| `secrets`          | secrets                                               |
| `providers`        | model providers and their credentials                 |
| `providers/import` | importing provider credentials found on this computer |
| `usage`            | usage and limits                                      |
| `voice`            | voice                                                 |
| `mobile-access`    | pairing and access from phones                        |
| `members`          | the members of a team server                          |
| `roles`            | the roles of a team server                            |
| `policy`           | a team server's policy                                |
| `mcp`              | MCP servers                                           |
| `computes`         | the computers agents work on                          |

Not every client has every page; Happy Cloud, for example, has pages a local desktop does not, and
the reverse. A client that has no such page shows the link's label as inert text. Opening a
settings link only navigates within the client: it never changes a setting, starts a sign-in, or
performs any other action, as a link or as a button. An instance link to settings opens that
installation's settings page under the rule in "Instance links", and a settings link reaching the
client from outside follows that rule too.

**Resolution.** Each kind resolves through routes that already exist:

| Kind        | Resolved through                                                        | Live title                                                       | Busy while                                                                |
| ----------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `artifact`  | `GET /v0/artifacts/:artifactId`, and `…/versions/:number` for a version | `title`, or that version's `title`                               | never                                                                     |
| `agent`     | `GET /v0/agents/:agentId`                                               | the agent's `title`, or the owning bot's `name` or task's `name` | `status` is not `"idle"`                                                  |
| `workspace` | `GET /v0/workspaces/:workspaceId`                                       | `name`                                                           | `initialization.status` is `"initializing"`, or `status` is `"archiving"` |
| `project`   | `GET /v0/projects/:projectId`                                           | `name`                                                           | `initialization.status` is `"initializing"`                               |
| `surface`   | `GET /v0/surfaces`, the instance whose `id` matches                     | `name`, following `surface.updated`                              | never                                                                     |
| `user`      | `GET /v0/users?ids=…`                                                   | `name`, following `profile.updated`                              | never                                                                     |

A Surface has no route of its own, so it resolves from the catalog, and it is unresolvable when
the catalog has no instance with its `id`. A `user` is unresolvable in standalone mode, where
`GET /v0/users` resolves only guests, and for an unknown ID. Services are specified, but no client
resolves them yet.

**Rendering.** A client that renders Happy links shows an entity link as a link whose text is the
entity's live title and which opens the entity in the client. The title follows the entity's
update events, so a rename shows without reloading the message. Until the title resolves, and
whenever it cannot, the client shows the label as written, or, when the label is empty, an inert
placeholder such as "an unavailable artifact". While the entity is busy as defined above, the
client SHOULD show its usual progress treatment on the link. An entity link is inert, shown as
non-interactive text, when:

- the entity does not exist or cannot be resolved;
- the caller cannot see it;
- an artifact is deleted, a project, workspace, or agent is archived, or the named artifact
  version does not exist.

A malformed Happy link shows its label as inert text. A client never shows the bare URL or ID in
place of a link, and never hands a `happy://` or `happy-file://` URL to the operating system or a
browser.

**Streaming.** While a text block is still growing through `message.delta`, its end may be a Happy
link that is not complete yet. Once its label's `]` has arrived, a client hides the link from its
`[` (or `![`) for as long as the destination so far could still become a `happy:` or `happy-file:`
URL, such as `[Q3]`, `[Q3](`, `[Q3](hap`, or `[Q3](happy://artifacts/r7k2`. The tail is shown once
the link completes, or once the text proves it is not a Happy link. A tail longer than 5,120
characters is never hidden, and the tail is never hidden inside code. Once the message is final,
an incomplete link is ordinary text.

**Fallback.** A surface that cannot render Happy links gets plain Markdown in which each Happy
link is replaced. An entity link becomes the entity's live title when the surface can resolve it,
escaped as literal text; otherwise its label as written; otherwise the inert placeholder. A file
link becomes what "File links" describes. A settings link becomes its label, or "Settings" when the
label is blank. A malformed link becomes its label, or nothing when the label is blank. The
daemon applies this fallback to text it relays to integrations that cannot
render links, including the Happy mobile app.

**Legacy reference tags.** Before Happy links, agents mentioned entities with reference tags such
as `<happy-artifact id="…" version="2"/>`, and stored history still holds them. Nothing emits them
any more. Clients and the daemon read them as entity links with an empty label, so old messages
render as before:

```text
tag        = "<happy-" kind 1*(1*ws attribute) *ws "/>"
kind       = lower *(lower / DIGIT) *("-" 1*(lower / DIGIT))
attribute  = name "=" DQUOTE value DQUOTE
name       = lower *(lower / DIGIT / "-")
value      = *256(%x00-09 / %x0B-0C / %x0E-21 / %x23-3B / %x3D / %x3F-10FFFF)
             ; any character but DQUOTE, "<", ">", CR, and LF
ws         = SP / HTAB
lower      = %x61-7A
```

- A tag is at most 512 characters and never spans lines. Values are taken literally.
- `id` is required and has the form of `id` above. `version`, when present, has the form of
  `version` above and applies only to an `artifact`. `workspace`, when present, has the form of
  `id` and names a `service`'s workspace. Other attributes are ignored.
- A repeated attribute, or a missing or malformed `id`, `version`, or `workspace`, makes the text
  not a tag. A tag of an unknown kind, or a `service` tag without `workspace`, is an unresolvable
  reference; its placeholder is "an unavailable reference" or "an unavailable service".
- A tag is never Markdown HTML. A tag in code, or whose `<` is backslash-escaped, stays literal.
  While text streams, a trailing partial tag, anything from a lone `<` to `<happy-artifact id="r7k2`,
  is hidden like a partial link.

**One implementation.** `@slopus/happy-agent-client` exports the grammar, parsers, formatters,
streaming rule, legacy tag reader, and fallback, for entity and file links alike:

```ts
type HappyReference = {
    kind: "artifact" | "agent" | "workspace" | "project" | "service" | "surface" | "user";
    id: string;
    version?: number; // artifacts only
    workspaceId?: string; // services only
};
type HappySettingsPage = (typeof HAPPY_SETTINGS_PAGES)[number]; // "providers", "providers/import", …
type HappyLink = (
    | { type: "reference"; reference: HappyReference }
    | { type: "file"; file: HappyFileLink } // see "File links"
    | { type: "settings"; page: HappySettingsPage } // see "Settings links"
) & { instanceId?: string }; // present only for an instance link
type HappyLinkMatch = {
    link: HappyLink | undefined; // undefined when malformed
    label: string; // the Markdown between the brackets; empty for a legacy tag
    image: boolean;
    source: string; // exactly as written
    syntax: "link" | "legacyTag";
    display: "link" | "button"; // "button" only for a link titled exactly `button`
};

parseHappyUrl(url: string): HappyLink | undefined; // happy://, instance links, happy-file://
isHappyUrl(url: string): boolean; // happy: or happy-file:, any case, well-formed or not
formatHappyUrl(link: HappyLink): string; // an instance link when link.instanceId is set
formatHappyReferenceUrl(reference: HappyReference): string;
formatHappyMarkdownLink(link: HappyLink, label?: string): string; // "[label](happy://…)"
parseHappyLinks(markdown: string, options?: { streaming?: boolean }):
    ({ type: "text"; text: string } | ({ type: "link" } & HappyLinkMatch))[];
replaceHappyLinks(markdown: string, replace: (match: HappyLinkMatch) => string,
    options?: { streaming?: boolean }): string;
happyLinkPartialLength(markdown: string): number;
renderHappyLinksAsText(markdown: string, resolve?: (reference: HappyReference) => string | undefined,
    options?: { streaming?: boolean }): string;
rewriteLegacyHappyReferenceTags(markdown: string, options?: { streaming?: boolean }): string;
happyReferencePlaceholder(reference: HappyReference): string; // "an unavailable artifact"
```

`HAPPY_REFERENCE_KINDS` lists the entity kinds and `HAPPY_SETTINGS_PAGES` the settings pages.
Clients and the daemon use these rather than their own parsers, so every surface agrees on
exactly what a link names.

Happy links are additive and do not increment the protocol version. Request and response schemas
are unchanged. A client that does not know them shows them as Markdown links with an unknown
scheme.

#### Media layouts in text

An agent may arrange media it already showed in the conversation by writing plain HTML in its
Markdown reply, without another tool call:

```markdown
Side by side:

<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px">
  <img src="shots/before.png">
  <img src="shots/after.png">
</div>
```

The HTML is layout only, in the subset `present_files`' `layout` takes: the same tags, attributes,
`style` grammar, and limits. The daemon stores and returns message text exactly as written; no
route rewrites it, and the HTML never reaches a renderer as HTML.

**Blocks.** A layout block starts at the start of a line indented at most three spaces, outside a
fenced code block and outside a code span, with a start tag `<div`, `<section`, `<figure`, `<p`,
or `<img` in any letter case, followed by whitespace, `>`, `/`, or the end of the line. It may
interrupt a paragraph. It runs until its root element closes: only start and end tags of the root's
own name count, comments and quoted attribute values are skipped, and an `img` root ends with its
own tag. The block then takes the rest of the line its root closes on. Unlike a CommonMark HTML
block, a blank line never ends it. A block holding no `<img` start tag is ordinary Markdown. A
block whose root never closes, or that ends inside a tag or comment, runs to the end of the text
and is incomplete. A last line without a newline that is only the start of such a tag, such as `<`,
`<di`, or `<fig`, is incomplete as well.

**Resolution.** Each `<img src>` names an earlier media item of the same conversation: the most
recent item, in any earlier `media` presentation, whose `source.path` or `source.absolutePath`
equals `src` exactly. An item without `source` is never named, and a `src` naming nothing is
dropped. A client never loads `src` from disk or the network; it shows only the item's snapshot
through its media route. Each item is placed at most once per block.

**Rendering.** A client that renders layout blocks parses each complete block into the `tree` of
a `media` presentation, whose item indexes refer to the items its `src`s resolved to, and shows it
as it shows a `tree` layout. A block is shown as a layout only when at least one `img` resolves and
no content was lost to a limit; otherwise it is shown as the Markdown it is, so nothing the agent
wrote is ever hidden. While text streams, a client holds an incomplete last block rather than
showing its HTML, and once the message is final, it shows an incomplete block as Markdown.

**Fallback.** A surface that cannot show layout blocks drops each complete block, closing up the
blank lines around it, and keeps an incomplete one as written. The daemon applies this to the
text it relays to exported bots, which receive the media the run showed as attachments instead,
and to the agent text it relays to the Happy mobile app, leaving out a text that was only layout.

**One implementation.** `@slopus/happy-agent-client` exports the block splitter, parser, matcher,
and fallback:

```ts
splitMediaLayoutBlocks(markdown: string):
    ({ type: "markdown"; text: string } | { type: "layout"; html: string; complete: boolean })[];
parseMediaLayoutHtml(html: string, resolve: (src: string) => number | undefined): {
    root: MediaLayoutNode[]; // each item node's index is what resolve returned
    placed: number[];        // the indexes placed, in order, each once
    ignored: string[];       // short notes on what was left out
    truncated: boolean;      // content was lost to a limit
};
mediaSourceMatches(source: MediaItemSource | undefined, src: string): boolean;
stripMediaLayoutBlocks(markdown: string): string;
```

The segments' text joined in order is the input, and an incomplete `layout` segment is always the
last. `MAX_MEDIA_LAYOUT_HTML_LENGTH` is the 32 KiB bound. Clients and the daemon use these rather
than their own parsers, so every surface agrees on exactly what a block shows.

Media layouts in text are additive and do not increment the protocol version. Request and response
schemas are unchanged apart from the optional `source`. A client that does not render them shows
the HTML as its Markdown renderer does.

#### File links

A bare `path:line` is read against the workspace of the conversation that shows it. That is the
wrong workspace whenever the text is read somewhere else: a subtask's report relayed by its
parent, or a message from an agent that works in another folder. A **file link** names the
workspace explicitly. It is a Happy link, an ordinary Markdown inline link, whose destination is a
file URL in one of two equally valid forms:

```markdown
The loop starts in [Foo.tsx:42](happy://agents/a1b2c3d4/files/packages/app/Foo.tsx#L42-L50).
The setup steps are in [README](happy-file://workspaces/k2h4j5l6/README.md).
```

The `happy://…/files/…` form is the one agents write in Markdown, alongside entity links. The
`happy-file://` form, which puts the path straight after the target, is the API's canonical file
URL. Readers accept both everywhere, and both name the same file. The label is ordinary Markdown
that the agent writes, and the daemon stores and returns message text exactly as written. An agent
keeps writing plain `path:line` for a file in the reader's own workspace.

**Grammar.** In ABNF, with `ALPHA`, `DIGIT`, and `HEXDIG` as in RFC 5234:

```text
file-url    = happy-form / file-form
happy-form  = "happy://" target "/files/" path [ "#" lines ]
file-form   = "happy-file://" target "/" path [ "#" lines ]
target      = "agents/" id / "workspaces/" id
id          = 1*128( ALPHA / DIGIT / "_" / "-" )
path        = segment *( "/" segment )
segment     = 1*( unreserved / pct-encoded / "!" / "$" / "&" / "'" / "*" / "+" / "," / ";" /
                  "=" / ":" / "@" )
unreserved  = ALPHA / DIGIT / "-" / "." / "_" / "~"
pct-encoded = "%" HEXDIG HEXDIG
lines       = "L" line [ "-L" line ]
line        = %x31-39 *8DIGIT
```

- A URL is at most 4,096 characters.
- Matching is case-sensitive. `happy://`, `happy-file://`, `agents/`, `workspaces/`, `/files/`,
  and `L` are written exactly as shown. Only the hex digits of `pct-encoded` may be either case.
- `agents/<id>` names an agent, and the file lives in that agent's workspace, its `workspaceId`.
  `workspaces/<id>` names a workspace directly. A project's files are linked through its root
  workspace's ID, as under "Files".
- `path` is relative to that workspace's root. Each segment is percent-decoded on its own, and
  its bytes must be valid UTF-8. A decoded segment must not be `.` or `..` and must not contain
  `/`, `\`, or a control character (U+0000–U+001F or U+007F–U+009F). An encoded `%2F` is never a
  separator. There is no leading or trailing `/` and no empty segment.
- Every character outside the grammar is percent-encoded as UTF-8: spaces, parentheses, `?`, `#`,
  `[`, `]`, a `%` that does not start an escape, and every non-ASCII character. Literal
  parentheses are excluded so a link never needs Markdown escaping.
- `#L12` selects line 12 and `#L12-L20` lines 12 through 20. Lines count from 1, a line number has
  no leading zeros and at most nine digits, and the end is never before the start. `#L12-L12`
  equals `#L12`.
- Anything else makes the link malformed: a query, an empty or other fragment, a missing path, an
  invalid escape, or a broken rule above. A malformed link is never partly interpreted. It is
  unresolvable as a whole.
- The canonical form percent-encodes every byte of a segment except `unreserved`, writes
  uppercase hex digits, and writes a single line as `#L12`. Readers accept every well-formed link,
  canonical or not.

A file link inside an inline code span or a fenced code block is literal text, as in Markdown.

**Resolution.** A file link resolves through routes that already exist:

1. For `agents/<agentId>`, `GET /v0/agents/:agentId` gives the agent's `workspaceId`. An unknown
   agent, or one whose `archivedAt` is not `null`, makes the link unresolvable.
2. `GET /v0/workspaces/:workspaceId` must answer with a workspace whose `status` is `"active"`.
   An unknown workspace, or one that is archiving or archived, makes the link unresolvable.
3. `GET /v0/workspaces/:workspaceId/file` with the decoded `path` reads the file. Any answer other
   than `200`, such as a missing file or a path escaping the root, makes the link unresolvable.

A link is resolved only when it is opened. A client does not have to check every link it renders.

**Rendering.** A client that renders file links shows each one as an ordinary Markdown link with
the agent's label. Opening it shows the file read-only, from the linked workspace, inside the
reader's own conversation. The reader does not move to the other agent or workspace. When `lines`
is present, the client shows those lines and SHOULD highlight them. A range past the end of the
file shows the file without a selection. When a link is malformed or unresolvable, the client
shows its usual "could not open" treatment. A client never hands a file URL to the operating
system or a browser.

**Fallback.** A surface that cannot open file links gets plain Markdown in which each inline link
whose destination starts with `happy:` or `happy-file:`, in any letter case and whether or not it
is well-formed, is replaced as "Happy links" describes. A file link becomes its label, kept as the
Markdown written between the brackets. An image, `![alt](happy-file://…)`, becomes its alt text
the same way. When the label is empty or blank, the link becomes its decoded path, escaped as
literal text, or nothing when the link is malformed.

**One implementation.** `@slopus/happy-agent-client` exports the file grammar with the rest of
the Happy links: `HAPPY_URL_SCHEME`, `HAPPY_FILE_URL_SCHEME`, `MAX_HAPPY_URL_LENGTH`,
`happyFileLinkSchema` with its `HappyFileLink` type, `parseHappyUrl`, and `formatHappyFileUrl`.
A parsed link has this shape, with `path` decoded:

```ts
{
    target: { type: "agent"; agentId: string } | { type: "workspace"; workspaceId: string };
    path: string; // "packages/app/Foo.tsx"
    lines?: { start: number; end: number }; // #L42 is { start: 42, end: 42 }
}
```

`formatHappyFileUrl(file, scheme?)` writes the `happy://` form by default and the `happy-file://`
form when `scheme` is `"happy-file"`. Clients and the daemon use these rather than their own
parsers, so every surface agrees on exactly what a file link names.

File links are additive and do not increment the protocol version. Request and response schemas
are unchanged.

### `POST /v0/agents/:agentId/send`

Sends a message. One endpoint covers both queuing and steering; `delivery` says which.

Request:

```json
{
    "id": "tz4a98xxat96iws9zmbrgj3a",
    "text": "Fix the login redirect loop",
    "clientMetadata": {
        "composer": "mobile",
        "localDraft": { "revision": 4 }
    },
    "content": [
        { "type": "text", "text": "Here is the screenshot:" },
        { "type": "image", "mimeType": "image/png", "data": "<base64>" },
        {
            "type": "tool_call_request",
            "name": "load_skill",
            "arguments": {
                "name": "agent-browser",
                "arguments": "Fix the login redirect loop shown here."
            }
        }
    ],
    "delivery": "queue",
    "profile": null,
    "mode": {
        "providerId": "codex",
        "modelId": "openai/gpt-5.6-sol",
        "effort": "medium",
        "serviceTier": null,
        "permissionMode": "auto"
    }
}
```

- `id` — optional client-chosen message ID, a CUID2 or any other string matching
  `^[a-z][a-z0-9]+$` of 2–96 characters, as described under Identifiers; a UUID is
  `400 invalid_request`. The daemon creates the message under
  exactly this identity, so the optimistic copy the client rendered at send and the durable
  message are **the same message** — in this response, in every event, and in every history
  load. No reconciliation or echo-matching is needed, and no path can strand a stale
  optimistic copy: whichever way the authoritative message arrives, it carries the ID the
  client already keys by. Omitted, the daemon generates one. Sending again with an `id` the
  agent already has creates nothing and returns the message as it now stands, which makes
  retrying a send whose response was lost safe.
- `text` — the message text. Required, 1–1,000,000 characters. In team mode, when a member sends
  it to a task's agent, the members it links as `happy://users/<userId>` join the task (see Tasks,
  "Mentioning from a message").
- `clientMetadata` — optional freeform JSON object owned by the sending client. It is persisted
  and echoed unchanged on every complete representation of this message, but is not interpreted
  by the daemon or sent to the model.
- `quickReply` — retired compatibility field, accepted and ignored. It is not validated, stored
  as provenance on new messages, or treated as authority.
- `deviceId` — optional, matching `^[A-Za-z0-9._:-]{1,64}$`: the sending device, as reported to
  `PUT /v0/environment`. Kept with the message's internal metadata and used only to choose which
  environment the agent is told; it is not part of the public `metadata` object. An ID the person
  has not reported from is accepted and treated as no device. Send it only to a daemon that
  supports user environments, as described under Versioning.
- `content` — optional rich blocks accompanying the text: text, inline images, and at most one
  `tool_call_request`. Image bytes travel **inline**, base64 in the block, exactly as they later
  appear in history — there is no separate upload step or attachment store. A tool-call request
  is retained on the pending and accepted user message, but Base executes it only after
  acceptance at the same safe boundary where that message would otherwise reach inference.
- `delivery` — optional, default `"queue"`. `"queue"` waits behind the current run; `"steer"`
  takes priority at the next inference boundary. The current assistant response and its complete
  tool-call batch finish without interruption, then pending steering messages are accepted before
  the next inference request. On an idle agent the two are identical: a run starts.
- `profile` — optional `null` or opaque string of at most 512 characters; omitted means `null`.
  The internal request-profile codec decides which strings are active and currently accepts only
  `null`. A string that does not decode — including a profile that a later feature removed — is
  converted to `null` on the fly. It does not reject the send, prevent a queued message or settings
  record from being restored, or make durable history unreadable. Only the decoded profile is
  stored for new messages and returned publicly.

    The effective profile starts as `null`. When inference accepts this message, the daemon compares
    its decoded profile with the decoded profile of the most recently accepted request. A different
    value resets the model's private conversation context at that safe boundary exactly like an
    incompatible model switch: the old provider session is destroyed, compactable Agent Base history
    and history-scoped state are cleared atomically, and the new request starts a fresh context. The
    durable person-visible history remains available, and the existing model-switch module uses its
    existing `modelChanged` hook to give the fresh model a bounded handoff from that archive so
    completed work is not silently repeated or undone. No new reset hook or module surface is
    introduced. An unchanged profile keeps the context. A simultaneous incompatible model change
    and profile change perform one reset. The profile is control data and is never sent to the
    provider or model.

- `mode` — required: the model selection and permission mode this message runs with. It has
  five required fields: `providerId` (1–128 characters), `modelId` (1–512), `effort` (1–64),
  `serviceTier` (`null` or 1–64 characters), and `permissionMode` (`"read_only"`,
  `"workspace_write"`, `"auto"`, or `"full_access"`). The output-only `account` and
  `providerType` of an echoed execution snapshot are accepted and discarded; any other field is
  `400 invalid_request`. The selection is then checked against the live model catalog: the
  provider must offer the model as enabled, `effort` must be one of the model's `efforts`, and a
  non-null `serviceTier` must be one of its `serviceTiers`. Any failure is `400 invalid_request`.

The request body accepts only the fields above; an unknown field is `400 invalid_request`.

### `GET /v0/agents/:agentId/messages`

Loads conversation history, **grouped by run**. A page always contains whole runs — paging
never splits a run — with one exception: the newest run may still be unfinished, and its
messages so far are returned with a cursor to load what comes after.

Query parameters:

- `before` — a run ID; return runs older than it. This is how a client pages back from the
  present.
- `after` — a message ID; return the messages that came after it. This is how a client extends
  the unfinished newest run (and picks up any runs that started since). `before` and `after`
  together are `400`.
- `limit` — optional, default 50, counted in messages. It is a **lower bound, not an upper
  bound**: once the page holds `limit` messages, no further run is started, but the run in
  progress is always returned whole. A page can therefore overflow well past `limit` — a single
  run with hundreds of tool calls comes back in one piece regardless. Clients must size their
  buffers for the runs they receive, not for the limit they asked for.
- `omitToolData` — optional, default `false`. When `true`, tool-call blocks that carry a
  `presentation` come back without `arguments` and `result` — the client renders the
  presentation, and the page stays small even when runs carried large tool output. Blocks
  without a `presentation` keep their raw data regardless, since there would be nothing else to
  render. `agent_spawn`, `media`, `artifact`, and `user_input` presentations also keep their raw
  data so older clients can render these additive variants through their unknown-presentation
  fallback.

With no cursor, the newest runs are returned.

Response — `200`:

```json
{
    "runs": [
        {
            "id": "tz4a98xxat96iws9zmbrgj3a",
            "status": "running",
            "reason": null,
            "startedAt": 1755400000000,
            "endedAt": null,
            "usage": {},
            "costUsd": null,
            "messages": [
                {
                    "id": "tz4a98xxat96iws9zmbrgj3a",
                    "role": "user",
                    "createdAt": 1755400000000,
                    "content": [{ "type": "text", "text": "Fix the login redirect loop" }],
                    "metadata": {},
                    "clientMetadata": {
                        "composer": "mobile",
                        "localDraft": { "revision": 4 }
                    },
                    "profile": null,
                    "mode": {
                        "providerId": "codex",
                        "modelId": "openai/gpt-5.6-sol",
                        "effort": "medium",
                        "serviceTier": null,
                        "permissionMode": "auto"
                    }
                },
                {
                    "id": "pfh0haxfpzowht3oi213cqos",
                    "role": "agent",
                    "createdAt": 1755400002000,
                    "metadata": {
                        "providerId": "claude",
                        "modelId": "anthropic/sonnet-5"
                    },
                    "content": [
                        {
                            "type": "reasoning",
                            "text": "The redirect loop suggests the session cookie..."
                        },
                        {
                            "type": "tool_call",
                            "id": "call-12",
                            "name": "Bash",
                            "arguments": { "command": "grep -rn redirect sources/auth" },
                            "status": "completed",
                            "result": { "output": "..." },
                            "presentation": {
                                "type": "exec_command",
                                "command": "grep -rn redirect sources/auth",
                                "output": "..."
                            }
                        },
                        { "type": "text", "text": "Found it — the callback URL rewrites..." }
                    ]
                }
            ]
        }
    ],
    "hasMore": true,
    "cursor": "01991f3a-6d2f-7000-8000-3a0b2c4d5e6f"
}
```

Runs are returned oldest first, and messages oldest first within each run. A history run is the
run metadata above plus `messages`, oldest first. Its `id` is the `runId` assigned at message
acceptance. `cursor` is the event cursor captured **before** the history read. A client follows the
global event stream from this cursor after installing the page. A mutation concurrent with the
read may therefore appear in both the page and the replay, but it cannot fall between them; stable
message identities and delta offsets make the duplicate harmless.

Every provider inference that produces agent content creates a new durable `agent` message inside
the active run. Streaming deltas grow only that inference's message. Tool results and permission
reviews update the same message as their matching tool call; a later inference never appends to an
earlier inference's message. Service messages created between inferences, including automatic
compaction, therefore retain their exact chronological position after reconnect.

Pending queue and steering messages are deliberately absent here: they are current composer state,
not pageable accepted history. The agent bootstrap endpoint returns their complete oldest-first
snapshot. When one is accepted it appears in its run, announced atomically by `run.started` or
`run.boundary` with its assigned `runId`.

### `GET /v0/agents/:agentId/tool-calls/:toolCallId/media/:index`

The bytes of one item of a completed tool call's `media` presentation. `toolCallId` is the
tool-call block's `id`, and `index` is the item's zero-based position in `items`, written in
decimal without leading zeros. The daemon serves the private copy it took when the call ran, so
the response never changes for the same URL.

The response is the file itself, not JSON: `Content-Type` is the item's `mimeType`, with
`; charset=utf-8` added for `text/*` types, and `Content-Length` its size. `ETag` is a quoted
content digest, and a matching `If-None-Match` answers `304`. Because the content of a URL never
changes, successful and `304` responses carry
`Cache-Control: private, max-age=31536000, immutable` and `Vary: Authorization`, for images and
every other kind alike. `Content-Disposition: inline` carries the item's `name` as the file name.
Every response carries `X-Content-Type-Options: nosniff` and the same sandboxing
`Content-Security-Policy` as artifact files, so a presented HTML or SVG file cannot act with the
daemon's origin.

`Accept-Ranges: bytes` advertises ranges, so a video player can stream and seek. A single
`Range: bytes=start-end`, `bytes=start-`, or `bytes=-suffix` answers `206` with `Content-Range`; a
range outside the file answers `416` with `code: "range_not_satisfiable"` and
`Content-Range: bytes */size`. Multiple ranges are ignored and answer the whole file with `200`.

`404` when the agent, the tool call, or the item does not exist, when the call has no `media`
presentation, or when the daemon no longer holds the copy. Errors are JSON and
`Cache-Control: no-store` as everywhere else. The route takes the bearer token like every route,
including through `/v0/connections/:id/api/*`. A client that renders media through an element
rather than `fetch` points it at this URL through a transport that adds the token, as with
artifact files.

### `GET /v0/agents/:agentId/messages/:messageId/story-frame`

The still frame a user message's story `quote` shows, served exactly as a tool call's media item, including its
immutable caching. An image story's frame is its image; a video story's is a still of its first
frame, taken when the agent posted it. The frame outlives the story. `404` when the agent or
message does not exist, or the message's `quote.frame` is `null`.

### Questions

Sometimes a run cannot proceed without the person: the agent asks a clarifying question, or an
action needs a one-time approval. That surfaces as a **question** — a resource on the agent
that any connected client can render and any one client can answer. An agent has at most one
open question at a time; while it is open the run is paused waiting on it, and the agent
object's `pendingQuestionId` carries its ID (with the `agent.updated` event announcing it), so
a list view can badge "waiting on you" without fetching anything.

The question object:

```json
{
    "id": "q7m2p9r4t1v6x8z3b5n0c2d4",
    "agentId": "a1b2c3d4",
    "runId": "tz4a98xxat96iws9zmbrgj3a",
    "status": "pending",
    "context": "The new billing service needs persistent storage. It runs on one node for now.",
    "questions": [
        {
            "id": "q7m2p9r4t1v6x8z3b5n0c2d4",
            "header": "Database",
            "question": "Which database should the new service use?",
            "multiSelect": false,
            "options": [
                { "label": "PostgreSQL", "description": "Matches the rest of the stack." },
                { "label": "SQLite", "description": "Zero-ops, fine for a single node." }
            ]
        }
    ],
    "autoResolveAt": null,
    "answers": null,
    "version": "01991f3a-6050-7000-8000-7e4f60819203",
    "createdAt": 1755400000000,
    "answeredAt": null
}
```

- `id` — stable question identifier (CUID2).
- `agentId`, `runId` — whose run is waiting.
- `status` — `"pending"`, `"answered"`, or `"canceled"`. Canceled means the run stopped
  needing the answer: it was aborted, or the question timed out into its default.
- `context` — the shared Markdown background the agent wrote once for all of its prompts,
  1–100,000 characters. Clients show it alongside the prompts. Older daemons omit it.
- `questions` — one or more prompts, answered together. Each has its own `id`, a short
  `header`, the `question` text, `options` the person picks from (possibly empty — then the
  answer is free text), and `multiSelect`. A prompt may also carry `secretRequest`, described
  below.
- `permissionRequest` — present only when something outside the agent asks the person for
  permission or input, described below. Absent on every other question.
- `autoResolveAt` — when set, the moment the agent proceeds on its own without an answer;
  `null` means it waits indefinitely.
- `answers` — `null` while pending; once answered, a map from question `id` to the chosen
  values, so every **other** client watching learns what was picked from the same object.
- `createdAt`, `answeredAt` — lifecycle timestamps.

#### Secret requests

When an agent needs a credential, it asks for a secret instead of asking for its values. The
question then has exactly one prompt, and that prompt carries `secretRequest`:

```json
{
    "id": "secret",
    "header": "Secret",
    "question": "The deploy step needs the staging API token. Create it under **Settings → API tokens** in the staging dashboard.",
    "multiSelect": false,
    "options": [],
    "secretRequest": {
        "suggestedId": "deploy-api",
        "description": "Staging deployment API credentials",
        "environmentVariables": [
            { "name": "DEPLOY_API_TOKEN", "description": "Token with the deploy scope" },
            { "name": "DEPLOY_ORGANIZATION", "description": null }
        ]
    }
}
```

- `question` — Markdown from the agent explaining why it needs the secret and where the person
  can find the values.
- `secretRequest.suggestedId` — a secret name the agent suggests, following the secret-name syntax
  under Secrets, or `null` when the agent has no preference. It is a suggestion only: the name may
  already be taken, and the person may choose another.
- `secretRequest.description` — a suggested secret description, 1–2,000 characters.
- `secretRequest.environmentVariables` — the 1–64 variables the agent needs, in the agent's order.
  Each `name` follows the variable-name syntax under Secrets and is case-insensitively unique;
  `description` is a hint of at most 2,000 characters for what the value is or where to find it, or
  `null`.

`secretRequest` is absent on every other prompt. A client renders a secret request as a form
prefilled from these fields, so the person only types the values, and creates the secret through
`POST /v0/secrets`. The client may instead let the person pick an existing secret from the catalog.
Either way it then answers the question with that secret's ID, never with a value.

#### Permission requests

Most questions come from the agent. A permission request comes from something outside it, such as
an MCP server asking the person to approve an action. The agent cannot answer it on the person's
behalf. The answer goes to whatever asked, and the agent sees only what that party reports back.
The question then carries `permissionRequest`:

```json
{
    "source": "mcp_elicitation",
    "server": "bambu_printer",
    "serverTitle": "Bambu Printer"
}
```

- `source` — what is asking. `"mcp_elicitation"` means an MCP server sent an elicitation during one
  of the agent's tool calls. `"harness"` means the permission system of the foreign harness the
  agent runs on, such as Claude Code or Codex CLI, asks before an action its permission mode does
  not allow on its own; the action is in the question's context. A client that does not recognize a
  source shows the question as a permission request without naming what is asking.
- `server` — the configured MCP server name, or the harness ID for `"harness"`, 1–128 characters.
- `serverTitle` — the server's or harness's display name, 1–128 characters, which clients show
  instead of `server`.

A client should present a permission request so the person can tell it apart from the agent's own
questions, naming `serverTitle` as the party asking. The prompts, options, and answer route are the
same as for any other question.

#### `GET /v0/agents/:agentId/question`

The open question, or `{ "question": null }` when nothing is pending. Answered and canceled
questions are not browsable — their outcome lives in the transcript.

#### `POST /v0/agents/:agentId/question/:questionId/answer`

Request:

```json
{
    "answers": {
        "q7m2p9r4t1v6x8z3b5n0c2d4": ["PostgreSQL"]
    },
    "mutationId": "..."
}
```

`answers` maps each question `id` to the person's values. A value matching one of the
question's option labels is a selection; any other string is free text the person typed —
both may appear together. Every question in the batch must receive at least one value.

Response — `200`: `{ "question": { ... } }` with `status` `"answered"`, and the run resumes.
Answering is first-write-wins across clients: a second answer — or an answer to a question the
run already abandoned — is `409` (`conflict`) carrying the question as it now stands, and the
late client renders the outcome instead. `404` when the ID never existed.

A secret request accepts exactly one value: the ID of an existing secret whose `availableToAgents`
is `true`. Anything else is `400` (`invalid_request`) and the question stays pending, so the client
may correct the answer and retry. Because a person using an older client may have typed a raw value
into what looked like a free-text question, the rejected text is never stored, logged, or included
in the error body. The secret need not contain every requested variable; the agent is told which
are missing. An accepted answer attaches the secret to the agent that asked, as an exact-agent
grant, in the same atomic change that answers the question. The answer's `answers` map, its
events, and the transcript contain only the secret ID.

Questions have their own events (`question.created`, `question.updated`) so watching clients
show and clear the prompt in real time; aborting the run cancels an open question.

### `POST /v0/agents/:agentId/abort`

Stops the current run, every current descendant run, and every background process owned by the
target or those descendants.

Request:

```json
{ "expectedRunId": "tz4a98xxat96iws9zmbrgj3a" }
```

- `expectedRunId` — optional guard: abort only if this run is still the one running. A
  different active run is `409`, so a client cannot race a newer message and kill the wrong
  work.

Response — `202`: `{ "agent": { ... }, "profiles": [ ... ], "slashCommands": [ ... ], "cursor": "..." }`. The abort is accepted. Each affected
run winds down with terminal status `"aborted"` and reason `"abort"`. For each affected agent
that owns a running background process, Compute first commits a one-shot notice to that agent's
scope in Compute's shared Agent KV saying what the abort killed. Process state and
`process.exited` events then move immediately, and every affected process tree receives an
immediate hard kill without a graceful shutdown period. Compute prepends the one-shot notice to
that agent's next model inference through its instructions hook and consumes it there; it is not
added to public history and does not queue a new conversation message.

Aborting an idle agent still kills and records a notice for its background processes, as well as
aborting any active descendant runs and their processes. It is a no-op only when the complete
subtree has no active run and no running background process.

### `POST /v0/agents/:agentId/compact`

Compacts the conversation context: the daemon summarizes older history so the next run fits the
model's window. It does not erase the person-visible transcript. Instead, every manual and
automatic attempt is one durable `service` message containing exactly one typed `compaction`
block. The message is created as `"running"` before provider work starts and updated in place when
the attempt completes or fails, exactly like a tool-call block changes status.

Explicit compaction is allowed only while the agent is idle and no other compaction is running for
it. It starts a maintenance run of its own whose ID is the compaction message ID. That run has no
accepted user messages: its `run.started.acceptedMessageIds` is empty. The ordered public
lifecycle is `run.started`, `message.created`, one or more `message.updated` events, then
`run.finished`. The generic agent status may move through `"working"`, but clients must not use
that status to identify compaction.

Response — `202`:

```json
{
    "agent": { ... },
    "profiles": [ ... ],
    "slashCommands": [ ... ],
    "run": { ... },
    "message": {
        "id": "c8n4q1r7v2x9z5m3k6p0t8w1",
        "role": "service",
        "createdAt": 1755400000000,
        "content": [
            {
                "type": "compaction",
                "trigger": "manual",
                "status": "running",
                "tokensBefore": 201000,
                "tokensAfter": null,
                "failureReason": null,
                "startedAt": 1755400000000,
                "completedAt": null
            }
        ],
        "metadata": {}
    },
    "cursor": "..."
}
```

The run and message are already durable and running when this response is sent. The cursor is
captured before their authoritative journal transition, so streaming from it includes the same
`run.started` and `message.created` state returned here followed by terminal updates. Compacting a
working agent, or an agent whose compaction is already running, is `409`.

Automatic compaction creates the same service-message shape with `trigger: "automatic"` inside
the active run. It emits `message.created` and `message.updated` but no run boundary. The history
write and its durable journal transition commit together: a delivered event is authoritative and
ordered, while `GET /v0/agents/:agentId/messages` recovers the identical full message after a
reconnect or cursor gap.

Cancellation and provider failure update the message to `"failed"` with a reason. On daemon
startup, every durable compaction message still marked `"running"` is updated to `"failed"` with
an interruption reason before the daemon becomes ready. A client can therefore never reconnect to
a stale indefinitely-running block.

### `POST /v0/agents/:agentId/read`

Marks the agent read: clears `unread`. The body is `{}`, optionally with a `mutationId`. On a
task's agent it also clears the caller's own task membership `unread`, as
`POST /v0/tasks/:taskId/read` does, with its `task.membership.updated` event. On a task's or bot's
agent it also marks that task or bot seen in the caller's Feed, as `POST /v0/feed/seen` does
without `through`.

Response — `200`: `{ "agent": { ... }, "profiles": [ ... ], "slashCommands": [ ... ] }` with `unread` `null`.

### `POST /v0/agents/:agentId/archive`

Archives the agent. The conversation is kept — an archived agent's history remains readable —
but it leaves the default list and receives no messages. Archiving a working agent aborts its
run first. Its permanent owner association and `orderKey` are retained. Idempotent. Archiving a
workspace-bound subtask also archives its workspace in the same transaction; see Subtasks.

Response — `200`: `{ "agent": { ... }, "profiles": [ ... ], "slashCommands": [ ... ] }` with `archivedAt` set.

### `POST /v0/agents/:agentId/unarchive`

Brings an archived agent back: it reappears in the default list and can receive messages again,
with its history, last submitted mode, owner, and order intact. Idempotent. An archived subtask
cannot be restored and answers `409`; its archival is unchanged.

Response — `200`: `{ "agent": { ... }, "profiles": [ ... ], "slashCommands": [ ... ] }` with `archivedAt` `null`.

### `POST /v0/agents/:agentId/reorder`

Moves the agent in the list order.

Request: `{ "afterId": "pfh0haxfpzowht3oi213cqos", "mutationId": "..." }` — the agent to place
this one after, or `null` to move it first.

Response — `200`: `{ "agent": { ... }, "profiles": [ ... ], "slashCommands": [ ... ] }`. Reordering assigns the moved agent a fractional
`orderKey` between its destination neighbours. Neighbour agent keys and versions remain unchanged;
only the moved agent emits an `agent.updated` reorder event. Its owning project or workspace also
advances because the embedded ordered agent list changed.

### `POST /v0/agents/:agentId/subtask-reorder`

Moves an active subtask among its siblings: the active subtasks that share its `parentAgentId`.

Request: `{ "afterId": "pfh0haxfpzowht3oi213cqos", "mutationId": "..." }` — the sibling subtask
to place this one after, or `null` to move it first.

Response — `200`: `{ "agent": { ... }, "profiles": [ ... ], "slashCommands": [ ... ] }`. The
moved subtask receives a `subtaskOrderKey` between its destination neighbours. When a sibling
has no key yet, the daemon first assigns keys to every active sibling in their current order,
in the same transaction, so the result is exactly the requested order. Moving a subtask to
where it already is changes nothing and emits nothing.

Each subtask whose key changed emits `agent.updated` with its `subtaskOrderKey`. The parent
emits `agent.updated` with `changes.subtasks`, the complete replacement snapshot of its direct
active subtasks in the new order, and its version advances. The subtask's workspace, its
workspace's agent series, and its `orderKey` are unchanged. Concurrent reorders and subtask
creation under one parent are serialized; each sees the order the previous one committed.

Errors: `404` when the agent does not exist. `409` with code `conflict` when the agent is not a
subtask or is archived, or when `afterId` names the agent itself or anything other than an
active subtask with the same parent.

### `GET /v0/agents/:agentId/draft`

Returns the current composer draft as separate current state. A draft is the text plus the exact
mode it will be sent with. The wrapper retains `updatedAt` even when `value` is `null`, so a clear
cannot be overwritten by an older device reconnecting later.

In team mode, drafts belong to the authenticated user and agent together. Reads, writes,
clears, and focused bootstrap address only that user's draft; devices belonging to the same
user share it. Another user's draft and timestamp never affect this state. Existing global
drafts are not exposed to team users. Standalone drafts remain installation-wide per agent.
The endpoints and request and response shapes are unchanged; clients never select a draft owner.

Response — `200`:

```json
{
    "draft": {
        "value": {
            "text": "Now fix the signup flow the same way",
            "providerId": "codex",
            "modelId": "openai/gpt-5.6-sol",
            "effort": "high",
            "serviceTier": null,
            "permissionMode": "auto"
        },
        "updatedAt": 1755400000000
    }
}
```

A fresh agent, and every subagent, returns
`{ "draft": { "value": null, "updatedAt": null } }` by default. An agent created through Happy
with a composer mode selected starts with a draft containing that mode and `text: ""`, with
`updatedAt` set to its creation time. This preserves the phone's initial picker choices through the
ordinary draft contract. Its last submitted mode remains `null` until a message is accepted.

### `PUT /v0/agents/:agentId/draft`

Saves or clears the focused composer draft state.

Request:

```json
{
    "draft": {
        "text": "Now fix the signup flow the same way",
        "providerId": "codex",
        "modelId": "openai/gpt-5.6-sol",
        "effort": "high",
        "serviceTier": null,
        "permissionMode": "auto"
    },
    "updatedAt": 1755400000000,
    "mutationId": "..."
}
```

- `draft` — the composer state, or `null` to clear it. Its mode fields have the same shape as a
  send's `mode` but are not checked against the model catalog; the catalog check happens when
  the message is sent.
- `updatedAt` — optional; when the client last touched this draft. Drafts are last-write-wins
  across the owner's devices: a write carrying an older `updatedAt` than the stored draft is
  ignored, so a stale device cannot clobber what was typed elsewhere. Omitted, the write always applies.

Response — `200`: the same `{ "draft": { "value", "updatedAt" } }` shape as `GET`, carrying
the authoritative stored state — which is the previous one when the write was ignored as stale.

### `GET /v0/agents/:agentId/usage`

Reports what this agent has consumed over its whole life, including the work of its subagents.
Usage is never summarized across models: it is always broken down by provider, then by model,
because tokens from different models are not comparable quantities. Clients that want a rollup
compute their own. The response also carries the latest exact context measurement for the root
agent only; subagents each own a separate context window.

Response — `200`:

```json
{
    "context": {
        "approximate": false,
        "contextTokens": 201000,
        "contextWindow": 272000,
        "providerId": "codex",
        "modelId": "openai/gpt-5.6-sol"
    },
    "usage": {
        "codex": {
            "openai/gpt-5.6-sol": {
                "input": 1250000,
                "output": 84000,
                "cacheRead": 900000,
                "cacheWrite": 120000
            }
        },
        "claude": {
            "anthropic/sonnet-5": {
                "input": 310000,
                "output": 42000,
                "cacheRead": 200000,
                "cacheWrite": 15000
            }
        }
    }
}
```

- `context` — the root agent's active conversation occupancy and hard model limit. It is `null`
  before the first provider measurement and after compaction or a context reset, until the next
  inference measures the replacement. `contextWindow` is `null` only for a custom model whose
  catalog entry has no known limit. Provider-measured occupancy is durable across daemon restart.
- `usage` — lifetime inference totals for the complete agent subtree.

When an exact measurement reaches the model's curated automatic-compaction threshold, published
as the model definition's `autoCompactWindow`, the daemon requests compaction before another
inference can overflow the hard `contextWindow`. Successful
compaction clears `context`; the first inference on the replacement context establishes its next
exact value and also records that value as `tokensAfter` on the completed compaction.

### Background processes

An agent's work can outlive a tool call: a dev server it started, a watcher, a long build
running in the background. Each of these is a **process** — a child of exactly one agent,
observable while it runs and after it exits.

The process object:

```json
{
    "id": "yefj4way7oyt3q1xgvnwpv2f",
    "agentId": "a1b2c3d4",
    "command": "pnpm dev",
    "status": "running",
    "exitCode": null,
    "version": "01991f3a-6161-7000-8000-8f5061920314",
    "startedAt": 1755400000000,
    "endedAt": null
}
```

- `id` — stable process identifier (CUID2), unique across the daemon.
- `agentId` — the agent that started it.
- `command` — the command line the process was started with.
- `status` — `"running"` or `"exited"`.
- `exitCode` — the exit code once `status` is `"exited"`; `null` while running, and `null`
  after a kill that produced no code.
- `startedAt`, `endedAt` — lifecycle timestamps; `endedAt` is `null` while running.

Process output does not travel through this API at all for now — not in this object, not in
events, and there is no output-reading endpoint. What the API announces is existence and
state, so a client can show "2 processes running" and their commands; reading output stays the
agent's own business.

`DELETE /v0/agents/:agentId/processes/:processId` stops a running process — `200` with the
final process object; `404` when the agent has no such process.

### `GET /v0/agents/:agentId/activity`

Everything the agent has set in motion, in one snapshot: every subagent it ever spawned and
every background process it ever ran, each with its current state. This is the drill-down
behind the `subagents` and `processes` counts on the agent object.

Response — `200`:

```json
{
    "subagents": [
        /* full agent objects, newest first */
    ],
    "processes": [
        /* full process objects, newest first */
    ]
}
```

- `subagents` — full agent objects (with `parentAgentId` set to this agent), including
  finished and archived ones; their `status` tells which are still running. This includes
  subtasks, distinguished by `subtask: true`. Unlike an agent's `subtasks` tree, this activity list
  also includes ordinary hidden subagents and finished or archived children. Each child carries
  `totalTokens` from its own recorded usage, or `null` when none has been recorded.
- `processes` — full process objects, including exited ones.

`404` when no such agent exists. On a subagent the endpoint works normally — subagents can
spawn their own subagents and processes.

### `GET /v0/usage`

Reports both sides of installation-wide usage in one response:

- what the daemon has consumed, in rolling windows ending now: the last hour, 24 hours, 7 days,
  and 30 days; and
- the latest account-usage reading for every configured provider, together with every model that
  provider exposes in the effective catalog.

Each token window has the same provider-then-model breakdown as agent usage. Provider-account
readings are advisory and live only in memory. The daemon asks each provider independently every
15 minutes, so a slow or unavailable vendor cannot withhold another provider's state. A provider
is present even before it has answered or when it has no account-usage API.

Response — `200`:

```json
{
    "providers": [
        {
            "providerId": "codex",
            "type": "codex",
            "enabled": true,
            "models": [
                {
                    "id": "openai/gpt-5.6-sol",
                    "enabled": true
                },
                {
                    "id": "openai/gpt-5.6-terra",
                    "enabled": true
                },
                {
                    "id": "openai/gpt-5.6-luna",
                    "enabled": true
                }
            ],
            "usage": {
                "providerId": "codex",
                "vendor": "codex",
                "capturedAt": 1755400000000,
                "planName": "Pro",
                "exhausted": false,
                "windows": {
                    "fiveHour": {
                        "usedPercent": 32,
                        "resetsAt": 1755412000000,
                        "startsAt": 1755394000000,
                        "durationMs": 18000000,
                        "capturedAt": 1755400000000
                    },
                    "weekly": {
                        "usedPercent": 16,
                        "resetsAt": 1755900000000,
                        "startsAt": 1755295200000,
                        "durationMs": 604800000,
                        "capturedAt": 1755396400000
                    },
                    "monthly": null
                },
                "credits": {
                    "available": true,
                    "remainingCents": 1250,
                    "unlimited": false,
                    "usedPercent": 37.5
                }
            },
            "checkedAt": 1755400000100,
            "error": null,
            "refreshedAt": 1755400000000,
            "refreshError": null,
            "retryAt": null,
            "refreshing": false,
            "signIn": "signed_in"
        }
    ],
    "hour": {
        "codex": {
            "openai/gpt-5.6-sol": {
                "input": 310000,
                "output": 21000,
                "cacheRead": 250000,
                "cacheWrite": 30000
            }
        }
    },
    "day": {
        /* same shape */
    },
    "week": {
        /* same shape */
    },
    "month": {
        /* same shape */
    }
}
```

- `providers` — optional for protocol-22 compatibility and always present on daemons that support
  provider-account usage. It contains every configured provider, including disabled or currently
  unavailable providers. `type`, `enabled`, and `models` have exactly the sanitized meanings and
  model-reference shape from `GET /v0/config`; the complete model list is returned here rather
  than only models that have spent tokens. `usage` is the latest successful normalized vendor
  reading, or `null` before the first successful reading and for providers such as Bedrock that
  expose no account-usage API. `checkedAt` is when the daemon last finished asking, whether or not
  the request succeeded. `error` explains why no reading is available; a failed refresh does not
  discard an older successful reading. A smart provider's entry also carries `pool`, exactly as
  on its `GET /v0/config` entry.
- `signIn` is the account's sign-in as the daemon last learned it: `"signed_in"`, `"signed_out"`,
  or `"unknown"`. `"signed_out"` follows exactly the rule of the `signin_missing` failure: the
  account has no credential, or the vendor rejected it after the provider's own renewal failed.
  `"signed_in"` means the vendor last accepted the account: a usage reading arrived for it, from a
  poll or in band, or an inference request on it completed or was refused only because its usage
  was spent. Each check that can tell replaces the value. A check that cannot tell, such as a
  network error, throttling, a vendor error, or a usage read that returns nothing, leaves the
  earlier value in place; when a usage read returns nothing, the daemon also looks for the
  account's credential locally, and a missing one is `"signed_out"`. `"unknown"` means no check
  has told since the daemon started. The value lives only in daemon memory, like the readings.
  Signing an account back in needs no restart: the next usage reading or inference the vendor
  accepts moves it to `"signed_in"`. Every change of `signIn` emits `provider.usage.updated`,
  even when nothing else in the entry changed.
  A smart provider's entry omits `signIn`: a pool is not an account, and each member's own entry
  carries its sign-in. `signIn` is additive and does not increment the protocol version. Older
  daemons omit it, and clients treat an account without it as `"unknown"`.
- `refreshedAt`, `refreshError`, `retryAt`, and `refreshing` are optional for protocol-28
  compatibility. A protocol-29 daemon always sends all four on every entry, with explicit `null`
  or `false`. `refreshedAt` is when the last successful reading arrived, from a poll or from
  inference, or `null` before the first one; an in-band report that measured no window does not
  advance it. `refreshError` is the human-readable reason the latest attempt to read the account
  failed, kept even while an older reading is still shown and cleared by the next success.
  `retryAt` is the epoch-millisecond instant before which the vendor asked not to be asked again,
  or `null`. `refreshing` is `true` while a read of this account is in flight.
- A non-null `usage` keeps every normalized vendor value: the human-readable `planName`, current
  `exhausted` state, five-hour, weekly, and monthly windows, optional `fableWeekly` for Claude's
  separate Fable weekly allowance, and spendable `credits`. A window is `null` only when the vendor
  did not report it. `fableWeekly` is omitted or `null` when the vendor has no Fable meter. Window
  timestamps are epoch milliseconds, `durationMs` is milliseconds, monetary amounts are USD cents,
  and percentages run from 0 to 100.
- Each window's optional `capturedAt` is when that window itself was last measured. A vendor that
  reports only some windows in band leaves the others as they were, and those keep their own older
  `capturedAt`, so a client can show how old each number is. The reading's `capturedAt` is when its
  newest window was measured; a report that measured no window does not move it. A window that
  has reset since it was measured is dropped rather than shown as current.

### `GET /v0/usage/daily`

Reports what the daemon has consumed per calendar day, for an activity grid. Query parameters,
both optional:

- `days` — how many days to report, ending with today: an integer from 1 to 1,096. Omitted, 365.
- `tz` — the IANA time zone whose calendar days are reported, such as `Europe/Berlin`. Omitted,
  `UTC`.

Response — `200`:

```json
{
    "days": [
        {
            "date": "2026-11-10",
            "byProvider": {
                "codex": {
                    "openai/gpt-5.6-sol": {
                        "input": 310000,
                        "output": 21000,
                        "cacheRead": 250000,
                        "cacheWrite": 30000
                    }
                }
            }
        }
    ],
    "since": "2025-03-02"
}
```

- `days` — one entry for each day in the range that has usage, in ascending `date` order. A day
  without usage is absent; clients show it as zero. The range is today in `tz` and the `days − 1`
  calendar days before it.
- `date` — the calendar day in `tz`, as `YYYY-MM-DD`.
- `byProvider` — the same provider-then-model breakdown, with the same keys and token fields, as
  the windows of `GET /v0/usage`. Providers are configured account IDs, so one account's grid is
  its own key. A provider or model appears only on a day it spent tokens.
- `since` — the first calendar day in `tz` with any usage, regardless of `days`, or `null` when
  the daemon has recorded none. Clients show nothing before it.

Usage is recorded in UTC hours. Each hour counts toward the calendar day in `tz` on which it
starts, which follows daylight-saving changes. In a zone whose offset is not a whole number of
hours, such as `Asia/Kolkata`, the hour that crosses midnight counts entirely toward the day it
starts on.

`400` with code `invalid_request` when `days` is not an integer from 1 to 1,096 or `tz` is not a
known IANA time zone.

### `POST /v0/usage/refresh`

Asks the daemon for fresher provider-account readings without waiting for them. The daemon starts
a background read of each selected account and answers at once; every result arrives as
`provider.usage.updated`, beginning with a snapshot whose `refreshing` is `true`.

Request body, every field optional:

```json
{
    "providerIds": ["claude-work", "codex"],
    "olderThanMs": 300000
}
```

- `providerIds` — the accounts to consider. Omitted means every enabled account. IDs that name no
  configured account are skipped rather than rejected.
- `olderThanMs` — only accounts whose `refreshedAt` is older than this many milliseconds, or that
  have never been read, are read again. Defaults to 300000 (five minutes); smaller values are
  raised to 60000 (one minute), so a client cannot hammer a vendor's rate-limited usage API.

An account is also skipped while its `retryAt` has not passed, while a read of it is already in
flight, and when it has no account-usage source, such as Bedrock or an API key. Reads of the same
account never overlap: a refresh joins the same one-at-a-time queue as the daily background poll.
Background reads run at startup and once a day, skipping accounts measured during ordinary
inference within the last day. The existing reset rechecks remain independent of that cadence.
Fallback inference probes have a separate exponential budget: each admitted probe, successful or
not, waits 5 minutes, 40 minutes, 5 hours 20 minutes, then a day before the next. Menu refreshes
cannot reset this budget. Ordinary inference measurements reset escalation and postpone probes
for a day. Inexpensive account endpoints remain eligible under the ordinary refresh age policy.

Response — `202`:

```json
{
    "started": ["claude-work"]
}
```

- `started` — the accounts for which a read was started, in configuration order. An empty array
  means every selected account was fresh enough or could not be read now.

`400` when the body is not an object of the shape above.

## Bots

A bot is a continuous chat with an identity and a single folder of its own. Where a project or
workspace is a place that hosts many conversations, a bot **is** one conversation: it is created
with exactly one agent, keeps that same agent for its whole life, and never gets another. The
conversation goes on indefinitely — compaction keeps the context fitting — which is what makes a
bot feel like a persistent assistant rather than a task.

Bots live outside the project catalog entirely. Each bot owns one folder under the daemon's
bots root, `~/Happy/Bots/<username>`, and that folder is held by a **dedicated workspace** the
bot owns — a real workspace with its own distinct ID, so the agent, file, terminal, and proxy
machinery works on a bot folder exactly as it does anywhere else. There is no project behind it:
a bot workspace is the root of nothing, appears in no project list, no workspace listing, and no
bootstrap `projects` or `workspaces` array, and it is not a Git worktree and has no branch
semantics. It is discovered only through its bot and addressed by its own workspace ID.

A bot's identity is:

- `name` — a normal human display name, chosen by the person ("Research Assistant") or generated
  from the first user message when creation omits the name.
- `username` — a local snake_case machine name; it is the folder name on disk. Lowercase ASCII
  letters, digits, and underscores, starting with a letter, 1–64 characters. Usernames are
  unique across all bots on the installation, archived ones included, because the folder path
  is derived from it. The username is chosen at creation and is immutable ever after — the
  folder never moves.
- `id` — the stable CUID2 the database knows the bot by, like every other resource.
- `isAdmin` — whether this bot may create other bots through `create_bot`. New and migrated bots
  are non-admin by default; an authenticated client may opt a bot into administration when
  creating it.
- `systemKey` — the stable kind key of a daemon-provided system bot, or `null` for an ordinary
  bot. The current built-in Chief of Staff uses `"chief_of_staff"`.
- an optional avatar, exactly like a project's picture.

**Mapping to workspaces and agents.** A bot is one dedicated workspace plus one agent in it,
under the bot's identity. All three have their own distinct IDs. The workspace is a real
workspace: its files, file-tree, terminals, and proxy routes all work by its workspace ID, its
`botId` names the bot, and its `projectId` and `parentId` are `null`. Its lifecycle belongs to
the bot — renaming, archiving, and creating children through the workspace surface are `409` —
and it is excluded from `GET /v0/workspaces` and the bootstrap `workspaces` array.

The agent is an ordinary agent, and every agent endpoint works on it unchanged: `send`,
`messages`, `bootstrap`, `mode`, `draft`, questions, `abort`, `compact`, `read`, usage,
activity, background processes, and slash commands. Its `workspaceId` names the bot's
workspace. The differences are ownership and lifecycle, not behavior:

- The agent reports `userVisible: true`, `managedByAnotherAgent: false`, and
  `canSendMessages: true` while the bot is active. Its `orderKey` is `null`: it belongs to no
  project or workspace root-agent series, and ordering lives on the bot.
- The agent's lifecycle belongs to the bot. Agent `archive`, `unarchive`, and `reorder` on a
  bot's agent answer `409`; archiving and unarchiving happen through the bot routes below, and
  the agent follows.
- It is the workspace's only primary conversation: `POST /v0/agents` refuses a bot workspace
  with `409`, and the bot workspace's `agents` array always contains exactly this one agent.
  Shared-filesystem subtasks may also run there and are included in the bot agent's `subtasks`
  tree and parent activity.

Bot agents and bot workspaces appear in no project or workspace listing; they are discovered
only through bot objects. A client that does not know about bots therefore never encounters
one, which is what keeps this chapter additive for protocol 22.

Bots are a versioned resource: mutations require `If-Match` with the usual `409` conflict
carrying the authoritative `bot`, and accept the optional `mutationId` from the basics. The bot's
`version` covers the bot's own fields — name, avatar, order, and archival. The embedded
agent is independently versioned and changes through `agent.updated` without advancing the bot,
exactly as agents embedded in projects and workspaces do; clients merge it by its own version.

### The bot object

```json
{
    "id": "b7f2k9m4",
    "name": "Research Assistant",
    "username": "research_assistant",
    "isAdmin": true,
    "systemKey": null,
    "workspaceId": "w9x8y7z6",
    "compute": { "type": "host", "path": "/Users/steve/Happy/Bots/research_assistant" },
    "status": "active",
    "avatar": { "kind": "image", "thumbhash": "3OcRJYB4d3h3iIeHeEh3eIhw+j2w", "source": "user" },
    "agent": {
        /* the bot's one agent, the full agent object */
    },
    "orderKey": "00000000000000000001",
    "version": "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e",
    "createdAt": 1755300000000,
    "updatedAt": 1755400000000,
    "archivedAt": null
}
```

Fields:

- `id` — stable bot identifier.
- `stories` — retired compatibility field, always `false` on current daemons. Older compatible daemons may omit it or support Stories.
- `name` — the human display name. Required, 1–256 nonblank characters, no ASCII control
  characters.
- `shortName` — optional generated label of at most 10 characters; clients fall back to `name`.
- `username` — the local snake_case name and on-disk folder name, under the rules above.
- `isAdmin` — whether the bot may create other bots through `create_bot`. The tool remains visible
  to non-admin bots, but calling it returns a tool error that explains the restriction and lists
  the installation's admin bots when any exist. Human-owned agents are unrestricted. A daemon
  implementing this field always returns a boolean. The field is additive and may be absent when
  talking to an older protocol-22-compatible daemon.
- `systemKey` — the stable snake_case kind key stored for a daemon-provided system bot, or `null`
  for an ordinary bot. `"chief_of_staff"` identifies the current built-in Chief of Staff. Clients
  may alter their presentation for keys they recognize and must preserve normal bot behavior for
  unknown keys. A daemon implementing this field always returns a string or `null`; the field is
  additive and may be absent when talking to an older protocol-22-compatible daemon.
- `workspaceId` — the bot's dedicated workspace, its own distinct ID. The workspace object is
  fetched from `GET /v0/workspaces/:workspaceId` like any other; it is simply not listed.
- `compute` — where the bot's folder lives, same shape as on projects and workspaces. A `"host"`
  compute carrying the resolved `path`, or, while runners are configured, a `"runner"` compute on
  the default runner. Creating a bot while the default runner has never connected is
  `503 runner_unavailable`. It mirrors the workspace's compute so a bot list renders without
  fetching workspaces.
- `status` — `"active"` or `"archived"`.
- `avatar` — the bot's picture, or `null`; the same shape and byte-fetching model as a project
  avatar, served from `GET /v0/bots/:botId/avatar`.
- `agent` — the bot's one agent, embedded in full so listing bots also answers what each one is
  doing. It merges by its own `version` through `agent.updated` events.
- `orderKey` — an opaque sort key; clients order the bot list by comparing these strings.
- `version` — the UUIDv7 concurrency version; see the basics.
- `createdAt`, `updatedAt`, `archivedAt` — lifecycle timestamps; `archivedAt` is `null` while
  active.

### `GET /v0/bots`

Lists every bot, archived ones included, in catalog order.

Response — `200`: `{ "bots": [ /* bot objects */ ] }`

### `POST /v0/bots`

Creates a bot: the row, its dedicated workspace with its folder, and its one agent, together.

Request:

```json
{
    "id": "b7f2k9m4",
    "workspaceId": "w9x8y7z6",
    "agentId": "a1b2c3d4",
    "name": "Research Assistant",
    "username": "research_assistant",
    "isAdmin": true
}
```

- `id` — optional client-supplied bot ID; the retry key.
- `workspaceId`, `agentId` — optional IDs for the new dedicated workspace and its one agent,
  not existing entities to attach or a creating agent. Require protocol 25 or newer.
- `name` — optional. Supplied names are deliberate and are never automatically replaced. Omitted,
  the daemon creates an immediately usable bot with the temporary display name `New Bot`; the
  client need not supply a placeholder or naming flag. A supplied blank or invalid name is `400`.
  Omission and automatic naming require protocol 24 or newer; older compatible daemons may
  require a supplied name.
- `username` — optional. Omitted, the daemon derives one from the name (lowercased,
  non-alphanumeric runs collapsed to underscores) and resolves a collision by appending a
  numeric suffix. When both name and username are omitted, the username starts from `bot` with
  the same collision handling. A supplied username that is malformed is `400`; one already taken by any bot,
  archived included, is `409` with code `conflict`.
- `isAdmin` — optional. `true` allows the bot to create other bots through `create_bot`. Omitted
  or `false`, the bot is non-admin. The bot-facing `create_bot` tool does not expose this field,
  so a bot cannot grant administration to a bot it creates.

Malformed IDs return `400 invalid_request`; omitted IDs are generated independently. For a new bot,
all three must be distinct and unused by any bot, workspace/project root, or agent, archived and
hidden included (`409 conflict`). Chosen IDs stay unchanged across responses, events, and reads.

Repeating `id` returns the current bot unchanged (`201`), including after rename, archival, or
restart; other valid creation fields are ignored. Omitted child IDs reuse stored ones; mismatches
return `409 conflict` with `currentVersion` and `bot`. Retries have no side effects or events.
Neither child IDs nor `mutationId` deduplicate creation.

Identity checks and creation are atomic: concurrent retries cannot create duplicates and conflicts
have no side effects. Folder-setup failure rolls back creation without exposing entities or events.

Response — `201`: `{ "bot": { ... } }`. Creation is complete when it answers: the folder exists
at `~/Happy/Bots/<username>`, the workspace and agent exist, the agent is `"idle"`, and the bot
is ready for its first message through `POST /v0/agents/:agentId/send`. New creation emits
`bot.created`, `workspace.created`, and `agent.created` once after commit, echoing `mutationId`.

Clients may open the composer immediately under their chosen IDs, queuing sends locally until
creation succeeds; the response waits for setup.

For an unnamed bot, the first accepted text-bearing user-role message starts one durable asynchronous
naming job, using that message alone and the same cheap, bounded inference mechanism as
workspace naming. The bot-specific prompt asks for a short entity, person, or role-like identity
based on its likely ongoing function, not a task title. Generated names are bounded to three words
and 40 characters. The same request also asks for `shortName`, a label of at most 10
characters; an answer over that budget leaves `shortName` absent. Message acceptance and the bot's real turn never wait for naming. Failure or
timeout does not fail the message. A new naming job makes at most three bounded attempts, waiting
one second before its second attempt and five seconds before its third. Pending jobs and their
attempt budget survive daemon restarts; later messages do not start another job. If every attempt
fails, a bounded plain-text excerpt of that first message supplies the name, within the same
word and character limits. Text with no letters or numbers supplies no fallback. Previously
attempted naming is not backfilled or restarted.

The generated name updates the bot and its conversation title together and publishes their usual
independently versioned updates. Its IDs, username, folder, and dedicated workspace remain
unchanged. An explicit rename always wins, including one committed while naming is running.
Existing named bots and built-in bots are not eligible for automatic naming.

### `GET /v0/bots/:botId`

Returns one bot.

Response — `200`: `{ "bot": { ... } }`; `404` when no such bot exists.

### `PATCH /v0/bots/:botId`

Updates the bot's display name. Requires `If-Match`, with the same authorization as rename.

Request: `{ "name"?: "Research Buddy", "stories"?: true, "mutationId"?: "..." }`; at least one of `name` or `stories` is required (`400 invalid_request` otherwise). The retired `stories` input is accepted and ignored; a stories-only request does not change the bot, its version, or automatic naming.

Renaming also updates the bot's conversation title, clears `shortName`, and permanently cancels
eligibility for automatic naming, even when the submitted name equals the current display name. This decision
and both names are persisted together, so a delayed naming result cannot overwrite the rename.

The `username` is immutable: it is the folder on disk, chosen at creation and never changed.
A request carrying `username` is `400` with code `invalid_request`.

Response — `200`: `{ "bot": { ... } }` with the updated name.

### `POST /v0/bots/:botId/archive`

Archives the bot. Requires `If-Match`; the body is `{}`. Idempotent — an already archived bot
answers the same way and stops nothing.

Archiving stops the work standing in the bot: its agent's run is aborted, its background
processes are killed, and its workspace's terminals are closed, with the same durability
contract as workspace archival — the cancellation is prepared inside the transaction that
records the archival. The workspace and agent are archived with the bot and the agent's
`canSendMessages` becomes `false`; the conversation history remains readable. The folder is
kept on disk — archival is a logical action, never a deletion. Only an admin bot's
[permanent deletion](#permanent-deletion) removes the folder and the bot.

Response — `200`: `{ "bot": { ... } }` with `status` `"archived"`.

### `POST /v0/bots/:botId/unarchive`

Brings an archived bot back: it reappears in the active list with its history, identity, folder,
and order intact, its workspace is active again, and its agent accepts messages. Requires
`If-Match`. Idempotent.

Response — `200`: `{ "bot": { ... } }` with `archivedAt` `null`.

### `POST /v0/bots/:botId/reorder`

Moves the bot in the catalog order. Requires `If-Match`.

Request: `{ "afterId": "c3d4e5f6", "mutationId": "..." }` — the bot to place this one after, or
`null` to move it first.

Response — `200`: `{ "bot": { ... } }`. Reordering assigns the moved bot a fractional `orderKey`
between its destination neighbours; neighbour keys and versions remain unchanged.

### `GET /v0/bots/:botId/avatar`

Serves the bot picture's image bytes, with the same `ETag`, conditional-request, image-caching,
and `404` behavior as a project avatar.

### `PUT /v0/bots/:botId/avatar`

Sets the bot picture. Requires `If-Match`. The body is the raw image bytes; the limit is 8 MB,
and a larger upload is rejected with `413`.

Response — `200`: `{ "bot": { ... } }` with the new `avatar`, including the freshly computed
`thumbhash`.

### `DELETE /v0/bots/:botId/avatar`

Removes the bot picture. Requires `If-Match`.

Response — `200`: `{ "bot": { ... } }` with `avatar` `null`.

## Surfaces

A Surface is an instance of a predefined feature with its own typed API. Every instance has a
CUID2 ID and a human name. Multiple independent Surfaces of each type may exist, with separate
content, history, and members. Supported types are `todo`, `document`, `calendar`, `system_monitor`,
`chat`, `vault`, `artifact`, `bot`, and `task`. System Monitors share host telemetry rather than independent
content. A `chat` Surface is a conversation among people; it is unrelated to the shared agent chat
every chat-enabled Surface may own.
The catalog initially has no instances.
All onboarded authenticated people may read and modify Surface data, whether
or not they joined. Joining and leaving control only the person's sidebar. Creating a Surface
does not create a workspace, agent, or chat; the separate chat-ensure operation below is lazy.

### Surface catalog and members

A Surface object has `id` (CUID2), `type` (one of the predefined types above; future types are additive),
`name` (human display text), `image` (`null` or `{ "thumbhash": "..." }`), `members`,
`version` (UUIDv7), and `updatedAt` (epoch milliseconds).
Surface IDs always use the daemon generator's 24-character CUID2 form: a lowercase letter
followed by 23 lowercase letters or digits (`^[a-z][a-z0-9]{23}$`). Caller-supplied creation IDs
and reorder anchors use this same format. Invalid body IDs return `400 invalid_request`;
every malformed `:surfaceId` path returns `404 not_found`. Short words such as `todo`,
`document`, `join`, and `image` are not Surface IDs, so they cannot collide with route names.
This deliberately corrects the earlier loose ID validation; existing generated IDs are
unchanged, and stored IDs are never rewritten.
Optional additive `chatAgentId` is the Surface's one shared chat agent ID, or null before a chat
exists. Current daemons include it; older compatible daemons may omit it. It is never supplied
in a creation request. Unsupported chat types keep it null.
It also has optional additive `creatorUserId`: the installation-local Happy user ID of its
creator, resolvable through `GET /v0/users`, or `null` when no creator is attributed or in
standalone mode. Current daemons always include it. It is set at creation and never changes,
including when the creator leaves the Surface. Surfaces stored before attribution was added
read as `creatorUserId: null`; no member or audit identity is used to infer a creator.
`members` is an array inside the Surface, sorted by `userId` using plain string comparison.
`members: []` is the sole representation of no joined people. There is no separate member list
or nullable member field in responses, and no duplicate `userIds` list. The Surface's version
covers its name, image, and all its member records. Its identity and type never change; its name
and image change only through `PATCH /v0/surfaces/:surfaceId`.
`name` is 1–256 nonblank characters without ASCII control characters.
Document Surfaces have optional additive `promptDocument`: `null` when the document is not one of
the installation's important documents (see [Document Surfaces](#document-surfaces)), or
`{ "description": "...", "name": "..." }` when it is. `description` is the admin's description of
what the document covers and when to read it. `name` is present only when the admin gave the
document its own display name for agents' instructions; otherwise agents see the Surface's `name`.
Current daemons include it on caller-facing catalog, desktop bootstrap, and single-Surface
responses for document Surfaces; other types omit it, and older daemons may omit it. It is
resolved when the Surface is read and is not part of the Surface's stored version chain: marking
or unmarking a document changes no Surface version, and shared `surface.created` and
`surface.updated` events omit it. Clients refetch the catalog to see a change.

Each member has `userId`, `orderKey`, and `joinedAt`. In standalone mode `userId` is `null`,
matching the existing profile and task identity convention; in team mode it is the
installation-local Happy user ID. A member is always an object, never a null array element. Resolve
the standalone person's name and photo through the profile, and team members through the
existing user routes. `orderKey` is an opaque fractional decimal string compared lexicographically,
like other catalogs. It places this Surface in this person's sidebar, not in anyone else's.
`joinedAt` is epoch milliseconds. The Surface contains all its members, so people can see who
joined. To render a person's sidebar, select Surfaces containing their member record and order
them by that record's key, with Surface ID as a tie-breaker.

In team mode, enrolled sign-in-capable members join all catalog Surfaces by default, including
existing Surfaces during startup catch-up and profile enrollment, and newly created Surfaces.
Guests never participate. Withdrawn types remain excluded. Reference membership never joins
anyone to the target or grants additional access, including when the target is unavailable.
Standalone creation keeps its existing local-person membership rule.

The independent per-person `surfaces.autoJoin` preference uses the existing user-settings routes.
Only JSON boolean `false` disables autojoin; missing, cleared, and all other values enable it.
Disabling preserves memberships. Enabling catches up missing memberships without changing
existing order keys or join times. The explicit creator always joins, even when opted out.
Setting changes and their derived joins commit together, with the setting event before membership
events. Startup catches up in bounded resumable batches, checking the preference between batches.
Surfaces have no deletion or archive lifecycle; referenced targets keep their independent lifecycle.

An explicit leave persistently excludes that Surface from autojoin for that person, even when
they were not a member, across restarts and preference changes. An explicit join clears the
exclusion. Missing memberships from before this behavior was introduced are eligible for catch-up.
Requests cannot supply another person's identity.
A new join appends to the caller's list; rejoining after leaving appends too. Mutations do not
require `If-Match`: the latest reorder wins within one person's list. Leaving never removes
Surface data or history. Changing one member never changes another member's order or join time.

`GET /v0/surfaces` returns `200 { "surfaces": [...], "cursor": "..." }`, the full instance
catalog in ascending ID order with members nested in every Surface. The event cursor is captured
before snapshot reads. Unknown query fields are ignored.

`POST /v0/surfaces` accepts `{ "id": "...", "type": "todo", "name": "Shopping",
"mutationId": "..." }`; `id` and `mutationId` are optional. It creates one independent empty
list, records the authenticated caller as `creatorUserId` (`null` in standalone mode), joins
that person at the end of their sidebar, and returns
`201 { "surface": {...} }`. Repeating a supplied ID returns the existing Surface without changing
it or rejoining, and emits no event. New creation emits shared `surface.created` containing
`surface` and optional `mutationId`. Invalid names, IDs, or unsupported types return
`400 invalid_request`. There is no Surface deletion route; leaving removes it only from the
caller's sidebar. HTTP request bodies cannot supply `creatorUserId`.

Creation additionally accepts optional `image` containing base64 `data` for a PNG, JPEG, or
WebP, at most 8 MiB decoded and 40 million pixels. The daemon normalizes it to a bounded WebP,
stores its own bytes atomically with creation, and computes the ThumbHash. Invalid or oversized
images return `400 invalid_request` without creating anything. `GET /v0/surfaces/:surfaceId/image`
serves those bytes with `Content-Type: image/webp`, a content-derived `ETag`, and the shared
private image cache policy; matching `If-None-Match` returns `304`. Missing images or Surfaces
return `404 not_found`. There is no caller-provided path or URL in a Surface response. Replacing
or removing the image changes what this route serves, including its `ETag`.

There is no `separator` type. Sections belong inside a todo list as `# ` heading rows, not in the
sidebar. Creating `{ "type": "separator", ... }` returns `400 invalid_request` and creates
nothing. Separators that an earlier daemon created are kept in storage unchanged but are no
longer part of the catalog: listing, desktop bootstrap, and events omit them, and every Surface
route given one of their IDs returns `404 not_found`.

Surface IDs are always 24-character CUID2s, so catalog, typed-content, and chat routes cannot
collide through short route words used as IDs. Paths such as `/v0/surfaces/todo/join` and
`/v0/surfaces/document/image` contain no valid Surface ID and return `404 not_found`.

`POST /v0/surfaces/:surfaceId/join` and `/leave` accept `{}` or `{ "mutationId": "..." }` and
return `200 { "surface": {...} }`. Unknown Surface IDs return `404 not_found`.
Joining an existing member or leaving an absent member changes no Surface version or event;
the explicit autojoin exclusion is still cleared or recorded respectively. A changed member record updates the
Surface's `members` and version atomically and emits shared `surface.updated` after commit,
echoing `mutationId` when supplied.

`POST /v0/surfaces/:surfaceId/reorder` accepts `{ "afterId": "s4k8m2q9w1e5r7y3u6i0o2p4", "mutationId": "..." }`;
`afterId: null` means first. It returns the same single-Surface response. The moved member record
gets the fractional key between the destination neighbours; neighbours keep their keys. Only
the caller's member record changes, advancing the Surface version and emitting `surface.updated`.
Moving to the current position is a no-op. An unjoined target, self-anchor, or anchor outside
the caller's list returns `409 conflict`. An unknown target Surface returns `404 not_found`.

`PATCH /v0/surfaces/:surfaceId` accepts `{ "name": "Groceries", "image": { "data": "..." },
"mutationId": "..." }` and returns `200 { "surface": {...} }`. At least one of `name` and
`image` is required. `name` follows the creation rules and replaces the stored name. `image`
follows the creation image rules and replaces the stored image; `image: null` removes it.
Every Surface type may be edited, including reference Surfaces, whose `name` is their stored
label. Any onboarded authenticated person may edit any Surface, whether or not they joined.
The route requires no `If-Match`: as with membership, the latest edit wins. A body with only
`mutationId`, unknown fields, an invalid name, or an invalid or oversized image returns
`400 invalid_request` without changing anything. An unknown Surface returns `404 not_found`.
A supplied value equal to the stored one changes nothing; an image is equal when its normalized
bytes match the stored image, and removing an absent image changes nothing. A request that
changes nothing is an exact no-op, including versions and events. Otherwise the new name, image
bytes, ThumbHash, `updatedAt`, and version commit atomically, and shared `surface.updated`
follows commit, echoing `mutationId` when supplied. Members, their order, the creator, the chat,
the Surface's content, and its history are unchanged.

### Todo data and permanent versions

Each Todo Surface owns one shared plain list. A todo contains:

```json
{
    "id": "t4k8m2q9w1e5r7y3u6i0o2p4",
    "surfaceId": "s4k8m2q9w1e5r7y3u6i0o2p4",
    "authorUserId": "u1x2y3z4a5b6c7d8e9f0g1h2",
    "text": "Pick up groceries",
    "status": "active",
    "orderKey": "5",
    "createdAt": 1755300000000,
    "updatedAt": 1755400000000,
    "completedAt": null,
    "deletedAt": null,
    "version": "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e"
}
```

`id` is a CUID2. `text` is plain text, 1–10,000 characters, containing a non-whitespace character
and no ASCII control characters except tab and newline. `status` is `active`, `completed`, or
`deleted`. Only active todos have an `orderKey`; inactive ones have `null`. Active todos have
`completedAt: null` and `deletedAt: null`. Completed todos have a completion timestamp and
`deletedAt: null`. Deleted todos have a deletion timestamp and retain their prior completion
timestamp, if any. All timestamps are epoch milliseconds. The version is a UUIDv7 resource
version. Clients use plain string comparisons for keys, never locale-aware collation.

An active todo whose stored text starts with the exact ASCII prefix `# ` is a section heading.
Clients render it without a checkbox and omit it from counts of outstanding tasks. Its display
label is the text after those first two characters, without further trimming or Markdown parsing.
`## Title`, ` # Title`, `#\tTitle`, and `#Title` are ordinary todos. Editing uses the full stored
text, including the prefix; adding or removing it changes the presentation without changing the
record's identity. A heading uses the same active ordering, text updates, deletion, and permanent
history as any other todo. It has no separate type, field, or route. The API still allows all
ordinary status changes; completion and deletion preserve its full text, and do not rewrite
earlier snapshots. This convention does not prescribe how clients style historical rows.

`authorUserId` is an optional additive field containing the installation-local Happy user ID of
the todo's author, resolvable through `GET /v0/users`, or `null` when no author is attributed or
in standalone mode. Current daemons always include it. It is set once at creation and appears
unchanged in every full revision snapshot. No edit, status change, deletion, reorder, or
application of a historical state may change it. Todos and revision snapshots stored before
attribution was added read as `authorUserId: null`; revision actors are never used to backfill it.

Every creation, text edit, status change, deletion, and reorder atomically
stores the new full todo snapshot as an immutable revision alongside the latest todo and its
durable notification intent; publication to the shared event journal follows commit.
A revision is `{ "todo": {...}, "actor": { "userId": null, "agentId": null },
"source": "api" }`. `actor.userId` is the authenticated Happy user ID for HTTP mutations, or
the identified person whose message the agent is working on for tools; it is `null` in
standalone mode or when no person is identified. `actor.agentId` is the executing agent ID for
tools and `null` for HTTP. `source` is `api` or `tool`. These values are resolved from trusted
execution context and cannot be supplied in request bodies. A revision's actor records who
performed that mutation and is independent of the todo's immutable `authorUserId`. Revisions
retain the full snapshot including author, text, and tombstones. Revisions are permanent;
ordinary event-journal retention never removes todo history. A no-op adds neither a revision
nor an event. All operations participate in a caller's transaction and notify only after commit.

All mutations of existing todos require `If-Match` with the current todo version. Missing or
malformed headers return `400 invalid_request`; stale ones return `409 conflict` with
`currentVersion` and the authoritative `todo`, including when it is deleted. Unknown IDs return
`404 not_found`. Invalid bodies, unsupported fields, invalid list scope, or malformed paging
parameters return `400 invalid_request`. Creation and Surface member mutations do not use `If-Match`.

### Todo routes

The collection prefix is `/v0/surfaces/todo/:surfaceId`. There is no generic single-Surface read
route: `GET /v0/surfaces` supplies the catalog; the typed prefix reads one list's todo data.
Every operation checks that the Surface has type `todo` and scopes todo and revision lookups to that instance.
Unknown Surfaces and todos or revisions belonging to a different Surface return `404 not_found`.
Using a non-todo Surface with a todo route also returns `404 not_found`.
Active ordering, creation retry IDs, and history are isolated to their Surface.

- `GET` lists `200 { "todos": [...], "cursor": "..." }`. Optional `scope` is `active` (default),
  `completed`, `deleted`, or `all`. Active scope loads every active todo, sorted by `orderKey`
  then ID, without paging. Completed and deleted scopes sort newest `completedAt` and
  `deletedAt` first, respectively, then ID. `all` groups active, completed, and deleted in
  that order with the same within-group ordering. The cursor precedes snapshot reads.
- `POST` accepts `{ "text": "Pick up groceries", "id": "...", "mutationId": "..." }`. `id`
  and `mutationId` are optional. Creation records the authenticated caller as `authorUserId`
  (`null` in standalone mode), inserts an active todo at the top of the active list with a new
  fractional key before its first item (without changing existing keys), and returns
  `201 { "todo": {...} }`, emitting shared `todo.created`. A repeated supplied ID returns the current todo
  unchanged with `201`, even after deletion or restart, and emits no event; other valid fields
  are ignored. This ID is the creation retry key; `mutationId` remains only an echo. HTTP request
  bodies cannot supply `authorUserId`, on creation or any subsequent mutation.
- `GET /:todoId` returns `200 { "todo": {...} }`, including deleted tombstones.
- `PATCH /:todoId` accepts `{ "text": "...", "status": "completed", "mutationId": "..." }`.
  At least one of `text` or `status` is required. Status is `active`, `completed`, or `deleted`.
  Omitting it keeps the current status. Text may be edited in any state. Moving an inactive
  todo to `active` clears both lifecycle timestamps and appends a fresh key at the active tail.
  Moving to `completed` clears the key and deletion timestamp and sets a new completion time.
  Moving to `deleted` clears the key, sets a new deletion time, and retains any completion time.
  Repeating the current status preserves its timestamps and key. Callers cannot supply audit
  timestamps or historical versions. To apply an old revision, read its fields, then use this
  ordinary update with the current `If-Match`; use ordinary reorder for active placement.
  An identical edit is a no-op. Returns `200 { "todo": {...} }` and emits shared `todo.updated`
  for a change.
- `POST /:todoId/reorder` accepts `{ "afterId": "...", "mutationId": "..." }`, with
  `afterId: null` meaning first. Only an active todo may move, and a non-null anchor must be a
  different active todo. Completed or deleted targets and inactive, unknown, or self anchors
  return `409 conflict` with the current target todo. Only the moved key changes; neighbours
  keep their keys. The response is `200 { "todo": {...} }`; a change emits `todo.updated`.
  Moving to the current position is a no-op and does not consume a version.
- `DELETE /:todoId` accepts `{}` or `{ "mutationId": "..." }`, marks the todo deleted, clears
  its key, and returns `200 { "todo": {...} }`. Already deleted is a no-op after checking
  `If-Match`. A change emits `todo.updated`; deletion never removes a revision.
- `GET /:todoId/versions` returns `200` with `versions` (immutable revisions, oldest first) and
  `nextAfterVersion` (a UUIDv7 or `null`). `afterVersion` is an optional exclusive
  UUIDv7 revision cursor belonging to this todo; unknown cursors return `404 not_found`.
  `limit` is optional, default 100, from 1 through 200. `nextAfterVersion` names this page's
  last revision when another page exists, otherwise `null`. Appending revisions never changes
  prior pages; clients may continue pagination while mutations occur.
- `GET /:todoId/versions/:version` returns `200 { "revision": {...} }` for that immutable
  revision. Unknown versions return `404 not_found`.

There are no dedicated restore, unarchive, or revert routes or tools. History reads and ordinary
updates allow any prior editable state to be applied without rewriting its original revision.

### Surface tools and events

Every ordinary agent model receives fixed common tools `list_surfaces`, `list_todos`,
`create_todo`, `update_todo`, `reorder_todo`, `delete_todo`, and `list_todo_versions`.
They call the same strict typed operations as the API.
`create_todo` requires an explicit `authorUserId` parameter: an installation-local Happy user ID
or `null`. The model must supply it; the daemon never infers it from the execution context.
It sets the todo's immutable author, not the revision actor.
New todos are inserted at the top, as with HTTP creation. Returning an inactive todo to active
still appends at the end; it is not a new creation.
Agents create and edit section headings using the same text-prefix convention. `list_todos`
returns headings in their ordinary list positions; summaries of outstanding work exclude active
heading rows from the task count.
Todo mutation tools supply the current version they read, and receive an explicit conflict on a
stale version rather than silently overwriting. `list_surfaces` lists instance IDs, types, names,
nested members, and `promptDocument` for document Surfaces.
Every ordinary agent model also receives `update_surface`, accepting `surfaceId`, optional
`name`, and optional `imagePath`: an absolute PNG, JPEG, or WebP path (8 MiB maximum) that
replaces the image, or `null` to remove it. At least one of `name` and `imagePath` is required.
It performs the same edit as `PATCH /v0/surfaces/:surfaceId` on any Surface type, changes no
membership, and never joins anyone. Images are read through the ordinary Compute filesystem
permission boundary, with reviewed elevation for outside-workspace or symlink targets. It
requires shared Auto review. Durable replay reuses the first execution's image bytes and returns
the previously committed result without changing the Surface again.
Active admin bots additionally receive the type-specific `create_todo_surface` tool, accepting
`name`, required explicit `creatorUserId` (an installation-local Happy user ID or `null`), and
optional absolute `imagePath`, plus `add_surface_user` and `remove_surface_user`, accepting
`surfaceId` and `userId` (null only for standalone).
These tools require an actual active admin bot, checked both at tool selection and execution;
ordinary agents and non-admin or archived bots cannot invoke them. Images are read through the
ordinary Compute filesystem permission boundary, with reviewed elevation for outside-workspace
or symlink targets. Creation makes an independent list and stores the explicit `creatorUserId`,
never inferring it from execution context. A non-null creator joins at the end of their sidebar;
in standalone mode the local person joins with null identity. In team mode a null creator
creates no member, even when the agent has an identified person. Adding a user appends the
Surface to that person's sidebar; removing them leaves data and history intact. Team targets must be existing
local members who can sign in, not exported-bot guests. The same existing-member validation
applies to non-null todo authors and Surface creators: unknown users and exported-bot guests
are rejected with `not_found`. Null attribution is allowed in team mode; in standalone mode
only null is allowed, and a non-null attribution is rejected with `invalid_request`. Missing
or malformed required tool attribution parameters are rejected as invalid arguments without
creating anything. Admin changes use the same idempotence,
versions, and shared events as self join/leave. Every todo tool requires `surfaceId`.
Tools otherwise never join, leave, or reorder anyone's sidebar. Reading or modifying todos never joins
the caller automatically. Read tools require no review; mutation tools own ordinary shared Auto
review and run within the current permission boundary. Durable tool
replay returns the previously committed result without appending another revision or event.

`surface.updated` carries `surfaceId`, `previousVersion`, `version`, `changes` (the complete new
`members` plus `updatedAt`, optional `chatAgentId` when the chat is first associated, optional
`name` when the name changed, and optional `image` when the image changed), and optional
`mutationId`. `image` is the new `{ "thumbhash": "..." }`, or `null` when the image was removed;
clients refetch the image bytes when it is present. It is shared so everyone sees the joined
people, the current name and image, and learns when the chat exists. It covers joining, leaving,
reordering, editing the name or image, and first chat creation; there are no separate member
events. Existing fields remain present on chat-only and edit-only changes, with members
unchanged.
`todo.created` carries the full `todo` and optional `mutationId`.
`todo.updated` carries `surfaceId`, `todoId`, `previousVersion`, `version`, `changes` (the
changed mutable fields, always including `updatedAt`), and optional `mutationId`. All todo events
are shared. Consumers follow normal version-chain reconciliation and refetch on gaps.

Desktop bootstrap adds optional `surfaces` (the complete catalog with nested members), exactly
as the list route returns. No todos or revision history are loaded into desktop bootstrap;
opening Todo fetches its list with its snapshot cursor.

### Document Surfaces

A `document` Surface owns one shared rich-text document that people and agents edit at the same
time. It is not a workspace file or an artifact. Its content is a Yjs CRDT document edited with
BlockNote, so concurrent edits merge without conflicts and without losing anyone's text. Markdown
is a read-only projection of it for reading, agents, and older clients. A daemon that serves this
model reports `capabilities.collaborativeDocuments: true` from health.

`POST /v0/surfaces` accepts `{ "type": "document", "name": "Notes", "text": "# Notes\n",
"id": "...", "image": { "data": "..." }, "mutationId": "..." }`. Only `type` and `name` are
required. Optional `text` is Markdown of at most 262,144 UTF-16 code units with no NUL; it is
converted to blocks and stored as the document's first change, `seq` 1. Omitted or empty `text`
creates an empty document with no change yet (`seq` 0). Images, creator attribution, automatic
creator membership, supplied-ID retries, and `surface.created` follow the catalog rules. The
Surface, its first change, and the notification intent commit atomically. Repeating an existing
Surface ID does not replace its document or add a change.

#### Content model

Each document is one Yjs `Y.Doc`. Its root `Y.XmlFragment` named `document` holds BlockNote
blocks, and its root `Y.Map` named `threads` holds BlockNote comment threads. The content model
is BlockNote 0.51's default block schema plus its comment mark. The daemon and every editing
client use the same BlockNote version and change it together; clients never write blocks, inline
content, or marks outside that model. The daemon stores and relays every change unchanged,
including content outside the model, but leaves such content out of Markdown and refuses agent
Markdown writes to a document that contains it.

Binary values on the wire are standard base64: a change is a Yjs update (version 1 encoding), a
state vector is a Yjs state vector, and presence is a y-protocols awareness update.

#### Permanent history

Every accepted change is one entry in the document's permanent, append-only log. `seq` is a
positive integer that increases by exactly one per entry, starting at 1. An entry is:

```json
{
    "seq": 42,
    "actor": { "userId": "u1x2y3z4a5b6c7d8e9f0g1h2", "agentId": null },
    "source": "api",
    "mutationId": "...",
    "createdAt": 1755400000000,
    "size": 318
}
```

`actor.userId` is the authenticated person who sent the change (null in standalone mode or for a
conversion); `actor.agentId` is the agent for tool edits, otherwise null. `source` is `api`,
`tool`, or `conversion`. `mutationId` is the request's value verbatim, or null. `size` is the
decoded change in bytes. The log is never pruned, by event retention, restart, or compaction.
The version at `seq` N is the log replayed through entry N. There is no delete or restore: to
revert, read an old version and write its content as a new change, so history only grows.

A change is at most 1 MiB decoded. A document's stored state is at most 16 MiB encoded and its
Markdown at most 262,144 UTF-16 code units. A change that does not decode as a Yjs update, or
that would exceed a limit, returns `400 invalid_request` and changes nothing. A change that adds
nothing the document does not already contain returns the current `seq` and appends nothing.
Document data has the same access as other Surface data.

#### Routes

The prefix is `/v0/surfaces/document/:surfaceId`. Every route checks the Surface has type
`document`; unknown or wrong-type Surfaces return `404 not_found`. Unsupported body or query
fields and malformed values return `400 invalid_request`.

- `GET` returns `200 { "document": {...}, "cursor": "..." }`, the Markdown projection:

    ```json
    {
        "surfaceId": "s4k8m2q9w1e5r7y3u6i0o2p4",
        "text": "# Notes\n",
        "authorUserId": "u1x2y3z4a5b6c7d8e9f0g1h2",
        "lastEditorUserId": "u1x2y3z4a5b6c7d8e9f0g1h2",
        "createdAt": 1755300000000,
        "updatedAt": 1755400000000,
        "version": "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e",
        "seq": 42
    }
    ```

    `text` is normalized Markdown of the content. Formatting Markdown cannot express, such as
    colors, underline, alignment, and comment threads, is left out. `authorUserId` is the
    immutable Surface creator or null. `lastEditorUserId` is the latest entry's `actor.userId`.
    `updatedAt` is the latest entry's time, or `createdAt` when there is none. `version` is a
    UUIDv7 derived from `seq`; it changes exactly when `seq` does. `seq` is the latest entry's,
    or 0; it is optional on the wire because older daemons omit it. The shared event cursor is
    captured before the read. Optional `?seq=N` returns the projection as of entry N; `N`
    outside 1 through the latest `seq` returns `404 not_found`.

- `PUT` is withdrawn. It returns `405 method_not_allowed` with `Allow: GET` and the message
  "Editing this document needs a newer Happy.", reads no body, and changes nothing.
- `GET /state` returns `200 { "seq": 42, "update": "...", "stateVector": "..." }`: the document's
  current state as one Yjs update, its state vector, and the latest `seq`. Optional
  `?stateVector=` returns only what that state lacks; absent or empty means the whole document.
  Optional `?seq=N` instead returns the whole document as of entry N. Supplying both, or a `seq`
  outside 1 through the latest, is invalid.
- `POST /updates` accepts `{ "mutationId": "...", "update": "..." }`, both required, and returns
  `200 { "seq": 43 }` once the change is stored. It needs no `If-Match`: changes merge. Repeating
  a `mutationId` already accepted for this document returns its original `seq` and appends and
  sends nothing. Clients choose a fresh mutation ID for each change and reuse it only to retry
  that same change.
- `GET /updates` returns `200 { "updates": [...], "nextAfterSeq": null }`: log entries without
  change bytes, oldest first. Optional `afterSeq` is an exclusive non-negative integer; optional
  `limit` is 1 through 200, default 100. `nextAfterSeq` is the last returned `seq` when another
  page exists, otherwise null. New entries never change earlier pages.
- `GET /versions` and `GET /versions/:version` read the Markdown revisions a document had before
  it became collaborative; a document created collaboratively has none. `GET /versions` returns
  `200 { "versions": [...], "nextAfterVersion": null }` with immutable summaries
  `{ "version": "...", "updatedAt": 1755400000000, "actor": { "userId": null, "agentId": null },
"source": "api", "mutationId": "..." }`, oldest first, without text. Optional `afterVersion`
  is an exclusive UUIDv7 cursor belonging to this document (unknown: `404 not_found`); optional
  `limit` is 1 through 200, default 100; `nextAfterVersion` is the last returned version when
  another page exists, otherwise null. `GET /versions/:version` returns `200 { "revision":
{ "document": {...}, "actor": {...}, "source": "api", "mutationId": "..." } }`, the exact
  frozen Markdown snapshot without `seq`. Unknown versions return `404 not_found`.
- `POST /subscribe` accepts `{ "streamId": "..." }` and returns `200 { "seq": 42 }`.
  `POST /unsubscribe` accepts the same body and returns `200 {}`; unsubscribing a stream that is
  not subscribed is a no-op. Both are described under live editing below.
- `POST /presence` accepts `{ "streamId": "...", "awarenessClientId": 123, "update": "..." }`
  and returns `200 {}`. Presence is relayed, never stored. Presence sent through a stream that is
  not subscribed to this document returns `200 {}` and is relayed to nobody.

Every accepted change commits its log entry and stored state in one transaction, composable with
its caller's transaction, and is sent to subscribers only after commit. Writes to one document
are serialized, so entries commit and are sent in `seq` order.

#### Live editing through the event stream

Live changes and presence travel on the existing `GET /v0/events/stream`, so no other connection
is needed. Its `hello` frame carries an optional `streamId`, a CUID2 naming that one stream
connection; it is absent on daemons without collaborative documents. A client subscribes the
stream to each document it has open. Only the person who opened a stream can subscribe it or
send presence through it; another person's, a closed, or an unknown `streamId` returns
`404 not_found`. A stream can be subscribed to at most 32 documents, and a document can have at
most 64 subscribed streams; more returns `409 conflict`.

Subscribed streams receive two kinds of live frame. Live frames have no SSE `id:` line and no
cursor, never enter the event journal, are never replayed, and are sent only to subscribed
streams; a client that never subscribes never receives one, and a reconnect's `Last-Event-ID` is
unaffected.

- `event: document.update` with data `{ "surfaceId": "...", "seq": 43, "update": "...",
"mutationId": "...", "actor": {...}, "source": "api" }`. A stream receives each subscribed
  document's changes in strictly increasing `seq` from the moment it subscribed, including
  changes its own client sent. Applying a change twice is harmless.
- `event: document.presence` with data `{ "surfaceId": "...", "clientKey": "...",
"revision": 7, "active": true, "awarenessClientId": 123, "update": "..." }`. `clientKey` is
  opaque and assigned per stream and document; `revision` increases with each frame for that
  key. A stream never receives its own presence. When the presence's stream closes or
  unsubscribes, or sends no presence for 30 seconds, the others receive
  `{ "surfaceId": "...", "clientKey": "...", "revision": 8, "active": false,
"awarenessClientId": 123 }`. On subscribing, a stream receives the document's current active
  presence.

To catch up, a client reads `GET /state?stateVector=` with its own state vector after
subscribing. A change committed in between arrives in that response, as a frame, or both, which
is harmless. A gap in a document's `seq`, and a stream that was closed for falling behind, are
repaired the same way. A reconnected stream has a new `streamId`, and the old stream's
subscriptions and presence end when it closes; the client subscribes each open document again
and catches up.

Clients batch typing: at most one `POST /updates` in flight per document, at least 200 ms apart.
They send presence at most every 250 ms and refresh it every 15 seconds while it stays active.
Every window shares a few connections per host, so a client never holds a request open waiting
for changes; the event stream delivers them.

#### Older documents

A document stored as Markdown by an earlier daemon becomes collaborative once, the first time it
is read or written, in one transaction: its current text becomes entry 1, with
`source: "conversion"` and a null actor. Its Markdown revisions stay readable at `/versions`.

#### Events

`surface.document.updated` is no longer emitted, and its name is not reused. Document content
never enters the event journal; live clients receive it through subscribed streams, and others
read it on demand. Document content and history are not included in desktop bootstrap.

#### Agent tools

Ordinary models receive `read_document` (`surfaceId`, optional `seq` to read an older version),
`update_document` (`surfaceId`, the `seq` it read, and full replacement Markdown `text`), and
`list_document_versions` (`surfaceId`, optional `afterSeq`, optional `limit` from 1 through 20,
default 10). `read_document` returns the Markdown and the `seq` it was read at, says when
content Markdown cannot show was left out, and, when the document is one of the installation's
important documents, includes its `promptDocument`. `update_document` compares the agent's
Markdown with the version at that `seq`, block by block, and applies only the difference to the
current document as one change, inside the write transaction. Edits people made after that
version are kept, and unchanged text appends nothing. A `seq` outside 1 through the latest is invalid, except
0 for an empty document. A document containing content outside the content model refuses the
write with an error telling the agent why. `list_document_versions` lists log entries.
Reading needs no review; updates are durable and own ordinary shared-data Auto review with no
filesystem elevation. Active admin bots additionally receive `create_document_surface`,
accepting `name`, required explicit `creatorUserId`, optional initial Markdown `text`, and
optional absolute `imagePath`. Its authority, attribution, creator join rules, image handling,
and permission boundaries match `create_todo_surface`. Creation follows the catalog's default
team membership policy; reading or editing document content never joins anyone.

Active admin bots also receive `list_prompt_documents`, `mark_prompt_document`, and
`unmark_prompt_document`, which manage the installation's important documents: one
installation-wide list of document Surfaces that every agent's instructions name, with a
description, as standing guidance to read with `read_document` before acting on work it covers.
`mark_prompt_document` accepts `surfaceId`, a required non-blank `description` of at most 1,024
characters, and an optional `name`. It accepts only an existing document Surface, allows at most
32 marked documents, and leaves the document unchanged. Marking an already marked document
replaces its description and name but keeps its original mark time; an identical mark changes
nothing. `unmark_prompt_document` accepts `surfaceId`; unmarking a document that is not marked
changes nothing. `list_prompt_documents` returns every marked document with its description,
name, mark time, and marking agent, including documents agents can no longer read. Agents see
the list ordered by mark time, oldest first, ties broken by Surface ID. Each entry shows the given
`name`, or else the Surface's live name, together with its `surfaceId` and
`happy://surfaces/<surfaceId>` link. A marked Surface that is missing or no longer a document is
left out. Changes apply from each agent's next model request. Authority is checked at tool
selection and again at execution. Mark and unmark are durable, require Auto or Full access, and
always own Auto review as an installation-wide instruction change with no filesystem elevation.
Listing needs no review. Marking and unmarking change the document Surface's `promptDocument`
field but no Surface version, and emit no event.

### Calendar Surfaces

A `calendar` Surface owns one shared set of calendar events that people and agents create, move,
and edit. Events live only in Happy: there is no external calendar sync, subscription feed, or
import, and the daemon makes no network request for calendar data. Recurring events are expanded
by the daemon. Clients and models read expanded occurrences from the range read and never
compute recurrences themselves.

`POST /v0/surfaces` accepts `{ "type": "calendar", "name": "Team", "id": "...",
"image": { "data": "..." }, "mutationId": "..." }`. Only `type` and `name` are required. It
creates an empty calendar. Images, creator attribution, automatic creator membership,
supplied-ID retries, and `surface.created` follow the catalog rules.

#### Event data

```json
{
    "id": "e4k8m2q9w1e5r7y3u6i0o2p4",
    "surfaceId": "s4k8m2q9w1e5r7y3u6i0o2p4",
    "authorUserId": "u1x2y3z4a5b6c7d8e9f0g1h2",
    "title": "Team sync",
    "notes": "Agenda in the shared doc.",
    "location": "Room 4",
    "timing": {
        "kind": "timed",
        "start": 1760943600000,
        "end": 1760947200000,
        "timeZone": "Europe/Berlin"
    },
    "recurrence": {
        "frequency": "weekly",
        "interval": 1,
        "weekdays": ["monday", "thursday"],
        "until": null,
        "count": 10
    },
    "status": "active",
    "createdAt": 1755300000000,
    "updatedAt": 1755400000000,
    "deletedAt": null,
    "version": "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e"
}
```

`id` is a CUID2. `title` is always a string of 0–1,024 characters with no ASCII control
characters. It may be empty or contain only whitespace; clients show such a title as their own
placeholder, such as "(No title)". `notes` is `null` or 1–10,000 characters with no ASCII control
characters except tab and newline. `location` is `null` or 1–1,024 characters containing a
non-whitespace character and no ASCII control characters. Text is stored exactly as supplied,
without trimming. `status` is `active` or `deleted`. An active event has `deletedAt: null`; a
deleted event is a tombstone with a deletion timestamp that keeps every other field. `createdAt`, `updatedAt`, and `deletedAt` are epoch milliseconds. `version` is a
UUIDv7 resource version.

`authorUserId` follows the todo author rules exactly. It is the installation-local Happy user ID
of the event's author, or `null`, set once at creation, never changed by any edit, deletion, or
application of an earlier state, and repeated unchanged in every revision snapshot.

#### Timing

`timing` is one of two kinds.

- **Timed:** `{ "kind": "timed", "start": 1760943600000, "end": 1760947200000,
"timeZone": "Europe/Berlin" }`. `start` and `end` are instants in epoch milliseconds, with
  `start < end` and both in `0` through `253402300799999` (the end of year 9999 UTC). `timeZone`
  is an IANA time zone name such as `Europe/Berlin`, `America/New_York`, or `UTC`. The daemon
  accepts any name its time zone database recognizes, including links such as `US/Eastern`, and
  stores it exactly as supplied. Numeric offsets such as `+02:00` are not time zones. An
  unrecognized name returns `400 invalid_request`. The time zone gives the event its local
  wall-clock time: the event's local start is `start` read in `timeZone`.
- **All-day:** `{ "kind": "allDay", "startDate": "2026-10-20", "endDate": "2026-10-21" }`.
  Dates are `YYYY-MM-DD` Gregorian calendar dates from `1970-01-01` through `9999-12-31`.
  `endDate` is exclusive and later than `startDate`, so a one-day event on 20 October has
  `endDate: "2026-10-21"`. All-day events have no time zone: they cover the same dates wherever
  they are viewed.

An event lasts at most 366 days: `end - start` is at most 31,622,400,000 ms for timed events, and
`endDate` is at most 366 days after `startDate` for all-day events. A longer event returns
`400 invalid_request`.

#### Recurrence

`recurrence` is `null` for a one-off event, or a rule:

```json
{
    "frequency": "monthly",
    "interval": 1,
    "until": "2027-06-30",
    "count": null
}
```

- `frequency` is `daily`, `weekly`, `monthly`, or `yearly`.
- `interval` is an integer from 1 through 1,000: every `interval` days, weeks, months, or years.
- `weekdays` exists only on weekly rules. It is `null` or 1–7 unique values from `monday`,
  `tuesday`, `wednesday`, `thursday`, `friday`, `saturday`, and `sunday`, stored in that
  Monday-first order whatever order the request used. `null` means the weekday of the event's
  start, and follows the start when the timing changes.
- `until` is `null` or an inclusive `YYYY-MM-DD` date no earlier than the start date.
- `count` is `null` or an integer from 1 through 10,000: the total number of occurrences,
  including the first.

At most one of `until` and `count` is non-null; both `null` repeats forever. A weekly rule with
`weekdays` on a daily, monthly, or yearly frequency, both `until` and `count`, or an `until`
before the start date returns `400 invalid_request`. Requests may omit `interval` (default 1),
`weekdays` (default `null`), `until`, and `count` (default `null`). Responses always include
every field of the rule, so a stored rule can be sent back verbatim.

The **start date** is the event's local start date: `startDate` for all-day events, and the date
of `start` in `timeZone` for timed events. Its **local start time** is the wall-clock time of
`start` in `timeZone`, to the millisecond. The event's own timing is always the first
occurrence, index 0. Later occurrences fall on these local dates after the start date:

- **Daily:** every `interval` days.
- **Weekly:** every listed weekday (or the start's weekday when `weekdays` is `null`) in every
  `interval`-th week. Weeks begin on Monday, and week 0 is the week containing the start date.
  The start is always index 0, even when `weekdays` does not list its weekday.
- **Monthly:** the start date's day of the month, every `interval` months. A month without that
  day is skipped, as in RFC 5545: a series starting on 31 January continues on 31 March, not
  28 February or 3 March.
- **Yearly:** the start date's month and day, every `interval` years. A series starting on
  29 February occurs only in leap years among those selected.

Occurrences are numbered 0, 1, 2, … in date order. Skipped months and years produce no
occurrence and consume no number, and `count` counts produced occurrences only. `until` keeps
occurrences whose local date is on or before it.

Timed occurrences are expanded in the event's own time zone, so the local start time stays fixed
across daylight-saving changes: a 09:00 Berlin meeting stays at 09:00 Berlin time in both summer
and winter, and its instant moves by an hour. Each occurrence's start is its local date at the
local start time, converted to an instant in `timeZone`. A wall-clock time that does not exist
because clocks jumped forward is moved forward by the length of the jump: 02:30 on a day that
skips from 02:00 to 03:00 becomes 03:30. A wall-clock time that occurs twice because clocks went
back uses the earlier instant. This matches RFC 5545 and JavaScript Temporal's `compatible`
disambiguation. Every timed occurrence lasts exactly `end - start` milliseconds. Every all-day
occurrence spans as many days as the event, with `endDate` shifted by the same number of days as
`startDate`.

There are no per-occurrence exceptions. An occurrence cannot be edited, moved, or deleted on its
own: editing or deleting an event changes the whole series. To move a whole series, update the
event's `timing`.

#### Range reads and occurrences

`GET /v0/surfaces/calendar/:surfaceId?from=1759269600000&to=1761951600000&timeZone=Europe%2FBerlin`
returns every occurrence of the calendar's active events that overlaps the instant range
`[from, to)`, with the events they belong to:

```json
{
    "events": [{ "id": "e4k8m2q9w1e5r7y3u6i0o2p4", "...": "..." }],
    "occurrences": [
        {
            "eventId": "e4k8m2q9w1e5r7y3u6i0o2p4",
            "index": 3,
            "timing": {
                "kind": "timed",
                "start": 1761552000000,
                "end": 1761555600000,
                "timeZone": "Europe/Berlin"
            }
        }
    ],
    "truncated": false,
    "cursor": "..."
}
```

- `from` and `to` are required epoch milliseconds written as plain decimal integers, with
  `0 <= from < to <= 253402300800000` and `to - from` at most 100 days (8,640,000,000 ms).
  One month or one week view, including its leading and trailing days, is one read.
- `timeZone` is required: the IANA time zone in which the client shows the range. It decides
  only how all-day occurrences meet the instant range. An all-day occurrence covers
  `[midnight of startDate, midnight of endDate)` in that zone. A midnight that does not exist
  there uses the same forward rule as recurrence expansion. Timed occurrences ignore it.
- A timed occurrence overlaps when its start is before `to` and its end is after `from`. An
  all-day occurrence overlaps when its covered range does, so an occurrence that started before
  the range and is still running is included.
- Each occurrence has `eventId`, its zero-based `index` in the series, and `timing` of the same
  shape as an event's. A timed occurrence repeats its event's `timeZone`. An occurrence's
  identity is `eventId` with `index`, and it is valid only for the event version it was read at.
  A one-off event has exactly one occurrence, index 0, whose timing equals the event's.
- `occurrences` is sorted by start, then all-day before timed at the same start, then `eventId`,
  then `index`. An all-day occurrence's start is its zone midnight for this ordering.
- `events` holds exactly the events referenced by `occurrences`, each once, in ascending ID
  order, as full event objects. Deleted events and their occurrences never appear in a range
  read.
- At most 5,000 occurrences are returned. When more overlap the range, the response holds the
  first 5,000 in the order above and `truncated: true`; the client reads a narrower range.
  Otherwise `truncated` is `false`.
- `cursor` is the shared event cursor captured before the read.

Missing, repeated, or malformed `from`, `to`, or `timeZone`, `from >= to`, or a range over 100
days return `400 invalid_request`. Other query fields are ignored.

#### Permanent history and restoration

Every creation, edit, timing or recurrence change, deletion, and return to active atomically
stores the event's complete new snapshot as an immutable revision, alongside the current event
and its durable notification intent. Publication to the shared event journal follows commit.
A revision is `{ "event": {...}, "actor": { "userId": null, "agentId": null },
"source": "api" }`. Its snapshot holds every field of the event: title, notes, location, timing
kind with its start and end or dates and time zone, the full recurrence rule, status, the
tombstone timestamp, the author, and the version. `actor` and `source` follow the todo revision
rules exactly. They come from trusted execution context, never from a request body, and are
independent of `authorUserId`. A no-op stores neither a revision nor an event. Revisions are
permanent: deletion, later edits, applying an earlier state, restart, and event-journal retention
never remove or change one. All operations participate in a caller's transaction and notify only
after commit.

There is no restore, revert, or undelete route or tool. Any earlier state can be restored exactly
with the ordinary update. To restore one, read a revision and send its `title`, `notes`,
`location`, `timing`, `recurrence`, and `status` through `PATCH` with the current version in
`If-Match`. Every field a revision holds can be set this way. Sending `status: "active"`
undeletes a deleted event. `title: ""` empties the title, and `notes: null` and
`location: null` clear them. `recurrence: null` removes a rule, and a full rule replaces one.
`timing` switches freely between timed and all-day.
A revision's `recurrence` is accepted verbatim. The result equals that revision in every editable
field. Server-owned fields stay server-owned: `id`, `surfaceId`, `authorUserId`, and `createdAt`
never change, `updatedAt` and `version` are new, and a restored deleted state gets a new
`deletedAt`. Applying an earlier state appends exactly one new revision and never rewrites the
revision it came from. Applying a state equal to the current one is a no-op.

All mutations of existing events require `If-Match` with the current event version. Missing or
malformed headers return `400 invalid_request`. A stale one returns `409 conflict` with
`currentVersion` and the authoritative `event`, including when it is deleted. Unknown event IDs
return `404 not_found`. Invalid bodies, unsupported fields, and malformed paging parameters return
`400 invalid_request`. Creation does not use `If-Match`.

#### Routes

The prefix is `/v0/surfaces/calendar/:surfaceId`. Every operation checks that the Surface has
type `calendar` and scopes event and revision lookups to that instance. Unknown Surfaces, a
Surface of another type, and events or revisions belonging to a different Surface return
`404 not_found`. Calendar routes given a todo, document, or reference Surface also return
`404 not_found`, as todo and document routes do for a calendar.

- `GET` is the range read above.
- `POST` accepts `{ "title": "Team sync", "notes": null, "location": "Room 4", "timing": {...},
"recurrence": {...}, "id": "...", "mutationId": "..." }`. Only `timing` is required. `title`
  defaults to `""`, `notes`, `location`, and `recurrence` default to `null`, and `id` and
  `mutationId` are optional. Creation records the authenticated caller as `authorUserId`
  (`null` in standalone mode), stores an active event, and returns `201 { "event": {...} }`,
  emitting shared
  `calendar_event.created`. A repeated supplied ID returns the current event unchanged with
  `201`, even after deletion or restart, and emits no event; the other fields are ignored. This
  ID is the creation retry key, and `mutationId` is only an echo. HTTP bodies cannot supply
  `authorUserId`, `status`, or timestamps.
- `GET /:eventId` returns `200 { "event": {...} }`, including deleted tombstones.
- `PATCH /:eventId` accepts any non-empty subset of `title`, `notes`, `location`, `timing`,
  `recurrence`, and `status`, plus optional `mutationId`. It requires at least one of those six
  fields. `status` is `active` or `deleted`. `timing` and `recurrence` replace the whole value;
  there is no partial merge inside them. The resulting event must be valid as a whole. For
  example, moving the timing past a rule's `until` returns `400 invalid_request` unless the same
  request also changes the rule. Fields may be edited in any status. Moving to `deleted` sets a
  new `deletedAt`. Moving to `active` clears it. Repeating the current status keeps its
  timestamp. An identical edit is a no-op. The response is `200 { "event": {...} }`, and a
  change emits `calendar_event.updated`. Dragging an event or an occurrence to a new time is one
  `PATCH` of `timing`. Resizing it is the same. Because there are no per-occurrence exceptions,
  a client moving an occurrence of a series applies the same shift to the event's own timing.
- `DELETE /:eventId` accepts `{}` or `{ "mutationId": "..." }`, marks the event deleted, and
  returns `200 { "event": {...} }`. Already deleted is a no-op after checking `If-Match`. A
  change emits `calendar_event.updated`. Deletion never removes a revision.
- `GET /:eventId/versions` returns `200` with `versions` (immutable revisions, oldest first) and
  `nextAfterVersion` (a UUIDv7 or `null`). `afterVersion` is an optional exclusive UUIDv7
  revision cursor belonging to this event, and unknown cursors return `404 not_found`. `limit`
  is optional, default 100, from 1 through 200. `nextAfterVersion` names this page's last
  revision when another page exists, otherwise `null`. Appending revisions never changes prior
  pages.
- `GET /:eventId/versions/:version` returns `200 { "revision": {...} }` for that immutable
  revision. Unknown versions return `404 not_found`.

#### Events

`calendar_event.created` carries the full `event` and optional `mutationId`.
`calendar_event.updated` carries `surfaceId`, `eventId`, `previousVersion`, `version`, `changes`,
and optional `mutationId`. `changes` holds the changed fields among `title`, `notes`,
`location`, `timing`, `recurrence`, `status`, and `deletedAt`, always with `updatedAt`. `timing`
and `recurrence` appear whole. Both events are shared. Consumers follow normal version-chain
reconciliation and refetch an event on a gap. Events carry series records, not occurrences: a
client showing a range reads that range again after a `calendar_event.*` event for its calendar,
and never derives occurrences from a payload. Calendar events, occurrences, and history are not
part of desktop bootstrap; opening a calendar reads its visible range with that read's cursor.

#### Agent tools

Every ordinary agent model receives fixed common tools `list_calendar_events`,
`create_calendar_event`, `update_calendar_event`, `delete_calendar_event`, and
`list_calendar_event_versions`. They call the same typed operations as the API. Tools state times
as ISO 8601 text instead of epoch milliseconds, so models never convert instants themselves:

- A tool **timed** timing is `{ "kind": "timed", "start": "2026-10-20T09:00",
"end": "2026-10-20T10:00", "timeZone": "Europe/Berlin" }`. `start` and `end` are local
  wall-clock date-times in `timeZone`, written `YYYY-MM-DDTHH:mm`, with optional `:ss` and
  `.sss`. An optional trailing offset (`+02:00`, `-05:00`, or `Z`) must equal `timeZone`'s
  offset at that wall-clock time, or the call is invalid. The offset selects between the two
  instants of a repeated hour. Without an offset, the daemon applies the expansion rule: a
  skipped time moves forward, and a repeated time uses the earlier instant. **All-day** timing
  is the API form, with `endDate` exclusive. Recurrence rules are the API form.
- Tool output writes every timed value as a local date-time with its offset, such as
  `2026-10-20T09:00:00+02:00`, so any tool output can be passed back as tool input. An event's
  and a revision's timing is written in the event's own `timeZone`.

The tools are:

- `list_calendar_events` accepts `surfaceId`, `from`, `to`, and `timeZone`. `from` and `to` are
  local dates (`YYYY-MM-DD`, meaning midnight) or local date-times in `timeZone`, with `from`
  before `to` and at most 100 days apart. It returns `timeZone`, the occurrences overlapping the
  range, the active events they belong to (with versions for guarded edits), and `truncated`.
  Occurrence times are written in the requested `timeZone`, the zone the person thinks in. Each
  occurrence names its `eventId` and `index`. At most 200 occurrences are returned, in the range
  read's order. When more exist, `truncated` is `true` and the description tells the model to
  narrow the range. It is the same daemon expansion as the range read.
- `create_calendar_event` accepts `surfaceId`, optional `title` (default `""`, which may be
  blank), optional `notes` and `location`, `timing`, optional `recurrence`, and a required
  explicit `authorUserId`, with the exact semantics, validation, and replay of `create_todo`'s
  `authorUserId`.
- `update_calendar_event` accepts `surfaceId`, `eventId`, the `version` it read, and any of
  `title`, `notes` (string or `null`), `location` (string or `null`), `timing`, `recurrence`
  (rule or `null`), and `status` (`active` or `deleted`). Its description tells models that
  edits change the whole series, and that restoring means reading a revision with
  `list_calendar_event_versions` and passing its fields here with the current version.
  `status: "active"` undeletes.
- `delete_calendar_event` accepts `surfaceId`, `eventId`, and `version`, and tombstones the whole
  series while keeping every revision.
- `list_calendar_event_versions` accepts `surfaceId`, `eventId`, optional `afterVersion`, and
  optional `limit` from 1 through 20, default 10. It returns full revisions oldest first, with
  their actors and with timing in the tool form, and `nextAfterVersion`. Like todos, there is no
  separate single-revision tool. Each page entry is the complete snapshot.

Mutation tools supply the version they read and receive an explicit conflict on a stale version.
Read tools require no review. Mutation tools are durable and transactional, own ordinary
shared-data Auto review, and run within the current permission boundary without filesystem
elevation. Durable replay of a creation reuses its call-stable event ID. Every replay returns
the committed result without appending another revision or event. Reading or modifying events
never joins anyone to the Surface.

Active admin bots additionally receive `create_calendar_surface`, accepting `name`, required
explicit `creatorUserId`, and optional absolute `imagePath`. Its authority, attribution, creator
join rules, image handling, durable replay, and permission boundaries match
`create_todo_surface`.

### System Monitor Surfaces

A `system_monitor` Surface displays the machine running the daemon. Multiple named instances may
exist; they all read the same daemon-wide sampler. Catalog, managed images, attribution, creator
membership, shared chat, and creation replay follow the ordinary Surface rules.
`POST /v0/surfaces` accepts `{ "type": "system_monitor", "name": "System Monitor" }`, with
optional `id`, `image`, and `mutationId`. It accepts no host selector or probe configuration.

#### `GET /v0/surfaces/system-monitor/:surfaceId`

Returns `200` with the snapshot directly (no response envelope or event cursor). A malformed,
missing, or differently typed Surface ID returns `404 not_found`.

```json
{
    "sampledAt": 1760943600000,
    "intervalMs": 1000,
    "host": {
        "hostname": "build-box",
        "platform": "linux",
        "arch": "x64",
        "osName": "Ubuntu 24.04.1 LTS",
        "uptimeSeconds": 123456
    },
    "cpu": {
        "model": "AMD Ryzen 9 7950X",
        "logicalCores": 2,
        "usagePercent": 26.05,
        "perCoreUsagePercent": [12, 40.1],
        "loadAverage": [1.2, 0.9, 0.7],
        "speedMhz": 4500,
        "temperatureCelsius": null
    },
    "memory": {
        "totalBytes": 34359738368,
        "usedBytes": 8589934592,
        "availableBytes": 25769803776,
        "cachedBytes": 2147483648,
        "swapTotalBytes": 0,
        "swapUsedBytes": 0
    },
    "gpus": [
        {
            "name": "NVIDIA GeForce RTX 4090",
            "vendor": "nvidia",
            "usagePercent": 12,
            "memoryTotalBytes": null,
            "memoryUsedBytes": null,
            "temperatureCelsius": 45,
            "powerWatts": 60.5
        }
    ],
    "disks": [
        {
            "mountPoint": "/",
            "device": "/dev/nvme0n1p2",
            "fileSystem": "ext4",
            "totalBytes": 1000000000000,
            "usedBytes": 400000000000,
            "availableBytes": 600000000000
        }
    ],
    "diskIo": { "readBytesPerSecond": 0, "writeBytesPerSecond": 0 },
    "processes": {
        "total": 123,
        "threads": 456,
        "items": [
            {
                "pid": 1234,
                "parentPid": 1,
                "name": "node",
                "user": "steve",
                "state": "running",
                "cpuPercent": 12.5,
                "memoryBytes": 268435456,
                "threads": 12,
                "startedAt": 1760940000000
            }
        ]
    },
    "history": [
        {
            "sampledAt": 1760943600000,
            "cpuPercent": 26.05,
            "memoryUsedBytes": 8589934592,
            "gpuPercent": 12,
            "diskReadBytesPerSecond": 0,
            "diskWriteBytesPerSecond": 0
        }
    ]
}
```

All fields shown are present. `sampledAt` is epoch milliseconds; `intervalMs` is the recommended
visible-client polling interval, currently 1000. Strings identify the daemon's host; `platform`
and `arch` use Node's platform and architecture names. `uptimeSeconds` is nonnegative.
`cpu.model` is a string and `logicalCores` a nonnegative integer. All CPU measurement fields
are nullable: `usagePercent`, `perCoreUsagePercent` (an array ordered by logical CPU),
`loadAverage` (exactly three numbers), `speedMhz`, and `temperatureCelsius`. CPU usage needs two
observations; unavailable initial values are null. Windows load averages are null.
`memory.totalBytes`, `usedBytes`, and `availableBytes` are nonnegative numbers. Used memory
excludes reclaimable page cache, using the operating system's available-memory accounting;
macOS derives it from `vm_stat` and `sysctl`. `cachedBytes`, `swapTotalBytes`, and `swapUsedBytes`
are nullable. Byte counts and rates are nonnegative numbers, not necessarily safe integers.
When platform-native memory accounting is unavailable, the daemon falls back to Node's
`os.totalmem()` and `os.freemem()`: `usedBytes` is total minus free, `availableBytes` is free,
and `cachedBytes` is null. This fallback may include reclaimable cache in used memory.

`gpus` is empty when no GPU can be discovered. GPU `name` is a string and `vendor` is `nvidia`,
`amd`, `apple`, `intel`, or `other`. Every GPU measurement is nullable. Percentages are from 0
through 100; temperatures are Celsius and power is watts. `disks` contains real mounted volumes
only, excluding virtual filesystems such as tmpfs, overlay, proc, and snap squashfs. Each disk's
three byte counts are nonnegative numbers, `mountPoint` and `device` are strings, and `fileSystem`
is a nullable string. An unavailable disk probe returns an empty array. `diskIo` is null when
unavailable; otherwise both rates are nonnegative numbers and aggregate physical-device activity
without counting partitions again. GPU history uses the maximum available device utilization,
or null. History CPU and disk-rate fields are nullable like their current measurements.

`processes` is null when process telemetry is unavailable. Otherwise `total` is the nonnegative
integer count of processes observed, `threads` is the total thread count or null, and `items`
contains at most 100 readable processes: the union of the top 50 by measured CPU and the top 50
by resident memory. It is sorted by CPU descending (unknown CPU last), then resident memory
descending, then PID ascending; a process appears only once. With fewer processes, all readable
ones appear. Each item has a nonnegative integer `pid`, nullable nonnegative integer `parentPid`,
string `name`, nullable string `user`, nullable `state` (`running`, `sleeping`, `stopped`,
`zombie`, `idle`, or `other`), nullable `cpuPercent` from 0 through 100, nonnegative resident
`memoryBytes`, nullable nonnegative integer `threads`, and nullable epoch-millisecond
`startedAt`. Process CPU is the share of the whole machine on the same scale as
`cpu.usagePercent`, rather than a percentage of one core. Initial or unavailable process CPU
measurements are null. PID reuse resets the CPU baseline using the process start identity.
`name` contains only the executable basename or operating system process name (comm), never
command-line arguments, paths, or environment values. All authenticated people and models can
read this data; command lines and environments may contain credentials and are never collected.
Process sampling has the same time and output bounds as other probes and runs independently,
so a slow scan never delays CPU, memory, disk, or GPU sampling. It may refresh less frequently
on expensive platforms, with a sampling interval of at most five seconds, reusing the last result between scans.
A failed scan returns null rather than retaining an indefinitely stale process list.

The sampler starts lazily on the first read, samples about once per second without overlapping
passes, stops after 60 seconds without a read, and keeps at most 300 history entries oldest first
in memory. History is neither persisted nor journaled. The first read waits at most 1500 ms for
sampling; a slow or failed probe never prevents a snapshot response. Unavailable measurements
are null or empty arrays, never fabricated zero utilization. External probes are bounded in
time and output and belong to a named sampler context rooted in the daemon lifetime. Requests
read the shared latest snapshot; they never start their own probe processes. Telemetry emits no
events and never changes the Surface version or membership. A daemon restart resets history.

Ordinary models receive `read_system_monitor`, accepting `surfaceId`, with no Auto review. It
returns a concise human-readable host and resource summary, including the top five available
processes by CPU and the top five by resident memory. Active admin bots additionally
receive `create_system_monitor_surface`, accepting `name`, required explicit `creatorUserId`,
and optional absolute `imagePath`. Authority checks at selection and execution, attribution,
creator joins, image handling, durable replay, and permission boundaries match
`create_todo_surface`.

### Chat Surfaces

A `chat` Surface is a conversation among people. Members post Markdown messages to it; agents
never post, edit, or delete them. A daemon that serves it reports `capabilities.chatSurfaces: true`
from health.

A chat Surface's **messages** are different from its **shared Surface chat**. Every chat-enabled
Surface, a `chat` Surface included, may own one contextual agent conversation through
`chatAgentId` and `POST /v0/surfaces/:surfaceId/chat`, described under Shared Surface chats. That
agent conversation uses the ordinary agent message routes and `message.*` events. The people's
messages described here are a separate resource with their own routes under
`/v0/surfaces/chat/:surfaceId/messages`, their own `surface_message.*` events, and their own
history. Neither ever appears in the other. In this section, "message" always means a Surface
message.

`POST /v0/surfaces` accepts `{ "type": "chat", "name": "Design team", "id": "...",
"image": { "data": "..." }, "mutationId": "..." }`. Only `type` and `name` are required. It
creates an empty conversation. Images, creator attribution, automatic creator membership,
supplied-ID retries, and `surface.created` follow the catalog rules.

#### Message data

```json
{
    "id": "m4k8m2q9w1e5r7y3u6i0o2p4",
    "surfaceId": "s4k8m2q9w1e5r7y3u6i0o2p4",
    "seq": 42,
    "authorUserId": "u1x2y3z4a5b6c7d8e9f0g1h2",
    "text": "Shipping the **beta** on Friday.",
    "status": "active",
    "createdAt": 1755300000000,
    "updatedAt": 1755400000000,
    "editedAt": 1755400000000,
    "deletedAt": null,
    "version": "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e"
}
```

`id` is a CUID2. `seq` is the message's position in its Surface: a positive integer assigned at
creation, starting at 1 and increasing by exactly one per message, never reused or changed.
Messages are ordered by `seq`, which is also their creation order. `text` is Markdown stored
exactly as supplied: 1–20,000 UTF-16 code units, containing a non-whitespace character, and no
ASCII control characters except tab and newline. Clients render it as Markdown. `status` is
`active` or `deleted`. `createdAt`, `updatedAt`, `editedAt`, and `deletedAt` are epoch
milliseconds. `editedAt` is `null` until the text first changes and then holds the time of the
latest text change. A deleted message is a tombstone: `deletedAt` is its deletion time, and it
keeps every other field, including its last text. Clients show a deleted message as a
placeholder such as "This message was deleted" and never render its text in the conversation.
`version` is a UUIDv7 resource version.

`authorUserId` is the installation-local Happy user ID of the person who posted the message,
resolvable through `GET /v0/users`, or `null` in standalone mode. It is set at creation from the
authenticated caller, never from a request body, and never changes. It appears unchanged in
every revision snapshot.

Only a message's author may edit or delete it. In team mode, the authenticated caller's user ID
must equal `authorUserId`; any other person, including for a message with a `null` author,
receives `403 forbidden` and changes nothing. In standalone mode the installation's one person
is the author of every message. Clients compare `authorUserId` with the caller's own identity to
decide whether to offer editing; responses carry no caller-relative permission field.

Every authenticated person may read every message and post to any chat Surface, whether or not
they joined it, as with all Surface data. Posting, reading, editing, and deleting never join
anyone to the Surface.

#### Permanent history

Every creation, text edit, and deletion atomically stores the message's complete new snapshot as
an immutable revision, alongside the current message and its durable notification intent.
Publication to the shared event journal follows commit. A revision is `{ "message": {...},
"actor": { "userId": null, "agentId": null }, "source": "api" }`. `actor` and `source` follow
the todo revision rules; because agents cannot change messages, `actor.agentId` is `null` and
`source` is `api`. A no-op stores neither a revision nor an event. Revisions are permanent:
later edits, deletion, restart, and event-journal retention never remove or change one. A
deleted message's earlier text stays readable through its revisions by everyone who can read
the Surface. All operations participate in a caller's transaction and notify only after commit.

There is no restore or undelete. A deleted message stays deleted. An author may return a live
message to earlier text by reading a revision and sending that text through the ordinary edit.

All mutations of existing messages require `If-Match` with the current message version. Checks
run in this order: an unknown Surface or message returns `404 not_found`; a caller who is not the
author returns `403 forbidden`; a missing or malformed `If-Match` returns `400 invalid_request`;
a stale one returns `409 conflict` with `currentVersion` and the authoritative `message`; an
invalid body returns `400 invalid_request`; and editing a deleted message returns `409 conflict`
with the current `message`. Creation does not use `If-Match`.

#### Routes

The prefix is `/v0/surfaces/chat/:surfaceId/messages`. Every operation checks that the Surface has
type `chat` and scopes message and revision lookups to that instance. Unknown Surfaces, a Surface
of another type, and messages or revisions belonging to a different Surface return
`404 not_found`. Todo, document, and calendar routes given a chat Surface also return
`404 not_found`. `/v0/surfaces/chat/:surfaceId` without `/messages` is not a route. Unsupported
body fields and malformed values return `400 invalid_request`.

- `GET` returns `200 { "messages": [...], "nextBeforeSeq": 12, "nextAfterSeq": null,
"cursor": "..." }`, one page of messages, oldest first, including tombstones. Optional
  `beforeSeq` is an exclusive positive integer and optional `afterSeq` an exclusive non-negative
  integer, so `afterSeq=0` reads from the first message; supplying both returns
  `400 invalid_request`. Optional `limit` is 1 through 200, default 50. Without `afterSeq`, the
  page holds the newest `limit` messages with `seq` below `beforeSeq`, or the newest `limit`
  messages overall when `beforeSeq` is absent: a client opening a conversation reads this page,
  then reads older pages with `beforeSeq: nextBeforeSeq`. With `afterSeq`, the page holds the
  oldest `limit` messages with `seq` above it: a client catching up reads forward with
  `afterSeq` set to the newest `seq` it holds, then `nextAfterSeq`. `nextBeforeSeq` is the first
  returned message's `seq` when the Surface has a message with a smaller `seq`, and
  `nextAfterSeq` is the last returned message's `seq` when it has a message with a larger `seq`;
  each is otherwise `null`. An empty Surface returns `messages: []` with both `null`. New
  messages never change which messages an earlier `beforeSeq` page holds, and edits and
  deletions change messages in place, never their `seq`. `cursor` is the shared event cursor
  captured before the read. Repeated or malformed paging parameters return
  `400 invalid_request`; other query fields are ignored.
- `POST` accepts `{ "text": "Shipping on Friday.", "id": "...", "mutationId": "..." }`. `id` and
  `mutationId` are optional. Creation records the authenticated caller as `authorUserId`, assigns
  the next `seq`, and returns `201 { "message": {...} }`, emitting shared
  `surface_message.created`. A repeated supplied ID returns the current message unchanged with
  `201`, even after deletion or restart, and emits no event; the other fields are ignored. This
  ID is the creation retry key, and `mutationId` is only an echo. Clients generate the ID before
  sending, so a retry after a lost response never posts twice.
- `GET /:messageId` returns `200 { "message": {...} }`, including tombstones.
- `PATCH /:messageId` accepts `{ "text": "...", "mutationId": "..." }`; `text` is required. It
  replaces the text and sets `editedAt`. Identical text is a no-op. The response is
  `200 { "message": {...} }`, and a change emits `surface_message.updated`.
- `DELETE /:messageId` accepts `{}` or `{ "mutationId": "..." }`, marks the message deleted, and
  returns `200 { "message": {...} }`. Already deleted is a no-op after the author and `If-Match`
  checks. A change emits `surface_message.updated`. Deletion never removes a revision.
- `GET /:messageId/versions` returns `200` with `versions` (immutable revisions, oldest first) and
  `nextAfterVersion` (a UUIDv7 or `null`). `afterVersion` is an optional exclusive UUIDv7
  revision cursor belonging to this message, and unknown cursors return `404 not_found`. `limit`
  is optional, default 100, from 1 through 200. `nextAfterVersion` names this page's last
  revision when another page exists, otherwise `null`. Appending revisions never changes prior
  pages.
- `GET /:messageId/versions/:version` returns `200 { "revision": {...} }` for that immutable
  revision. Unknown versions return `404 not_found`.

#### Events

`surface_message.created` carries the full `message` and optional `mutationId`.
`surface_message.updated` carries `surfaceId`, `messageId`, `previousVersion`, `version`,
`changes`, and optional `mutationId`. `changes` holds the changed fields among `text`,
`editedAt`, `status`, and `deletedAt`, always with `updatedAt`. Both events are shared and
journaled, so every connected client receives new, edited, and deleted messages live through the
ordinary event stream. Consumers follow normal version-chain reconciliation and refetch a message
on a gap. A client showing a conversation appends `surface_message.created` messages in `seq`
order; when a created message's `seq` is not one more than the newest it holds, it reads forward
with `afterSeq` instead of guessing. Messages and their history are not part of desktop
bootstrap; opening a conversation reads its newest page with that read's cursor.

#### Agent tools

Agents read a conversation but never take part in it. Every ordinary agent model receives fixed
common read-only tools; there is no tool to post, edit, or delete a message.

- `list_surface_messages` accepts `surfaceId`, optional exclusive `beforeSeq` or `afterSeq` (not
  both), and optional `limit` from 1 through 50, default 30. It returns the same page as the
  `GET` route, oldest first, with `nextBeforeSeq` and `nextAfterSeq`. Each message carries its
  `id`, `seq`, `authorUserId`, `text`, `status`, `createdAt`, `editedAt`, and `deletedAt`. A
  deleted message is listed without its text. The description tells models to resolve authors
  through the people they know, to treat deleted messages as withdrawn, and to read older pages
  with `beforeSeq` to summarize a longer conversation.
- `list_surface_message_versions` accepts `surfaceId`, `messageId`, optional `afterVersion`, and
  optional `limit` from 1 through 20, default 10. It returns full revisions oldest first, with
  their actors, and `nextAfterVersion`. Each entry is the complete snapshot.

Both require no review and run within the current permission boundary. Reading never joins
anyone to the Surface. Active admin bots additionally receive `create_chat_surface`, accepting
`name`, required explicit `creatorUserId`, and optional absolute `imagePath`. Its authority,
attribution, creator join rules, image handling, durable replay, and permission boundaries match
`create_todo_surface`.

### Vault Surfaces

A `vault` Surface is a shared file store shaped like a file system without being one: a tree of
folders, files, and vault apps that people browse like a Finder window or search, and that
keeps earlier versions of every file under a retention policy the vault's people choose. A daemon
that serves vaults reports `capabilities.vaults: true` from health.

`POST /v0/surfaces` accepts `{ "type": "vault", "name": "Studio", "retention": {...},
"id": "...", "image": { "data": "..." }, "mutationId": "..." }`. Only `type` and `name` are
required. Optional `retention` is the vault's first retention policy, described under Retention;
without it the vault gets the default policy. It creates an empty vault and its settings in the
same transaction as the Surface. Images, creator attribution, automatic creator membership,
supplied-ID retries, and `surface.created` follow the catalog rules. Repeating an existing Surface
ID changes nothing, including its settings.

Vault content lives on the daemon's machine, in its private data directory (`.happy/agent/vaults`).
Content is stored once per SHA-256, across all vaults, so content kept by several versions, files,
or vaults is one file on disk, and moving or renaming never touches stored bytes. Nothing is
ever written into a working directory. Agents never reach vault storage through their own file
system; they use the vault tools below. Vault data has the same access as other Surface data: every
onboarded authenticated person may read and change every vault, and guests never may.

#### Folders and files

A vault holds **folders** and **files**; together they are its **items**. A folder holds other
items and may be empty. A file is either a plain file or an artifact, a vault app kept as one
file, and every file has numbered versions; folders have none. Storage is flat: an item names its
parent folder, and the vault's root is not a folder. Every item has a `kind`, `"folder"`, `"file"`,
or `"artifact"`, so a list holding both tells them apart, and an item's kind never changes.

A folder:

```json
{
    "id": "f7k2m9q4w1e5t8y3u6i0o2p5",
    "surfaceId": "s4k8m2q9w1e5r7y3u6i0o2p4",
    "parentId": null,
    "name": "Reports",
    "kind": "folder",
    "createdAt": 1755300000000,
    "createdBy": { "userId": "u1x2y3z4a5b6c7d8e9f0g1h2", "agentId": null },
    "updatedAt": 1755300000000,
    "updatedBy": { "userId": "u1x2y3z4a5b6c7d8e9f0g1h2", "agentId": null },
    "deletedAt": null,
    "version": "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e"
}
```

A file:

```json
{
    "id": "e4k8m2q9w1e5r7y3u6i0o2p4",
    "surfaceId": "s4k8m2q9w1e5r7y3u6i0o2p4",
    "parentId": "f7k2m9q4w1e5t8y3u6i0o2p5",
    "name": "summary.pdf",
    "kind": "file",
    "latestVersion": 3,
    "size": 48213,
    "sha256": "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
    "mediaType": "application/pdf",
    "artifact": null,
    "createdAt": 1755300000000,
    "createdBy": { "userId": "u1x2y3z4a5b6c7d8e9f0g1h2", "agentId": null },
    "updatedAt": 1755400000000,
    "updatedBy": { "userId": null, "agentId": "a9b8c7d6e5f4g3h2i1j0k9l8" },
    "deletedAt": null,
    "version": "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e"
}
```

Both have:

- `id` — a CUID2, the item's identity, unique across the vault's folders and files. Paths are
  derived from names and change when an item or one of its folders is renamed or moved; the ID
  never does.
- `parentId` — the folder holding the item, or `null` at the vault's root.
- `kind` — `"folder"` for a folder; `"file"` or `"artifact"` for a file.
- `createdBy`, `updatedBy` — actors `{ "userId": ..., "agentId": ... }`, resolved from trusted
  execution context as for todo revisions: `userId` is the authenticated person for HTTP, or the
  identified person whose message an agent is working on, and `null` in standalone mode or when
  nobody is identified; `agentId` is the executing agent for tools and `null` for HTTP.
  `updatedBy` and `updatedAt` describe the item's latest change of any kind.
- `deletedAt` — when the item itself was moved to the Trash, or `null`. See Trash.
- `version` — the UUIDv7 resource version. It covers every field and advances on every change to
  the item. It is unrelated to a file's numbered content versions below.

A file also has:

- `latestVersion` — the number of its newest version.
- `size` — bytes of its newest version, or of all files of an artifact's newest version together.
  A plain file may be empty.
- `sha256` — the lowercase hexadecimal SHA-256 of a plain file's newest version; `null` for an
  artifact.
- `mediaType` — a plain file's media type, decided by the daemon from its name's extension with
  the artifact extension table, `application/octet-stream` when the extension is unknown. Renaming
  can change it. `null` for an artifact.
- `artifact` — for an artifact, its newest version's `{ "type": "html", "entry": "index.html",
"fileCount": 12 }`, described under Artifacts; `null` for a plain file.

A **name** is 1–255 bytes of UTF-8 after Unicode NFC normalization, which the daemon applies and
stores. It holds no `/`, `\`, or ASCII control character, and is not `.` or `..`. Names are unique
among a folder's live children, folders and files together, case-insensitively: two names collide
when their NFC forms are equal after Unicode default lowercasing, so `Report.pdf` and `report.PDF`
cannot sit side by side, and a vault exported to a case-insensitive file system loses nothing.
Names keep the case they were given. A **path** is `/` followed by the names from the root down,
joined with `/`, such as `/Reports/Q3/summary.pdf`. Paths are resolved case-insensitively, so
`/reports/q3/SUMMARY.pdf` names the same file. An item is at most 64 levels below the root. A
folder cannot be moved into itself or into a folder inside it.

An artifact's name ends in `.artifact`, such as `launch.artifact`, and only an artifact's name
does: the suffix, matched case-insensitively, is how people, clients, and agents recognize an
artifact in the tree, in paths, and on disk after a download, and it decides whether a new file is
an artifact. Creating, renaming, restoring under a new name, moving, or copying is refused with
`400 invalid_request` when an artifact's new name would lose the suffix or a folder's or plain
file's would gain it.

Items have no manual order. Listings put folders first, then plain files and artifacts together,
sorted as the request asks. Folders are never removed for being empty.

#### Trash

Deleting moves an item to the vault's Trash: it sets the item's own `deletedAt` and nothing else.
Deleting a folder takes everything inside it along without touching those items. An item is **in
the Trash** when it or any folder above it is deleted, and **live** otherwise. Only live items
appear in listings, the tree, path resolution, and search, and only live folders can hold new or
moved items. A **Trash item** is a deleted folder or file whose folders are all live; the Trash
lists those.

Restoring a Trash item clears its `deletedAt`, bringing back everything inside it that was not
deleted separately before; an item deleted on its own earlier stays in the Trash inside the
restored folder, and is a Trash item again. A restored item returns to its folder, or to the
vault's root when that folder is no longer live, unless the request names another live folder and,
optionally, a new name. An item inside a deleted folder is not a Trash item, so it cannot be
restored on its own; restore its folder first.

An item in the Trash cannot be renamed, moved, or given a new version. Its history and content stay
readable, so people can look at what they are about to restore. Trash items are removed
permanently, with everything inside them, their versions, and their activity, once they have been
in the Trash for the policy's `trashDays`. That is the only way an item ever disappears.

#### Versions

Every content change of a file appends one version. Folders have no versions.

```json
{
    "fileId": "e4k8m2q9w1e5r7y3u6i0o2p4",
    "surfaceId": "s4k8m2q9w1e5r7y3u6i0o2p4",
    "number": 3,
    "size": 48213,
    "sha256": "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
    "artifact": null,
    "pinned": false,
    "restoredFrom": null,
    "createdAt": 1755400000000,
    "actor": { "userId": null, "agentId": "a9b8c7d6e5f4g3h2i1j0k9l8" },
    "source": "tool"
}
```

- `number` — from 1, the next number for every new version of the file. Numbers of pruned
  versions are never reused.
- `size`, `sha256` — a plain file's bytes and digest; for an artifact, `size` is all its files
  together and `sha256` is `null`.
- `artifact` — for an artifact version, `{ "type", "entry", "fileCount" }`; `null` for a plain
  file. A single-version read adds `files`, the version's whole file list, as described under
  Artifacts.
- `pinned` — whether a person pinned the version. Pinned versions are never pruned.
- `restoredFrom` — the number of the version whose content this version copied, when it was made
  from an earlier version; otherwise `null`.
- `actor`, `source` — who made the version, as for item actors, and `"api"` or `"tool"`.

A version never changes after it is made, except for `pinned`. Writing content identical to the
newest version makes no version and changes nothing. Renames, moves, deletion, and restoration are
not versions; the activity log records them. Restoring an earlier version is an ordinary write
whose content is that version's: it appends a new version with `restoredFrom` set, so history
only grows.

One agent makes at most 100 versions of one file in any hour through its tools; a write beyond
that fails and asks the agent to make its changes in fewer calls. People are not limited. This
keeps a looping agent from pushing a vault's history out through a count-based policy.

#### Retention

Each vault has one retention policy, applied to every file in it, in the Trash too:

```json
{
    "maxVersions": null,
    "maxAgeDays": null,
    "keepAllDays": 1,
    "thinning": [
        { "afterDays": 1, "everyDays": 1 },
        { "afterDays": 30, "everyDays": 7 }
    ],
    "trashDays": 30
}
```

- `maxVersions` — keep at most this many versions of each file, the newest included; an
  integer from 1 through 10,000, or `null` for no cap. Pinned versions are not counted.
- `maxAgeDays` — drop versions older than this many days; an integer from 1 through 36,500, or
  `null` to keep them however old.
- `keepAllDays` — keep every version younger than this many days; an integer from 0 through 36,500.
- `thinning` — up to 8 tiers, in strictly increasing `afterDays`. A tier applies to versions at
  least `afterDays` old (an integer from 0 through 36,500) and keeps one version in every
  `everyDays` (an integer from 1 through 3,650).
- `trashDays` — how many days a Trash item stays before it is removed; an integer from 1 through
  3,650, or `null` to keep it until it is restored.

The JSON above is the default policy, a Time Machine schedule: every version for a day, one a day
until 30 days, one a week after that, and no cap. For each file, versions are kept or dropped
in this order:

1. The newest version and every pinned version are always kept, and are left out of the steps below.
2. A version older than `maxAgeDays` is dropped.
3. A version younger than `keepAllDays` is kept.
4. Otherwise the version belongs to the tier with the largest `afterDays` not above its age. With
   no such tier it is kept. Within a tier, time is divided into buckets of `everyDays` days counted
   from the Unix epoch, and the newest of the file's versions that belong to that tier in each
   bucket is kept; the others are dropped.
5. When `maxVersions` is set, only the newest `maxVersions` minus one versions that survived the
   steps above are kept beside the newest version.

Ages are measured from a version's `createdAt` at the moment the policy is applied. Buckets are
aligned to the epoch rather than to any version, so applying the same policy twice at the same
moment drops nothing more. "Keep the last 10" is `{ "maxVersions": 10, "keepAllDays": 0,
"thinning": [] }`, and keeping everything is `{ "keepAllDays": 0, "thinning": [] }` with no caps.

The daemon applies the policy to a file after each new version of it, and to every file of every
vault at least once an hour, in bounded batches that never hold up requests. Changing the
policy never prunes inside the settings request; the next pass applies it. Pruning removes version
rows permanently; a pruned version answers `404 not_found` and emits no event, so a client showing
history drops a version that answers `404`. Stored content is removed when no version, upload, or
artifact manifest in any vault still uses it.

#### Activity

Every folder and file keeps an append-only activity log of what happened to it, for history views:

```json
{
    "id": "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e",
    "itemId": "e4k8m2q9w1e5r7y3u6i0o2p4",
    "kind": "moved",
    "fromParentId": null,
    "toParentId": "f7k2m9q4w1e5t8y3u6i0o2p5",
    "fromName": "draft.pdf",
    "toName": "summary.pdf",
    "at": 1755400000000,
    "actor": { "userId": "u1x2y3z4a5b6c7d8e9f0g1h2", "agentId": null },
    "source": "api"
}
```

`id` is a UUIDv7 and `itemId` the folder or file it belongs to. `kind` decides the other fields:

- `created` — `parentId`, `name`, and `copiedFrom`, the ID of the file it was copied from or `null`.
- `moved` — `fromParentId`, `toParentId`, `fromName`, and `toName`; a rename keeps the parent.
- `deleted` — nothing more.
- `restored` — `parentId` and `name`, where the item came back.
- `version_created` — `number` and `restoredFrom`, for files only. The version may since have been
  pruned. Creating a file records `created` only; its version 1 is implied.
- `pinned`, `unpinned` — `number`, for files only.

The set of kinds may grow; a client shows a kind it does not recognize as "changed". Activity is
removed only with its item.

#### Artifacts

An artifact is a vault app: a small web app kept as one file. Its `.artifact` file is a zip bundle
served as a web app, its files each named by a relative `path` under the artifact file object's path
rules and served under one URL prefix so relative references resolve without rewriting. Its inner files are not items of the tree, and its
versions are whole bundles. A version's `artifact` summary is `{ "type", "entry", "fileCount" }`:

| `type`     | `entry`                   | Rules                                                             |
| ---------- | ------------------------- | ----------------------------------------------------------------- |
| `html`     | `index.html`, UTF-8       | 1–256 files, entry at most 16 MiB, 256 MiB together               |
| `markdown` | `index.md`, UTF-8         | 1–256 files, entry at most 4 MiB, 256 MiB together                |
| `gen_ui`   | `index.genui.json`, UTF-8 | 1–256 files, entry at most 256 KiB, 32 MiB each, 256 MiB together |

A bundle holding `index.html` at its root is `html`, otherwise one holding `index.md` is
`markdown`, otherwise one holding `index.genui.json` is `gen_ui`, otherwise it is refused. The type may differ between versions. `artifact.json` at a
bundle's root is reserved for its manifest and is never one of the app's files. Every file holds at
least one byte, file media types come from the artifact extension table, paths are case-sensitive,
and no path is also a folder of another. A single-version read carries `files`, the whole file list
in path order, each `{ "path", "mimeType", "size", "sha256" }` exactly as the artifact file object.

An artifact travels as a **`.artifact` file**: a zip holding the app's files at its root beside
`artifact.json`, its manifest.

```json
{ "format": "happy.artifact", "formatVersion": 1, "type": "html", "entry": "index.html" }
```

`format` is always `happy.artifact`. `formatVersion` is `1`; a higher one is refused as made by a
newer Happy. `type` and `entry` are the version's summary, and `entry` must be the file the type
names in the table above. Fields not described here are ignored. The manifest is not stored as an
app file: the daemon keeps `type` and `entry` on the version and writes the manifest again on
download, so a downloaded `.artifact` file uploads back as the same content.

A `gen_ui` vault app is a Gen UI document kept in a vault. Its bundle has the layout of a `gen_ui`
artifact version, and each version goes through the same rules: the entry must be a valid
authoring document, its images are pictures of the same bundle named by relative path and never
fetched, every picture is measured, and the daemon compiles the render document and stores it in
the version as `.genui/render.json`, within the same render limits. The render document is one of
the version's `files`, counts in `fileCount`, and is written into a downloaded `.artifact` file.
`.genui` at the bundle's root is reserved for it: files there in an uploaded `.artifact` file, a
folder, or a zip are left out and the render document is compiled again, so a downloaded
`.artifact` file uploads back as the same content, and inline files or a vault path naming one are
refused. A refused document is `400 invalid_request` with a message naming each problem by its node
path, and nothing is changed.

People make artifact versions by uploading a `.artifact` file. A client uploading a file whose name
ends in `.artifact` creates an artifact, or makes a new version of the artifact of that name,
just as it does for a plain file. A `.zip` is always a plain file. The daemon reads the `.artifact`
file when the upload is placed:

- Folder records, everything under `__MACOSX/`, files named `.DS_Store`, and empty files are left
  out.
- When no `artifact.json` sits at the zip's root and every remaining file is inside one top-level
  folder, that folder is removed from every path, so a zipped `launch.artifact/` folder works.
- `artifact.json` must be at the root, valid UTF-8 JSON, and agree with the files.
- Stored and deflated records only. Encrypted records, symbolic links, absolute paths, `\`, `.` and
  `..` segments, duplicate paths, and anything else that breaks the path rules are refused, and so
  is a zip whose files break the limits above while it is being read, whatever its headers claim.

A refused `.artifact` file, including one that is not a zip or has no valid manifest, is
`400 invalid_request` with a message saying why, and nothing is changed. Agents write artifacts
with the tools below, file by file or as a whole.

A client draws a `gen_ui` vault app natively from the version's `.genui/render.json`, read with
the images it names through `GET /files/:fileId/versions/:number/artifact/*path` of the same
version, as it draws a `gen_ui` artifact. Its files are still served like any other app's.

An artifact is served as the artifact routes serve `html` artifacts, in the same sandbox:
every response carries the artifact file route's `Content-Security-Policy` sandbox and
`X-Content-Type-Options: nosniff`, so its pages run in an opaque origin without the daemon's or the
client's storage or credentials. A vault artifact has no artifact data store; clients do not
expose the artifact data bridge or rewrite its `/api/*` requests.

#### Search

Vault folders and files are found through `POST /v0/search`, across every vault the caller can
reach; vaults have no search route of their own. Their matches come in four tiers, and each tier
leaves out what an earlier one returned:

1. Name matches, `match: "name"`: every query word matches a word of the item's own name. Ranked
   by BM25 over names.
2. Content matches, `match: "content"`: every query word matches a word of one text. Ranked by
   BM25 over texts.
3. Path matches, `match: "path"`: every query word matches a word of the item's name or of the
   folders above it, but not all of them its name. Ranked by BM25 over names and folders.
4. Substring matches: items whose name or path contains the query, case-insensitively (names
   equal to the query, then names starting with it, then names containing it, then paths
   containing it, each group by path), as `match: "name"` when the name contains it and
   `match: "path"` otherwise; then, for queries of at least three characters, texts containing
   the query as a case-insensitive substring, as `match: "content"`.

The texts are the newest version of plain text files and the text files inside artifacts' newest
versions, other than a `gen_ui` app's `.genui` files. A file is text when it is valid UTF-8 without NUL and at most 1 MiB; larger and binary
files are found by name only. An item is returned once, under its best tier. The indexes are
updated in the same transaction as the change, so search never returns content a vault no longer
holds, and renaming or moving a folder updates the paths below it at once. After an upgrade, a
daemon indexes the words of existing vaults in the background; until it finishes, older items may
be found only by substring.

#### Uploads

People send bytes as uploads, which are resumable so large media survives a broken connection.
An upload is global, like an artifact upload: whoever holds its ID may place it in any vault.

```json
{
    "id": "u8p2l4o6a1d3e5f7g9h0j2k4",
    "size": 734003200,
    "received": 268435456,
    "sha256": null,
    "status": "receiving",
    "createdAt": 1755300000000,
    "expiresAt": 1755386400000
}
```

`size` is the whole upload's length, from 0 through 64 GiB (68,719,476,736 bytes). `received` is
how many bytes have arrived, always from the start; `status` is `"receiving"` until `received`
equals `size`, then `"complete"`, when `sha256` holds the digest of the bytes. An upload expires 24
hours after it was created or last received bytes, whichever is later, and then neither it nor its
bytes remain unless something else holds the same content. Placing an upload in a file uses it
up in the same transaction; an upload is used at most once. Uploads emit no events and are not
listed.

- `POST /v0/vault-uploads` accepts `{ "size": 734003200, "sha256": "..." }`; `sha256` is optional.
  It returns `201 { "upload": {...} }`. A zero-byte upload is complete at once.
- `PUT /v0/vault-uploads/:uploadId` appends raw bytes; the body's `Content-Type` is ignored. A
  `Content-Range: bytes start-end/size` header places them, and without one the body is the whole
  upload from byte 0. `start` must equal `received`, `size` must equal the upload's size, and the
  body must hold exactly `end - start + 1` bytes; one request carries at most 256 MiB. It returns
  `200 { "upload": {...} }`. A `start` other than `received`, or a complete upload, is
  `409 conflict` carrying the current `upload`, so a client whose response was lost resumes from
  `upload.received`. A range past the size or a body of the wrong length is `400 invalid_request`;
  a body over 256 MiB is `413 too_large`. When the last byte arrives and a supplied `sha256` does
  not match, the upload is discarded and the request answers `409 hash_mismatch`.
- `GET /v0/vault-uploads/:uploadId` returns `200 { "upload": {...} }`, where to resume.
- `DELETE /v0/vault-uploads/:uploadId` discards an unused upload and returns `200 {}`.

An upload that does not exist, has expired, or was used is `404 not_found` on every route and when
it is placed. Placing an upload that is still receiving is `409 conflict`.

#### Settings

A vault's settings are `{ "surfaceId": "...", "retention": {...}, "updatedAt": 1755400000000,
"version": "..." }`, a version-chained resource of their own.

- `GET /v0/surfaces/vault/:surfaceId/settings` returns `200 { "settings": {...}, "cursor": "..." }`.
- `PATCH /v0/surfaces/vault/:surfaceId/settings` accepts `{ "retention": {...}, "mutationId":
"..." }` with a whole policy, which replaces the stored one. It needs no `If-Match`: the latest
  edit wins, as with Surface names. An identical policy changes nothing. It returns
  `200 { "settings": {...} }`, and a change emits `vault.settings.updated`.

#### Routes

The prefix is `/v0/surfaces/vault/:surfaceId`. Every route checks that the Surface has type `vault`
and scopes folders, files, versions, and activity to it. Unknown Surfaces, a Surface of another
type, folders and files of another vault, a folder ID on a file route, and a file ID on a folder
route return `404 not_found`, as do malformed IDs in the path. Unsupported body or query fields and
malformed values return `400 invalid_request`. Paged reads take an optional `limit` and an opaque
`pageCursor`, the previous page's `nextPageCursor`, which is `null` on the last page; an
unrecognized `pageCursor` is `400 invalid_request`. `cursor` in a response is the shared event
cursor, captured before the first read.

Every change to an existing folder or file — rename, move, delete, restore, and new versions —
requires `If-Match` with its `version`. A missing or malformed header is `400 invalid_request`, and
a stale one is `409 conflict` with `currentVersion` and the current `folder` or `file`. A name
already taken by a live item in the destination folder is `409 name_taken` carrying that sibling as
`item`. Changing an item in the Trash, placing anything in a folder that is not live, and moving a
folder into itself are `409 conflict` with the current `folder` or `file`. Creation, pins, and
settings do not use `If-Match`.

Reading:

- `GET /items` lists the live children of the folder `parentId`, or of the root without it,
  folders and files together as items. Optional `sort` is `name` (default), `updatedAt`, or
  `size`, and `order` is `asc` or `desc` (default `asc` for `name`, `desc` otherwise). Folders come
  first in every sort; names compare case-insensitively, then by ID. `limit` is 1–500, default 200. It returns `200 { "items": [...], "nextPageCursor": null, "cursor": "..." }`. A `parentId`
  that is not a folder of this vault is `404 not_found`; a folder in the Trash still lists its
  children, so people can look inside.
- `GET /folders/:folderId` returns `200 { "folder": {...}, "path": "/Reports", "ancestors": [...],
"inTrash": false }`, and `GET /files/:fileId` returns `200 { "file": {...}, "path":
"/Reports/Q3/summary.pdf", "ancestors": [{ "id": "...", "name": "Reports" }, ...], "inTrash":
false }`. `ancestors` runs from the root down to the item's folder; `inTrash` says whether the
  item is in the Trash. Trash items and the items inside them are readable here.
- `GET /resolve?path=/Reports/Q3/summary.pdf` returns `200 { "item": {...}, "path": "...",
"ancestors": [...], "inTrash": false, "innerPath": null }` for a live path. When the path runs on
  past an artifact, `item` is the artifact and `innerPath` is the rest, which must be a file of its
  newest version; otherwise `innerPath` is `null`. `path` must start with `/` and name at least one
  item; a trailing `/` is ignored. A path that names nothing is `404 not_found`.
- `GET /tree` lists every live folder and file of the vault, in ID order, for clients that keep the
  whole tree. `limit` is 1–1,000, default 500. It returns `200 { "items": [...], "nextPageCursor":
null, "cursor": "..." }`. A client following events from the first page's `cursor` misses nothing
  made while it reads the rest.
- `GET /trash` lists Trash items, most recently deleted first, as `200 { "items": [{ "item":
{...}, "path": "/Reports/Q3" }], "nextPageCursor": null, "cursor": "..." }`. `path` is where the
  item was. `limit` is 1–500, default 200.
- `GET /files/:fileId/versions` lists a file's surviving versions, newest first, as
  `200 { "versions": [...], "nextPageCursor": null }`, without their file lists. `limit` is 1–200,
  default 50.
- `GET /files/:fileId/versions/:number` returns `200 { "version": {...} }`; `number` may be
  `latest`. An artifact version carries `artifact.files`. A pruned or unknown version is
  `404 not_found`.
- `GET /folders/:folderId/activity` and `GET /files/:fileId/activity` list an item's activity
  newest first, as `200 { "activity": [...], "nextPageCursor": null }`. `limit` is 1–200,
  default 50.

Changing:

- `POST /folders` creates a folder from `{ "parentId": null, "name": "Q3" }`, plus optional `id`
  and `mutationId`, and returns `201 { "folder": {...} }`, emitting `vault.folder.created`. A new
  folder is empty and stays until it is deleted.
- `POST /files` creates a file and returns `201 { "file": {...} }`, emitting `vault.file.created`.
  It accepts `{ "parentId": "...", "name": "summary.pdf" }`, plus optional `id` and `mutationId`,
  and exactly one content source: `uploadId`, or `fromFileId`, a file in any vault whose content
  the new file copies, with optional `fromVersion` (default its newest). A name ending in
  `.artifact` makes an artifact, whose upload must be a `.artifact` file and whose copy source must
  be an artifact; any other name makes a plain file, whose copy source must be a plain file. A new
  file starts at version 1, and the activity records `created` with `copiedFrom`.
- Repeating a supplied `id` on either creation route returns the current folder or file unchanged
  with `201`, even after deletion or restart, consumes no upload, and emits no event; the other
  fields are ignored. An `id` already used by an item of the other kind is `409 conflict`.
- `PATCH /folders/:folderId` and `PATCH /files/:fileId` rename or move: `{ "name": "...",
"parentId": "...", "mutationId": "..." }` with at least one of `name` and `parentId` (`null` is
  the root). They return `200 { "folder": {...} }` or `200 { "file": {...} }`. A change records
  `moved` and emits `vault.folder.updated` or `vault.file.updated`; the same name and folder is a
  no-op.
- `POST /folders/:folderId/delete` and `POST /files/:fileId/delete` accept `{}` or
  `{ "mutationId": "..." }`, move the item to the Trash, record `deleted`, and return the item as
  above, emitting its `updated` event. Deleting an item that is already deleted is a no-op after the
  `If-Match` check. Deleting an item inside a deleted folder is allowed and marks it on its own.
- `POST /folders/:folderId/restore` and `POST /files/:fileId/restore` accept `{ "parentId": "...",
"name": "...", "mutationId": "..." }`, all optional, restore a Trash item as described under
  Trash, record `restored`, and return the item as above, emitting its `updated` event. An item
  that is not a Trash item is `409 conflict`.
- `POST /files/:fileId/versions` makes a new version of a file from `{ "uploadId": "..." }` (for an
  artifact, a `.artifact` file of its whole bundle) or `{ "fromVersion": 2 }`, plus optional
  `mutationId`. It returns `201 { "file": {...}, "version": {...} }`, records `version_created`,
  and emits `vault.file.updated`. Content identical to the newest version returns
  `200 { "file": {...}, "version": null }`, changes nothing, and still uses up the upload.
- Optional `operationId` on either body, a client-chosen string of 1–128 characters, makes the
  request safe to repeat: a client sends one `operationId` per attempt and repeats it unchanged when
  a response is lost. The daemon remembers, for as long as the file exists, whether each
  `operationId` used on the file made a version and which. Repeating one already used on that file
  makes nothing new: it skips the `If-Match` check, ignores the rest of the body, uses up no
  upload, and emits no event. It answers with the original status, `201` or `200`, and
  `{ "file": {...}, "version": {...} }`, where `file` is the file as it is now and `version` is the
  version the first request made, with its current `pinned`, or `null` when that request made none
  or the version has since been pruned. An `operationId` belongs to one file; the same value sent
  for another file is a new request.
- `POST /files/:fileId/versions/:number/pin` and `/unpin` accept `{}` or
  `{ "mutationId": "..." }` and return `200 { "version": {...} }`. A change records `pinned` or
  `unpinned` and emits `vault.version.updated`; it does not change the file or its `version`.
  Pinning a pinned version, or unpinning an unpinned one, is a no-op.

Content:

- `GET /files/:fileId/versions/:number/content` serves a plain file version's bytes; `number` may
  be `latest`. `Content-Type` is the file's `mediaType`, with `; charset=utf-8` for `text/*`.
  `Content-Disposition` is `inline` with the file's name as `filename*`, or `attachment` with
  `?download=true`. `ETag`, `If-None-Match`, `Range`, `Cache-Control`, `Vary`,
  `X-Content-Type-Options`, and the sandbox `Content-Security-Policy` follow the artifact file route
  exactly, with the version's `sha256` as the entity tag; numbered versions are immutable and
  `latest` is revalidated. An artifact is `404 not_found`.
- `GET /files/:fileId/versions/:number/artifact/*path` serves one file of an artifact version under
  every rule of `GET /v0/artifacts/:artifactId/versions/:number/files/*path`: per-segment
  percent-encoding, exact file-list matches only, caching, ranges, and the same sandbox. A client
  showing a page uses a numbered version, so the artifact and its files come from one version. A
  plain file is `404 not_found`.
- `GET /files/:fileId/versions/:number/zip` downloads an artifact version as its `.artifact` file:
  `artifact.json` first, then its files in path order, named in `Content-Disposition` by the
  artifact's name. Every record carries the version's creation time, so one version always
  downloads as the same bytes. A plain file is `404 not_found`.
- `GET /folders/:folderId/zip` downloads a live folder, and `GET /zip` the whole vault: every live
  item below it, plain files at their relative paths, each artifact as its newest version's
  `.artifact` file under the artifact's name, and folders, empty ones included, as folder records.
  The folder or vault is named in `Content-Disposition` with `.zip`.

Zips are streamed with `Content-Type: application/zip`, `Content-Disposition: attachment`, no
`Content-Length`, UTF-8 names, and ZIP64 records where sizes need them. They are made on request
and never stored.

#### Events

All vault events are shared and follow commit.

- `vault.folder.created` carries the full `folder`, and `vault.file.created` the full `file`, each
  with optional `mutationId`.
- `vault.folder.updated` carries `surfaceId`, `folderId`, `previousVersion`, `version`, `changes`,
  and optional `mutationId`. `changes` holds the changed fields among `name`, `parentId`, and
  `deletedAt`, always with `updatedAt` and `updatedBy`.
- `vault.file.updated` carries `surfaceId`, `fileId`, `previousVersion`, `version`, `changes`, and
  optional `mutationId`. `changes` holds the changed fields among `name`, `parentId`,
  `latestVersion`, `size`, `sha256`, `mediaType`, `artifact`, and `deletedAt`, always with
  `updatedAt` and `updatedBy`.
- `vault.folder.removed` carries `surfaceId` and `folderId`, and `vault.file.removed` carries
  `surfaceId` and `fileId`, when a Trash item was removed for good; for a folder, everything inside
  it went with it, and a client drops every item below it.
- `vault.version.updated` carries `surfaceId`, `fileId`, `number`, `pinned`, and optional
  `mutationId` when a version was pinned or unpinned.
- `vault.settings.updated` carries `surfaceId`, `previousVersion`, `version`, `changes` (`retention`
  and `updatedAt`), and optional `mutationId`.

Deleting or restoring a folder emits one event, for the folder; a client holding items below it
derives their state from the tree. Consumers follow normal version-chain reconciliation and refetch
an item, or the folder they show, on a gap. Version creation is announced through the file's
`latestVersion`; pruning emits nothing. Vault content and history are not part of desktop
bootstrap.

#### Agent tools

Agents read and change vaults only through fixed common tools, available to every ordinary agent
model, shaped like the file tools they already know. Each takes the vault's `surfaceId` and
addresses folders and files by vault path, resolved case-insensitively. A path that runs on past an
artifact addresses a file inside it: `/Apps/launch.artifact/index.html` is the entry file of the
vault app `launch.artifact`, and `/Apps/launch.artifact/img/hero.png` is one of its files. Writing
such a path makes a new version of the artifact with that file added or replaced.

- `list_vault` accepts `surfaceId`, optional `path` (default `/`), and optional `depth` from 1
  through 10, default 1. It lists a folder's live folders and files, folders first and marked as
  folders, with the files' kinds, sizes, newest version numbers, and change times, recursing to
  `depth`; at most 1,000 lines, saying when more were left out. Listing an artifact lists the files
  of its newest version. The vault tools never list, read, or write a `gen_ui` app's `.genui`
  files.
- `read_vault_file` accepts `surfaceId`, `path`, optional `version`, and optional `offset` and
  `limit`. It reads a file, or a file inside an artifact, exactly as `read_artifact_file` reads an
  artifact file: numbered lines, 2,000 at a time from `offset`, raster images shown to the model,
  other binary files described. `version` reads an earlier version of the file or of the artifact
  holding it. Reading a folder or an artifact itself says what it is and points at `list_vault`.
- `write_vault_file` accepts `surfaceId`, `path`, and exactly one of `content` and `fromVersion`.
  `content` is the file's whole UTF-8 text, at most 16 MiB. It creates the file, and any missing
  folders above it, or makes a new version of the existing file. `fromVersion` restores an earlier
  version of the file or artifact at `path` as a new version. Identical content makes no version.
- `edit_vault_file` accepts `surfaceId`, `path`, `old_string`, `new_string`, and optional
  `replace_all`, and edits the newest version's text as `edit_artifact_file` does, with the same
  uniqueness rule. A version someone made while the call ran refuses the edit instead of being
  undone.
- `glob_vault` accepts `surfaceId`, `pattern`, and optional `path` (default `/`). It matches the
  paths of live folders and files below `path` against a glob relative to it (`*`, `**`, `?`,
  `[...]`, and `{a,b}`), case-insensitively, and returns at most 200 paths, most recently changed
  first, with a trailing `/` on folders, saying when more matched. Files inside artifacts are not
  matched.
- `grep_vault` accepts `surfaceId`, `pattern` (a JavaScript regular expression), optional `path`,
  optional `glob` limiting the files searched, optional `case_insensitive`, optional `output_mode`
  (`files_with_matches`, the default, `content` for matching lines with their numbers, or `count`),
  and optional `head_limit`, default 100. It searches the text that content search covers, files
  inside artifacts included, and says that larger and binary files were not searched.
- `create_vault_folder` accepts `surfaceId` and `path` and creates that folder, empty, with any
  missing folders above it. A folder already there is reported and left as it is.
- `move_vault_file` and `move_vault_folder` accept `surfaceId`, `path`, and `toPath`, and rename or
  move a file (or artifact) or a folder. The folder above `toPath` must already exist, and nothing
  may be at `toPath`.
- `copy_vault_file` accepts `surfaceId`, `path`, `toPath`, optional `toSurfaceId`, another vault to
  copy into (default the same vault), and optional `version` (default the newest). It copies a file
  or an artifact, not a folder or a file inside an artifact, to `toPath` as a new file whose history
  starts at version 1 with the source version's content, as `POST /files` with `fromFileId` does;
  no bytes are uploaded or rewritten. Missing folders above `toPath` are created, and nothing may
  be at `toPath`. Its activity records `copiedFrom`.
- `delete_vault_file` and `delete_vault_folder` accept `surfaceId` and `path` and move the file or
  the folder, with everything inside it, to the Trash.
- `list_vault_trash` accepts `surfaceId` and lists Trash items, each marked as a folder or a file,
  with their IDs, former paths, and deletion times.
- `restore_vault_file` accepts `surfaceId`, `fileId`, and optional `toPath`, and
  `restore_vault_folder` accepts `surfaceId`, `folderId`, and optional `toPath`. Each restores a
  Trash item from `list_vault_trash` there or where it was.
- `list_vault_versions` accepts `surfaceId`, `path`, optional `pageCursor`, and optional `limit`
  from 1 through 50, default 20. It lists a file's versions newest first with their actors, sizes,
  pins, and `restoredFrom`, and recent activity. `read_vault_file` with `version` reads an old one.
- `import_vault_file` accepts `surfaceId`, `fromPath`, a file on the agent's machine, and `path`,
  where it goes in the vault. It copies the file's bytes as they are, whatever they hold, creating
  missing folders, and makes the file or a new version of it, or adds the file to an artifact when
  `path` runs into one. When `path` names a file ending in `.artifact`, the file is read as a
  `.artifact` file and makes that artifact or a new version of it. A zip stays a zip file. To copy
  within or between vaults, use `copy_vault_file`.
- `export_vault_file` accepts `surfaceId`, `path`, `toPath` on the agent's machine, optional
  `version`, and optional `unpack`. A plain file is written to `toPath`, replacing a file there. An
  artifact is written as its `.artifact` file, or with `unpack: true` as a folder of its files at
  `toPath`, which must be absent or an empty folder.
- `write_vault_artifact` accepts `surfaceId`, `path`, which must end in `.artifact`, and either
  `files`, a list of `{ "path": "index.html", "content": "..." }` inline UTF-8 files, or
  `fromPath`, a folder, a zip, or a `.artifact` file on the agent's machine. It creates an artifact
  at `path`, or makes a new version of the artifact there whose files are exactly those given. The
  bundle rules and zip rules above apply; `artifact.json` at the root of `files` is refused, and
  one in a folder or zip is read as the manifest, while a bundle without one takes its type from
  its `index.html`, `index.md`, or `index.genui.json`.

Read tools are never reviewed. Writes change shared data that keeps its history and Trash, so,
as for artifacts an agent made, they are not reviewed: Workspace write, Auto, and Full access allow
them, and Read only refuses every vault write. Moving to the Trash is reversible, so deletion is not
reviewed either. `import_vault_file` and `write_vault_artifact` with `fromPath` read the agent's
machine through Compute's ordinary file boundary, with Auto review and temporary Full access only
for a path outside the workspace or a symbolic link leaving it, as artifact `fromPath` copies do.
`export_vault_file` writes the agent's machine under the ordinary file-write policy: inside the
workspace in Workspace write and Auto, reviewed with temporary Full access in Auto outside it or
at a protected path, refused in Read only. No vault write needs or grants Full access on its own.

Every writing tool is durable and keyed by its call ID: a call repeated after a restart finds the
folders, files, and versions it made and returns its result without making another one or another
event. A tool that makes a version uses its call ID as the version's `operationId`. Every result
names the paths it changed and the version numbers it made. Reading and writing never join anyone
to the Surface.

Active admin bots additionally receive `create_vault_surface`, accepting `name`, required explicit
`creatorUserId`, optional absolute `imagePath`, and optional `retention`. Its authority,
attribution, creator join rules, image handling, durable replay, and permission boundaries match
`create_todo_surface`.

### Reference Surfaces

An `artifact`, `bot`, or `task` Surface points to exactly one existing entity. It does not clone
the target, move it out of its existing catalog, create a new conversation, or change its access.
The Bots and Tasks catalogs remain unchanged. Opening an available reference uses the existing
artifact viewer or the referenced bot/task's existing agent conversation.

`POST /v0/surfaces` accepts one of these bodies, with optional `id`, `image`, and `mutationId`
following the catalog rules:

- `{ "type": "artifact", "name": "Design reference", "artifactId": "..." }`
- `{ "type": "bot", "name": "Research assistant", "botId": "..." }`
- `{ "type": "task", "name": "Launch work", "taskId": "..." }`

The target ID is required for its type and is immutable; other target-ID fields are invalid.
`name` is an explicit Surface label, not a copied or synchronized target title. It changes only
through `PATCH /v0/surfaces/:surfaceId` or `update_surface`, never because the target changed.
The optional managed Surface image is independent of the target's image and is edited the same
way. Current target display fields are resolved when the Surface is read, rather than stored
twice. Clients show that live target name while available and use the stored Surface name as
the unavailable fallback.

Creation validates that the target exists, is active, and is readable by the authenticated
caller. Missing, inactive, or inaccessible targets all return `404 not_found`, without creating
anything or revealing why lookup failed. HTTP uses the ordinary creator/join rule. A repeated
supplied Surface ID returns the existing Surface unchanged, including if its original target
later becomes unavailable; it never changes the binding or retries target creation.

Reference Surfaces have an optional additive `target` projection. Current daemons include it on
caller-facing catalog, bootstrap, and single-Surface mutation responses for reference types;
other Surface types omit it, and older daemons may omit it. An available projection is one of:

- `{ "type": "artifact", "state": "available", "artifactId": "...", "name": "Current title",
"hasImage": true, "version": "..." }`
- `{ "type": "bot", "state": "available", "botId": "...", "name": "Current name",
"hasImage": true, "version": "..." }`
- `{ "type": "task", "state": "available", "taskId": "...", "name": "Current name",
"hasImage": false, "version": "..." }`

`version` is the current target resource version, not the Surface version. `name` comes from the
artifact title or bot/task name. `hasImage` is true for an image or image-series artifact, true
for a bot with a non-null avatar, and false for tasks. It does not supply bytes, paths, or URLs;
clients use the existing target image/viewer routes, with their existing authentication.

An unavailable projection is only `{ "type": "artifact", "state": "unavailable" }` (or `bot`
or `task`), without a target ID, live name, image flag, or version. Missing/deleted artifacts,
archived bots/tasks, and targets the current caller cannot read all use that same form. The
Surface, its stored label/image, memberships, and immutable binding remain; resolution does
not return an error or delete anything. Restoring target availability makes the reference usable
again. Neither Surface membership nor knowing a Surface ID grants any target permission.
In particular, task archival still follows `canArchive` and the existing owner/team-owner rules.

Target resolution is caller-relative and is not part of the Surface's stored version chain.
It must be checked on every read; never reuse one person's resolved projection for another.
Shared `surface.created` events omit `target`, avoiding publication of caller-relative metadata.
Clients refetch the catalog to resolve newly created references. Existing `artifact.updated`,
`artifact.deleted`, `bot.updated`, and `task.updated` events trigger a fresh resolution for
affected references, including unavailable ones that may become available. No title or avatar
is copied into the Surface record and no synthetic Surface mutation is emitted for target
changes. Clients reconcile target metadata using the target's own version and must not discard
a fresh resolution merely because the Surface version stayed the same.

Active admin bots receive `create_artifact_surface`, `create_bot_surface`, and
`create_task_surface`. Each requires `name`, explicit `creatorUserId`, and its type's target ID;
each accepts optional absolute `imagePath`. The creator must be able to read an active target
when non-null, and execution must independently satisfy the target's existing access rules.
Missing/inactive/inaccessible targets return `not_found` without side effects. Authority,
creator attribution, creator joins, image handling, durable replay, and Auto permission
boundaries match other typed Surface creation tools. `list_surfaces` resolves targets for the
trusted current execution identity and returns unavailable when access cannot be established.
The reference never joins anyone to the target's own task list or changes its existing rights.

### Shared Surface chats

The chat-enabled types are `todo`, `document`, `calendar`, `system_monitor`, `chat`, `vault`,
`artifact`, `bot`, and `task`. Each may own exactly
one shared persistent conversation, created lazily when a person explicitly opens its chat.
Unsupported types have no chat: their ensure operation returns `409 conflict` and leaves
`chatAgentId` null. A reference Surface's contextual chat is separate from the target
bot/task's existing conversation; ordinary reference opening still opens that existing target.

`POST /v0/surfaces/:surfaceId/chat` accepts `{}` or `{ "mutationId": "..." }` and returns
`200 { "surface": {...}, "agent": {...} }`, where `surface.chatAgentId` equals `agent.id`.
It requires no `If-Match`. The Surface ID is the idempotency identity; callers cannot provide an
agent ID, workspace ID, model, permission mode, owner identity, or initial message. Unknown
Surfaces return `404 not_found`, and unsupported body fields return `400 invalid_request`.
There is no chat peek route: the catalog's `chatAgentId` already answers whether a chat exists.
After ensuring it, clients use the ordinary agent read, bootstrap, message, mode, draft, and
control routes. Sending the first message is a separate ordinary agent `send` with its own
stable message ID.

The chat route matches only this exact POST path. In particular, it does not capture
`POST /v0/surfaces/todo/:surfaceId`, document routes, or membership routes.
The Surface ID must be a 24-character CUID2, never a route word such as `todo`, `document`, or
`chat`. No valid existing method/path pair is repurposed.

The first successful ensure creates the logical agent and its dedicated workspace, sets
`chatAgentId`, advances the Surface version and `updatedAt`, and persists their notifications
in one transaction. Concurrent callers and retries after a lost response converge on the same
agent and workspace; only one association and one version transition commit. After commit,
`agent.created` precedes `surface.updated` containing the new `chatAgentId`. Only the winning
creation's optional `mutationId` is echoed. Subsequent ensures return the current Surface and
agent with no version, membership, message, or event change. Restart never creates a second chat.
Durable folder-preparation intent precedes filesystem work, and independent preparation belongs
to the daemon's lifetime, not the HTTP caller. An initialization failure exposes no partial chat
association; retry resumes the same reserved identities. Transient unavailable initialization
returns `503 not_initialized`, not an invented ready agent.

The agent is an ordinary parentless, user-visible, non-admin root, with
`managedByAnotherAgent: false`, `canSendMessages: true` when ready, and `orderKey: null`. It
belongs to no ordinary root-agent series. Its defaults follow HTTP task/bot creation exactly:
creation itself runs no inference and sets no special provider/model/effort/permission selection.
When no last composer mode exists, clients use `GET /v0/config`'s `defaults.providerId`,
`defaults.modelId`, `defaults.effort`, and `defaults.permissionMode`; every send supplies the
ordinary required `mode`, and later composer state uses the existing mode endpoint. Creating the
shared chat never copies an unrelated conversation's selection or elevated permissions from its opener.

In team mode, all permitted readers see the same conversation. Every human message carries its
authenticated sender in `metadata.userId`, exactly as task chats do; clients cannot substitute
an owner in the body. Trusted sender context changes with each accepted human message, so the
agent works for that sender rather than the person who first opened the chat or created the
Surface. Standalone messages use the existing null/absent local-user convention. Reference
chat reads, messages, agent snapshots, and events also obey the target's existing read access;
Surface membership or a known chat ID never bypasses it. A caller lacking that access receives
`404 not_found`. Target lifecycle state alone does not erase the chat or its history.

The Surface owns one plain, non-Git folder at `<public Happy folder>/Surfaces/<surfaceId>`,
beside the `Tasks` and `Bots` roots. As with task creation, configured runners place it on the
default runner using that runner's platform layout (`~/Happy/Surfaces/<surfaceId>` on macOS,
`~/happy/Surfaces/<surfaceId>` otherwise); without runners it uses the local workload/public
Happy folder. Configuration owns path resolution. The folder and all three IDs stay fixed.
Its dedicated workspace has `kind: "surface"`, optional additive `surfaceId`, `botId: null`,
no `taskId`, `parentId: null`, `projectId: null`, `base: null`, and exactly this primary agent.
It is discovered through the chat agent's `workspaceId`, not project/workspace listings or
bootstrap workspace arrays. Its normal file, terminal, and proxy operations work by
workspace ID under the same permission model as task workspaces.

The Surface owns the lifetime. Agent archive, unarchive, and reorder; workspace rename,
archive, reorder, and child creation; and attaching another root agent all return `409 conflict`.
Surface membership changes never stop the chat, delete its folder, or discard history, even
when nobody remains joined. Since Surfaces have no deletion route, their chats and folders
remain for the Surface's lifetime. The agent's context names its Surface ID, type, and stored
label, and tells it to use ordinary Surface tools, plus document tools for document content,
calendar tools for calendar events, vault tools for a vault's folders and files, and the read-only message
tools for a chat Surface's conversation. A calendar chat's context calls its Surface a calendar. A chat Surface's agent
context calls its Surface a conversation among people, and tells the agent it reads that
conversation but cannot post to it, so it answers in its own shared chat.
It receives no admin role, no new subtask-creation eligibility, and no implicit join, creation,
or target permissions. Ensuring or using the chat never joins anyone to a Surface or task list.

## Tasks

A task is a bot-like continuous chat for one piece of work. Like a bot it is created with exactly
one agent, keeps that agent for its whole life, and owns one dedicated folder. Unlike a bot it has
no avatar and no administration, and it records who it belongs to: the person whose message led
to its creation. A task is the root of its own subtasks.

A person creates a task through `POST /v0/tasks`. An agent creates one through its `create_task`
tool on behalf of the person it is working for: an active bot's agent, or another user-controlled
root. The agent that created a task may message and archive it through its task tools; people
rename, archive, and unarchive tasks through the routes below. Each task's folder lives under the
daemon's tasks root beside the bots root, `~/Happy/Tasks/<folderName>`, or on the default runner
while runners are configured.

**Owner.** `ownerUserId` is the installation-local Happy user ID of the person the task belongs
to, resolvable through `GET /v0/users` like message `metadata.userId`. For a task created through
`POST /v0/tasks` it is the authenticated team member who created it. For a task an agent created
it is the team member whose message the creating agent was working on, and it is `null` when no
person is identified, for example when another agent's message led to the task. It is `null` in
standalone mode. It never changes after creation.

**Memberships and per-person order.** Any authenticated person may join any task, archived ones
included. Joining puts the task in that person's own task list; leaving takes it out. Each
person's list has its own order, held by their membership, so reordering moves a task only in the
caller's list and never changes another person's list or the task itself. The owner joins when
the task is created, at the top of their list; a newly joined task also goes to the top. The owner
may leave like anyone else and remains the owner. In standalone mode the installation's one
person is the only member; in team mode a membership belongs to the authenticated team member.
Leaving and archiving are separate: leaving never archives a task, even when its owner or its last
member leaves, and archiving never removes a membership, so an archived task stays in every list
that holds it.

**Automatic membership.** Every team member automatically joins all active tasks by default,
including tasks created by other people or agents and tasks that already exist when the member
finishes their profile. Guests of exported bots are excluded. Existing members acquire missing
active-task memberships after daemon startup. Automatic joins use ordinary memberships and their
private `task.joined` events, place newly joined tasks at the top, and preserve the order of tasks
already joined. They do not change ownership, archival permission, or subtask visibility.

The per-person user setting `tasks.autoJoin` controls this behavior through the existing user-settings
routes. Only the JSON boolean `false` disables automatic joining; a missing or cleared value, `true`,
or any other JSON value enables it. Disabling preserves existing memberships and manual joining.
Enabling again joins missing active tasks. The owner still joins a newly created task even when
their automatic joining is disabled. Setting changes use the same last-write-wins rules and
owner-only `user_settings.updated` events as other settings; a stale write cannot change participation.
Standalone installations retain their existing behavior: their one person joins each new task.

Explicitly leaving a task suppresses automatic joining of that task for that person, including
across daemon restarts and disabling and re-enabling automatic joining. An explicit join clears
that suppression. Archived tasks are not automatically joined, but restoring a task makes it
eligible again for members who have not explicitly left it. Leaving a task before joining it also
records the suppression without emitting a membership event. Absences before this behavior was
introduced are not recorded leaves and are eligible for automatic joining.

**Mentioning a teammate.** In team mode a task's agent reads the team through its
`list_teammates` tool (each member's user ID, name, `role`, and `follows`; guests left out) and
loops someone in with `loop_in_teammate`, giving one sentence on why the task concerns them. That
joins them to the task. Such a join ignores `tasks.autoJoin`, clears an explicit leave like a
manual join, and marks the membership `unread` with the agent's reason; looping in a member already
in the task keeps its place and marks it unread again. Agents write a person as `[Name](happy://users/<userId>)` (see "Happy links").

**Mentioning from a message.** In team mode, a team member's `POST /v0/agents/:agentId/send` to a
task's agent loops in every other member its `text` links as `happy://users/<userId>`, through the
same join as `loop_in_teammate`. That join ignores `tasks.autoJoin`, clears an explicit leave, and
keeps the place of a member already in the task. The membership is marked `unread` with
`reason: "mentioned"` and the sender's `userId`. This happens in the transaction that stores the
message, so the message's response and events come after the join. Guests, unknown IDs, and the
sender are ignored, and so is an archived task. A mentioned person leaves through
`POST /v0/tasks/:taskId/leave` like anyone else. Mentions in messages to bots, workspaces, and
other agents join nobody.

**Unread.** A membership's `unread` says what its member has not looked at yet. A teammate's
agent may have looped them in, or a teammate may have mentioned them. In team mode there is also
new activity: a finished run of the task's agent marks every member, and a person's message marks
every member except its sender. An already-unread membership keeps its mark and `since`. It gets
a new `task.membership.updated` with its derived `count`. It is the
member's own: it travels on their membership in task responses, `GET /v0/tasks`, the desktop
bootstrap's `taskMemberships`, and their `task.joined` and `task.membership.updated` events, on
every connection that member uses, a paired phone included. `POST /v0/tasks/:taskId/read` clears
it, and so does `POST /v0/agents/:agentId/read` on the task's agent. A client shows a task's
unread mark and count from the caller's membership when it is set, and otherwise from the task
agent's `unread`.

**Archival permission.** In standalone mode the installation's one person may archive and
unarchive every task. In team mode the task's owner and the team owner may; any other member
receives `403` with `code: "forbidden"`. A task without an owner can be archived only by the team
owner. Each task object tells the caller whether they may, through `canArchive`.

**Showing the owner.** Resolve `ownerUserId` through `GET /v0/users` for the owner's name and
photo placeholder, and fetch the photo itself from `GET /v0/users/:userId/photo`. In standalone
mode `ownerUserId` is `null`; the installation's one person is the profile, whose photo is
`GET /v0/profile/photo`.

**Mapping to workspaces and agents.** A task is one dedicated workspace plus one agent in it, all
with distinct IDs. The workspace is a real workspace, exactly like a bot's: it is fetched from
`GET /v0/workspaces/:workspaceId`, and its files, file tree, file revisions, terminals, Git state,
Git watch, proxy, and secret attachments all work by its workspace ID. Its `kind` is
`"task"`, its `taskId` names the task, its `botId`, `projectId`, and `parentId` are `null`, and its
`agents` array always contains exactly the task's agent. It is not a Git worktree; it is a plain
folder created empty, so its `base` is `null`. Its lifecycle belongs to the task — renaming,
archiving, reordering, and creating children through the workspace routes answer `409` — and it
appears in no project list, `GET /v0/workspaces` listing, or bootstrap `workspaces` array. While the
task is archived its folder routes answer `409`, as for an archived bot. The daemon emits no
`workspace.*` events for a task's workspace: its status follows the task, so a client holding the
workspace object refetches it after `task.updated`.

The agent is an ordinary agent and every agent endpoint works on it unchanged. Its `workspaceId`
names the task's workspace. It reports `userVisible: true`, `managedByAnotherAgent: false`, and
`canSendMessages: true` while the task is active, and its `orderKey` is `null`. Its lifecycle
belongs to the task: agent `archive`, `unarchive`, and `reorder` on a task's agent answer `409`.
It is the workspace's only primary conversation: `POST /v0/agents` refuses a task's workspace with
`409`. Shared-filesystem subtasks run in the task's workspace and appear in the task agent's
`subtasks` tree.

Tasks are a versioned resource. The task's `version` covers its own fields — name and archival.
Memberships are not versioned: a person's own list has one writer, and the latest reorder wins. The
embedded agent is independently versioned and changes through `agent.updated` without advancing
the task.

### The task object

```json
{
    "id": "t4k8m2q9w1e5r7y3u6i0o2p4",
    "name": "Fix login redirect",
    "folderName": "fix_login_redirect",
    "ownerUserId": "u1x2y3z4a5b6c7d8e9f0g1h2",
    "creatorAgentId": "a9b8c7d6e5f4g3h2i1j0k9l8",
    "workspaceId": "w5v4u3t2s1r0q9p8o7n6m5l4",
    "compute": { "type": "host", "path": "/Users/steve/Happy/Tasks/fix_login_redirect" },
    "status": "active",
    "canArchive": true,
    "agent": {
        /* the task's one agent, the full agent object */
    },
    "version": "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e",
    "createdAt": 1755300000000,
    "updatedAt": 1755400000000,
    "archivedAt": null
}
```

Fields:

- `id` — stable task identifier.
- `name` — the human display name, 1–256 nonblank characters without ASCII control characters.
  The task's agent title follows it. A task created without a name is called `New Task` until it
  names itself; see `POST /v0/tasks`.
- `shortName` — optional generated label of at most 10 characters; clients fall back to `name`.
- `folderName` — the immutable snake_case folder name, unique across all tasks, archived ones
  included: lowercase ASCII letters, digits, and underscores, starting with a letter, 1–64
  characters.
- `ownerUserId` — the owner's Happy user ID, or `null`, as described above.
- `creatorAgentId` — the agent whose `create_task` call created the task, or `null`.
- `workspaceId` — the task's dedicated workspace, its own distinct ID.
- `compute` — where the task's folder lives, same shape as on projects, workspaces, and bots.
- `status` — `"active"` or `"archived"`.
- `canArchive` — whether the caller may archive and unarchive the task, under the archival
  permission above. It depends on the caller, so it appears in route responses and the bootstrap
  but not in `task.created` events, which reach every member alike, nor in `task.updated`
  `changes`. It never changes for a given caller and task, so a client keeps the value it read; a
  client that learns of a task only from `task.created` reads `GET /v0/tasks/:taskId` before
  offering archival. Older compatible daemons omit it.
- `agent` — the task's one agent, embedded in full. It merges by its own `version` through
  `agent.updated` events.
- `version` — the UUIDv7 concurrency version; see the basics.
- `createdAt`, `updatedAt`, `archivedAt` — lifecycle timestamps; `archivedAt` is `null` while
  active.

### The membership object

```json
{
    "taskId": "t4k8m2q9w1e5r7y3u6i0o2p4",
    "userId": "u1x2y3z4a5b6c7d8e9f0g1h2",
    "orderKey": "5",
    "joinedAt": 1755300000000,
    "unread": {
        "reason": "looped_in",
        "since": 1755400000000,
        "agentId": "f2g3h4j5k6l7m8n9p0q1r2s3",
        "note": "Refunds go through Stripe, which Steve follows."
    }
}
```

- `taskId` — the joined task.
- `userId` — the member's Happy user ID, or `null` for the standalone installation's one person.
- `orderKey` — an opaque sort key within this member's list; clients order the member's tasks by
  comparing these strings.
- `joinedAt` — when the member joined.
- `unread` — `null`, or what the member has not looked at yet: `reason`, `since` (when it was
  first marked; later activity keeps it), and optional fields. `reason` is `"looped_in"` (a task's
  agent looped the member in, with `agentId` and the agent's one-sentence `note`, 1–500
  characters, shown to the member), `"mentioned"` (a teammate's message mentioned them, with that
  teammate's `userId`), or `"new_messages"` (the task's agent finished a run, or another person
  wrote in the task). The set may grow; clients treat an unknown reason as plain unread. `count`
  is optional: how many runs of the task's agent finished, and how many messages people other
  than this member wrote in the task, at or after `since`, at most 100. It is derived when the
  membership is read, never stored. Clients show `100` as "99+". When `count` is missing or `0`
  they show a plain unread mark. Additive: older daemons omit `unread` and `count`, and clients
  treat a missing `unread` as `null`.

Every task route answers only with the caller's own memberships. In team mode one member never
sees another member's memberships.

### `GET /v0/tasks`

Lists tasks with the caller's memberships.

Query `scope` is optional: `all`, the default, lists every task, archived ones included, oldest
`createdAt` first with the ID as the tie-breaker. `joined` lists only the tasks the caller joined,
in the caller's own order. Any other value is `400 invalid_request`.

Response — `200`: `{ "tasks": [ /* task objects */ ], "memberships": [ /* membership objects */ ] }`.
`memberships` is always every membership of the caller, in the caller's order, whichever scope was
requested, so a global list also shows which tasks the caller joined.

### `POST /v0/tasks`

Creates a task for the authenticated person: the row, its dedicated workspace with its folder,
and its one agent, together. The creator becomes the owner in team mode and joins the task at the
top of their list.

Request:

```json
{
    "id": "t4k8m2q9w1e5r7y3u6i0o2p4",
    "workspaceId": "w5v4u3t2s1r0q9p8o7n6m5l4",
    "agentId": "a9b8c7d6e5f4g3h2i1j0k9l8",
    "name": "Fix login redirect",
    "folderName": "fix_login_redirect",
    "mutationId": "..."
}
```

- `id` — optional client-supplied task ID; the retry key.
- `workspaceId`, `agentId` — optional IDs for the new dedicated workspace and its one agent.
- `name` — optional. A supplied name is deliberate and is never automatically replaced. Omitted,
  the task is created immediately usable as `New Task` and names itself, as described below. A
  supplied blank or invalid name is `400`.
- `folderName` — optional. Omitted, the daemon derives one from the name (lowercased,
  non-alphanumeric runs collapsed to underscores), starting from `task` without a name, and
  resolves a collision by appending a numeric suffix. A malformed folder name is `400`; one
  already taken by any task, archived included, is `409 conflict`.

Malformed IDs return `400 invalid_request`; omitted IDs are generated independently. For a new
task, all three must be distinct and unused by any task, bot, workspace or project root, or agent,
archived and hidden included (`409 conflict`).

Repeating `id` returns the current task unchanged (`201`), including after rename, archival, or
restart; other valid creation fields are ignored and nothing is joined again. Omitted child IDs
reuse the stored ones; mismatches return `409 conflict` with `currentVersion` and `task`. Retries
have no side effects or events. Identity checks and creation are atomic, and a folder-setup
failure rolls back creation without exposing entities or events.

Response — `201`: `{ "task": { ... }, "membership": { ... } }`, the caller's new membership.
Creation is complete when it answers: the folder exists, the workspace and agent exist, the agent
is `"idle"`, and the task is ready for its first message through `POST /v0/agents/:agentId/send`.
New creation emits `task.created`, `task.joined`, and `agent.created` once after commit, echoing
`mutationId`.

**Automatic naming.** For a task created without a name, by this route or by `create_task`, the
first accepted text-bearing message starts one durable asynchronous naming job: a person's message,
or the message from the agent that created it, which is how a `create_task` call's opening `text`
arrives. Naming uses that message alone and the same cheap, bounded inference as workspace naming,
and asks for a short title of the work, two to six words, and in the same request a `shortName` of
at most 10 characters; an answer over that budget leaves `shortName` absent. The excerpt fallback supplies no `shortName`. Message acceptance and the task's own
turn never wait for naming. Failure or timeout does not fail the message. A new naming job makes
at most three bounded attempts, waiting one second before its second attempt and five seconds
before its third. Pending jobs and their attempt budget survive daemon restarts; later messages
do not start another job. If every attempt fails, a bounded plain-text excerpt of that first
message supplies the name, within the same word and character limits. Text with no letters or
numbers supplies no fallback. Previously attempted naming is not backfilled or restarted.
The generated name updates the task and its agent title
together, publishing `task.updated` and `agent.updated`. The task's IDs, folder, and workspace
never change. An explicit rename always wins, including one committed while naming is running.

### `PATCH /v0/tasks/:taskId`

Renames the task. Requires `If-Match` with the task's `version`. Any authenticated person may
rename a task, as with bots; renaming is not restricted like archival.

Request: `{ "name": "Fix the redirect loop", "mutationId": "..." }`

Renaming also updates the task's agent title, clears `shortName`, and permanently ends automatic
naming for the task, even when the submitted name equals the current one. The `folderName` is immutable: a request
carrying `folderName` is `400 invalid_request`.

Response — `200`: `{ "task": { ... }, "membership": { ... } }` with the new name, and a
`task.updated` event after commit, echoing `mutationId`. `404` when no such task exists, and the
usual `409` when `If-Match` names an older version.

### `GET /v0/tasks/:taskId`

Response — `200`: `{ "task": { ... }, "membership": { ... } }`. `membership` is the caller's
membership in the task, or `null` when the caller has not joined it. `404` when no such task
exists.

### `POST /v0/tasks/:taskId/join`

Joins the task, placing it at the top of the caller's list. The body is `{}` or
`{ "mutationId": "..." }`. Idempotent: joining a task the caller already joined changes nothing,
keeps its place, and emits no event.

Response — `200`: `{ "task": { ... }, "membership": { ... } }`. A new membership emits
`task.joined` after commit, echoing `mutationId`. `404` when no such task exists.

### `POST /v0/tasks/:taskId/read`

Marks the task read for the caller: clears their membership's `unread`. The body is `{}` or
`{ "mutationId": "..." }`. Idempotent: a task with nothing unread for the caller, or one they have
not joined, changes nothing and emits no event.

Response — `200`: `{ "task": { ... }, "membership": { ... } }`, the membership being the caller's
or `null`. A cleared mark emits `task.membership.updated` after commit, echoing `mutationId`.
`404` when no such task exists. Additive: older compatible daemons return `404`.

It also marks the task seen in the caller's Feed, closing their open entry for it with the Feed's
own events, as `POST /v0/feed/seen` does without `through`.

### `POST /v0/tasks/:taskId/leave`

Takes the task out of the caller's list. The body is `{}` or `{ "mutationId": "..." }`.
Idempotent: leaving a task the caller has not joined changes nothing and emits no event. Leaving
does not change the task, its owner, or anyone else's membership, and it never archives the task,
even when the owner or the last member leaves.

Response — `200`: `{ "task": { ... }, "membership": null }`. A removed membership emits
`task.left` after commit, echoing `mutationId`. `404` when no such task exists.

### `POST /v0/tasks/:taskId/reorder`

Moves the task within the caller's own list.

Request: `{ "afterId": "c3d4e5f6...", "mutationId": "..." }` — the joined task to place this one
after, or `null` to move it first.

Response — `200`: `{ "task": { ... }, "membership": { ... } }`. The moved membership receives a
fractional `orderKey` between its destination neighbours in the caller's list; every other
membership, the caller's neighbours and other members' lists included, is unchanged. Moving a task
to the place it already holds changes nothing and emits no event; otherwise the move emits
`task.reordered` after commit, echoing `mutationId`.

`404` when no such task exists. `409 conflict` when the caller has not joined the task, when
`afterId` names the task itself, or when `afterId` names a task that is not in the caller's list.

### `POST /v0/tasks/:taskId/archive`

Archives the task. Requires `If-Match` with the task's `version`; the body is `{}` or
`{ "mutationId": "..." }`. Idempotent — an already archived task answers the same way and stops
nothing.

Archiving has the same effect as the creating agent's `archive_task` tool and the same durability
contract as bot archival: the task agent's run is aborted and its background processes are
stopped, the agent is archived and its `canSendMessages` becomes `false`, and its history remains
readable. The folder is kept on disk — archival is logical, never a deletion. Memberships are
unchanged. Only an admin bot's [permanent deletion](#permanent-deletion) removes the folder and
the task.

Response — `200`: `{ "task": { ... }, "membership": { ... } }` with `status` `"archived"`; the
membership is the caller's, or `null`. Archival emits `task.updated` after commit, echoing
`mutationId`. `403 forbidden` when the caller may not archive the task, `404` when no such task
exists, and the usual `409` when `If-Match` names an older version.

### `POST /v0/tasks/:taskId/unarchive`

Brings an archived task back: its agent accepts messages again, with its history, folder, owner,
and memberships intact. Requires `If-Match`; the body is `{}` or `{ "mutationId": "..." }`.
Idempotent. The same callers may unarchive as may archive.

Response — `200`: `{ "task": { ... }, "membership": { ... } }` with `archivedAt` `null`, and a
`task.updated` event after commit, echoing `mutationId`. `403`, `404`, and `409` as for archive.

## Stories (retired)

Stories was removed because Activity is a better version of Stories today. A Stories-like feed
may return for the latest updates in Activity. The runtime no longer loads a Stories module,
offers `post_story`, `list_stories`, or `delete_story`, serves `/v0/stories` routes, advertises
`storyFeed`, or publishes Stories events. Desktop bootstrap returns `storiesEnabled: false` and
`stories: []` for older clients. Bot projections return `stories: false`, and the retired bot
PATCH input is ignored. Opaque user settings remain readable and writable but have no effect.
Stored Stories tables, migration history, media, and existing message quotes are preserved;
the historical quote still-frame route remains available. No retirement migration deletes data.

The following describes the historical wire formats retained by published clients for connecting
to older daemons. It does not require current daemons to implement any Stories behavior.

A story is one image or video that a task's own agent publishes to the people who joined the task, with a few words
of caption, to show something that shipped. It lasts 24 hours. Clients show live stories on the
task's existing icon and play them full screen. A bot's `stories` switch enables its story tools,
off by default; its stories reach every non-guest member with personal stories on while enabled.

**Turning stories on.** Stories are on for a person only while their user setting `stories` is
the JSON boolean `true`; missing, cleared, `false`, or any other value is off. It is read and
written through the ordinary user-settings routes and `user_settings.updated` events. For a person
with stories off, nothing changes: `GET /v0/stories` answers an empty list, every other story route
answers `404 not_found`, they receive no story events, and agents working for them are offered no
story tool. Turning stories on shows every live story they may see; refetch the list when the
setting changes.

**Posting.** Agents post through their `post_story` tool
`{ "path": "...", "caption"?: "...", "replaces"?: ["..."] }`. `path` names an image, or an H.264 MP4 video (`.mp4`), on
the agent's own machine; the daemon snapshots its bytes when the call runs, with the same
boundary, review, and size limits as presenting a file in chat (32 MiB for an image, 256 MiB for a
video). An image that does not decode is refused, and so is a video that is not named `.mp4`, does
not open with an MP4 `ftyp` box, or has no H.264 (`avc1` or `avc3`) sample entry under
`moov/trak/mdia/minf/stbl/stsd`. Box lengths bound the scan; bytes in frame data or unrelated
metadata do not declare a track. The daemon checks only
the container and track type, not that every frame decodes. `caption` is 1–200
characters. The tool is offered to a task's own agent when its owner has personal stories on,
or a bot's own agent when its bot's Stories switch is on; never to a subtask, project or
workspace conversation. This is checked once when
the turn's tools are assembled, with no recheck inside the tools. Each call adds one
story; an agent may have multiple live stories, played oldest first, with no video duration limit
(the byte limits above still apply). For a multipart update, call `post_story` once per outline part;
do not combine the parts into one frame or replace earlier parts of the same update. People may also upload their own stories or
repost an agent's story. Nobody edits a story. Optional `replaces` names at most twenty of the
agent's own live originals to remove, with their reposts, in the posting transaction. Foreign,
repost, missing, and ended IDs are ignored. The tool result includes the `replaced` IDs; removals
emit `story.removed` after commit. `delete_story` still removes a story without posting.
Omitting `replaces` preserves earlier frames; use it only for originals made stale by this update.
The viewer is 9:16 (1080×1920 reference pixels); important content fits inside
x=48–1032 and y=384–1344, clear of the top progress/poster/attribution bar and bottom caption/reply controls.

**Agent tools.** Alongside `post_story`, and under the same conditions, the agent is offered
`list_stories` `{}`, which lists its live stories and people's reposts of them, each with how many
people saw it, how many replied, and the latest 50 replies; and `delete_story` `{ "id": "..." }`,
which deletes one of its own live stories with every repost of it. `delete_story` answers
`{ "deleted": false }` for anything else, including a repost. An agent whose person has stories
off is offered none of the three.

**Reposts.** A person reposts an agent story they see, with an optional caption and an optional
round video of themselves, through `POST /v0/stories/:storyId/repost`. A repost keeps the
original's `agentId`, `taskId`, `botId`, and `media`, referencing the same stored media bytes
without downloading, re-encoding, or uploading the original again, and reaches every non-guest team member with
stories on. It lasts 24 hours from its own `postedAt`. A repost
cannot be reposted. A person's original story cannot be reposted either. Optional `layers` keep
text and round positions separate from the base media (see below).

**Replies.** Anyone who sees a story may reply to it with 1–2000 characters of text. The reply is
kept with the story, readable by everyone who sees the story, and is also sent to the story's agent
as the replier's own message in that agent's chat. Its `content` is exactly the text they wrote,
and its `quote` names the story; see Message content. Just before it, the model receives a private
system notification naming the story, such as
`The person's next message replies to your story “<caption>” (story <id>). Its first frame follows.`,
with the quote's frame as an image when there is one. It is delivered
like a message the person typed, so the agent answers it in its ordinary turn. A reply to a repost
reaches the original's agent the same way. Replies to a person's original story stay with that
story only; there is no agent chat.

**Deleting.** A story's `canDelete` tells the caller whether they may delete it. In team mode the
task's owner may delete their task's agent stories, and a person may delete their own stories and reposts;
nobody else may delete anything. The agent deletes its own through `delete_story`.
In standalone mode the installation's one person may delete any story. Deleting an
agent story deletes every repost of it. A deleted story leaves every list and route at once, and
everyone who saw it receives `story.removed`; its media, round video, seen state, and replies
answer `404 not_found`.

**Who sees a story.** Posting always publishes: there is no owner-only or internal audience.
A task agent's original story reaches the task's owner and every non-guest person who joined the
task with stories on, while the task is active. Archiving hides it until unarchived, if it has not
ended. Joining or leaving the task, archiving, and unarchiving send each affected reader
`story.changed` for every live original they now see and `story.removed` for each they no longer see. A person's
original story or repost reaches every non-guest team member with stories on, or the one person
standalone. Guests cannot post or read stories. Everything else answers
as if the story did not exist.

**Seen.** Each person has their own seen state. Opening a story marks it seen for that person
only, on all of their devices; nobody else's changes.

**Ending.** A story ends at `expiresAt`, 24 hours after `postedAt`. An ended story leaves every
list and route at once and no event announces it; clients drop it at `expiresAt`. Stories, seen
state, and replies persist across daemon restarts.

### The story object

```json
{
    "id": "q2v7m4wfx0e8c1hg9kz3b6np",
    "agentId": "k8d2s0vqzj4m7ly1c5xh3rwe",
    "taskId": "t3n6b1yqk8w2x0fz9mh4c7dp",
    "botId": null,
    "caption": "New onboarding is ready to try",
    "media": {
        "kind": "image",
        "mimeType": "image/png",
        "size": 482113
    },
    "postedAt": 1755400000000,
    "expiresAt": 1755486400000,
    "seen": false,
    "poster": "person",
    "userId": "u5c9w2hx7m0k3qz8b1fn4tjd",
    "repostOf": "a7p1x4kd9q2m6zv0w3hn8csl",
    "round": { "mimeType": "video/mp4", "size": 912004 },
    "replyCount": 3,
    "replies": [
        {
            "id": "r4k8x1mq0w7z2cv9h3dn6pfs",
            "storyId": "q2v7m4wfx0e8c1hg9kz3b6np",
            "userId": "b6t0y3nw8k1q5zx2m7hc4dvj",
            "text": "Looks great",
            "createdAt": 1755401000000
        }
    ],
    "canDelete": true
}
```

- `id` — the story's CUID2.
- `agentId` — the posting task's agent, including on reposts. This is the existing
  **Open chat** target. `null` for a person's original story, which has no chat target.
- `taskId`, `botId` — where it was posted. Exactly one is set for agent stories and reposts;
  both are `null` for a person's original story. Match a row by its corresponding ID.
- `caption` — 1–200 characters, or `null`.
- `media` — `kind` is `"image"` or `"video"` (H.264 MP4), its `mimeType`, and its `size` in bytes.
  Fetch the bytes from `GET /v0/stories/:storyId/media`.
- `postedAt`, `expiresAt` — epoch milliseconds.
- `seen` — whether the caller opened it.
- `poster` — `"agent"` for the agent's own story, `"person"` for a person's story or repost. Clients show agents and
  people differently.
- `userId` — the person who posted or reposted it; `null` for an agent's story, and in standalone mode.
- `repostOf` — the ID of the agent story this reposts, or `null`.
- `round` — the reposter's round video, `{ "mimeType", "size" }`, or `null`. Fetch the bytes from
  `GET /v0/stories/:storyId/round`.
- `replyCount` — how many replies the story has.
- `replies` — the latest replies, at most two, oldest first. Each reply has `id`, `storyId`,
  `userId` (the replier, `null` in standalone mode), `text`, and `createdAt` in epoch milliseconds.
- `canDelete` — whether the caller may delete it.
- `layers` — optional `{ "text"?: { "text": "...", "x": 0.5, "y": 0.5, "scale"?: 1, "rotation"?: 0 },
"round"?: { "x": 0.5, "y": 0.45, "scale"?: 1, "rotation"?: 0 } }`. Text is 1–200 characters, including emoji; coordinates
  are finite numbers in [0, 1], measuring the layer's **center** relative to the full media frame.
  Optional `scale` is finite and in [0.5, 3], default 1; optional `rotation` is finite degrees
  in [-180, 180], default 0. Rotation and scaling apply around the layer's center.
  Missing text means no text layer. A round without placement defaults to center (0.2, 0.2);
  clients adding a new text layer start at (0.5, 0.5). All layer objects reject unknown fields.
  Clients adding a new round layer start at (0.5, 0.45), with unscaled diameter 40% of frame width.
  A round placement requires an uploaded round file. A repost without its own text shows the
  original's text.
- `mediaLayers` — optional array of stored images and videos placed above `media`, in paint
  order, below text. Each is `{ "id", "kind", "mimeType", "size", "shape"?, "x", "y", "width",
"aspect", "scale"?, "rotation"? }`: `kind` is `"image"` or `"video"`; `shape` is `"rect"`
  (default) or `"round"`, clipped to a circle whose diameter is the layer width; `x` and `y`
  are the layer's center in [0, 1] of the full frame; `width` is in (0, 1] of the frame width
  before `scale`; `aspect` is the media's width over its height in [0.1, 10], so the box is known
  before its bytes load; `scale` and `rotation` are as for `layers`. Fetch the bytes from
  `GET /v0/stories/:storyId/layers/:layerId`. A repost lists the original's layers first, under
  their own IDs, then its own. A story with a legacy `round` also lists it as the layer `round`
  with `shape: "round"`, its `layers.round` center, scale, and rotation, `width: 0.4`, and
  `aspect: 1`. The server never composes layers into the media or re-encodes any of them; each
  is stored once and referenced by every story showing it. Older daemons omit the field.

### `POST /v0/stories`

Uploads a person's original story. Request is `multipart/form-data` with one `media` file
(non-empty, at most 32 MiB = 33,554,432 bytes), optional `round` file (non-empty H.264 MP4,
at most 16 MiB), and optional `metadata` string containing JSON `{ "caption"?: "...", "layers"?: { ... } }`.
No other fields or repeated parts are accepted. The binary files are never base64 encoded.
`media` must have an `image/*` content type and decode as an image, or have content type
`video/mp4` and pass the same `ftyp`/`avc1`/`avc3` check as `post_story`. Round's content type is
`video/mp4` and it passes that check too. `caption` is 1–200 characters; metadata rejects unknown fields.
For both files, compare the base media type case-insensitively, ignoring parameters such as `codecs`.
The entire multipart body is capped at 48 MiB plus 64 KiB of multipart overhead and metadata.

Alternatively send `application/json`, referencing files already streamed to disk through
`POST /v0/artifact-uploads`: `{ "media": { "uploadId": "..." }, "caption"?: "...",
"layers"?: { ... }, "mediaLayers"?: [ { "uploadId": "...", "shape"?: "rect", "x": 0.5, "y": 0.5,
"width": 0.4, "aspect": 1, "scale"?: 1, "rotation"?: 0 } ] }`, with at most 8 media layers and
no other fields. The daemon reads each upload's kind from its bytes: an image that decodes (at
most 32 MiB), or a video (at most 256 MiB) that passes the `post_story` H.264 MP4 check. Bytes are
adopted into story storage without copying or re-encoding, and an upload may be referenced again
until it expires. JSON `layers.round` is refused; send a circle video as a media layer with
`shape: "round"`. An unknown, expired, or refused upload is `400 invalid_request`.

Response — `200`: `{ "story": { ... } }`, with `poster: "person"`, the caller's `userId`, and
`agentId`, `taskId`, `botId`, and `repostOf` all `null`. The story lasts 24 hours and emits
`story.changed` to every non-guest member with stories on. `404 not_found` while stories are off
or for a guest; `400 invalid_request` for invalid metadata, media or round; `413 too_large` when
a file or the complete request exceeds its cap. Standalone posts have `userId: null`.

### `GET /v0/stories`

Response — `200`: `{ "stories": [ /* story objects */ ], "cursor": "..." }`: every live story the
caller may see, oldest `postedAt` first. Empty while the caller's stories are off. `cursor` is the
event cursor captured before the stories were read; follow `story.changed` and `story.removed`
after it.

### `POST /v0/stories/:storyId/seen`

Marks the story seen for the caller. Any body is ignored; send none or `{}`. Idempotent.

Response — `200`: `{ "story": { ... } }` with `seen: true`, and one `story.changed` to the caller
after commit. `404 not_found` when the story does not exist, has ended, the caller may not see it,
or the caller's stories are off.

### `GET /v0/stories/:storyId/media`

The story's image or video bytes, served exactly as `GET
/v0/agents/:agentId/tool-calls/:toolCallId/media/:index` serves an item: `Content-Type` is
`media.mimeType`, `ETag` and `If-None-Match`, `Cache-Control: private, max-age=31536000, immutable`
with `Vary: Authorization`, single byte ranges answering `206` so a video can stream and seek,
`X-Content-Type-Options: nosniff`, and the sandboxing `Content-Security-Policy`. `404 not_found`
under the same conditions as marking it seen. A client that renders through an element rather than
`fetch` points it at this URL through a transport that adds the bearer token.

### `GET /v0/stories/:storyId/round`

A story's round video, served exactly as its media. `404 not_found` when the story has no round,
and under the same conditions as marking it seen.

### `GET /v0/stories/:storyId/layers/:layerId`

One media layer's bytes, served exactly as the story's media, including byte ranges. A repost
serves its original's layers under their IDs. `404 not_found` when the story has no such layer,
and under the same conditions as marking it seen.

### `POST /v0/stories/:storyId/repost`

Request: `{ "caption"?: "...", "round"?: { "data": "<base64>" }, "layers"?: { ... },
"mediaLayers"?: [ ... ] }`, with no other fields. `mediaLayers` are the reposter's own, referencing
uploads exactly as in a JSON `POST /v0/stories`; they are painted above the original's layers.
The original's media and layers are referenced, never downloaded, copied, or uploaded again.
`caption` is 1–200 characters; `round.data` is a base64 H.264 MP4 video of at most 16 MiB (at
most 22,369,624 characters), checked as `post_story` checks a video.
Alternatively send `multipart/form-data` with optional `metadata` (the same JSON as person
uploads) and optional binary `round`, with the same limits and validation, and no `media` part.
The complete repost multipart body is capped at 16 MiB plus 64 KiB; content type is checked before
either multipart upload's body is read.
An empty JSON object or multipart form posts a repost with nothing added.

Response — `200`: `{ "story": { ... } }`, the new repost, and one `story.changed` to everyone who
sees it. `400 invalid_request` for a bad body or round. `404 not_found` when the story is a
repost or a person's original story, and under the same conditions as marking it seen.

### `GET /v0/stories/:storyId/replies`

Response — `200`: `{ "replies": [ /* replies */ ] }`, every reply, oldest first. `404 not_found`
under the same conditions as marking it seen.

### `POST /v0/stories/:storyId/replies`

Request: `{ "text": "..." }`, 1–2000 characters, with no other fields.

Response — `200`: `{ "reply": { ... } }`. When `agentId` is non-null, the reply is sent to that
agent as the caller's message. Everyone who sees the story receives `story.changed` with the new `replyCount` and
`replies`. `400 invalid_request` for a bad body; `404 not_found` under the same conditions as
marking it seen.

### `DELETE /v0/stories/:storyId`

Deletes the story, and every repost of a deleted agent story. Response — `200`: `{}`, and
`story.removed` to everyone who saw each deleted story. `403 forbidden` when the caller sees the
story but its `canDelete` is `false`; `404 not_found` under the same conditions as marking it seen.

## Artifacts

An artifact is finished work published for people to see: a Markdown document or an HTML page with
the pictures and other files it uses, a live web page reached by URL, an image, an ordered series
of images, a video, a document such as a PDF, or a Gen UI document, a small native view built from
a fixed set of components. Artifacts are global. One catalog holds every
artifact on the installation, and in team mode every member sees all of it, wherever each artifact
was made. Each artifact remembers
where it was created — its `source` — and who created it and who last changed it.

Almost any agent publishes artifacts through its artifact tools: `create_artifact`,
`write_artifact_file`, `edit_artifact_file`, `read_artifact_file`, `update_artifact`,
`list_artifacts`, `read_artifact`, and `delete_artifact`.
The daemon records the acting agent as the author and the place the agent works in as the source.
People publish through the routes below. Either way, creating an artifact and every later update
each make a new immutable version; nothing is overwritten. Deleting an artifact leaves a tombstone.

**Artifact tools.** An agent writes an artifact's files with artifact tools that work directly on
the daemon's catalog. There is one copy of every artifact, the catalog's, and nothing on any
machine to keep in step, so the tools are the same for every agent, whichever model runs it and
whoever executes its other tools. They take the artifact's `artifactId` and a `path` inside it,
under the file object's path rules below, and otherwise follow the file tools agents already know:

| Tool                  | Arguments                                                                                             | Does                                                                                    |
| --------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `create_artifact`     | `type`, `title`, `display`, `background`, `cover`, `summary`, `content`, `files`, `url`               | Issues the artifact's ID and makes version 1.0                                          |
| `write_artifact_file` | `artifactId`, `path`, `content`                                                                       | Writes one whole text file, adding it or replacing the one there                        |
| `edit_artifact_file`  | `artifactId`, `path`, `old_string`, `new_string`, `replace_all`                                       | Replaces exact text in one text file of the latest version                              |
| `read_artifact_file`  | `artifactId`, `path`, `version`, `offset`, `limit`                                                    | Reads a text file as numbered lines, or shows an image                                  |
| `update_artifact`     | `artifactId`, `title`, `display`, `background`, `cover`, `summary`, `files`, `remove`, `major`, `url` | Changes metadata or a live URL, copies files in, removes files, bumps the major version |

The daemon issues every artifact's ID in `create_artifact`; the model never chooses one. For a
Markdown or HTML artifact, optional `content` supplies the complete UTF-8 text of `index.md` or
`index.html` in the initial version. It may accompany auxiliary `files`, but cannot accompany a
file supplied at that entry path or a live `url`, and is refused for other artifact types. The entry
must satisfy the same non-empty and byte-size limits as any other artifact file. Without `content`
or an entry in `files`, a Markdown or HTML artifact starts from a short entry holding its title. A
Gen UI artifact needs its document: `content` supplies `index.genui.json`, and without it or an
entry in `files` the call is refused. An image, image series, video, or document starts from the
files the call supplies. Initial content
and all supplied files publish together as one version 1.0; a rejected call publishes no artifact.
`files` on `create_artifact` and `update_artifact` copies files from the agent's machine, each
`{ "fromPath": "...", "path": "..." }`,
which is how an agent publishes images it generated and files it built with the shell; a `path`
left out is the file's own name. Reading those files follows the agent's permission mode like any
other read on its machine.

On `create_artifact` only, each `files` item may instead be `{ "path": "style.css", "content": "…" }`
to supply that file's UTF-8 text directly. Inline files require an explicit `path`; each item
supplies exactly one of `content` and `fromPath`. Inline and copied files may be mixed, and an
inline entry in `files` is allowed when top-level `content` is omitted. All files follow the same
path, non-empty, byte-size, count, media-type, and bundle rules below. Duplicate destination paths,
including a top-level `content` entry also supplied in `files`, and file/folder path conflicts are
refused without publishing an artifact. Inline files require no access to the agent's machine;
only `fromPath` copies undergo local-file permission checks. `update_artifact` keeps its existing
copy-only `files` shape; later inline text changes use the artifact file tools. REST creation and
update shapes are unchanged.

`edit_artifact_file` works as an exact-text edit does: `old_string` must appear exactly once in the
latest version's text unless `replace_all` is `true`, and must differ from `new_string`; otherwise
the call fails and changes nothing. `write_artifact_file` and `edit_artifact_file` handle UTF-8
text; other files arrive through `files`. `read_artifact_file` numbers lines from 1, as a line
number, a tab, and the line; `offset` is the first line to read and `limit` how many, at most 2,000
by default, and it reads the latest version unless `version` names another.

Each tool call that writes an artifact makes exactly one new version of it, recorded as made by the
calling agent where it works: a minor version, unless `update_artifact` names `major`. The new
version must satisfy its type's rules and limits below; otherwise the call fails and makes nothing.
A write that leaves both content and metadata unchanged makes no version. A version is keyed by its tool call, so
a call repeated after the daemon restarts makes nothing a second time, and an edit applied to text
someone else changed while the call ran fails instead of undoing that change. One agent makes at
most 100 versions of one artifact in any hour through its tools; a write beyond that fails and asks
the agent to make its changes in fewer calls.

Reading is never reviewed, since every agent can read every artifact. Writing follows the
permission mode. Read only refuses every artifact write. An agent writes artifacts it created
itself without review in Workspace write, Auto, and Full access. Writing an artifact the agent did
not create — one a person or another agent made — is refused in Workspace write, reviewed in Auto
as a new version of that artifact visible to everyone using the installation, and allowed in Full
access. An artifact write never needs or grants Full access to the agent's machine; only reading a
`files` copy from outside the agent's workspace does.

Creating or updating a live-URL artifact is always reviewed in Auto, even when the acting agent
created it. The review discloses the effective URL, title, and recorded network, and that the
client will load the page and run its scripts through that network. For a loopback URL it states
the exposure plainly, such as "exposes localhost:5173 on the agent's machine to the page".
For a private or link-local URL it identifies the address as non-public and explains that the
artifact proxy will refuse it. This review does not itself grant Full access. Other
permission-mode and ownership rules above still apply.

An agent mentions an artifact in its replies with a Happy link,
`[title](happy://artifacts/<id>)`, which clients show as a link labeled with the artifact's live
title; see "Happy links". The writing and reading tools give the agent the exact link.

Published artifact content lives on the daemon's machine, in its private data directory
(`.happy/agent/artifacts`). Published content is stored once per distinct content, so a file that
several versions or artifacts share is kept once. An artifact made by an agent on a runner or in a
container is served by the daemon like any other.

**Bundles.** A file-content version is a small tree of files, each named by its `path` inside the
artifact, such as `index.md`, `images/chart.png`, or `assets/css/site.css`. One file is the version's
`entry`, the file a client opens to show the artifact; the others are what the entry refers to.
Relative references inside a Markdown or HTML entry resolve against the entry's own URL, exactly as
a browser resolves them, so `![](images/chart.png)` in `index.md` and `<img src="img/hero.jpg">` in
`index.html` reach their files without any rewriting through the file route below.

**Live URLs.** `create_artifact` with `type: "html"` and `url` creates a live-URL artifact. The URL
is its content, not a request to download or snapshot a page. Neither `files` nor `content` can
accompany `url`, and other artifact types cannot take it. The daemon parses and normalizes the URL; only absolute
`http` and `https` URLs without a user name or password are accepted, at most 4,096 characters
after normalization. Invalid input fails without creating an artifact or version. The daemon
never fetches the URL body.

Each version records `live: { "url": "http://localhost:5173/", "networkId": "..." }`. `networkId`
is the creating agent's network, resolved as for
`GET /v0/workspaces/:workspaceId/agents/:agentId/proxy` and captured at creation. It is opaque and
never changes for that artifact, even if another agent updates it or the creator later changes
machines. A URL update keeps that network. `localhost` therefore means the original agent's
network, not the viewer's machine. Failure to resolve the network fails creation without a
partial artifact. A client opens the URL through `CONNECT /v0/artifacts/:artifactId/proxy` on the
artifact's daemon or connection, subject to that route's destination policy. It must not use
`CONNECT /v0/networks/:networkId/proxy` for live artifacts. If the artifact proxy or its recorded
network is unavailable, it shows an unavailable page; it must not fall back to an unrestricted
proxy, the viewer's network, or the creator's current network. It may resolve
the creator's network again to restore the recorded route after a daemon restart, but may use
the result only if its ID still equals the recorded `networkId`.

The desktop renders a live-URL artifact in a browser profile scoped to that artifact's ID on
its daemon or connection. Cookies and storage belong only to that artifact, shared by its
versions and views on that client, never with the workspace browser, another artifact, or another
daemon. This profile is not the network-scoped profile used for ordinary workspace browsing,
even when both use the same `networkId`. The page runs in the client's web-page sandbox. The
client never forwards daemon authorization, artifact-data API credentials, or workspace browser
credentials to the page. It does not expose the artifact data bridge or rewrite the page's
`/api/*` requests to the daemon; those requests belong to the live site's own origin. Network
access and the page's scripts remain a potential vulnerability, as with any live web page.

New clients prefer `live` to the file entry. For compatibility, every live version also holds
one daemon-generated inert `index.html`, containing a fixed, title-independent notice to open the
artifact in a newer Happy client. It contains no redirect, iframe, script, or active link to the
live URL. `entry`, `files`, `fileCount`, and `size` describe this real fallback file under their
existing rules. The fallback is not the live page's contents, and a pinned version fixes the
URL and metadata, not what the external server returns over time.

`update_artifact` with `url` makes a new minor version under the ordinary version rules, or a
major version when `major` asks for one. Omitting `url` preserves it. A live artifact cannot be
converted to file content, nor can an existing file artifact be converted to live content;
create another artifact instead. Live artifacts reject `files` and `remove` in update tools,
and `write_artifact_file` and `edit_artifact_file` fail with an explanation that the content is a
live URL. Reading their fallback files remains available. Metadata-only REST updates preserve
`live`; REST updates containing `files`, `remove`, or `replaceAll` on a live artifact fail with
`400 invalid_request`. REST creation and update request shapes are unchanged and do not accept
live URL content. Only the agent tools create or change it.

`show_page` was removed. Use `create_artifact` with `type: "html"` and `url` for live pages.
Existing `page` presentations remain readable as history.

**Types.** The type decides the entry and which files a version may hold:

| `type`         | Entry               | Files                                       | Size limits                                  |
| -------------- | ------------------- | ------------------------------------------- | -------------------------------------------- |
| `markdown`     | `index.md`, UTF-8   | the entry plus any other files; 1–256 files | entry 4 MiB; 256 MiB together                |
| `html`         | `index.html`, UTF-8 | the entry plus any other files; 1–256 files | entry 16 MiB; 256 MiB together               |
| `image`        | its one file        | exactly one image                           | 32 MiB                                       |
| `image_series` | the first file      | 1–64 images, shown in `path` order          | 32 MiB each, 256 MiB together                |
| `video`        | its one file        | exactly one video                           | 256 MiB                                      |
| `document`     | its one file        | exactly one document                        | 64 MiB                                       |
| `gen_ui`       | `index.genui.json`  | the entry plus any other files; 1–256 files | entry 256 KiB; 32 MiB each, 256 MiB together |

- Images: `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `image/avif`, and `image/svg+xml`.
- Videos: `video/mp4`, `video/webm`, `video/quicktime`, and `video/ogg`.
- Documents: `application/pdf`, `application/msword`,
  `application/vnd.openxmlformats-officedocument.wordprocessingml.document`,
  `application/vnd.ms-excel`, `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`,
  `application/vnd.ms-powerpoint`,
  `application/vnd.openxmlformats-officedocument.presentationml.presentation`,
  `application/vnd.oasis.opendocument.text`, `application/vnd.oasis.opendocument.spreadsheet`,
  `application/vnd.oasis.opendocument.presentation`, `application/rtf`, `text/plain`, `text/csv`,
  and `application/epub+zip`.

Every file holds at least one byte. A file's media type is decided by the daemon from its path's
extension, case-insensitively, and is `application/octet-stream` for an extension it does not know;
the file object below lists the extensions. An `html` artifact is rendered as it is,
scripts included, in a sandboxed frame that has no access to the daemon's or the client's origin,
storage, or credentials. An artifact's type never changes. The set of types grows with the product;
a client that meets a `type` it does not recognize shows the title and offers the entry for
download.

**Gen UI documents.** A `gen_ui` artifact is a view the client draws natively, not a page. Its
entry is an authoring document, UTF-8 JSON in the Gen UI format, and the daemon compiles every
version into a render document the client draws. Both formats are specified in `docs/genui/` of
the Happy Agent repository: `SPEC.md` and `catalog.json` for authoring documents, `RENDER.md` and
`render/catalog.json` for render documents.

- Every version's entry must be a valid authoring document. Otherwise the change is
  `400 invalid_request`, no version is made, and the message names each problem by its node path,
  such as `root<card>.children[0]<stat>.value: expected string`.
- An image names a picture of the same version by its path relative to the entry, such as
  `assets/photo.jpg`. A remote URL is refused: the daemon never fetches images. The file must be a
  PNG, JPEG, GIF, WebP, or AVIF picture the daemon can decode; a missing or undecodable one is
  refused with the node path that names it. Every picture of a `gen_ui` version is measured as
  "Media metadata" describes.
- The daemon stores the render document as the version's file `.genui/render.json`
  (`application/json`), made in the same change as the version. It is one of `files`, counts in
  `fileCount` and `size`, and is served by the file route like any other file. `.genui` at the
  root is reserved for files the daemon derives: a creation or update that writes or removes a
  file there is `400 invalid_request`.
- A render document holds at most 4,000 elements and 4 MiB. A document whose render document would
  be larger is refused with a message saying so.
- A client draws a `gen_ui` version from its `.genui/render.json`, never from the entry, and loads
  the images the render document names by `file` through the file route of the same version. A
  client that does not support the render document's `genuiRender` format version shows the
  version's summary instead.
- The document's optional `fallback` is plain text saying what the view shows. A version that
  names no summary takes the fallback as its summary, within the summary rules, and a later version
  whose summary still equals the earlier fallback follows the new one. Search covers the
  fallback. A `gen_ui` artifact has no cover unless one is named.
- The agent tools never list, read, or write the `.genui` files and leave them out of the file
  counts they report; agents work only with the authoring document and its images.

**Sources.** `source` says where an artifact was created, as an object discriminated by `kind`:

- `{ "kind": "bot", "botId": "...", "agentId": "..." }` — a bot's conversation, or work under it.
- `{ "kind": "task", "taskId": "...", "agentId": "..." }` — a task's conversation, or work under it.
- `{ "kind": "project", "projectId": "...", "agentId": "..." }` — a project's root folder.
- `{ "kind": "workspace", "workspaceId": "...", "projectId": "...", "agentId": "..." }` — a
  workspace below a project; `projectId` names that project.
- `{ "kind": "agent", "agentId": "..." }` — a conversation that belongs to none of those.

`agentId` names the conversation the artifact came from. It is `null` when a person created the
artifact outside a conversation, and never `null` on an `agent` source. For an agent's artifact the
daemon fills the source itself: starting at the acting agent and following its parents, the first
agent that is a bot's or a task's agent, or that belongs to a workspace or a project root, decides
the kind, and `agentId` stays the acting agent. A person creating or changing an artifact may name
a source; without one it is `null`. Sources are extensible: new kinds may be added, and a client
treats a `kind` it does not recognize as "made elsewhere", still reading `agentId` when present.

**Authors.** `createdBy`, `updatedBy`, `deletedBy`, and every version's `createdBy` are authors,
also discriminated by `kind`:

- `{ "kind": "agent", "agentId": "...", "botId": "..." }` — an agent; `botId` names the bot it works
  for, the bot's own agent or an agent under it, and is `null` otherwise.
- `{ "kind": "user", "userId": "..." }` — a person, by installation-local Happy user ID, resolvable
  through `GET /v0/users`; `null` for the one person of a standalone installation.

Authors are extensible in the same way; a client shows an unrecognized `kind` as "someone else".

**Versions.** Versions are numbered from 1 and never change once made. Each records its title, its
files or live URL and network, its author, its source, and when it was made. The integer `number`
identifies a version everywhere, in routes and Happy links, and every version takes the next
one, whatever it changed.

Each version also carries a `major.minor` label. The first version is 1.0. Every change makes a
minor version, the next minor of the same major, unless it asks for a major version: an update
naming `major` makes the version `major.0`. `major` must be exactly one more than the latest
version's major, and the latest version must be a minor one — its minor above 0 — so a major
version always follows at least one change since the previous major; anything else is
`400 invalid_request` and makes nothing. A major version holds whatever else the same update
changes, or the latest files unchanged.

A new file-content version starts from the files of the latest one and adds, replaces, or removes individual
files, so files that did not change carry over without being sent again; it may also replace every
file at once. An update that changes only the title or the background makes a new version holding
the same files. The artifact object mirrors its latest version in `latestVersion`, `latestMajor`,
`latestMinor`, `title`, `entry`, `fileCount`, `size`, `background`, `display`, `cover`, `summary`,
and `live`, records
its creation in `source`, `createdBy`, and `createdAt`, and its latest change in `updatedBy`,
`updatedSource`, and `updatedAt`.

**Backgrounds.** A client shows an artifact on a transparent slot, so the surface around it — a
desktop pane, a chat card — shows through, in light and dark. A version may instead name a
`background`, a colour the client paints behind its content. It is for content that needs one
fixed canvas, such as a print-like document or a visualization drawn for one palette; most
artifacts leave it `null`. It is a hexadecimal colour, `#rgb`, `#rgba`, `#rrggbb`, or `#rrggbbaa`,
accepted in either case and stored in lowercase, and nothing else: no colour names, functions,
variables, or other CSS. A new version keeps the latest version's background unless the change
names another or clears it. A client uses it only as the slot's background colour and checks the
pattern again before it does.

**Display.** A version may name a `display` preference, how its author wants it shown in a chat:

- `"inline_compact"` — inline in the conversation, collapsed to its title until a viewer expands
  it.
- `"inline_expanded"` — inline in the conversation at its full height.
- `"side"` — as its title in the conversation, opened beside the chat.

`null` leaves the choice to the client. It is a preference, not a guarantee: a client that cannot
show an artifact inline opens it as it opens any other. Whether one viewer has collapsed an inline
artifact is that viewer's own state and never part of the artifact. A new version keeps the latest
version's display unless the change names another or clears it. Only an agent's `create_artifact`
and `update_artifact` set it; the routes below never change it. The set of values may grow; a
client treats a value it does not recognize as `null`.

A client shows an HTML artifact inline where a tool-call presentation with `shows` `"latest"`
names it (see "Tool-call presentations"), always at its latest version. Inline means the page's
full height in the flow of the conversation: the client measures the page at the exact width it is
shown at and never caps it or scrolls inside it, so a page that needs scrolling of its own belongs
beside the chat. The page is laid on the conversation's own surface, with no frame or background of
its own unless the version names a `background`, and the client gives it the conversation's color
scheme, light or dark, as its `color-scheme`. The standard styles below make that the default.

**Covers and summaries.** A version may have a `cover`, an image that sums it up where artifacts
are listed, such as the Feed, which shows it full width under the title as a post. The artifact
draws everything into the image itself — a title card with the headline, the key number, or the
main chart — and clients draw nothing of their own over it. A version may also have a `summary`,
post-like plain text a client shows under the title.

- A cover is one of the version's own files, named by its `path`. The daemon decodes it and
  records its `mimeType`, its intrinsic `width` and `height` in pixels, as shown after any EXIF
  rotation, and the standard `aspect` that size matches, so a client lays out the post before it
  loads the image. It also records a `thumbhash` of the first frame, base64 in the same format as
  chat media and pictures, which a client draws until the image loads; it is `null` when the daemon
  could not decode the pixels, which is not an error. A client loads it through the file route,
  `GET /v0/artifacts/:artifactId/versions/:number/files/<path>`, at the version it shows. A cover
  may also carry `preview`, `{ "width", "height" }`: the same still preview its file object
  describes, served by `GET /v0/artifacts/:artifactId/versions/:number/previews/<path>`, which a
  list or grid loads instead of the whole cover. It is absent when the cover's file has no preview.
- A cover has one of two standard shapes, so it looks the same everywhere:

    | `aspect`   | Shape | Recommended size | Smallest |
    | ---------- | ----- | ---------------- | -------- |
    | `"wide"`   | 16:9  | 1600×900         | 960×540  |
    | `"square"` | 1:1   | 1200×1200        | 720×720  |

    A size matches a shape when `width / height` is within 2% of its ratio. Each side is at most
    4,096 pixels. Any other shape or size is refused with a message naming both shapes and their
    recommended sizes. The set of aspects may grow; a client that meets an `aspect` it does not know
    shows the artifact without its cover.

- A cover is a raster image: `image/png`, `image/jpeg`, `image/webp`, or `image/gif`, decided by
  its path's extension, and its bytes must be that format. WebP, still or animated, is the preferred
  format; a GIF is accepted but should be converted to an animated WebP first, for example with
  `ffmpeg -i in.gif -c:v libwebp -loop 0 -q:v 75 cover.webp`. An animated cover plays where a client
  shows it; there is no separate flag for it. The size of a WebP or GIF comes from its container
  header, the canvas of an extended WebP or a GIF's logical screen, so an animation is measured
  without decoding every frame. SVG is refused, because not every client can draw one: render it to
  WebP or PNG first. The file is at most 32 MiB.
- A summary is post-like plain text, as in a tweet or a short post: what the artifact is and its
  key takeaway, in a few sentences. The daemon turns CRLF line ends into `\n` and trims the text;
  it must then hold 1–5,000 characters, counted as Unicode code points, and no control characters
  (U+0000–U+001F, U+007F–U+009F) other than `\n`, nor a Unicode line or paragraph separator.
  It is never Markdown: clients show it as text, keeping its line breaks, and may linkify
  `http(s)` URLs. The stored text is what every response returns.
- A cover or summary that breaks these rules is `400 invalid_request` with a message saying which
  rule, and no version is made.
- A new version keeps the latest version's cover path and summary unless the change names new ones
  or clears them with `null`. The daemon decodes the kept cover again for every version, because
  its file may have been replaced; if the version no longer holds the cover's file, or the new file
  breaks the rules, the change is refused unless it also names another cover or clears it. So a
  change that removes or replaces the cover's file through `remove`, `replaceAll`, `files`, or the
  artifact file tools must name a cover or clear it at the same time.
- An `image` artifact's cover is its own file, and an `image_series` artifact's its first file,
  unless a change names another cover or clears it. Such a default follows the files: a version that
  replaces the picture takes the new one as its cover. A default picture the rules refuse, such as
  an SVG or a picture of neither standard shape, leaves the version without a cover, and that is not
  an error. Once a cover is cleared or named, it stays that way. Every other type has no cover unless
  one is named. Images and image series made before covers existed take their default from their
  next version on.
- A live-URL artifact holds no files a cover could be, so naming a cover for one is
  `400 invalid_request`; it may have a summary.

Agents give a cover and summary to reports, analyses, and results people would want to see in the
Feed; the artifact tools tell them so. Scratch and utility artifacts usually have neither.

**Deletion.** Deleting leaves a tombstone. `status` becomes `"deleted"`, `deletedBy`,
`deletedSource`, and `deletedAt` record the deletion, which is also the artifact's latest change,
and the artifact leaves every list unless `includeDeleted` asks for it. The tombstone stays readable
by ID so that every client learns of the deletion. A deleted artifact no longer serves its versions
or files and cannot be updated or restored. Its stored content stays on the daemon's disk:
deletion, like archival, never erases durable data.

**Permissions.** In standalone mode the installation's one person may do everything. In team mode
every authenticated member may create, update, and delete every artifact; the versions keep what
each change replaced.

Artifacts are a versioned resource. `version` covers every field of the artifact object, and
updating or deleting an artifact requires `If-Match` with it.

### The artifact object

```json
{
    "id": "r7k2m9q4w1e5t8y3u6i0o2p5",
    "type": "markdown",
    "title": "Q3 revenue report",
    "status": "active",
    "latestVersion": 2,
    "latestMajor": 1,
    "latestMinor": 1,
    "entry": {
        "path": "index.md",
        "mimeType": "text/markdown",
        "size": 18234,
        "sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
    },
    "fileCount": 3,
    "size": 412870,
    "background": null,
    "display": "inline_expanded",
    "cover": {
        "path": "cover.webp",
        "mimeType": "image/webp",
        "width": 1600,
        "height": 900,
        "aspect": "wide",
        "thumbhash": "1QcSHQRnh493V4dIh4eXh1h4kJUI",
        "preview": { "width": 640, "height": 360 }
    },
    "summary": "Revenue up 18% QoQ, driven by enterprise seats.",
    "live": null,
    "source": {
        "kind": "workspace",
        "workspaceId": "w5v4u3t2s1r0q9p8o7n6m5l4",
        "projectId": "p1o2i3u4y5t6r7e8w9q0a1s2",
        "agentId": "a9b8c7d6e5f4g3h2i1j0k9l8"
    },
    "createdBy": { "kind": "agent", "agentId": "a9b8c7d6e5f4g3h2i1j0k9l8", "botId": null },
    "createdAt": 1755300000000,
    "updatedBy": { "kind": "user", "userId": "u1x2y3z4a5b6c7d8e9f0g1h2" },
    "updatedSource": null,
    "updatedAt": 1755400000000,
    "deletedBy": null,
    "deletedSource": null,
    "deletedAt": null,
    "version": "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e"
}
```

Fields:

- `id` — stable artifact identifier.
- `type` — one of the types above; it never changes.
- `title` — the latest version's title: 1–256 nonblank characters without ASCII control
  characters.
- `status` — `"active"` or `"deleted"`.
- `latestVersion` — the number of the latest version.
- `latestMajor`, `latestMinor` — the latest version's `major` and `minor` label. Absent from older
  daemons.
- `entry` — the latest version's entry, as a file object.
- `fileCount`, `size` — how many files the latest version holds, and their bytes together. The
  files themselves are listed by the version.
- `background` — the latest version's background, or `null` for a transparent slot.
- `display` — the latest version's display preference, or `null` to leave it to the client.
- `cover` — the latest version's cover, `{ "path", "mimeType", "width", "height", "aspect",
"thumbhash", "preview"? }`, or `null` for none; see "Covers and summaries". Absent on older
  daemons.
- `summary` — the latest version's summary, or `null` for none. Absent on older daemons.
- `live` — the latest version's `{ "url", "networkId" }`, or `null` for file content. Absent on
  older daemons. When present and non-null, it takes precedence over `entry`; see "Live URLs".
- `source` — where the artifact was created, or `null`.
- `createdBy`, `createdAt` — who created the artifact, and when.
- `updatedBy`, `updatedSource`, `updatedAt` — who made the latest change, where, and when. After
  creation they repeat `createdBy`, `source`, and `createdAt`; after deletion they describe the
  deletion.
- `deletedBy`, `deletedSource`, `deletedAt` — who deleted the artifact, where, and when; `null`
  while it is active.
- `version` — the UUIDv7 concurrency version; see the basics.

### The version object

```json
{
    "artifactId": "r7k2m9q4w1e5t8y3u6i0o2p5",
    "number": 2,
    "major": 1,
    "minor": 1,
    "title": "Q3 revenue report",
    "entry": {
        /* the entry's file object */
    },
    "files": [
        /* file objects, in path order */
    ],
    "background": null,
    "display": "inline_expanded",
    "cover": {
        "path": "cover.webp",
        "mimeType": "image/webp",
        "width": 1600,
        "height": 900,
        "aspect": "wide",
        "thumbhash": "1QcSHQRnh493V4dIh4eXh1h4kJUI",
        "preview": { "width": 640, "height": 360 }
    },
    "summary": "Revenue up 18% QoQ, driven by enterprise seats.",
    "live": null,
    "createdBy": { "kind": "user", "userId": "u1x2y3z4a5b6c7d8e9f0g1h2" },
    "source": null,
    "createdAt": 1755400000000
}
```

- `artifactId`, `number` — the artifact and the version's number within it, from 1.
- `major`, `minor` — the version's label, `major.minor`; see "Versions". Absent from older daemons.
- `title`, `entry`, `files` — the artifact as this version left it. `files` is the version's whole
  manifest, ordered by `path` in Unicode code point order; `entry` is one of them.
- `background` — the colour behind this version's content, or `null` for a transparent slot.
- `display` — how this version's author wants it shown, or `null` to leave it to the client.
- `cover` — this version's cover, `{ "path", "mimeType", "width", "height", "aspect", "thumbhash" }`,
  or `null` for none. `path` is one of `files`; `width` and `height` are the pixel size, `aspect` is
  `"wide"` or `"square"`, a set that may grow, and `thumbhash` is the base64 ThumbHash of its first
  frame or `null` when it could not be decoded. The daemon computes the ThumbHash when the version is
  made and reuses it while the cover's path and digest are unchanged; versions made before ThumbHashes
  existed keep `null` until the next version. `preview` is optional: the `{ "width", "height" }` of
  the cover file's still preview, exactly as on its file object, and absent when it has none.
  `thumbhash` and `preview` are absent on older daemons, and `cover` itself is absent on still older
  ones.
- `summary` — this version's summary, post-like plain text with `\n` line breaks, or `null` for
  none. Absent on older daemons.
- `live` — this version's `{ "url", "networkId" }`, or `null` for file content. Absent on older
  daemons. The URL may change between versions; the artifact's network never does.
- `createdBy`, `source`, `createdAt` — who made this version, where, and when.

### The file object

```json
{
    "path": "images/chart.png",
    "mimeType": "image/png",
    "size": 48213,
    "sha256": "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
    "width": 1600,
    "height": 900,
    "thumbhash": "1QcSHQRnh493V4dIh4eXh1h4kJUI",
    "preview": { "width": 640, "height": 360 }
}
```

- `path` — the file's place in the artifact: segments joined by `/`, 1–1,024 characters in all and
  1–255 per segment. A segment is never empty, `.`, or `..` and holds no `\` or control
  character, so a path never starts or ends with `/`. Paths are case-sensitive. One version never
  holds a file at a path that another of its files uses as a folder, such as `a` beside `a/b`.
- `mimeType` — the media type the daemon decided from the path's extension.
- `size` — the length in bytes, at least 1.
- `sha256` — the lowercase hexadecimal SHA-256 of the bytes. Equal digests mean equal content.
- `width`, `height` — optional; the picture's or video's positive pixel size as displayed, after
  EXIF orientation or a video's rotation. See "Media metadata" below.
- `durationMs` — optional; a video's length in whole milliseconds.
- `thumbhash` — optional; the standard base64 encoding of a
  [ThumbHash](https://evanw.github.io/thumbhash/) placeholder of the first frame, at most 128
  characters, in the same format as chat `media` items.
- `preview` — optional; `{ "width", "height" }`, the pixel size of the still preview served by
  `GET /v0/artifacts/:artifactId/versions/:number/previews/*path`. Present only when the daemon
  made one.

**Media metadata.** The daemon measures the files people show as pictures and videos, as it does
for chat `media` items, so a client lays them out and shows a placeholder before any bytes load:

- Every image file of an `image`, `image_series`, or `gen_ui` version, and every version's cover
  file of any type, gets `width`, `height`, and `thumbhash` when the daemon can decode it: PNG, JPEG, GIF,
  WebP, or AVIF, still or animated. SVG files get none. The size of a WebP or GIF comes from its
  container header, like a cover's.
- The video file of a `video` artifact gets `width`, `height`, `durationMs`, and `thumbhash`, and a
  poster taken from its first frame, when the daemon's host has `ffprobe` and `ffmpeg` on its
  `PATH`. The daemon runs them itself on its stored copy of the file, whichever client or agent
  made the version, and gives each at most 15 seconds. Without them, or when they fail, the fields
  are absent. The poster itself is not served; its preview is.
- Each of those pictures and each poster gets a `preview`: a still WebP of the first frame, fitted
  within 640×640 pixels and never enlarged, so a list or grid shows a small image instead of the
  whole file. The daemon stores each preview once per source digest.

The daemon measures a file when the version that places it is made, and reuses what it measured
for the same digest and media type in later versions and other artifacts. A file that cannot be
measured simply lacks the fields; it never refuses the version. Versions made before media
metadata existed have none, and their kept files get it from the next version on. A client treats
every one of these fields as optional, because older daemons omit them all.

A client showing an artifact in a list or grid loads a preview rather than the whole file: the
cover's when there is a cover, otherwise its media file's (an image's picture, an image series'
first picture, a video's poster), with that file's `thumbhash` as the placeholder, and the type's
glyph when there is neither. A Feed post still loads the whole cover, which may be animated, with the
cover's `thumbhash` as its placeholder. A video viewer shows the poster preview until playback
starts.

The extensions the daemon knows, case-insensitively:

| Extensions           | Media type                                                                  |
| -------------------- | --------------------------------------------------------------------------- |
| `md`, `markdown`     | `text/markdown`                                                             |
| `html`, `htm`        | `text/html`                                                                 |
| `css`                | `text/css`                                                                  |
| `js`, `mjs`, `cjs`   | `text/javascript`                                                           |
| `json`, `map`        | `application/json`                                                          |
| `webmanifest`        | `application/manifest+json`                                                 |
| `txt`                | `text/plain`                                                                |
| `csv`                | `text/csv`                                                                  |
| `tsv`                | `text/tab-separated-values`                                                 |
| `xml`                | `application/xml`                                                           |
| `yaml`, `yml`        | `application/yaml`                                                          |
| `wasm`               | `application/wasm`                                                          |
| `png`                | `image/png`                                                                 |
| `jpg`, `jpeg`        | `image/jpeg`                                                                |
| `gif`                | `image/gif`                                                                 |
| `webp`               | `image/webp`                                                                |
| `avif`               | `image/avif`                                                                |
| `svg`                | `image/svg+xml`                                                             |
| `ico`                | `image/x-icon`                                                              |
| `bmp`                | `image/bmp`                                                                 |
| `mp4`, `m4v`         | `video/mp4`                                                                 |
| `webm`               | `video/webm`                                                                |
| `mov`                | `video/quicktime`                                                           |
| `ogv`                | `video/ogg`                                                                 |
| `mp3`                | `audio/mpeg`                                                                |
| `m4a`                | `audio/mp4`                                                                 |
| `wav`                | `audio/wav`                                                                 |
| `ogg`, `oga`, `opus` | `audio/ogg`                                                                 |
| `flac`               | `audio/flac`                                                                |
| `aac`                | `audio/aac`                                                                 |
| `woff`               | `font/woff`                                                                 |
| `woff2`              | `font/woff2`                                                                |
| `ttf`                | `font/ttf`                                                                  |
| `otf`                | `font/otf`                                                                  |
| `pdf`                | `application/pdf`                                                           |
| `doc`                | `application/msword`                                                        |
| `docx`               | `application/vnd.openxmlformats-officedocument.wordprocessingml.document`   |
| `xls`                | `application/vnd.ms-excel`                                                  |
| `xlsx`               | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`         |
| `ppt`                | `application/vnd.ms-powerpoint`                                             |
| `pptx`               | `application/vnd.openxmlformats-officedocument.presentationml.presentation` |
| `odt`                | `application/vnd.oasis.opendocument.text`                                   |
| `ods`                | `application/vnd.oasis.opendocument.spreadsheet`                            |
| `odp`                | `application/vnd.oasis.opendocument.presentation`                           |
| `rtf`                | `application/rtf`                                                           |
| `epub`               | `application/epub+zip`                                                      |
| `zip`                | `application/zip`                                                           |

### `GET /v0/artifacts`

Lists the catalog, newest `createdAt` first with the artifact ID as the tie-breaker.

Query parameters, all optional:

- `type` — only artifacts of this type.
- `sourceKind` — only artifacts whose `source.kind` is this. `sourceId` additionally narrows to one
  place: the source's `botId`, `taskId`, `projectId`, `workspaceId`, or, for an `agent` source,
  `agentId`. `sourceId` without `sourceKind` is `400`.
- `agentId` — only artifacts whose `source.agentId` is this conversation, whatever the kind.
- `authorKind` — only artifacts whose `createdBy.kind` is this. `authorId` additionally narrows to
  one author: the `agentId` or the `userId`. `authorId` without `authorKind` is `400`.
- `includeDeleted` — `true` also lists tombstones; default `false`.
- `limit` — `1`–`100`, default `50`.
- `pageCursor` — the `nextPageCursor` of the previous page. An unrecognized cursor is `400`.

Unknown values of `type`, `sourceKind`, and `authorKind` match nothing rather than failing.

Response — `200`:

```json
{
    "artifacts": [
        /* artifact objects */
    ],
    "nextPageCursor": null,
    "cursor": "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e"
}
```

`nextPageCursor` is `null` on the last page. Page positions follow creation, which never changes,
so paging is stable while artifacts are created, updated, or deleted. `cursor` is the event cursor
captured before the first read: a client that follows `GET /v0/events/stream` from the first page's
`cursor` misses no change made while it loads the rest.

### `GET /v0/artifacts/:artifactId`

Response — `200`: `{ "artifact": { ... } }`, a tombstone included. `404` when no such artifact
exists.

### `GET /v0/artifacts/:artifactId/versions`

Lists an artifact's versions, newest first, each with its whole manifest. Query: optional `limit`
(`1`–`100`, default `50`) and `pageCursor` (the previous page's `nextPageCursor`; an unrecognized
one is `400`).

Response — `200`: `{ "versions": [ /* version objects */ ], "nextPageCursor": null }`. `404` when
no such artifact exists or when it is deleted.

### `GET /v0/artifacts/:artifactId/versions/:number`

`number` is a version number, or `latest` for the version that is latest when the request is
answered.

Response — `200`: `{ "version": { ... } }`. `404` when the artifact or the version does not exist,
or when the artifact is deleted.

### `GET /v0/artifacts/:artifactId/versions/:number/files/*path`

The bytes of one file of one version. `number` is a version number or `latest`, as above, and
`path` is the file's `path` with each segment percent-encoded, so the entry of version 2 is
`/v0/artifacts/r7k2…/versions/2/files/index.md` and its chart
`/v0/artifacts/r7k2…/versions/2/files/images/chart.png`. Because every file of a version lives
under the same prefix, a relative reference in an entry resolves to its file. The daemon decodes
each segment and serves a file only when the decoded path is exactly a `path` in that version's
manifest. Request each file by its exact manifest path; clients and artifacts should not send `.`
or `..` segments. Any that are sent are resolved before routing, and the resolved path must still be
exactly a manifest `path`. Nothing outside the manifest is ever reached: an empty segment, an
encoded `/`, or any other name the version does not hold is `404`, as is a folder.

The response is the file itself, not JSON: `Content-Type` is the file's `mimeType`, with
`; charset=utf-8` added for `text/*` types, and `Content-Length` its size. `ETag` is the quoted
`sha256`, and a matching `If-None-Match` answers `304`. A numbered version never changes, so its
files carry `Cache-Control: private, max-age=31536000, immutable`; files reached through `latest`
carry `Cache-Control: private, no-cache` and are revalidated. Both carry `Vary: Authorization`.
`Content-Disposition: inline` carries the last segment of the path as the file name.

Every file response carries `X-Content-Type-Options: nosniff` and
`Content-Security-Policy: sandbox allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads`.
A page opened from the daemon therefore runs its scripts in an opaque origin: it cannot read the
daemon's other responses, storage, or credentials, and it cannot navigate the window it is shown
in.

`Accept-Ranges: bytes` advertises ranges, which a video player needs to seek. A single
`Range: bytes=start-end`, `bytes=start-`, or `bytes=-suffix` answers `206` with `Content-Range`; a
range outside the file answers `416` with `code: "range_not_satisfiable"` and
`Content-Range: bytes */size`. Multiple ranges are ignored and answer the whole file with `200`.

`404` when the artifact, the version, or the file does not exist, or when the artifact is deleted.
Errors are JSON and `Cache-Control: no-store` as everywhere else.

File routes take the bearer token like every route. A client showing an `html` artifact points a
sandboxed frame at the entry's URL through a transport that adds the token — for example a
desktop protocol handler that forwards `artifact://<artifactId>/<number>/<path>` to this route —
so the page and the files it refers to load through the same prefix. Use a numbered version rather
than `latest` for a page, so the entry and its files always come from the same version. A client
rendering a `markdown` entry itself resolves each relative link or image against the entry's URL
the same way and loads it through this route.

### `GET /v0/artifacts/:artifactId/versions/:number/previews/*path`

The still preview of one file of one version: the picture's, the cover's, or the video poster's,
as the file's `preview` describes. `number` and `path` name the source file exactly as on the file
route, with the same decoding and the same `404` for any name the version does not hold. The
response is the preview's bytes with `Content-Type: image/webp` and `Content-Length`; `ETag`,
`If-None-Match`, `Cache-Control`, `Vary`, `X-Content-Type-Options`, and `Content-Security-Policy`
behave as on the file route, and `Content-Disposition: inline` carries the source's name with a
`.webp` extension. It takes no `Range`.

`404` when the artifact, the version, or the file does not exist, when the artifact is deleted, or
when the file has no `preview`.

### `POST /v0/artifact-uploads`

Uploads one file's bytes for a later creation or update. The body is the raw bytes, not JSON; its
`Content-Type` is ignored, and `application/octet-stream` is a fine choice. An upload has no name
or media type of its own: those come from the `path` it is placed at. An empty body is `400`; a
body over 256 MiB is `413 too_large`. Whether the file fits its place and its type's limits is
checked when the upload is used.

Response — `201`:

```json
{
    "upload": {
        "id": "u8p2l4o6a1d3e5f7g9h0j2k4",
        "size": 48213,
        "sha256": "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
        "createdAt": 1755300000000,
        "expiresAt": 1755386400000
    }
}
```

An upload is used once: the creation or update that places it removes it in the same change. An
upload nobody uses expires 24 hours after it was made, and then neither it nor its bytes remain,
unless an artifact holds the same content. Uploads emit no events and are not listed; whoever holds
an upload's ID may use it.

### Version files

Creation and update both describe files with entries, each placing content at one `path`:

- `{ "path": "index.md", "text": "# Report\n..." }` — the file's whole text, stored as UTF-8. Best
  for Markdown, HTML, CSS, scripts, and other text.
- `{ "path": "images/chart.png", "uploadId": "u8p2l4o6a1d3e5f7g9h0j2k4" }` — an upload's bytes.

Entries may come in any order; a version's files are always kept in `path` order. Two entries for
the same path are `400`.

### `POST /v0/artifacts`

Creates an artifact with its first version.

Request:

```json
{
    "mutationId": "...",
    "id": "r7k2m9q4w1e5t8y3u6i0o2p5",
    "type": "markdown",
    "title": "Q3 revenue report",
    "source": { "kind": "project", "projectId": "p1o2i3u4y5t6r7e8w9q0a1s2" },
    "files": [
        { "path": "index.md", "text": "# Q3 revenue\n\n![Revenue](images/chart.png)\n" },
        { "path": "images/chart.png", "uploadId": "u8p2l4o6a1d3e5f7g9h0j2k4" }
    ]
}
```

- `id` — optional client-supplied artifact ID; the retry key.
- `type`, `title` — required, under the rules above.
- `source` — optional; where the artifact is being created. Its `agentId` may be omitted, except on
  an `agent` source, and a `workspace` source's `projectId` may be omitted; the daemon fills it from
  the workspace. A source naming a bot, task, project, workspace, or agent that does not exist is
  `400`.
- `files` — required, 1–256 version files, as described above: every file of the first version.
- `background` — optional; the first version's background, as described above. Omitted or `null`
  means none. Leave it out unless the content needs one fixed canvas.
- `cover` — optional; the `path` of the first version's cover among `files`, such as
  `"cover.webp"`, or `null` for none. Omitted takes the type's default: an `image`'s own file or an
  `image_series`' first, and none for other types. See "Covers and summaries".
- `summary` — optional; the first version's summary. Omitted or `null` means none.

The first version's `display` is `null`.

A `background` that is not such a colour is `400 invalid_request`, as is a cover or summary that
breaks the rules under "Covers and summaries". Files that break the type's
rules — a missing entry, too many or too few files, a media type the type does not accept, a file
or total over its limit, an entry that is not valid UTF-8, an invalid path, or a path that is also
a folder — are `400 invalid_request`. An upload that does not exist,
has expired, or was already used is `404`, and nothing is created.

Repeating `id` returns the current artifact unchanged with `201`, including after updates or
deletion; the other fields are ignored, no upload is consumed, and no event is emitted.

Response — `201`: `{ "artifact": { ... } }`, created by the authenticated person, and an
`artifact.created` event after commit, echoing `mutationId`.

### `PATCH /v0/artifacts/:artifactId`

Makes a new version. Requires `If-Match` with the artifact's `version`.

Request:

```json
{
    "mutationId": "...",
    "title": "Q3 revenue report, revised",
    "source": { "kind": "project", "projectId": "p1o2i3u4y5t6r7e8w9q0a1s2" },
    "files": [{ "path": "images/chart.png", "uploadId": "u9q3m5p7b2e4f6g8h1j3k5l7" }],
    "remove": ["images/old-chart.png"],
    "replaceAll": false,
    "cover": "images/chart.png",
    "summary": "Revenue up 21% QoQ after the late enterprise deals.",
    "major": 2
}
```

Every field is optional, but at least one of `title`, `background`, `cover`, `summary`, `files`,
`remove`, `replaceAll`, and `major` is required. The new version starts from the latest version's files, or
from none when `replaceAll` is `true`. `files`, up to 256 version files, then adds each path or replaces the
file already there, and `remove`, up to 256 paths, takes files out. A path both written and
removed, or removed but not present, is `400`, and the result must satisfy the type's rules just
as a creation does. An omitted `title` keeps the current title. A `background` colour sets the
new version's background, `null` clears it, and omitting it keeps the latest version's; anything
else is `400`. A `cover` path in the new version sets its cover, `null` clears it, and omitting it
keeps the latest version's cover path, whose file the new version must still hold; a `summary`
sets the new version's summary, `null` clears it, and omitting it keeps the latest one. Both follow
"Covers and summaries". The new version keeps the latest version's `display`. `source` says where this
change is being made; it becomes the new version's `source` and the artifact's `updatedSource`.
`major` makes the new version that major version, as "Versions" describes; without it the new
version is the next minor one.

For live-URL artifacts, metadata-only changes preserve `live` and keep the existing inert entry,
including when the title changes. `files`, `remove`, and `replaceAll` are refused even when empty or false;
the live URL can only be changed through the agent tools.

Response — `200`: `{ "artifact": { ... } }` with the new `latestVersion`, and an `artifact.updated`
event after commit, echoing `mutationId`. File errors are `400` and upload errors `404`, as in
creation. `404` when no such artifact exists; `409 conflict` with `currentVersion` and `artifact`
when `If-Match` names an older version or the artifact is deleted.

### `POST /v0/artifacts/:artifactId/delete`

Deletes the artifact, leaving its tombstone. Requires `If-Match`; the body is `{}`, or carries an
optional `mutationId` and an optional `source` saying where the deletion is being made.

Response — `200`: `{ "artifact": { ... } }` with `status` `"deleted"`, and an `artifact.deleted`
event after commit, echoing `mutationId`. Deleting an artifact that is already deleted answers
`200` with the tombstone and emits nothing, so a retried deletion succeeds even with the version it
was first sent with. `404` when no such artifact exists, and the usual `409` when `If-Match` names
an older version of an active artifact.

### Artifact data

Every artifact has one small key-value store that its file-backed HTML pages read and write, so
an `html` artifact can be a realtime, multi-user app: a shared to-do list, a poll, a game board. A store
belongs to the artifact ID. Every version of the artifact uses the same store, and so does everyone
using the daemon: each device, each client, and in team mode each member. The daemon keeps each
store in its own file outside the main database, at `.happy/agent/artifacts/_data_/<artifactId>/`.
Live-URL pages do not receive this bridge or its credentials; their `/api/*` paths belong to the
external site, not this store.

The data API is served under `/v0/artifacts/:artifactId/api/*` and takes the bearer token like
every route. A page reaches it at `/api/*` of its own origin. The client showing the page forwards
`/api/<rest>?<query>` to `/v0/artifacts/<artifactId>/api/<rest>?<query>` on the same daemon or
connection, unchanged and for every method, and adds the token itself. The page never holds a
token, and the client needs no knowledge of the routes below, so the API grows with the daemon
alone. A forwarding client passes at least the request headers `Content-Type`, `Accept`,
`If-Match`, `If-None-Match`, `Last-Event-ID`, and `Cache-Control`, and the response headers
`Content-Type`, `Content-Length`, `ETag`, `Cache-Control`, `Last-Modified`, `Retry-After`, and
`Location`. It buffers or streams request bodies of up to 1 MiB, streams responses without
buffering, applies no idle timeout to them, and aborts the forwarded request when the page's
request ends. Files a version holds under `api/` are not reachable through such a client, so
artifacts should not hold any. An older daemon answers `404` for the whole prefix.

The routes below are under `/v0/artifacts/:artifactId/api/v1/`. The daemon routes on the request
target as sent, so a path it does not name exactly, `.` and `..` segments included, is `404`.
Every route answers `404` when the artifact does not exist or is deleted. A deleted artifact's data
stays on disk.

**Identity.** The caller is always the authenticated person, never something the page claims. A
user ID is a stable, lowercase alphanumeric ID: in team mode, the member's installation-local Happy
user ID, the same `id` that `GET /v0/users` returns; in standalone mode, an opaque ID that the
installation's one person always has. Agents also read and write stores, through their
`read_artifact_data` and `write_artifact_data` tools; an agent's writes carry a stable opaque ID
of its own that `users` resolves, never the agent's ID. Pages never see an email address, a
WorkOS ID, an agent ID, or the profile's private identity.

**Entries and versions.** An entry is one key and its JSON value:

```json
{
    "key": "todos/01991f3a",
    "value": { "title": "Milk", "done": false },
    "deleted": false,
    "version": "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e",
    "updatedBy": "u1x2y3z4a5b6c7d8e9f0g1h2",
    "updatedAt": 1755400000000,
    "writeId": "w8c1f0e2d"
}
```

- `key` — 1–512 characters, with no control characters. `/` is an ordinary character, so a prefix
  such as `todos/` groups keys.
- `value` — any JSON value, `null` included; at most 256 KiB when serialized as UTF-8 JSON. A
  deletion leaves `value` `null` and `deleted` `true`.
- `version` — a UUIDv7 that the store minted for the write. Every write to a store gets a version
  greater than every earlier one, across restarts and clock changes, so versions order a store's
  changes, double as resume cursors, and carry their write time in the first 48 bits.
- `updatedBy`, `updatedAt` — who made the write, and when: `updatedAt` is the version's
  timestamp in milliseconds.
- `writeId` — the write's idempotency key, or `null`.

A store holds at most 100,000 keys and 64 MiB of keys and values together. A deleted key's
tombstone is kept for 30 days and then forgotten; a cursor from before a forgotten tombstone can
no longer resume.

**Reliable writes.** A write may carry a `writeId`: 1–128 characters from `A–Z a–z 0–9 _ . : -`,
chosen by the client and unique per write. For 24 hours, repeating a write with the same `writeId`
by the same user answers with the first write's result and `replayed: true`, and changes nothing,
even if the key changed since. A client that lost a response can therefore retry safely. Reusing a
`writeId` for another key is `400`.

**Compare-and-set.** A write may carry `If-Match: "<version>"`, which applies only while the key
holds a value at that version, or `If-None-Match: *`, which applies only while the key holds no
value. When the condition fails, the response is `409 conflict` with `entry`: the key as it is now,
or `null`. The quotes around the version are optional, and sending both headers is `400`.

#### `GET /v0/artifacts/:artifactId/api/v1/client.js`

A dependency-free browser SDK. A page loads it with `<script src="/api/v1/client.js"></script>`
and gets `window.happy`. It is served as `text/javascript; charset=utf-8` with an `ETag` and
`Cache-Control: no-cache`, and a matching `If-None-Match` answers `304`. It changes with the daemon,
and pages never need to bundle a copy. The SDK is described in the artifact apps recipe that ships
with these docs (`recipe/artifact-apps.md`).

#### `GET /v0/artifacts/:artifactId/api/v1/style.css`

Happy's standard styles for a page, loaded first with
`<link rel="stylesheet" href="/api/v1/style.css">`. They make the page look like part of whatever
surface shows it: a transparent root, the app's typeface and sizes, its text, link, code, table, and
rule colors, its scrollbars, the body's inset, and the styles of the standard components below.
Every rule has the least specificity it can, so anything the page writes itself wins. They define
custom properties a page may use: the colors `--happy-text`, `--happy-muted`, `--happy-faint`,
`--happy-border`, `--happy-surface`, `--happy-accent`, `--happy-added`, `--happy-removed`,
`--happy-diff-added`, `--happy-diff-removed`, `--happy-chart-1` to `--happy-chart-6`,
`--happy-scrollbar-thumb`, and `--happy-scrollbar-thumb-hover`; `--happy-font`, `--happy-mono`,
`--happy-font-size`, `--happy-line-height`, and `--happy-scrollbar-size`; and `--happy-page-inset`,
the body's `padding`. Each takes the value of a `--happy-host-<name>` property the page's host sets,
when it sets one, and otherwise a default; default colors follow the page's `color-scheme` through
`light-dark()`, and the root's `color-scheme` is `--happy-host-color-scheme`, else `light dark`. A
host showing the page inline sets `--happy-host-page-inset` to `0`, and elsewhere to its own content
inset. The sheet holds no `!important` and no `url()`, so a host may also insert it itself, at user
origin, for a page that does not link it. It is served as `text/css; charset=utf-8` with an `ETag`
and `Cache-Control: no-cache`, and a matching `If-None-Match` answers `304`.

#### `GET /v0/artifacts/:artifactId/api/v1/components.js`

The standard components, loaded last with `<script src="/api/v1/components.js"></script>`. It
defines five custom elements and no other globals. Each reads what it shows from the page itself, so
the page's own scripts are never needed:

- `<happy-diff src="changes.diff">` — a unified diff, such as `git diff` or `diff -u` writes, from a
  file of the artifact named by `src` or from a `<script type="text/x-diff">` child. `path` shows
  one file of it and `lines` (`"40-52"`) only the lines of the changed file in that range, with the
  hunks around them; every file shows a header with its path, status, and added and removed line
  counts.
- `<happy-code src="src/app.ts">` — code, highlighted where the host can, from a file of the artifact
  named by `src` or from a `<script type="text/plain">` child, whose surrounding blank lines and
  common indent are removed. `language` (`"ts"`, `"python"`) names its language, which otherwise
  comes from `path` or `src`; `path` also shows a header with the file's name; and `lines`
  (`"40-52"`) shows only the lines in that range. Lines are numbered, by their place in the code,
  when it comes from `src` or `lines` is given.
- `<happy-files src="changes.diff">` — files as a tree grouped under their folders: the files a
  diff changes, with their status and counts, or the paths of a `<script type="application/json">`
  child holding an array of `{ "path", "status"?, "added"?, "removed"? }`. A file that a
  `<happy-diff>` on the page shows scrolls to it when clicked.
- `<happy-chart type="bar">` — a chart drawn as SVG at the element's width: `type` is `"bar"`,
  `"hbar"`, `"line"`, or `"area"`, and a `<script type="application/json">` child holds
  `{ "labels": ["…"], "series": [{ "name": "…", "values": [1, 2] }], "unit"?: "…" }`.
- `<happy-diagram>` — a Mermaid diagram, from a `<script type="text/x-mermaid">` child, drawn as SVG
  in the page's colors: flowcharts, sequence, state, class, and entity-relationship diagrams.

Diffs and code are drawn by the code renderer the page's host provides, if it has one: the
script loads `code.js` beside itself, at `/api/v1/code.js` of the page, as an ES module, only when
the page holds a `<happy-diff>` or `<happy-code>`. Happy Desktop provides the renderer and styling
it uses for full-file diffs and code, so they look the same inline. The daemon itself serves no
such module and answers `404`; without one, and wherever the renderer fails, each element draws
plain monospace text with numbered lines and colored additions and deletions, and no highlighting.
Long lines wrap unless the element has a `nowrap` attribute, which scrolls them instead.

A host's `code.js` exports `version` (`1`) and two functions. Each draws into `target`, an empty
element inside the component, and returns `{ dispose() }`, or a promise of it, which the component
calls before drawing again or when it is removed; a function that throws or rejects leaves that
element to the plain rendering.

- `renderDiff(target, { patch, path, previousPath, status, wrap })` — one file: `patch` is its
  git patch (`diff --git` header, mode and rename lines, `---` and `+++` lines, and the hunks shown,
  already cut to `path` and `lines`), `path` its path (the old path when deleted), `previousPath`
  its old path when renamed or else `null`, `status` `"added"`, `"deleted"`, `"renamed"`, or
  `"modified"`, and `wrap` whether long lines wrap.
- `renderCode(target, { code, path, name, language, lines, lineNumbers, wrap })` — `code` is the
  whole text, `path` the `path` attribute or `null` (a header naming the file is drawn when set),
  `name` the path or `src` to infer a language from, `language` the `language` attribute or
  `null`, `lines` `{ "first", "last" }` (1-based and inclusive) to show only those lines numbered as
  in the code, or `null`, `lineNumbers` whether to number lines, and `wrap` as above. A language the
  renderer does not know is drawn as plain text.

The style sheet colors the renderer's `diffs-container` element through its `--diffs-*` custom
properties, from the page's own `--happy-*` colors and fonts.

An element that cannot show what it was given says why in its own place rather than leaving the page
blank, and reports the same as a `warn` entry with source `console` to the page's debug log, through
the SDK when the page loads it and otherwise by posting it itself, each message once and at most 20
per page. The script is served like `style.css`, and so is the diagram renderer it loads on demand, at
`GET /v0/artifacts/:artifactId/api/v1/diagrams.js`, which pages never load themselves. The set of
elements may grow; an element the script does not define is left as the page wrote it.

#### `GET /v0/artifacts/:artifactId/api/v1/me`

Response — `200`:

```json
{
    "user": {
        "id": "u1x2y3z4a5b6c7d8e9f0g1h2",
        "kind": "user",
        "name": "Steve Korshakov",
        "firstName": "Steve",
        "lastName": "Korshakov",
        "photoUrl": "/api/v1/users/u1x2y3z4a5b6c7d8e9f0g1h2/photo?v=9f86d081884c7d65"
    }
}
```

`kind` is `"user"` for a person and `"agent"` for an agent that wrote through its tools; `me` is
always a person. `name`, `firstName`, `lastName`, and `photoUrl` are `null` when the person has not
set them. The name is split at its first whitespace, as in the profile. `photoUrl` is relative to
the page's origin, and it changes when the photo does. An agent's `name` and `firstName` are its
bot's name, or `"Agent"`; its `lastName` and `photoUrl` are `null`.

#### `GET /v0/artifacts/:artifactId/api/v1/users?ids=...`

Resolves up to 100 comma-separated user IDs, for example the `updatedBy` of entries. Response —
`200`: `{ "users": [ ... ] }`, user objects as in `me`, in the order asked, each once. Unknown IDs
are left out. In standalone mode the installation's one person is the only person known. Agents
are known by the stores they wrote to, so an agent's ID resolves through each artifact it wrote. More than 100 IDs,
an invalid ID, or a repeated `ids` parameter is `400`.

#### `GET /v0/artifacts/:artifactId/api/v1/users/:userId/photo`

The user's photo bytes, with their content type, `ETag`, `304` on a matching `If-None-Match`, and
the shared image-caching policy. `404` when the user is unknown or has no photo.

#### `GET /v0/artifacts/:artifactId/api/v1/kv`

Lists live entries in key order. Query parameters, all optional:

- `prefix` — only keys starting with this.
- `limit` — `1`–`1000`, default `100`.
- `pageCursor` — the previous page's `nextPageCursor`.

Response — `200`:

```json
{
    "entries": [
        /* live entries */
    ],
    "nextPageCursor": null,
    "cursor": "01991f3a-..."
}
```

`cursor` is the store's newest version when the page was read, or `null` for a store nobody has
written to. A client that follows `kv/events` from the first page's `cursor` misses no change.

#### `GET /v0/artifacts/:artifactId/api/v1/kv/entry?key=...`

Response — `200`: `{ "entry": { ... } | null, "cursor": "..." | null }`. `entry` is `null` while
the key holds no value. `cursor` is as in the list.

#### `PUT /v0/artifacts/:artifactId/api/v1/kv/entry?key=...`

Sets the key. Body: `{ "value": <JSON>, "writeId": "..." }`; `value` is required, and `writeId` is
optional. Takes the optional compare-and-set headers.

Response — `200`: `{ "entry": { ... }, "replayed": false }`, the entry as this write left it. A
value over 256 KiB, or a body over 1 MiB, is `413 too_large`. A write that would take the store past
its limits is `507 storage_full`. During a daemon drain, writes are `503 draining`; retry them.

#### `DELETE /v0/artifacts/:artifactId/api/v1/kv/entry?key=...`

Deletes the key, leaving a tombstone. The body is empty or `{ "writeId": "..." }`, and the request
takes the optional compare-and-set headers. Response — `200`: `{ "entry": { ... }, "replayed": false }`
with `deleted` `true`. Deleting a key that is already deleted answers with its tombstone and
changes nothing.

#### `GET /v0/artifacts/:artifactId/api/v1/kv/changes`

The changes after a version, in version order. Query parameters, all optional:

- `since` — a version that this store returned. Omitted, the feed starts at the beginning.
- `prefix` — only keys starting with this.
- `limit` — `1`–`1000`, default `100`.

Each changed key appears once, as it is now, tombstones included. Response — `200`:

```json
{
    "changes": [
        /* entries */
    ],
    "cursor": "01991f3a-...",
    "hasMore": false
}
```

Pass `cursor` as the next `since`. While `hasMore` is `true`, more changes follow at once. `since`
older than a forgotten tombstone, or newer than any version the store has minted, is
`409 cursor_unavailable`: read the store again with `kv`, then follow it from that `cursor`.

#### `GET /v0/artifacts/:artifactId/api/v1/kv/events`

Server-Sent Events for the store, as `text/event-stream; charset=utf-8`. Query: optional `since`,
a version as in `kv/changes`, or the `Last-Event-ID` header instead; and optional `prefix`. Events:

- `change` — one committed entry as `data`, with the entry's version as the event `id`. Changes
  arrive in version order and include changes made by every user, device, and connection, the
  caller's own included.
- `ready` — `data: { "cursor": "..." | null }`. When `since` is given, every change after it is
  sent first, then `ready`. Without `since`, `ready` comes first and carries the store's current
  cursor, so a client reads what it needs and applies the stream on top. Live changes follow
  `ready`.
- `reset` — `data: { "reason": "cursor_unavailable" }`; the stream then ends. `since` can no
  longer resume, or it is too far behind to replay. Read the store again and open a stream
  without `since`. An `EventSource` must be closed and opened again, because it would resend the
  same `Last-Event-ID`.
- `closed` — `data: { "reason": "artifact_deleted" }`, or `"shutdown"` when the daemon stops;
  the stream then ends.

A `: ping` comment arrives every 15 seconds. A client that hears nothing for 45 seconds treats
the stream as dead and reconnects with `since` set to the last version it saw. The stream also
ends when the client reads it too slowly; reconnect the same way.
At most 64 streams may be open for one artifact and 512 in all; another is `429 too_many_streams`
with `Retry-After`.

#### `POST /v0/artifacts/:artifactId/api/v1/debug/log`

Keeps what a page reports about itself in the artifact's debug log, so the agent that built the
app can see what went wrong for the people using it. The SDK reports on its own: uncaught errors,
unhandled rejections, `console.error` and `console.warn`, and its own sync trouble. The standard
components report what an element could not show, even on a page without the SDK. Body:

```json
{
    "entries": [
        {
            "level": "error",
            "source": "uncaught",
            "message": "TypeError: board is undefined",
            "data": { "stack": "TypeError: board is undefined\n    at render (index.html:12:5)" },
            "at": 1755400000000
        }
    ],
    "url": "https://.../index.html"
}
```

- `entries` — 1–50 entries. `level` is `error`, `warn`, or `info`. `source` is `uncaught`,
  `rejection`, `console`, `sync` (the SDK's own reports), or `app` (what the page logs itself).
  `message` is at most 4,096 characters. `data` is optional JSON; data over 8 KiB when serialized
  is kept as `{ "truncated": "<its first 1,024 characters>" }`. `at` is the page's own clock in
  milliseconds, optional.
- `url` — the page's address, at most 1,024 characters, or `null`; optional.

Response — `200`: `{ "accepted": 2, "dropped": 0 }`. Each entry is kept with the caller's user
ID, the time the daemon received it, and the artifact's newest version number at that moment.
One user may add 120 entries to one artifact's log per minute; entries past that are dropped and
counted in `dropped`, and the request still succeeds. An invalid body is `400`.

The log lives beside the artifact's data, in `logs.sqlite` in the same directory, and keeps the
newest 1,000 entries of the last 7 days. It is read by agents through their `read_artifact_logs`
tool, newest first, filtered by level, user, and time. Pages cannot read it.

## Feed

The Feed is one list per person of what happened on the installation: new tasks, bots, and
Surfaces, new todos, edits to documents, and new and changed artifacts. Changes to one thing that
the person has not looked at yet fold into one entry. Once they look at it, the next change starts
a new entry. A daemon that serves the Feed reports `capabilities.feed: true` from health.

**Subjects.** Every entry is about one subject, `{ "type": "...", "id": "..." }`. The types are:

- `task` — a task, by its task ID.
- `bot` — a bot, by its bot ID.
- `surface` — a Surface of any type, by its Surface ID. A todo list's new todos and a document's
  edits are changes to their Surface, so they fold into the Surface's entry.
- `artifact` — an artifact, by its artifact ID.

The set of types grows with the product; a client leaves out an entry whose type it does not
recognize.

**What makes an entry.** These changes reach the Feed:

| Subject    | Change                                          | Counted as               | Clusters                         |
| ---------- | ----------------------------------------------- | ------------------------ | -------------------------------- |
| `task`     | the task was created                            | creation                 | `team`, `task:<taskId>`          |
| `bot`      | the bot was created                             | creation                 | `team`, `bot:<botId>`            |
| `surface`  | the Surface was created, of any type            | creation                 | `team`, `surface:<surfaceId>`    |
| `surface`  | a todo was created in a todo list               | update: one new todo     | `surface:<surfaceId>`            |
| `surface`  | a document was edited                           | update: one edit session | `surface:<surfaceId>`            |
| `artifact` | the artifact was created with its first version | creation                 | from its `source`, below         |
| `artifact` | a new version was made                          | update: one new version  | from the version's source, below |

Document edits are folded before they reach the Feed: a person's or agent's edits to one document
form one **edit session**, which ends after 10 minutes without an edit by that same actor. A
session is one change, recorded when its first edit is accepted; later edits in the same session
add nothing to the Feed.

Nothing else reaches the Feed today: renaming, archiving, changing a picture, completing or
editing todos, deleting artifacts, calendar events, and chat Surface messages do not. None of them
needs to: entries hold no names or pictures to bring up to date, as described next.

**Showing an entry.** An entry holds references and counts, never the subject's data. It names
the subject, the actors, its clusters, and the newest change (`latest`), and counts the changes;
it never carries a title, name, text, picture, avatar, Surface type, or the agent that opens a
chat. Clients render every entry from the entities they already sync, so a rename, a task naming
itself, a new picture, or an edited todo shows in every entry at once, with no Feed event. A
client resolves:

- a `task` subject or `task:` cluster from the tasks it syncs: desktop bootstrap `tasks` and
  `GET /v0/tasks`, both archived tasks included, `GET /v0/tasks/:taskId`, and the `task.*` events.
  The task's agent, which opens its chat, is its embedded `agent`.
- a `bot` subject or `bot:` cluster from bootstrap `bots` and `GET /v0/bots`, archived bots
  included, `GET /v0/bots/:botId`, and the `bot.*` events; its picture from
  `GET /v0/bots/:botId/avatar`.
- a `surface` subject or `surface:` cluster from bootstrap `surfaces` and `GET /v0/surfaces`, and
  the `surface.*` events; its picture from `GET /v0/surfaces/:surfaceId/image`. Surfaces are never
  deleted.
- the newest todo (`latest.todoId`) from `GET /v0/surfaces/todo/:surfaceId/:todoId`, deleted
  todos included, and the `todo.*` events; the document edit that began a session
  (`latest.seq`) from `GET /v0/surfaces/document/:surfaceId?seq=N` and `GET .../updates`.
- an `artifact` subject from `GET /v0/artifacts/:artifactId`, which also answers a deleted
  artifact's tombstone, `GET /v0/artifacts?includeDeleted=true`, and the `artifact.*` events; the
  version an entry names (`latest.artifactVersion`) from
  `GET /v0/artifacts/:artifactId/versions/:number` while the artifact is not deleted.
- a `project:` or `workspace:` cluster from `GET /v0/projects` (archived included),
  `GET /v0/projects/:projectId`, `GET /v0/workspaces/:workspaceId`, and their events.
- an actor's `userId` through `GET /v0/users`, members and guests alike, kept current by
  `profile.updated`, and the standalone person through the profile; an actor's `agentId` through
  `GET /v0/agents/:agentId` and `agent.updated`.

A client shows an entry once it holds the entities the entry names, rather than placeholder text
in their place. An entry whose subject no longer exists — a task or bot that was permanently
deleted — is removed from every feed with `feed.item.removed`.

**Clusters.** Every change belongs to one or more clusters, which are what a person subscribes
to, mutes, and peeks at. A cluster is named by a string:

- `team` — what happens across the team: new tasks, bots, and Surfaces.
- `task:<taskId>`, `bot:<botId>`, `surface:<surfaceId>`, `project:<projectId>`,
  `workspace:<workspaceId>` — one task, bot, Surface, project, or workspace.

An artifact change belongs to the clusters of its source: `task:<taskId>` for a task source,
`bot:<botId>` for a bot, `project:<projectId>` for a project, both `project:<projectId>` and
`workspace:<workspaceId>` for a workspace, and `team` for an `agent` source, no source, or a kind
the daemon does not map. The last cluster in each list above is the change's **home cluster**,
which entries report as `cluster`. The set of cluster kinds grows with the product; clients treat
an unknown kind as an opaque name.

**Who receives a change.** In team mode, every enrolled member who can sign in has their own
feed; guests of exported bots have none, and every Feed route answers them `404 not_found`. A
member who has not finished their profile yet has an empty feed. In standalone mode the
installation's one person has the only feed. A change reaches a person when all of these hold:

- its **audience** includes them. A change's audience is `everyone`, or a list of user IDs. Today
  every change is for everyone; the audience is checked everywhere the Feed reads its history, so
  a restricted change never appears through seeding or peeking either;
- they have not muted any of its clusters;
- they are subscribed to `*`, which means everything, or to one of its clusters.

Every person is subscribed to `*` until they mute it, so by default everyone's feed holds
everything. Muting a cluster wins over every subscription: muting `task:<taskId>` silences that
task's creation and its artifacts even while subscribed to `*`. Muting `*` stops everything except
clusters the person subscribed to themselves. Fan-out to people happens shortly after the change
commits, in the order the changes happened, and survives daemon restarts; a client learns of new
entries through the events below rather than by reading the feed right after a mutation.

**Folding.** Each person has at most one **open** (unseen) entry per subject. A change to a
subject folds into the person's open entry for it: `updates` grows by one (or `created` becomes
`true`), `cursor` and `lastAt` advance, the actor is added, and `latest` names the change.
Without an open entry, the change opens a new one. Seeing the subject closes the open entry, so
the next change opens another. A person who opens an artifact after each of fifty
changes has fifty-one entries, each with one change; a person who never opens it has one entry
with its creation and fifty updates.

**Your own changes count as seen.** A change a person makes directly, whose actor is that person
with no agent, is already seen for them: it folds into their newest entry for the subject, open
or seen, and leaves that entry seen; when they have no entry for the subject yet, it opens one
already seen. It never raises their unread count. A change an agent makes, including one on that
person's behalf, does not count as seen.

**Seeing.** Clients mark subjects seen with `POST /v0/feed/seen` when the person opens one: a task
or bot chat, a Surface, an artifact, or the entry itself. `POST /v0/tasks/:taskId/read` also marks
the `task` subject seen for the caller, and `POST /v0/agents/:agentId/read` on a task's or bot's
agent marks that task or bot seen, so clients that already call them need nothing more for those.

**Seeding.** When a person joins the Feed — a member finishing their profile, or the standalone
person when the daemon first serves the Feed — and when they subscribe to a cluster, the daemon
gives them context from the shared history instead of unread entries: for the clusters concerned
(everything, on joining), it takes the changes of the last 30 days that would reach them, groups
them per subject, and writes one entry for each of the 200 most recently changed subjects. Seeded
entries are already seen. Subjects the person already has an entry for are skipped. Seeded
entries announce themselves through `feed.item.created` like any other.

**Retention.** The shared history keeps 90 days of changes. Each person's feed keeps their newest
1,000 entries by `cursor` and drops entries whose `lastAt` is older than 90 days. Retention emits
no item events; a client holding an entry the daemon dropped may keep showing it until it next
reads the feed. Dropping open entries emits `feed.unread.updated` with the person's new count. When an admin bot [permanently deletes](#permanent-deletion) a task or bot, its changes
and every person's entries for it are removed, and each person holding such an entry receives
`feed.item.removed`.

**Privacy.** Each person's entries, unread count, subscriptions, and Feed events are their own. In
team mode one member never reads or receives another member's.

### The feed item object

```json
{
    "id": "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e",
    "version": "01991f3b-0a1c-7000-8000-1b2c3d4e5f60",
    "cursor": "01991f3b-09f2-7000-8000-7a6b5c4d3e2f",
    "subject": { "type": "artifact", "id": "r7k2m9q4w1e5t8y3u6i0o2p5" },
    "cluster": "task:t4k8m2q9w1e5r7y3u6i0o2p4",
    "created": true,
    "updates": 49,
    "actors": [
        { "userId": null, "agentId": "a9b8c7d6e5f4g3h2i1j0k9l8" },
        { "userId": "u1x2y3z4a5b6c7d8e9f0g1h2", "agentId": null }
    ],
    "actorCount": 2,
    "latest": { "type": "artifact.updated", "artifactVersion": 50 },
    "firstAt": 1755300000000,
    "lastAt": 1755400000000,
    "seenAt": null
}
```

- `id` — a UUIDv7 minted when the entry opened. It never changes, including when the entry takes
  in a change and moves up; clients key rows by it.
- `version` — a UUIDv7 minted at every change to the entry, including being seen. Of two copies
  of the same entry, the one with the greater `version` is current.
- `cursor` — the UUIDv7 of the newest change folded in, and the feed's sort key: entries are
  listed newest `cursor` first. It is a position in the Feed's history, not an event-stream
  cursor.
- `subject` — what the entry is about, as described above.
- `cluster` — the home cluster of the newest change folded in.
- `created` — whether the subject's creation is among the folded changes.
- `updates` — how many further changes are folded in: new todos for a todo list, edit sessions for
  a document, new versions for an artifact.
- `actors` — who made the folded changes: the first five distinct actors, in the order they first
  acted. An actor is `{ "userId", "agentId" }`. A person acting directly has their `userId` and a
  `null` `agentId`. An agent's change has its `agentId`, with `userId` naming the person it was
  working for when the daemon knows them, otherwise `null`. Both are `null` for a change nobody is
  attributed with. In standalone mode `userId` is always `null`. Resolve people through
  `GET /v0/users`, and the standalone person through the profile.
- `actorCount` — how many distinct actors are folded in, which may exceed the five listed.
- `latest` — the newest change folded in, by reference:
    - `type` — what the change was: `task.created`, `bot.created`, `surface.created`,
      `todo.created`, `document.edited`, `artifact.created`, or `artifact.updated`. The set grows
      with the product; a client treats a type it does not recognize as a change to the subject
      without further detail.
    - `todoId` — for `todo.created`, the new todo's ID, in the Surface the entry is about.
    - `seq` — for `document.edited`, the `seq` of the document change that began the edit
      session.
    - `artifactVersion` — for `artifact.created` and `artifact.updated`, the number of the version
      the change made.

    Each is absent for every other type. `todoId` and `seq` are also absent from changes the
    first Feed daemons recorded, before entries named their newest change; a client then shows
    the change without that detail. These fields name the change: the todo's text, the
    document's content, and the version's title are read from the entities they name. Fields may
    be added; clients ignore ones they do not know.

- `firstAt`, `lastAt` — when the oldest and newest folded changes happened, epoch milliseconds.
- `seenAt` — when the person saw the entry, or `null` while it is open. Seeded entries and entries
  of the person's own changes carry the time they were written.

**Peek entries.** Peeking and the history it reads have no person attached, so a peek entry is
the feed item without `id`, `version`, and `seenAt`: `cursor`, `subject`, `cluster`, `created`,
`updates`, `actors`, `actorCount`, `latest`, `firstAt`, and `lastAt`, folding every change to
the subject that the window covers.

### The cluster object

```json
{
    "cluster": "task:t4k8m2q9w1e5r7y3u6i0o2p4",
    "kind": "task",
    "state": null,
    "lastAt": 1755400000000
}
```

A cluster, like an entry, carries references only. Clients label `*` and `team` themselves and
show any other cluster by resolving the task, bot, Surface, project, or workspace its name points
at, as described under "Showing an entry".

- `cluster` — the cluster's name, as above, or `*` for everything.
- `kind` — `"everything"` for `*`, `"team"`, `"task"`, `"bot"`, `"surface"`, `"project"`, or
  `"workspace"`. The set grows with the product. For the kinds that name one thing, the ID follows
  `<kind>:` in `cluster`.
- `state` — the caller's own choice: `"subscribed"`, `"muted"`, or `null` when they made none and
  the cluster follows `*`. For `*` it is `"subscribed"` or `"muted"`, never `null`.
- `lastAt` — the newest retained change in the cluster that the caller's audience allows, or
  `null`.

### `GET /v0/feed`

The caller's feed, newest `cursor` first.

Query parameters:

- `before` — optional; an entry `cursor`. Only entries with an older `cursor` are listed, so a
  client passes the last entry it holds to load the next page.
- `limit` — optional, 1–200, default 50.
- `subjects` — optional; a comma-separated list of subject types, such as
  `subjects=artifact,task`. Only entries about those types are listed, and `before`, `limit`, and
  `hasMore` page within that filtered list. An unknown type matches nothing and is not an error,
  and empty names are skipped, so a list naming none lists nothing. Daemons with
  `capabilities.feedSubjectFilter`.

A malformed `before` or `limit`, or a `subjects` list naming more than 32 types or a type longer
than 64 characters, is `400 invalid_request`.

**Highlights.** Clients offer a Highlights view of the Feed: entries about artifacts and tasks,
read with `subjects=artifact,task`. Live `feed.*` events are not filtered; a client showing a
filtered view leaves out entries whose subject type is outside it.

Response — `200`:

```json
{
    "items": [
        /* feed item objects, newest cursor first */
    ],
    "unread": 3,
    "filteredUnread": 1,
    "hasMore": true,
    "cursor": "01991f3a-6d2f-7000-8000-3a0b2c4d5e6f"
}
```

- `items` — at most `limit` entries.
- `unread` — how many of the caller's entries are open, of every subject type, filtered or not.
- `filteredUnread` — with `subjects`, how many of the caller's entries about those types are open;
  absent without `subjects`.
- `hasMore` — whether older entries exist beyond this page.
- `cursor` — the event cursor captured before reading. Follow the `feed.*` events from it. An entry
  that takes in a change while a client pages moves to the top, so a client merges entries by
  `id` and keeps the greater `version`.

### `POST /v0/feed/seen`

Marks subjects seen for the caller, closing their open entries.

Request:

```json
{
    "subjects": [
        {
            "type": "artifact",
            "id": "r7k2m9q4w1e5t8y3u6i0o2p5",
            "through": "01991f3b-09f2-7000-8000-7a6b5c4d3e2f"
        }
    ],
    "mutationId": "..."
}
```

- `subjects` — 1–100 subjects. `type` is 1–64 characters and `id` 1–96 characters.
- `through` — optional: the entry `cursor` the client was showing. When the open entry has since
  taken in a newer change, it stays open, so a change that arrived while the person was looking
  is not hidden. Omitted, the open entry closes whatever it holds.

Subjects the caller has no open entry for, including unknown subjects and types, change nothing
and are not an error. Unknown fields and malformed values are `400 invalid_request`.

Response — `200`: `{ "items": [ /* the entries this request closed */ ], "unread": 2 }`. Each
closed entry emits `feed.item.updated`, then `feed.unread.updated` follows once, all after
commit and echoing `mutationId`. A request that closes nothing emits nothing.

### `POST /v0/feed/read-all`

Closes every open entry of the caller.

Request: `{}`, or `{ "through": "...", "subjects": ["artifact", "task"], "mutationId": "..." }`.
Optional `through` is an entry `cursor`: only open entries whose `cursor` is not newer close, so
entries that arrived after the client last drew the feed stay open. Optional `subjects` is a JSON
array of up to 32 subject types, each 1–64 characters: only open entries about those types close,
so "Mark all read" in a filtered view such as Highlights closes only what that view shows. An
unknown type closes nothing. Daemons with `capabilities.feedSubjectFilter`; older daemons refuse
`subjects` with `400`.

Response — `200`: `{ "unread": 0 }`, the caller's remaining open entries of every subject type. Each closed entry emits
`feed.item.updated`, then `feed.unread.updated` follows once, all after commit and echoing
`mutationId`. A request that closes nothing emits nothing.

### `GET /v0/feed/clusters`

Response — `200`: `{ "clusters": [ /* cluster objects */ ] }`: `*` first, then `team`, then every
other cluster named by a retained change the caller's audience allows or by one of the caller's
choices, newest `lastAt` first with clusters without changes last, at most 500 in all. A task,
bot, Surface, project, or workspace that no longer exists is left out.

### `PUT /v0/feed/subscriptions/:cluster`

Subscribes the caller to a cluster and seeds it, as described under Seeding. `:cluster` is the
cluster's name as one percent-encoded path segment, such as `task%3At4k8m2q9w1e5r7y3u6i0o2p4`, or
`*` (`%2A`) for everything. The body is `{}` or `{ "mutationId": "..." }`. Subscribing again
changes nothing but still seeds subjects the caller has no entry for. Subscribing to `*` seeds
every cluster.

Response — `200`: `{ "cluster": { ... } }` with `state` `"subscribed"`. Each seeded entry emits
`feed.item.created` after commit, echoing `mutationId`. Subscription choices themselves emit no
event; a client showing them reads `GET /v0/feed/clusters` again.

A cluster name that is not `*`, `team`, or a known kind followed by `:` and a lowercase
alphanumeric ID is `400 invalid_request`. A well-formed name whose task, bot, Surface, project, or
workspace does not exist is `404 not_found`.

### `DELETE /v0/feed/subscriptions/:cluster`

Mutes a cluster for the caller, as described under Who receives a change. Entries the caller
already has stay. The body is empty, `{}`, or `{ "mutationId": "..." }`; the path and errors are as
for subscribing.

Response — `200`: `{ "cluster": { ... } }` with `state` `"muted"`. Nothing else changes and no
event is emitted.

### `GET /v0/feed/clusters/:cluster`

Peeks at a cluster without subscribing: reads the shared history of the last 30 days for the
cluster, filtered by the caller's audience, grouped per subject. Nothing is written and nothing is
marked seen. The path and errors are as for subscribing; `*` peeks at everything.

Query `limit` is optional, 1–200, default 50: how many subjects to return.

Response — `200`: `{ "cluster": { ... }, "entries": [ /* peek entries, newest cursor first */ ] }`.

## Live voice sessions

GPT-Live controls the initiating desktop window through a fixed set of UI-equivalent actions.
It is not bound to a coding agent and does not receive that agent's tools. The desktop verifies
each action's target and permissions and executes it through its existing UI/state actions. Only
public conversation text is shared: no coding tools, screen capture, other sessions' audio,
private reasoning, or tool logs. Voice covers only the agents of the daemon serving the call;
remote connections and peers are never read or acted on.

**Voice.** GPT-Live hands every request to the person's Voice agent: one long-running subtask of
Happy per person, created the first time that person starts a call and kept across calls. Voice is
an ordinary agent: it appears in Happy's `subtasks`, is created unreported, has a conversation of
its own, and is recognised by an agent ID the daemon stores for the person, not by metadata. When the person
archives it, the next call creates a new Voice. Voice has a fixed tool array and fixed
instructions that are not configurable: a tool that lists the person's sidebar, a tool that
reads the public user and assistant text of any conversation on this daemon the person can see, and
every desktop action below for the window of the call it is serving, so it can do whatever the
person does by clicking.
Calls in several windows share the person's one Voice and one queue; each request's actions go
only to the window of the call that made it, and a request the person writes in Voice's
conversation has no window to act on.

Voice runs the machine's voice settings (`config.voice`, see `GET /v0/config`).
By default it uses `openai/gpt-6.1-sol` at low effort through the daemon's configured-default
provider or account pool. The settings may instead name any configured provider, account, or
account pool, any model that provider offers from any vendor, an effort that model accepts, and
fast mode. Fast mode requests the `priority` service tier only when the selected route's catalog
offers it; otherwise it is ignored, and the effective settings say so. The daemon captures the
selection when the call starts, verifies that the provider is enabled and offers the model and
effort, resolves one compatible enabled account, and freezes provider, account, model, effort,
and service tier for the call: every request of that call reaches Voice with that exact selection.
For an account pool it prefers the call's own voice credential account when the pool includes
it, then an account without a recent sign-in or usage failure. Later settings changes affect only
new calls. The explicitly selected voice credential remains separate. A creation request cannot
override this selection. An unavailable or incompatible controller route fails with
`503 live_unavailable` and a setup explanation; the call never silently switches models or
accounts. A selection whose model is incompatible with Voice's previous one starts Voice's
conversation afresh, as any agent's model change does.

The voice model's system prompt is the settings' override when one is stored, otherwise the
built-in default. It is also captured when the call starts.

Provider delegations enter a bounded first-in, first-out queue per person; an ordinary follow-up
is queued rather than refused as busy. Voice handles one request at a time: the next request is
given to it only after the previous one's outcome is delivered, and the desktop has at most one
outstanding action. Each request retains its original delegation identity and source transcript
identities. It reaches Voice as one message in Voice's conversation holding the delegation text,
the call's new attributed user and assistant transcript fragments, and the sidebar outline when it
changed since Voice last received one. That message is attributed provider context with agent
origin, never a person's own message, so it is not human authorization. Every dispatched desktop
action uses the current accepted context revision. Spoken outcomes use human-readable names rather
than internal IDs; ambiguous names require clarification.

Voice's conversation is durable and persists across calls like any agent's. It holds Voice's own
tool calls and results; ordinary automatic compaction bounds it. Coding tool calls, tool results,
private reasoning, and provider metadata of other conversations are never imported, and Voice's
own tool traffic is never copied into GPT-Live. The person may open Voice's conversation and
write to it; such a message is the person's own request, and Voice answers in text, not speech.
Completed actions remain recorded in the call's bounded deduplication ledger. Failed requests
report truthful plain-text outcomes and uncertainty and never replay a desktop action. A request
is never retried after it fails. Desktop actions are not durable tool calls: one interrupted by a
restart becomes an error result and is never executed again.

Each active request is bounded to 120 seconds, excluding queue time, and eight inference rounds;
at either limit the daemon stops Voice's turn and delivers a fixed explanation. Queued requests
expire after 120 seconds without starting an action. Closing voice cancels queued requests and
stops Voice's active turn; Voice itself remains. Already-started desktop mutations retain the
existing uncertainty and deduplication rules. When the frozen account's sign-in is rejected or its
usage runs out, the explanation says so and what the person can do.

A request whose actions all succeed and end in a terminal action — `desktopOpen`, `sessionSend`
staging, `composerDraftAppend`, `sessionModelChange`, or `taskCreate` — receives a fixed,
truthful outcome composed by the daemon from the verified results, delivered as soon as the last
result is verified. Voice's turn may continue to completion, but nothing more from that turn is
spoken. Requests that read state or receive a refusal or failure are answered with Voice's final
text for that request. No outcome is delivered to the voice model before the action it describes
has a verified result.

The voice model receives the person's sidebar outline as Markdown under a `# Sidebar` heading,
described below, when the call starts and again only when the sidebar itself changes. Agent
activity is never pushed: no run starts or settlements, message briefs, conversation statuses,
or desktop AppState. The outline is attributed data, not instructions, authorization, or an order
to speak. The voice model may answer directly from it; anything else, including whether some work
finished, requires a request to Voice, which looks it up when asked.

Every route uses ordinary API authentication. A session belongs to its creating principal;
another principal receives `404` for its ID and never receives its journal events. The session
is also bound to the initiating `windowId`; its control socket must name that same window.
The trusted desktop host binds the socket to the actual window, not a renderer-selected foreign
window. Provider transcripts and generated action text remain attributed provider context, not
automatically trusted human authorization. Existing permissions, role checks, and required human
confirmations still apply. Voice cannot answer permission prompts or grant bot administration.

The browser owns microphone and speaker WebRTC tracks. The daemon exchanges SDP using the
explicitly selected server-held credential and owns the sideband, delegation identities,
bounded text updates, and shutdown. Credentials never enter responses, events, URLs, or the
browser. Selecting a Codex subscription credential is an explicit experimental choice, not a
promise of entitlement; selecting an OpenAI API key explicitly opts into API billing. The
daemon never falls back between credential kinds, accounts, or transports after a refusal.
Use current GPT-Live only: the public `gpt-live-1` transport or Codex's native
`gpt-live-1-codex` integration. Never fall back to older Realtime models or protocols.

### The live session object

```json
{
    "id": "l1a2b3c4",
    "windowId": "desktop-window-1",
    "credential": { "type": "codex_subscription", "providerId": "codex" },
    "contextRevision": 1,
    "status": "active",
    "usage": { "seconds": 12, "final": false },
    "error": null,
    "createdAt": 1755400000000,
    "updatedAt": 1755400012000,
    "endedAt": null,
    "version": "01991f3a-6d2f-7000-8000-3a0b2c4d5e6f"
}
```

- `id` — Happy's CUID2 resource ID, distinct from any provider session or delegation ID.
- `windowId` — the initiating desktop window's opaque lifetime identity; immutable.
- `credential` — the immutable selection: `type` is `codex_subscription` or `openai_api_key`,
  and `providerId` names an enabled configured provider holding that exact credential kind.
  An unavailable provider, missing credential, or kind mismatch fails without trying another.
- `contextRevision` — the latest accepted desktop context revision, a positive safe integer.
  Context contents and watch selection remain private to the control connection, not the journal.
- `status` — `starting`, `active`, `closing`, `closed`, or `failed`. `active` requires a
  verified provider session and attached sideband. `closed` means an orderly deliberate end
  completed; it does not claim final usage. For public GPT-Live, this requires a valid
  `session.closed` with reason `close_requested` after our close request. Other provider close
  reasons or an unrequested terminal event are `failed`, even when final usage is confirmed.
  Unexpected transport loss, a transport error, an interrupted start, or an applicable close
  deadline instead means `failed`. Only `usage.final` reports confirmed final usage.
- `usage.seconds` — the latest cumulative voice duration, or `null` before the provider reports
  it. Never sum cumulative snapshots or infer billable duration from a local clock.
- `usage.final` — `true` only after the provider confirms final usage. It remains `false` on
  an interrupted connection without that confirmation. Coding-agent token usage remains on
  the ordinary agent usage surface; no token usage is invented from voice duration.
- `error` — a human-readable, sanitized explanation on failure, otherwise `null`; never a raw
  provider diagnostic, credential, or private transcript.
- `createdAt`, `updatedAt`, `endedAt` — timestamps; `endedAt` is `null` until local termination.
- `version` — the ordinary resource version for reads and event chaining.

### `POST /v0/live/sessions`

Creates one voice session. Body:

```json
{
    "mutationId": "start-voice-1",
    "id": "l1a2b3c4",
    "windowId": "desktop-window-1",
    "sdp": "<WebRTC SDP offer>",
    "credential": { "type": "codex_subscription", "providerId": "codex" },
    "contextRevision": 1,
    "context": {
        "windowId": "desktop-window-1",
        "connections": [],
        "activeConnectionId": null,
        "activeTarget": null,
        "projects": [],
        "workspaces": [],
        "sessions": [],
        "bots": [],
        "activeSession": null,
        "truncated": false
    }
}
```

`mutationId` and `id` are optional; other fields are required. The SDP is
nonblank and at most 65,536 characters. `providerId` is nonblank and at most 128 characters.
Raw credentials, arbitrary endpoints, model overrides, and permission overrides are not accepted.
Creation, credential-selection, context/control, and close request objects reject unknown fields.
The Live resource ID uses ordinary CUID2 syntax (2–32 lowercase alphanumeric characters, starting
with a letter). Desktop window and target IDs are opaque, nonblank strings of at most 128
characters without control characters; never derive one ID from another. The context window ID
must equal the outer window ID. The entire creation body is limited to 640 KiB.
The daemon chooses the supported Live model and transport for the selected credential kind.

Two optional fields negotiate additive desktop capabilities:

- `desktopCapabilities` — the capability names this desktop implements: unique strings of 1–64
  characters, at most 16. Send it only to a daemon whose `GET /v0/health` lists
  `capabilities.desktopLiveCapabilities`. The daemon accepts the intersection of this list and its
  own; unknown names are ignored, never rejected. Current names are `appState`, `voiceFocus`,
  `taskCreate`, `sessionModelChange`, and `agentTargets`. `taskCreate`, `sessionModelChange`, and
  `agentTargets` are accepted only together with `appState`. Omitted, the call uses only the
  original contract.
- `appState` — the initial Desktop AppState object described below. It is valid only when
  `desktopCapabilities` includes `appState`, and its serialized form is at most 256 KiB.
- `localConnectionId` — the desktop's connection ID for the daemon serving this request, an
  opaque ID as above. It is valid only when `desktopCapabilities` includes `agentTargets`, and is
  then required; the daemon accepts `agentTargets` only when it is present. Because creation
  rejects unknown fields, send it only to a daemon whose `capabilities.desktopLiveCapabilities`
  lists `agentTargets`. The daemon acts only on this connection and refuses any target on another.

The accepted capability list is echoed in control `hello`. A desktop must not send fields,
frames, task targets, or action results that belong to a capability the daemon did not accept,
and the daemon never sends an action or frame for a capability the desktop did not request.

Response — `201`:

```json
{
    "session": { "id": "l1a2b3c4", "windowId": "desktop-window-1", "status": "starting" },
    "transport": { "type": "webrtc", "sdp": "<WebRTC SDP answer>" }
}
```

`session` is the complete live session object. Apply the answer to the browser peer connection
and wait for identity-checked control `hello` followed by `status: active` before sending
application commands. The renderer need not interpret raw provider readiness events. The create request already starts
the call; do not send another start event. Only this response includes SDP, never GET or events.
The response returns after upstream call allocation and sideband attachment; it must not wait
for browser media negotiation. `starting` transitions asynchronously to `active` when the
provider confirms readiness after the browser applies the answer. An already-ready call may
instead return `active`.

Readiness requires an observed, valid provider `session.started` or dialect-supported
`session.updated` on the attached sideband. HTTP success, a socket opening, ICE negotiation,
and the browser data channel are not readiness evidence. The native Codex adapter may send
one native `session.update` with the already-selected instructions/settings to obtain that
confirmation; rejection or lack of confirmation fails the call without retry. The public
adapter must not send this native update or change immutable startup settings. If no valid
confirmation arrives within the readiness deadline, fail with a clear startup explanation.

The daemon reserves the local resource before the single upstream create attempt. Reusing its
ID returns `409 conflict` with the current `session`, including after an uncertain outcome; it
never creates another upstream call. `mutationId` remains an echo, not a deduplication key.
Clients should supply an ID, read it after a lost response, and close it before deliberately
creating a replacement. An unknown upstream outcome is reported as failure, not retried.

Invalid requests are `400 invalid_request`, a provider
credential refusal is `403 forbidden`, and an unsupported credential transport is `501 unsupported`.
An unavailable credential/provider or failed upstream connection is `503 live_unavailable`.
Errors after reservation additionally carry the current `session`; errors before reservation
create no resource or events. Call allocation and sideband attachment have a 30-second deadline;
provider readiness after returning the answer has a separate 30-second deadline. There may be at most four
nonterminal sessions per principal and at most one per window; further creates return
`409 conflict` without an upstream call. The desktop must attach its control connection within
15 seconds of creation; failure to attach ends the voice session without starting actions.

### `GET /v0/live/sessions/:id`

Response — `200`: `{ "session": { ... } }`. Returns the complete current resource, including
terminal state and whether usage finalized. `404` for an unknown ID or another principal's session.

### `POST /v0/live/sessions/:id/close`

Body: `{ "mutationId": "stop-voice-1" }`, with `mutationId` optional.

Response — `200`: `{ "session": { ... } }`. Records a close request and may return `closing`;
that state does not claim provider finalization. Repeating close, including on a terminal session,
is harmless. Unknown or another principal's IDs return `404`. No `If-Match` is required.

Stop accepting delegations and send the selected transport's `session.close` once. Public
GPT-Live keeps the sideband alive for up to 15 seconds for the documented `session.closed`
event and final usage. A valid event with reason `close_requested` after our close request is
`closed`; other reasons or an unrequested terminal event are `failed` with confirmed final
usage when supplied. Timeout or premature transport loss is `failed` with usage unconfirmed.
Native Codex sends its close command and closes the transport, following its native lifecycle.
An orderly deliberate native end settles as `closed`, with the last reported duration or null
and `usage.final: false` unless actual final provider usage was received. A local disconnect or
normal WebSocket close never invents a provider event or final usage. A transport error or
interrupted start remains `failed`. Closing voice does not abort, archive, or recreate any coding
session or its tasks.
Daemon shutdown closes owned calls; restart marks unfinished local sessions failed and never
replays creation or delegated mutations. A Voice turn a restart interrupted is stopped, not
resumed, and its desktop actions are never executed again. Terminal records remain readable for seven days,
bounded to the newest 1,000 per principal. Evicted records return `404`.

### Desktop context and targets

The initial `context` and subsequent `desktopContext` frames carry the same closed object:

- `windowId` — the initiating window identity.
- `connections` — up to 100 `{ connectionId, name, online }` entries.
- `activeConnectionId` — an explicitly selected connection ID, or `null`.
- `activeTarget` — one desktop target below, or `null`.
- `projects` — up to 100 `{ target: ProjectTarget, name }` entries.
- `workspaces` — up to 100 `{ target: WorkspaceTarget, name, status }` entries; workspace
  status is `ready`, `preparing`, `error`, or `unknown`, not a conversation activity state.
- `sessions` — up to 100 `{ target: SessionRef, title, status }` entries; title may be `null`.
- `bots` — up to 100 `{ target: BotTarget, name, status }` entries.
- `activeSession` — `null` or `{ target: SessionRef, status, messages, composerHasDraft,
writeRefusal }`. `writeRefusal` is a bounded human-readable reason or `null`.
- `truncated` — whether the bounded projection omitted visible entities or text.

Names and titles are at most 256 characters. `writeRefusal` is at most 1,024 characters.
Conversation status is exactly `idle`, `running`, `awaitingInput`, `waiting`, `error`, or
`unknown`; it comes from structured application state, never text matching. `messages` contains
at most 50 `{ id, role, text }` public messages with `role` either `user` or `assistant` and
`text` at most 16,384 characters. Exclude private reasoning, tool arguments/results, attachments,
files, credentials, and composer draft contents. The draft is only a boolean in context.

References are namespaced; IDs from different connections never identify the same entity:

- `ProjectRef`: `{ connectionId, projectId }`.
- `GroupRef`: `{ connectionId, groupId }`.
- `SessionRef`: `{ connectionId, groupId, sessionId }`.
- `ProjectTarget`: `{ kind: "project", connectionId, projectId, groupId }`.
- `WorkspaceTarget`: `{ kind: "workspace", connectionId, projectId, workspaceId, groupId }`.
- `SessionTarget`: `{ kind: "session", connectionId, groupId, sessionId }`.
- `BotTarget`: `{ kind: "bot", connectionId, groupId, sessionId, botId }`.
- `TaskTarget`: `{ kind: "task", connectionId, groupId, sessionId, taskId }` — `groupId` is the
  task's workspace and `sessionId` its one agent.

A `DesktopTarget` is exactly one of those target variants. `TaskTarget` may appear only in a call
whose accepted capabilities include `appState`; older daemons reject it. Group IDs are supplied
explicitly even where they currently coincide with project or workspace IDs. The desktop maps
its internal worktree identity to wire `workspaceId` explicitly, never by parsing names or paths.
A task's or bot's conversation is an ordinary `SessionRef` for the session actions, and the
desktop lists task conversations in `sessions`.

With the `agentTargets` capability, an action may also name a conversation by this daemon's own
agent ID, as Voice reads it from the sidebar and conversation tools:

- `AgentTarget`: `{ kind: "agent", connectionId, agentId }` — the conversation of agent `agentId`
  on connection `connectionId`, which is always the call's `localConnectionId`. `agentId` is the
  daemon's agent ID, at most 128 characters.

An `AgentTarget` may appear wherever an action takes a `DesktopTarget` or a `SessionRef`. The
desktop resolves it to its own entity for that agent — a task's, a bot's, a subtask's, or another
conversation's — and refuses an agent it cannot show with `notFound`. A result whose `target`
answers an action that named an `AgentTarget` may name either form. Without `agentTargets` the
daemon never sends an `AgentTarget`, and older desktops are unaffected.

### Desktop AppState

With the `appState` capability, the desktop also supplies an AppState object: the whole
sidebar the person sees, already filtered and in canonical sidebar order, plus the focused
conversation. It is a closed object:

- `timeZone` — the desktop's IANA time zone, such as `America/Los_Angeles`, at most 64 characters.
- `servers` — up to 32 `{ connectionId, name, kind, online, catalog, bots, tasks, projects,
models }` entries in sidebar order: the local server first, then remote connections.
  `kind` is `local` or `remote`; `catalog` is `ready`, `loading`, or `error`. - `bots` — up to 100 `{ target: BotTarget, name, status, lastActivityAt }` top-level bots. - `tasks` — up to 100 `{ target: TaskTarget, name, status, lastActivityAt }` top-level tasks
  in the person's own order. - `projects` — up to 100 `{ target: ProjectTarget, name, sessions, workspaces }`, where
  `workspaces` holds up to 100 `{ target: WorkspaceTarget, name, status, sessions }` and each
  `sessions` holds up to 100 `{ target: SessionRef, title, status, lastActivityAt }` direct
  conversations of that project root or workspace, in tab order. - `models` — up to 200 `{ providerId, providerName, modelId, name, efforts, defaultEffort }`
  entries: the model choices this server's composer picker offers. `providerName` is the
  picker's human-readable service label.
- `focused` — `null` or `{ target: DesktopTarget, title, latestMessage }`. `latestMessage` is
  `{ state: "loaded", role, text, truncated }` for the latest loaded, settled public user or
  assistant message; `{ state: "empty" }` when the loaded conversation has none; or
  `{ state: "notLoaded" }` when its transcript is not loaded.
- `truncated` — whether the desktop omitted entities or text to stay within bounds.

Bots and tasks are top-level only. Bot and task descendants, subtasks, and workspaces owned by
them never appear. `status` is the conversation status above; workspace `status` is the workspace
status above. `lastActivityAt` is epoch milliseconds floored to the minute, or `null`. Names and
titles are at most 256 characters; message text is at most 16,384 characters; efforts and IDs are
at most 128 characters. The serialized object is at most 256 KiB.

The desktop sends a complete replacement as the creation request's `appState` and later as the
`appState` control frame. It is not revisioned, persisted, or journaled; the latest frame wins and
identical repeats are harmless. AppState changes never advance `desktopContext` revisions, and
background AppState never stales an action. The desktop coalesces changes before sending them and
sends only settled message text, never streaming partial text. With the `agentTargets`
capability the desktop sends the `appState` frame only when a server's `models` change, never for
activity, status, names, order, focus, or messages.

The daemon uses AppState only to resolve names and targets and to validate model choices for
Voice's actions. It never pushes AppState, or anything derived from it, to the voice model.

### Sidebar outline

The voice model receives the person's own sidebar on this daemon, never the desktop's: Happy,
their bots, their tasks, and their joined Surfaces, in that order. The outline holds names only: no
conversation status, activity times, messages, or IDs:

```markdown
# Sidebar

- Happy
- Release notes
- Preview viewer release
- Team todos
```

The outline is bounded to 8 KiB and marks omitted entries explicitly; omitted entries are never
sent later. It is sent as the call's initial context and again, as a complete replacement under
the same heading, only when the outline's text changes, such as a renamed row or new or
archived work. A changed outline waits while a voice request lacks its delivered
outcome and is sent after it; several changes meanwhile send one outline. Nothing else is pushed
to the voice model in the background.

### `GET /v0/live/sessions/:id/control?windowId=...`

Upgrades to a full-duplex WebSocket using ordinary Happy API bearer authentication. The trusted
desktop host attaches authentication; never put a bearer token in the URL or renderer state.
`windowId` is required and must match the resource. Unknown/foreign resources are `404`, a
mismatched window or an already attached controller is `409 conflict`, and a terminal resource
cannot attach. There is only one controller per call. Frames are UTF-8 JSON, at most 256 KiB.
Invalid/oversized frames fail the connection; raw audio and raw provider frames are not accepted.
The whole serialized context must fit the frame budget, even when each individual field fits
its own limit. Omit older/less relevant text and entities and set `truncated` rather than
assuming every per-field maximum can fit simultaneously.

The server first sends `{ type: "hello", sessionId, windowId, contextRevision, capabilities? }`.
The desktop verifies all three identities before acting. `capabilities` is present only when the
creation request carried `desktopCapabilities`, and lists the accepted capability names.
Client-to-server frames are:

- `{ type: "desktopContext", revision, context }` — a complete replacement, with strictly
  increasing positive safe-integer `revision`. Exact same-revision duplicates are harmless;
  older revisions are ignored; different contents at the same revision fail the connection.
  Focus, catalog, access, and draft-presence changes advance the revision. Public text streaming
  does not advance it token by token.
- `{ type: "actionResult", actionId, result }` — an outcome for an action the server requested.
- `{ type: "sessionUpdate", target: SessionRef, status, messages, truncated }` — a bounded
  replacement public snapshot for the active session or one of at most five explicitly watched
  sessions. Unselected or inaccessible targets are rejected. An empty selection never means all.
  After enabling a watch, send its successful action result before the initial snapshot; the
  server records the selection from that result before accepting the update. Current daemons
  accept these frames under the same rules but never forward them to the voice model or to
  Voice; a desktop with the `agentTargets` capability does not send them.
- `{ type: "appState", appState }` — a complete replacement Desktop AppState, only with the
  `appState` capability.

Server-to-client frames after hello are:

- `{ type: "actionRequested", actionId, contextRevision, inputTranscriptIds, action }` — one
  fixed desktop action. `actionId` is an opaque lifetime-stable ID; `inputTranscriptIds` contains
  at most 32 distinct source fragment IDs for attribution, not authorization or a claimed completed turn.
- `{ type: "status", status, error }` — `status` is `starting`, `active`, `closing`, `closed`,
  or `failed`; `error` is a sanitized human-readable explanation or `null`.
- `{ type: "transcript", transcriptId, role, text, startMs?, endMs? }` — a normalized provider
  fragment, role `user` or `assistant`. Include the time fields only as a pair when the provider
  supplied its real nonnegative session-relative millisecond interval, with `startMs <= endMs`;
  otherwise omit both. Never synthesize timing from clocks, audio offsets, or delegation offsets.
  The daemon mints a stable call-local `transcriptId`, distinct from provider item/turn IDs.
  Text is at most 16,384 characters; preserve repeated words and whitespace. This v1 contract
  exposes no turn or final identity, even when a dialect reports one. Native transcript-added
  fragments are forwarded once; its turn-done text is not appended again. Native delegation
  input text remains attributed provider context, never human confirmation or authorization.
- `{ type: "voiceFocus", focusId, contextRevision, target, reason }` — only with the `voiceFocus`
  capability. `focusId` is an opaque ID, `contextRevision` the current accepted revision, `target`
  a `DesktopTarget` or `null` to clear the highlight, and `reason` is `mention` or `navigation`.
  The desktop highlights the target as the entity voice is talking about. It is decorative: it
  authorizes nothing, opens nothing, and is never an action. The daemon sends one as soon as a
  request's target is uniquely resolved — including from an exact, unique name match against
  the sidebar outline or AppState before Voice runs — and immediately before each targeted action, using
  `navigation` before `desktopOpen` and `mention` otherwise. It never sends one for a different
  target while an action is outstanding. It clears the highlight with `target: null` when the
  request ends. The desktop ignores `reason` on a clear, ignores stale or unknown targets, and
  clears the highlight when voice ends. For `desktopOpen`, the desktop highlights the target, holds
  it for 500 milliseconds, revalidates the target, and then navigates; the hold is skipped when
  that same target has already been highlighted for at least 500 milliseconds.

The action union is:

| `type`                | Other fields                                              | UI-equivalent behavior                                                                    |
| --------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `desktopState`        | none                                                      | Read the current bounded context.                                                         |
| `desktopOpen`         | `target: DesktopTarget`                                   | Focus/open that existing entity.                                                          |
| `sessionRead`         | `target: SessionRef`                                      | Return bounded public conversation text and status.                                       |
| `sessionSend`         | `target: SessionRef`, `text`                              | Stage exact text for an independent explicit human Send; never answer a pending question. |
| `sessionWatch`        | `target: SessionRef`, `enabled`                           | Retained for compatibility; current daemons never request it.                             |
| `composerDraftAppend` | `target: SessionRef`, `text`                              | Append text to that session's draft without replacing it or its attachments.              |
| `taskCreate`          | `connectionId`, optional `name`, `text`, optional `model` | Create a task, open it, and stage `text` as its unsent draft.                             |
| `sessionModelChange`  | `target: SessionRef`, `providerId`, `modelId`             | Choose the model for that session's next message through its composer.                    |
| `workspaceCreate`     | `project: ProjectRef`                                     | Retained for compatibility; current daemons never request it.                             |
| `sessionCreate`       | `group: GroupRef`, optional `prompt`                      | Retained for compatibility; current daemons never request it.                             |
| `botCreate`           | `connectionId`, optional `name`, optional `prompt`        | Retained for compatibility; current daemons never request it.                             |

`taskCreate` requires the `taskCreate` capability and `sessionModelChange` requires the
`sessionModelChange` capability. A desktop may refuse a retained compatibility action with
`unavailable`.

`taskCreate` creates an ordinary task on that connection through the desktop's usual task
creation, with `name` when supplied and the daemon's automatic naming otherwise. Optional
`model` is `{ providerId, modelId }` from that server's AppState `models`; the desktop validates
it before creating anything, refuses an unknown choice with `notFound`, and creates the task with
that selection and the model's usual effort. The desktop then opens the task and stages `text` as
its composer draft, never sending it; a person must review the draft and press Send. Success is
`{ type: "created", target: TaskTarget }`.

`sessionModelChange` changes the model that the identified session's next message will use,
through the same composer mode path as the model picker, with effort and speed following the
model as the picker does. It validates the choice against that session's offered models and
refuses an unknown choice with `notFound`, or `unavailable` when the session cannot change models.
It preserves draft text, attachments, and permission mode, and never interrupts, aborts, or
restarts a running turn. Success is `{ type: "ack" }`.

Every session action names its target explicitly. `composerDraftAppend`, like the others, never
falls back to the focused session; a missing or stale target is refused.

Action text/prompts are nonblank and at most 16,384 characters; optional bot and task names are
nonblank and at most 256; provider and model IDs are nonblank and at most 128 and 256 characters.
No action accepts paths, arbitrary URLs/API calls, shell commands, JavaScript, permission
overrides, security settings, or permission/question answers. A model choice is limited to the
choices the desktop's own picker offers. An optional
creation prompt is a draft, not an automatic user-authored message. In v1, `sessionSend` refuses
or stages the exact text visibly and returns terminal `succeeded` with `{ type: "staged" }`.
Staged means awaiting an independent explicit human Send, never sent or authorized, and never
uses the action's `pending` state. The later human Send is an ordinary UI action observed through
context or session updates, not a delayed result for the staged action. Refuse staging while the
target has a pending question or awaits input, and recheck that guard at Send time. Never route
generated text through a question-answer path or label it as human authorization before that
explicit exact-text Send.

Before every action, the desktop checks current call/window, the expected context revision,
connection/target visibility, connectivity, write eligibility, and existing permission guards.
Cached read/navigation actions remain available offline wherever the ordinary UI permits them;
mutations require the target connection online.
It must not substitute the currently focused session for a stale or missing target. No operation
executes twice for one `actionId`; remember up to 256 action IDs and results during the active
call. The server permits one outstanding action at a time and ends the call before exhausting
that bound instead of evicting a mutation's deduplication record.

`result` is one of these closed variants:

- `{ status: "succeeded", output }`, where `output` is `{ type: "ack" }`,
  `{ type: "staged" }` (only exact-text staging for `sessionSend`, not submission),
  `{ type: "context", context }`, `{ type: "created", target: DesktopTarget }`, or
  `{ type: "session", target: SessionRef, status, messages, truncated }`.
- `{ status: "pending" }` — waiting for ordinary UI completion, not a v1 `sessionSend`
  confirmation. It is not success; a later result for the same ID supplies the terminal outcome.
- `{ status: "refused" | "failed" | "cancelled", code, message }` — `code` is
  `staleContext`, `unavailable`, `forbidden`, `draftConflict`, `notFound`, `ended`, or `failed`;
  `message` is a sanitized explanation of at most 1,024 characters.

Terminal results are immutable; duplicate identical results are harmless, conflicting results
or results for unknown actions fail the connection. The server bounds action waiting to 60
seconds. An uncertain or timed-out mutation is never replayed as a new action. Control socket
loss, window disposal, or disabling voice ends this voice session and cancels controller actions
that have not begun. Already-started UI mutations may complete; they are never undone or
replayed, and late results are ignored after disposal. Coding tasks stay alive. V1 does not reconnect the controller automatically; the
person explicitly starts a new call. No transcript or controller mutation is replayed on restart.

### Live updates

`live.session.created` carries `{ session, mutationId? }`; `live.session.updated` carries
`{ sessionId, previousVersion, version, changes, mutationId? }`, with `updatedAt` in every
`changes`. Both are committed before publishing and filtered to the session owner in journal
pull and SSE. They never contain SDP, provider credentials, transcripts, or raw provider events.

Duplicate delivery cannot repeat an operation; late results retain their original action and
delegation IDs. Background progress, completion, failure, and requests for human input are never
pushed to the voice model; voice learns them only by asking Voice, which reads the conversation
when asked. Provider appends respect the selected GPT-Live transport's documented
limit. Queues and transcript windows are bounded; overflow ends the call with a clear failure
instead of replaying writes or silently losing task state.

These routes and events are additive without a protocol bump. `GET /v0/health` advertises the
optional `capabilities.desktopLiveControl` boolean. Only `true` promises this window-scoped
contract; omission or `false` means unavailable, not an older agent-bound voice API. This
capability does not promise provider entitlement, enabled microphone access, or API billing consent.
The optional `capabilities.desktopLiveCapabilities` lists the additive desktop capability names
this daemon accepts in `desktopCapabilities`; omission means none.
A `404` or `501` from session
creation may mean the daemon lacks Live support; clients must not mistake that for an empty
session or silently choose a different authentication method.

## Search

Search finds everything in the node the caller can reach by name or text, and answers every search
box, such as the desktop's quick switcher and mobile search. Clients search what they already hold
at once, call `POST /v0/search` in parallel, and fuse the two lists as described under Fusing
results. A daemon that serves it reports `capabilities.search: true` from health. Older daemons
omit it and answer the route with `404`; clients then show their local results only.

### Matching and ranking

The query is split into words of letters and digits, ignoring case and diacritics, so `Café` and
`cafe` are the same word. A word matches any word that starts with it, so a query typed so far
finds what it is becoming; words are not stemmed. Each kind of thing is searched by its own
provider, which ranks its matches with BM25: matches in names and titles first, then matches in
content. Vault folders and files follow the tiers described under Vault Surfaces search, and a
vault item is returned once, under its best tier. People are matched by name and also by email,
which results never include; skills by name or description. The daemon then fuses the providers'
lists with Reciprocal Rank Fusion: a result at 1-based position `p` in its provider's list scores
`1 / (60 + p)`, results are ordered by score, and equal scores follow the provider order of the
table below, then position.

Names, titles, message text, todo text, calendar event titles, notes, and locations, artifact text
and summaries, and vault text change in the search index in the same transaction as the change
itself. A document's text and comments are indexed shortly after each edit, so a content match may
lag the newest edit by about a second. Conversation titles, people, and skills are read from a
catalog the daemon refreshes every few seconds. After an upgrade, a daemon indexes existing
content in the background; until it finishes, older content may be missing from results.

### `POST /v0/search`

Searching changes nothing; it is a `POST` so the query travels as a JSON body.

Request:

```json
{ "q": "launch", "types": ["vault_file", "todo"], "limit": 30 }
```

- `q` — required, 1–256 characters.
- `types` — optional, the result types to search. Without it every type is searched. Types the
  daemon does not know are ignored, so a newer client can ask an older daemon; when none of the
  listed types is known, the results are empty.
- `limit` — optional, 1–100, default 30.

A body that is not JSON, a content type other than `application/json`, any other field, an empty
`types` array, or a malformed value is `400 invalid_request`.

Response — `200`:

```json
{
    "results": [
        {
            "type": "vault_file",
            "key": "vault_file:f1a2b3c4d5e6f7g8h9i0j1k2",
            "rank": 1,
            "surfaceId": "v1a2u3l4t5s6u7r8f9a0c1e2",
            "fileId": "f1a2b3c4d5e6f7g8h9i0j1k2",
            "name": "Launch plan.md",
            "path": "/Docs/Launch plan.md",
            "kind": "file",
            "match": "content",
            "innerPath": null,
            "line": 4,
            "snippet": "The launch moves to Friday"
        },
        {
            "type": "todo",
            "key": "todo:t1o2d3o4i5d6t7o8d9o0i1d2",
            "rank": 2,
            "surfaceId": "s1u2r3f4a5c6e7i8d9t0o1d2",
            "todoId": "t1o2d3o4i5d6t7o8d9o0i1d2",
            "text": "Book the launch venue",
            "status": "active"
        }
    ],
    "truncated": false,
    "partial": false
}
```

- `results` — at most `limit` results in fused order. Every result has `type`, `key`, and `rank`,
  its 1-based position in this list. A thing appears at most once.
- `truncated` — `true` when more results matched than `limit`.
- `partial` — `true` when a provider did not answer within the daemon's time budget of about
  250 ms, or failed, and its results are missing. Retrying may find them.

A caller finds exactly what it may read through the routes that list each kind of thing: in team
mode every signed-in member finds vaults, Surfaces, todos, documents, calendar events, artifacts,
projects, workspaces, conversations and their messages, other members, and skills, but tasks and
their messages only where they hold a membership, and bots as `GET /v0/bots` lists them. Things in
a vault's Trash, deleted todos, deleted calendar events, deleted artifacts, hidden subagents and
their messages, and guests are never returned. Archived projects, workspaces, and conversations
are, marked as archived, and their messages are returned too.

### Result types

Keys are `<type>:<id>`, with the ID named below; a key is stable for as long as the thing exists.
Types are listed in provider order. Clients ignore results whose `type` they do not know, and
fields they do not know on a result they keep, so daemons may add types and fields without a
protocol change.

| `type`           | Key ID        | Fields                                                                                                            |
| ---------------- | ------------- | ----------------------------------------------------------------------------------------------------------------- |
| `vault_file`     | `fileId`      | `surfaceId`, `fileId`, `name`, `path`, `kind` (`"file"` or `"artifact"`), `match`, `innerPath`, `line`, `snippet` |
| `vault_folder`   | `folderId`    | `surfaceId`, `folderId`, `name`, `path`, `match`                                                                  |
| `document`       | `surfaceId`   | `surfaceId`, `name`, `match`, `line`, `snippet`                                                                   |
| `message`        | `messageId`   | `agentId`, `messageId`, `role` (`"user"` or `"agent"`), `snippet`, `createdAt`, `workspaceId`, `projectId`        |
| `todo`           | `todoId`      | `surfaceId`, `todoId`, `text`, `status` (`"active"` or `"completed"`)                                             |
| `calendar_event` | `eventId`     | `surfaceId`, `eventId`, `title`, `allDay`, `start`, `match`, `snippet`                                            |
| `artifact`       | `artifactId`  | `artifactId`, `title`, `artifactType`, `match`, `snippet`                                                         |
| `surface`        | `surfaceId`   | `surfaceId`, `surfaceType`, `name`                                                                                |
| `agent`          | `agentId`     | `agentId`, `title`, `kind` (`"chat"`, `"task"`, `"subtask"`, or `"bot"`), `archived`, `workspaceId`, `projectId`  |
| `project`        | `projectId`   | `projectId`, `name`, `archived`                                                                                   |
| `workspace`      | `workspaceId` | `workspaceId`, `projectId`, `name`, `archived`                                                                    |
| `user`           | `userId`      | `userId`, `name`                                                                                                  |
| `skill`          | `skillId`     | `skillId`, `name`, `description`                                                                                  |

- `match` says where the words matched: `"name"` in the name or title, `"content"` in the text,
  or, for vault items, `"path"` only in the folders above. A vault folder's `match` is `"name"` or
  `"path"`; a document's, a calendar event's, and an artifact's are `"name"` or `"content"`.
- `line` and `snippet` describe a content match: the 1-based line where a query word first
  appears and at most 200 characters of that line around it. They are `null` for other matches.
  `innerPath` names the file inside a vault app holding the text, and is otherwise `null`.
- A vault file is the vault's plain file or vault app at `path`; a vault folder is a folder.
- A `document` is a document Surface, matched by its name or by the text of its Markdown
  projection and its comments. A match in a comment has a `snippet` from the comment and a `null`
  `line`. Other Surfaces, vaults included, are `surface` results matched by name, with
  `surfaceType` as the catalog reports it.
- A `message` is one message of a conversation the caller can see under the rules for `agent`
  results, titled or not, matched by its text: what a person wrote (`"user"`), or what an agent
  wrote (`"agent"`), its replies and messages it sent another agent. Reasoning, tool calls, tool output, and system and service
  notices are not searched. `snippet` is at most 200 characters of the line where a query word
  first appears, `createdAt` is when the message was accepted, and `workspaceId` and `projectId`
  are its conversation's, as on the `agent` result.
- A `todo` matches by its text. A `calendar_event` matches by its title, as `match: "name"`, or by
  its notes or location, as `match: "content"` with a `snippet`; `start` is the epoch
  milliseconds start of the series' next occurrence, or of its last one when the series has
  ended, and `allDay` says whether it is an all-day event.
- An `artifact` matches by its title or by its summary and the text of its newest version:
  Markdown as written and HTML without its tags. `artifactType` is the artifact's `type`.
- An `agent` is a conversation people see: `"chat"` for a project or workspace conversation,
  `"task"` for a task's agent, `"subtask"` for a subtask, and `"bot"` for a bot's own agent. It
  matches by `title`. `workspaceId` is the workspace holding the conversation, as
  `GET /v0/agents` reports it: a bot's or task's own workspace, a project's root workspace (whose
  ID is the project's) for a project conversation, the workspace for a workspace conversation, and
  the nearest ancestor's for a subtask; `null` only when none is found. `projectId` is the project
  owning that workspace, and `null` for bots, tasks, and their subtasks.
- `project` and `workspace` match by name. A project is its root workspace, which is never also a
  `workspace` result.
- A `user` is a team member as `GET /v0/users` describes them, matched by name or email, in
  team mode only. A `skill` is a global skill as `GET /v0/skills` lists it, matched by name or
  description.

### Fusing results

Clients fuse their local results with the daemon's the same way, so every platform shows the same
order. A client ranks its own local list as the daemon does, assigning 1-based positions, and
scores each list's result at position `p` as `1 / (60 + p)`, using a remote result's `rank` as its
position. Results with the same `key` are one result whose score is the sum of its scores; it
shows the remote result's fields when the daemon returned one, and the local result's otherwise.
Results are ordered by score, highest first. Equal scores are ordered by remote `rank`, results
the daemon did not return coming after those it did, and then by local position. The client
package ships these rules as `fuseSearchResults()` and its test vectors as
`searchFusion.fixtures.json`.

## Events

Everything that changes on the daemon is announced as an event: projects and workspaces
mutating, agents starting and finishing runs, messages arriving, titles being generated. A
client opens with REST snapshots, then follows events to stay current — pulling them, or
holding a stream open.

### The event envelope

```json
{
    "cursor": "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e",
    "type": "workspace.updated",
    "occurredAt": 1755400000000,
    "payload": {
        "workspaceId": "w9x8y7z6",
        "previousVersion": "01991f3a-5d2b-7000-8000-4b1c3d5e6f70",
        "version": "01991f3a-6d2f-7000-8000-3a0b2c4d5e6f",
        "changes": { "name": "auth-refactor", "updatedAt": 1755400000000 },
        "mutationId": "..."
    }
}
```

- `cursor` — the event's position in the journal, a **UUIDv7**, time-ordered. It is named
  `cursor` rather than `id` deliberately: it is never a resource identity, only a place in the
  stream, and every cursor parameter below is one of these values.
- `type` — a dotted name (`project.updated`, `workspace.created`, `run.finished`, ...).
  The set grows with the product; clients skip types they do not recognize.
- `payload` — type-specific; see "Event types". Events caused by a mutation carry the
  `mutationId` echo when the mutation supplied one.

### The journal is bounded

The daemon keeps a bounded window of recent events, not an infinite log. A cursor that has
fallen out of the window cannot be replayed; the daemon says so explicitly rather than
silently skipping what was lost, and the client **resyncs**: it re-reads the REST snapshots it
cares about, then follows events from the fresh cursor the daemon handed it. Resync is a normal
part of the protocol — a client that was offline for a while should expect it.

### Event types

Version-chained resources use the two payload shapes below. Explicitly documented current-state
events such as `git.updated`, `files.updated`, `skills.updated`, and `happy.integration.updated`
use complete replacements or compact invalidations instead.

**`*.created` normally carries the resource in full** — the same JSON the corresponding `GET`
returns, so a client inserts it into its cache with no follow-up read. The object carries its own
`id` and `version`, so the payload holds no separate ID field unless it links to something the
object does not name (a message's `agentId` and `runId`, for example). A documented bounded summary
may replace a potentially large full resource.

**`*.updated` carries only what changed, chained by version:**

```json
{
    "workspaceId": "w9x8y7z6",
    "previousVersion": "01991f3a-5d2b-7000-8000-4b1c3d5e6f70",
    "version": "01991f3a-6d2f-7000-8000-3a0b2c4d5e6f",
    "changes": { "name": "auth-refactor", "updatedAt": 1755400000000 }
}
```

- the resource ID (`projectId`, `workspaceId`, `terminalId`, `agentId`, `botId`, `secretId`,
  `artifactId`, `compactionId`, `processId`, `questionId`) — an ID string naming what changed, since the full
  object is not here;
- `previousVersion` — the resource's version **before** this change;
- `version` — its version after;
- `changes` — a partial resource object: only the fields that changed, with their new values
  (`updatedAt` is always among them).

The client's rule: if its cached copy's `version` equals `previousVersion`, it merges
`changes` and adopts the new `version` — it is provably current. If they differ, the cached
copy is **dirty** — an update was missed or arrived around a snapshot — and the client
refetches that one resource instead of guessing. Because versions are UUIDv7, any two copies
of a resource can also be compared directly: the greater `version` is the newer copy, which is
how a bootstrap snapshot and an event stream reconcile.

**Daemon lifecycle**

- `daemon.draining` — this daemon process entered its sticky read-only draining phase. It is
  emitted exactly once, before any drain handler starts.
    - `daemonId` (ID string) — the identity minted for this daemon process.
    - `draining` — always `true`.
    - `drain` (drain object) — whether the process will be restarted or stay stopped, and why;
      see Daemon lifecycle. Absent on older compatible daemons.

Daemon start is connection metadata rather than a journal event. A restarted daemon owns a new
in-memory journal, so a startup event inside that journal could be skipped by the very cursor gap
that a client needs it to explain. The SSE `hello` frame therefore carries the daemon identity and
start time on every connection. A reconnecting client emits one `daemon_started` update when it
first sees an identity and again only when that identity changes; the latter means it reconnected
to a different daemon process.

**Projects**

- `project.created` — a project was registered or a clone began.
    - `project` (full project object).
- `project.updated` — rename, settings, reorder, archive, avatar, initialization progress, or a
  change to the root-agent association. Reordering emits one event for the moved project;
  neighbour keys remain unchanged.
    - `projectId` (ID string), `previousVersion`, `version`, `changes`.
- `project.removed` — protocol 33 or newer. An admin bot permanently deleted the project. Its
  root workspace emits `workspace.removed` with the same ID and version; every other workspace and
  every agent it took arrives with its own removal event.
    - `projectId` (ID string), `previousVersion` (the project's final version).

**Workspaces**

- `workspace.created` — a workspace was reserved; its checkout may still be building.
    - `workspace` (full workspace object).
- `workspace.updated` — rename, reorder, archive progress, initialization settling, or a change
  to the workspace's top-level-agent association.
    - `workspaceId` (ID string), `previousVersion`, `version`, `changes`.
- `workspace.removed` — protocol 33 or newer. An admin bot permanently deleted the workspace, or
  the project or bot it belongs to.
    - `workspaceId` (ID string), `previousVersion` (the workspace's final version).

**Secrets**

Secret events contain safe metadata only. They are emitted for changes made through the HTTP API,
agent tools, and daemon-owned integrations. An HTTP mutation's optional `mutationId` is echoed;
changes from another source omit it.

- `secret.created` — a global secret entered the catalog.
    - `secret` (full safe secret object).
- `secret.updated` — a secret's description, environment bundle, or agent availability changed.
    - `secretId` (ID string), `previousVersion`, `version`, `changes`.
    - `changes` may contain `description`, `environmentVariables`, `availableToAgents`, and always
      `updatedAt`, but never environment values. A value-only rotation therefore carries only
      `updatedAt` plus the version chain.
- `secret.attached` — one direct project, workspace, or agent grant was created.
    - `attachment` (full attachment object).
- `secret.detached` — one direct grant was removed.
    - `attachment` (the full attachment object as it existed before removal).
- `secret.removed` — one secret left the catalog: a user deleted it through
  `DELETE /v0/secrets/:secretId`, or a daemon-owned feature retired a managed secret it owns.
    - `secretId` (ID string), `previousVersion` (the final safe secret version).
    - Every attachment whose `secretId` matches is removed by the same atomic change; clients
      discard those cached relations without waiting for separate detach events.

Attachments are immutable relation resources, so their create/remove events are not version
chained and do not advance the attached secret or target version. Replaying either attachment
event is idempotent by attachment ID.

**Bots**

- `bot.created` — a bot was created, with its dedicated workspace, folder, and one agent; the
  workspace and agent also emit their own `workspace.created` and `agent.created`.
    - `bot` (full bot object).
- `bot.updated` — rename, reorder, archive, unarchive, or avatar. The embedded agent's own
  state changes travel as `agent.updated` and do not advance the bot; likewise the workspace's
  own changes travel as `workspace.updated`.
    - `botId` (ID string), `previousVersion`, `version`, `changes`.
- `bot.removed` — protocol 33 or newer. An admin bot permanently deleted the bot. Its workspace
  emits `workspace.removed` and its agents emit `agent.removed`.
    - `botId` (ID string), `previousVersion` (the bot's final version).

**Tasks**

- `task.created` — a task was created, with its dedicated workspace, folder, and one agent; the
  agent also emits its own `agent.created`.
    - `task` (full task object).
- `task.updated` — rename, automatic naming, archive, or unarchive. The embedded agent's own
  state changes travel as `agent.updated` and do not advance the task. A task's workspace has no
  `workspace.*` events of its own; it follows the task.
    - `taskId` (ID string), `previousVersion`, `version`, `changes`.
- `task.removed` — protocol 33 or newer. An admin bot permanently deleted the task. Its
  memberships go with it without separate `task.left` events, and its agents emit
  `agent.removed`.
    - `taskId` (ID string), `previousVersion` (the task's final version).
- `task.joined` — the caller joined a task, including the owner's automatic membership at
  creation. In team mode it reaches only that member's connections.
    - `membership` (full membership object).
- `task.reordered` — the member moved a task within their own list. In team mode it reaches only
  that member's connections.
    - `membership` (full membership object with its new `orderKey`).
- `task.left` — the member left a task. In team mode it reaches only that member's connections.
    - `membership` (the removed membership object).
- `task.membership.updated` — the member's membership changed in place: marked `unread` again,
  its derived unread `count` moved, or read. In team mode it reaches only that member's
  connections. Additive; older daemons never emit it.
    - `membership` (full membership object).

**Artifacts**

Artifact events reach every connection, in team mode every member's. They are emitted for changes
made through the API and through agent tools; an API mutation's `mutationId` is echoed, and an
agent's change carries none.

- `artifact.created` — an artifact was created with its first version.
    - `artifact` (full artifact object).
- `artifact.updated` — a new version was made.
    - `artifactId` (ID string), `previousVersion`, `version`, `changes`.
    - `changes` always holds `latestVersion`, `latestMajor`, `latestMinor`, `title`, `entry`,
      `fileCount`, `size`, `background`, `display`, `cover`, `summary`, `live`, `updatedBy`,
      `updatedSource`, and `updatedAt`; older daemons leave out `latestMajor` and `latestMinor`, and
      daemons predating covers leave out `cover` and `summary`. `cover` is the whole cover object,
      its `thumbhash` and any `preview` included. Read the new version's files through the version
      routes.
      Daemons predating live-URL artifacts omit `live`; current daemons include the new version's
      `{ "url", "networkId" }`, or `null` for file content.
- `artifact.deleted` — the artifact was deleted and is now a tombstone.
    - `artifactId` (ID string), `previousVersion`, `version`, `changes`.
    - `changes` holds `status`, `deletedBy`, `deletedSource`, `deletedAt`, `updatedBy`,
      `updatedSource`, and `updatedAt`. A client drops the artifact from its lists and from any
      cached files.

**Terminals**

- `terminal.created` — a terminal was opened; the terminal object names its workspace itself.
    - `terminal` (full terminal object).
- `terminal.updated` — a resize, a new backing process (`epoch` change), or exit. Screen
  contents never appear in events; they travel over the attachment WebSocket.
    - `terminalId` (ID string), `previousVersion`, `version`, `changes`.

**Workspace bridges**

- `bridge.created` — a bridge opened.
    - `bridge` (full bridge object).
- `bridge.updated` — a bridge closed.
    - `bridgeId`, `workspaceId`, `previousVersion`, `version`, `changes`, optional `mutationId`.
    - `changes` holds `status`, `closeReason`, `closedAt`, and `updatedAt`.
- `bridges.capabilities.updated` — payload `{}`. The daemon's machine probe changed; clients
  reread `GET /v0/workspaces/:workspaceId/bridges` for the capabilities they show.

In team mode, bridge events reach only the bridge's owner. Bridges are an on-demand workspace
surface and are not part of bootstrap.

**Git**

- `git.updated` — the watcher rescanned a watched workspace and its change state moved. Git
  state is computed, not mutated, so it has no version chain: the payload is the whole
  snapshot, and the client replaces what it had.
    - `workspaceId` (ID string) — the workspace whose repository changed.
    - `git` (full git state object, as returned by `GET /v0/workspaces/:workspaceId/git`).

**Files**

- `files.updated` — files or immediate tree entries changed in a recently viewed workspace
  location, or a successful API file write changed the workspace. File state is computed, not a
  versioned resource, so this is an invalidation nudge: the client re-reads any affected open file
  or tree page.
    - `workspaceId` (ID string) — the workspace whose files changed.
    - `paths` (array of relative path strings, or `null`) — the paths the watcher identified,
      coalesced into one bounded event. `null` means the operating system did not identify a path
      or too many paths changed, so the client refreshes the visible file and tree state for that
      workspace.

**Global skills**

- `skills.updated` — installed skills, enablement, or files under `~/.agents/skills` changed.
    - `skillIds` (up to 100 IDs, or `null`) and `paths` (up to 100 root-relative paths, or `null`).
    - Optional `mutationId` for an API enablement change. This is the compact invalidation
      described under Global skills; refetch affected management snapshots, including disabled
      skills. It is not an agent-state event and contains no document bytes.

**Plugins**

- `plugins.updated` — an installation was requested, finished, failed, or was removed, or a
  catalog source's cached list or sync state changed.
    - `installationIds` (up to 100 IDs, or `null`), optional `catalog`, and optional `mutationId`.
      This is the compact invalidation described under Plugins; refetch `GET /v0/plugins`, and
      `GET /v0/plugins/available` when `catalog` is `true`.

**Agents**

- `agent.created` — an agent came into being: created through `POST /v0/agents`, or spawned as
  a subagent by its parent (then `parentAgentId` is set in the object).
    - `agent` (full agent object).
- `agent.updated` — any change to the agent object. This is the agent **state-change** event:
  every `status` move between `"idle"`, `"thinking"`, `"working"`, `"generating_tools"`, and
  `"running_tools"` is one of these, as is every change to the `subagents` and `processes`
  counts, `wait`, `pendingQuestionId`, title generation, unread, reorder, subtask reorder, archive
  and unarchive. `changes` carries exactly the fields that moved — a status flip is
  `{ "status": "running_tools", "updatedAt": ... }`, nothing more.
    - `agentId` (ID string), `previousVersion`, `version`, `changes`.
- `agent.removed` — protocol 33 or newer. The agent was permanently deleted with its whole
  conversation. Clients drop the agent and its messages, and remove it from every parent's
  `subtasks`, `subagents`, and every workspace's or project's `agents` list naming it; those
  containers do not emit their own update for it.
    - `agentId` (ID string), `previousVersion` (the agent's final version).

    A wait transition carries the complete replacement `wait` object or `null`, plus `updatedAt`,
    on the existing agent version chain, published only after the durable transition commits.
    Replaying a transition that leaves the projected interval unchanged emits no extra wait update.
    Full snapshots and incremental updates use the same Scheduling-owned state.

Nested `subtasks` are a composed snapshot of independently versioned agents, not additional
identities or copies of their durable state. Creating, archiving, unarchiving, or updating a
subtask emits that child's existing `agent.created` or `agent.updated` event. Clients normalize
every nested full agent by ID and its own version, then reconcile direct-child membership using
`parentAgentId`, `subtask`, and `archivedAt`. A child-only change does not require replaying the
whole tree or advancing every ancestor's version. A delayed ancestor or workspace snapshot must
not overwrite a newer child record. If `changes.subtasks` is supplied, it is a complete replacement
snapshot of that parent's direct active subtask list, with the same recursive shape and child
version rules. Snapshot-to-stream cursor and version-gap recovery rules remain unchanged.

- `agent.context.updated` — the provider measured the active conversation context, or compaction
  or reset invalidated the previous measurement. Context is computed state and has no resource
  version chain; replace the prior value whole.
    - `agentId` (ID string).
    - `context` — the complete context object from the agent usage/bootstrap response, or `null`
      until the next inference measures the replacement context.
- `agent.draft.updated` — the focused composer draft changed. It is current state and has no
  resource version chain; replace it whole. In team mode, only the authenticated draft owner
  receives this event, including journal pulls, replay, and live delivery. Its payload is unchanged.
    - `agentId` (ID string).
    - `draft` — the complete `{ "value", "updatedAt" }` object from the draft/bootstrap response.
- `agent.profiles.updated` — the focused agent's request-profile catalog changed because its
  available features changed. It is computed current state and has no resource version chain;
  replace the prior list whole. Removing a profile is ordinary and does not invalidate history.
    - `agentId` (ID string).
    - `profiles` — the complete ordered profile catalog from the focused agent response.
- `agent.slash_commands.updated` — turn-time or invocation-time discovery found that the focused
  agent's slash-command catalog changed. It is computed current state and has no resource version
  chain; replace the prior list whole.
    - `agentId` (ID string).
    - `slashCommands` — the complete ordered command catalog from the focused agent response.

**Background processes**

- `process.started` — an agent started a background process; the process object names its
  agent itself.
    - `process` (full process object) — `status` is `"running"`.
- `process.updated` — a running process changed short of exiting.
    - `processId` (ID string), `previousVersion`, `version`, `changes`.
- `process.exited` — the process ended on its own, by `DELETE`, or because its agent subtree was
  aborted. The terminal transition travels as an ordinary update: `changes` carries `status`,
  `exitCode`, and `endedAt`. An abort records and emits this transition immediately before sending
  the process tree its hard-kill signal.
    - `processId` (ID string), `previousVersion`, `version`, `changes`.

**Questions**

- `question.created` — a run paused to ask the person something; the agent's
  `pendingQuestionId` is set (its own `agent.updated` accompanies this). The question object
  names its agent and run itself.
    - `question` (full question object) — `status` is `"pending"`.
- `question.updated` — the question resolved: answered by a client, canceled by an abort, or
  auto-resolved at its deadline. `changes` carries `status`, `answers`, and `answeredAt`.
    - `questionId` (ID string), `previousVersion`, `version`, `changes`.
    - When the answer settles a secret request, the same commit also emits `secret.attached` for
      the asking agent's new exact-agent grant, unless that grant already existed.

**Runs and messages**

- `run.started` — a run with no predecessor began; the agent left `"idle"`. Message acceptance
  and the visible start of work are one event.
    - `agentId` (ID string).
    - `run` (full run metadata object) — status is `"running"`.
    - `acceptedMessageIds` (array of ID strings) — every visible message accepted into this run,
      oldest first; empty for an explicit-compaction maintenance run or when every accepted
      message is hidden.
- `run.boundary` — a person's steering atomically ended one run and began its successor; the
  agent remains active. Steering from another agent or from the system joins the active run
  instead and never emits it.
    - `agentId` (ID string).
    - `finishedRun` (full run metadata object) — terminal with reason `"steering"`.
    - `startedRun` (full run metadata object) — status `"running"`.
    - `acceptedMessageIds` (array of ID strings) — every visible steering message accepted into
      `startedRun`, oldest first; empty when every accepted steering message is hidden.
- `run.finished` — a run reached a terminal state without an immediate successor; the agent is
  `"idle"` again. A run whose `kind` is `"standalone"` is the one exception: it was never active,
  this is its only lifecycle event, no `run.started` came before it, it precedes the
  `message.created` of its messages, and the agent's status is whatever it was.
    - `agentId` (ID string).
    - `run` (full run metadata object) — terminal, including its explicit `reason`, final usage,
      cost, and timestamps, and its `kind` when it has one.
- `message.created` — a message came into being: a user message entering as `"pending"`
  (content complete, no run yet), or an agent/system/service message that may still grow.
    - `agentId` (ID string).
    - `runId` (ID string, or `null` for a pending user message) — the run it belongs to.
    - `message` (full message object) — role, content blocks, client metadata when supplied,
      everything.
- `message.updated` — a message changed structurally after it entered a run: a block was added,
  a tool call or compaction changed `status`, a compaction gained `tokensAfter`, a result or
  presentation arrived. Pending acceptance is carried by `run.started` or `run.boundary`, not
  duplicated here.
    - `agentId` (ID string).
    - `runId` (ID string).
    - `message` (full message object) — the whole message as of now; not a diff.
- `message.delta` — streaming text, the one event that is **not** a full object. Deltas are
  the high-frequency path. Every delta identifies the absolute prior length of its target block,
  so replay is idempotent and a missed append is detectable. A client that detects a gap or
  conflict recovers the full message from the next `message.updated` or authoritative history.
    - `agentId` (ID string).
    - `runId` (ID string).
    - `messageId` (ID string) — the growing message.
    - `blockIndex` (number) — which content block grows.
    - `offset` (non-negative integer) — the target block's text length immediately before this
      append, measured in UTF-16 code units.
    - `append` (string) — text to concatenate onto that block.

    Delta application is exact:

    - when the current text length equals `offset`, append the complete `append`;
    - when the complete `append` is already present starting at `offset`, ignore the replay;
    - when the current text ends partway through an otherwise matching `append`, append only its
      missing suffix;
    - when the block is absent or not textual, the current text is shorter than `offset`, or text
      after `offset` conflicts with `append`, stop applying deltas for that message and reconcile
      it from authoritative history (or a later full `message.updated`).

- `message.deleted` — the message is gone from history; clients remove it from rendering.
  There is no REST operation behind this: deletion happens only when the daemon **resets a
  block of the transcript to restart inference** — a retried or interrupted generation whose
  partial messages are discarded before the model produces them again. The replacements arrive
  as ordinary `message.created` events.
    - `agentId` (ID string).
    - `runId` (ID string).
    - `messageId` (ID string).

**Live voice sessions**

- `live.session.created` — owner-private full `session`, with optional `mutationId`.
- `live.session.updated` — owner-private version-chained changes identified by `sessionId`,
  with optional `mutationId`. See "Live updates" for the exact payload and privacy boundary.

**Configuration, profile, Cloud, and Happy integration**

- `config.updated` — payload `{}`, deliberately empty. Something about the daemon's
  configuration changed — the effective config, the instructions document, or the security
  policy. This includes changes to `config.node.name` or the node avatar through config mutations
  or admin tools. It is a nudge to refetch the config endpoints whenever convenient; clients
  displaying the node avatar also conditionally refetch its image bytes.
- `runners.updated` — payload `{ "runners": [...], "version": "<UUIDv7>" }`, a complete
  replacement of the runner list in the same shape as `GET /v0/runners`, published after any
  runner object changes, including connection status. Clients keep the greater version across
  reads and events. Tokens and transport addresses are absent.
- `connections.updated` — payload `{ "connections": [...], "version": "<UUIDv7>" }`, a
  complete replacement of the public remote roster, in the same shape as `GET /v0/connections`
  with `version` always present. An empty array clears the roster. A changed public roster is
  persisted before notification; additions, removals, renames, and authentication-kind or
  organization changes advance its version. Unchanged public rosters emit nothing. Startup
  reconciliation covers offline configuration edits and interrupted writes. Notifications may
  coalesce intermediate configurations, but always carry the complete committed snapshot and its
  matching version. Clients keep the greater version across reads and events. The event is
  available through journal pull, SSE, and `HappyAgentClient.updates()`. Credentials, transport
  addresses, and health status are absent; remote agents' own events stay in the remote journal.
- `profile.updated` — a profile changed. Standalone mode includes `profile` (the full profile
  object). Team mode instead includes only `userId`; it is a server-wide invalidation delivered to
  every connected organization member so clients can invalidate state for exactly that identity.
  The shared event never broadcasts profile fields belonging to another member. Either variant
  echoes `mutationId` when the API mutation supplied one.
- `cloud.updated` — the installation-wide Cloud authentication state changed. This is a complete
  replacement rather than a version-chain diff; clients keep the greater embedded `version` when
  reconciling it with a snapshot.
    - `cloud` (full Cloud object).
    - `mutationId` — echoed when an API mutation caused the change.
- `happy.integration.updated` — the Happy mobile connection state changed: installation-wide in
  standalone mode, private to the authenticated connection owner in team mode. This is a complete
  replacement rather than a version-chain diff; clients keep the greater embedded `version` when
  reconciling snapshots for the same owner. Team clients never receive another owner's event or
  an unowned installation-wide integration event.
    - `integration` (full Happy integration object).

**Provider CLIs**

- `provider_cli.updated` — one assistant's provider CLI object changed: discovery found a
  different installation or sign-in, or an install or sign-in made progress, printed output, or
  finished. This is a complete replacement rather than a version-chain diff; clients keep the
  object with the greater `version` for its `id`. Output lines may be coalesced, at most a few
  events per second for one assistant. Absent on older daemons and in team mode.
    - `providerCli` (the complete provider CLI object).
    - `mutationId` — echoed when the API request that started or changed the operation supplied
      one.

**Provider-account usage**

- `provider.usage.updated` — protocol 29 or newer. One provider account's usage entry changed: a
  read started or finished, a vendor reported the account during inference, or a read failed.
  The payload is a complete replacement of that account's entry from `GET /v0/usage`, without the
  configuration fields `type`, `enabled`, `models`, and `pool`, which follow `config.updated`:
    - `providerId`, `usage`, `checkedAt`, `error`, `refreshedAt`, `refreshError`, `retryAt`, and
      `refreshing` — exactly as on the `GET /v0/usage` entry.
    - `signIn` — optional, exactly as on the `GET /v0/usage` entry, so it is absent for a smart
      provider and from older daemons. A change of `signIn` alone emits an event too.

    Every change emits one event, in the order the changes happened, so the latest event for a
    `providerId` is its current state. The event is journaled like any other and replays from a
    cursor. Readings live only in daemon memory, so events replayed from before a daemon restart
    describe state that daemon no longer holds; after a resync or a reconnect across a restart,
    clients read `GET /v0/usage` again and treat it as current.

**Mobile connector**

- `mobile_connector.updated` — the caller's mobile connector changed: its socket status, pairing,
  or paired phones. This is a complete replacement rather than a version-chain diff; clients keep
  the snapshot with the greater `version`. In team mode only its owner receives it, in journal
  pulls, replay, and live delivery, and the payload never names the owner.
    - `mobileConnector` (the complete mobile connector object).

**User settings**

- `user_settings.updated` — a write applied to one of the person's settings: set, changed, or
  cleared. It is a complete replacement of that one entry rather than a version-chain diff; clients
  keep the entry with the greater `version` for its key. In team mode only the settings' owner
  receives it, including journal pulls, replay, and live delivery. The payload never names the
  owner. A write ignored as stale emits nothing.
    - `setting` (the complete setting object; `value` is `null` for a clear).
    - `mutationId` — echoed when the write supplied one.

**User environment**

- `user_environment.updated` — one of the person's devices reported. In team mode only that
  person receives it, in journal pulls, replay, and live delivery; the payload never names the
  person.
    - `environment` (the complete device environment object).
    - `mutationId` — echoed when the report supplied one.

**Stories**

Retired: current daemons emit neither event below. The shapes remain documented for older daemons
and retained event history.

- `story.changed` — a story or repost was posted, someone replied to it, or the reader marked it
  seen. Each reader receives their own copy, because `seen` and `canDelete` are theirs; in team
  mode only that reader receives it, including journal pulls, replay, and live delivery. Only people
  with stories on who may see the story receive it. Nothing is emitted when a story ends; clients
  drop it at `expiresAt`.
    - `story` (the complete story object, as that reader is served it).
- `story.removed` — a story was deleted before it ended. Delivered like `story.changed`, to each
  person who saw it; clients drop it at once.
    - `storyId`.

**Feed**

Feed events belong to one person: in team mode only that person receives them, including journal
pulls, replay, and live delivery, and the payloads never name them. Guests receive none. A
mutation's `mutationId` is echoed; fan-out, seeding on enrollment, and the read routes of tasks
and agents carry none.

Like the routes, these events carry references only; a change to a subject's name, picture, or
text reaches clients through that subject's own events, never through the Feed.

- `feed.item.created` — an entry was opened in the person's feed: a change opened it, or seeding
  wrote it.
    - `item` (full feed item object).
- `feed.item.updated` — an entry took in a change or was seen. It is a complete replacement rather
  than a version-chain diff; clients keep the copy with the greater `version` for its `id` and
  re-sort by `cursor`.
    - `item` (full feed item object).
- `feed.item.removed` — an entry was removed because its subject was permanently deleted.
    - `itemId` (the entry's `id`).
- `feed.unread.updated` — the person's count of open entries changed. It follows the item events
  of the same change.
    - `unread` (non-negative integer).

The set grows with the product; clients skip event types they do not recognize.

### `GET /v0/events`

Pulls events, oldest first.

Query parameters:

- `after` — the cursor to read from, exclusive. Omitted, reading starts at the oldest retained
  event.
- `until` — optional, inclusive upper bound: pull the changes between two cursors, such as the
  `cursor` a mutation answered with and the point a client last processed.
- `limit` — optional, default 100.

Response — `200`:

```json
{
    "events": [
        /* envelopes, oldest first */
    ],
    "cursor": "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e",
    "latestCursor": "01991f3a-6d2f-7000-8000-3a0b2c4d5e6f"
}
```

`cursor` is where this page ended — pass it as the next `after`. `latestCursor` is the newest
event the daemon holds, so the client knows how far behind it still is.

In team mode, private Happy integration, draft, and user-settings events are filtered by
authenticated owner before their payloads are returned. Journal cursors remain opaque installation-wide positions: `cursor`
advances past scanned events hidden from that user, and `latestCursor` still describes the
journal, not just visible events. A page may therefore contain no events while advancing its
cursor. Filtering must not strand pagination behind another user's events or change cursor
retention and `cursor_unavailable` semantics.

When `after` has fallen out of the journal window — `409`:

```json
{
    "error": "Event cursor is unavailable.",
    "code": "cursor_unavailable",
    "cursor": "<current cursor>"
}
```

The client resyncs and continues from the returned cursor.

### `GET /v0/events/stream`

The same journal as a Server-Sent Events stream. The resume cursor comes from the standard
`Last-Event-ID` header, or an `after` query parameter; SSE auto-reconnect therefore resumes
correctly with no client logic at all.

The stream opens with a `hello` frame before anything else:

```
event: hello
data: {"cursor":"01991f3a-...","gap":false,"resumed":true,"connectedAt":1755400000000,"daemonId":"d4e5f6g7","daemonStartedAt":1755399990000,"draining":false}
```

- `resumed` — the supplied cursor was honored; everything since it follows, in order.
- `gap` — **the supplied cursor was lost to the journal window.** The stream is live from now,
  but events between the cursor and now are gone: the client must resync its snapshots, exactly
  as with a pull `409`. The stream stays usable while it does.
- `daemonId` — one CUID2 minted when this daemon process starts and repeated by every stream it
  accepts. A changed value after reconnect means the client reached a different process.
- `daemonStartedAt` — when that process started, in epoch milliseconds.
- `draining` — whether the process has entered its sticky draining phase. This closes the race
  where draining began while the client was disconnected and its `daemon.draining` event is no
  longer replayable.
- `drain` — the drain object described under Daemon lifecycle, or `null` before draining or
  graceful shutdown begins. A client that connects mid-drain learns from it whether a replacement
  is coming.
- `streamId` — a CUID2 naming this one stream connection, for subscribing it to collaborative
  documents. A reconnect gets a new one. Additive; absent on daemons without collaborative
  documents.

`daemonId`, `daemonStartedAt`, `draining`, and `drain` are additive and may be absent on older
compatible protocol-22 daemons. `HappyAgentClient.updates()` emits `daemon_started` once for each
distinct `daemonId` it observes. It emits `draining` after either a draining hello or a live
`daemon.draining` event, carrying the drain object when the daemon supplied one, while continuing
to pass the underlying journal event through normally.

After `hello`, every event is one SSE frame: the SSE `id:` field carries the event's `cursor`
(feeding `Last-Event-ID`), the `event:` field is the event's `type`, and `data:` is the
envelope. The one exception is the live `document.update` and `document.presence` frames
described under Document Surfaces: they carry no `id:` line and no cursor, are not journal
events, and reach only a stream its client subscribed to a document.
In team mode, the same owner filtering applies to replay and live delivery. Hidden Happy
integration events produce no event frame for another member; resuming after the last visible
cursor must still deliver all subsequent visible events in journal order. The hello cursor and
gap rules retain their installation-wide journal meaning. The same rules apply to private draft and
user-settings events.
Comment heartbeats arrive at least every 15 seconds and keep the connection alive through
proxies; clients ignore them, and a client that hears nothing for 45 seconds reconnects, as
described under Keepalive. A client
that falls too far behind reading is disconnected rather than buffered without bound, and comes
back with its last cursor — landing in either the resumed or the gap case above.

## Bootstrap

### `GET /v0/agents/:agentId/bootstrap`

One bounded snapshot for opening a conversation. It composes the exact agent object plus the
`mode`, `context`, and `usage` fields from the focused agent endpoints, the agent's complete
background-process and subagent activity, and every durable queue or steering message that
inference has not accepted yet. It also captures the event cursor before reading, so a client can
render the snapshot and follow every concurrent change without a snapshot-to-stream gap. Accepted
messages, including compaction messages, come from the pageable history endpoint. The current
slash-command catalog is included directly so autocomplete is ready with the rest of the composer.

Response — `200`:

```json
{
    "agent": {
        /* exactly GET /v0/agents/:agentId */
    },
    "draft": {
        "value": null,
        "updatedAt": 1755400000000
    },
    "mode": {
        "providerId": "codex",
        "modelId": "openai/gpt-5.6-sol",
        "effort": "medium",
        "serviceTier": null,
        "permissionMode": "auto"
    },
    "context": {
        "approximate": false,
        "contextTokens": 201000,
        "contextWindow": 272000,
        "providerId": "codex",
        "modelId": "openai/gpt-5.6-sol"
    },
    "usage": {
        /* exactly the provider-then-model map from GET /v0/agents/:agentId/usage */
    },
    "pending": [
        {
            "id": "x3k9m2q7w1e5r8t4y6u0i2o5",
            "role": "user",
            "status": "pending",
            "delivery": "steer",
            "createdAt": 1755400009000,
            "content": [{ "type": "text", "text": "Then update the tests" }],
            "metadata": {},
            "clientMetadata": { "composer": "mobile" },
            "mode": {
                "providerId": "codex",
                "modelId": "openai/gpt-5.6-sol",
                "effort": "medium",
                "serviceTier": null,
                "permissionMode": "auto"
            },
            "runId": null
        }
    ],
    "processes": [
        /* full background-process objects, newest first */
    ],
    "subagents": [
        /* full child-agent objects, newest first */
    ],
    "profiles": [],
    "slashCommands": [
        {
            "name": "compact",
            "hasArguments": false,
            "description": "Summarize older messages to free context space.",
            "kind": "compaction"
        }
    ],
    "cursor": "01991f3a-6d2f-7000-8000-3a0b2c4d5e6f"
}
```

- `agent` — exactly the focused agent resource, including its recursive active `subtasks` tree.
- `draft` — exactly the focused draft response object, scoped to the authenticated user in team mode.
- `mode` — exactly the focused mode response; `null` on a fresh agent.
- `context`, `usage` — exactly the focused usage response fields.
- `pending` — every not-yet-accepted `queue` and `steer` message, oldest first and never paged.
- `processes` — the complete background-process list from the focused activity response, newest
  first. This additive field may be absent when talking to an older compatible daemon.
- `subagents` — the complete child-agent list from the focused activity response, newest first.
  This additive field may be absent when talking to an older compatible daemon.
- `profiles` — the complete ordered profile catalog from the focused agent response. Current
  daemons emit an empty array. This additive field may be absent when talking to an older
  compatible daemon.
- `slashCommands` — exactly the complete catalog from the focused agent response.
- `cursor` — the event cursor captured before the snapshot reads. Open the global event stream
  from it; duplicate facts are harmless, while no concurrent fact can disappear.

`404` when no such agent exists. Accepted message history remains in the pageable `messages`
endpoint and is intentionally not repeated here.

### `GET /v0/bootstrap/desktop`

One request that gets the desktop app on screen instantly: instead of a fan-out of `GET`s at
launch, the client reads this, renders, and opens the event stream. It is a composition of
other endpoints' objects — nothing here has a shape of its own.

Response — `200`:

```json
{
    "config": {
        /* exactly GET /v0/config */
    },
    "profile": {
        /* exactly GET /v0/profile */
    },
    "onboarding": {
        /* exactly GET /v0/onboarding */
    },
    "cloud": {
        /* exactly GET /v0/cloud */
    },
    "happyIntegration": {
        /* exactly GET /v0/integrations/happy */
    },
    "userSettings": [
        /* exactly the settings array from GET /v0/user-settings */
    ],
    "projects": [
        /* all project objects, catalog order */
    ],
    "workspaces": [
        /* root workspaces of every project, plus their first-level children */
    ],
    "bots": [
        /* all bot objects, catalog order */
    ],
    "tasks": [
        /* all task objects, oldest first */
    ],
    "taskMemberships": [
        /* the caller's memberships, in the caller's order */
    ],
    "surfaces": [
        /* the full Surface instance catalog, ascending ID */
    ],
    "storiesEnabled": false,
    "stories": [],
    "feedUnread": 3,
    "teammates": [
        /* every team member who signs in, as GET /v0/users describes each one */
    ],
    "archivedAgents": [
        /* the most recently archived agents of those projects and workspaces, newest first */
    ],
    "cursor": "01991f3a-6d2f-7000-8000-3a0b2c4d5e6f"
}
```

- `config`, `profile`, `onboarding`, `cloud`, and `happyIntegration` — the full
  objects from their own endpoints. `cloud` and `happyIntegration` are additive
  and may be absent on an older compatible daemon; a daemon old enough to omit one does not serve
  that feature's endpoints either.
- In team mode, `happyIntegration` is exactly the authenticated user's personal mobile snapshot,
  with the same wire shape, never another member's connection or an installation-wide fallback.
  The bootstrap cursor and owner-filtered event stream preserve the same snapshot-to-stream
  guarantee as standalone mode. The separate `cloud` object is unchanged.
- `userSettings` — exactly the `settings` array from `GET /v0/user-settings`: the authenticated
  member's own in team mode, the installation's one person's in standalone mode. Current daemons
  always include it; its absence means the daemon has no user settings, so the client keeps those
  preferences on the device. Follow `user_settings.updated` from the bootstrap `cursor`.
- `config.node` — the installation's name and nullable avatar ThumbHash metadata are already
  part of the config object, not a separate bootstrap field. Optional for older compatible
  daemons; `avatar: null` explicitly means no image is set.
- `projects` — every active project.
- `workspaces` — deliberately shallow: each project's root workspace and the workspaces
  directly under it. Each returned project and workspace embeds its active top-level `agents`
  series. Deeper nesting and archived workspaces are loaded on demand through the workspace
  endpoints when the user opens a project; the archived agents of the included owners arrive in
  `archivedAgents`.
- `bots` — every bot, archived ones included, in catalog order, exactly as `GET /v0/bots`
  returns them, each embedding its one agent. This additive field may be absent on an older
  compatible daemon, which does not serve the bot endpoints either.
- `tasks` — every task, archived ones included, oldest first, exactly as `GET /v0/tasks` returns
  them, each embedding its one agent and naming its `ownerUserId`. Additive; absent on an older
  compatible daemon, which does not serve the task endpoints either.
- `taskMemberships` — the caller's memberships, in the caller's own order, exactly as
  `GET /v0/tasks` returns them. A client renders the caller's task list by following this order
  into `tasks`. Additive; absent together with `tasks`.
- `surfaces` — exactly the catalog with nested members from `GET /v0/surfaces`. Additive and
  absent on daemons without Surface support. Follow shared `surface.updated` from the bootstrap cursor.
  Todo data and revision history are loaded on demand through the Todo Surface endpoints.
  Calendar events, occurrences, and revision history are likewise loaded on demand through the
  Calendar Surface endpoints.
- `storiesEnabled` — retired compatibility field, always `false` on current daemons.
- `stories` — retired compatibility field, always `[]` on current daemons. Historically
  included with `storiesEnabled` by daemons supporting the Stories bootstrap addition;
  both fields may be absent on older compatible daemons.
- `feedUnread` — the caller's count of open Feed entries, exactly `unread` from `GET /v0/feed`, so
  a client can show the Feed's badge before reading the Feed itself. Follow `feed.unread.updated`
  from the bootstrap `cursor`. Optional; absent on daemons without the Feed and for guests.
- `teammates` — in team mode, every member who signs in, the caller included, guests left out, in
  name order. Each entry has exactly the user shape of `GET /v0/users`. It is the directory a
  client offers when the person types `@` to mention someone, so mentioning needs no request.
  Follow `profile.updated` from the bootstrap `cursor` and re-read a changed member through
  `GET /v0/users?ids=`. A member who signs in for the first time appears in the next bootstrap.
  Optional: absent in standalone mode and on older daemons. Teams are small today. A later
  revision may send only the members the daemon predicts a person is most likely to mention,
  with clients looking up anyone else on demand.
- `archivedAgents` — the archived agents that would otherwise belong to the included projects'
  and workspaces' `agents` series, as full agent objects, newest `archivedAt` first with the
  agent ID as the tie-breaker. Each carries the `workspaceId` of its owner, which is the
  project's ID for a root-owned agent. The list is bounded to the 200 most recently archived
  agents across the whole snapshot, so a client showing recent history reads it here without a
  per-owner fan-out; older archived agents remain readable by ID. Agents owned by archived
  projects or workspaces and ordinary hidden subagents are not included. This additive field
  may be absent on an older compatible daemon, which carries no archived agents in bootstrap.
- Every included full agent embeds its recursive `subtasks` tree. This includes each bot's and
  each task's agent and every agent in a project or workspace series, so shared-filesystem and workspace-bound
  subtasks are available on initial load without fetching activity for every agent. Workspace
  listings remain shallow and owner-series membership is unchanged. A workspace-bound subtask
  may appear both in its parent's tree and in its own workspace's series; both occurrences name
  the same agent. Reconcile by ID and the nested agent's own version.
- `cursor` — the event cursor captured before the composed snapshot reads. The client opens
  `GET /v0/events/stream` from here and everything it just read stays current; there is no
  window for a change to fall between the snapshot and the stream.

There is no global agent-list endpoint and no standalone collection of active agents in
bootstrap. Active agents are discovered through the ordered `agents` arrays embedded in projects
and workspaces — and, for bots and tasks, through the single agent embedded in each bot or task
object. Surface chats are discovered through `Surface.chatAgentId` and ordinary focused agent
reads, not a separate agent list. Active
subtask descendants are included recursively on those same agent objects, not in a new top-level
collection. `archivedAgents` is the one flat collection, and it holds only archived agents. An
individual agent's history is loaded by ID.
