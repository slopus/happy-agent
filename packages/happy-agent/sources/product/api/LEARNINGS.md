# Native API learnings

The Rust daemon omitted the existing onboarding endpoints. The API now reads current profile,
active-project and enabled-provider readiness through their owning modules. Explicit completion
writes Config's private installation marker atomically with owner-only permissions, survives
restart and emits no configuration event. Standalone completion remains advisory when the
profile has no name, as required by the authoritative API and original implementation.

Master plan 19's mandatory verified email and inference gate conflict with the current advisory
standalone API. The interface-preserving Rust rewrite follows the existing approved API at the
human's direction; introducing those unshipped requirements requires a separate specification
change. Team transport and authenticated-member readiness remain a separate unfinished gate.
