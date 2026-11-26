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
again. An explicit `enabled` value from configuration or `PATCH /v0/config` wins over automatic
discovery and is written beside `auto_enable` in runtime.toml. Provider records merge field-by-field, so these state
fields cannot replace credential or model configuration from another layer.

The machine provider setting `hidden = true` prevents direct selection regardless of scans
or explicit enable overrides. The provider and its models remain in the public catalog as disabled,
but the independent account-enabled state still controls smart routing and quota polling. Hiding is file-only configuration, not an API
field or mutation; changing it requires a daemon restart. See the
[configuration guide](../../../../docs/configuration.md#hiding-providers).

Agents with their own login, such as the built-in Antigravity account, keep that login where only
the agent can read it, so the scan reports their credentials missing. `recordDiscovery(ctx,
providerId)` lets the provider CLIs module, which runs `agy`'s own check, count a sign-in it found
as a discovery: the account is remembered and enabled exactly as if the scan had found it.

`scan(ctx)` joins a scan already in progress. `setOverrides(ctx, providers)` validates the whole
batch before applying it; a disable closes the provider gate and aborts live inference, compaction,
and verification. `verify(ctx, providerId, level)` supports local credentials, the vendor's
authenticated usage endpoint when one exists, and a minimal no-tool inference. Authentication
falls back to inference when the provider has no auth-only request. `verificationCandidates`
chooses the inference models: it never uses a Fable model, orders the provider's enabled models
cheapest first by a static relative cost rank by family (not prices), and picks the cheapest
effort other than "off". Verification stops at the first model that answers and moves on only after
a model-specific failure (`isModelSpecificFailure`: an unavailable model or an invalid request for
it), trying at most three models within the same 30-second bound. A provider whose only enabled
models are Fable fails with `no_model`. When every tried model failed for a reason of its own, the
`model_unavailable` message says the credentials work and lists each model with its short reason;
a failure every model would share keeps its own explanation, prefixed with the models tried. A
successful verification is remembered, while a failure changes no earlier discovery. A failure
returns `failure: { kind, message }`: `describeVerificationFailure` classifies the problem
(missing credentials, authentication, network, TLS, timeout, unavailable model, quota, provider
error, no model, or unknown) and writes an actionable sentence that names only non-secret
configuration such as the provider type, endpoint host, region, AWS profile, credential variable
name, and model ID. Any vendor text passes through `sanitizeVerificationDiagnostic`, which keeps
URL origins and paths and replaces credentials, opaque tokens, and local paths; the message is at
most 500 characters. The daemon log keeps the unsanitized reason. Hidden providers support the same credential, authentication, and inference
verification levels. A successful verification cannot unhide the provider for direct selection.
