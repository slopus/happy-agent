# Auto module — learnings

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
  curated catalog, and an account may be signed out, expired or out of quota. Such a route is
  unavailable, never a verdict: a provider that cannot be built (checked before the reviewer is
  rebuilt for a new route), an inference that never started, an explicit missing-model error, or
  a provider error classified `authentication` or `out_of_tokens`. The last two mean the account
  itself refused, so its other models are skipped for the rest of that review. Each failed route
  is discarded and the next gets complete evidence, within the original review deadline and
  cancellation signal. Denials, malformed normal answers, and ordinary inference failures never
  trigger fallback. No failed-route blacklist survives the review; a route change rebuilds the
  private conversation rather than continuing another model's review history.
- Routes used to stop at the agent's own account and then Happy's default model, so a signed-out
  default account left no reviewer while other accounts were logged in, and with only Antigravity
  signed in Auto had none at all: Happy cannot call Gemini directly and the reviewer never ran on
  a harness. By the user's decision the order is now: the agent's own account (its v1 precedence,
  or for a harness model the account's hidden Sonnet, Codex Auto Review or GPT-5.4 routes), then
  Happy's default model's routes, then every other enabled account in `config.models` order on its
  first model, and last `antigravity/gemini-4-hydrogen` at `low` on an enabled Antigravity
  account. Only that last route runs on a harness, and only Antigravity can: Happy starts agy with
  `tools: []` (none of its own tools, not even web search, through
  `ConfigModule.readOnlyHarnessProvider`) and its turns always `read_only`, so it reaches only
  Claude's reviewer array plus the reviewer's History and `ask_parent` tools over MCP, with the same
  Guardian prompt, transcript, `SECURITY.md` and verdict tags. Live, Hydrogen low allowed a
  user-authorized outside write in about 4 s every time and decided a force push in 11–15 s: denied
  3 times, and allowed once when the person's own message spelled out that exact push for the
  sub-agent. Gemini 3.8 Flash denied all four but took 6–56 s, so Hydrogen is the reviewer. With
  no route at all the review fails with `NoReviewerModelError`, and with every route unavailable
  it fails saying no reviewer could run.
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

- The reviewer prompt tracks Codex's bundled Guardian prompts as literally as possible. A user
  approved sending excerpts to their own Cloudflare account, in their own words and after hearing
  the risk, and v1's policy still refused it: its exfiltration rule denied "even when
  user_authorization is high", contradicting its own post-denial approval rule, and the rationale
  cited a "tenant policy" the user could not find. Codex had already replaced that rule with
  "allow egress where the user has specifically authorized that payload for the end destination",
  kept secret exfiltration `critical`, and made post-denial approval unable to lift `critical`.
  A hand-written precedence list fixed the incident but drifted from Codex, so by the user's
  decision both prompt files are now Codex's text at openai/codex f2b94ef (2026-11-04), assembled
  through the same `{{ tenant_policy_config }}` and `{{ extra_policy }}` slots, with only the
  differences listed in `createPermissionReviewInstructions.ts`. Keep that diff minimal, and
  update the recorded commit and differences whenever the prompts are re-compared. Alignment
  outweighs prompt size: the aligned prompt is about 20,400 characters without `ask_parent`.

- Reading delegators' history was not enough: a reviewer still denied a child's action when the
  person's request lived only in the parent's context, or was phrased so that only the parent
  could say whether it covered the action. By the user's decision a reviewer whose reviewed agent
  has a parent now gets `ask_parent`, and its prompt tells it to ask before denying for unclear
  authorization or intent. The user first described forking the parent's session, then corrected
  it: the question goes to the parent's _reviewer_, never the parent session. `ask_parent` builds
  a new private agent as a fresh (rebuild) review of the parent would be built — the parent's
  reviewer route, the parent's reviewer instructions, the parent's whole evidence transcript up
  to its latest message, the normal reviewer tools — puts the question in place of
  `<proposed_action>`, takes its trailing text as the answer, and erases it. The parent's own
  reviewer conversation is not copied: the base does not expose reading a private agent's model
  context, and prior reviews are context, not precedent. Nothing touches the parent agent, its
  evidence, or its reviewer's conversation and cursor, so the fork leaves no trace.
- The fork may ask its own parent the same way, toward the root: at most four hops, never an agent
  already in the chain, the first question inside 60 seconds and 90 seconds of the review's start,
  each further hop 15 seconds less than its asker, and at most two questions sent per reviewer or
  fork (each fork has its own two; a question counts once sent, one refused for lack of time does
  not, and a third is answered with the limit string while the tool stays offered). Stopping the review aborts the reviewer, whose
  tool aborts its fork, whose tool aborts the next. Every non-answer is a plain `unknown: <reason>`
  result rather than a tool error, so the reviewer falls back to its ordinary judgement instead of
  reading the failure as a refusal. Resolving the parent here does not contradict the earlier
  "parents are never resolved for the reviewer" rule: `read_agent_history` still only follows IDs
  the reviewer found, and `ask_parent` never hands the reviewer the parent's ID.
- Sub-agents kept having approved high-risk actions denied, such as a revert pushed to main that
  the person had approved in the parent, because the prompt made `read_agent_history` the general
  path and `ask_parent` an afterthought at the end, and reviewers often denied without asking. By
  the user's decision `ask_parent` is now the primary path for a child: its bullet comes right
  after the one saying authorization may live with another agent, and tells the reviewer to call it
  before reading any history. `read_agent_history` is for lateral requests from an agent that is
  not the parent (a task messaging a bot), for an agent with no parent, and for a parent whose
  answer was unknown or says it did not send the request. Live evals on Sonnet 5 and Codex Auto
  Review, the reviewers Auto uses, needed three wording changes beyond the user's draft. The
  reviewer is never told its parent's ID, so a delegation under `Message from agent <id>:` read as
  lateral and Sonnet went straight to that agent's history; the `ask_parent` bullet now says that
  sender may be the parent. Codex filtered the reviewed agent's own history with
  `roles: ["user"]`, which hides the `AGENT (<id>)` sender headers, and so never found the
  delegator; the bullets now say to read that history unfiltered and to filter by role only in the
  sender's history. Codex also decided from the first page it read; the bullet now says to follow
  the IDs instead. With those, Sonnet passed 30 of 30 runs and Codex 28 of 30, against 9 of 24 and
  7 of 24 on the old prompt. Codex at `low` still sometimes stops after one history read when
  `ask_parent` answers unknown. Messages from other agents have role `agent` and never enter the
  evidence, so a child's reviewer usually sees no delegation at all; eval transcripts should
  reflect that.
- Scripted gym inference cannot show how a real reviewer reads the prompt, so the user asked
  for the real-model eval to be kept, but run only when working on this area: after any change to
  the reviewer prompt, `ask_parent`, or how the reviewer reads history. It is
  `tests/auto/autoReviewPrompt.live.test.ts` with its scenarios in `tests/auto/reviewerEval/`, and
  it runs only through `pnpm --filter @slopus/happy-agent-modules eval:auto-review`, which sets
  `HAPPY_AGENT_AUTO_REVIEW_EVAL=1`. It reviews each scenario on the reviewer routes Auto would
  pick for this installation's own Claude and Codex accounts, resolved through the configuration
  at runtime, with `ask_parent`, `read_agent_history` and the shell answered from the scenario. It
  writes a report to `.context/auto-review-eval/` and fails only when a review could not run; pass
  rates vary by run, so compare them by eye. Baseline when the prompt was made ask-parent-first:
  Sonnet 5 passed 30 of 30 and Codex Auto Review 28 of 30 in development, with Codex's misses in
  the unknown-answer fallback (s3), and both passed 24 of 24 in the suite's first run.
- The guideline is inserted through a `{{ ask_parent }}` paragraph between the first and the
  remaining history bullets. With the tool, the paragraph becomes the bullet; without it, the
  paragraph and its surrounding blank lines collapse so the bullets form one list. The
  placeholder needs its own paragraph because the formatter folds a line directly under a bullet
  into that bullet and puts a blank line between a paragraph and a following list. The history
  bullets are shared, so rewording them changes a root agent's prompt too. happy-cluster mirrors
  the tool name, schema, guideline, fork prompt, bounds, and failure strings; it has not taken
  the ask-parent-first rewording yet and diverges until it does.
- A fork holds a copy of the parent's evidence transcript, user messages included, so it must not
  outlive its question. Stopping the daemon used to abort the review and close the private system
  at once; the closing system refused the fork's abort and delete and waited for its turn, so
  shutdown hung until the fork answered (up to the question's deadline) and the fork then stayed in
  the private store forever under a random ID. `close` now stops every live fork and waits for it
  to erase itself before closing the private system, and a question asked during shutdown is
  answered `unknown`. A stop that lands while the fork's question is still being queued finds no
  turn to cancel, so the fork is aborted again once the question is accepted; otherwise shutdown
  waited for its whole answer. Each fork ID is also written to the private store's `autoForks`
  scope before the fork is created and removed only after it is erased, so a fork a crashed
  process left behind is erased at the next start. Durable Functions was not used: it carries work
  to completion after a restart, while here the only work left after a restart is the erase itself.
