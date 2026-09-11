# Socket transport learnings

## Keep Bun and keep ordinary HTTP out of the tunnel adapter

The standalone Bun listener enforced one request per connection to accommodate a bridge that
routed HTTP and WebSockets separately. That defeated client and remote-proxy keep-alive pools.
Ordinary HTTP and local WebSockets now share a native Bun server, so Bun owns request framing,
connection reuse, and upgrades after an earlier HTTP request. The raw adapter is limited to
CONNECT and opaque remote attachment handshakes; it never grows an ordinary HTTP body parser.

The existing API remains authoritative for authentication, request-body limits, errors, and
streaming. A bounded reusable internal HTTP pool adapts native Request/Response streams to that
handler without duplicating its Node request/response implementation. Cancelling an HTTP client
closes its upstream work; responses and uploads are not buffered in full or replayed.

Bun 1.4.0's node:http CONNECT event can fire without delivering socket writes to the client.
Merely removing the old request limit or trusting Node-only tests does not prove tunnel support.
Keep native-runtime smoke coverage for repeated HTTP requests, rejected requests, SSE cancellation,
local WebSocket upgrade on a reused socket, and authenticated workspace CONNECT.
