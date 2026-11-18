# Provider scan learnings

## Verification tries the cheapest models and never Fable

Verification used to pick one hard-coded model per provider type (Fable 5 on Bedrock, Sonnet 5 on
Claude) at the first effort level. That failed real setups: Fable can need extra usage credits
on a Claude subscription, Bedrock rejects Fable 5's "off" level (`thinking.type.disabled` is not
supported), and Fable 5's default Mantle transport answers "model does not exist" where Mantle does
not serve it. Steve's rule: test from cheapest to most expensive, and never test with Fable.

`verificationCandidates.ts` now drops every `anthropic/fable*` model and orders the provider's
enabled models by a static relative cost rank by family (Haiku, Luna, and Composer first; then
Sonnet, Terra, and the other Grok models; then Opus and Sol; then Astra). The rank is relative,
not prices, because Happy has no price data; unranked models go last in configuration order.
The effort is the cheapest one the model accepts other than "off" (low, minimal, medium, then the
default), and "off" only when it is the model's only level.

Verification stops at the first model that answers. Only a model-specific failure (an unavailable
or unpermitted model, or an invalid request such as a rejected thinking setting) moves on, at most
three models and only while five seconds of the 30-second budget remain. Missing credentials,
sign-in, TLS, network, quota, and provider-side failures stop at once because every model would
share them. A provider whose only enabled models are Fable reports `no_model` and asks the person
to enable another model. When the catalog gains, renames, or drops a model, update the rank and the
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
