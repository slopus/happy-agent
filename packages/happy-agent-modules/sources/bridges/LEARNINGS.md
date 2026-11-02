# Bridges — learnings

## Bluetooth is a USB adapter, not a protocol of its own

Bluetooth could have been a separate HCI relay, but Steve chose USB adapter passthrough: a USB
Bluetooth adapter on the person's computer is attached like any other USB device and becomes an
ordinary controller on the workspace's machine, usable with BlueZ. There is one transport to secure
and keep correct, and the capability reports `transport: "usb"` so another transport can be added
later without changing its shape. Bluetooth is available exactly when USB is and the kernel has
`btusb`.

## USB reaches the daemon's own kernel; ports reach the folder's machine

Steve first approved host workspaces only. A Docker workspace has neither the host's devices nor
its loopback network, so it reports `container_compute`. Runners then got port bridges: the
listener is the folder machine's own compute `network.listen(ctx, { port, ownerOnly: true })`, so a
host folder, a workload user's folder, and a runner folder all go through one path. USB and
Bluetooth on runners report `runner_compute` with "USB and Bluetooth are not supported on runners."
Steve asked for that to be permanent so apps hide the options, and the API says so. Reasons are
reported on the capability rather than hidden, so a client can explain a missing option. USB needs
`vhci-hcd` loaded and the daemon's user able to write its attach control; the module never loads a
kernel module or changes a permission itself.

## A bridge lives exactly as long as the client's WebSocket

Nothing outlives the client channel unless that is deliberately designed and approved, so a bridge
is not a stored resource with its own lifetime. It exists from the WebSocket that opened it until
that WebSocket closes, and also ends on `DELETE`, archival, and shutdown. There is no table, no
replay after restart, and no durable work, which is also why the module does not use Durable
Functions.

## Port listeners admit only the machine's own user on Linux

A loopback listener is reachable by every local user of the machine, and a bridge relays to a
service on the person's own computer. The listener therefore asks for `ownerOnly`: on Linux the
compute finds the arriving connection in `/proc/self/net/tcp` or `tcp6`, matched by both
endpoints, and closes it unless its socket's owner is the user serving that machine. It fails
closed when the entry cannot be found. The check used to live here and compare against the
daemon's uid, which was wrong for a workload user, whose programs run as another uid; it now lives
in compute, which runs as that machine's user. Other platforms expose no equivalent, and the API
says that every local user can connect there.

A dropped runner connection keeps the listener for the runner's lease, so a network blip does not
end the bridge; a runner that comes back without it ends the bridge with `failed`.

## The kernel's USB/IP connection is one end of a socket pair

`vhci-hcd` takes a socket file descriptor in its attach control and owns the connection from then
on. The daemon creates a Unix socket pair by spawning a tiny shell with an extra `pipe` stdio slot,
hands the child's end to the kernel by writing `"<port> <fd> <devid> <speed>"` from inside that
child, and keeps its own end as the relay to the WebSocket. Closing the daemon's end detaches the
device, and the kernel ending the connection shows up as end-of-file, which closes the bridge with
`device_detached`. A port taken by someone else between reading `status` and writing `attach` is
retried on the next free port; a port still free after a failed write means the kernel refused.
Attaches are serialized so two bridges never race for the same port.

Whether the kernel accepts a Unix stream socket instead of TCP has not been verified on a real
`vhci-hcd`; it checks only for a stream socket. If it does not, a loopback TCP pair is the
replacement.

## Bun cannot hold a client back

Node's `ws` server can pause reading a WebSocket, so a relay whose socket is behind holds the
client back. Bun's server WebSocket, which production runs on, has no such call. Rather than buffer
without bound, a relay ends once its socket is 16 MiB behind: a port connection closes with `1011`,
and a USB bridge fails. The kernel reads a USB/IP connection promptly, so in practice this bounds
only a program on the workspace's machine that stops reading a port connection.

## Admission and archival must not interleave

Resolving a workspace is asynchronous, so an archival could land between the check that a
workspace is usable and the bridge being registered, leaving a bridge on a workspace nobody can
see. The module counts archivals; an admission that saw the count change while it was resolving
resolves again, and registration happens synchronously right after a clean resolution. From then
on the bridge is in the table archival ends bridges from.
