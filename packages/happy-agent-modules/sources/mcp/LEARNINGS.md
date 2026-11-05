# MCP module learnings

## Model guidance uses the resolved configuration path

The user-wide tools wrote the correct file but described the macOS-only `~/Happy/Config` path
on every platform. On Linux, agents following those descriptions could not inspect or remove the
file they had just configured. Tool descriptions, parameter guidance, and review progress now
ask configuration for the actual MCP path, abbreviated relative to the user's home where possible.
This preserves custom Happy homes and native platform casing instead of maintaining another path
rule in the MCP tools. Linux guidance is covered through the real tool definitions.

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

## Bots and tasks configure their own folders

A bot's or task's folder was already a workspace catalog, because the catalog is keyed by the
agent's working directory: its root `mcp.toml` loaded at the first session and after a restart, and
reached the agents sharing that folder and no others. What was missing was a way for the agent to
write it, since `configure_mcp_server` only changed the user-wide file, so a bot had to edit the
protected file by hand. The tool now takes `scope = "folder"`, which rewrites the caller's folder
catalog through the folder's machine and reconciles only that catalog under the reload lock. The
default stays user-wide, so existing calls keep their meaning. A folder entry whose name the
user-wide catalog uses is refused instead of being written and silently shadowed. The approval
names the exact file, and the tool keeps its Auto review and temporary Full access, like editing
the protected root `mcp.toml` directly.

Bot settings do not withhold folder servers. They are the bot's own folder, shared by its own tree,
so reach settings have nothing to narrow; secrets are not involved, because a server's
configuration carries its own values. Stdio servers are processes on the host or on the folder's
runner, so they run outside a bot's Docker container, exactly as user-wide stdio servers do.

## Invalid tools are isolated from the catalog

An MCP server's tool descriptors are untrusted independently of the connection itself. Validate
each listed tool before assembling a page, omit only descriptors that are invalid or outside the
bounded protocol shape, and keep the server and its healthy tools connected. Model-facing tool
conversion has the same per-tool failure boundary, matching Codex's behavior of logging and
skipping a tool whose spec cannot be built. MCP JSON values permit twelve nested collections;
deeper values remain excluded so validation work stays finite.

## Bounded JSON schemas serialize compactly

The depth-bounded JSON value schema shares one child between its array and record branches at
each of its twelve levels. In memory that is small, but JSON serialization expands the sharing:
one direct tool's result schema was 12 million characters. Claude keyed its live query on
`JSON.stringify` of the tools, so with about sixty MCP tools every turn spent some 25 seconds of
main-thread CPU and each live session kept a 700 MB key, freezing the daemon and growing it to
gigabytes. Each level now serializes as a flat description of its collections, so the
serialized form no longer grows with depth, while TypeBox validation still walks the real levels
and enforces the bound.

## Each connection lists its tools once

