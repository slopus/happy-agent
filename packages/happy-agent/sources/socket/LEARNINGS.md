# Socket transport learnings

## Team terminals need native Bun upgrades too

Team TCP still used Node's WebSocket upgrade path after standalone moved to native Bun.
Bun 1.4.0's `ws.handleUpgrade` fails after asynchronous authentication yields, so valid WorkOS
members could use ordinary APIs but could not attach terminals. Both transports now share native
Bun HTTP/WebSocket handling and the raw tunnel adapter. Team listeners and internal hops use TCP;
they create neither a local API socket nor a standalone bearer-token file.

The internal workspace HTTP proxy is loopback-only and requires a random, memory-only admission
credential on its first request. That credential is stripped before forwarding, and subsequent
requests on the admitted connection retain keep-alive without parsing HTTP bodies in the adapter.
This prevents moving a formerly private Unix listener onto TCP from exposing an unauthenticated
proxy. WorkOS authentication and onboarding still gate every public attachment.

Prove this under the pinned Bun runtime: a Node-only gym cannot reproduce Bun's asynchronous
upgrade failure. The team smoke must include a real shell's input/output and reattachment, rejected
credentials, and authenticated plain HTTP and nested CONNECT workspace tunnels.

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
