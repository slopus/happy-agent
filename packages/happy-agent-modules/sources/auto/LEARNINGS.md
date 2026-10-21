# Auto module — learnings

- A short approval can remain available in durable history while the default first page omits it
  and a user-only filter omits the question it answers. Reviewer guidance now starts with recent,
  bounded pages and recovers adjacent question context before interpreting a short answer, then
  checks later revocations and refusals within the review deadline. The question supplies context,
  never authorization. The synthetic gym proves this retrieval path across two delegation hops
  while always denying the proposed command; it does not prove a live reviewer's judgment or the
  cause of a particular refusal. History remains pulled by the reviewer, not inherited or injected.

- The converter used to change every critical-risk allow into a denial while keeping the
  reviewer's approval rationale. An informed user approval reached the reviewer and produced an
  allow, but the agent was falsely told the reviewer had refused again. Critical-risk verdicts
  now pass through unchanged in both Auto and Permissions; the reviewer applies the policy and
  user evidence. Codex likewise uses the returned outcome at execution time rather than a
  hard-coded critical-risk veto. The separate high-risk authorization check is unchanged.

- A user's explicit tool request is structured authorization evidence, not an image placeholder
  and not assistant-generated tool prose. Preserve its exact name and arguments in the durable
  evidence archive and render them under the message's existing provenance. Only positively
  stamped human input is trusted; the generated assistant call remains untrusted. The usual
  preferential retention and incomplete-user-evidence checks apply to requests too.

- Exported bots made outside people's messages user-role messages with a real author, stamped
  with the `guest` origin. Auto needed no change for them: evidence trusts only the positive
  `user` origin, so a guest's message is recorded as untrusted context and rendered as an agent
  message, never as user authorization. The gym proves a guest's request for an escalated command
  is denied while the same request from the owner is allowed. Keep the `user`-only check; never
  widen it to "any human origin".

- The reviewer already accounts for explicit informed user approval after a denial, but the
  agent-facing refusal used to forbid all retries without explaining that path. Agents therefore
  treated a prior denial as permanent even after the user authorized the exact action and its
  disclosed risks. The refusal now permits one fresh Auto review with that new authorization,
  while still forbidding workarounds, repeated retries, and bypassing policy restrictions. This
  changes the guidance, not the reviewer's decision rules or the runtime's independent enforcement.

- The private reviewer system inherits the runtime's stdlib graceful-shutdown coordinator through
  its detached context. It must register as `auto-agent-system`, distinct from the main
  `agent-system`, so both store locks remain visible and awaited instead of one named handler
  replacing the other.
- Daemon draining stops the main agent system before it drains this private reviewer system. A
  main tool already running may still be waiting for an automatic permission review; keeping the
  reviewer available until the main system reaches its edge lets that admitted tool finish instead
  of deadlocking both drains. Once the main system is drained, no new tool can begin a review, so
  the private system can reach its own edge without cancellation.

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
- A reviewer ending in error, length, tool-call, cancellation, or without a completion event has
  made no judgement. Such runs now fail as unavailable; Permissions records an unproven outcome
  with the provider error in its bounded, public reason. A caller-aborted review still follows the
  existing cancellation cleanup and makes no refusal event. A normal but genuinely unparseable
  answer remains a rejected denial, as explicitly requested. Full reviewer transcripts cannot be
  exposed in the recorded review without a human-approved API specification addition.
- A preferred reviewer route is not guaranteed to instantiate just because it appears in a
  curated catalog. Construction failures and explicit missing-model errors now advance once
  through the same provider's reviewer precedence, ending with the active model. Each failed
  route is discarded and the next gets complete evidence, within the original review deadline
  and cancellation signal. Denials, malformed normal answers, and ordinary inference failures
  never trigger fallback. No failed-route blacklist survives the review; a route change rebuilds
  the private conversation rather than continuing another model's review history.
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
- About a third of denied sub-agents were false positives: a person told the parent "sync to
  main" or "release", and the child's push or release workflow was refused with unknown
  authorization because the child's evidence holds only its own messages, and compaction drops
  earlier ones the same way. By the user's decision the reviewer now pulls history itself rather
  than having messages inherited or injected: each review names `<reviewed_agent_id>`, and the
  private reviewer gets History's own `read_agent_history` (`HistoryModule.reviewerTools`) through
  `AutoReviewHistoryModule`. It may read the reviewed agent and any agent whose ID it finds there,
  following delegators upward; parents are never resolved for it, because an unguessable Agent ID
  is the capability. The tool reads through the review's own context, which carries the main
  database, is offered only while that review runs, and is non-transactional so it never opens
  main storage inside a private transaction. Only History's `role: "user"` messages count, and
  the policy requires the person's request to cover the exact action; a delegator's paraphrase
  that widens it does not. The gym proves the delegation evidence is not in the child's
  transcript, so the reviewer must start from the reviewed agent's own history. Those reads add
  reviewer turns, so the user raised the review budget from v1's 90 seconds to 120.
- The module now takes only modules, plus the one structural argument `SPEC.md` §13.3 kept:
  `constructor(config: ConfigModule, compute: ComputeModule, systemPrompt: SystemPromptModule,
history: HistoryModule, storage: AgentStorage)`. The accounts, the catalog and the working folder come from
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
