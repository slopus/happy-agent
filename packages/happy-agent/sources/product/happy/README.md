Happy Mobile uses a private encrypted relay protocol separate from WorkOS Cloud.
`socket.rs` owns one bounded Engine.IO/Socket.IO carrier and its unanswered requests.
`sessions.rs` routes the machine carrier to individual session lifetimes and supports
older servers that need a separate connection per session.

    machine socket -> subscription negotiation -> session links
                             |
                             +-> older server -> at most 64 dedicated sockets

The native relay is being ported against the original Happy module. Its tests use
an independent WebSocket relay fixture; API pairing, encryption, durable projection,
and daemon installation must be completed before this transport is enabled.
