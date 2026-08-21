# Integration API

Happy Agent can expose integration-owned functions and skill instructions to a model
without installing their implementations or source files in the daemon.
Requests are stored in SQLite before they are published, remain pending across
daemon restarts, and are completed through a separate authenticated HTTP request.

## Happy mobile synchronization

Happy synchronization is an explicit daemon feature. Happy Agent's CLI starts
`runLocalProtocolServer` with `happyIntegration: "enabled"`. Library embedders
may pass `happyIntegration: "disabled"`; omission is also fail-closed and means
disabled. The user-wide `[settings] happy_integration` config value is a second
gate and defaults to `true`; setting it to `false` disables Happy even when the
host application enables the feature. Repository `happy.toml` files cannot
change this machine-level setting. In disabled mode Happy Agent does not load the Happy
module, search or copy credentials, register lifecycle hooks or reload handling,
create sync state, or open Happy HTTP and socket connections. Config changes
take effect after restarting the daemon.

The daemon imports the newest valid Happy credentials from `~/.happy/access.key`
into `~/.happy/agent/happy/access.key` at startup. `HAPPY_HOME_DIR` changes the source
directory. `HAPPY_AGENT_HAPPY_SERVER_URL`, then `HAPPY_SERVER_URL`, can override the
server URL. `happy-terminal happy auth` performs Happy's QR authentication directly and
hot-reloads a running daemon without interrupting its sessions.

Every accessed primary session synchronizes automatically. Happy Agent persists the
Happy session tag, encryption key, remote cursor, and a bounded outbound queue
in its session database. Encrypted v3 HTTP messages are authoritative; the
Happy socket only wakes synchronization. Stable message IDs make retries and
daemon recovery idempotent. Mobile text and encrypted image attachments are
submitted or steered through the same Happy Agent session, tools, filesystem sandbox,
and permission context as terminal input. Happy model and reasoning selections
are applied before an idle session starts its next turn. The mobile stop action
invokes Happy Agent's normal abort path, including active subprocess and subagent
cleanup.

Archiving a Happy Agent session also archives its Happy projection. Happy Agent immediately
sends Happy's `session-end` signal, publishes the encrypted `archived` lifecycle
metadata, calls Happy's session archive endpoint, and tears down that session's
socket and polling. Accessing the archived Happy Agent session by ID does not reconnect
it. Restoring the session reconnects synchronization and publishes the
`running` lifecycle state again.

Happy Agent publishes encrypted, versioned metadata with its client identity, actual
provider, provider-qualified model IDs, reasoning levels, current model and
reasoning selection, capabilities, title, Happy Agent session status, tools, skills, MCP
servers, and bounded activity counts for subagents, workflows, background
processes, and tasks. Metadata is refreshed whenever the corresponding Happy Agent
session event occurs. Secrets, prompts, raw tool schemas, process output, and
conversation contents are deliberately excluded.

The capability contract reports that Happy Agent supports text, steering, images,
model selection, reasoning selection, permission selection, and abort. Happy Agent
publishes its native `auto`, `workspace_write`, `read_only`, and `full_access`
mode IDs. Each mode includes a Happy Agent-owned visible name and description plus a
semantic `kind` (`default`, `read-only`, `safe-yolo`, or `yolo`) that Happy can
use for its icon, color, and risk indication without owning Happy Agent's security
semantics. Happy's
"resume" operation means launching a replacement native coding-agent CLI for
a disconnected session; Happy Agent sessions remain owned by the daemon and reconnect
automatically, so that operation does not apply.

