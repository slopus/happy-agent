# Skills discovery

Skills are instruction resources on the agent's own compute. The native module
rescans before catalog reads, skill reads, and instruction contributions; it does
not retain completed catalogs. Concurrent scans may share only the same compute,
directory, permission boundary, global availability, and configured folders.

The discovery parser belongs to the global skills owner. Its public parsing seam
keeps YAML metadata and validation identical between management and agent discovery.
Runtime behavior requested by frontmatter remains ordinary skill text.

The original loader has deliberate parsing behavior beyond general YAML: folded
paragraphs retain their line breaks, and some unmatched quotes remain plain text.
The native owner preserves that exact subset and validates its output with the
captured TypeBox schema. A generic YAML replacement changed those results; the
original executable parser fixtures now guard the shared owner.

User-only skills stay installed but leave the model's catalog. A read is permitted
only when an accepted user-origin message requested that skill in this run, or a
matching recorded user invocation supplied its content. Agent-origin messages and
untrusted role labels cannot grant that permission.

An explicit skill command reads the fresh complete document before admission.
The caller then queues its user-origin message and updates the selected mode in
one existing transaction. Rolling back that transaction publishes no work. The
model receives the complete invoked document only while that same name and
installation path remain available; user-only skills remain absent from its
ordinary catalog.
