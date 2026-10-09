# Runner protocol

A runner is a machine dedicated to running agents' work, separate from the daemon that thinks. The
daemon keeps the database, provider credentials, and inference; the runner keeps the files and the
processes. An agent's mistake — or a malicious dependency it installed — lands on a machine that
holds nothing worth stealing.

This directory is both halves of the protocol between them. Neither half knows how bytes travel:
the runner dials the daemon, whoever authenticates that transport hands a `RunnerChannel` to the
protocol, and from then on both sides see ordered frames.

```text
  daemon machine                                    runner machine
  ──────────────                                    ──────────────
  agent tools                                       RunnerHost
      │ Compute                                         │ one owner per daemon process
      ▼                                                 ▼
  createRunnerCompute ──┐                           host compute + native supervisor
  createRunnerCompute ──┤                               │
                        ▼                               ▼
                   RunnerLink  ◀════ RunnerChannel ════  serve(channel)
                 (one per runner,   (WebSocket, SSH,     (runner dials out,
                  across reconnects) in-memory pair)      reconnects on loss)
```

## Frames

A frame is a 32-bit big-endian header length, a UTF-8 JSON header, and an optional raw body. File
contents, command input, and stream bytes travel as the body, so they cost their own size on the
wire. A frame is at most 64 MiB, which is also the largest file a runner moves in one call.

```text
runner                                   daemon
  │── hello {protocol range, identity} ──▶│
  │◀── welcome {protocol, instanceId, ────│   instanceId changes every daemon start
  │             leaseGraceMs}             │
  │── ready {epoch, retained computes, ──▶│
  │          retained streams}            │
  │◀────────── request {id, method} ──────│   fs.*, shell.*, process.*, watch.*, net.*
  │── response {id, result | error} ─────▶│
  │◀────────── cancel {id} ───────────────│   the caller stopped waiting
  │── event {seq?, shell.exit | ...} ────▶│
  │◀────────── ack {seq} ─────────────────│
  │◀──────── data / eof {stream} ────────▶│   stream bytes, by channel and offset
  │◀──────── flow {stream, consumed} ────▶│   the reader handled bytes; send more
  │── exit {stream, code, signal} ───────▶│
  │◀────────── close / release {stream} ──│   stop it / forget it
  │◀──────── ping / pong ────────────────▶│   either side, every 15 s when quiet
  │◀──────── goodbye {reason} ───────────▶│   deliberate end
```

Every frame either side receives is validated against `runnerProtocol.ts` before it is used. A
runner may be a compromised machine, so a malformed frame ends the connection, an invalid result
fails its request, and an unknown event is ignored. Node-style error codes such as `ENOENT` cross
the protocol, because callers above compute branch on them.

## Lifetime

Master plan 8 says nothing a daemon started survives it. A runner keeps that promise without
seeing the daemon's process table:

- A connection that ends unannounced starts a lease (`leaseGraceMs`, 60 s by default). The same
  daemon process reconnecting within it finds its machines, running commands, and unheard exits
  where it left them.
- A lease that runs out releases everything the daemon held: every process tree is killed.
- A connection from a new daemon process — a new `instanceId` — releases the previous process's
  machines before anything else happens.
- A `goodbye` from the daemon releases at once.

The `epoch` in `ready` names the runner's record of the daemon process. It changes when that
record starts over, and exit-event sequence numbers restart with it. The daemon acknowledges
every sequenced event, the runner keeps up to 1,024 unacknowledged exits for a daemon that is
away, and a replayed exit is delivered once.

## Streams

A long-lived flow of bytes is a stream: a program's input and output, a file watch, a TCP
connection, or a listener. The daemon picks the stream ID, routes it, and then asks the runner to
start it with `process.start`, `watch.start`, `net.connect`, or `net.listen`; output that races
ahead of the response is already routed. A runner holds at most 256 streams for a daemon.