Happy app implementations should use `metadata.client.id` for the client badge.
Happy Agent owns the provider and model presentation data: `metadata.providers` supplies
each provider's stable icon kind and human-readable name, and every model repeats
that descriptor alongside its visible `name`. Happy only needs to map a provider
`kind` such as `codex`, `claude`, `grok`, or `kimi` to an available icon; unknown
kinds can use its generic provider icon. `metadata.models` contains the complete
Happy Agent catalog; each entry is identified by the pair `providerId` and `id` (`code`
is retained for Happy's existing selector), and includes `thinkingLevels` and
`defaultThinkingLevel`. The selected pair is `currentModelProviderId` and
`currentModelCode`. The relevant metadata extension is shaped as follows:

Happy should likewise prefer `metadata.operatingModes` even when `flavor` is a
known provider. The selected native Happy Agent ID comes from `metadata.permissionMode`
or `currentOperatingModeCode`; `kind` is presentation metadata and must not be
sent back in place of `code`.

```json
{
    "rigMetadataVersion": 1,
    "client": { "id": "rig", "name": "Happy Agent", "version": "0.0.30" },
    "provider": { "id": "codex", "kind": "codex", "name": "OpenAI Codex" },
    "providers": [
        { "id": "codex", "kind": "codex", "name": "OpenAI Codex" },
        { "id": "claude", "kind": "claude", "name": "Anthropic Claude" },
        { "id": "grok", "kind": "grok", "name": "xAI Grok" },
        { "id": "kimi", "kind": "kimi", "name": "Moonshot Kimi" }
    ],
    "capabilities": {
        "abort": true,
        "attachments": {
            "enabled": true,
            "maxBytes": 10485760,
            "mediaTypes": ["image/*"]
        },
        "files": { "browse": true, "read": true, "search": true, "write": true },
        "modelSelection": true,
        "reasoningSelection": true,
        "permissionModeSelection": true,
        "resume": false,
        "rpcMethods": [
            "abort",
            "bash",
            "communication",
            "listFileTree",
            "readFile",
            "writeFile",
            "ripgrep"
        ],
        "shell": true,
        "steering": true
    },
    "models": [
        {
            "providerId": "codex",
            "providerKind": "codex",
            "providerName": "OpenAI Codex",
            "provider": { "id": "codex", "kind": "codex", "name": "OpenAI Codex" },
            "id": "gpt-5.3-codex",
            "code": "gpt-5.3-codex",
            "name": "GPT-5.3 Codex",
            "value": "GPT-5.3 Codex",
            "contextWindow": 200000,
            "serviceTiers": ["fast"],
            "thinkingLevels": ["low", "medium", "high", "xhigh"],
            "defaultThinkingLevel": "high"
        }
    ],
    "currentModelProviderId": "codex",
    "currentModelCode": "gpt-5.3-codex",
    "permissionMode": "auto",
    "currentOperatingModeCode": "auto",
    "operatingModes": [
        {
            "code": "auto",
            "value": "Auto",
            "description": "Uses the workspace sandbox and asks before actions that need full access.",
            "kind": "safe-yolo"
        },
        {
            "code": "workspace_write",
            "value": "Workspace write",
            "description": "Allows workspace changes while blocking shell network and outside writes.",
            "kind": "default"
        },
        {
            "code": "read_only",
            "value": "Read only",
            "description": "Allows inspection without workspace changes or shell network access.",
            "kind": "read-only"
        },
        {
            "code": "full_access",
            "value": "Full access",
            "description": "Removes Happy Agent filesystem, shell, and network restrictions.",
            "kind": "yolo"
        }
    ],
    "model": { "providerId": "codex", "id": "gpt-5.3-codex" },
    "reasoning": {
        "current": "high",
        "levels": ["low", "medium", "high", "xhigh"]
    },
    "session": {
        "status": "running",
        "permissionMode": "auto",
        "modelLocked": false,
        "serviceTier": "fast"
    },
    "thoughtLevels": [{ "code": "high", "value": "high" }],
    "currentThoughtLevelCode": "high",
    "activity": {
        "subagents": { "running": 1, "queued": 0, "total": 2 },
        "workflows": { "running": 1, "total": 1 },
        "processes": { "running": 2 },
        "tasks": { "pending": 1, "inProgress": 1, "completed": 3, "total": 5 }
    }
}
```

When Happy sends a user text record, it may attach the selected values as
`meta.model`, `meta.modelProviderId`, `meta.effort`, and `meta.permissionMode`. Happy Agent also accepts
`meta.providerId`, `meta.reasoning`, and `meta.thinkingLevel` aliases. The
permission mode is validated as a native Happy Agent mode and applied through the
session's normal permission path, including subagent propagation and process
shutdown when permissions are reduced. Model and reasoning selection applies
before an idle turn. A selection attached to a steering message cannot replace
the model of an already-running inference; the same persisted Happy selection
applies to the next idle turn.

A question Happy Agent is waiting on — from `AskUserQuestion`, Codex's
`request_user_input`, Grok's `ask_user_question`, or MCP elicitation — is
published on Happy's agent-to-user communication channel, as `communications`
in the encrypted agent state, keyed by the question's request id. Happy Agent publishes
the `form` kind: a title for clients that cannot render the payload, and one
entry per question with its options, `multiSelect`, and `allowCustom`, since
Happy Agent accepts any answer text and not only the labels it offered. Answering a
question anywhere moves it into `completedCommunications` with the answers, so
another device settles the card it is still showing.

Happy replies with the session RPC method `{happySessionId}:communication`,
carrying the request id and either `status: "answered"` with answers keyed by
question id, or `status: "cancelled"`. Happy Agent cannot decline a single question, so
a dismissal — including one from a client that could not render the kind —
aborts the run that asked it, which is what makes the waiting tool throw.

Happy invokes abort through the standard encrypted session RPC method
`{happySessionId}:abort`. Happy Agent registers that method on every socket connection
and returns its normal encrypted abort result. Image attachments use Happy's
existing encrypted file event followed by user text convention. Happy Agent downloads
and decrypts every preceding image in memory and includes it in that text
submission; it does not persist plaintext attachment bytes.

Happy Agent exposes `listFileTree` as its lazy file browser session RPC. It deliberately
uses a new name because Happy's older unpaginated `listDirectory` helper has a
different contract. `listFileTree` requires a POSIX-relative path (`""` is the
root), returns names in UTF-8 byte order, and requires callers to follow
`nextCursor` until it is `null`.

Each call
returns one bounded page of one directory at a time, including hidden and
Git-ignored entries such as `.context`, without recursively materializing the
workspace or invoking the agent's shell tool. Opaque cursors are bound to the
directory snapshot, and `reason: "directory_changed"` tells RPC callers to
restart a page sequence. `.git` directories are not exposed, and symbolic links
are visible but cannot be expanded through the tree API.

The current Happy app also invokes `bash`, `readFile`, `writeFile`, and
`ripgrep` for its legacy flat all-files list, Git status/diffs, file
viewing/editing, and file search. Its all-files UI can move to `listFileTree`
with a new paginated client operation and lazy expansion. Happy Agent publishes the
exact RPC list in `capabilities.rpcMethods`. The older recursive
`getDirectoryTree` helper is not advertised because an eager recursive tree
cannot stay bounded on large workspaces.

Native Happy Agent sessions use the platform-specific ripgrep binary bundled with the
Happy Agent package, so Happy file search does not depend on `rg` being installed on the
user's `PATH`. Docker and virtual filesystem sessions use the `rg` supplied by
their controlled execution environment when the host bundle is not visible
inside that environment.
These run through the session's real Happy Agent `AgentContext`; they therefore use the
same local-or-Docker filesystem, current permission mode, shell sandbox,
network boundary, process accounting, output limits, and abort lifecycle as the
TUI agent. File writes retain Happy's SHA-256 optimistic-concurrency contract.

## Happy2 local plugins and MCP Apps

The legacy local-plugin catalog integration has been removed. Happy2
integrations must use the public Happy Agent API through
`@slopus/happy-agent-client`; capabilities absent from that API are not exposed
through a compatibility adapter.

The renderer implements the MCP Apps 2026-01-26 JSON-RPC 2.0 `postMessage` bridge:
`ui/initialize`, `ui/notifications/initialized`, `resources/read`, and `tools/call`. Do not inject a
global API object. Electron main derives the caller from its committed origin and calls
`connection.callTool(app, server, name, arguments, { signal })`. It may advertise the explicit
`io.slopus.happy/storage/*` extension. Do not expose arbitrary daemon paths, raw fetch, credentials,
plugin sockets, or tools absent from the app catalog.

The daemon has already bounded and validated the catalog: at most 8 apps per plugin, 64 resources
per app, 256 KiB per resource, and 1 MiB per app. Storage is JSON-only and limited to 1,024 keys,
64 KiB per value, and 5 MiB per plugin. Happy2 must still bound its own decoded/object-URL caches
to the catalog it received and must not broaden those limits.

Unmounting, removing navigation, or closing the subscription aborts prefetch and tool calls, destroys
the isolated view, and releases object URLs or custom-protocol mappings for that generation. A
stale-generation error retires the old view: unmount it, drop its bundle, and wait for the current
catalog. Never retry the old generation. Ordinary tool failures stay inside the app UI.

A clean reconnect keeps cached current generations. After a gap, retain unchanged generation keys,
prefetch new ones, and dispose missing ones. Happy2 tests should cover an event on each side of the
opening snapshot, clean resume, gap reload, replacement, uninstall, stale actions, partial-prefetch
cancellation, and last-subscriber disposal.

## HTTP proxy

The authenticated daemon connection exposes a project- or workspace-scoped
proxy tunnel:

```http
CONNECT /projects/{projectId}/proxy
CONNECT /projects/{projectId}/workspaces/{workspaceId}/proxy
Authorization: Bearer <daemon token>
```

After Happy Agent answers `200 Connection Established`, the connection speaks the
ordinary HTTP proxy protocol: absolute-form HTTP requests and nested
`CONNECT host:port` requests both work, and request and response bodies stream
without buffering. Happy Agent removes proxy and hop-by-hop headers while preserving
upstream `Authorization`.

Putting the folder scope in this URL lets an Electron main process bind one
ephemeral loopback proxy per project or workspace, pass its ordinary
`http://127.0.0.1:<port>` URL to `session.setProxy()`, and pipe each accepted
browser connection through the authenticated Happy Agent tunnel. Chromium does not
preserve path, query, or arbitrary headers in its proxy server setting, so the
loopback bridge owns that final URL-to-tunnel mapping.

The proxy is a host-side project service. It remains available before a chat
exists and does not inherit a chat's execution environment or lifecycle.

## Direct project and workspace files

`GET /projects/{projectId}/file?path={path}` reads binary file bytes from a
project. Add `/workspaces/{workspaceId}` before `/file` to target a workspace:

```json
{ "content": "<base64>", "hash": "<sha256>" }
```

`PUT` to the same URL replaces or creates a file:

```json
{
    "path": "path/to/file",
    "content": "<base64>",
    "expectedHash": "<sha256 or null>"
}
```

Use the hash returned by `GET` to replace the exact version that was read. Use
`null` only when creating a file expected not to exist. A concurrent change
returns HTTP 409. Paths are confined to the selected project or workspace;
writes use Happy Agent's workspace boundary and reject protected Git control files.
File payloads are limited to 32 MB. File search follows the same scope at
`GET .../files?query={query}&limit={limit}`. None of these operations requires
or consults a Session.

## Submit a configured message

`POST /sessions/{sessionId}/messages` accepts the normal message fields plus an
optional exact system prompt:

```json
{
    "text": "Resolve ticket 42",
    "systemPrompt": "You are the support automation agent."
}
```

When present, `systemPrompt` replaces Happy Agent's assembled prompt; `null` restores
Happy Agent's normal prompt.

Use `POST /messages` with either `"all": true` or a non-empty `sessionIds`
array to submit the same configured message to multiple primary sessions. IDs
must be unique, and a single broadcast is bounded to 500 sessions.
