# MCP servers

Happy Agent can connect to local MCP processes over stdio and to remote MCP services over
Streamable HTTP. Every model uses the same Happy-owned server catalog, connection lifecycle, and
permission model.

## Configuration file

Configure servers in:

```text
~/Happy/Config/mcp.toml
```

Happy Agent creates this file with commented examples when it initializes the user configuration
directory. It is the only source for configured MCP servers. Entries in a project's `happy.toml`,
Codex configuration, Claude configuration, or another provider's files are intentionally ignored.

Each table below `[mcp_servers]` defines one server. The table name is the server's display name and
may be quoted when it contains spaces.

## Local stdio server

Use `command` for a process that speaks MCP over stdin and stdout:

```toml
[mcp_servers.local_docs]
command = "node"
args = ["/absolute/path/to/docs-server.mjs", "--stdio"]
cwd = "/absolute/working/directory"
env = { DOCS_ROOT = "/absolute/path/to/docs" }
enabled = true
startup_timeout_sec = 10
tool_timeout_sec = 30
```

`command` may be an absolute executable path or a command available in Happy Agent's environment.
Use absolute paths for script arguments and `cwd` when the daemon's working directory should not
matter. The process stays owned by Happy Agent and is stopped when the server is replaced, removed,
or the daemon shuts down.

## Remote HTTP server

Use `url` for a Streamable HTTP endpoint:

```toml
[mcp_servers.remote_docs]
url = "https://mcp.example.com/mcp"
http_headers = { "X-Client" = "Happy Agent" }
bearer_token_env_var = "MCP_BEARER_TOKEN"
enabled = true
startup_timeout_sec = 10
tool_timeout_sec = 30
```

`bearer_token_env_var` names an environment variable; its value is read by Happy Agent and sent as
an `Authorization: Bearer ...` header. This keeps the token itself out of `mcp.toml`. Static headers
belong in `http_headers`.

Interactive MCP OAuth is not currently supported. Configure static headers or a bearer-token
environment variable for authenticated HTTP servers.

## Available settings

| Setting                | Applies to | Meaning                                                                              |
| ---------------------- | ---------- | ------------------------------------------------------------------------------------ |
| `command`              | stdio      | Executable to start. A server must have exactly one of `command` or `url`.           |
| `args`                 | stdio      | Arguments passed to the executable.                                                  |
| `cwd`                  | stdio      | Working directory inherited by the server process.                                   |
| `env`                  | stdio      | Additional environment variables for the process.                                    |
| `url`                  | HTTP       | Streamable HTTP MCP endpoint.                                                        |
| `http_headers`         | HTTP       | Static request headers.                                                              |
| `bearer_token_env_var` | HTTP       | Environment variable containing a bearer token.                                      |
| `enabled`              | both       | Set to `false` to retain the entry without connecting it. Defaults to enabled.       |
| `startup_timeout_sec`  | both       | Connection timeout in seconds, greater than zero and at most 600. Defaults to 10.    |
| `tool_timeout_sec`     | both       | Per-operation timeout in seconds, greater than zero and at most 600. Defaults to 60. |
| `enabled_tools`        | both       | When present, only these named tools are available.                                  |
| `disabled_tools`       | both       | Tools to hide. A disabled tool remains hidden even if it is also enabled.            |

## Reloading without restarting

After editing `mcp.toml`, ask the agent to reload the MCP servers. Models can call
`reload_mcp_servers`, which rereads the file, prepares enabled connections concurrently, swaps the
live catalog, and closes the old connections. The next model inference sees the updated tool list.

Models can also call `configure_mcp_server` to add, replace, or remove one named entry. The update
preserves unrelated servers, writes `mcp.toml` atomically, and performs the same online reload.

Both operations require Auto or Full access. In Auto they are reviewed and receive temporary Full
access because they may update global configuration, start local processes, or connect to remote
services.

## Using MCP capabilities

Connected server tools appear as:

```text
mcp__<normalized-server-name>__<tool-name>
```

Happy Agent also exposes protocol tools for discovering resources, resource templates, and prompts.
MCP operations are available only in Auto or Full access because an MCP server can act outside the
local filesystem sandbox. Every MCP tool call and prompt load is reviewed in Auto; server-provided
annotations such as `readOnlyHint` are metadata, not authorization.

A server that fails to connect is reported as failed without preventing other servers from loading.
Common causes are an unavailable command, a relative script path resolved from the wrong directory,
a missing bearer-token environment variable, an unreachable URL, or a startup timeout that is too
short.

When troubleshooting, first confirm the entry is in `~/Happy/Config/mcp.toml`, then ask the agent to
reload and list the MCP servers. The resulting server status includes an isolated connection error
for each failed entry.
