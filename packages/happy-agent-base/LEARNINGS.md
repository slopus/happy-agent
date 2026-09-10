# Agent Base learnings

## An unavailable old provider must not prevent a provider switch

Checking Bedrock GPT context compatibility resolved both the old and new providers. If the old
provider was disabled or its factory could no longer resolve the route, that check threw before
the replacement message was accepted, leaving the existing conversation stuck on its old settings.

A failed compatibility lookup for the old route now means compatibility is unknown, just as when
the provider is absent from the registry. The switch uses the existing private-context reset and
`modelChanged` handoff, without replacing the agent or clearing module-owned durable history. The
new provider's lookup still fails normally: this does not enable a disabled account, choose an
unrequested fallback, or hide a broken replacement. Regression coverage includes removed and
disabled old providers, restored sessions, stable message acceptance, and later follow-up turns.
