# Provider usage learnings

## Freshness belongs to each window, not to the reading

A Claude report about overage alone used to produce a reading with no windows; the merge carried
the old windows forward and stamped the whole reading with the current time, so numbers hours old
looked just measured. Each window now carries its own `capturedAt`, a carried window keeps it, and
a report that measured no window moves neither the reading's `capturedAt` nor `refreshedAt`.

## A refusal is dated by when inference reported it

`spentAccount` tells History that a throttled account is really spent. A Claude refusal that names
no window keeps the reading's older `capturedAt`, so judging freshness by it alone would discard the
very refusal that just happened. The module remembers when inference last reported each account
refused, counts that as fresh for fifteen minutes, and stops calling the account spent once its
blocking window has reset or a later reading is not exhausted.

## A failed read must be visible beside the reading it failed to renew

A failed poll used to keep the old reading, stamp `checkedAt`, and clear `error`, which made a
throttled account indistinguishable from a healthy one. Entries now carry `refreshedAt` for the
last success, `refreshError` for the last failure, `retryAt`, and `refreshing`; `error` keeps its
older meaning for compatibility.

## Clients are told, not made to poll

Usage changes are pushed as `provider.usage.updated`. Background checks run daily and skip
accounts measured by ordinary inference within the last day. These human-directed behaviors
override master plans 11 and 12, which still describe polling clients and a fifteen-minute cadence.
In-band readings carry an account in use;
`POST /v0/usage/refresh` lets a client ask for fresher readings without waiting.

## Sign-in keeps the latest answer that could tell

A pool member that signs out needs a visible badge, and a usage read cannot always say why it
failed: a Codex read answers nothing on a revoked token, and a refresh when the picker opens would
have flipped `signed_out` back to `unknown` at once. Each account entry now carries `signIn`. It is
set only by evidence: a reading arriving or Config's `onProviderSignIn` (a completed or
usage-spent response means `signed_in`, a typed authentication failure or a missing credential
means `signed_out`). A read that returns nothing triggers a bounded local credential probe, and only
a missing credential changes the value. Errors, throttling, and null reads with a credential leave
it alone. Smart-provider entries carry no `signIn`. An unchanged value announces nothing, so
ordinary inference does not flood `provider.usage.updated`.

## Read a blocked account again as soon as it can work

The human asked that an account blocked by a window be read again just after that window resets,
so a client learns quickly that inference is unblocked. Vendors' resets can be soft, so a read that
still finds the same window full backs off briefly before giving up to the daily poll.

## Claude's usage method follows its credential

Setup tokens and gateway tokens can never read the OAuth usage endpoint, and asking it only
spends that endpoint's rate limit. The method is chosen from the credential instead of a setting:
a login with `user:profile` asks the endpoint, everything else measures inference headers. A `429`
falls back to the headers immediately rather than leaving a stale reading on screen.

## Fallback inference needs its own budget

Every admitted usage probe grows a separate cooldown from 5 minutes to 40 minutes, 5 hours
20 minutes, and a day, even when successful. Menu requests cannot reset it; cheap account endpoints
remain eligible. An ordinary inference reading that measures a window resets escalation and
postpones probes for a day. Admission happens immediately before the actual inference request,
covering inference-only credentials and throttled-endpoint fallbacks without bypassing the
existing endpoint-refusal, retry, push, or reset-recheck machinery. A deferred probe retains the
cached reading and its existing error state; intentional backoff is not a failed refresh.
