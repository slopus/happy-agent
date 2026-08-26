# MCP

`McpModule` owns Happy Agent's MCP clients, transports, child processes, live connections, tools,
and reload lifecycle. It depends on `ConfigModule` for the Happy-owned
`~/Happy/Config/mcp.toml` path and parsed server records, and on `UserInputModule` for MCP
elicitation. It does not inspect or import MCP configuration from Codex, Claude, or another model
provider.

The module connects enabled stdio and Streamable HTTP servers concurrently at startup. A failed
server is reported as failed without preventing unrelated servers or the daemon from starting.
`reload_mcp_servers` rereads `mcp.toml` and atomically swaps the live connection catalog;
`configure_mcp_server` updates one server without exposing or replacing unrelated records and then
performs the same online reload.

Every MCP operation remains on the shared permission surface. Catalog and resource inspection are
intrinsically read-only but still declare the external boundary. Tool calls and prompt loading are
reviewed in Auto mode regardless of untrusted server annotations. Configuration changes and live
reloads are reviewed and request temporary Full access because they update global configuration
and start external processes or network connections.

Direct tools use `mcp__<server>__<tool>`. Protocol tools provide live tool, resource, template, and
prompt discovery. The tools hook resolves the catalog for every provider request, so a successful
online reload is visible on the next inference without restarting the daemon.
