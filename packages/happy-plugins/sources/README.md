# Sources

This directory contains the public plugin types, Unix-socket client, MCP, compute, network, and hook
event streams, in-memory authoring host, and no-Docker development runner. `index.ts` is the package
boundary. Apps are
manifest-declared static folders rather than an SDK lifecycle. The fake host mirrors projects,
workspace commands and bounded files, sessions, provider usage, MCP calls, app-scoped MCP calls,
plugin-private storage, HTTP request handlers, and HTTPS tunnel observations.
The compute test host mirrors provider registration, deadline-bound lifecycle calls, and
generation retirement. Compute remains a plugin-to-plugin abstraction and is not yet used to host
agent sessions.
Workspace command execution, path resolution, and file access are one shared implementation used
by both the fake host and Happy Agent through the package's internal host export.
It enforces the same tool visibility, JSON/key/value/count/quota rules, and manifest bundle
validation as Happy Agent.
It creates a production-shaped writable data directory in a short operating-system temporary root
and removes the root on close. A production plugin must register every startup contribution and
then call `happy.ready("Ready.")` within Happy's startup window; startup registration after
readiness is rejected. The test host can invoke registered system-prompt middleware and publish
tracing observations without a daemon.
