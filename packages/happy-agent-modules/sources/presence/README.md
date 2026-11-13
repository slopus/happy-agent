# Presence

Presence records whether the person an agent is working with is online, away, offline, in do not
disturb mode, or using a configured custom state. Every catalog definition carries its display
identity (`title` and `emoji`), model guidance (`prompt`), and answer wait policy
(`answerWaitMs`). `null` waits indefinitely, `0` continues immediately, and a finite value gives
the user-input broker a bounded answer window.

`PresenceModule` stores a state selection, custom definitions, and schedules in the Agent Base
database carried by the current `Context`. Direct mutations use `ctx.inTx`; the model mutation
tool declares `transactional: true`, so Agent Base commits its state and result together. The
module keeps no operation IDs, fingerprints, receipts, or replay state.

The module takes the configuration module and nothing else. The catalog of custom states, and the
state this installation starts in, are the person's own settings, so presence reads them itself
rather than being handed a catalog someone else assembled:

```ts
import { ConfigModule, PresenceModule } from "@slopus/happy-agent-modules";

const config = await ConfigModule.load();
const presence = new PresenceModule(config);
```

```toml
[presence]
current = "focus"

[presence.states.focus]
title = "Focus time"
emoji = "🎧"
prompt = "The user is concentrating. Continue independently unless the answer is essential."
answer_wait = "15m"
```

A settings entry named after a built-in state refines that state rather than replacing it: give
`away` a new title and it keeps its built-in prompt and wait policy. `presence.current` is written
once during module startup when no state is stored yet; `presence.until` makes that starting state
temporary and falls back to `online` unless `presence.fallback` names another state. A state named
in `current` or `fallback` that nobody defined is refused at construction.

At most `MAX_PRESENCE_DEFINITIONS` (64) states exist, including the four built-ins, and at most
`MAX_PRESENCE_SCHEDULES` (64) recurring windows. Both are constants: they describe what the
feature is, not something a caller tunes.

## Model surface

`get_presence` reads the effective state and its wait/display guidance. `list_presences` returns
the bounded catalog so a model can choose a custom ID. `set_presence` changes the state; its
description requires an explicit user request before the model does so. It accepts either a
built-in `status` or catalog `presenceId`, plus an absolute `until` timestamp and optional
`fallbackPresenceId`. Every agent is offered the same three tools.

The mutation tool is durable and transactional, so Agent Base commits the stored presence and
completed tool result together without a module-owned replay ledger.

The module tells every agent the effective state, including its default prompt, as a system notice
in the conversation:

```text
Current user presence: Away 🌙. The user is away and cannot be reached. Do not wait for an answer. Decide with your best judgement, keep working, and record anything the user should look at later.
```

Presence is never part of the system prompt. It changes while agents work — the person sets it, a
temporary state expires, a schedule starts — and a system prompt that changes mid-conversation
invalidates the prompt cache and, on Claude models with preserved thinking, the thinking blocks
already sent. The notice is appended instead: each history is told the current state before its
next message or inference, told again only when the guidance changes, and told afresh after
compaction. A history that was told of a presence hears when it is cleared; one that never heard
of any is told nothing while none is set.

## Direct operations

- `read(ctx)` and `state(ctx)` return the effective state now.
- `userInputState(ctx)` returns `{ answerWaitMs, title, emoji, prompt, changesAt? }`.
- `subscribeUserInput(ctx, callback)` hands the callback that state immediately and again after
  every committed change, and returns the function that stops it. [User input](../userInput/README.md)
  calls these two methods directly; there is no policy object between the modules.
- `setPresence(ctx, input)` stores a permanent or temporary catalog selection.
- `clear(ctx)` returns whether a configured state was removed.
- `setTemporary(ctx, input)` stores a state with an expiry and optional fallback.
- `listPresences(ctx)` returns the bounded built-in and custom catalog.
- `setPresenceDefinition` and `clearPresenceDefinition` persist custom catalog entries.
- `listSchedules(ctx)`, `setSchedule(ctx, input)`, and `clearSchedule(ctx, id)` manage recurring
  schedule windows.

`onEventTransactional(listener)` watches changes from inside the transaction that makes them, so a
caller can write its own record in the same commit; a listener that throws rolls the change back.
`onEvent(listener)` watches committed changes. Both return the function that stops watching. A
committed change is durable before anyone is told, so a post-commit listener that fails is
reported through `ctx.log.warn` and never turns a saved change into a failure.

## Storage

Migration `001-presence` creates the state, schedule, and historical receipt tables.
`002-remove-presence-receipts` drops the obsolete receipt table without rewriting the released
first migration. `003-presence-catalog` adds the persisted custom-definition catalog.
