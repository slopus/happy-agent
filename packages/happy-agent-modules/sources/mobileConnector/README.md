# Mobile connector

Phones pair with this daemon by scanning a QR code and then reach it directly over a dedicated,
private Tailcat socket. `MobileConnectorModule` depends on Config, Team, Node, Tailcat, and
Durable Functions. The API module takes it to authenticate phone credentials and serve the
desktop and handshake routes; this module owns the pairing state machine, the device store, and
the exposure.

```text
phone ── server.tailcat:24781 ── Tailcat (own identity, mobile.private.json, binds no port)
                                      │ serve exec: one pipe process per connection
                                      ▼
                         the API's mobile listener (127.0.0.1:ephemeral, flagged as mobile)
                           every request, upgrade, and CONNECT: authenticate() first
                             ├── device token        → the ordinary API as its owner, minus
                             │                         drain, shutdown, debug, mobile-connector
                             ├── pairing token       → POST /v0/mobile-connector/handshake
                             ├── handshake credential → /v0/mobile-connector/handshake[/…]
                             └── anything else       → 401
```

There is one API. The daemon binds the extra listener with the same HTTP stack as its main
transport and gives it to `attachTransport`; nothing opens before that. The main transports
accept no phone credential. Only `TailcatModule.openExposure` is used to reach Tailcat.

## The socket opens on demand

`#reconcile` opens the socket while the feature is enabled and either a pairing is active, a
device is paired, or a pairing ended less than three seconds ago, and closes it otherwise. The
linger lets the answer to the request that ended a pairing, and the phone's woken status read,
reach the phone. Device inserts and deletes schedule the same reconciliation through Durable
Functions in their own transaction, and `attachTransport` reconciles in the background, so a
restart reopens the socket when devices exist without holding up startup. Its status is `disabled`,
`closed`, `starting`, `open`, or `failed`.

## Pairing

`impl/MobilePairing.ts` is one pairing's memory-only state machine:

```text
waiting ──start──▶ committed ──reveal──▶ verifying ──both confirmed──▶ completed
   └───────────────────┴─────────────────────┴──▶ rejected | expired | cancelled | failed
```

- `startPairing` replaces the caller's previous pairing, opens the socket, and shows
  `happy://direct?<base64url JSON>` with the address, port, one-time token, node name, and expiry.
- The token lives only in memory, expires after five minutes, and is consumed by
  `startHandshake`, whatever happens next, a malformed body included. Each owner has one pairing
  at a time. The handshake ID that start returns is the phone's credential for the rest.
- The phone commits to `SHA256(label ‖ A ‖ Nm)` before it learns the daemon's key. A wrong
  commitment, an unusable key, or a wrong confirmation MAC fails the pairing.
- The desktop's `confirmPairing` and the phone's confirmation arrive in either order. When both
  have, one transaction inserts the device with the SHA-256 of its derived token, then the
  pairing forgets its secrets and gives the phone the daemon's MAC.
- A finished pairing stays in the owner's snapshot, and readable by its handshake ID, until the
  next start or cancel. Cancelling an active pairing ends it; cancelling a finished one dismisses
  it; anything else changes nothing.

`impl/mobilePairingCrypto.ts` implements the daemon's half of
the Mobile connector section of [`API.md`](../../../happy-agent/API.md) on Node's crypto, and
`impl/callsEmoji.ts` carries Telegram iOS's emoji table. They are the only implementation in this
repository; phones implement the same document natively. The tests' fake phone, in
`tests/mobileConnector/support`, is written from the document independently of `impl/`; the
module tests drive it through `moduleTransport`, and the gym and Bun transport tests drive it over
real HTTP.

## Owners, devices, and events

The owner comes from the caller's context: the team member's installation-local ID, or
`standalone`. No operation takes an owner as an argument. `authenticate` hands a device credential
an AbortSignal; `revokeDevice` deletes the row and, after commit, aborts it, and the API closes
every request, stream, WebSocket, and tunnel opened with it. A device's `lastSeenAt` moves at
most once a minute. `onEvent` delivers `{ owner, mobileConnector }` after each change commits,
with a UUIDv7 `version` per owner.

## Storage

Migration `001-mobile-devices` creates `happy_agent_mobile_devices`: ID, owner, name, platform,
the unique hex SHA-256 of the device token, `created_at`, and `last_seen_at`.
