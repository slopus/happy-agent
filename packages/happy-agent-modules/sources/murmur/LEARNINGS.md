# Murmur learnings

## Enrollment belongs to the public API

The earlier module treated `[sharing].enabled` and a caller-provided profile ID as enrollment.
That made a configuration file capable of creating an identity and left API clients without a
durable unenrolled resource. Sharing now initializes a stable unenrolled snapshot and creates an
identity only through `POST /v0/sharing/enroll`. The managed relay is internal, and old sharing
configuration is ignored.

## Murmur internals stop at the API projection

The module needs session IDs, private profile ownership fields, and Murmur's carried-profile
shape to operate, but none are public Sharing fields. ApiModule directly depends on MurmurModule,
projects a fresh exact public object, and validates it against the published client schema. A
public outgoing request ID is separately minted rather than reusing an invitation or session ID.

## Events follow durable public high water

An in-memory ordered string could move backward after restart and could be published before a
refetch observed it. Public sharing state now stores UUIDv7 `version` and monotonic `updatedAt`
high-water values. Every actual change commits those values before notifying subscribers; reads
and documented no-ops do not change them. This preserves event/refetch ordering through restart,
clock rollback, and concurrent connection callbacks.

The durable row is the complete authoritative projection, not metadata beside a fallible live
read. Public snapshots and error bodies remain available while Murmur is unreadable. Private
pending intents and outgoing reservations can change without advancing the public version; after
a crash, startup reconciles them against Murmur and publishes only the resulting public change.

## Side effects begin after the caller commits

Request, accept, reject, remove, enroll, and reset first persist bounded intent in the caller's
transaction. Relay or Murmur mutations start only from an `afterCommit` callback on the module's
detached lifetime. A caller rollback therefore performs no external action. If Murmur mutates and
then both its response and the immediate local read fail, the retained intent lets restart recover
the result without inventing another public request ID.

## Reset stages before replacing

Deleting the old keyspace before proving a replacement can open made an ordinary local failure
destructive. Reset now opens a complete replacement against a transactional in-memory store while
the old identity remains live. Only then does one database transaction replace the keyspace,
binding, authoritative snapshot, and version. Replacement-open failure leaves the old identity
usable and publicly unchanged.

Murmur 0.4.5 resolved the earlier invitation invalidation gap with `revokeInvitation` and
`revokeInvitations`. Reset now opens the replacement first, then must confirm identity-wide relay
revocation before it swaps any durable Happy state. Murmur records failed revocations in its store
by design, so Happy performs revocation on a bounded clone of the old store: success makes the
clone disposable because the identity is being replaced, while failure discards it and reopens
the byte-for-byte unchanged old store. A failed or aborted revocation leaves the identity,
binding, public snapshot, version, events, and invitations alone.

## Profile refresh belongs to Murmur's contact lifecycle

Initial contact profiles are not enough because a local edit must reach established peers.
The first implementation added a Happy-specific service descriptor, packet codec, session scan,
one session per peer, and a durable peer-profile overlay. Murmur 0.4.5 now owns this protocol:
`updateContactProfile` atomically retains and queues the latest carried local profile to every
active contact, and `onContactUpdated` reports authenticated remote replacements. Sharing keeps
only its crash-safe local scheduling high water, reconciles each remote callback from Murmur's
authoritative contact snapshot, and advances the sharing UUIDv7 with a mutationless event. Startup
always republishes the latest local profile and reprojects Murmur's durable contact profiles, so a
crash in either callback gap converges without a parallel Happy wire protocol or overlay.

Profile and Sharing cannot currently commit their version changes atomically. ProfileModule calls
its listeners only after its own write transaction commits and exposes no in-transaction
participant or durable outbox seam. Murmur therefore advances its durable projection immediately
afterward and reconciles on restart; a crash between those commits delays the Sharing event but
does not lose the latest profile. Exact atomicity requires a ProfileModule hook that runs inside
the profile transaction, or a shared outbox intent persisted by that transaction.

## Background events never borrow API mutation identity

AsyncLocalStorage follows scheduling chains, so a delayed relay or profile callback can still run
inside the API mutation that happened to schedule it. Murmur records event origin at the durable
change. ApiModule appends background sharing invalidations outside mutation storage, while direct
mutation events retain the exact caller-provided mutation ID.

## One outgoing collection owns the bound

Separate invitation and public-ID maps each had their own capacity and could therefore admit twice
the intended durable records. Each pending or active request is now one discriminated entry in one
array. Its invitation digest, public ID, resolved identity, and eventual session ID move through
that one lifecycle.

Murmur 0.4.5 exposes complete relationship reads and contact-profile fanout only through its first
256 records. Advertising larger Happy collections could accept state that a later snapshot or
profile update silently omitted. Contacts, incoming requests, and outgoing requests are therefore
each capped at 256 until Murmur provides complete pagination; the runtime schemas, admission checks,
projection slices, API text, and capacity test all share that ceiling.
