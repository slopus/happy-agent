# Happy

This module connects an agent to Happy, the mobile app. A session running here
shows up on the phone, streams as it works, and can be driven from there.

`HappyModule` owns one `HappyConnection` per authenticated team user, or the existing single
connection in standalone mode. Team credentials live under `<data>/users/<userId>/happy/` and
never adopt the shared Happy CLI login. The unchanged API selects the caller's connection from
authentication; pairing, status, bootstrap, and events are private to that user. Every connection
has its own lifecycle, locks, machine registration, and session/project sync state. Incoming
mobile messages retain the connection owner's team identity.

```
Happy CLI credentials       API QR pairing
        |                         |
        +------------+------------+
                     v
  <data>/happy/{access.key,settings.json,machine.json}
        |
        v
     credentials  --->  crypto  --->  Happy server
```

## Credentials

Happy signs a person in once, on the phone, and the CLI stores the result in
`~/.happy/access.key`. `importHappyCredentials` adopts that file into the
agent's own data directory whenever the CLI's copy is newer, so signing in with
Happy anywhere on the machine signs this agent in too. No credentials means
Happy is simply not connected; it is never an error.

Clients can also pair this daemon directly through the Happy integration API.
Starting the integration creates a two-minute, process-local authorization
request and returns its opaque `happy://` data for a QR code. The daemon saves
the credentials only after the phone authorizes that exact ephemeral key. An
initial server failure never exposes a QR code that cannot work. The same API
can cancel a pairing attempt, unlink only this daemon, or unlink and start a
fresh pairing attempt. Unlinking never changes the external Happy CLI login.

An account uses one of two encryption formats for its whole lifetime. A
`legacy` account encrypts every payload with the account secret. A `dataKey`
account encrypts with a per-scope AES key that is wrapped to the account public
key, so the account secret never leaves the phone.

## Encryption

`crypto/` holds the wire formats, which must match Happy exactly:

- payloads — secretbox with a 24-byte nonce prefix (`legacy`), or AES-256-GCM
  behind a zero version byte (`dataKey`);
- wrapped data keys — a zero byte, an ephemeral public key, a nonce and a
  sealed key;
- the authorization bundle a phone returns — the same box without the version
  byte;
- attachments — secretbox under a key derived from the account or session key.

## Storage

The sync database has two tables for what a restart must not lose.
`happy_agent_happy_sessions` holds one row per owner and attached agent: the session it
mirrors, the tag that keeps remote session creation idempotent, the key its
payloads are encrypted with, how far Happy's own stream has been read, and how
far the agent's history has been projected. `happy_agent_happy_outbox` holds
the messages that are written but not yet accepted, in the order they were
produced.

Both are keyed by connection owner as well as agent, and belong to the account that produced them. Signing in to a different
account discards the remote identity, the cursor and the queue, because none of
it belongs to the new account.

Integration metadata has one row per connection owner (the empty owner is standalone). It keeps the public
snapshot's UUIDv7 high-water mark monotonic across restart and clock rollback,
and remembers bounded SHA-256 fingerprints of credentials this daemon must not
adopt again. Happy rejection and explicit unlink both suppress only the exact
credential involved; a changed external login remains eligible, and successful
pairing clears the rejection history. No token or encryption key is stored in
this metadata.

## Projection

A message is queued in the same transaction as the event it comes from, so the
queue can never disagree with the history it was built from, and a crash
between the two is not a state that exists. The cursor moves forward only past
an event whose messages are queued, so a restart resumes exactly where it
stopped. Events with nothing to say to Happy still move it, which is what keeps
a quiet agent from re-reading its history on every start.

The queue is bounded, and reaching a bound is a decision rather than a failure:

- past ten thousand waiting messages, new ones are held back rather than
  dropped, and released in order once the phone catches up;
- past ten thousand held back, the agent stops queueing until Happy accepts
  something, and resumes on its own when it does;
- a message too large for Happy to ever accept stops the queue where it is,
  because sending what came after it would show the phone a conversation that
  never happened.

## Acting on a conversation

The socket, the encryption and the queue are this module's own. The conversation
is not, and it is not reinvented here either: sending a message, stopping a turn,
answering a question, ending a session and starting one all go through the same
catalogs and the same journal the daemon's HTTP routes write to. That is what
makes a session driven from the phone and the same session driven from a desktop
client leave identical history behind.

Each module-owned `HappyConnection` does that work, and hands its own pieces only the narrow
contract each of them needs — `HappySessionOperations` for the session client,
`HappySpawnOperations` for a phone starting something new — so the wire handling
can be exercised without a daemon behind it.

A phone message is always steering. Happy first writes its complete pending
history row and offers the same message identity to Agent Base with `steer` in
one transaction. History's committed-pending notification lets the API publish
that row immediately, so an open desktop transcript shows the message while the
active run is still reaching its steering boundary. Once accepted, the ordinary
Agent Base event path promotes that exact row into the successor run. At that
same acceptance the session stream answers the phone with a content-free
`user-message-accepted` receipt instead of an echo: it closes the interrupted
turn and tells the client, by server message ID, where its own message entered
the run order. An older app that cannot name the receipt drops it silently.

