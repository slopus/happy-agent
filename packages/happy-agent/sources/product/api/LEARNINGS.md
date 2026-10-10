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

Reordering subtasks must publish the coordinator's complete new tree, with every descendant's
independent version, rather than only advancing the coordinator's timestamp. Capturing replay
cursors inside the transaction left the tree behind child frames from the same commit. Events
now assigns those cursors when appending the committed coordinator frame, after its child frames;
an eventless descendant uses that new valid frame cursor. The journal makes room for the new frame
before assigning those cursors, so a child frame evicted by that append also uses the current
fallback. The public delta then matches the next focused snapshot without requiring another tree
fetch. Creation and parent activity publication remain separate lifecycle work.
