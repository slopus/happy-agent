# Provider scan learnings

## Claude verification uses a subscription model

Claude verification previously selected Fable 5.1, which can require extra usage credits even
when a Claude subscription is signed in and can run Sonnet. It now probes Sonnet 5 with the
lowest offered effort, preserving the real inference requirement without requiring premium
model access. The preferred probe is selected by the registry's provider type so named Claude
accounts use the same model instead of falling back to the first, potentially more expensive,
catalog entry. Verification still respects the account's model filters and performs one request.

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
