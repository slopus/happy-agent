# Tailcat learnings

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
