# Daemon HTTP transports

The Node runtime binds its standard HTTP server directly. In the standalone Bun runtime,
the native HTTP server owns ordinary HTTP parsing, connection reuse, and local terminal
WebSocket upgrades. The public Unix socket retains a bounded admission adapter for raw
CONNECT tunnels and opaque remote attachments.

```text
Public Unix socket
  ├─ CONNECT / remote attachment → raw tunnel adapter
  └─ ordinary HTTP / local WebSocket → Bun.serve
       ├─ HTTP → reusable streaming HTTP pool → existing API handler
       └─ WebSocket → authenticated terminal attachment
```

The internal HTTP hop preserves the API's existing IncomingMessage/ServerResponse boundary,
including authentication on every request and route-specific body limits. It streams bodies in
both directions, preserves end-to-end headers, removes hop-by-hop headers, propagates cancellation,
and never retries requests. Its pool is bounded and is destroyed with the listener. Active streams
have no idle timeout; idle native HTTP connections expire after 60 seconds.

The raw adapter examines only connection admission and tunnel handshakes. It does not parse
ordinary HTTP bodies or delimit subsequent HTTP requests. CONNECT and opaque remote attachments
use dedicated connections that become bidirectional byte streams. Ordinary HTTP connections can
serve multiple requests and subsequently upgrade to a local terminal WebSocket.

Run the package's transport unit tests and `scripts/smoke-binary-transports.mjs` for changes here.
The smoke covers real Bun keep-alive, authenticated SSE, WebSocket reuse, and workspace CONNECT.
Node-only tests do not establish Bun socket compatibility.
