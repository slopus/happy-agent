# Bridges

Local bridges: a USB device, a Bluetooth adapter, or a TCP service on a person's own computer,
reaching the machine one of their workspaces runs on.

There are two kinds, both opened by an authenticated client over a WebSocket:

- **USB** (`kind: "usb"`). The client runs a USB/IP exporter for one device. The daemon is the
  USB/IP client: it imports the device over the WebSocket, attaches it to the kernel's virtual host
  controller (`vhci-hcd`), and relays the data phase unchanged. Bluetooth is a USB Bluetooth
  adapter carried this way; once attached it is an ordinary controller for BlueZ.
- **Port** (`kind: "port"`). The daemon listens on `127.0.0.1` on the workspace's machine, through
  that machine's compute `network.listen`, and announces each connection over the bridge's control WebSocket. The client accepts one by opening
  a WebSocket for it and relaying it to its own local target, or rejects it.

The other direction, a program on the client reaching a port on the workspace's machine, needs
nothing here: it is the workspace proxy's nested `CONNECT`.

A bridge belongs to the client WebSocket that opened it and lives exactly as long as that
WebSocket. It also ends on `DELETE`, when its workspace is archived, and when the daemon stops.
The module never opens one on its own, for an agent, or for anyone but the person whose WebSocket
it is, and nothing about a bridge is stored.

## Public API

The module has no model-facing tools. A bridge is something a person attaches from their own
computer, not a capability an agent calls.

| Method                                                          | What it does                                                            |
| --------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `list(ctx, ownerId, workspaceId)`                               | What the workspace can bridge, and the caller's open bridges on it.     |
| `admitUsb(ctx, ownerId, workspaceId, request)`                  | Admits one USB bridge before its WebSocket upgrade.                     |
| `admitPort(ctx, ownerId, workspaceId, request)`                 | Admits one port bridge and binds its listener before the upgrade.       |
| `admitConnection(ownerId, workspaceId, bridgeId, connectionId)` | Claims one waiting connection of the caller's port bridge, once.        |
| `closeBridge(ownerId, workspaceId, bridgeId, mutationId?)`      | Ends one open bridge on its owner's request and returns it closed.      |
| `onEvent(listener)`                                             | `bridge.created`, `bridge.updated`, and `bridges.capabilities.updated`. |
| `close()`                                                       | Ends every bridge with `1001` and opens nothing more.                   |

An admission is a `BridgeAdmission`: `attach(webSocket)` once the upgrade completes, or `failed()`
when it does not. The API module owns the routes and the WebSocket server; this module owns
everything after the upgrade and never sees an HTTP request. `ownerId` is whoever the API
authenticated, and every lookup is scoped to it, so another user's bridge is simply not found.

Creation and closing events carry the owner, and the API publishes them to that owner only. The
capability event carries nothing and goes to everyone, because it describes the machine.

## What it depends on

- [`ProjectsModule`](../projects/README.md), [`WorkspacesModule`](../workspaces/README.md), and
  optionally [`BotsModule`](../bots/README.md) and [`TasksModule`](../tasks/README.md) — whether a
  workspace exists and is usable, where it runs, and when it is archived.
- [`RunnersModule`](../runners/README.md) — whether this daemon may act on its own machine, for
  USB, and the folder's machine, whose listener a port bridge uses: this computer's, the workload
  user's runner, or the runner holding the folder.

```ts
const bridges = new BridgesModule(projects, workspaces, runners, bots, tasks);
```

The module subscribes to every catalog's archival when it is built. Archiving a workspace, or the
project, bot, or task it belongs to, ends its bridges with `workspace_archived`. None of the
catalogs knows bridges exist.

Production always uses the kernel's real controller under `/sys`. The one test-only seam is
`BridgesModule.withUsbHostController(projects, workspaces, runners, controller, bots?, tasks?)`,
which replaces that boundary so a test can attach a device without `vhci-hcd`.

