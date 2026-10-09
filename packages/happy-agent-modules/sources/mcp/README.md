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

## Runners

A stdio server is a process, and while runners are configured nothing runs on the daemon's
machine. A workspace on a runner has its `mcp.toml` read from the runner, and its stdio servers
start there as the runner's product programs, speaking MCP over their standard input and output.
The user-wide catalog's stdio servers start on the default runner. HTTP servers are always reached
from the daemon. The same configuration on two machines is two servers, so pooling never shares a
process across machines. A server whose runner goes away fails at once, naming the runner, and
a server that stopped or could not start because its runner was away starts again once that runner
connects. The module takes `RunnersModule` for the machines and `ComputeModule`
for which runner an agent's folder is on.
