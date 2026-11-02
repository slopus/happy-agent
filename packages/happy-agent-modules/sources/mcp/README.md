# MCP

`McpModule` owns Happy Agent's MCP clients, transports, child processes, live connections, tools,
workspace demand, and reload lifecycle. It depends on `ConfigModule` for parsing the Happy-owned
user-wide `mcp.toml` (`~/Happy/Config` on macOS, `~/happy/config` on Linux, or
`%USERPROFILE%\happy\config` on Windows) and workspace-root `mcp.toml` files, on `WorkspacesModule`
for archival, and on `UserInputModule` for MCP elicitation. It does not inspect or import MCP
configuration from Codex, Claude, or another model provider.

The module connects enabled user-wide stdio and Streamable HTTP servers concurrently at startup.
A workspace catalog is the root `mcp.toml` of an agent's working directory, so a project workspace,
a bot's folder, and a task's folder each have one, shared by every agent working there. The first
durable session in a folder activates its catalog; the last archived session or workspace archival
releases it. Identical normalized configurations share one client
and process across catalogs. A failed server is reported as failed without preventing unrelated
servers or the daemon from starting. A server that fails to start, or stops later, is started again
in the background while any catalog still uses it: first after one second, then with the delay
doubling up to five minutes. A retry runs outside every request and reload, so a slow server never
delays a turn. `reload_mcp_servers` reconciles the caller's workspace by
default and the user-wide catalog with `global = true`; `configure_mcp_server` updates one
user-wide server, or with `scope = "folder"` one server in the caller's folder catalog, without
exposing or replacing unrelated records and then performs the same online reconciliation of that
catalog.

Every MCP operation remains on the shared permission surface. Catalog and resource inspection are
intrinsically read-only but still declare the external boundary. Tool calls and prompt loading are
reviewed in Auto mode regardless of untrusted server annotations. Configuration changes and live
reloads are reviewed and request temporary Full access because they update user-wide or folder
configuration and start external processes or network connections.

## Elicitation

Every connection advertises form elicitation. A server's `elicitation/create` during a tool call
becomes a question on the calling agent through `UserInputModule.askForPermission`, so every
client that shows questions shows it, and its `permissionRequest` marks it as the server's request
rather than the agent's. The context and the first question also name the server, for clients that
ignore the flag. A request with no fields is an Approve/Decline question; boolean, enum,
string, and number fields become one question each, at most four. Only the person's answer is
returned: choosing Decline or giving an answer the schema cannot hold is `decline`, and anything
that ends the question without an answer is `cancel`. A request outside a tool call, or one the
question surface cannot show faithfully, is declined without asking.

A tool call's `tool_timeout_sec` stands still while a person is answering. When the server
withdraws its request, the connection ends, or the turn stops, the question is withdrawn too.

Direct tools use `mcp__<server>__<tool>`. Protocol tools provide live tool, resource, template, and
prompt discovery. The tools hook resolves the catalog for every provider request, so a successful
online reload is visible on the next inference without restarting the daemon.

## Runners

A stdio server is a process, and while runners are configured nothing runs on the daemon's
machine. A workspace on a runner has its `mcp.toml` read from the runner, and its stdio servers
start there as the runner's product programs, speaking MCP over their standard input and output.
The user-wide catalog's stdio servers start on the machine of the agent's folder: on this machine
for agents here, and once on each runner that has an agent, shared by every agent on it and stopped
when the last one leaves. While a runner is the default nothing runs here, so the user-wide stdio
servers start only on runners. HTTP servers are always reached from the daemon, so a `localhost`
or `127.0.0.1` URL names a server on the daemon's machine, never one on the agent's runner; a
service on a runner is reached by a stdio server there or by an address the daemon can route to. The same configuration on two machines is two servers, so pooling never shares a
process across machines. A server whose runner goes away fails at once, naming the runner, and
a server that stopped or could not start because its runner was away starts again once that runner
connects. The module takes `RunnersModule` for the machines and `ComputeModule`
for which runner an agent's folder is on.

When work runs as a separate Linux user, stdio servers start through that user's local runner
like a runner's. Only the default user has one product machine, so an agent of a bot that runs as
a user of its own sees the user-wide and workspace stdio servers as failed, with a message saying
why, rather than reaching processes that run as another user. HTTP servers are unaffected.
