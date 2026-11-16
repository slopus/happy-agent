# Happy account link and relay reachability

A standalone Happy Agent can be linked to one Happy account. While its owner marks it reachable,
the daemon keeps one outbound connection to the Happy Relay, and the owner's apps reach the Happy
Agent API through that relay from anywhere. Nothing listens on the computer, and no inbound port
or address has to be shared.

This is an additional, opt-in, account-based path beside [Tailcat](tailcat.md). Tailcat stays the
accountless way to reach a daemon and is unchanged: either can be on without the other, and
neither reads the other's settings or credentials. The account link is also separate from Happy
teams and from the WorkOS sign-in. It is off unless the machine configuration turns it on, a
configured computer is not linked until someone asks, and a linked computer is not reachable
until someone asks for that too.

> End-to-end sealing between the client and the daemon is not implemented yet. The relay
> terminates TLS and can read forwarded requests and responses, including the relay token of each
> request. Sealing is a required follow-up before production use. Until then, point this feature
> only at a relay you operate.

## Configure

Add both origins to the machine-wide `happy.toml`, then start or
[reload](configuration.md#applying-configuration-changes) Happy Agent:

```toml
[feature.account_link]
enabled = true
accounts_url = "https://accounts.example.com"
relay_url = "https://relay.accounts.example.com"
```

Each value is an origin: HTTPS, no path. Plain HTTP is accepted only for a loopback address, for
local development. Neither origin has a default. A repository's `happy.toml` cannot set this
section. A team server cannot be linked: only personal, account-owned computers are supported.

## Link, make reachable, unlink

Ask the active admin bot, initially the built-in Chief of Staff. With the feature configured,
admin bots receive four tools. Ordinary bots, archived admin bots, human-owned root agents, and
subagents do not.

- `link_happy_account` starts an OAuth device grant and returns a short code with a URL. Open the
  URL in a browser signed in to the Happy account and confirm the code. The account that approves
  becomes the computer's owner. A code is valid for ten minutes.
- `get_happy_account_status` reports whether the computer is unlinked, waiting for approval, or
  linked, and whether the relay connection is up.
- `set_happy_account_reachable` turns relay reachability on or off. The choice is stored and
  survives restarts. Turning it off closes the relay connection at once.
- `unlink_happy_account` closes the relay connection, marks the computer unreachable and revokes
  its credential at accounts, deletes the stored credential, and cancels a code that is still
  waiting. The computer stays in the account's device list, unreachable, until the owner removes
  it there: only the account can delete its own entry.

Linking, changing reachability, and unlinking are internet-exposure actions. In Auto permission
mode, Happy Agent reviews the exact operation before the admin bot's tool runs, as it does for
`set_tailcat_enabled`.

## What is stored

`~/.happy/agent/account-link/credentials.json`, readable only by the daemon's user, holds the
endpoint ID, the owner's account ID, the reachable choice, and a refresh token. Accounts rotates
the refresh token on every use, and Happy Agent stores the replacement before using the new access
token. A daemon that stays linked renews it daily. Do not copy this file to another computer:
presenting a rotated-out refresh token revokes the link.

If the owner removes the computer from the account, the next renewal fails, the daemon closes its
relay connection, deletes the credential, and reports itself unlinked.

## Who can reach a reachable computer

The relay forwards a request only with a relay token, which accounts issues only to the owner and
only while the computer is marked reachable. The daemon does not rely on that. It verifies every
forwarded request itself against the accounts signing keys before the request touches the API:

- the signature is EdDSA, by a key the accounts key set publishes and the token names;
- the issuer is the configured accounts origin and the audience is this computer's relay address;
- the token is a relay token, for this endpoint, for the owning account, and has not expired;
- the token was not issued to a third party on the owner's behalf.

A request without such a token is refused: `401` when the token is missing, malformed, forged, or
expired, `403` when it is a genuine token for another account, endpoint, or purpose, and `503`
when the signing keys cannot be fetched. A verified caller acts as the local owner, with the same
API a local client has.

The relay checks a token only when a request or stream opens, and it never drops an attached
daemon. The daemon therefore enforces the rest itself:

- A response or WebSocket that is still open when its token expires is closed (a WebSocket with
  code `4401`), so a client reconnects with a fresh token and revoked access ends within the
  token's fifteen minutes.
- The daemon closes its own relay connection when reachability is turned off, on unlink, and when
  accounts refuses its refresh token, for example after "sign out everywhere".
- The relay has no flow control for WebSocket messages. The daemon queues at most 8 MiB per
  stream in each direction and closes a stream whose client falls further behind (code `4408`).
  HTTP bodies use the relay's credit windows.

One daemon is attached per linked computer. If a second daemon attaches with the same link, the
relay replaces the first, which then waits at least thirty seconds before trying again.

Access for third-party MCP clients through the Happy MCP gateway is not enabled for local agents
yet: tokens issued on the owner's behalf are refused.

## Troubleshooting

- `get_happy_account_status` reporting "connecting" with an error means the relay or accounts
  could not be reached. The daemon retries with backoff, from one second up to one minute.
- A client receiving `503` with `endpoint_offline` from the relay means the daemon is not
  attached: it is stopped, offline, or not marked reachable.
- After changing `accounts_url`, a credential from the previous service is never sent to the new
  one. The status says so; unlink and link again.
