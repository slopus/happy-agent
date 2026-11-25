# Viewers module learnings

## Admission against an erase is decided in the write transaction

A request checks access before it reaches the module, so an agent erased in between was still
viewed and answered, and its visit was written back after the erase deleted its rows. An
in-memory set of erased agents guarded it next, but a count-bounded set forgot old erases and
refused an agent legitimately re-created under the same ID. The erase now records a numbered
erasure in its own transaction. A request reads the latest number before checking access, and
the transaction that stores its visits refuses a new view of a target erased since; a view the
stream already holds stands only while its stored visit does, and a departure only updates an
existing visit. The installed views and the response follow that one result. An erasure is kept
only while a request that read before it is still checking. Reading Agent Base's configuration
inside the transaction instead is not an option: it throws while a deletion is still finishing.

The remaining window, where a request racing a deletion answers that target with people from
before it and history from after, is accepted and documented in the API: clients discard the
target anyway. Do not chase it further.

## A target is its type and ID

Clients newer than the daemon may view types it does not know or add fields to a target. Both
are accepted: unknown types are answered with an empty list, extra fields are ignored, and two
targets with the same type and ID are duplicates whatever else they carry, including unknown
types, so a request that is valid today stays valid once the daemon learns the type.
