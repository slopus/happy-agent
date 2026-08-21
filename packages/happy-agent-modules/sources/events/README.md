# Events

Durable, bounded event journal shared by every agent in an `AgentSystem`. Every event carries a
strict monotonic UUIDv7 identifier so cursors are time-ordered and lexicographically comparable.

```ts
import { Agent } from "@slopus/happy-agent-base";
import { EventsModule } from "@slopus/happy-agent-modules";

const events = new EventsModule();
const agent = await Agent.create(ctx, { ...options, modules: [events] });
```

The module takes nothing. The live window holds `EVENTS_CAPACITY` (10,000) events — a property of
the journal rather than something a caller tunes — and the module reads the wall clock itself.

## Public surface

- `record(ctx, input: { type, payload, agentId? }): Promise<AgentEvent>` — append a raw event.
  The module assigns `id` (UUIDv7) and `occurredAt`.
- `replay(after?, limit?)` — returns `{ cursor, events, latestCursor }` for the slice after the
  provided cursor, up to `limit`. Passing the module's `originCursor()` replays from the start of
  the window.
- `trim(ctx, through)` — removes the durable prefix through an exact cursor.
- `latestCursor(agentId)` — newest cursor for one agent.
- `activeAgentIds()` — identities whose runs have started and have not reached a terminal event.
- `messageCursor(agentId, messageId)` — durable cursor assigned to one accepted message.
- `subscribe(listener)` — register a post-commit observer. Returns an unsubscribe function.
- `observe(listener)` — register the single `{ onEventTransactional?, onEvent? }` projection
  listener. The transactional callback runs inside the mutation transaction, so its own writes
  commit with the event or not at all; the ordinary callback is invoked after commit via the
  queue's publication path. There is exactly one, because two would share a transaction neither
  owns.
- `cursor()` — current head (newest event id or the origin cursor).
- `originCursor()` — the stable starting position for this instance.
- `capacity()` — the window size, always `EVENTS_CAPACITY`.

## Event shape

```ts
{
  id: string;          // UUIDv7, time-ordered
  occurredAt: number;  // ms since epoch at record time
  type: string;        // e.g. "agent.created", "message.accepted"
  payload: unknown;    // stored as-is (structured clone)
  agentId?: string;
}
```

All event identifiers are validated against a strict UUIDv7 pattern at runtime.

## AgentModule hooks

The module implements the standard `AgentModule` lifecycle hooks and records raw events for:

- `agent.created`, `agent.restored`, `agent.archived`
- `message.accepted`
- `agent.permission-changed`, `agent.metadata-changed`
- `loop.started`
- `provider.event`
- `tool.started`, `tool.completed`
- `inference.completed`, `turn.completed`, `loop.settled`

Payloads are the values supplied by Agent Base at the hook boundary, stored verbatim.

Every event belonging to a run also names it. A loop opens before its first message is accepted, so
`loop.started` is journaled the moment the loop first names its run rather than at the hook that
announced it: the start, the messages accepted into the run, and `loop.settled` therefore all carry
one `runId`, and a loop that never accepts a message is bracketed by its own loop identity.

## Storage and lifetime

The module owns migrations for its event journal, origin cursor, and active provider-run
projection. It reloads the retained window before agents restore. If a process dies during a
provider block, restoration emits a durable `block_reset` and continues the same run identity.

The bounded journal deletes its oldest durable prefix once capacity is reached;
`originCursor()` advances to the last removed identifier so replays can express “from the
beginning of what remains.”
