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

Create and send validate the complete original request before resolving an idempotent retry.
An existing user message or pending input returns its original resource before checking whether
its submitted provider is still available. Queue admission, the duplicate claim, pending history,
and last mode are atomic. Steering waits for the current inference and its tool batch, then owns
one run boundary; ordinary queued inputs share the next run and keep their individual modes.
Explicit requests retain the public user control block while excluding it from provider input,
and use one fresh call identity for the requested assistant message and its result.

Provider failures must survive the inference-to-settlement boundary. The active run now retains
its terminal reason, so error settlement finishes the archive as failed instead of completed.
The error remains a human-readable service message, as required by the published client schema.

Canonical History owns exact requested arguments, including inputs too large or complex to run.
Those limits fail the accepted tool call before execution. Public message events retain the exact
message, while private durable message events store a compact History reference to stay within
their separate 5 MiB bound. Full original raw event and hook parity remains migration work.

Health must answer while database restoration waits. The authenticated listener now serves
starting health before restoration, and shutdown closes workers and storage even after failed
initialization. Serialized TypeBox validators compile once into an immutable shared collection;
compiling the same expanded schemas separately in every module delayed the starting listener.

Common tools and vendor tools have separate fixed-array entry points and one shared composition
path. The common history definition is identical for every model. History owns its archive reads,
target validation, full-content search, bounded rendering, statistics, and original-position
cursors. Reading an uncreated agent returns an empty archive and still includes it in the roster.
Eleven original-source golden results cover those semantics through real native turns and restart.

The explicit-request argument limit must not become a limit on every tool's parsed input. History
now checks the durable indexed call's requested marker before enforcing it. Ordinary provider
calls use their own tool schema, and History retains oversized structured arguments as the
original raw JSON string. This avoids both rejecting more permissive tools and leaving an ordinary
call permanently unable to flush its owning inference before execution.

Model compatibility comes from the original provider-family matrix, including resolved Bedrock
regions for GPT models. Compatible selections retain private inference context. An incompatible
selection clears only that context, keeps public History, clears the context estimate, and inserts
the original bounded history handoff in the same input-acceptance transaction. The full notice
matches an original-source golden through three real model selections and restart. Effort, tier,
and permission changes preserve context; choosing the regular tier removes the stored priority
option and omits it from the provider request.

Provider retry safety must be checked at the actual provider seam. A real failed Responses attempt
that completed tool items before its retry retains neither those items nor their shell effects.
The native provider commits one complete attempt, so this scenario needs a regression fixture
without additional rollback machinery in the outer loop.
