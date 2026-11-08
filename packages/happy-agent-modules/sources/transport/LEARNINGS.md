# Transport learnings

## An SSE writer cannot wait for `drain` alone

A client waiting on `/v0/events/stream` for a run's `run.finished` hung forever, even though the
daemon had journaled the event and replayed it to that connection. The SSE writer queued frames
after `response.write()` reported backpressure and resumed only on the response's `drain`. Node 26
corks a response for the rest of the tick and measures that buffer, headers and chunk framing
included, against the high-water mark. A synchronous replay burst can therefore cross the mark
while the socket, after the kernel takes the first bytes, stays below its own. The socket never
needs `drain`, so the response never emits it, and every remaining frame stayed queued. A replay
that follows a manual compaction is large enough to hit this reliably under load.

The writer now counts each frame's write callback and resumes only once every frame it handed to
Node has been flushed. Callbacks are the single resume signal: keeping `drain` as well would let a
stale `drain` release a later blocked batch early, and measuring 78 MiB of 2 KiB frames in bursts
showed the same throughput either way (about 45 ms under both Node 26 and Bun 1.4.4). The byte
bounds and whole-frame ordering are unchanged.

Stored files and workspace proxy bodies had the same dependency through `pipeline()` straight
into the message. `streamToOutgoing` keeps `pipeline()`, which owns the whole transfer's
lifetime, and pipes into a sink that finishes each chunk on the message's own write callback. The
sink turns the message's `error` or premature `close` into its own failure, so a client that
leaves while the source is idle, a source that fails during backpressure, and a write that fails
after it was accepted all end the transfer, destroy the other side, and reject. A first version
rebuilt that lifecycle by hand and missed each of those cases; do not hand-roll it again.

## A tunnel WebSocket that closes after a half-close is still read out

`WebSocketTunnel.webSocketClosed()` destroyed the stream at once, dropping bytes the client had
sent before its empty half-close message but nobody had read yet. When the client half-closed
first, everything it sent is now read out before the stream is destroyed; any other close still
ends it at once.
