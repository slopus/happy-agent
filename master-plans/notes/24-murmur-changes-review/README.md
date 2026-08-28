# Murmur changes proposed for Happy CRDT

Status: approved by Steve with two revisions: use `crdt.loro` while keeping
Murmur's existing service-ID validation unchanged, and strictly linearize all
relay-derived application effects through one durable relay-ordered queue. The
approved implementation includes bounded inbox backpressure, the ordering and
corruption corrections, and remains subject to the final independent review and
release gates.

This note explains the exact Murmur changes proposed to support Happy Services
and the generic Happy CRDT service. The Happy Agent contract calls the Murmur
service `crdt.loro`, keeps local data usable without Murmur, and treats Murmur's
confirmed session state as the authority for participants, roles, and policies.

## Decision summary

| Change                                      | Why it is proposed                                                                                                                                              | Scope                                                                                             | Recommendation                                                                        |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Use the existing-valid `crdt.loro` ID       | Steve selected the dotted form, so Murmur's existing validator needs no change.                                                                                 | Happy API/client constants and lifecycle tests.                                                   | Approved.                                                                             |
| Add `onSessionsChanged`                     | Existing services receive new sessions, application updates, and owner deletion, but not confirmed membership, device, role, policy, or local-removal changes.  | One optional public callback plus durable lifecycle delivery.                                     | Required for the requested participant semantics.                                     |
| Add one bounded application-effect queue    | Separate route, update, and lifecycle paths allowed later effects to overtake blocked earlier effects.                                                          | A durable relay-ordered queue over route decisions, application updates, and lifecycle snapshots. | Required; strict relay linearization explicitly approved.                             |
| Add `onIssues`                              | Membership operations can be durably accepted and later fail. Happy Agent needs to retire its private attempt record without polling while `sync()` is running. | One optional callback over Murmur's existing bounded issue set; no new issue store.               | Required for robust asynchronous add-member settlement, but independently reviewable. |
| Enforce member capacity on incoming Commits | A peer may send a valid Commit exceeding this client's configured limit. Lifecycle snapshots must never bypass the same bound applied to local operations.      | One preflight check before adopting a remote Commit.                                              | Defensive fix; review separately if desired.                                          |
| Add focused tests and docs                  | The new retry, ordering, deletion, and resource behavior needs executable coverage.                                                                             | Service/session tests and existing READMEs.                                                       | Required with any approved behavior above.                                            |

No new membership protocol, admission format, host abstraction, or Murmur
service-specific branch is proposed. In particular, Murmur's current durable
membership-intent records and account-device convergence remain unchanged.

## 1. Use `crdt.loro` without changing Murmur validation

Murmur's validation remains:

```text
^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$
```

The existing 64-character limit remains. Dots and hyphens cannot lead, trail,
or repeat, and slashes remain invalid:

```text
accept: crdt.loro
accept: notes.v1
accept: local-bots.chat
reject: crdt/loro
reject: .crdt.loro
reject: crdt..loro
```

Pseudocode:

```text
function validateServiceId(id):
    require length(id) <= 64
    require id matches existing lowercase dotted-or-hyphenated pattern
    return id
```

The Happy API/client constant and every Murmur lifecycle test use `crdt.loro`.
The draft slash-support validator change is reverted rather than released.

## 2. Expose confirmed session lifecycle snapshots

### Public API addition

Add one optional identity-wide synchronization callback:

```ts
interface MurmurSessionChangedEvent {
    id: string; // stable authenticated relay event ID
    service: string;
    sessionId: Uint8Array;
    status: "active" | "removed";
    descriptor: Uint8Array;
    members: readonly Uint8Array[]; // account identities, not devices
    owner: Uint8Array;
    admins: readonly Uint8Array[];
    policies: {
        adminsAssignAdmins: boolean;
        anyoneCanAddMembers: boolean;
        sendPolicy: "everyone" | "admins";
    };
    reAdmission?: boolean;
}

interface MurmurSyncOptions {
    onSessionsChanged?: (
        ctx: Context,
        events: readonly MurmurSessionChangedEvent[],
    ) => void | Promise<void>;
}
```

