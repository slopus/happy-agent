# Put a team server behind an SSO load balancer

Use this recipe when an organization runs a team-mode Happy Agent behind an HTTPS load balancer or
gateway that enforces single sign-on itself, for example an AWS Application Load Balancer, an API
gateway, or an identity-aware proxy, and members sign in with the organization's own OAuth server.
The outcome is a server members add in the Happy desktop and mobile apps by its HTTPS URL, with no
dependency on Tailcat, Happy Cloud, or WorkOS.

First complete [Set up enterprise JWT sign-in](enterprise-jwt-authentication.md): the daemon must
run with `authentication = "jwt"`. This recipe adds only the load balancer. It does not authorize
changing the organization's network, load balancer, or identity provider; ask the administrator
for that access.

## How it fits together

```text
Happy app ──HTTPS──▶ load balancer ──HTTP──▶ team daemon (feature.team, port 3000)
   │                  verifies the bearer JWT
   │                  for everything except GET /v0/authentication
   └──── system browser ──▶ organization's OAuth server (happy://oauth/callback)
```

The app reads `GET /v0/authentication`, signs the person in with the OAuth server in the system
browser, and then sends the access token in the `Authorization` header on every request, event
stream, and WebSocket. The load balancer and the daemon both verify the same token. Neither ever
sees the authorization code, the PKCE verifier, or the refresh token, which the app keeps in the
operating system's keychain.

## 1. Configure the OAuth server

Register the Happy apps as one public (native) client:

- Redirect URI: exactly `happy://oauth/callback`. The desktop, iOS, and Android apps all use it.
- Grant: authorization code with PKCE (`S256`); refresh tokens if members should stay signed in.
- Access tokens: JWTs whose audience the load balancer and the daemon both accept.

When the OAuth server picks the API a token is for from an RFC 8707 `resource` parameter, set
`resource` under `[feature.team.jwt]`, usually to the same value as `audience`. The apps then send
it on sign-in and refresh so the server issues tokens for this deployment directly.

## 2. Configure the load balancer

Point the load balancer's HTTPS listener at the daemon's team port, `[feature.team] port`
(default `3000`), over plain HTTP on a private network. Then:

1. **Let discovery through.** Forward `GET /v0/authentication` to the daemon without edge
   authentication. It returns only the sign-in method and never user or daemon data.
2. **Authenticate with the bearer token only.** Verify the `Authorization: Bearer` JWT on every
   other path: issuer, audience, signature, and expiry. Never answer an API request with a
   redirect to a sign-in page or rely on a browser session cookie; the apps follow no redirects on
   API calls and treat a redirect as "sign in again".
3. **Pass headers and streams through.** Forward `Authorization` unchanged, allow WebSocket
   upgrades, and do not buffer responses: `GET /v0/events/stream` is Server-Sent Events.
4. **Set the idle timeout between 20 and 59 seconds**, such as 55 seconds on an AWS ALB, whose
   default of 60 seconds equals the daemon's own keep-alive timeout. Every event stream and
   WebSocket carries a heartbeat or ping at least every 15 seconds, so a longer timeout is never
   needed.
5. **CONNECT is optional.** Workspace browser previews, agent networks, and live artifacts use
   WebSocket tunnels at `…/proxy/websocket` when the daemon reports
   `capabilities.webSocketTunnels`, so a load balancer that rejects `CONNECT` loses nothing.
6. **Keep runner and bridge routes off the edge.** `GET /v0/runners/connect` and
   `GET /v0/exported-bots/connect` use their own tokens, not member tokens. Connect runners and
   exported-bot bridges over the private network. If they must cross the edge, forward those two
   paths without edge authentication; the daemon authenticates them itself.

An edge rejection reaches the app as a `401`, a `403` that is not Happy's JSON error, or a
redirect, and the app asks the person to sign in again. Answer with Happy's own errors only from
the daemon.

## 3. Deploy two nodes

