# MCP

`McpModule` owns Happy Agent's MCP clients, transports, child processes, live connections, tools,
workspace demand, and reload lifecycle. It depends on `ConfigModule` for parsing the Happy-owned
`~/Happy/Config/mcp.toml` and workspace-root `mcp.toml` files, on `WorkspacesModule` for archival,
and on `UserInputModule` for MCP elicitation. It does not inspect or import MCP configuration from
Codex, Claude, or another model provider.

The module connects enabled user-wide stdio and Streamable HTTP servers concurrently at startup.
The first durable session in a workspace activates its workspace catalog; the last archived
session or workspace archival releases it. Identical normalized configurations share one client
and process across catalogs. A failed server is reported as failed without preventing unrelated
servers or the daemon from starting. `reload_mcp_servers` reconciles the caller's workspace by
default and the user-wide catalog with `global = true`; `configure_mcp_server` updates one
user-wide server without exposing or replacing unrelated records and then performs the same online
reconciliation.

Every MCP operation remains on the shared permission surface. Catalog and resource inspection are
intrinsically read-only but still declare the external boundary. Tool calls and prompt loading are
reviewed in Auto mode regardless of untrusted server annotations. Configuration changes and live
reloads are reviewed and request temporary Full access because they update global configuration
and start external processes or network connections.

Direct tools use `mcp__<server>__<tool>`. Protocol tools provide live tool, resource, template, and
prompt discovery. The tools hook resolves the catalog for every provider request, so a successful
online reload is visible on the next inference without restarting the daemon.
