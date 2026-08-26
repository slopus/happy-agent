# MCP module learnings

## Happy owns global and demand-driven workspace catalogs

Parsing MCP entries from general project or provider configuration without installing a production
client lifecycle left servers visible in configuration but unusable by models. MCP configuration
now comes from dedicated `mcp.toml` files: one in the user's config directory and one optionally at
a workspace root. `McpModule` owns SDK clients, transports, child processes, failures, session
demand, and online reconciliation. Provider-specific MCP files are deliberately ignored.

Workspace demand follows durable session lifecycle. The first session in a workspace loads its
catalog; the last archived session releases it, and workspace archival releases it immediately.
Connections are pooled by normalized server configuration across catalogs, so identical entries
share one process and close only after their final catalog reference disappears. User-wide entries
win same-name collisions without starting the shadowed workspace process.

Workspace `mcp.toml` is intentionally treated as trusted project configuration and starts
automatically when a durable session creates demand. Tool allow/deny policy is catalog-local and
does not split otherwise identical pooled processes.

## Invalid tools are isolated from the catalog

An MCP server's tool descriptors are untrusted independently of the connection itself. Validate
each listed tool before assembling a page, omit only descriptors that are invalid or outside the
bounded protocol shape, and keep the server and its healthy tools connected. Model-facing tool
conversion has the same per-tool failure boundary, matching Codex's behavior of logging and
skipping a tool whose spec cannot be built. MCP JSON values permit twelve nested collections;
deeper values remain excluded so validation work stays finite.

## Configuration edits reload through the same bounded path

Model-driven global changes update one named server so unrelated records are preserved, then use
the same serialized reconciliation path as an explicit reload. The reload tool reconciles the
calling workspace by default and the user catalog only with its explicit global flag. New
connections are prepared concurrently, unchanged pooled clients stay live, and obsolete clients
close only after the catalog swap and final-reference check.

Malformed workspace catalogs are isolated from global and healthy-workspace reconciliation. Their
last valid catalog remains live, a new failure is logged once, and a catalog that has never loaded
is retried on later session use. Archival, path reuse, queued reloads, and shutdown all pass through
the same serialized lifecycle boundary so stale work cannot resurrect a released process.
