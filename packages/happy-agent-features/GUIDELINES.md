# Happy Agent Feature Guidelines

Use these rules for every feature in this package. They capture mistakes found
while building and reviewing the first Rig v2 features.

## Feature boundary

- Build one shared feature instance for an `AgentSystem`. Put per-agent durable
  state in the supplied feature `AgentKV`, collection state in `sharedKV`, and
  in-progress state in `runKV`.
- Agent Base scopes Agent KV, `sharedKV`, and `runKV` by feature name. Keys
  must be unique within one feature, but two different features may safely use
  the same literal key; do not add a second cross-feature namespace or infer a
  collision without tracing `Agent.scopeOf`.
- Avoid mutable in-memory state. It cannot survive restart or coordinate across
  processes, so it must never be authoritative. Keep it only for genuinely
  ephemeral, non-persistable observations.
- A feature must not choose or open a database, file, directory, timer service,
  process, network client, or other external resource. Inject a narrow
  structural store, service, factory, clock, or scheduler owned by the host.
- Do not import Rig or another feature. Cross-feature behavior uses a structural
  callback or service supplied by the host. Default cross-agent access is
  denied until an injected Collaboration policy authorizes it.
- Do not change `happy-agent-base` to make a feature easier to implement.
- Tools use one common provider-neutral surface. Do not add vendor-specific
  wrappers, compute, permission review, or autoreview behavior here.

## Runtime types and configuration

- Define every runtime shape with TypeBox first and derive its TypeScript type
  with `Static`. Do not maintain a parallel interface, compatibility alias, or
  handwritten predicate for the same shape.
- Injected services, stores, listeners, callbacks, and clocks are part of the
  runtime option contract too. Describe their callable surface with TypeBox,
  reject unknown nested keys, derive the exported options type from the schema,
  and export the public options schema. `Type.Unknown()` plus manual `typeof`
  checks is not a TypeBox-first contract.
- Make schemas describe the real semantic contract. Use discriminated unions
  for conditional fields instead of a broad schema followed by duplicate
  handwritten validation.
- Validate constructor options, public method inputs, injected store results,
  and persisted KV before use.
- Shape validation is not semantic validation. A host result must also match
  the requested identity, operation ID, target version, scope, and other
  invariants before the feature stores, projects, or announces it.
- A replay receipt is not a second source of truth for host-owned collection
  state. Validate its identity and fingerprint, then reconcile its returned
  record or archive with the authoritative host catalog before returning it;
  a schema-valid but corrupted receipt must not override the catalog.
- Revalidate a mutation result after the injected transaction returns. A
  malformed transaction adapter can substitute another schema-valid callback
  result; the outer feature boundary must still enforce the requested identity,
  normalized input, operation ID, and terminal state.
- A validated factory function does not validate the object it returns. Define
  and check a narrow TypeBox contract for every injected persistence, runtime,
  broker, or catalog result before calling methods on it; do not leave factory
  returns as `Type.Any()`.
- If the feature's public contract requires a host capability, make that
  callable required in the injected TypeBox schema and always invoke it. Do not
  mark it optional and silently return an empty value when the host omitted or
  misspelled the capability.
- Snapshot and validate the expected mutation result before handing it to an
  injected transaction callback. Compare the transaction's returned value
  against that detached snapshot; comparing two aliases of the callback result
  lets an adapter mutate the object in place and validate the mutation against
  itself.
- Bound strings, collection sizes, page sizes, output sizes, and pending
  in-memory or KV state. A format-time cap does not excuse an unbounded store
  read.
- Recursive JSON needs an explicit maximum depth as well as per-level string,
  item, and property limits. Enforce a final encoded-byte limit at the
  persistence boundary too: bounded leaves do not bound an arbitrarily deep
  tree or its serialized payload.

## Transactions and events

- Do not add feature-level in-memory locks. Perform the whole read-decide-write
  mutation inside the injected store transaction and require that transaction
  boundary to provide the necessary serialization. If an external system needs
  coordination that a database transaction cannot provide, its injected host
  adapter owns that coordination.
- Run the transactional listener inside the mutation transaction.
- “Post-commit” means after the host's outermost transaction commits, not merely
  after a nested feature transaction callback returns. Require the injected
  store or host boundary to register an outermost-commit callback.
- Make commit-registration timing explicit. If `afterCommit` may be async, await
  registration inside the mutation transaction; if registration must be
  synchronous, encode that in the callable contract and test rejection of an
  async/malformed adapter.
