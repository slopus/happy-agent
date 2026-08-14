# Happy Agent Base reconciliation debt

Rig v2 treats `packages/happy-agent-base` as frozen. The feature migration must
work against its current public hooks and record the gaps below instead of
changing the package as part of feature work.

The current migration has no known requirement to change Agent Base. Earlier
suspected gaps are implementable through the shared transaction and injected
feature stores.

## Implementable without Agent Base changes

The following are feature or host responsibilities, not Agent Base debt:

- Collaboration listing, archival metadata, roles, parentage, directed reply
  obligations, scheduling, and waits use an injected roster/store/broker.
- Collaboration creation opens the shared host transaction, calls
  `AgentSystemRef.create()` with the transaction context, and inserts the
  returned ID into the roster with that same context. It publishes the ID and
  sends work to the child only after commit, so Agent Base creation and the
  roster row commit together.
- Message submission opens the shared host transaction, stores the Rig run,
  message, mutation, and submission metadata under a stable repeat key, and
  sends or steers the Agent Base message with that transaction context. A retry
  reads the same record instead of enqueueing another message. Transactional
  acceptance resolves the protocol projection metadata from this host ledger.
- Waiting is an ordinary durable tool call; no additional feature action is
  required.
- Run outcome and activity projection use transactional loop, inference, turn,
  and settlement hooks plus `runKV`.
- Effort and service-tier changes are observed from the effective feature scope
  during message acceptance and compared with feature KV. Enabling the
  priority tier is implementable; clearing an already-effective priority tier
  from the protocol's explicit `serviceTier: null` transition is not exposed
  by Agent Base 0.0.6. Rig rejects that explicit clear before creating a
  receipt or dispatching the Agent Base message. Reconcile this when Base gains
  a nullable/resettable selection option.
- Stable feature event IDs are allocated transactionally and published through
  injected post-commit callbacks or an outbox.
- Live inference deltas use the awaited async `onEvent` hook; durable completed
  blocks, messages, and terminal events use transactional hooks.
- Cross-feature behavior uses narrow structural services supplied by the host,
  without feature-to-feature imports or a capability registry.
