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

The module hook installs the same four common tools for every provider: `service_start`,
`list_services`, `service_input`, and `service_stop`. Startup, writes, and stops own their Auto
reviews without elevation; consuming reads and mutations are never replayed after a restart.
Trusted agent placement selects the workspace. Discovery retains every active service plus at
most the newest 256 stopped records, with an explicit omitted-history flag.

Input uses the existing SDK process and capture. Each agent and authenticated API view has an
independent position; read-and-advance is synchronous, writes use the SDK's serialization, and
caller cancellation ends only that bounded wait. UTF-8 response limits disclose truncation.
At most 64 reader positions survive per execution, idle positions expire after 30 minutes, and
positions retire together with the completed capture.

```text
authenticated API scope -> daemon-lifetime issuer -> five-minute credential
CONNECT scope + credential -> signature/expiry/scope validation -> live-runtime admission check
```

Signature validation alone never admits a connection: the runtime must still be running and
unrevoked. A new daemon issuer invalidates every old credential.

Managed-workspace archival closes admission in the same transaction as the optimistic archive
decision. Cleanup progress is versioned workspace state. Removal waits for positive service
teardown; failure retains the directory and exposes a safe blocked status. Managed project roots
have the same removal barrier. Restore reopens admission for new identities and cancels old
cleanup without reviving any execution. Agent and bot archival also revoke owned services through
their existing abort paths.

The controller is not yet installed in product composition. The authenticated HTTP gateway and
Desktop integration are still being connected against the published service contract; this
directory does not create a public listener.
