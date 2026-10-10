# Tailcat learnings

## Carriers stay in the background on Windows

Both incoming exposure and outgoing SOCKS helpers launch with hidden Windows consoles. Their
captured output and existing supervision remain authoritative; reconnecting cannot flash a terminal.

## New identities carry a pre-shared key

The bundled Tailcat is v0.7.0. Since v0.6.0, `genkey` adds a WireGuard pre-shared key to new
server identities and their addresses. Happy Agent keeps that upstream default and does not pass
`--psk=false`, because the key makes the address itself a secret that is needed to connect. A
persisted identity created by v0.4.0 has no pre-shared key, and `serve` keeps using it as it is,
with a warning, so existing addresses keep working for clients of every version. An address that
has a pre-shared key cannot be reached by Tailcat v0.5.0 or earlier clients. That includes older
Happy Agent releases dialing out. The arguments Happy Agent passes (`genkey --key=<path>
--fixed-region`, `--key=<path> serve <port>` with `TAILCAT_ADDR_FILE`, and `--key=new socks
--listen=127.0.0.1:0 <address>`) and the `SOCKS running at socks5h://127.0.0.1:<port>` line are
unchanged.

## Tailcat did not cause the macOS app-data prompt

macOS asked users to let Happy access data from other apps just after the bundled Tailcat
started, and a strings scan showed Tailscale's `safesocket` code for finding Tailscale.app.
Tailcat seemed to be the cause, but it was not. That code is linked only through the DERP server
type and runs only in a local debug mode, and Tailcat's `serve`, `socks` and `genkey` produce no
privacy requests at all. The unified log named the daemon itself as the accessor. A recursive
watch on the home directory caused it, and the Git module now forbids that watch. Before blaming
a helper process for a privacy prompt, read the `accessing=` process in tccd's
`AUTHREQ_ATTRIBUTION` log line.

## The feature owns its live transport

Tailcat used to be started by the daemon executable after the modules-owned runtime had already
opened. That made the tunnel work at startup but left tools with no legitimate module boundary for
live control. Tailcat is now a module that owns its stable key, loopback relay, supervised process,
live status, and durable reconciliation. The executable only attaches the API transport it bound.

The configured setting is the desired state. A live mutation is written atomically to generated
`runtime.toml` before in-memory state changes, then reconciliation is scheduled through Durable
Functions and attempted immediately for interactive feedback. Startup attachment reconciles the
same persisted state, so an interrupted mutation converges on restart.

## Internet exposure is an admin-bot capability

Tailcat control and address tools exist only for active admin bots. Ordinary bots, archived admin
bots, human-root agents, and subagents do not receive them. Every tool operation checks the caller's
bot record again at execution so a stale tool list cannot grant authority. Enabling is an Auto
reviewed, full-access action because it opens an account-free external network path; reading status
is local and read-only. Happy Agent's own API authentication remains in force inside the tunnel.

## The service port is deterministic

Binding the loopback relay to port zero made the remote endpoint change on every daemon restart,
even though the Tailcat identity was stable. Tailcat now binds the exact machine-configured port,
which defaults to the IANA-unassigned `24779`. A collision is a startup failure, never permission
to choose another port, because remote nodes may have stored the address and port together.

## Outbound carriers are persistent native sockets

Remote connections use one persistent Tailcat SOCKS process per active configured endpoint and
native TCP sockets for its HTTP pool. A stdio-backed Duplex worked on Node but did not satisfy
Bun's HTTP transport. Tailcat still carries and encrypts the remote traffic; the loopback SOCKS
hop adapts it to both runtimes without exposing the remote API token to the carrier process.
Processes, handshake buffers, concurrent sockets, startup, and shutdown are bounded. Recreating a
failed carrier is allowed for a new request, never a replay of an interrupted mutation.

## A live process is not necessarily a healthy carrier

After a remote restart, a SOCKS process can stay alive while every new handshake fails. Keeping
its resolved startup promise then pins the connection to that failed process indefinitely.
Handshake and startup failures now destroy that generation's sockets and reap its process before
subsequent requests share a fresh startup. Cleanup is generation-checked, so late failures cannot
tear down a replacement. Permanent close still unregisters the connection; transient recovery
does not. Destroying the old sockets also evicts them from the owning HTTP pool. No failed request
is replayed, and no credential or roster change is needed.
