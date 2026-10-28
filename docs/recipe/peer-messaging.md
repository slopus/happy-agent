# Connect two Happy Agents over one WebSocket

Use this recipe when a desktop or private machine should initiate one outbound
connection to a reachable Happy Agent, then exchange messages in both directions.
The desktop needs no incoming port, public address, or reverse URL. The contract
is `API_P2P.md`, installed beside the Happy Agent docs; in a source checkout it lives at
[`packages/happy-agent/API_P2P.md`](../../packages/happy-agent/API_P2P.md).

## Reach both installations for administration

The Happy bot on either installation coordinates both sides using existing
authorized SSH/deployment access or an existing managed connection. Peer messaging
does not expose configuration endpoints. For a managed connection, send an
authorized setup request to the remote Happy bot through the ordinary API:

```text
POST /v0/connections/<existing-connection>/api/v0/agents/<remote-chief-agent-id>/send
```

Follow the main API's authentication and send contract. Its `text` explains the
authorized setup, and `content` may carry a `tool_call_request` with the exact
tool and arguments below. Observe the remote run through that same administration
path. When deploying through SSH, write the equivalent machine `happy.toml`
settings and use the normal configuration reload. Preserve unrelated settings
and check existing runtime overrides first; never hand-edit generated
`runtime.toml`.

Choose stable node IDs: this example uses `desktop` and `server`. The server is
reachable at `100.80.0.20:24780`, through system Tailscale or another private
network. Only the desktop-to-server network direction must be reachable. Use
`wss://` behind a TLS terminator when that is the chosen carrier. This feature
does not provision Tailscale or an embedded Tailcat service.

Generate one private pair token with `randomBytes(32).toString("base64url")` using
Node's crypto module. Hold it in memory or a private file, use the same value on
both installations, and keep it out of reports and command output. Different
peers require different tokens. `<PAIR_TOKEN>` below denotes that value.

## Configure the server, then the outbound-only desktop

Have the server's active admin Happy bot invoke `configure_peer_messaging`:

```json
{ "enabled": true, "node_id": "server", "listen": true, "host": "100.80.0.20", "port": 24780 }
```

Then invoke `set_peer_connection`:

```json
{ "node_id": "desktop", "connection": { "role": "accept", "token": "<PAIR_TOKEN>" } }
```

No desktop URL belongs in that accept record. Poll `debug_peer_connections` until
the server is listening with no error and the accept peer is configured.

On the desktop, invoke `configure_peer_messaging`:

```json
{ "enabled": true, "node_id": "desktop", "listen": false }
```

Then invoke `set_peer_connection`:

```json
{
    "node_id": "server",
    "connection": { "role": "connect", "url": "ws://100.80.0.20:24780", "token": "<PAIR_TOKEN>" }
}
```

Configuration tools acknowledge durable intent admission. Poll debug with a
bounded deadline until both peers report `connected: true` and the **same
session ID**. Desktop must report `listenEnabled: false` and `listening: false`.
The server must have `role: "accept"` and no reverse URL. A connect/authentication
failure appears only as a safe diagnostic.

Equivalent machine settings on the server are:

```toml
[peer_messaging]
enabled = true
node_id = "server"
listen = true
host = "100.80.0.20"
port = 24780

[peer_messaging.peers.desktop]
role = "accept"
token = "<PAIR_TOKEN>"
```

And on the desktop:

```toml
[peer_messaging]
enabled = true
node_id = "desktop"
listen = false

[peer_messaging.peers.server]
role = "connect"
url = "ws://100.80.0.20:24780"
token = "<PAIR_TOKEN>"
```

Tools persist private generated runtime overrides without restarting the daemon.
Project settings cannot configure peer connectivity.

## Verify live health and both message directions

Call `check_peer_connection` on the desktop with `{"node_id":"server"}` and on
the server with `{"node_id":"desktop"}`. Both must report reachable,
authenticated, and ready. These checks use ping/pong over the existing session;
the server does not dial the desktop.

Follow the deployed-node verification rules: create a fresh disposable project
and agent on each installation through its independently authenticated main API,
record the returned Agent IDs and share them with both agents. Check the projects
remain active before each message. The peer API performs no discovery.

From the desktop verification agent call `send_peer_agent_message`:

```json
{
    "node_id": "server",
    "to_agent_id": "<SERVER_TEST_AGENT_ID>",
    "text": "Peer setup probe. Reply through send_peer_agent_message to node desktop, Agent ID <DESKTOP_TEST_AGENT_ID>, saying: Peer round trip complete."
}
```

Observe the source-node/source-agent provenance in the server agent's transcript,
the server agent's reply tool call, and the reply in the desktop transcript.
Verify debug still shows the same session ID on both sides. The successful send
acknowledges durable inbox admission; the observed reply proves both directions
work without another connection.

Reconnect restores the session, never replays messages. A lost acknowledgment
may mean delivery occurred; inspect the recipient and reuse the reported message
ID for a deliberate retry. Archive both temporary projects if still active and
confirm cleanup through the main API. Report live health, round-trip evidence,
outbound-only desktop state, and cleanup without credentials.

## Diagnose, rotate, or disconnect

A bind error concerns only the listening server. A disconnected connector may
have the wrong node ID, token, endpoint, TLS/private-network reachability, or
roles. The two roles must be complementary. A duplicate session is refused until
the old one closes; heartbeat detects half-open sockets.

Rotate the pair token on both nodes with `set_peer_connection`. Old sessions
close and the connector reconnects with the new token. Poll debug and ping again.
`remove_peer_connection` revokes that local peer; configure both sides when
disconnecting a pair. `configure_peer_messaging` with `{"enabled":false}` closes
local sessions and cancels reconnect work after application. Local agents keep
working while the link is unavailable.
