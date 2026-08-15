# Collaboration

Lets one agent create, message, and wait on other agents as durable collaborators, so a model can
delegate work to a team of agents instead of doing everything in one conversation. Collaboration is
a host capability, not an agent manager: the roster, message store, broker, transaction, timers,
queues, and receipt retention all belong to the host. The feature only validates input, drives the
host's transaction boundary, and shapes what the model sees.

```ts
import { Agent } from "@slopus/happy-agent-base";
import { CollaborationFeature } from "@slopus/happy-agent-features";

const collaboration = new CollaborationFeature({
    roster, // CollaborationRoster: readAgent, writeAgent, listAgents
    store, // CollaborationStore: transaction, afterCommit, message/obligation/receipt CRUD
    broker, // CollaborationBroker: create, config, send, wait, schedule, getSchedule
    authorization, // optional CollaborationAuthorization: authorize(ctx, acting, target, action)
});
const agent = await Agent.create(ctx, { ...options, features: [collaboration] });
```

`roster`, `store`, and `broker` are required; every other option (`authorization`, the ID and
operation-ID factories, `clock`, `listener`, `onPostCommitError`, `maxPageSize`,
`maxOutputCharacters`) is optional and defaulted. One `CollaborationFeature` instance serves every
agent in a collection; each agent's own roster row, and the collaborators it creates, are what
distinguish it.

## Tools

The feature exposes `create_agent`, `list_agents`, `send_agent_message`, `reply_to_agent_message`,
and `wait_for_reply` to every agent. `schedule_message` is added only for a root agent — one whose
roster row has `parentId: null` — because scheduled delivery is a root-agent capability; a missing
roster row is not read as evidence of being root, so the tool stays absent until the projection
exists. Every tool is `durable: true` and answers `shouldReviewInAutoMode: () => false`, so none of
them go through Auto-mode review; each simply calls the matching method on `CollaborationFeature`
with the calling agent's own ID as the acting agent.

- **`create_agent`** — creates a collaborator with a durable role and roster entry. Parameters mirror
  `CollaborationCreateInput` minus `operationId` and `id`: `config` (an `agentConfig`), and optional
  `parentId`, `role`, `groupId`, `title`, and `metadata`. The feature always assigns the new agent's
  identity; the model cannot choose one. Returns the created `CollaborationAgent`.
- **`list_agents`** — lists a bounded page of the roster. Parameters: optional `limit` (1–100,
  default `maxPageSize`), `cursor`, `groupId`, `ownerAgentId`. The result is rendered to the model as
  one line per agent (`id (role): status`) plus a cursor hint, capped at `maxOutputCharacters`; if a
  full page would not fit, the feature shrinks the page rather than truncating a row.
- **`send_agent_message`** — sends a text message to another collaborator. Parameters: `toAgentId`,
  `text` (1–50,000 characters), optional `metadata`, and `expectReply` (`true` opens a reply
  obligation, the default `false`/omitted does not). Returns `{ message, obligation? }`.
- **`reply_to_agent_message`** — answers a pending reply obligation. Parameters: `toAgentId`, `text`,
  optional `metadata`, and `replyTo` (the obligation ID). Only the obligation's designated responder
  may answer it. Returns `{ message, obligation }`.
- **`wait_for_reply`** — blocks until a collaborator answers one of the caller's own reply
  obligations. Parameter: `obligationId`. The host owns the durable wait and may suspend the tool
  call across a restart; returns the settled `CollaborationObligation`.
- **`schedule_message`** — schedules a message for a collaborator at a host-owned due time, with no
  timer or queue owned by the feature. Parameters: `targetAgentId`, `message`, `dueAt` (epoch
  milliseconds). Returns the created `CollaborationSchedule`.

Every mutating tool (`create_agent`, `send_agent_message`, `reply_to_agent_message`,
`schedule_message`, and the write side of `wait_for_reply`) is idempotent by construction: the
feature generates a durable `operationId` (persisted in the calling agent's own `AgentKV` when one
is attached to the context) and a canonical input fingerprint before ever running the host
transaction, so a retried tool call with the same input replays the original result instead of
repeating the effect, while a retry with different input for the same operation is rejected.
Authorization for anything not already settled by durable ownership — a self-owned root, or the
owner of a target's ancestor chain — is delegated to the host's `authorize` callback; a missing
policy is never treated as a grant.

## External functions

