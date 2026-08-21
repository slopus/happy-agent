# Provider usage

`ProviderUsageModule` owns the latest account-level quota reading for every configured inference
provider. It is deliberately separate from `UsageModule`: token accounting is durable work
history, while vendor quotas are an advisory snapshot that lives only in memory.

The module asks `ConfigModule` to read each account through its vendor's native usage API. Each
provider has an independent named polling loop, runs immediately at startup, and refreshes every
15 minutes. A slow or unavailable provider cannot delay another one. Failed refreshes preserve a
previous successful reading; before any successful reading the entry carries the failure text.

`list()` always includes every configured provider, including disabled providers and vendors such
as Bedrock that expose no coding-account quota API. `ApiModule` combines these readings with the
complete provider/model catalog in `GET /v0/usage`.
