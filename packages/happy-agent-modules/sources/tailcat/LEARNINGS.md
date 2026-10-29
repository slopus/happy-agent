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
Happy Agent releases dialing out. The upgrade changed none of the arguments Happy Agent passes
(`genkey --key=<path> --fixed-region`, `serve` with `TAILCAT_ADDR_FILE`, and `--key=new socks
--listen=127.0.0.1:0 <address>`) or the `SOCKS running at socks5h://127.0.0.1:<port>` line.

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
live control. Tailcat is now a module that owns its stable key, connection pipe, supervised
process, live status, and durable reconciliation. The executable only attaches the API transport it bound.

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

## The port is advertised, never bound

Remote nodes and paired phones store the address and port together, so the port is fixed machine
configuration, `24779` by default and `24781` for the mobile connector, and never changes on its
own. Exposures used to give Tailcat `serve <port>`, which proxies to that port on localhost, behind
a loopback relay bound to it. Every Happy Agent on a computer shares the defaults, so a second one,
such as a development daemon, took the port first and the exposure failed to open, sometimes only
after a reboot changed which daemon started first. Naming the port in the error did not help a
person who had no idea why it was taken.

Exposures now run `serve exec -- <pipe>`. Tailcat's exec service runs the pipe for each
connection to any port, with the connection as its stdin and stdout, and the pipe joins them to
the API's Unix socket or TCP listener. Nothing binds a local port, so there is nothing to clash,
and the configured port is only the number reported in the status, the `port` file, and the QR
code. The pipe is this process's own runtime with `-e`: Node or Bun from source, and the standalone
binary acting as Bun through `BUN_BE_BUN`, which every other runtime ignores. A peer that closes
its side ends the connection, as the relay did, so pipes left behind by a stopped Tailcat exit
when their stdin closes.

The pipe must not exit until its last byte has left stdout. The daemon closes each response's
connection right after writing it, and the pipe used to exit from the callback of an empty
`stdout.write('')`. On Bun 1.4.4, the runtime Happy Agent ships, that callback fires before
earlier output has flushed. Large responses, such as a phone's 130–250 KB message pages, then lost
their tail, and the phone saw the chunked body end mid-chunk. Node and Bun 1.4.0 flushed in time,
which is why the module tests running on Node missed it. The pipe now ends stdout and exits from
`end`'s callback. Tailcat half-closes the connection when stdout closes, so the peer still gets
every byte and then its FIN. A gym test reads a 1 MiB file through the mobile connector the way
the iOS app does, ten times, and checks the bytes.

Each new connection pays for one short-lived process. On real Tailcat between two processes on one
Mac, a fresh connection and request took about 1 ms through the relay, about 15 ms through the
release binary's pipe, and about 45 ms under Node from source; each open connection's pipe holds
about 17 MB resident with the release binary. Event streams, WebSockets, and kept-alive HTTP
connections are long-lived, so the cost is paid per connection, not per request.

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

## Other features get their own named exposures

The mobile connector needs a Tailcat address that is separate from `[feature.tailcat]`, so that
pairing a phone never exposes the main API socket and the two can open and close independently.
`openExposure` starts an additional supervised exposure with its own identity key from
`ConfigModule.tailcatExposurePaths(name)`, its own advertised port, and its own API target, and
returns a handle with the address, port, and an idempotent close. It reuses the same genkey,
pipe, and supervision code as the default exposure, which stays exactly as it was. A name is open
at most once, `default` is refused, and module shutdown closes every named exposure. Callers use
only this method, never the internal exposure code.

## Tailcat addresses never reach a log

An address carries its identity's WireGuard key and pre-shared key, so whoever reads it can reach
the socket. The default exposure used to log `tailcat:open address=… port=… pid=…`; Steve asked
for the address to be hidden everywhere. Every exposure, default and named, now logs only that it
opened or reopened, with its port and pid, and any Tailcat address in Tailcat's own output or in a
restart error is replaced with `[address]`. Outbound connections already report only "The remote
Tailcat transport is unavailable.", and the runner's endpoint error no longer echoes what was
typed. The `address` files and the admin status tool still show the address: they are where a
person goes to read it.