- Allocate one stable TypeBox-validated event identity and timestamp per
  mutation. Deliver the same event to transactional and post-commit listeners.
- Clone and deeply freeze a validated event before either listener receives it.
  Do not share mutable task, record, array, or result references with callers;
  a transactional observer must not be able to alter what post-commit
  observers later receive.
- Define listener failure behavior. A post-commit listener failure must be
  contained or reported through an explicit callback; it must not make a caller
  observe failure after durable state already committed.
- Do not publish heap state, promises, notifications, or events before commit.
  Durable writes happen in the transaction; only the corresponding in-memory
  publication happens after commit.
- Trusted feature-hook failures do not need elaborate recovery machinery.
  Preserve rollback correctness and focus recovery work on process crashes.
- A database transaction cannot roll back an external file, process, or
  network side effect. Inject an explicit host staging/commit/rollback
  boundary—or a compensating cleanup operation—and test cleanup when a later
  catalog write or transactional listener fails.

## Durable tools and idempotency

- A durable tool may execute again after a process restart. Re-execution must
  not duplicate externally visible state or events.
- Do not make the model invent persistence or idempotency IDs. Allocate an ID
  from the configured factory and keep it in the tool call's durable,
  call-scoped `AgentKV`, then reuse it on retry.
- Every durable mutation tool needs that operation identity, not only create.
  Cancel, stop, resume, update, revert, and similar calls can replay after an
  intervening opposite transition, so current-state no-ops alone are not an
  idempotency boundary.
- Make normalized identical mutations no-ops. When equality is insufficient,
  use a stable repeat key owned by the host store.
- Provider call IDs are correlation data, not globally unique feature record
  identities. Allocate a feature-owned durable ID.
- Thin tools call the same public operations used by the host. Tool results and
  model-facing text must include the bounded detail required to use the feature;
  structured return values alone are not automatically visible to the model.
- A model-facing page must not advance its cursor past identities hidden by
  output truncation. Either make every returned identity visible in a compact
  row or reduce the returned page so its next cursor advances only past visible
  items; provide a detail tool for the remaining fields.
- Detail output must put every identity needed by a follow-up mutation before
  optional prose. When a validated invariant makes a compact representation
  exact—such as a contiguous version range—prefer that representation over
  truncating individual target identities.
- A nonterminal page must also make progress: every returned next cursor must
  be strictly beyond the requested cursor and expose at least one complete
  item or identity. Test the minimum output budget with maximum-length IDs so a
  valid page cannot repeat the same empty slice forever.

## Agent Base identity and metadata

- Target the published `@slopus/happy-agent-base` version selected by the
  package. Do not rely on an unreleased workspace implementation.
- When an agent has an external identity, pass the stable caller-owned ID to
  Agent Base at creation. Put descriptive and routing data in agent metadata
  instead of maintaining a parallel in-memory link map.
- Give every sent or steered message a stable caller-owned ID. Put immutable
  feature and protocol correlation in message metadata, then route accepted
  messages from `accepted.id` and `accepted.metadata`.
- Test identity reuse after presentation-event retention and while the first
  request is still unprojected. An identical retry returns the original durable
  result; different content or settings under the same identity is rejected;
  neither path may register a bridge wait that Agent Base will no-op forever.
- Treat message metadata as persisted correlation, not authorization. Validate
  a feature-owned TypeBox shape before using fields from the open metadata
  record.
- Preserve the complete validated protocol content when bridging into Agent
  Base, history, and retry fingerprints. Do not replace structured text/image
  blocks with display text or silently drop an unsupported block; carry it
  through or return an explicit unavailable error.
- Pass the shared transaction context into agent creation, send, and steer when
  feature or host projection must commit with the Agent Base operation.
- Prefer Agent Base's idempotent persisted identity boundary over a duplicate
  feature receipt table. Add a host repeat-key table only when it carries a
  distinct contract Agent Base cannot represent. Such a table needs exact
  indexed lookups, bounded startup queries, and an explicit terminal/session
  retention or pruning path; never recover by scanning all Agent Base records.
- Async observational hooks are awaited. Contain optional observer failures
  deliberately; never create an unbounded promise chain to preserve a
  synchronous assumption from an older Agent Base version.
- An explicit setting clear is a real value transition. Do not translate
  `null` or an off toggle into omission when omission means “keep the previous
  value.”

## Stores, paging, and persistence adapters

