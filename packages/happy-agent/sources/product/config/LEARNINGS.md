# Native configuration learnings

Runner shell policy uses the project's canonical root even when a command runs
from a subdirectory. It protects network policy files alongside other root
settings, rejects symbolic-link guards and invalid root names, and carries the
Source sensitive and product-private read boundaries. Read only mode has no
write grants or explicit write guards. Host allowlists enable the supervisor's
managed proxy; naming a host does not also permit a private address it resolves to.

Security review previously interpreted an agent's compute directory as a path on the daemon.
A remote directory with the same spelling could therefore select unrelated host instructions.
Configuration now reads only its own global security policy and public configuration folder's
project policy, with the Source headings and exact byte bounds. SystemPrompt owns the agent's
live instruction hierarchy through compute, including remote files.

Idle Codex and Grok logins renew without inference, including enabled hidden accounts. The same
credential selection as inference excludes static keys, disabled accounts, Claude and smart
aliases. ProviderScan owns one durable maintenance lifetime; a completed pass schedules the
next one three hours later, and restart performs the Source startup pass again. Each pass has
bounded concurrency and per-account time limits. Credential failures expose no diagnostics,
never change enablement and never fail a successful turn.

Private reviewer models were selected correctly but then rejected by the ordinary inference
factory's public model filters, silently falling back to the main model. Reviewers now use
Config's private catalog validation while sharing the same credential selection, provider
construction and cancellation lifetime. The hidden routes remain absent from public model
catalogs and ordinary inference continues to enforce its public filters.

The original configuration endpoint echoed the raw presence table, so a fresh installation
returned only an empty states object and failed the published API schema. Configuration now
asks the Presence owner for its effective selection and full catalog, including configured
refinements and stored definitions. Expiry and manual selection remain owned by Presence;
the public snapshot always carries current, fallback and all four display fields per state.