The module registers its projection listener on the journal in its own
constructor, because the journal must carry that listener from the moment it
records anything; it takes its lifetime and the agent collection at
`beforeStart`; and it connects to Happy at `afterStart`. Connecting last is the
point. Publishing a session means describing what it is doing, and until every
durable agent has been restored there is no honest answer to give — a phone
would be shown a row of sessions that all look idle and then watch them correct
themselves. Catalog reconciliation then runs on the module's background
lifetime, so reading a large archive cannot hold daemon startup open. It follows
complete catalog pages, rejects archived agents and owners, and opens at most 64
session connections. After startup, the API may ask the same module to begin
pairing or resume a configured connection.

The public integration state is a complete, versioned snapshot. Pairing,
connecting, connected, disconnected and failed transitions are emitted through
the installation event journal, while repeated observations of the same state
are deduplicated. This gives API clients one authoritative object to replace
instead of a collection of socket-derived flags to reconcile.

Happy stays separate from required onboarding. Desktop bootstrap returns both
objects together so a client may offer pairing during onboarding, but Happy
connection state neither changes nor blocks onboarding completion.

Nothing about talking to Happy is handed in, and nothing it takes is anything
other than another module. Where the credentials live and what version to report
are asked of the config module; which agent this machine acts as is asked of the
installation module that settles it; the conversation catalog, the journal, the
questions a person answers and the folders a session may start in are the modules
that own them. The socket is opened by `connectHappySocket`; a client accepts a
socket factory only so a test can drive one by hand. A machine that has never
been paired with Happy has no credentials, and that is the whole of the decision
about whether to connect.

## The session client

One `HappySessionClient` per attached agent keeps that session in step. Its loop
is deliberately dull — create the remote session if there is none, send what the
outbox owes, read what the phone said, publish what the session is and what it
is waiting on — because that is what makes it safe to interrupt anywhere and
pick up where it stopped. Nothing is republished unless it changed, and a
version conflict is resolved by taking the server's version, putting Happy Agent's own
facts back on top, and trying again.

An attachment arrives as its own message just before the words that go with it,
so it is held rather than delivered, and the read position does not move until
the message that claims it has been delivered too.

## Reading workspace changes from the phone

The encrypted session RPC adds three read-only methods. Clients discover them through
`capabilities.rpcMethods`, not a daemon-version comparison. `files.read` is true; shell,
file browsing, search, and writes remain unavailable. Existing session-control RPCs are unchanged.

```text
<remote session id>:gitState            {}                 -> { success: true, git }
<remote session id>:readFile            { path }           -> { success: true, content, hash }
<remote session id>:readFileAtRevision  { path, revision } -> { success: true, content }
```

The request schemas live in `HappyWorkspaceRead.ts`. File content is base64, with a SHA-256 hash
for current reads. HTTP and Happy share `GitModule.resource`: facts, merge base with `origin/main`,
counts, file paths (including rename sources), truncation and scan time, without private bytes.

`revision` is a full lowercase 40- or 64-character object ID, normally `git.base`, never `HEAD`.
A rename's before side uses `previousPath`; its current side uses `path`. Current files remain live,
not an atomic snapshot of the list. Binary files and inexact counts remain explicit in the UI.

Each request resolves the session's active owner through the catalogs, not metadata or a supplied
`cwd`. Unknown fields are ignored. Paths are relative POSIX paths; current-file reads also accept
native absolute links inside that root. Traversal, symlink escapes and non-files are refused.
Git state is unsupported for plain folders or projects below a repository's root.

The existing file methods receive a 524,288-byte limit; their HTTP default remains unchanged.
Before encryption, any JSON response above 700,000 UTF-8 bytes becomes a small `too_large` failure.
This includes exceptionally large Git lists. Git's existing cache and 1,000-file cap are unchanged.

Failures are `{ success: false, code, error }`; codes are `invalid`, `forbidden`, `missing`,
`too_large`, `unavailable`, or `unsupported`. Only a ready comparison with zero changed files means
“No changes.” A genuine zero-byte file succeeds; absence or failure does not. This adds no HTTP route.

## Machine identity

Each daemon owns a machine identity so Happy can tell two daemons on one
computer apart. It is created once by publishing a file and linking it into
place, so a race resolves to whichever daemon landed first.

A daemon with a machine identity also connects a `HappyMachineClient`, which is
what lets somebody start a session from their phone. A directory that does not
exist is reported back and created only once the person has said yes; a model,
reasoning level or permission mode this daemon does not have is refused rather
than quietly substituted, because a session running on something other than
what was asked for is worse than no session. The session id is derived from the
request, so a phone that asks again gets the same session rather than a second
one.

The newer `happy-agent-spawn` request names a project, a ready workspace, a new
workspace, or a folder to import. Its outer object and agent configuration are
strict schemas. Agent and new-workspace identities are both derived from the
client request ID; terminal answers are memoized for the daemon lifetime, while
`pending` is deliberately retried until background workspace provisioning is
ready.

## Historical context

A newly mirrored session receives at most its latest 50 archived messages, in
oldest-first order, once. Backfill uses the same message mapper as live sync and
stable `history:` identities. It publishes visible text and structured tool-call
start/end events, but never private reasoning or tool output content.

Archiving is one decision in both products. A phone archive aborts the run,
disposes the local compute and writes Agent Base's durable `archivedAt` metadata
before the remote projection closes. Project and workspace archives enumerate
their own durable agent associations, so a session does not have to be one of the
currently connected 64 to be retired remotely.
