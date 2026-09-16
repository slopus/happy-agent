# Common service tools

These four definitions are installed by the owning module's fixed tool array, unchanged across
providers. They do not alter ordinary shell tools. Only trusted agent placement chooses workspace
membership; model arguments cannot supply an owner, workspace, credentials, or elevation request.

Start and stop require Auto or Full access. Start, nonempty stdin, and stop request review without
elevation. Empty polls and discovery skip review. Start, input, and stop are non-replayable;
discovery is durable and reloadable. The SDK enforces the existing mandatory sandbox even in Full
access and serializes stdin writes.

Start/input share the approved service snapshot. Output uses a conservative UTF-8 byte-per-token
bound, capped at 10,000 bytes, below every currently curated model's shell output policy. Capture
or response loss is explicit. Discovery lists all active services plus at most 256 newest stopped
records, reports omitted history, and abbreviates display names and exceptionally long commands.
