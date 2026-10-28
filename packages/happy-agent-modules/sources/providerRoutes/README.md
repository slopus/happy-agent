# Provider routes

A provider route is one way this computer can already reach models: a vendor's own sign-in, a
sign-in found through a vendor's desktop app, an API key, a local proxy, a router, an AWS profile,
or a local model server. Onboarding shows the routes found, and nothing else, and sets a chosen
route up with its recommended configuration. `packages/happy-agent/API.md` ("Provider routes") is
the contract.

`ProviderRoutesModule` takes the config, provider CLIs, and provider scan modules. It holds no
state and does no durable work: every read detects again, and using a route is one configuration
write.

## Detection never runs inference

Detection only discovers. It reads local files and the daemon's own process environment and reuses
the provider CLI checks. It never runs a shell or any other program, never calls a vendor's or a
cloud's API, and never reads the keychain. The only network requests are `GET /v1/models` on
`127.0.0.1`, at a port a detected program's configuration names or at LM Studio's and Ollama's
default ports, each bounded to 1.5 seconds.

Each detector in `impl/` returns `DetectedRoute`s. A detected route either names the configured
provider it already is (`providerId`), or carries the provider table choosing it would add
(`provider`). That table may hold a key copied from another program's configuration, so it is
written only to runtime.toml and never projected. `assembleProviderRoutes` orders the routes,
lists overlaps by shared vendor, picks the initial selection, and works out `use`.

## Using a route

A route that is a configured provider turns that provider on through the provider scan, which takes
effect at once. A route that needs a new provider adds its table to runtime.toml with
`ConfigModule.addRuntimeProvider`; providers are read at startup, so it takes effect after the
daemon restarts. A provider already pointing at the same local base URL, or a Bedrock provider
already using the same AWS profile, counts as that route being configured, whatever its ID.

A route counts as a configured provider only when this daemon actually runs that provider
(`ConfigModule.providerIds`), not merely when configuration mentions it.
