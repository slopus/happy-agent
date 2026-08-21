# History learnings

## Run lifecycle belongs to History

The run table is the durable authority for normal turns and standalone maintenance alike. Callers
that need lifecycle correctness use the exact `run`, `runningRun`, and `previousRun` readers rather
than inferring state from an event cache or from `runs()` pagination. The paged reader is organized
around person-visible messages and intentionally skips message-less runs, while lifecycle readers
must still see an explicit-compaction maintenance run.

An exact database reader is not a substitute for a nonblocking live signal while Agent Base owns
an active transaction: the reader may wait until that transaction settles and then truthfully see
no running row. Interactive guards therefore take a current normal-run ID from the Events module,
which owns and restart-restores that live provider state, and fall back to History for standalone
maintenance runs that Events intentionally does not represent. This does not make an API-side
cache authoritative; emitted run metadata and every terminal outcome still come from History.

Successful loop settlement is not always a public run settlement. When durable user steering is
still pending, History leaves the current run open. Accepting that steering then performs the one
atomic transition the public contract describes: the old run becomes `aborted/steering` and the
successor becomes running. Provider failure and explicit abort still settle immediately; queued
messages do not defer settlement.

## A run starts when its accepted work was submitted

`startedAt` is the accepted message's durable submission time, or the maintenance operation's
creation time. A later loop or provider event is not a second start clock. Keeping the timestamp on
the History run makes live events, elapsed-time UI, restart recovery, and paged history agree.
