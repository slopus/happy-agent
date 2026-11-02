# Remote connection learnings

## Upstream responses own their caching policy

The remote HTTP proxy replaced every upstream cache policy with no-store, defeating browser
caching even when a remote image explicitly allowed it. Forward upstream end-to-end headers
unchanged, including cache directives, validators, freshness metadata, and Vary. Once an upstream
response arrives, remove the local API's default Cache-Control before forwarding it so an absent
upstream policy also stays absent. Locally generated failures retain the API's no-store policy;
hop-by-hop headers are still stripped.

## The proxy never caps concurrency

Each connection used to refuse a request with `503 remote_busy` once 32 were active, and its HTTP
pool also capped sockets at 32. An open event stream holds its slot for as long as it lives, so
opening about eight desktop conversations at once (roughly forty parallel requests beside the
desktop's event stream) failed some of them while the remote itself was idle. The user directed
that the proxy run everything in parallel and limit nothing: every request and attachment now gets
its own carrier stream immediately, with no count limit, no queue, and no idle-socket cap beyond the
idle timeout. Per-request deadlines, response bounds on health checks, and stream backpressure
remain.

## Tunnels and upgrades never reuse a pooled connection

A browser tab on a remote agent failed with `ERR_TUNNEL_CONNECTION_FAILED` once the connection had
answered any ordinary request. The keep-alive pool handed the `CONNECT` to a socket that had already
carried a request such as the health check, and the remote's Bun front door routes a connection by
its first request: that socket belonged to its HTTP server, which never answered the tunnel. Each
upgrade and `CONNECT` now opens a fresh carrier through a separate non-pooled agent with the same
transport, while ordinary requests keep sharing the pool.

## Display order is required, durable public state

Sorting connections by ID prevented user reordering and inserted new connections into the middle
of the roster. Every connection now has a required fractional `orderKey`, backfilled by a new
migration for existing snapshots. New and re-enabled connections append after the surviving
user-chosen order. Renames and credential changes retain keys. Reordering uses the roster version
for concurrency, changes only the moved key, and publishes the complete snapshot after commit
without touching transports. A conflict returns the persisted roster, never a reconciliation
version that the rejected operation would roll back.

## Display names do not own transport lifetimes

Renaming a remote used to close its HTTP pool, active requests, and outbound Tailcat process.
Both live settings updates and durable reconciliation now exclude only the display name when
comparing connection settings. Renames persist and publish the versioned public roster while
keeping the existing pool and carrier alive. Endpoint or authentication changes and removal still
close the old connection. Each configured remote retains its own on-demand Tailcat process; this
does not introduce a shared multi-destination carrier. Tailcat replaces a failed carrier for
subsequent requests without changing the roster or replaying interrupted HTTP requests.

## Managed nodes use Tailcat and application tokens

The former invitation and emoji-verification design is not the managed-secondary workflow.
Tailcat carries encrypted bytes; team deployments authenticate WorkOS organization tokens and
standalone secondaries authenticate a fixed machine-configured bearer token. Admin bots configure
the main daemon's roster, and clients instantiate a separate client/reducer through its proxy.
Remote agent ancestry and event journals are never merged into local ones.

## Team access preserves the requesting identity

A standalone main mints a WorkOS token for its connected Cloud user and the configured destination
organization. A team main forwards its authenticated caller's token, never an owner's cached token.
The destination still verifies membership and requires its own profile onboarding.

## Endpoint health is an admin capability

Endpoint health inspection belongs to the same active-admin-bot tool surface as connection
administration. It must check authority again when executed, use the configured transport and
authentication, bound the check, and return only readiness and safe diagnostics—not credentials or
raw remote response bodies.

## Roster updates carry the complete public snapshot

An empty invalidation would force every client to fetch a list that is already bounded to 100
entries. Connection updates instead carry the complete public roster and its persisted UUIDv7
version. Reads expose that same version so delayed snapshots and duplicate events cannot replace
newer client state. Only public changes advance the version; rotating private credentials or
transport addresses does not. Reconciliation restores the projection from machine configuration
after interruption or offline edits, and notifications are published only after the snapshot commits.

## Slow proxied requests are logged with their token wait

Neither the daemon nor the desktop recorded proxy latency, so a slow Happy Core sidebar left no
timing trace. A proxied request slower than one second now logs `connections:forward:slow` at info
level with the connection ID, method, path with query names but no values, status, total, response
header, and token-wait milliseconds. Event streams, upgrades, and tunnels stay open for their
lifetime, so only their wait for response headers counts. Headers, credentials, and query values
are never logged.

## Enabled team remotes keep their tokens fresh

Connections tells Cloud which organizations its enabled team remotes mint for whenever the roster
is reconciled, changed, or closed. Cloud refreshes those cached tokens ahead of expiry so the first
request after an idle stretch does not wait on WorkOS. Team deployments forward the caller's token
and name none.

## A server connection by URL holds no token

The first design made the daemon the OAuth client: it ran PKCE, kept the refresh token in the OS
keychain (in memory when there was none), refreshed, and reported a sign-in status. Steve rejected
it. The sign-in belongs to the person's desktop, and on a headless server with no keychain, the
memory fallback forgot every sign-in on restart. Now the daemon is only a proxy. The desktop's
main process signs in and keeps the tokens in memory, and every request carries the access token
in `Happy-Remote-Authorization`. The daemon forwards it as `Authorization` and stores nothing.
There is no keychain module, no refresh, no sign-in route, and no status. Agents on the daemon
cannot reach these servers, which is accepted. The token travels only in that header, never in a
URL, including on WebSocket upgrades and CONNECT, as the customer requires.

## People add servers through the Chief of Staff

An HTTP route let the owner add and remove servers by URL, which bypassed the rule that only
machine configuration and admin bots change the roster. Steve chose the Chief of Staff instead.
`add_server_connection` checks the server's discovery before adding it, and removal is the
ordinary `remove_remote_connection`.

## A server's address is fixed for its connection ID

A security review found that `set_remote_connection` could point an existing server connection's
ID at another URL. Apps keep each person's token by connection ID, and the proxy forwards
`Happy-Remote-Authorization` to whatever URL the entry names, so the old server's token would have
gone to the new origin. A server connection's URL is now immutable. `set_remote_connection`
refuses a changed URL, a new URL entry, and any other kind of connection under an enabled server's
ID. Only `add_server_connection` creates one, after checking its discovery, under an ID nothing has
used before, since removal leaves the ID reserved. Desktop also binds its sessions to the URL, as a
second line of defense.

## A server's edge never speaks for the local daemon

A server connection by URL may sit behind a load balancer that answers with a sign-in redirect, a
bare `401`, or a non-Happy `403`. Passed through the proxy, the app would read it as its own daemon
asking it to sign in, and drop the wrong session. The pool screens those answers and replaces
them with a Happy `403 remote_sign_in_required`. The request is never replayed: the app refreshes
its own token and sends it again. A Happy `401` is checked against the server's discovery with the
same token, so the remote's profile gate still reaches the app, and a Happy `403` is an ordinary
refusal.

## Background work needs the database put back

`detach(ctx)` drops the database, so the module's own context could not save an `instanceId`
learned from a relayed health response after the request that read it had finished. The module's
root context is built with `withAgentDatabase(detach(ctx).named(...), ctx.db)`, as peer messaging
does.
