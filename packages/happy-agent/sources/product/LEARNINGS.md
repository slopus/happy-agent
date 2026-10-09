# Native product learnings

The Rust executable must retain the original Happy Agent commands, flags and defaults. Provider
diagnostics alone did not retain the shipped product. Daemon launch now uses the same executable's
`run` role, and the existing public help text remains the CLI authority.

The runtime's database ownership seam must remain the canonical `<database>.lock` SQLite write
transaction, together with the original agent store's matching-token PID lock. A different sibling
lock lets the old and new runtimes both claim one installation. Opened database handles must close
before releasing ownership. Original migration keys retain their declaration order and are checked
as an exact prefix; unrelated tables and opaque payloads are left in storage until their owning
feature reads them.

The Node inspector does not exist in a Rust process. Both existing inspector routes use the API's
documented 409 response for a daemon without inspector support. The public contract stays unchanged.

Document responses preserve the submitted text and the API's UTF-8 byte bounds. Original character
validation alone allowed oversized multibyte writes, and security reads could split a character.
The native API evaluates serialized TypeBox schemas with their UTF-16 string semantics, enforces
the specified byte bound, and truncates external document reads at a valid UTF-8 boundary.

Mutation IDs are correlation values, not deduplication keys. Every successful document write emits
its own event. Mutation admission occurs before reading an HTTP body, so draining waits for writes
it already accepted while rejecting later mutations. SSE hello and drain publication share the
journal lock to keep a concurrent subscriber from missing both the sticky state and its event.

An original tool row means dispatch already happened. Restart may retry only a reloadable tool;
an ordinary shell call returns the original interruption result instead. An unanswered private
call without a tool row has not dispatched and may execute once. The recovered result keeps the
Base call ID in public history and the provider's native correlation ID in inference context.
Pending history blocks must flush under their original inference ID before the result updates
that row. The active public run ID survives both operations and settlement.

Restoration starts only valid persisted owed work. Queued messages alone do not wake an idle agent.
Settlement, tool-result claims, private records, history, and scoped KV cleanup participate in the
same database transaction, with public notifications after commit. Unknown configuration metadata
remains intact. Usage keeps the original five migration keys and attributes provider measurements
to the public run; history reads all selected runs' usage in one grouped query.

On Linux, a zombie main thread can coexist briefly with exiting worker threads that still hold
database handles. The launcher now considers that daemon alive until its thread group has exited,
so a successful kill command also means the canonical database ownership lock can be reclaimed.
