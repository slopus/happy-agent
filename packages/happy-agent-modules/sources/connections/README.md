# Remote connections

`ConnectionsModule` owns the configured roster, active-admin-only tools, and reusable HTTP pools.
Configuration owns private machine settings, Cloud owns WorkOS refresh rotation, and Tailcat owns
the encrypted carrier processes. No remote credential reaches a roster response.

`client.connection(id)` → main API authentication → connection pool → Tailcat → remote API authentication

Set `[connections.<id>]` in machine `happy.toml`, or use `set_remote_connection` from an active admin
bot after deploying the remote. Supply `name`, `address`, optional `port`, and exactly one of `token`
or `workos_organization_id`. Configure a standalone remote's matching fixed token under `[api]` and
enable `[feature.tailcat]` on that remote. Team remotes use their existing WorkOS deployment settings.

HTTP pools open one Tailcat carrier per configured remote on demand and retain it for reuse. A
connection does not cap concurrency: every request and attachment opens or reuses its own carrier
stream at once, and idle streams stay warm until they time out. Display-name changes preserve the
pool, carrier, and active requests. Endpoint or authentication changes and removal close active work
without deleting any remote data. Durable Functions reconcile persisted configuration after restart; no request or
mutation is replayed by the proxy. SSE, upgrades, and CONNECT remain remote-owned streams.
Requests slower than one second log `connections:forward:slow` with safe timing fields, including
the time spent waiting for the remote's token. Standalone mains ask Cloud to refresh the team
tokens of enabled WorkOS remotes ahead of expiry.

The public roster is also a single bounded persisted snapshot. `getSnapshot(ctx)` reconciles it
with configuration in the caller's transaction, retains its version for unchanged public data,
and publishes `onUpdated` after commit. The API forwards that exact `{ connections, version }`
snapshot as `connections.updated`; clients keep the greater version across list reads and events.
Startup and durable reconciliation recover offline edits without exposing private configuration.

Every public entry carries a required fractional `orderKey`. Migration backfills existing entries
in their prior ID order. `list(ctx)` and admin tools read the same durable ordered snapshot;
new and re-enabled entries append, while replacements preserve their key. `reorder(ctx, id,
afterId, expectedVersion, mutationId?)` moves one entry after a neighbour (`null` means first).
It composes with the caller's transaction, rejects stale roster versions, preserves neighbour
keys, and emits nothing for a no-op. Notifications carry an optional explicit mutation echo,
so background reconciliation never inherits a request's identity. Reordering never changes
private configuration or opens, closes, or replaces a remote transport.

A server connection by URL (`[connections.<id>] url`) reaches a team server over HTTPS instead of
Tailcat, in standalone mode only. A person adds one by asking an active admin bot, such as the
Chief of Staff: `add_server_connection { url, name? }` normalizes the URL, refuses it unless the
server's discovery, read without a credential, is a Happy response that offers an `oauth` method,
generates the ID from the host, and saves the entry in generated `runtime.toml`.
`remove_remote_connection` removes it like any other entry. No HTTP route adds or removes one.
Its address never changes: `set_remote_connection` may rename it but refuses a different URL, a
new URL entry, or another kind of connection under its ID while it is enabled. Removal keeps the ID
reserved, so adding the server again, or another one, yields a new ID.

The daemon holds no credential for these servers. Each request through the proxy carries the
person's own access token in `Happy-Remote-Authorization`, which the app keeps; the pool strips
that header from every forwarded request and sends the token to the server's own host and path
prefix as `Authorization: Bearer`, following no redirects. A request without it is answered
`403 remote_sign_in_required` without contacting the server, so agents on this daemon cannot use
these servers. Every redirect, `401`, and `403` is screened with the sign-in rule: an edge answer
becomes `403 remote_sign_in_required`, a Happy `401` whose token discovery still accepts passes
through as the profile gate, and a Happy `403` passes through. Nothing is refreshed or replayed;
the app refreshes and sends its request again. Event streams end after 45 silent seconds; proxied
WebSockets are pinged between frames every 15 seconds and closed with 1011 after 45 silent
seconds. `CONNECT` is carried over the server's WebSocket twin, or refused with `501` when its
health does not advertise twins. Every health response a pool relays teaches the roster the
remote's `instanceId`.

`check_remote_connection_health` is also restricted to active admin bots, including an execution-time
check. It checks the configured endpoint through the same pool with a 30-second deadline and a
64 KiB response bound. Team health checks require a connected Cloud user with access to the target
organization; the tool cannot impersonate a team owner or borrow an unrelated client's token.
