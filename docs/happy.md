# The Happy family

Happy is a family of two products, built by the same authors as Rig, that put
people in touch with the coding agents working for them. Both connect to Rig,
and both can be the thing on the other end of a conversation you are having.

- **Happy** is _end-to-end encrypted remote access to your coding agents_. A
  mobile and web client lets you watch and steer agents that are running on your
  own machine, from anywhere. The relay in the middle carries only ciphertext
  and can read nothing.
- **Happy 2** is Happy's _desktop collaborative sibling_: a self-hosted,
  Slack-like workspace where people and coding agents build together —
  conversations, files, documents, workspaces, and agents in one app, started
  with a single command and keeping all of its state on the machine that runs
  it.

They solve two halves of the same problem. Happy answers "my agent is working
on my machine and I am not at my machine." Happy 2 answers "my team and our
agents need one shared place to work." Rig is the coding-agent runtime
underneath both: Happy synchronizes your live Rig sessions to your phone, and
Happy 2 executes its agents as Rig sessions.

A naming note, because the two products share a word. In this documentation,
**Happy** always means the encrypted remote-access product, and **Happy 2**
always means the collaborative desktop workspace. Happy 2 is started with
`npx happy2` and keeps its state under `.happy2`, so its package names,
configuration keys, and paths read `happy2`. Rig's own `happy_integration`
setting and its `RIG_DISABLE_HAPPY_SYNC` environment variable belong to
**Happy**, not to Happy 2 — and Happy 2 deliberately turns that integration off
in the private Rig runtime it manages.

---

# Happy — encrypted remote access to your agents

## What it is

Happy is a mobile app (iOS and Android) and a web app that act as a remote
control for coding agents running on your own computer. You start work in a
terminal, walk away, and keep reading the transcript, answering questions,
sending new instructions, or stopping a run from your phone. Nothing about
where the agent runs changes: the agent stays on your machine, with your files,
your credentials, and your permission boundary.

The design constraint that shapes everything else is that the server in the
middle must not be able to read your work.

## Architecture

Happy has three parts:

| Part             | Where it runs                      | What it does                                                                                                             |
| ---------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Client**       | Your phone or browser              | Renders sessions, transcripts, and machines; sends messages, permission answers, and control commands.                   |
| **Relay server** | Hosted                             | Stores and routes opaque encrypted blobs, delivers realtime updates and push notifications. Holds no readable content.   |
| **CLI / daemon** | Next to the agent, on your machine | Runs or wraps the coding agent, encrypts everything before it leaves, and executes commands that arrive from the client. |

On your own machine, the Happy CLI is installed globally (`npm install -g
happy`) and used in place of the agent command — `happy claude`, `happy codex`.
It keeps local state under `~/.happy` (relocatable with `HAPPY_HOME_DIR`):
`access.key` holds the local key material, `settings.json` the profile and
onboarding state, `daemon.state.json` the background daemon's PID, control
port, and version, and `logs/` the CLI and daemon logs. The daemon is what lets
the client reach a machine when no terminal is attached: it registers the
machine, spawns sessions on request, and keeps machine state synchronized.

The relay is a Fastify server with Socket.IO for realtime, Postgres for
storage, and S3-compatible blob storage for uploads. Its API surface deals in
sessions, machines, messages, artifacts, and a key-value store — but for all of
those, the interesting fields are ciphertext it never opens.

## What "the relay sees only ciphertext" actually means

Clients encrypt before sending and decrypt after receiving. The server stores
and forwards the result as opaque strings and bytes. This covers session
metadata, session agent state, every session message, machine metadata, daemon
state, artifact headers and bodies, key-value entries, and access keys.

Two encryption variants are in use:

- **Legacy**, when a client only holds a 32-byte shared secret: NaCl secretbox
  (XSalsa20-Poly1305) with a 24-byte nonce, laid out as nonce followed by
  ciphertext and authentication tag.
- **DataKey**, when a client supports per-session and per-machine data keys:
  AES-256-GCM with a 12-byte nonce and 16-byte tag, laid out as a version byte,
  nonce, ciphertext, and tag. The content key itself is wrapped with
  NaCl-compatible X25519/XSalsa20-Poly1305 under an ephemeral keypair and
  travels as a versioned bundle
  in fields such as `dataEncryptionKey`.

Everything encrypted becomes base64 on the wire. Identifiers, versions, and
timestamps stay in plaintext, because the server has to route and order things.
Separately, and unrelated to your content, the server encrypts certain
third-party tokens at rest with a server-only key; those are not end-to-end
encrypted, and they are the server's own secrets, not yours.

Practical consequence: the operator of the relay can see that a machine exists,
that sessions exist, and roughly when they were active. They cannot see your
prompts, the model's replies, your file contents, your tool calls, or your
machine's name.

