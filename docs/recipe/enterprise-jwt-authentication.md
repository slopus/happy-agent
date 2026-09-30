# Set up enterprise JWT sign-in

Use this recipe when an organization wants its members to sign in to a team-mode Happy Agent with
the organization's own identity provider (Okta, Entra ID, Google Workspace, Keycloak, an internal
SSO, and so on) instead of Happy's WorkOS accounts. The outcome is a team-mode daemon that verifies
JWT access tokens issued by the organization, and an OAuth authorization server, owned by the
organization, that the Happy desktop or mobile app signs in with directly.

Read [Team deployment mode](../team-mode.md) first; everything there about installation, Tailcat,
onboarding, and verification still applies. This recipe replaces only its WorkOS authentication.
It does not authorize changing the organization's identity provider, registering applications in
it, or publishing a service to the internet; ask the user's administrator for that access.

This requires a Happy Agent release that includes enterprise JWT authentication. Clients detect it
through `GET /v0/authentication`; an older daemon answers `404`.

## How sign-in works

It is the same pattern Slack and other desktop apps use for enterprise SSO: the app sends the
person to the organization's sign-in page in the system browser, gets back a short-lived one-time
code, and exchanges that code for tokens itself.

The daemon is treated as **untrusted with credentials**. It tells the app where to sign in and
verifies the access token the app sends it, but it never sees the sign-in code, the PKCE secret,
or a refresh token.

```text
Happy app                 Happy Agent daemon           Authorization server (deployer)
   |  GET /v0/authentication  |                                  |
   |------------------------->|                                  |
   |  oauth: authorizationUrl, tokenUrl, refreshUrl, clientId    |
   |<-------------------------|                                  |
   |  system browser: authorizationUrl?client_id&redirect_uri&state&code_challenge
   |------------------------------------------------------------>|  SSO login with the
   |                          |                                  |  identity provider
   |  browser redirects to redirect_uri?code=...&state=...       |
   |<------------------------------------------------------------|
   |  POST tokenUrl  code + code_verifier                        |
   |------------------------------------------------------------>|
   |  access_token (JWT), expires_in, refresh_token?             |
   |<------------------------------------------------------------|
   |  Authorization: Bearer <access_token>                       |
   |------------------------->|  verify signature, iss, aud, exp; read user ID
   |          ... later, when the access token expires ...       |
   |  POST refreshUrl  refresh_token                             |
   |------------------------------------------------------------>|
   |  new access_token (and maybe a new refresh_token)           |
   |<------------------------------------------------------------|
```

1. The Happy app asks the daemon how to sign in. Any `401` from the daemon carries the same
   answer, so the app can start sign-in from any rejected request.
2. The daemon returns an `oauth` method: the authorization, token, and optional refresh
   endpoints, the client ID, and an optional scope, straight from its configuration.
3. The app creates a random `state` and a PKCE verifier, keeps both in memory, and opens the
   authorization endpoint in the **system browser**, never an embedded web view. It shows the
   authorization server's host so the person can see where they are signing in.
4. The authorization server signs the person in with the identity provider and redirects to the
   app's `redirect_uri` with a **one-time code** and the `state`. On desktop the redirect URI is a
   loopback address such as `http://127.0.0.1:53682/callback`; on mobile it is the app's own URL
   scheme.
5. The app checks `state` and exchanges the code, together with the PKCE verifier, at the token
   endpoint. Anyone who intercepts the redirect gets only a code that is useless without the
   verifier and expires within seconds.
6. The app sends the access token to the daemon on every request. It may keep all tokens only in
   memory.
7. Before or when the access token expires, the app sends the refresh token to the refresh
   endpoint, if there is one, and receives a new access token. Without a refresh endpoint, or when
   refresh fails, the app goes through the browser again. That is usually instant while the
   identity provider's own session is still valid, which is how an app can keep credentials only
   in memory and still rarely prompt.

The app sends a refresh token only to the refresh endpoint recorded when it signed in, never to one
a daemon advertises later. Client code uses `beginOAuthSignIn`, `completeOAuthSignIn`, and
`refreshOAuthCredential` from `@slopus/happy-agent-client`; `HappyAgentClient` accepts a token
function so a refreshed token applies without recreating the client.

## 1. Choose the authorization server

The deployer needs an OAuth 2.0 authorization server that supports the **authorization code flow
with PKCE** for a public client and issues **JWT access tokens**. There are two ways:

