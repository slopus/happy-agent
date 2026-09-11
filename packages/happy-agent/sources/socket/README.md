# Daemon HTTP transports

The Node runtime binds its standard HTTP server directly. In both standalone and team Bun runtimes,
the native HTTP server owns ordinary HTTP parsing, connection reuse, and local terminal
WebSocket upgrades. The public Unix socket or team TCP listener retains a bounded admission adapter for raw
CONNECT tunnels and opaque remote attachments.

```text
Public Unix socket / team TCP listener
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

Team internal hops bind only loopback TCP and create no Unix socket or standalone token file.
The workspace HTTP hop has a random, memory-only connection-admission credential, stripped before
forwarding to the destination. Ordinary API and terminal requests keep their WorkOS authentication.

After building the modules, run `pnpm --filter @slopus/happy-agent test:bun:transports` for the
asynchronous-upgrade regression. Run `scripts/smoke-bun-http.mjs <bun-executable>` after building
the daemon to check fixture-signed WorkOS authentication, real terminal input/output and reconnect,
HTTP keep-alive, SSE cancellation, and both workspace tunnel forms.
