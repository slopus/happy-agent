# Mobile connector learnings

## A finished pairing must not close the socket under its own answer

Closing the socket as soon as nothing needed it cut off the phone at the worst moment. A phone
whose "Doesn't match", bad MAC, or reveal ended the last pairing had its own request destroyed
before the answer was sent, and a long poll woken by a desktop cancel could lose its response.
Ending a pairing now starts a three-second linger, and reconciliation keeps the socket open until
the linger runs out. Device changes still converge through Durable Functions and the same
reconciliation, so the socket never stays open longer than that without a reason.

## The specification is the phone's only reference

Happy Agent ships no phone code: the native app implements pairing from the Mobile connector
section of `API.md` alone. A TypeScript phone SDK was built first and then dropped for that
reason, so the daemon's `impl/` crypto and emoji table are the one implementation in this
repository. The section therefore carries everything a phone needs, including the full emoji
table, its checksum, and fixed vectors. The tests' fake phone is written from it, reads the emoji
table out of it, and never imports `impl/`, so its agreement with the daemon checks both against
the spec.

## One API, with mobile authentication first

The first design gave the connector its own listener and router, which served the pairing routes
and handed device requests to the API through a registered handler, without WebSockets or
`CONNECT`. Steve rejected that as a branch of the API. Phones now reach the one API: the daemon
binds an extra loopback listener with the same HTTP stack, flagged as mobile, and the exposure
forwards there. On that transport the API asks `authenticate` about the bearer before routing,
for every request, upgrade, and `CONNECT`, and accepts nothing else. A device acts as its owner
everywhere except a short denylist (drain, shutdown, debug, mobile connector management), which
answers `403`; the pairing and handshake credentials reach only their own `/v0` handshake routes,
which exist only there. Revocation is an AbortSignal on the device credential, so the API closes
connections on every transport path, Bun's native WebSockets and tunnels included.

## The socket's port is not a local port

The socket has a fixed port, default `24781`, because paired phones keep the address and port
they dialed. It used to be bound on loopback, and every installation on a computer shares that
default, so a second Happy Agent, such as a development daemon, could take it first and keep
phones from connecting. A clearer "port in use" message was tried first and did not fix it.
Tailcat now runs a pipe per connection through its exec service and binds nothing, so the port is
only the number in the QR code and the socket opens whatever else holds that port. The QR format
and the setting are unchanged, so phones paired before keep working.

## The exposure waits for its transport

The module used to start its own listener and reconcile in `afterStart`. With the API owning the
listener, the exposure can only open once the daemon has bound it, so `attachTransport` triggers
the first reconciliation and a pairing started earlier fails with "not ready yet" instead of
showing a code nothing can answer.
