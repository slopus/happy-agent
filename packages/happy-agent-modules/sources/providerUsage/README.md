# Provider usage

`ProviderUsageModule` owns the latest account-level quota reading for every configured inference
provider. It is deliberately separate from `UsageModule`: token accounting is durable work
history, while vendor quotas are an advisory snapshot that lives only in memory.

Readings arrive two ways. A vendor that measures the account on every response — Claude reports
the account's own limiter on each run — delivers its reading in band through
`ConfigModule.onProviderAccountUsage`, so ordinary work keeps the number current at no cost and
without touching a rate-limited endpoint. Such a reading names only the window that currently
constrains the account, so it is merged onto what is already known rather than replacing it and
erasing a window the vendor simply stayed silent about.

The module also asks `ConfigModule` to read each account through its vendor's native usage API.
Each provider has an independent named polling loop, runs immediately at startup, and refreshes
every 15 minutes. A slow or unavailable provider cannot delay another one. Failed refreshes
preserve a previous successful reading; before any successful reading the entry carries the
failure text. A poll answers about every window, so unlike an in-band reading it supersedes what
came before. When a provider refuses with its own retry deadline, that deadline is honored and no
poll is attempted until it passes.

`list()` always includes every configured provider, including disabled providers and vendors such
as Bedrock that expose no coding-account quota API. `ApiModule` combines these readings with the
complete provider/model catalog in `GET /v0/usage`.

`onChanged()` lets presentation modules republish advisory UI as soon as a poll or in-band reading
changes. The snapshot remains owned here; consumers choose their own wire shape and refresh scope.