- Store contracts perform bounded paging, filtering, and listing at the storage
  boundary. Never require a host to load an entire archive so the feature can
  slice it afterward.
- Validate that every returned page obeys the requested limit in addition to
  validating its item schema. A conforming item array can still violate the
  store's bounded-read contract.
- Cursors name stable source positions. Test forward, backward, partial previous
  pages, pruned prefixes, filtered pages, empty histories, and cursors beyond
  the final match.
- Validate complete persisted invariants on every load, including configured
  cardinality, unique identities and ordering, referential integrity, and
  acyclicity where applicable.
- Rig adapters stay thin. SQL and query-builder code belongs in semantic
  persistence operations under Rig's persistence tree, not in the feature
  adapter.
- When an in-memory test store and a SQL store implement the same filter, add
  parity cases so metadata or serialized JSON keys cannot accidentally change
  search semantics.

## Lifecycle and composition

- Put protocol projection after every configurable feature in the host feature
  array so it is the final transactional observer.
- In an Agent Base-enabled server, every agentic route must either call the
  Agent Base host facade or return a clear unavailable response. Audit related
  broadcast, context, compact, reset, rewind, and configuration routes
  together; a single unconditional legacy-session call silently revives the
  runtime being replaced.
- Verify the real daemon startup wiring, not only a service constructor test.
  Recovery callbacks and stores that are optional in a helper signature can
  silently be absent from the production call site.
- Never persist terminal or other correctness state from a non-transactional
  fallback after the transactional operation rolled back.
- A nested persistence transaction is not an outer commit. Tests for protocol
  projection must use the real session implementation and prove that an outer
  rollback changes neither SQLite nor the live session heap/events. Fake
  sessions cannot prove this boundary.
- Restart tests must include multiple queued messages with distinct run
  metadata. Restoring only the currently visible run can strand the remaining
  durable queue.
- Process-crash recovery must rebuild host routing from persisted Agent Base
  identities and metadata before the live system resumes. A heap-only bridge
  registration is not recovery, even when durable agent and message rows still
  exist.
- Presentation-event retention must not become identity retention. Validate a
  caller-supplied message identity and its immutable fingerprint against the
  durable Agent Base envelope (or a bounded host receipt with a distinct
  contract) before accepting a retry.
- Never project into a legacy mutable heap during a nested transaction and
  assume a later outer rollback can undo it. Stage heap, event, and notification
  work for the host's outermost post-commit callback, and never write a
  correctness event from a fallback observer after transactional settlement
  rolls back.
- A durable queue may contain several messages for the same run. Recovery and
  projection must select by persisted message identity and metadata, not by the
  first or last in-memory registration.
- Collaboration owns agent creation, listing, directed reply obligations,
  scheduling, and waits through an injected host store. Waiting is an ordinary
  durable tool call.
- For creation or message submission that must update host metadata atomically,
  start the shared host transaction, pass its transaction context to Agent
  Base, and write the host repeat-key or roster row in that same transaction.

## Required tests

Every stateful feature should cover the applicable cases:

- public methods and tools use the same behavior;
- persistence survives a fresh feature instance or process-style reload;
- malformed persisted state is rejected;
- nested outer rollback emits no post-commit event;
- concurrent mutations remain correct through the injected transaction;
- durable tool replay is idempotent;
- transactional and post-commit listeners receive the same stable event;
- listener failure follows the documented containment policy;
- configured bounds are enforced at the store boundary;
- model-facing output contains the detail the model needs;
- cross-agent access is denied by default and allowed only by an injected
  policy.

## Review pipeline

- A Luna Max implementation pass owns the feature and its focused tests.
- A different Luna Max review pass checks the implementation against this file,
  the package plan, public contracts, transaction semantics, persisted
  invariants, bounds, replay, and model-facing behavior. It does not edit until
  findings are handed back.
- Give each delegated implementation or review a self-contained narrow brief
  with only the context it needs. Do not fork unrelated later lane assignments
  into a reviewer; ambient feature chatter can be mistaken for a replacement
  task and silently change the reviewed scope.
- The implementation pass fixes concrete Luna findings and reruns focused
  validation.
- A distinct Sol High review is the final release gate. Sol reviews only after
  the Luna implementation and Luna review agree the feature is ready.
- Feed every recurring or generalizable review mistake back into this file
  before starting the next feature.
- Commit a feature only after its final Sol review has no blocking findings.
  Keep the commit coherent and limited to the feature, its tests, exports,
  narrow host adapter, and directly required dependency wiring.
