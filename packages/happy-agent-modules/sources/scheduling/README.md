# Scheduling

Waiting, and messages that arrive later. Scheduling keeps its own time: it owns the durable rows,
arms its own timers, and when one fires it delivers the message itself through the agent
collection. Nothing outside the module holds an alarm or performs a delivery.

```ts
const scheduling = new SchedulingModule();
```

The constructor takes nothing. Scheduling reads the clock, mints its own cuid2-shaped identities,
and holds its own timers; its bounds are module constants rather than knobs —
`MAX_SCHEDULING_WAIT_DURATION` and `MAX_SCHEDULING_HORIZON` are 24 hours, `SCHEDULING_PAGE_SIZE` is
50, `SCHEDULING_OUTPUT_CHARACTERS` is 8,000, and a scheduled message may be up to
`MAX_SCHEDULING_MESSAGE_LENGTH` characters. The module's tables are its own, created by its
migrations, and every database operation runs on the Drizzle facade from `ctx.db`.

## Waits

Every agent gets `wait` and `wait_until`. Durations are seconds, minutes, hours, and days, as
fields or as text such as `90 seconds` or `1h 30m`; dates are ISO 8601, RFC 2822, or a Unix
timestamp in seconds or milliseconds, and a date already past resolves at once. Both are bounded to
24 hours, which the tool descriptions say out loud.

A wait is claimed in a short transaction, suspended outside every transaction, and settled in
another short transaction, so a day-long wait never holds a write lock. It survives a restart: the
durable tool call runs again, finds its own row still waiting, and re-enters the suspension for
whatever time is left.

Three things end a wait: its time arrives, the turn is aborted, or a message arrives for the agent.
The last one comes from `interruptWaits`, which Happy Agent calls when a person submits or steers into a
session — a queued message does not reach the conversation until the current turn ends, and the
wait is what is holding that turn open. `messageAccepted` ends any wait still standing once the
message really is in the conversation. The result is `elapsed` or `interrupted` and always reports
the time that actually passed, never the time that was asked for.

## Scheduled messages

`schedule_message`, `list_scheduled_messages`, and `cancel_scheduled_message` go to agents that are
not subagents; the module decides that itself by asking the collection for the agent's parent. A
message may be addressed to any agent whose ID the sender knows, including itself — knowing an
unguessable Agent ID is the capability, so there is no separate authorization policy. Only the
sender may list or cancel; the sender and the recipient may read.

A message is `pending`, then `delivered`, `undelivered`, or `cancelled`. Scheduling writes the
pending row and arms its alarm in the committing transaction's `afterCommit`; at start, every
pending row in the table is armed again, oldest due time first, in bounded batches. When an alarm
fires the message goes into the recipient's inbox through `AgentSystemRef.send` on a context of the
module's own, outside every transaction, because a database cannot roll a message back out of a
conversation. The delivery carries the scheduled message's own ID, and Agent Base accepts an ID
once, so a redelivery after a crash is recognised rather than duplicated. What became of it is
recorded in a short transaction afterwards. An undelivered message keeps its bounded failure text
and stays with its sender.

Delivered messages are stamped with the sending agent, never as user origin, so the automatic
permission reviewer treats them as agent-generated context rather than human authorization.

## Events

Subscriptions are taken after construction and each returns the function that ends it:

```ts
const stop = scheduling.onEvent((ctx, event) => project(event));
scheduling.onEventTransactional((ctx, event) => mirror(ctx, event));
```

Every subscriber receives one detached, deeply frozen event: `wait_started`, `wait_finished`,
`message_scheduled`, `scheduled_message_cancelled`, or `scheduled_message_delivery_outcome`.
`onEventTransactional` runs inside the transaction that commits the change, so throwing from one
rejects the mutation that produced it. `onEvent` runs through stdlib `afterCommit(ctx, …)` once the
outermost transaction has committed; nothing there can undo a committed change, so a failing
subscriber is logged through `ctx.log` and the remaining subscribers still see the event.