## What a workspace can bridge

USB acts on the daemon's own kernel, so only a host workspace can attach a device. A port bridge
listens on whichever machine holds the folder:

| Workspace runs | USB and Bluetooth           | Workspace to local  | Local to workspace  |
| -------------- | --------------------------- | ------------------- | ------------------- |
| On the host    | When the machine probe says | Yes                 | Yes                 |
| In Docker      | `container_compute`         | `container_compute` | `container_compute` |
| On a runner    | `runner_compute`            | Yes                 | Yes                 |

`runner_compute` appears on USB and Bluetooth only, and is permanent: runners do not support them,
and clients hide those options for such a workspace. A runner older than protocol 4 cannot listen
on a chosen port, which a port bridge refuses as `bridge_unavailable` asking for the runner to be
updated.

The machine probe answers `unsupported_platform` off Linux, `vhci_not_loaded` when the kernel has
the module but it is not loaded, `vhci_missing` when it has none, and `permission_denied` when the
daemon's user cannot write `/sys/devices/platform/vhci_hcd.0/attach`. Bluetooth additionally needs
`btusb`, or answers `bluetooth_driver_missing`. Every admission probes afresh, and a background
loop probes once a minute and announces a changed answer.

## Bounds

| Thing                                   | Limit                                 |
| --------------------------------------- | ------------------------------------- |
| USB bridges per daemon                  | 32 (`MAX_USB_BRIDGES`)                |
| Port bridges per workspace              | 32 (`MAX_PORT_BRIDGES_PER_WORKSPACE`) |
| Port bridges per daemon                 | 256 (`MAX_PORT_BRIDGES`)              |
| Open connections per port bridge        | 256, at most 64 of them waiting       |
| Waiting for a connection to be accepted | 30 seconds                            |
| Waiting for the USB/IP import answer    | 10 seconds                            |
| Control message                         | 16 KiB of JSON text                   |
| Binary message                          | 1 MiB                                 |

A connection beyond a port bridge's limits is closed when it arrives. A relay stops reading its
socket while the client's WebSocket has more than 4 MiB unsent. In the other direction it pauses
the WebSocket where the server can; Bun's cannot, so there a socket more than 16 MiB behind ends
its relay with `1011` instead of buffering more.

## Refusals

`BridgeError` carries a `code` the API turns into a status: `invalid_request` for a malformed
request; `not_found` for a workspace, bridge, or connection the caller does not have;
`not_initialized` for a workspace still being prepared; `conflict` for an archived workspace or an
ID already open; `bridge_unavailable`, with the capability's `reason`, for a workspace that cannot
bridge that kind; `bridge_limit`; `port_unavailable` for a port in use or not bindable; and
`unavailable` once the daemon is shutting down. A runner that is not connected surfaces as the
runners module's `RunnerUnavailableError`, which the API answers `503 runner_unavailable`.

After the upgrade, a failure closes the WebSocket with a code instead: `4400` for a protocol
violation, `4404` for an exporter that refused or misidentified the device, `4408` for an import
that never answered, `4409` for no free controller port of the device's speed, and `4502` for the
kernel refusing the attachment.

## Security

- A bridge is opened only by an authenticated client, for that client, and ends with its WebSocket.
- Port listeners bind `127.0.0.1` only, with `ownerOnly`: on Linux the machine's listener checks
  its kernel's socket table and closes any connection that does not come from a process running
  as the user serving that machine — the daemon's, the workload user's, or the runner's.
- Neither kind is visible to another user: listing, events, accepting, and closing are scoped to
  the owner.
- An attached USB device belongs to the whole kernel of the workspace's machine, and its device
  node follows that machine's udev rules. That is the nature of attaching hardware, and the API
  says so.

## Storage

None. The module owns no table, runs no migration, and has no durable work, so it uses no Durable
Functions: a bridge is a live connection, and after a restart there is nothing to resume.