## How Rig connects to Happy

Rig speaks the Happy protocol natively. It does not wrap another CLI; a Rig
daemon registers itself as a machine and synchronizes its sessions directly.

**Turning it on and off.** Happy integration is enabled by default for the
normal Rig CLI. It is a machine-level decision: it can be switched off in the
user-wide configuration file with `happy_integration = false` under
`[settings]`, and it can be forced off for any Rig host by setting
`RIG_DISABLE_HAPPY_SYNC=1`, which overrides the configuration file.
Repository-level configuration cannot enable or disable it. Development builds
of Rig disable the synchronization by default so that local builds do not appear
as machines or mirror test sessions; `RIG_DISABLE_HAPPY_SYNC=0` opts a
development run back in.

**Credentials.** When the integration is enabled, the Rig daemon imports newer
credentials from `~/.happy` at startup, so a machine already paired with the
Happy CLI needs no extra step. To pair from Rig directly, `rig happy auth`
prints a QR code — a real PNG in terminals that support Kitty or iTerm2 image
protocols, and a compact text QR everywhere else — which you scan with the
Happy app. Rig keeps its copy of the access key, machine identity, and settings
under its own home directory, separate from the CLI's `~/.happy`.

**What Rig publishes.** Every primary Rig session you open is synchronized live.
Rig registers itself as a Rig-kind machine and publishes its display name, host,
platform, version, and the complete model catalog: each provider, each model,
its available reasoning levels and default level, its service tiers, and its
context window. It also publishes Rig's four permission modes with
human-readable names and descriptions, so the client can offer them. Session
metadata carries the live activity of a session — the current activity state,
running processes, queued and running subagents, task counts, and workflow
counts — along with the current model, provider, and the capabilities the
session supports.

**What a person can do from the app.** Send messages into a running or idle
session; attach encrypted images; answer permission requests and interactive
questions; stop the active turn; switch the session's model to any
provider-qualified model in the catalog and pick a supported reasoning level;
and ask the machine to spawn a new session in a directory, choosing the
provider, model, effort, and permission mode. Spawning in a directory that does
not exist comes back as an explicit request to approve creating it, rather than
silently creating directories on your machine.

A small set of remote procedures is also exposed against a synchronized
session, so the client can act on the machine through the agent's own
boundaries: `abort`, `bash`, `listFileTree`, `readFile`, `writeFile`, `ripgrep`, and
`communication` (the reply channel for interactive questions). These run
through the same `AgentContext`, filesystem boundary, and sandbox as the
agent's own tools — the app does not get a wider door than the agent has.

**There is no separate remote mode.** Messages that arrive from a phone enter
the same session, the same queue, and the same permission boundary as messages
typed into the terminal. You do not hand control back and forth; both surfaces
are attached to one durable session.

---

# Happy 2 — the desktop collaborative workspace

## What it is

Happy 2 is a self-hosted, Slack-like work and coding app: channels and chats,
direct messages, documents, files, activity, calls, apps and plugins, and
administration — with coding agents as first-class members of conversations
rather than a separate tool you switch to.

This page describes the **local, self-hosted** Happy 2, the only mode that
matters here: the app you start on your own machine, keeping all of its state
on that machine.

- One command starts everything: `npx happy2`, then open
  <http://127.0.0.1:3000>. Node.js 24 or later is required.
- Everything durable lives under `.happy2` in the directory where Happy 2 was
  started: the SQLite database, uploaded files, generated JWT keys and password
  pepper, plugin state, agent workspaces, and Happy 2's private Rig runtime.
- The same React application runs in a browser and in an Electron desktop app.
- `npx happy2 daemon start` and `daemon stop` run it in the background with a
  PID file and logs under `.happy2`; `npx happy2 service start` and
  `service stop` install it as a per-user macOS LaunchAgent or print the
  systemd commands for Linux.
- Configuration is a partial TOML file merged over built-in defaults, selected
  by `--config`, `HAPPY2_CONFIG`, or `./.happy2/happy2.toml`.

## Local architecture

| Piece   | Role                                                                                  |
| ------- | ------------------------------------------------------------------------------------- |
| Server  | Fastify backend: authentication, SQLite persistence, files, realtime, agent execution |
| State   | Framework-independent client state; immutable snapshots plus realtime reconciliation  |
| UI      | Reusable design system and component workbench                                        |
| App     | The React product, shared by web and desktop                                          |
| Web     | Browser entry point and production web build                                          |
| Desktop | Electron app that supervises child processes and hosts the Rig surface                |

