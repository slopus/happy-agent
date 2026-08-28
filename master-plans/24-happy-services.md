# Master plan 24: Happy Services

## Big picture

A `HappyService` is an opinionated, local-first wrapper around a Murmur service.
It gives a feature one way to create sessions, apply updates, observe changes,
and manage participants whether Murmur is connected, disconnected, disabled, or
not configured at all.

The local service is the product. Murmur adds encrypted synchronization between
the user's devices and other participants; it does not become a prerequisite
for using the feature. A scratchpad, messenger, todo list, or web application
can therefore begin as an entirely local feature and gain sharing without
growing a second behavior model.

One `HappyService` instance is registered with Cloud under a stable service
identity. Cloud attaches it to the current Murmur client when one is available
and detaches it when synchronization stops. The instance itself remains alive
and usable throughout both transitions.

## Local and shared are not online and offline

These are two independent facts:

| Session    | Service offline                              | Service online                       |
| ---------- | -------------------------------------------- | ------------------------------------ |
| Local only | Updates apply locally.                       | Updates still apply only locally.    |
| Shared     | Updates apply locally and wait for delivery. | Updates apply locally and replicate. |

A local session never starts syncing merely because the service comes online.
Making it shared is an explicit operation. A shared session never stops being
usable merely because the service goes offline. An existing local session can
be made shared without changing its application identity or losing its current
state.

This distinction permits both sides of the product: one messenger can have a
private channel for local bots, while another channel uses the same methods and
events to communicate with people on other devices.

## The service contract

A service owns any number of application sessions. Each one has a stable local
identity, a local or shared disposition, its current state, and its current
participants. For a shared session, participants are user or account
identities; several devices belonging to one account are replicas, not several
participants.

The feature defines its descriptor, update, snapshot, validation, and merge
semantics. A scratchpad may use Yjs, a messenger may use an append-only message
protocol, and a todo list may use operations suited to its data. `HappyService`
does not force all of them into one conflict-resolution algorithm. It provides
the common session envelope, stable operation identities, local persistence,
delivery bookkeeping, lifecycle, and event ordering around that feature-owned
protocol.

Every local update follows one path:

1. Validate it and apply it to the local session immediately.
2. Commit the resulting state, operation identity, and any required delivery
   intent in one local transaction.
3. Notify the feature after the commit.
4. If the session is shared, publish the committed intent whenever Murmur is
   available.

The feature sees its own committed update through the same ordered event
surface whether it was local only, waiting offline, or already published. It
does not wait for a network round trip and it does not receive a second logical
update when Murmur later echoes the operation.

Every remotely received update follows the same path in the other direction:
the update and its stable delivery identity are applied together in one local
transaction, then one post-commit event is emitted. A retry after a crash is
recognized as the same update. Once bytes have arrived, a simultaneous
disconnect does not discard or suppress them.

The service exposes a current online or offline synchronization state and
ordered transitions between them. Becoming online, becoming offline, creating
or deleting a remote session, applying a remote update, and changing the
confirmed participant set all have a transactional event and a corresponding
post-commit event. A listener never observes a state that failed to commit.
Startup begins offline; an old persisted online value must never claim a dead
connection is live.

## Murmur bridge

When Cloud has a live Murmur client, it registers each `HappyService` as the
corresponding Murmur service. The bridge receives every new session addressed
to that service, every application update for a claimed session, owner
deletion, and every confirmed membership, role, or policy change. It translates
those into the transactional local lifecycle above. If the Murmur service
surface cannot currently report one of those lifecycle changes, extend that
surface directly instead of polling or inventing a parallel membership
protocol.

Murmur owns encrypted membership, forward secrecy, per-device delivery,
cryptographic session state, and relay acknowledgement. `HappyService` owns the
application replica and its history. The relay is not treated as application
history.

For that reason, every feature protocol must be able to bootstrap and catch up
a replica. Making an existing local session shared, receiving a new remote
session, adding a participant, or adding another device must eventually provide
enough authenticated application state for that replica to converge. This may
be a feature snapshot, a compact operation history, or a CRDT exchange, but it
cannot depend on the relay retaining old application messages.

Murmur synchronization state and application state do not need one physical
database transaction. Stable operation and delivery identities bridge that
boundary: local commits can safely be published again, and remote callbacks can
safely be replayed, without duplicating an application update. Murmur is
acknowledged only after the local application transaction succeeds.

A Murmur continuity reset, Cloud disconnect, or unavailable relay never deletes
the feature's local application state. It moves synchronization offline and
preserves enough local identity and intent for the product to explain or repair
the sharing relationship.

A UI reads one local `HappyService` view. It does not merge that local view with
a direct Murmur stream.

## Order

First, build the local `HappyService` contract with sessions, local updates,
snapshots, participants, transactional and post-commit events, and no Murmur or
Cloud requirement. Done when a complete feature can run and restart locally
through this surface alone.

Second, add the Cloud registration and Murmur bridge. Make online and offline
transitions explicit, receive and claim remote sessions, translate the full
session and participant lifecycle, and durably publish shared local updates.
Done when disconnecting changes availability but does not change feature
behavior or lose work.

Third, make promotion, bootstrap, and recovery complete. An existing local
session can become shared, a new device or participant can reconstruct current
state, retries are idempotent, and crashes at every boundary converge without a
duplicate session or update.

Finally, prove that the abstraction is genuinely general with services that
have different data semantics: a collaborative scratchpad, an append-only
messenger including a local-only bot channel, and a structured todo list. A web
application must be able to use the same model with browser-local persistence.

## What done looks like

- A `HappyService` starts, reads, writes, emits events, and restarts correctly
  when Cloud and Murmur are absent.
- Local-only sessions stay local even while the service is online.
- Shared sessions accept and emit local updates while offline, then synchronize
  them after reconnect without an application-visible duplicate.
- One explicit operation can make an existing local session shared without
  replacing its identity or state.
- A remote session, remote update, deletion, and confirmed participant or role
  change each become one atomic local change and one ordered post-commit event.
- Several devices of one user and several participating users converge while
  preserving the distinction between a device and a participant.
- A newly added replica receives current application state without assuming the
  Murmur relay is a history store.
- Crashes, reconnects, callback retries, and Murmur continuity reset preserve
  local application state and do not silently lose or duplicate logical work.
- Scratchpad, messenger, todo, and browser-local-storage products can choose
  their own state protocol without reimplementing connection, session,
  participant, transaction, or delivery lifecycle.