Deploy the team server as two machines: the node behind the load balancer, and a
[dedicated runner](add-runner.md) on a separate machine. The node keeps the database, provider
credentials, and sign-in configuration. The runner holds the project folders and runs everything
that touches them: agent commands, Git, terminals, and previews. A server that the Internet can
reach is exactly where an agent command that goes wrong, or a dependency that runs hostile code,
must not share a machine with those secrets.

The runner connects to the node over the private network, never through the load balancer and
never over Tailcat, which this recipe turns off below:

```sh
HAPPY_RUNNER_ENDPOINT=http://NODE_PRIVATE_ADDRESS:3000 happy-agent runner
```

Follow [Add a dedicated runner](add-runner.md) for the token, the service, and moving projects
onto the runner. Use the private `http://` endpoint above in place of the Tailcat endpoint.

## 4. Turn off what the edge does not need

The apps have no device-management settings. A team server turns its own features on and off in
its machine `happy.toml`, and the apps hide a feature when the server reports it off. Behind an
SSO load balancer, we recommend:

```toml
[feature.mobile_connector]
enabled = false        # phone pairing: phones sign in with OAuth instead

[feature.tailcat]
enabled = false        # the default; keep it off on a server the Internet can reach

[settings]
happy_integration = false   # the connection to the Happy mobile app through Happy's hosted server
```

- **Phone pairing.** Paired phones authenticate with device tokens, which an SSO-enforcing edge
  rejects, so pairing cannot work through it. With it off, `GET /v0/mobile-connector` reports
  `status: "disabled"`, and the apps hide pairing.
- **Happy's hosted server.** With `happy_integration = false`, `GET /v0/integrations/happy`
  reports `status: "disabled"` for every member, and the apps hide it.
- **Tailcat.** Keep it off on any server exposed to the Internet, even though other Happy setups
  use it. The load balancer already gives members an HTTPS path, and a Tailcat exposure is a
  second, account-free way in that bypasses the load balancer and its single sign-on: anyone who
  learns the address reaches the daemon directly. The daemon still checks every token, but the
  organization's edge policy no longer applies. Tailcat is off by default, and `enabled = false`
  makes that explicit. It is the operator's starting choice, not a lock: an active admin bot can
  still turn Tailcat on at runtime, and machine configuration or an admin bot can add Tailcat
  remote connections. The mobile connector opens a separate Tailcat socket only while it is
  enabled and `[api] public_url` is unset, so turning phone pairing off closes that path too.

All three are machine settings; a repository's `happy.toml` cannot change them.

## 5. Verify

Replace `SERVER` with the load balancer's HTTPS origin.

1. Discovery passes the edge without a token:

    ```sh
    curl -s "SERVER/v0/authentication"
    ```

    Expect `"authenticated": false` and the `oauth` method, including `resource` when configured.

2. A request without a token is refused by the edge or the daemon, and never redirected:

    ```sh
    curl -s -o /dev/null -w '%{http_code}\n' "SERVER/v0/health"
    ```

    Expect `401` or `403`, not `3xx`.

3. Sign in from a Happy app with the server's URL, then confirm in the app that health reports
   `webSocketTunnels`, that conversations update live for several minutes without reconnecting,
   and that a workspace browser preview loads.
4. Run the [deployed-node test](README.md#testing-a-deployed-node) through the load balancer.

## Troubleshooting

- **The app asks to sign in again right after signing in.** The edge rejects the token: compare
  its expected issuer and audience with the token, or the app sent no `resource` the server needed.
  A signed-in member who has not saved a profile yet is asked for a name instead, not to sign in.
- **Live updates stop after about a minute.** The load balancer buffers Server-Sent Events or its
  idle timeout is below 20 seconds.
- **Requests fail intermittently with `502`.** The load balancer's idle timeout is 60 seconds or
  more and it reuses connections the daemon has closed; lower it below 60 seconds.
- **Browser previews say the network does not allow them.** The daemon is older than WebSocket
  tunnels and the edge rejects `CONNECT`. Upgrade Happy Agent.