The all-in-one executable starts the API on an ephemeral loopback port, serves
the packaged single-page app on the configured public port, and proxies the API
internally, so the browser talks to one origin for HTTP, uploads, and
server-sent events. All useful HTTP endpoints live under a `/v0` prefix; `/` is
only a small status response. Server APIs use GET and POST only, and POST paths
name explicit actions rather than CRUD verbs.

## How Happy 2 uses Rig

Happy 2 drives Rig in **two separate ways**. They are easy to confuse, so keep
them apart:

1. **Server-side agent execution.** The Happy 2 server starts and owns a
   private, bundled Rig daemon and creates one Rig session per agent
   conversation. This is how an agent that is a member of a channel actually
   thinks and works.
2. **The desktop Rig surface.** The Electron app connects to a Rig daemon _you_
   already run yourself and shows its projects, sessions, transcripts, files,
   and terminals inside Happy 2.

### 1. The private Rig runtime that executes agent turns

An `[agents]` table configures this path — whether it is enabled, the daemon
socket and token paths, the Rig command, and the default working directory for
agent workspaces. Its defaults point at a private Rig runtime under
`.happy2/rig`, with workspaces under `.happy2/workspaces`.

What follows from the implementation:

- Happy 2 starts the Rig executable **installed with its own server package**,
  never a global `rig` binary, with `RIG_HOME` pointing at `.happy2/rig`. That
  home holds the runtime's configuration, settings, session state, socket, and
  token.
- Every Rig process Happy 2 starts receives `RIG_DISABLE_HAPPY_SYNC=1`, so this
  private runtime never appears as a machine in Happy's encrypted mobile sync.
- The daemon mode defaults to _managed_: Happy 2 writes an exact internal
  runtime configuration (durable global event queue on, Happy integration off),
  hashes it, checks the running daemon's version, replaces the daemon when
  either drifts, and stops it during shutdown. A separately supervised
  deployment may instead run _attached_, in which case Happy 2 neither rewrites
  nor stops the daemon.
- Happy 2 talks to the daemon over its Unix socket using the token file beside
  it, and enables the durable global event queue so it can follow one global
  event stream with a cursor and trim it periodically.

**One Rig session per agent conversation.** When an agent must answer in a
chat, Happy 2 resolves or creates a binding of (chat, agent) to a Rig session:

- A per-agent sandbox directory pair is created under the configured agent
  working directory, and an OCI container (Docker or Podman) is created from
  that agent's image, with the workspace bind-mounted at `/workspace` and the
  agent home at `/home`.
- The Rig session is created against that existing container with
  `/workspace` as the working directory, the chat's model, and the agent's
  effort.
- Child channels reuse their parent conversation's container and working
  directory, so related channels share one environment; their images must
  match.
- Sessions are created with the `full_access` permission mode. That is
  deliberate: the agent is already confined by a dedicated container sandbox,
  and Happy 2's durable external functions require it. **Full access here means
  "no extra Rig-side sandbox inside an already sandboxed container", not "free
  rein on the user's machine".**
- Per-agent and per-channel secrets are registered with Rig and reconciled onto
  the session, so environment values are attached and detached as bindings
  change.

**Turns.** Messages addressed to agents become durable turns that Happy 2
drains one at a time per chat. A channel has a default agent and may address
additional agent members; a direct message can only address its own agent.
Happy 2 submits the prompt to Rig together with the external tool definitions
and durable skills contributed by installed plugins, streams the agent-loop
events back out of the global event stream, and turns them into Happy 2
messages, typing indicators, live activity (phase, tool names, subagents,
background terminals, token counts), and a final reply. Steering delivers new
user text into a running turn; stopping a run ends it in Rig and releases the
worker lease.

**Terminals and previews.** Happy 2 can open Rig remote terminals inside the
agent's container and attach them to the app over WebSocket. Optional
port-sharing configuration publishes a range of container ports through a
wildcard preview domain with per-share audiences.

### 2. The desktop Rig surface

The Electron app also acts as a Rig client for the Rig you installed yourself:

- The main process discovers the `rig` command through your login-shell
  environment, resolves the daemon socket and token, and refuses to connect
  when the running daemon's version does not match the installed command.
- It proxies that daemon connection to the renderer, which uses Rig's client
  library to keep the transcript, session list, model catalog, inbox, provider
  usage, changed files, and terminals live.
- This is a normal Rig daemon on your machine: your projects, your workspaces,
  your credentials. It is _not_ the private Rig runtime described above.

**Remote Rigs are in progress.** A prototype in the desktop main process
reaches another machine over OpenSSH: it asks the machine for its default
daemon socket and token with one fixed command, forwards that Unix socket to a
private local one, and then speaks the ordinary daemon protocol over it, so a
remote daemon looks identical to a local one above the connection boundary. The
intended destination is that a remote Rig is added by naming a machine the way
you already reach it over SSH, its projects appear in the sidebar beside local
ones, Connect and Disconnect work on demand, a disconnected Rig degrades
cleanly, and no application code above the connection layer branches on remote
versus local. Treat that polished experience as **planned**; the SSH transport
exists today.

