# MCP — learnings

## Happy owns global and demand-driven workspace catalogs

Parsing MCP entries from general project or provider configuration without a client lifecycle left
servers visible in configuration but unusable by models. MCP configuration comes only from
dedicated `mcp.toml` files: one in the user's config directory and one optionally at a workspace
root. `McpModule` owns the clients, transports, child processes, failures, session demand, and
online reconciliation. Provider-specific MCP files are deliberately ignored.

Workspace demand follows the durable session lifecycle: a session created or restored in a folder
loads its catalog, and archiving its workspace releases it. The Desktop API's
archive only marks the agent archived, as the original's did, so it keeps the demand. Connections
are pooled by normalized configuration across catalogs, so identical entries share one process,
which closes after its final catalog reference disappears. User-wide entries win same-name
collisions without starting the shadowed workspace process; removing the user's entry lets the
workspace's take the name on the next reload.

Workspace `mcp.toml` is trusted project configuration and starts automatically when a session
creates demand. Tool allow and deny lists are catalog-local and do not split otherwise identical
pooled processes.

## Invalid tools are isolated from the catalog

A server's tool descriptors are untrusted independently of the connection. Each listed tool is
validated before a page is assembled; only descriptors that are invalid or outside the bounded
protocol shape are omitted, and the server keeps its healthy tools. Turning a tool into a model
tool has the same per-tool failure boundary. JSON values permit twelve nested collections; deeper
values stay excluded so validation work is finite.

## Large schemas are held by reference

TypeBox expanded the twelve-level JSON value schema at every use, so the original's schemas reach
megabytes and a tool result's alone serializes to twelve. Held as JSON values in a daemon that
would cost hundreds of megabytes. Each depth is now defined once and the schemas name it with
`{"$ref": "mcp-json-N"}`, which the module's `check` resolves. `expand` writes the references out
again, and the tests hold every expanded schema to the original's digest. The call tool's
parameters travel to providers expanded, exactly as the original sent them. Results are checked
against the full schemas inside the module before they become tool output.

## The server alone judges a direct tool's arguments

The original declared a direct tool's parameters as TypeBox `Unknown`, so its arguments were never
checked and the server alone judged them. The native agent runtime does not validate a module
tool's arguments either: the server's `inputSchema` travels to the provider as the tool's
parameters, the arguments must only be JSON, and the call goes to the server as written. The fixed
tools check their own input against the captured schemas before they act.

## The module is one agent-runtime hook set

MCP installs itself into the agent runtime from its constructor and takes only modules: config for
the catalogs and the `mcp.toml` writer, runtime for the server index, Durable Functions for its
discovery, lifecycle for the daemon's shutdown, user input for a server's questions, workspaces for
archival, and the agent runtime. Its tools are a fixed array — the server
listing, the two configuration tools, the protocol tools once a server is connected, and the
connected servers' direct tools — all deferred. A direct tool is recognized by the name it was
offered, or after a restart by its `mcp__server__tool` form. Every MCP tool requires Auto or Full
access; calls, prompts, configuration edits and reloads are reviewed, configuration edits and
reloads run with Full access because they write outside the workspace and start processes, and a
server's `readOnlyHint` is never a reason to skip review. Shutdown closes every server through the
runtime's `close` hook.

The user catalog lives only in `mcp.toml` in the configuration directory, read once at startup and
rewritten whole by `configure_mcp_server`; `happy.toml` holds no MCP servers and the public
configuration reports them from `mcp.toml`. A malformed catalog fails startup rather than silently
offering no servers.

## Discovery is owed to Durable Functions

The first port started the user catalog's discovery on a task of its own, outside any owner's
lifetime, so nothing stopped it with the daemon or remembered it was owed. Startup now invokes the
durable `mcp.discover` call, whose name is also its operation, so a discovery a stopped daemon still
owed runs once on the next start rather than twice. Durable Functions run it after the commit and
stop it with the daemon; agents wait for it before their first tool list until it settles or the
daemon begins shutting down, so no wait outlives a discovery that will not run. A failed discovery
is logged and not retried, as the original's was.

Workspace changes followed the same pattern: an after-commit listener fed an unbounded channel
drained by a task of its own. MCP now subscribes to the workspace owner's transactional events and,
inside the transaction that commits a creation or an archive, owes one row per workspace — a later
change replaces an earlier one not yet applied — plus the durable `mcp.workspaces` drain, whose name
is its operation, so every change owed while it is pending joins it. The drain applies the oldest
change first and settles each row only after it applies and only if no newer change replaced it,
then owes itself again from its settle transaction if rows remain. A rolled-back workspace change
owes nothing; a stopped daemon applies what it still owed on the next start. Storage is bounded by
the number of workspaces, and at most one drain call is ever pending.

The server index's and the owed changes' SQL lives in the module's private `persistence` folder
and runs inside the caller's transaction; the released `001-mcp-server-index` migration is
unchanged and the intents table is the new `002-mcp-workspace-intents`.

## Stdio servers never inherit the daemon's credentials

When a server's configuration set any environment variable, the original passed the daemon's whole
environment to it, provider credentials included. A stdio server now inherits only the SDK's small
safe set (`HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, `USER`) plus what its configuration sets,
whether or not it sets anything.

## A server's question can be answered

The original named an elicitation's question `mcp:<uuid>`, and the Desktop API's answer route
accepts only URL-safe identifiers, so the question showed in every client and could never be
answered. The question is named like every other identifier now. Answers return to the server
as the values its schema declared; anything that does not fit is declined.

## Configuration edits reload through the same bounded path

Model-driven global changes update one named server so unrelated records are preserved, then use
the same serialized reconciliation as an explicit reload. The reload tool reconciles the calling
workspace by default and the user catalog only with its explicit `global` flag. New connections
are prepared concurrently, unchanged pooled clients stay live, and obsolete clients close only
after the catalog swap and final-reference check. A server that stops on its own is recorded as
failed and starts again on the next reload.

Malformed workspace catalogs are isolated from global and healthy-workspace reconciliation. Their
last valid catalog stays live, a new failure is logged once, and a catalog that never loaded is
retried on later session use. Release, queued reloads, and shutdown all pass through the same
serialized lifecycle lock so stale work cannot resurrect a released process.

## A stopped listing settles as reloaded

Listing and reading tools are reloadable: a drain stops them and the next daemon runs them again.
The original made a listing stopped by its lifetime wait briefly before failing, because Agent Base
preferred a returned execution over its drain signal. The native runtime checks the drain first,
so a drained listing settles as reloaded with no delay and the module returns its error at once.

## Runner servers are not here yet

The original started a runner workspace's stdio servers on that runner and read its `mcp.toml`
there, and failed a runner's servers while it was away. MCP does not yet start anything through the
runners module: a catalog that names a runner reports that its servers cannot start there yet, and
a runner workspace's `mcp.toml` is reported unreadable rather than read from this machine.