The callback is identity-wide because Murmur has one synchronization loop and
one ordered inbox for all registered services. Each event carries `service`, so
the application can route it transactionally. This does not add a Happy-CRDT
special case to Murmur and does not add another method to every `MurmurService`
implementation.

### Events that produce a snapshot

Record a complete snapshot when a service-owned session:

1. is claimed and activated from a remote Welcome;
2. adopts the local creator's echoed bootstrap Commit;
3. adopts any local or remote membership, device, role, or policy Commit;
4. is re-admitted after continuity recovery; or
5. receives a Commit that removes the local account, immediately before its
   local cryptographic session state is destroyed.

Owner deletion continues to use the existing `onSessionDeleted` service
callback. It is terminal deletion rather than a participant snapshot.

Only confirmed state is emitted. Merely queuing `addMember`, `removeMember`, or
`leave` does not change the snapshot.

### Transaction boundary

The lifecycle record is created in the same Murmur store transaction that
adopts the Commit or activates the session:

```text
function adoptCommit(transaction, inboxEvent):
    authenticatedCommit = decryptAndValidate(inboxEvent)
    nextEpoch = apply(authenticatedCommit)
    nextSession = buildSessionRecord(nextEpoch)

    transaction.set(sessionStateKey, nextSession)

    if session is owned by a registered service:
        transaction.recordSessionChanged(
            relayEventId = inboxEvent.id,
            confirmedSession = nextSession,
        )

    transaction.commit()
```

For local-account removal, capture the final confirmed public snapshot before
deleting local session state:

```text
if applying commit removes this account:
    finalSnapshot = projectConfirmedStateAfterCommit()
    owner = readServiceOwner()
    deleteCryptographicSessionState(transaction)
    recordSessionChanged(
        transaction,
        status = "removed",
        descriptor = previousDescriptor,
        members = finalSnapshot.members,
        owner = owner,
    )
```

This is the event Happy Agent uses to atomically change a shared CRDT service
back to local while preserving the Loro document.

## 3. Strictly linearize relay-derived application effects

### Required invariant

Every authenticated relay delivery has one stable UUIDv7 event ID. Murmur uses
that ID as the sole order for every application-visible consequence of inbox
processing:

- a new-session route decision;
- an application update; and
- a confirmed session lifecycle snapshot.

Protocol adoption and appending any resulting effect happen in the inbox cursor
transaction. The relay delivery may then be acknowledged because the effect is
durable. Application callbacks drain those effects strictly in relay order. A
failed callback or unresolved route leaves that exact effect at the head and
blocks every later effect.

```text
relay event N
    transaction:
        authenticate and adopt protocol state
        append application effect at N, if any
        advance durable inbox cursor to N
    acknowledge N

drain application effects:
    next = oldest effect by relay event ID
    invoke the matching application callback
    transactionally consume next only after success
```

The application does not have to be online while Murmur receives events. A
restart observes the same immutable head effect and retries it with the same
stable event ID and content.

### Proposed durable record

Internal record, not a new public protocol:

```text
SessionChangedRecord {
    version: 1
    id: relay event UUIDv7
    serviceId: validated Murmur service ID
    sessionId: 32 bytes
    status: active | removed
    descriptor: bytes only when status = removed
    members: unique account identities, bounded by member limit
    roles: owner, admins, policies
    attempted: boolean
    reAdmission?: true
}
```

Storage per service-owned session:

```text
murmur/session-changed-events/<session-id>/<relay-event-id>
murmur/session-changed-event-index/<relay-event-id>/<session-id>
```

Every retained lifecycle record has a global index entry. Routing markers and
application updates already have equivalent relay-ID indexes. Murmur merges the
three ordered sources and considers only the oldest effect or one contiguous
batch of same-kind effects. It never skips an unresolved or failed head effect.

