# Provider scan learnings

## New credentials require a scan begun after they were saved

Joining a scan already in flight could reuse its missing-credential result after a setup token
was saved. Credential mutations now wait for that scan and start or join a later one. Ordinary
concurrent scans still coalesce, and explicit enablement decisions still take precedence.

## Verification tries the cheapest models and never Fable

Verification used to pick one hard-coded model per provider type (Fable 5 on Bedrock, Sonnet 5 on
Claude) at the first effort level. That failed real setups: Fable can need extra usage credits
on a Claude subscription, Bedrock rejects Fable 5's "off" level (`thinking.type.disabled` is not
supported), and Fable 5's default Mantle transport answers "model does not exist" where Mantle does
not serve it. Steve's rule: test from cheapest to most expensive, and never test with Fable.

`verificationCandidates.ts` now drops every Fable model and orders the provider's enabled models
by a static relative cost rank by family (Haiku, Luna, Composer, and Gemini Flash first; then
Sonnet, Terra, the other Grok models, and the other Gemini models; then Opus and Sol; then Astra).
The rank is relative, not prices, because Happy has no price data; unranked models go last in
configuration order. The effort is the cheapest one the model accepts other than "off" (low,
minimal, medium, then the default), and "off" only when it is the model's only level.

The rank and the Fable rule first matched whole vendor IDs (`anthropic/haiku-…`), so a provider
served only through a harness (`claude-code/opus`, `codex-cli/gpt-6.2-sol`,
`antigravity/gemini-4-carbon`) was verified flagship first and `claude-code/fable` was not
excluded. Both now match the model's own name, the last ID segment, with an optional `claude-`
in front for the harnesses that spell it (`antigravity/claude-sonnet-5-5`), so a family ranks the
same whoever runs it.

Verification stops at the first model that answers. Only a model-specific failure (an unavailable
or unpermitted model, or an invalid request such as a rejected thinking setting) moves on, at most
three models and only while five seconds of the 30-second budget remain. Missing credentials,
sign-in, TLS, network, quota, and provider-side failures stop at once because every model would
share them. A provider whose only enabled models are Fable reports `no_model` and asks the person
to enable another model. A model-specific error proves the request already passed the network, TLS,
proxy, and credential checks, so when every attempt fails that way the `model_unavailable`
message says the credentials work and lists each model with why it failed, instead of reading
like a sign-in problem. When the catalog gains, renames, or drops a model, update the rank and the
Fable pattern in `verificationCandidates.ts` with it.

## A failed verification explains itself

Desktop onboarding gates on one inference verification. The response used to report only
`passed` or `failed`, so people on corporate machines (AWS SSO profiles, OpenAI-compatible
gateways, TLS-inspecting proxies, proxies a GUI-launched daemon never inherited, models not
enabled in a region) were stuck behind "Couldn't verify" with no reason, and support had only the
daemon log. A failed verification now returns `failure: { kind, message }` and still writes one
daemon warning with the provider, levels, model, and the unsanitized reason.

The message is for the person, not for support: it says what to do (`aws sso login --profile …`,
set `NODE_EXTRA_CA_CERTS`, check `HTTPS_PROXY`, request model access) and names only non-secret
configuration. Vendor text is included only after sanitizing and truncation, because vendors echo
API keys, bearer tokens, signed URLs, and local credential paths in their errors. TLS is checked
before network because fetch reports an untrusted certificate as a bare "fetch failed" network
failure, and a Bedrock 403 that names the model is reported as an unavailable model rather than
bad credentials.
