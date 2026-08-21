# Murmur

Contacts over one Murmur identity: the people this installation has accepted, and the requests
either side is still waiting on. A client calls this sharing.

The module owns no file and no socket. Murmur's cryptographic state lives in the agent database
like everything else this agent knows, next to one row saying which person the identity belongs
to, so the two can never disagree about who this installation is.

```ts
import { MurmurModule } from "@slopus/happy-agent-modules";

const murmur = new MurmurModule(config, profileModule);
murmur.onEvent((ctx, event) => {
    void events.record(ctx, { type: "sharing.changed", payload: event });
});
await murmur.open(ctx, person?.id);
```

Sharing is off unless the configuration turns it on. Nothing reaches a relay, and no identity is
created, until someone says so.

## Dependencies

The constructor takes modules and nothing else.

- **`config`** — the [configuration](../config/README.md) module. Whether sharing runs at all
  (`sharing.enabled`) and which relay it reaches (`sharing.relayUrl`) are settings, not arguments:
  an identity on a relay is not something an installation should acquire because a caller passed a
  flag. `enabled` is read live, so it is always what configuration currently says.
- **`profile`** — the [profile](../profile/README.md) catalog itself. Sharing puts a person on the
  wire so a contact sees a name rather than a key, and whether this installation may act as that
  person is that catalog's decision rather than something restated here.

The lifetime the relay loop and the store run on is derived by the module itself, the first time
sharing opens: the caller's context is detached and the agent database carried back onto it. Both
outlive every call that touches them, so neither may borrow a request's context. Opening sharing
without an agent database throws `Sharing was opened without an agent database.`

The clock is `Date.now`. Background failures — a relay that will not answer, a subscriber that
throws — go to `ctx.log` on the lifetime they happened on, because there is no caller left to hand
them back to.

`openClient` is a `protected` method holding the one call that needs a network. A test subclasses
the module and overrides it; nothing in the product does. It is handed the store the module
opened, and the module owns the lifetime of whatever it returns.

## Events

`onEvent(listener)` subscribes and returns the function that ends the subscription. Subscribers are
told after the change has happened, so one that throws is logged and the rest still hear it.

## Direct operations

- `open(ctx, profileId?)` starts sharing when it is enabled and there is someone to be. Enabled
  with nobody named is not an error; it resolves when `bindProfile` is called.
- `bindProfile(ctx, profileId)` names the person this installation shares as. This replaces the
  onboarding step the legacy daemon had.
- `snapshot(ctx)` — connection state, contacts, both request directions, the bound profile, and
  a version that changes whenever any of it does.
- `createInvitation(ctx, signal?)` — a capability another installation can resolve, and when it
  stops being resolvable.
- `requestContact`, `acceptContact`, `rejectContact`, `removeContact`.
- `reset(ctx)` throws away the Murmur identity and starts again as the same person: the stored
  keys go, the binding keeps the profile and forgets the identity, and a fresh client binds to
  them. Every contact is lost, because a contact is a relationship with the discarded identity.
  Both halves happen in one transaction, so an interrupted reset cannot leave a record of an
  identity whose keys are gone.
- `close(ctx)` drains work already in flight and starts nothing new.

Rejecting or accepting a request that is not there throws exactly `Contact request not found.`,
which is what the HTTP layer turns into a 404.

## Connection

The relay loop runs for as long as sharing is on. A dropped connection is ordinary — a laptop
closes, a network changes — so the loop reports it, backs off from one second to a minute, and
tries again. Only closing ends it. The snapshot reports `connecting`, `connected`, or
`disconnected` while it lasts; none of it is durable.

## What an event says

Every change publishes a `murmur_changed` event carrying the version that resulted. A burst of
relay callbacks — synchronizing after a while offline delivers many at once — collapses into one
event, because a client only needs to know the state moved. The host is what renames it to
`sharing_changed` and puts it on its event stream.

## Storage

Migration `001-murmur-binding` creates `happy_agent_murmur_binding`, a single row linking the
profile to the Murmur identity. Binding refuses to move to another person, and refuses an
identity that disagrees with the one already stored: a store and a record that disagree about who
this is must be caught here rather than halfway through a contact exchange.

Migration `002-murmur-store` creates `happy_agent_murmur_store`, the key–value table Murmur keeps
its own state in. `SqliteMurmurStore` is its only reader. Murmur's store API carries no caller
context, so the store is built on the lifetime the module derived and every statement runs there.
Values are base64 text rather than blobs, which keeps the same statements working on either
database this package supports. Scans order and paginate with `COLLATE BINARY`, because Murmur's
keys carry base64url identities whose case and punctuation a linguistic collation would fold
together.

## Deliberately not here

- **Folder sharing.** Legacy Happy Agent shared folders over the same identity. The snapshot a client
  reads still has a `folderShares` field, and the host answers with an empty list.
- **Onboarding.** Enabling sharing is a configuration decision and naming the person is
  `bindProfile`. There is no state machine and no `/v0/onboarding/murmur`.
- **Model-facing tools.** This is a host capability. The model is not given contacts.
