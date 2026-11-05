# Add MCP servers and log in to them

Use this recipe when the user wants an agent to use an MCP server: to add one, to give a bot or task
servers of its own, to sign in to a server that needs a login, or to find out why a server's tools
are missing. [MCP servers](../MCP.md) is the reference for every `mcp.toml` setting; this recipe is
the order to do things in.

Execute the recipe end to end, as the [recipe rules](README.md) describe. Ask only for choices that
are still missing, and for the one step only the person can do: signing in in their own browser.

## 1. Resolve the choices

- **Who uses it.** A user-wide server, in `mcp.toml` in the user's configuration directory, reaches
  every session. A folder server, in `mcp.toml` at the root of a project workspace, a bot's folder,
  or a task's folder, reaches only the agents working in that folder. Prefer a folder server for
  something one bot or project needs, and a user-wide server for something everyone uses. A
  user-wide server wins when both use the same name, so a folder entry with a user-wide name is
  refused.
- **How it runs.** A stdio server is a program Happy starts (`command`), on the machine of the
  agent's folder: this machine, or the folder's runner. An HTTP server is a Streamable HTTP address
  (`url`) that Happy always reaches from the daemon's machine, so `localhost` there means the
  daemon's machine, never a runner.
- **How it signs in.** Pick the first that fits:
    1. It needs no sign-in.
    2. It takes a fixed API key or token. Put a non-secret header in `http_headers`, and a token in an
       environment variable of the daemon named by `bearer_token_env_var`, so the token stays out of
       `mcp.toml`. Happy then never logs in to that server itself.
    3. It is an HTTP server with an OAuth login. Configure only its `url`, and log in through an agent
       as step 4 describes. If the server's provider requires a client registered in advance, add
       `oauth_client_id_env_var` (and `oauth_client_secret_env_var` for a confidential client) naming
       the daemon's environment variables, and `oauth_scopes` when the provider asks for specific
       scopes.
    4. It is a stdio wrapper that signs in by itself, such as `mcp-remote`. Step 5 covers it.

## 2. Add the server

Call `configure_mcp_server` with `action = "set"`, the server's name, and its configuration. Leave
out `scope` for a user-wide server; pass `scope = "folder"` for the calling session's folder. To
give another bot or project a server, do it from an agent working in that folder, or edit that
folder's `mcp.toml` and reload it.

```json
{
    "action": "set",
    "name": "linear",
    "scope": "folder",
    "server": { "transport": "http", "url": "https://mcp.linear.app/mcp" }
}
```

```json
{
    "action": "set",
    "name": "docs",
    "server": {
        "transport": "stdio",
        "command": "node",
        "args": ["/absolute/path/to/docs-server.mjs"]
    }
}
```

The tool needs Auto or Full access; in Auto it is reviewed and runs with temporary Full access,
because it changes configuration and starts external processes or connections. Editing
`mcp.toml` by hand works too: follow it with `reload_mcp_servers`, passing `global = true` for the
user-wide file.

## 3. Check its status

Call `list_mcp_servers`. Servers start in the background, so neither startup nor a turn waits for
one, and the first turn after Happy starts may not have every server's tools yet.

| Status       | Meaning and next step                                                                                                                                                                                                  |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connecting` | Still starting. Check again shortly.                                                                                                                                                                                   |
| `connected`  | Ready. Its tools appear as `mcp__<server>__<tool>` from the next model request.                                                                                                                                        |
| `needs_auth` | An HTTP server that refused the request and has no login yet. Tell the person, and log in when they ask (step 4). It is not retried on its own.                                                                        |
| `failed`     | Could not start or stopped, with the reason. Happy retries it in the background; fix the cause from the message, such as a wrong path, a missing environment variable, or a refused configured credential, and reload. |
| `disabled`   | `enabled = false` in its `mcp.toml`.                                                                                                                                                                                   |

A server whose configured header or bearer token is refused shows as `failed`, not `needs_auth`:
change the credential in `mcp.toml` or the environment variable rather than logging in.

## 4. Log in to an HTTP server

Log in only when the person asks for it, such as "log in to Linear". Call `start_mcp_auth` with the
server's name. Like `configure_mcp_server`, it needs Auto or Full access and is reviewed in Auto.

1. Happy finds the server's authorization server, registers itself there when the server allows
   it (or uses the configured client), and prepares a one-time sign-in.
2. The person gets a question with the sign-in link. It names the domain the link opens, and only
   the person can answer it; an agent cannot.
3. The person opens the link in any browser and signs in. Their browser then goes to an address
   starting with `http://127.0.0.1:<port>/callback`. On another machine that page usually does not
   load, which is expected: they copy the whole address from the address bar and paste it as the
   answer. On the daemon's own machine, the page loads and the question closes by itself.
4. Happy checks that the address belongs to this sign-in, finishes the login, saves it, and
   reconnects the server. The tool result says only how it went: logged in, saved but the server is
   not connected yet, not needed, cancelled, or failed with a plain reason.

The login is shared by everyone using the same catalog: a user-wide server's login by every agent
using the user-wide servers, a folder server's login by the agents in that folder only. Happy keeps
it in its own database, refreshes it as it expires, and never shows a token to any agent. If the
provider revokes the login, the server goes back to `needs_auth`; log in again the same way.

`start_mcp_auth` reports `not_needed` for a server that is already connected, one with a configured
header or bearer token, or a disabled one. If the person dismisses the question, nothing is saved.

## 5. Log in to a stdio wrapper

Happy does not log in to stdio servers. A wrapper such as `mcp-remote` runs its own sign-in and
keeps its own login, so run the same command once in a terminal outside Happy, as the user and on
the machine that runs the server: this machine for a folder here, or the folder's runner. Complete
the sign-in it opens, then call `reload_mcp_servers` (with `global = true` for a user-wide server)
so the server starts with the login. `start_mcp_auth` on a stdio server explains the same.

## 6. Verify

Call `list_mcp_servers` and confirm the server is `connected` with the expected tool count. Call
one harmless tool, such as a search or a list, and confirm the result. Report any server still
`failed` or `needs_auth` with its message.

## Limits

- There is no logout tool. To stop using a login, revoke it at the provider or remove the server.
- Happy reads `bearer_token_env_var` and the OAuth client variables from the daemon's own
  environment, and a stdio server started on this machine receives that environment too. Add
  only servers the user trusts.
- Happy does not watch `mcp.toml`. After editing it by hand, reload.
