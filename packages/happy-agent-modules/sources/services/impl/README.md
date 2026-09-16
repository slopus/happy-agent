# Service implementation details

`ServiceAccessTokens` owns bounded, stateless, daemon-lifetime establishment credentials. It performs
signature and TypeBox payload validation before comparing the trusted scope. The owning service
module supplies that scope and performs live admission checks; this helper cannot start or revive
an execution.

`ServiceOutputReaders` keeps at most 64 independent positions over one SDK capture, with one
idle-expiry timer. A fixed 8 KiB Bloom filter remembers discarded identities without retaining an
unbounded tombstone map. Returning readers always disclose their reset; a collision may
conservatively warn a new reader too. Output is cut at UTF-8 boundaries, advances over omitted
bytes, and reports both response-limit loss and SDK capture loss. Closing the book releases its
timer and every position.