## Files and documents

- **Files** are stored by the server under `.happy2/files` with signed URLs,
  quotas, optional malware scanning, and resumable uploads. A chat's workspace
  files are reachable through dedicated workspace endpoints.
- **Documents** exist today as server-owned collaborative documents with a
  Documents tab, presence, attach and detach to chats, and an approval flow for
  write requests, exercised by a built-in documents plugin.
- **Planned:** moving document ownership to the Rig instance rather than to
  projects, so each connected Rig exposes its own Documents tab and local
  collection stored in a defined folder on that machine, every saved document
  keeps a normalized Markdown file beside its collaborative state, a document
  can be attached to a session without being owned by it, and agent edits enter
  as versioned changes rather than replacing the collaborative state. A later
  step would synchronize documents between Rigs through an encrypted relay that
  never owns the data.
- **Planned:** a unified set of file surfaces — Changed files, All files, and an
  in-app preview component for images, video, and Markdown, reused wherever a
  file or link is opened.

---

# What an agent under Rig should know

## When your session is driven through Happy

Your execution does not change. You are an ordinary local Rig session with your
normal permission mode, working directory, and sandbox. What changes is who is
watching and who can interrupt:

- **A person may be reading along from a phone.** Your text blocks, tool calls,
  and activity are mirrored live. Write as if someone is following on a small
  screen away from their desk.
- **Messages can arrive from anywhere.** A message sent from the app enters the
  same session and the same queue as terminal input; there is no separate
  remote mode and no reduced boundary. Steering and stopping mid-turn are
  normal outcomes, not failures.
- **Permission answers and question answers may come from the app.** A reply to
  an interactive question is a trusted user answer regardless of which surface
  it came from.
- **The model or reasoning level may change under you.** A person can switch
  the session's model and effort from the app. Do not assume the model that
  answered last time.
- **Your content is encrypted end to end, but it is still leaving the
  machine.** Session content is encrypted before it goes to the relay and the
  relay cannot read it. That is not a reason to treat the transcript as
  private-by-default: it is a normal conversation with a person who may be
  anywhere.

## When your session is driven through Happy 2

If your session was created by the Happy 2 server, your environment is
different in ways that matter:

- **You are inside a container.** Your working directory is `/workspace` and
  `HOME` is `/home`, both bind-mounted from the host's agent workspace tree.
  You are not in the user's own repository checkout unless someone put it
  there.
- **Your permission mode is `full_access` by design.** The container is the
  security boundary, not Rig's sandbox. Being unsandboxed inside it is not an
  invitation to act outside the task you were asked to do; behave as carefully
  as you would in Auto mode.
- **Your conversation is a chat.** Your reply becomes a message in a channel or
  direct message that people and possibly other agents read. Your text blocks,
  tool calls, subagents, and background terminals are surfaced live, so partial
  work is visible while you are still working.
- **Extra tools may appear.** Happy 2 contributes plugin functions as external
  tools and plugin skills as durable skills for the turn. It executes them on
  the host side and returns their results; they are bound to the current turn
  and the current chat.
- **Turns are queued and steerable.** New user messages can be delivered into a
  running turn, and a reader can stop your run at any time. A stopped or steered
  turn is a normal outcome.
- **Secrets are attached, not discoverable.** Agent- and channel-scoped secrets
  are attached to your session. Use them through the mechanisms Rig exposes; do
  not go looking for credential stores.
- **Model and effort are chosen by the chat.** They are set and reconciled from
  the chat and agent configuration.
- **Rig's bundled documentation may not be mounted.** Rig exposes these pages at
  `/happy/docs` only in containers it creates itself. Happy 2 supplies its own
  container, so that path is generally absent there; read documentation from
  the workspace or ask, instead of assuming the path exists.

If instead you are an ordinary local Rig session that the Happy 2 **desktop
app** is displaying, nothing about your execution changes either. Happy 2 is
only a client watching the same daemon your terminal uses, so a person may be
reading along, sending messages, switching your model, or stopping your run
from a window you never see.

## Related pages

- [architecture.md](architecture.md) — how Rig itself is put together: daemon,
  protocol, sessions, providers, persistence.
- [permissions-and-sandbox.md](permissions-and-sandbox.md) — the permission
  modes referenced above and how review and escalation actually work.
- [agents-and-collaboration.md](agents-and-collaboration.md) — subagents,
  messaging between agents, scheduling, and durable waits.
- [extending.md](extending.md) — plugins, skills, MCP servers, and building on
  Rig from the inside.
