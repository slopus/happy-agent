# Tab model tools

One fixed common array serves every model. Todo operations name their Tab instance and use
current-version guards. `update_tab` renames any Tab or replaces or removes its picture
from an absolute image path; it is reviewed in Auto, elevates only for outside-workspace or
symlink images, and settles its durable result in the edit's own transaction. A separate fixed
admin array adds type-specific creation and user administration only for actual active admin bots. Every mutation owns its permission policy.

Document tools read the Markdown projection at the latest or an earlier `seq`, write full
replacement Markdown against the `seq` the model read, and list the change log. A write applies
only the difference from that version, so people's concurrent edits survive, and it is refused
with an explanation when the document holds content Markdown cannot represent. Reads skip review;
writes require shared-data Auto review without filesystem elevation. Document creation has the
same optional managed-image boundary as todo creation.

Calendar tools live in their own fixed array merged into the common one. They read and write
timed values as local ISO 8601 date-times in an IANA zone, list occurrences the daemon expanded,
and restore history through ordinary update. Admin bots also receive `create_calendar_tab`.

`read_system_monitor` is an ordinary read tool with no Auto review. It reads a shared daemon-host
snapshot and presents CPU, GPU, memory, disk, and top-five CPU/memory process summaries. Active
admin bots receive `create_system_monitor_tab`, with the same explicit creator, image,
durable replay, authority checks, and permission boundary as other Tab creation tools.

Admin bots receive `create_artifact_tab`, `create_bot_tab`, and `create_task_tab`.
Each names its own target field, requires an explicit creator, and accepts an optional image.
They reject missing or inactive targets as not found and never change the target's own access,
membership, or catalog.