- **Use the identity provider directly.** Okta, Entra ID, Auth0, Keycloak, Ping, and most modern
  identity providers do this out of the box. Register a native or public application, allow the
  Happy app's redirect URIs, define an API or resource for this deployment so access tokens carry
  its audience, and enable refresh tokens if wanted. No custom code is needed.
- **Write a small authorization server** in front of an identity provider that cannot issue
  suitable access tokens, for example a SAML-only one. See step 3.

## 2. Agree the token contract

- **Issuer** (`iss`): the authorization server's issuer, for example `https://sso.acme.example`.
- **Audience** (`aud`): a value unique to **this** deployment, for example
  `https://happy.acme.example`. The daemon sees every token sent to it; a unique audience stops it
  from replaying a member's token to another service or another Happy deployment.
- **User ID claim**: a stable, never-reused user ID. `sub` is the default. Prefer an immutable
  object ID over an email address. Values are 1–256 printable characters.
- **Owner**: the user ID of the person who should become the deployment owner.
- **Client ID** and optional **scope**: whatever the authorization server registered for the
  Happy app. Request `offline_access` or the provider's equivalent if refresh tokens need it.
- **Lifetimes**: short access tokens, typically 5–60 minutes, with refresh tokens if the
  organization wants long sessions. Rotate refresh tokens on use where the server supports it.
- **Signing key**: prefer an asymmetric key published as a JWKS URL, which every identity provider
  offers. Algorithms: `RS256`, `RS384`, `RS512`, `PS256`, `PS384`, `PS512`, `ES256`, `ES384`,
  `ES512`, `EdDSA`. A shared secret (`HS256`, `HS384`, `HS512`, at least 32 bytes) is supported,
  but whoever holds it can mint tokens, including the daemon itself. Never use a shared secret
  when the daemon is not fully trusted, and never share one between deployments.

Every access token must carry `iss`, `aud`, `exp`, and the user ID claim. `nbf` and `iat` are
checked when present. Clocks may differ by up to 30 seconds.

## 3. If you write the authorization server yourself

Implement three endpoints following RFC 6749, RFC 7636, and RFC 8252. Any OAuth server library can
do this; the essentials are:

**`GET /oauth/authorize`** receives `response_type=code`, `client_id`, `redirect_uri`, `state`,
`code_challenge`, `code_challenge_method=S256`, and optional `scope`.

1. Check `client_id` and **check `redirect_uri` exactly against an allow-list** of the Happy app's
   callbacks, for example `happy://auth/callback` and `http://127.0.0.1:<any port>/callback`.
   Never redirect anywhere else, not even to report an error.
2. Sign the person in with the identity provider, and check that they may use Happy.
3. Create a random, single-use code that expires within about a minute, and store it with the user,
   `client_id`, `redirect_uri`, and `code_challenge`.
4. Redirect to `redirect_uri?code=<code>&state=<state>`, copying `state` unchanged.

**`POST /oauth/token`** receives a form with `grant_type=authorization_code`, `code`,
`redirect_uri`, `client_id`, and `code_verifier`. Consume the code, check that `client_id` and
`redirect_uri` match, and check that the base64url SHA-256 of `code_verifier` equals the stored
challenge. Respond with JSON:

```json
{
    "access_token": "<JWT>",
    "token_type": "Bearer",
    "expires_in": 900,
    "refresh_token": "<opaque random string>"
}
```

Errors use `400` with `{ "error": "invalid_grant" }` or another OAuth error code.

**`POST /oauth/refresh`** (optional; it can also be the token endpoint) receives
`grant_type=refresh_token`, `refresh_token`, and `client_id`, and responds the same way. Store
refresh tokens hashed, rotate them on every use, revoke them when a person leaves, and treat reuse
of a rotated token as theft by revoking the whole session. The refresh endpoint may live on a
different origin from the other two.

Minting the access token with `jose`:

```ts
import { importPKCS8, SignJWT } from "jose";

const privateKey = await importPKCS8(process.env.HAPPY_SIGNING_KEY!, "ES256");

export async function accessToken(userId: string): Promise<string> {
    return await new SignJWT({})
        .setProtectedHeader({ alg: "ES256", kid: "happy-2026-09" })
        .setIssuer("https://sso.acme.example")
        .setAudience("https://happy.acme.example")
        .setSubject(userId)
        .setIssuedAt()
        .setExpirationTime("15m")
        .sign(privateKey);
}
```

Publish the public key as a JWKS at a stable `https` URL, include `kid` in both the key and the
token header, and rotate by publishing a new key before signing with it. Keep the old key in the
JWKS until every token it signed has expired, then remove it; the daemon stops accepting it at its
next download. Serve every endpoint over
`https`; plain `http` is accepted only on a loopback host for local testing.

