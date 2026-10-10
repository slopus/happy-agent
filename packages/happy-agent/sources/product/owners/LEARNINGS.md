# Native durable owner learnings

Node identity belongs to the installation, including when no conversation agents exist. Preserve
the original transactional singleton and its complete avatar asset. Name changes commit their
Durable Functions intent with the state, and the executor reads the current stored name instead
of replaying a name captured in arguments. Config owns the serialized atomic runtime file write.

Global skill disablement keeps the skill installed, readable and watched. The catalog retains its
identity and enablement across disappearance and reappearance. Preferences are written from the
current committed catalog; watcher execution belongs to Durable Functions and releases every
native watch on cancellation or module close.

Frontmatter needs a real YAML parser: line-prefix parsing misses aliases, flow maps, block scalars
and quoted boolean values. Native parsing uses YAML syntax and the original TypeBox metadata
schemas. Its mapping visitor retains the shipped rule that the last string or boolean scalar
wins when top-level keys repeat; only an actual boolean `true` reserves model invocation.

Runners own agent computes after a filesystem reader returns. A bounded strong catalog holds
them until confirmed disposal, while computes keep a weak reference to their owning module to
avoid a cycle. An unconfirmed disposal remains in Closing and cannot execute new work. Report
deduplication follows the runner epoch across reconnects; lease expiry finishes owned sessions
even without another connection. Command requests check their generation after obtaining a
bounded channel slot and again on reply, so a lost handle cannot act on a reused remote ID.

Product stdio uses byte windows rather than a fixed queue of frames: valid bursts of small
chunks must apply backpressure without disconnecting. Stdout credit follows reader delivery,
stderr drains continuously, and input retains only its unacknowledged window. Stream identities
belong to the link across reconnects. Detached programs reattach only when the runner confirms
their retained identities; replay and orphan release run under the connection's lifetime so
incoming output can drain during recovery. A missing stream or the sixty-second lease plus
five-second margin makes the handle terminal without claiming an unobserved process exit.

Runners close their cached native server through a weak singleton reference and finish their own
program handles within a bounded shutdown. Stopping the remote server confirms its local jobs
are gone, while a separate live client link still waits for retained-stream evidence or lease
expiry. Closing the owning client finishes its handles without waiting for that lease. Unopened
or dropped stdout readers discard and credit held bytes, including after exit, so teardown cannot
wait forever on output with no consumer. EOF accepted before a blocked send remains deliverable
on retry after cancellation; repeating the same end offset is safe under the stream protocol.

Native runner replies preserve Source error names and codes, including socket refusal and frame
limits. A reply that exceeds the frame bound returns a small typed error while leaving the link
usable. All 256 stream slots remain available to real programs; duplicate identities are protocol
errors before capacity is considered. A handshake rechecks shutdown while holding the owner lock,
so a delayed welcome cannot create ownership after the server has closed.

A runner connection releases its own session slot when its protocol future is dropped, including
malformed-message and transport cancellation paths. Cleanup cancels pending requests, starts the
lease only for that same session, and cannot remove its replacement. The dedicated runner token
authenticates only the binary WebSocket route. Committed snapshot changes publish the same complete
list to the API event journal. The API owns and joins its bounded connections during shutdown,
flushing one protocol Goodbye before the WebSocket closes.

Directory aliases have separate installation identities and enablement preferences. Discovery
excludes a canonical skill document only when no present, enabled, ready alias still exposes it.
Disabling one alias must not hide a second enabled installation of the same directory.

Missing generated schemas must fail owner construction before recovery starts. Native owners
resolve every required runtime schema up front, so an omitted event validator cannot turn owed
work into an executor failure that deletes its pending call and state.

Catalog reads preserve the Source cursor formats: projects use decimal strings and workspaces use
integers. Pages contain at most 50 rows in fractional order-key and identity order, with a next
cursor only when an extra row proves another page exists. SQL applies archive and project filters
before decoding rows, so unrelated corrupt history cannot break an active catalog. Public catalog
and agent-series methods read the caller's transaction snapshot; API projections stay in the API
module. Compute metadata uses the runner's last committed home without contacting its machine.

Execution scopes follow the Source project location rather than a stored Home path. A Home project
uses the configured default runner's cached home; an unknown home is unavailable, while catalog
compute metadata still reports a null path. Regular local projects refuse execution once runners
are configured. Folder registration validates client-chosen identities, resolves aliases before
the catalog decision, and retains its path and project locks through the caller's atomic change.
An active duplicate keeps its identity and version; an archived duplicate restores that same row.

Managed clone acceptance holds both the canonical folder and project identity locks through the
catalog transaction. Exact retries compare the recorded runner, source and credential descriptor;
a failed clone retries only when its required credential is available, preserving its attempt count.
The initializing row and Durable Functions clone intent commit together. Prepared GitHub tokens stay
in bounded private memory, activate after commit and disappear when a rejected transaction releases
its preparation. Catalog records and events contain only the credential kind.

An explicit standalone import may reuse the installation's GitHub CLI login through a trusted PATH,
a restricted environment and bounded output and time. Explicit environment tokens take precedence,
including blank or invalid values, and team mode never discovers the host CLI account. Background
clone recovery uses only existing in-memory credentials or the environment token getter.

Catalog owners publish complete Source mutation events in the transaction instead of formatting
API deltas themselves. Failing transactional observers roll back the record, association, image
bytes and durable intents together. Source no-ops preserve versions; settling an unchanged workspace
name can advance its version without a rename event. API projections belong to the API module.

TypeBox validates record structure before the Source lifecycle assertions validate its meaning.
Project archival times, Home readiness and failure reasons must remain consistent with the row.
A project update that moves time backward is refused and rolled back; workspace updates advance
to at least the previous update time plus one millisecond, including archival and attachment.
