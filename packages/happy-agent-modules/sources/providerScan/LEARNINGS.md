# Provider scan learnings

## Claude verification uses a subscription model

Claude verification previously selected Fable 5.1, which can require extra usage credits even
when a Claude subscription is signed in and can run Sonnet. It now probes Sonnet 5 with the
lowest offered effort, preserving the real inference requirement without requiring premium
model access. The preferred probe is selected by the registry's provider type so named Claude
accounts use the same model instead of falling back to the first, potentially more expensive,
catalog entry. Verification still respects the account's model filters and performs one request.
