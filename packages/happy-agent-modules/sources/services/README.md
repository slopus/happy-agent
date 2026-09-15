# Workspace services

This feature owns workspace-scoped service control and access. Its internal credential issuer
binds browser establishment credentials to the authenticated principal, workspace, service, and
exact execution. Credentials never belong in tools, URLs, events, or page JavaScript.

`persistence/ServiceRecords` keeps durable metadata in the supplied shared AgentKV. Its bounded
active index and immutable history pages support workspace discovery without scanning all history;
transactional capacity and teardown checks keep lifecycle decisions consistent.

`ServicesModule` resolves project roots, managed workspaces, bot workspaces, and inherited agent
placement through their owning modules. It records creation and a Durable Functions invocation in
one transaction. A durable spawn claim permits only one attempt; recovery confirms teardown without
replaying the command. Native completion, rather than a shell exit notification, releases capacity.
An owning-agent abort also revokes durable work that has not spawned yet.

The ordinary process-stop path records service revocation in the caller's transaction and signals
only after commit. Services remain independently owned after their initiating tool or turn ends.
A bounded endpoint probe reports connection readiness separately from process liveness. Completed
runtime handles retire within one hour, at most 256 per workspace and 4096 per daemon.

```text
authenticated API scope -> daemon-lifetime issuer -> five-minute credential
CONNECT scope + credential -> signature/expiry/scope validation -> live-runtime admission check
```

Signature validation alone never admits a connection: the runtime must still be running and
unrevoked. A new daemon issuer invalidates every old credential.

The controller is not yet installed in product composition. Agent output/input tools, archive
barrier subscriptions, the authenticated HTTP gateway, and the Desktop integration are still being
connected against the published service contract; this directory does not create a public listener.
