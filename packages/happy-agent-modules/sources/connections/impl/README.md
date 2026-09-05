# Remote transport implementation

`RemoteProxyConnection` owns one bounded HTTP pool, request cancellation, response streaming,
upgrades, CONNECT, and authenticated health checks. It receives sockets from Tailcat and never
replays requests or stores credentials.
