# Provider scan module

`ProviderScanModule` owns automatic provider discovery and the live enabled state layered over
configuration. It takes only `ConfigModule`: configuration owns the provider registry, its gates,
the machine credential locations, and the generated `runtime.toml` mutation boundary.

At startup every provider without an explicit setting remains disabled while one scan runs. The
scan checks local credential evidence in parallel with a ten-second bound per provider. It makes no
vendor request. Codex, Claude, and Grok use their normal local credential loaders; Bedrock checks
configured bearer/AWS sources, environment selectors, and nonempty shared AWS files without
invoking the network-capable AWS credential chain.

A provider has no `auto_enable` value before discovery. A new positive discovery atomically writes
`auto_enable = true` to its generated runtime provider table. Later missing credentials or a probe
error never erase that setting and therefore never disable the provider automatically. A person
may set `auto_enable = false`; scans preserve that decision rather than auto-enabling the provider
again. An explicit `enabled` value from configuration or `PATCH /v0/config` always wins and is
written beside `auto_enable` in runtime.toml. Provider records merge field-by-field, so these state
fields cannot replace credential or model configuration from another layer.

`scan(ctx)` joins a scan already in progress. `setOverrides(ctx, providers)` validates the whole
batch before applying it; a disable closes the provider gate and aborts live inference, compaction,
and verification. `verify(ctx, providerId, level)` supports local credentials, the vendor's
authenticated usage endpoint when one exists, and a minimal no-tool inference on a curated cheap
model. Authentication falls back to inference when the provider has no auth-only request. A
successful verification is remembered, while a failure exposes no raw vendor error and changes no
earlier discovery.