These are `CollaborationFeature`'s public methods, called as `collaboration.<method>(ctx,
actingAgentId, ...)` by a host or by the tools above. All take a `Context` first and the acting
agent's ID second, and all return plain, already-validated, cloned values (never a live reference
into host storage).

- `createAgent(ctx, actingAgentId, input: CollaborationCreateInput): Promise<CollaborationAgent>` —
  same operation as `create_agent`, but accepts a host-supplied `operationId` and `id`.
- `getAgent(ctx, actingAgentId, targetAgentId): Promise<CollaborationAgent | undefined>` — reads one
  roster row, subject to `authorize(..., "read")`.
- `listAgents(ctx, actingAgentId, query?): Promise<CollaborationAgentPage>` — same as `list_agents`,
  returning structured data rather than model text.
- `sendMessage(ctx, actingAgentId, input: CollaborationSendInput): Promise<CollaborationSendResult>`
  — same as `send_agent_message`; throws if `input` carries `replyTo` (use `replyMessage` instead).
- `replyMessage` / `reply(ctx, actingAgentId, input: CollaborationReplyInput):
  Promise<CollaborationSendResult>` — `reply` is a descriptively named alias for `replyMessage`.
- `listObligations(ctx, actingAgentId, query?): Promise<CollaborationObligationPage>` — a bounded,
  cursor-paged read over obligations, filterable by `status`, `requesterAgentId`, and
  `responderAgentId`.
- `waitForReply` / `wait(ctx, actingAgentId, input: CollaborationWaitInput | obligationId):
  Promise<CollaborationObligation>` — `wait` is an alias; both accept either the full input object or
  a bare obligation ID string.
- `scheduleMessage` / `schedule(ctx, actingAgentId, input: CollaborationScheduleInput):
  Promise<CollaborationSchedule>` — `schedule` is an alias for `scheduleMessage`.
- `formatAgentPageForModel(page: CollaborationAgentPage): string` — the same rendering `list_agents`
  uses, exposed so a host can reuse it outside the tool.

`CollaborationFeature` also implements the `AgentFeature` contract Agent Base calls directly: `tools`
(assembles the tool list above per agent), `metadataChangedTransact` (keeps the roster row's `title`
and `metadata` in step with the agent's own metadata changes), `beforeAgentLoopTransact` (marks the
agent `"active"`), and `afterAgentSettledTransact` (marks it `"idle"`).

Every mutation that changes durable state emits a `CollaborationEvent` — `agent_created`,
`agent_status_changed`, `message_sent` (optionally carrying the opened `obligation`),
`reply_answered`, or `schedule_created` — carrying `eventId`, `at`, and `actingAgentId`. Events reach
an optional `listener` passed in `CollaborationFeatureOptions`: `onEventTransactional` runs inside
the host's mutating transaction, and `onEvent` runs after it commits, via the host's `afterCommit`
registration. A throw from `onEvent` is reported to `onPostCommitError` rather than surfacing back
into the tool call, since the mutation has already committed.

## Storage

Collaboration keeps no state of its own; every durable value it manages lives in host-implemented
storage passed to the constructor, and the feature only reads and writes through that boundary
inside the host's own `transaction`:

- **Roster** (`roster: CollaborationRoster`) — `readAgent`, `writeAgent`, `listAgents`. Rows are
  `CollaborationAgent` values: `id`, `ownerAgentId`, `parentId` (`null` for a root), and optional
  `role`, `groupId`, `title`, `metadata`, plus `status` (`"active" | "idle" | "waiting"`),
  `createdAt`, `updatedAt`. The feature never deletes a roster row.
- **Messages and obligations** (`store: CollaborationStore`) — `readMessage`/`writeMessage` persist
  `CollaborationMessage` (`id`, `fromAgentId`, `toAgentId`, `text`, optional `replyTo`/
  `obligationId`/`metadata`, `createdAt`); `readObligation`/`writeObligation`/`listObligations`
  persist `CollaborationObligation` (`id`, `requesterAgentId`, `responderAgentId`, `messageId`,
  `status` of `"pending" | "answered" | "cancelled"`, and `answerMessageId` once answered).
- **Replay receipts** (`store.readReceipt`/`writeReceipt`) — one `CollaborationMutationReceipt` per
  `(actingAgentId, operationId)`, holding `kind`, `fingerprint`, and the mutation's `result`. Read
  before every mutating operation runs and written once it commits, so a retried call with a matching
  fingerprint returns the stored result instead of re-executing.
- **Schedules** (via `broker.schedule`/`broker.getSchedule`) — `CollaborationSchedule` rows
  (`id`, `ownerAgentId`, `targetAgentId`, `message`, `dueAt`, `status` of `"pending" | "delivered" |
  "undelivered" | "cancelled"`, timestamps, optional `failure`). Delivery timing, retries, and the
  actual send are entirely the host broker's responsibility; the feature only records that a
  schedule was created.
- **Per-agent call-scoping** — when the context carries an `AgentKV` (`agentKV(ctx)` from
  `@slopus/happy-agent-base`), the feature stores, under keys such as `operation.create`,
  `operation.send`, `create.agentId`, `send.messageId`, `schedule.id`, an `{ operationId,
  fingerprint }` record or a generated ID, scoped to the calling agent. This lets a durable operation
  or tool ID survive a retry even when the caller supplies none; when no `AgentKV` is attached, IDs
  are simply regenerated by the configured factories on every call.

Every timestamp is bounded to `COLLABORATION_MAX_TIMESTAMP` (`8_640_000_000_000_000`, the ECMAScript
date maximum). Metadata objects (agent, message, and protocol) are bounded in depth (8), item and
property counts (64), string length (4,096 characters per string), and total encoded size (16,384
bytes), enforced both by the TypeBox schema and, for create/send/reply paths, by an explicit
pre-schema check so oversized input fails before an ID or operation is ever allocated. Roster and
obligation pages are capped at `maxPageSize` (default 50, hard ceiling 100) and, for `list_agents`,
further shrunk so the rendered text stays within `maxOutputCharacters` (default 8,000).
