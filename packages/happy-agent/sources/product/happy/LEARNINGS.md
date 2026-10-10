# Native Happy Mobile learnings

Happy Mobile is a private encrypted relay separate from WorkOS Cloud. Preserve
its existing HTTP and Socket.IO vocabulary; carrier failures do not prove that
credentials are invalid. Authenticated machine registration owns that decision.

One machine socket carries all sessions when the relay supports subscriptions.
Negotiate on every connection, keep the previous capacity while probing, and
contract to 64 before opening dedicated sockets against an older relay. Bots
take priority over project conversations; recency comes from durable agent
updates, with the agent ID breaking ties. Releasing a subscription does not
archive its remote session or stop its agent.

Match answers to both the carrier generation and the session link that asked.
A session reopened under the same remote ID must not inherit an older answer.
Leaving a carrier cancels its outstanding requests immediately, including when
the machine socket itself remains open. Forward disconnects on both transports;
the next connect tells the session owner to force its metadata comparison again.

Bound frames, outgoing bytes, unanswered requests, event queues, subscription
batches and connection lifetimes. Cancel all independent socket work before
awaiting it, and close dedicated sockets concurrently so an unresponsive relay
cannot multiply the shutdown deadline by the number of sessions.
