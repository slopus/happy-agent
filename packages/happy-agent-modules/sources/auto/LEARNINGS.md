# Auto module — learnings

- The private reviewer system inherits the runtime's stdlib graceful-shutdown coordinator through
  its detached context. It must register as `auto-agent-system`, distinct from the main
  `agent-system`, so both store locks remain visible and awaited instead of one named handler
  replacing the other.

- The history module now records who actually sent each incoming message: an accepted message is
  archived as `role: "user"` only when its metadata carries the positive `messageOrigin: "user"`
  stamp this module trusts, and as `role: "agent"` otherwise, with `senderAgentId` naming the
  specific sending agent when the sender identified itself (collaboration deliveries and goal
  continuations now stamp it via `senderAgentIdMetadata`). Provenance is therefore no longer the
  reason the evidence archive exists. The archive is still needed for the human-owned portion of
  interactive answers, generation stamping tied to compaction, fail-closed archive health, and the
  exact trusted/untrusted classification, so it stays.
- `senderAgentId` is attribution, never authorization. The reviewer's trust decision must keep
  resting solely on the positive `messageOrigin: "user"` stamp; a sender ID grants nothing.

- The reviewer now returns its verdict as tagged fields (`<review>` wrapping `<risk_level>`,
  `<user_authorization>`, `<outcome>`, `<rationale>`) instead of hand-assembled JSON. The user
  found a session where the reviewer allowed a `sync to main` push twice and both allows were
  discarded: its rationale quoted the phrase `"sync to main"`, the unescaped quotes made the JSON
  unparseable, and the unreadable answer became a `rejected` denial telling the agent not to route
  around a judgement the reviewer never made. Free text can break a format the model has to
  assemble by hand; tags have nothing to escape.
- Unreadable verdicts are still classified as `rejected`. The user noted that `unavailable` is the
  honest bucket — a verdict that could not be read is not a judgement about the action — but chose
  the format fix first; the reclassification is still open.
- The `messageOrigin` stamp must be the metadata's own property. Reading it through the prototype
  chain lets a shared or polluted prototype authorize every message that omits the marker, which is
  the forgery the positive-marker rule exists to prevent.
- "Whole transcript or delta" is a fact about the reviewer session, not about the cursor's
  position. Deriving it from `reviewedPosition === 0` is wrong whenever the archive is empty: a
  reused reviewer is then sent the whole transcript again, without the follow-up reminder,
  contradicting its own history. Derive it from whether the reviewer was rebuilt.
- An archive row must prove itself by more than its JSON. The denormalized `category` and trust
  flags, and the fact that positions form exactly the sequence the persisted cursor claims, are
  part of what makes evidence trustworthy — a gap, a duplicate, or a flag this store never wrote
  means evidence was lost, and the review has to fail closed rather than judge a conversation
  that never happened in that shape. Coercing a stored flag with `Number` before validating it is
  the same mistake in miniature: `NaN !== 0`, so a corrupt health column reads back as healthy.
- A recreated agent identity invalidates in-memory state as well as durable rows. Bumping the
  generation is not enough: the remembered inference route and the pending call-ID → tool-name
  labels belong to the agent that used to hold the ID, so a review must fail closed on an unknown
  route instead of reusing the previous occupant's model. Compaction is different — the agent
  running the turn is the same one, so its route stays live.
- A per-agent FIFO queue needs the abort signal checked twice: once before queueing and again when
  the queue releases the review. A review whose turn was stopped while it waited must never reach
  the reviewer.
- Once a review reaches the private system, retain and await the private system's reviewer-agent
  abort before discarding the stopped session. A fire-and-forget abort lets cancellation escape
  past cleanup and leaves the next review to discover and delete the stale session while holding
  its FIFO slot. Check the request signal again after installing its listener too: a signal aborted
  during evidence or instruction preparation will not replay its abort event for a listener added
  later, and that stopped review must never be sent.
- The `messageOrigin` marker is no longer this module's file. Collaboration, goal, history and
  scheduling all stamp or read it, so it now lives at the package's `sources/impl/messageOrigin.ts`
  as a shared, module-neutral utility and is exported from the package index rather than from
  `auto/index.ts`. The trust rule is unchanged and still belongs to this module; only the
  definition moved. `SPEC.md` §"Trust" still points at `messageOrigin.ts` as if it were auto's own
  and needs a dictated path update.
- The module now takes only modules, plus the one structural argument `SPEC.md` §13.3 kept:
  `constructor(config: ConfigModule, compute: ComputeModule, systemPrompt: SystemPromptModule,
storage: AgentStorage)`. The accounts, the catalog and the working folder come from
  configuration; the private lifetime is derived in `beforeStart` from the context the base hands
  the module, so nothing it starts is carried by a lifetime that ends before it does; the security
  documents are `ConfigModule.readGlobalSecurity` / `readProjectSecurity`, because configuration is
  what owns those paths; the project instructions are
  `SystemPromptModule.readAgentsMdInstructions`; and the reviewer's read-only tools are
  `ComputeModule.reviewerTools(ctx, scope)`, because the machine a reviewer investigates is the
  compute module's to create, cache and dispose — the module asks for the tools rather than being
  handed a closure that builds them.
- The remaining `storage` argument is a real tension, and it is recorded here rather than resolved.
  `SPEC.md` §13.3 records it as a deliberate, human-decided deviation: this package opens no
  database anywhere, and duplicating the host's SQLite and single-owner-lock mechanics here would
  buy nothing. The package-wide strictness rule says a module's constructor takes only other
  modules. Both cannot be true at once, and the resolution is the user's to make. Two ways out
  exist if it should be resolved: a storage-owning module in this package that opens and hands out
  databases (which would make this package own SQLite, contradicting the reason for the deviation),
  or configuration exposing `paths.autoDatabasePath` / `paths.autoAgentLockPath` — which it already
  does — and this module opening its own store from them, which trades one deviation for a
  different one. Until the user decides, `storage` stays, and `SPEC.md` is not edited.