An active event does not duplicate the potentially 1 MiB descriptor. Its
descriptor is read from the ordinary session state when preparing the callback.
A removed event retains the descriptor because ordinary session state has
already been destroyed.

### Lifecycle recording

```text
function recordSessionChanged(transaction, next):
    write immutable next under its relay event ID
    write global index for next
```

Lifecycle snapshots do not coalesce. Coalescing would erase an authenticated
point in the relay order and make strict behavior depend on callback timing.
After a successful callback, Murmur deletes the exact record and its index in
one transaction. If the callback throws or the process crashes, both remain:

```text
function deliverSessionChanged(record):
    await onSessionsChanged([immutablePublicCopy(record)])

    transaction:
        delete record
        delete its global index
```

If `onSessionsChanged` is omitted, Murmur consumes lifecycle effects without a
callback because that application elected not to consume the optional surface.
It does not retain history forever for an unused callback.

### Bounded inbox backpressure

The durable effect queue has one identity-wide hard bound. Before adopting the
next relay delivery, the inbox handler checks capacity in the same transaction.
If the queue is full, it returns `deferred`: the transaction makes no mutation,
the inbox cursor does not advance, and the relay event is not acknowledged.
Murmur drains already-durable effects and then retries that same relay event.

```text
function processInboxDelivery(transaction, delivery):
    if durableApplicationEffectCount >= hardLimit:
        return deferred

    adoptProtocolState(transaction, delivery)
    appendApplicationEffect(transaction, delivery.id)
    return accepted

function consumeInboxPage(page):
    for delivery in page:
        outcome = transaction(processInboxDelivery(delivery))
        if outcome == deferred:
            stop before delivery
        advanceCursorAndAcknowledge(delivery)
```

This is a small internal extension to the low-level inbox handler result. A
custom handler that returns `void` retains its current accepted behavior. The
bound pauses intake instead of dropping, reordering, or coalescing effects.

### Ordering requirement

Route decisions, session changes, and application updates are ordered by their
authenticated relay event IDs before callbacks run. For one session, a
membership Commit must be observed before an application update sent in the
resulting epoch. The same ordering also applies across sessions.

Intended pseudocode:

```text
prepared = prepareOldestGloballyOrderedEffects(
    routingMarkers,
    applicationUpdates,
    sessionChangeRecords,
)

head = prepared.first
if head is unresolved route:
    stop
if head is route:
    await decideAndConsumeRoute(head)
    reprepare
if head is session change:
    await deliverSessionChanged(head)
if head is application update:
    await deliverContiguousApplicationUpdateBatchStartingAt(head)

commit consumption atomically
```

Application updates for a pending session receive their global index when the
relay event is adopted, not later when routing completes. The earlier route
effect blocks them until the application claims or ignores the session. Murmur
commits that route decision and re-prepares before invoking another callback.
Activation therefore cannot reveal an old hidden update after a newer effect.

The approved implementation reads bounded prefixes from each ordered source,
merges candidates by relay event ID, and takes one shared limit. Regressions
cover page boundaries and cross-session route blocking.

### Deletion and corruption

```text
function deleteSession(transaction, sessionId):
    deletePrefix(sessionChangedPrefix(sessionId))
    delete existing session state, buffers, routes, and ownership
```

Owner deletion is a local terminal action and continues to purge that session's
pending application effects. A malformed effect and its index are deleted and
reported through Murmur's existing bounded quarantine/issue mechanism instead
of permanently wedging synchronization. Other valid records remain ordered and
deliverable.

A Commit that removes the local account uses a narrower terminal cleanup. It
destroys cryptographic state but retains earlier queued application updates,
lifecycle snapshots, and the service owner mapping. Every earlier relay effect
drains before the final `removed` snapshot. Settling that snapshot deletes the
retained application-delivery state. Owner deletion continues to purge all
pending application and lifecycle callbacks for that locally deleted session.

