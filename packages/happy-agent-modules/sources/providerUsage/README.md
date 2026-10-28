# Provider usage

`ProviderUsageModule` owns the latest account-level quota reading for every configured inference
provider. It is deliberately separate from `UsageModule`: token accounting is durable work
history, while vendor quotas are an advisory snapshot that lives only in memory.

Readings arrive two ways. A vendor that measures the account on every response delivers its
reading in band through `ConfigModule.onProviderAccountUsage`, so ordinary work keeps the number
current at no cost and without touching a rate-limited endpoint. Claude reports both its
five-hour and seven-day windows whenever either moves; Codex reports both on every WebSocket
response and in SSE headers. Such a reading may still be partial, so it is merged onto what is
already known rather than replacing it and erasing a window the vendor stayed silent about.

The module also asks `ConfigModule` to read each account through its vendor's native usage API.
Each provider has an independent named polling loop, runs immediately at startup, and refreshes
once a day, skipping accounts measured by ordinary inference in the last day. A slow or unavailable
provider cannot delay another one. A poll answers about every
window it can, so unlike an in-band reading it supersedes what came before. Reads of one account
never overlap: polls, rechecks, and client refreshes share its one-at-a-time queue.

## Freshness

Every window carries the `capturedAt` it was measured. A window carried forward keeps its own,
and a reading that measured no window — Claude reporting only overage, say — moves neither the
reading's `capturedAt` nor the entry's `refreshedAt`. A carried window that has since reset is
dropped rather than shown as current.

Each entry separates the last success from the last attempt:

- `refreshedAt` — the last successful reading, from a poll or in band.
- `checkedAt` — the last finished attempt.
- `refreshError` — why the latest read failed, kept beside an older reading and cleared by the
  next success. `error` keeps its older meaning: why no reading is available at all.
- `retryAt` — the vendor's own retry deadline. No read is attempted before it.
- `refreshing` — a read is in flight.
- `signIn` — `signed_in`, `signed_out`, or `unknown`, from the latest evidence that could tell: a
  reading, Config's `onProviderSignIn`, or a local credential probe after a read returned nothing.
  Smart-provider entries omit it, and an unchanged value emits no change.

## Choosing Claude's method

Configuration decides how a Claude account is read, with no setting of its own. A stored
`claude auth login` whose grant includes `user:profile` asks the OAuth usage endpoint. A configured
`oauth_token` or `auth_token`, a `CLAUDE_CODE_OAUTH_TOKEN`, or a login without that scope measures
the unified headers of a one-token inference response instead. An endpoint that answers `403` or
`404` is never asked again for that account during this daemon's life; configuration is fixed for
it. An endpoint that answers `429` falls back to the headers at once, and the headers keep
answering until the endpoint's own deadline passes, so a throttled endpoint never leaves an old
reading on screen.

## Rechecking after a reset

When an account is blocked — a window at 100%, which is what an exhausted or refused account
reports — the module schedules one read for 30 seconds after the last full window resets, or at
the vendor's `retryAt` if that is later. A newer reading that names another reset moves it, and
one showing the account working cancels it. If the read still finds the same window blocked, the
vendor's reset was soft: the module reads again after one, two, then five minutes, up to six reads,
before leaving the account to the daily poll and in-band readings. An exhausted account whose
blocking window is unknown has no reset to wait for and gets no recheck. Rechecks end on `close()`.

Routing does not depend on any of this: a smart provider skips a failed account only for the
current turn and reconsiders every account on the next user message, so a recovered account is
used again as soon as someone writes.

## Surface

`list()` always includes every configured provider, including disabled providers and vendors such
as Bedrock that expose no coding-account quota API. Such an account is never read; it records once
that it reports no usage. `ApiModule` combines these readings with the complete provider/model
catalog in `GET /v0/usage`.

`requestRefresh(ctx, { providerIds, olderThanMs })` starts background reads of the accounts whose
readings are older than `olderThanMs` (five minutes by default, at least one minute), skipping
accounts without a usage source, under `retryAt`, or already being read. It returns the accounts it
started at once. Those reads run in the module's own named context and end with it, never with the
request that asked. `ApiModule` serves it as `POST /v0/usage/refresh`.

Actual fallback inference probes have a separate budget: each admitted probe, successful or not,
waits 5 minutes, 40 minutes, 5 hours 20 minutes, then a day before another. Refresh requests never
reset this budget. Ordinary inference that measures a window resets escalation and postpones
probes for a day. Inexpensive account endpoints remain eligible under the ordinary refresh policy;
existing endpoint refusals, vendor retry deadlines, pushed events, and reset rechecks remain in use.

`onChanged()` reports every change to an entry, in order, including `refreshing` turning on and
off. `ApiModule` publishes each one as `provider.usage.updated`; presentation modules republish
advisory UI from it. The snapshot remains owned here.

`hidden = true` affects direct model selection, not account-quota collection. Enabled hidden
accounts continue polling and receiving in-band quota readings when a smart provider uses them.
Smart-provider entries have no synthesized account quota; the readings remain on the concrete
accounts. This module does not duplicate consumed-token counters between router and account IDs.
