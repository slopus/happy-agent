# Remote connections

`ConnectionsModule` owns the configured roster, active-admin-only tools, and bounded HTTP pools.
Configuration owns private machine settings, Cloud owns WorkOS refresh rotation, and Tailcat owns
the encrypted carrier processes. No remote credential reaches a roster response.

`client.connection(id)` → main API authentication → connection pool → Tailcat → remote API authentication

Set `[connections.<id>]` in machine `happy.toml`, or use `set_remote_connection` from an active admin
bot after deploying the remote. Supply `name`, `address`, optional `port`, and exactly one of `token`
or `workos_organization_id`. Configure a standalone remote's matching fixed token under `[api]` and
enable `[feature.tailcat]` on that remote. Team remotes use their existing WorkOS deployment settings.

HTTP pools open one Tailcat carrier per configured remote on demand and retain it for reuse. Each
connection allows 32 active requests and four idle sockets. Display-name changes preserve the pool,
carrier, and active requests. Endpoint or authentication changes and removal close active work
without deleting any remote data. Durable Functions reconcile persisted configuration after restart; no request or
mutation is replayed by the proxy. SSE, upgrades, and CONNECT remain remote-owned streams.

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

`check_remote_connection_health` is also restricted to active admin bots, including an execution-time
check. It checks the configured endpoint through the same pool with a 30-second deadline and a
64 KiB response bound. Team health checks require a connected Cloud user with access to the target
organization; the tool cannot impersonate a team owner or borrow an unrelated client's token.