## 4. Configure the daemon

Follow [Team deployment mode](../team-mode.md) to install the binary and bootstrap Tailcat, but
instead of the WorkOS settings, write the machine `happy.toml` like this:

```toml
[feature.team]
enabled = true
host = "0.0.0.0"
port = 3000
authentication = "jwt"
owner_user_id = "REPLACE_WITH_OWNER_USER_ID"

[feature.team.jwt]
name = "Acme SSO"
authorization_url = "https://sso.acme.example/oauth/authorize"
token_url = "https://sso.acme.example/oauth/token"
refresh_url = "https://sso.acme.example/oauth/refresh"
client_id = "happy"
scope = "happy offline_access"
issuer = "https://sso.acme.example"
audience = "https://happy.acme.example"
user_id_claim = "sub"
algorithms = ["ES256"]
jwks_url = "https://sso.acme.example/.well-known/jwks.json"
jwks_refresh_interval_sec = 3600
```

`name` is what the Happy app shows on the sign-in button. Leave out `refresh_url` to turn refresh
off; leave out `scope` if the server needs none. Configure exactly one key source:

- `jwks_url = "https://..."` for a published key set (recommended). The daemon downloads the keys
  itself when it starts and again every `jwks_refresh_interval_sec` seconds (60–86,400, default
  3,600), so no key is written into configuration. A token signed with a key the daemon has not
  seen yet triggers an immediate download, at most every 30 seconds, so rotations apply at once.
  If a download fails, the daemon keeps the last good keys and retries after a minute;
  a key removed from the JWKS stops working at the next successful download;
- `public_key = """-----BEGIN PUBLIC KEY-----..."""` for one PEM public key;
- `secret_env = "HAPPY_TEAM_JWT_SECRET"` for a shared secret, kept in that environment variable of
  the daemon's service and never in `happy.toml`.

Do not set `workos_organization_id`, `owner_workos_user_id`, or `workos_client_id` with JWT
authentication; the daemon refuses the combination. Configuration mistakes stop startup with a
readable message, so read the service log if the daemon does not come up.

Users are identified by the method and user ID together. A deployment that switches from WorkOS to
JWT starts with fresh member accounts; existing WorkOS users stay stored but cannot sign in through
JWT.

## 5. Verify

Run these checks from a machine that can reach the daemon, replacing `DAEMON` with its address.

1. Discovery answers without a token:

    ```sh
    curl -s "DAEMON/v0/authentication"
    ```

    Expect `"authenticated": false` and one `oauth` method with the configured endpoints and client
    ID, and no secret, key, or JWKS content.

2. Sign in from the Happy app, or test the flow by hand: open the authorization URL with a
   loopback `redirect_uri`, a `state`, and a PKCE challenge, confirm the browser lands on
   `redirect_uri?code=...&state=...`, and exchange the code at the token endpoint.
3. Call discovery with the access token and expect `"authenticated": true`. `userId` stays `null`
   until the person saves a profile.
4. Confirm that a tampered, expired, or wrong-audience token gets `401` with an `authentication`
   field listing the same method, and that a token for another audience is rejected.
5. If refresh is configured, refresh once and confirm that the new access token works and that the
   old refresh token is rejected when rotation is on.
6. Sign in as the owner in the Happy app, complete onboarding, and run the
   [deployed-node test](README.md#testing-a-deployed-node). Then sign in as a second member and
   confirm they are not the owner.

## Troubleshooting

- **The browser shows an error instead of redirecting.** The redirect URI is not registered with
  the authorization server, or the client ID is wrong.
- **The code exchange fails with `invalid_grant`.** The code expired or was already used, the
  redirect URI differs from the one used to authorize, or the server does not verify PKCE with
  S256.
- **Every access token is rejected right after startup.** The daemon could not download the JWKS:
  check that the daemon can reach `jwks_url` over `https` without a redirect, and read the service
  log for the key set warning.
- **Every access token is rejected.** Compare `iss`, `aud`, `alg`, and `kid` with the configuration
  exactly, and check the server clock. Some identity providers issue opaque access tokens unless an
  API or resource audience is requested; the daemon needs a JWT.
- **Refresh never happens.** `refresh_url` is not configured, the token response has no
  `refresh_token`, or the scope lacks `offline_access` or its equivalent.
- **Someone became the owner unexpectedly.** Owner status comes only from `owner_user_id` matching
  the token's user ID claim.

Never paste real tokens, codes, private keys, or shared secrets into a conversation, issue, or
log.