## 4. Surface existing bounded issues during persistent sync

Murmur already has:

```ts
murmur.issues(ctx): Promise<readonly MurmurSessionIssue[]>
```

That read method is sufficient for manually bounded `synchronize()` calls, but
Happy Agent will normally use Murmur's persistent `sync()` loop. It otherwise
has no notification that an asynchronously processed membership intent became
terminal.

The proposed addition is only a callback over the existing bounded durable
issue store:

```ts
interface MurmurSyncOptions {
    onIssues?: (ctx: Context, issues: readonly MurmurSessionIssue[]) => void | Promise<void>;
}
```

Pseudocode:

```text
function deliverUpdates(ctx, callbacks):
    if callbacks.onIssues exists and issueMutationVersion changed:
        issues = engine.issues(ctx)  # existing bounded set
        fingerprint = canonicalFingerprint(issues)
        if issues is not empty and fingerprint differs from last delivered fingerprint:
            await callbacks.onIssues(ctx, immutableCopy(issues))
        remember observed mutation version and fingerprint

    continue normal lifecycle and application delivery

    if callbacks.onIssues exists and recovery changed issueMutationVersion:
        # Include issues created while preparing or recovering this drain.
        issues = engine.issues(ctx)
        fingerprint = canonicalFingerprint(issues)
        if issues is not empty and fingerprint differs from last delivered fingerprint:
            await callbacks.onIssues(ctx, immutableCopy(issues))
        remember observed mutation version and fingerprint
```

No issue is deleted by this callback, no unchanged idle cycle repeats it, and no
second issue database is added. The mutation version is only a scan hint; the
fingerprint is the authority, so an identical overwrite or a rolled-back
transaction cannot repeat an unchanged public issue set.
Happy Agent deduplicates stable issue/operation IDs in its own transaction and
uses a terminal add-intent issue only to release private retry bookkeeping.
Public participants remain unchanged until `onSessionsChanged` reports
confirmed state. An undecodable issue-store record is deleted during the bounded
read so corruption reporting itself cannot wedge persistent synchronization.

If this callback is rejected, the fallback is for Happy Agent to poll
`murmur.issues(ctx)` alongside a persistent sync loop. That is workable but less
direct and adds another scheduler solely to observe state Murmur already owns.

## 5. Enforce the configured member bound on incoming Commits

Local session creation and local additions already check member capacity. A
remote authorized member can run with a different configured limit and send a
cryptographically valid Commit whose projected leaf count exceeds this
client's bound.

Proposed preflight:

```text
function receiveCommit(transaction, currentEpoch, commit):
    projectedDeviceLeaves = countActiveLeaves(currentEpoch)

    for proposal in commit.proposals:
        if proposal is Add: projectedDeviceLeaves += 1
        if proposal is Remove: projectedDeviceLeaves -= 1

    if projectedDeviceLeaves < 1 or
       projectedDeviceLeaves > maximumMembersPerSession:
        quarantine(commit, code = "session_member_capacity")
        acknowledge terminal invalid input according to existing Murmur rules
        return

    applyCommitNormally()
```

The public lifecycle event still deduplicates devices into account-level
`members`. The capacity check uses MLS device leaves because that is the actual
cryptographic and memory cost.

This check is defensive rather than Happy-CRDT-specific. It can be reviewed and
landed separately, but without it a remote Commit can bypass a configured local
resource boundary.

## 6. Happy Agent consumption pseudocode

The proposed Murmur surface would be consumed without polling session state:

