# Account link learnings

## The daemon decides who the owner is, on every request

The relay verifies tokens before forwarding, but the relay is a network service outside this
machine and is not trusted with the decision. Every forwarded request carries its own relay token,
and the daemon verifies it against the accounts key set before opening any local connection:
EdDSA only, a key the token names, exact issuer and audience, `typ` `relay`, this endpoint, the
stored owner account, unexpired. Only then is the caller's credential replaced with the local
owner token. A token with an `act` claim, which accounts issues to a third party such as the MCP
gateway, is refused for every method: `GET` on the owner API reads files and transcripts, so there
is no safe read-only subset without an explicit allowlist, which is a later change. The token's
expiry also bounds any stream it opened, so revoked access ends within one token lifetime.

## The credential is a file beside the daemon's other credentials

The link is one record: endpoint, owner, refresh token, and the reachable choice. It lives at
`account-link/credentials.json` in the agent home, mode `0600`, next to the local API token and
the Tailcat keys, and is replaced atomically. Keeping the reachable choice in the same record
means unlinking cannot leave a stale "reachable" behind. Writes are serialized and always write
the newest in-memory state, because a token refresh and a reachable change can overlap.

## Refresh tokens rotate and are never replayed

Accounts retires a refresh token when it issues the next one and revokes the whole family when a
retired one comes back. Concurrent callers therefore share one refresh, the replacement is stored
before the new access token is verified or used, and a failed refresh is not retried with the same
token inside one call. `invalid_grant` means the owner removed the computer: the daemon closes the
relay socket, deletes the credential, and reports itself unlinked. A refresh whose response was
lost in transit ends the same way on the next attempt; that is the cost of rotation.

## The local choice is the source of truth for reachability

`reachable` is set on this machine through an Auto-reviewed admin tool, stored locally, and pushed
to accounts with the endpoint token. The daemon attaches only while its own stored choice says so.
Accounts' copy decides only whether relay tokens are issued. Turning reachability off closes the
socket first and tells accounts second, so a failure to reach accounts cannot keep the path open.

## Unlinking revokes; only the owner deletes

Accounts lets an endpoint token change `reachable` and nothing else: deleting the account's
entry needs the owner's account token, which the daemon never holds. Unlinking therefore closes
the socket, sets `reachable` to false, and revokes the refresh family through the standard
revocation endpoint. The entry stays in the owner's device list, dead, until they remove it.

## Standalone daemons only

A verified relay caller becomes the local owner by presenting the local API token on the Unix
socket, the same API Tailcat wraps. A team server has no single owner and authenticates each
person through its identity provider, so the module reports itself unavailable there.

## A stored credential never follows a changed accounts origin

The stored record names the accounts origin it was issued by. If the configured origin differs,
the record is ignored and never sent, and the status asks for a new link.

## The relay enforces nothing after a stream opens

The relay checks a token once, at attach or when a request or stream opens, never drops an
attached socket, and has no flow control for WebSocket messages. So the daemon closes its own
socket on unlink, on reachable off, and when a refresh is refused; cuts every exchange at its
token's expiry; and bounds each stream's queue at 8 MiB in each direction, closing a stream that
falls further behind. HTTP response bodies follow the relay's credit window, because overrunning
it makes the relay close the whole computer socket.

## Replaced means wait

Close code 4000 says another daemon attached with the same link. Reconnecting at once would make
the two evict each other forever, so the connector waits at least thirty seconds and reports the
conflict in its status.

## Independent of Tailcat

Tailcat remains the accountless path and this module shares nothing with it: no settings, no
keys, no transport. Unconfigured, the module offers no tools, reads no credential, and opens no
connection, so it cannot change a Tailcat-only install.

## The relay's bytes never choose where the daemon connects

An independent review found that opening a forwarded WebSocket as `ws+unix://<socket>:<path>`
let the relay's path pick the socket: URL parsing folds `/../` before the path is split at the
colon, so `/../../tmp/evil.sock:/x` would have sent the local owner token to another socket. The
local connection is now fixed by `createConnection`, and the path is only ever a path. The same
review found that a close reason over 123 bytes threw out of the message handler. Everything the
relay sends is treated as hostile input: messages are capped at the protocol's size, a handler
error drops the socket instead of the daemon, at most 1,024 exchanges are live at once, and at
most one window of request body is held that the local API has not taken.