An outside report (slopus/happy-desktop#78) found every MCP server receiving `tools/list` every
second or two while a few agents worked. The tools hook runs for every provider request and tool
execution, and each run listed every server twice: once for the summary's tool count and once for
its tools. The module now keeps one listing per connection, shared by every session, and loads it
single-flight. It is not bound to its caller. The tools hook and the server list never wait for
it; they use the last listing and the next request sees the new one. Only an explicit tool-page
request waits. A listing is marked stale on `notifications/tools/list_changed` and on any reload,
and is retried after it fails; a new connection starts empty.

## Nothing waits for an MCP server

Startup, an agent's restoration, and the tools hook used to await the initial reload, the folder's
catalog activation, and `tools/list`, so one slow or hanging server delayed the daemon and every
turn by up to its startup timeout (issue #87). Connecting now runs in the background: a pooled
server is `connecting` until its attempt finishes, and the attempt is adopted under the reload lock
only if the server is still wanted, so the atomic catalog swap, retries, and archival keep their
meaning. A folder's activation runs in its own lifetime, and a user-wide stdio server is shown as
`connecting` while the agent's folder, and so its machine, is still being resolved. Deliberate
reloads and `configure_mcp_server` still wait for their servers, outside the lock, because the
caller asked for the result. The price is that the first turn after a start may not have every
server's tools yet, which is better than no turn at all.

## A server that needs a login waits for a person

An HTTP server behind OAuth failed with an SDK error and was retried with backoff, and giving the
SDK an auth provider would have discovered, registered, and tried to log in on every attempt,
registering clients nobody asked for. Now a 401, or a 403 with `insufficient_scope`, from a server
with no saved login and no configured credential is `needs_auth`, with a message telling the agent
the person can ask it to log in. It is never retried; a reload, a configuration change, or a login
checks it again. Connecting only presents and refreshes a saved login. A server whose configured
`Authorization` header or bearer token is refused stays `failed`, because logging in would not fix
it.

## Logins are made for the person, through an agent

Kirill chose explicit logins: an agent calls `start_mcp_auth` only when the person asks. The
daemon is often remote, so the flow is paste-back: the redirect is `http://127.0.0.1:<port>/callback`,
the person signs in in any browser and pastes the landed address into a question only they can
answer, shown through `UserInputModule.askForPermission` with the link's real domain. A loopback
listener finishes it by itself when the browser is on the daemon's machine. The state is random
and single-use, and the code is exchanged with the PKCE verifier that never leaves the call. The
tool returns only an outcome, never tokens, codes, or the authorization server's own text, which
is untrusted.

The MCP server names its authorization server, so a hostile server could point discovery at
metadata or private addresses, or collect the API key configured for it. Discovery and
registration therefore never carry configured headers, require https (http only for a server
configured with an http loopback URL), refuse private, loopback, link-local, and metadata
addresses off the server's own host, and are bounded in time, redirects, and size.

Checking a host's addresses and then calling `fetch` with its name let the name resolve again: a
rebinding DNS answer could be public when checked and private when connected, on every redirect
too. Each hop now resolves once, with a time limit, and connects through `node:http` or
`node:https` with a lookup that answers only the checked addresses; the hostname stays the SNI and
certificate name, and no pooled socket is reused. An undici dispatcher would have done this under
Node, but Bun, which Happy Agent ships on, ignores dispatchers and resolves the name itself, while
both honour a request's `lookup`.

A login belongs to its catalog, as the person sees it: one for the user-wide servers on every
machine, and one per folder for that folder's servers. A logged-in connection is pooled within its
catalog only, so a folder never presents another folder's login. Logins live in the module's own
table, not the secrets catalog, because secrets can be attached to agents and exposed to commands.
Each login has one token presenter, so refreshes never race, and a refused refresh returns the
server to `needs_auth`. Stdio servers sign in by themselves, so the tool explains how to log in to
one outside Happy instead.

Detaching a context drops its agent database, so a login read in the module's own lifetime found
no storage and a restarted daemon forgot every login. The module keeps the database from
`beforeStart` and hands it to that lifetime deliberately.

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

## Stdio servers follow the folder's machine

MCP stdio servers used to be children of the daemon, with a workspace's `mcp.toml` read from the
daemon's disk by path. A runner workspace's path names a folder on another machine, so the daemon
would read a different file, or none, and start the server beside the database instead of beside
the code. A workspace's catalog key now includes its runner, its catalog is read through the
runner's filesystem, and its stdio servers start through the runner's product processes behind a
small stdio transport. Pool keys include the runner for stdio servers. Folders on this machine
keep the SDK's own stdio transport, because it limits the inherited environment to a safe subset,
and the daemon's environment can hold provider credentials; a runner's environment holds none.

## User-wide stdio servers start on each agent's runner

User-wide stdio servers used to start on the default runner, so with two runners an agent on the
other one used a filesystem or build server on the wrong machine, and with `default = "local"` an
agent on a runner used servers on the daemon's machine. Steve asked for MCP to run on the folder's
compute. The user-wide catalog now has one copy per machine: `global` for this machine, started
eagerly while work may run here, and `global:runner:<id>` for each runner that has an agent,
created when its first agent attaches and removed when its last one leaves. Pool keys already
include the runner, so each (server, machine) pair is one process, and a workspace's own server
with the same configuration on that runner shares it. HTTP servers are still reached from the
daemon; making `localhost` mean the runner would need a tunnel per server, which was not worth it.

## A runner's servers fail while it is away and return with it

A server's stream on a runner survives a reconnect within the runner's lease, so a request sent
while the runner was away waited up to the whole lease, stalling an agent turn for about a minute.
When the lease ran out the server was gone, yet its pooled connection stayed in place, so the server
never came back after the runner restarted. A runner that disconnects now fails its servers at
once with a message naming it and stops them; a connection that ends on its own is recorded as
failed; and the runner's return reloads every failed server.

## Failed servers come back on their own

A server that failed at startup stayed failed until someone ran `reload_mcp_servers`. In the case
that exposed this, a server hung on an expired login after a daemon restart and was marked failed
when its startup timed out. Its tools dropped out of every session, and a long-running Bedrock
session whose native tool search had found one of those tools then failed every request. Each
pooled server now keeps what it took to start it. While a catalog still uses a failed server, the
module retries it in the background, first after one second and then with the delay doubling up
to five minutes. Exactly one retry exists per server, pending or running. The attempt connects
outside the reload lock and adopts the connection only if the server is still failed and still
used. A reload that got there first, a released catalog, or shutdown closes the late connection
instead. The retry is in-memory, like the connections it restores: after a restart, the initial
reload starts every server again, so durable execution would add nothing.

## Elicitation must reach a person and nothing else

A printer server that will not start a print without a person's approval never got one: every
elicitation was declined. The request schema forbade fields outside `message` and
`requestedSchema`, and servers on the 2025-11-25 protocol always send `mode: "form"`. Even past
that, the question's ID started with `mcp:`, which the API's answer route rejects, so Desktop could
not have answered it. Only hand-built requests had been tested. Tests now drive a real SDK server's
`elicitInput` end to end, and the question takes its ID from `UserInputModule`.

What the server receives depends only on what the person did. Their answer is `accept`, Decline or
an answer the schema cannot hold is `decline`, and dismissal, a stopped turn, away, or timeout is
`cancel`. No agent tool answers a question, so the agent cannot approve its own action.

A person must know who is asking. The question carries `permissionRequest`
(`source: "mcp_elicitation"`, the server, and its display name) in the API and on the phone form,
so clients can show it as a permission request rather than the agent's own question. Only
`UserInputModule.askForPermission` sets it, so an agent cannot dress up its own question as a
server's. The server name is also in the first question's text, for clients that predate the flag.

Time a person spends answering is not charged to `tool_timeout_sec`: the SDK's timer cannot pause,
so the connection gives the SDK an unreachable timeout and keeps its own pausable deadline. The
server bounds the wait itself. When it gives up, the question is withdrawn so nobody approves a
request that no longer exists. The SDK drops a cancellation of request ID 0, which is usually a
server's first elicitation, so the connection handles `notifications/cancelled` itself.

## A bot with its own Linux user gets no shared stdio servers

Stdio servers are pooled per machine, and with `[execution]` the machine is the default workload
user's runner. A bot given a user of its own, typically one that strangers talk to, would otherwise
have driven processes running as the default user, with that user's files. Its agents now see
those servers as failed with a message naming the reason, and connecting refuses; the catalog
records which user each active agent runs as.