```text
murmur.sync(happyServiceContext, {
    onConnected(ctx):
        crdt.transaction(ctx, setConnectionOnlineAndEmitEvent)

    onDisconnected(ctx):
        crdt.transaction(ctx, setConnectionOfflineAndEmitEvent)

    onSessionsChanged(ctx, snapshots):
        crdt.transaction(ctx, transaction =>
            for snapshot in snapshots:
                require snapshot.service == "crdt.loro"
                deduplicate snapshot.id

                if snapshot.status == "active":
                    upsert confirmed participants, roles, policies, recovery
                else:
                    preserve Loro state
                    change sharing to local

                advance service and catalog versions
                persist post-commit event intent
        )
        # Resolve only after the Happy transaction commits. Murmur may now
        # consume the lifecycle record.

    onUpdates(ctx, updates):
        crdt.transaction(ctx, validateMergeDeduplicateAndEmit)

    onIssues(ctx, issues):
        crdt.transaction(ctx, retireMatchingPrivateAdmissionAttempts)
})
```

Local CRDT reads and writes never call Murmur. Local writes commit immediately;
shared writes additionally create a durable Happy Agent publication intent.

## 7. Alternatives not recommended

### Add slash support to Murmur service IDs

Not needed. Steve selected `crdt.loro`, which is valid under the existing
validator and keeps the Murmur change surface smaller.

### Poll `murmur.sessions()`

Polling cannot atomically bind a specific confirmed Commit ID to the Happy
Agent transaction. It can miss short-lived transitions, does not naturally
retry one exact snapshot after callback failure, and cannot read a local session
after a Commit has removed the local account and destroyed that state.

### Send participant changes as CRDT application updates

This creates a second membership protocol that can disagree with MLS,
duplicates authorization logic, and lets stale application history claim a
participant state that Murmur no longer confirms.

### Change Murmur's membership-intent format

Not proposed. Happy Agent will submit one claimed device KeyPackage through the
existing API; Murmur's authenticated account-device roster convergence adds the
account's other current devices through its existing machinery.

## 8. Proposed test coverage

The approved implementation should prove:

1. `crdt.loro` is valid while `crdt/loro` and malformed dotted IDs remain invalid.
2. Remote activation emits one complete confirmed service snapshot.
3. Membership-, role-, device-, and policy-only Commits emit snapshots.
4. A callback failure retries the same event ID and immutable content after
   restart.
5. Consecutive Commits remain distinct immutable lifecycle effects regardless
   of callback timing.
6. Local-account removal emits one final `removed` snapshot before local state
   disappears.
7. A Commit snapshot precedes a later application update in relay order,
   including across delivery page boundaries.
8. An update preceding a deferred-claim Commit remains ahead of the eventual
   activation snapshot, which uses that latest Commit as provenance.
9. Identity-wide `onUpdates` flushes before a later `onSessionsChanged` callback.
10. An unresolved route blocks all later cross-session effects until its route
    decision commits.
11. A full identity-wide effect queue leaves the next relay event unprocessed,
    unacknowledged, and available for exact retry after the queue drains.
12. Owner deletion suppresses retained callbacks for the locally deleted session.
13. One malformed lifecycle effect is quarantined without blocking a valid
    newer effect or healthy application work.
14. Existing bounded issues created during recovery reach `onIssues` in the same
    drain, malformed issue records are dropped, and unchanged idle cycles do not
    repeat the callback.
15. Incoming Commits cannot exceed the configured device-leaf member limit.
16. Existing Murmur deterministic tests, typecheck, lint, package compatibility,
    and relay
    tests remain green.

## Review checklist

- [x] Use `crdt.loro`; do not add slash support.
- [x] Approve the `MurmurSessionChangedEvent` shape.
- [x] Approve identity-wide `onSessionsChanged` rather than a per-service hook.
- [x] Approve strict relay ordering with no lifecycle coalescing.
- [x] Approve the identity-wide hard effect bound and inbox deferral seam.
- [x] Approve the final `removed` snapshot before local-state destruction.
- [x] Approve `onIssues` over the existing issue set.
- [x] Approve incoming Commit capacity enforcement.
- [x] Require global ordering across page boundaries before landing.
- [x] Approve the test matrix.