Each stream has an input channel `in` and output channels `out` and `err`. Every `data` frame
names its channel and the offset of its first byte, in chunks of up to 64 KiB. The reader answers
with `flow`, the count of bytes it has actually handed on, and the writer never runs more than
512 KiB ahead of it. That window is also the retransmission buffer: after a reconnect inside the
lease, each side sends again whatever the other has not reported consumed, and the receiver drops
bytes it already has by offset. A gap, a write past the window, or data after `eof` ends the
connection as a protocol violation. Nothing is lost and nothing is buffered without bound: a
reader that stops reading pauses the program, watch, or socket on the runner.

`exit` follows both output `eof`s, so it always comes after the last byte. `close` asks the runner
to stop a stream; its exit still arrives. `release` tells the runner to forget a stream and kill it
if it still runs. Streams the runner reports in `ready` survive a reconnect; any the daemon was
routing that the runner no longer holds are lost, and their owners hear that the runner restarted
or released this daemon.

A watch writes newline-delimited JSON batches `{paths, overflow}` on `out`. While the daemon is
behind, the runner merges pending batches rather than queueing them, and too many changed paths
become one overflow batch telling the reader to rescan.

A listener is how a program on the runner reaches back to something only the daemon can do. Git
is the reason it exists: a repository token never leaves the daemon, so Git on the runner talks to
a loopback port there, and each connection to it comes back to the daemon's own credential proxy.
`net.listen` answers with the port. Every accepted connection is announced on the listener's `out`
as a JSON line `{connection}` and waits, paused, until the daemon attaches it to a stream of its own
with `net.accept`; at most 64 wait, each for at most 30 seconds.

## Daemon side

`RunnerLink` is one registered runner across all of its connections. `accept(channel)` runs the
handshake and makes the connection current; a newer connection replaces an older one. Calls
made while the runner is away wait for it to return until ten seconds after it went away, then
fail with `RunnerUnavailableError`: nothing was sent. The window is counted from the drop, so a
runner that has been away longer fails every call at once rather than making each wait in turn. A request in flight when a connection ends fails
with `RunnerDisconnectedError`: its outcome is unknown, and it is never replayed.

`createRunnerCompute` builds a `Compute` on a link. The machine is created on the runner before
it resolves, so an unreachable runner fails where the machine is chosen. Session IDs belong to
the compute, not the runner. When the runner loses a machine, its running commands are reported
as killed, the next call rebuilds the machine in the same folder, and new commands never reuse
a lost command's ID. A runner refuses a request for a machine it no longer holds before doing
anything, so that one refusal is the only call the compute answers by rebuilding and asking
again.

A runner compute carries the filesystem and shell, plus `processes` (pipes or a terminal, for
Git, terminals, and stdio MCP servers), `watcher`, and `network` (connections the runner makes, for
previewing web apps it serves, and loopback listeners) over streams. A compute created with
`docker: { image }` runs the agent's files and commands in a container of that image on the
runner, with the folder mounted at the same path; its processes, watches, and connections still
run on the runner itself, over the same folder. Strict services need cgroup delegation on the runner
and are a later, additive protocol version; until then a runner compute has no `services`
capability, and callers refuse service startup rather than falling back to an ordinary shell.
Commands that select attached secrets are refused until the daemon can resolve them for a single
command on the runner.

## Runner side

`RunnerHost` serves one daemon at a time. It builds machines through the `createCompute`
function it was given — on a real runner, `createRunnerMachine`: the host compute with the native
supervisor, protecting the runner's own private directories, or a Docker compute when the daemon
asked for one — and derives a separately named lifetime for every connection and every machine
from its own context. Only project-relative protected file names
cross the protocol; the daemon's absolute private paths mean nothing on the runner.

## Tests

`tests/runner` drives a real host compute through both halves over `createRunnerChannelPair`, and
drives the daemon's half with a hand-written misbehaving runner. The stream tests cut the
connection mid-transfer, dropping frames in both directions, and check every byte still arrives
exactly once.
