# Surface model tools

One fixed common array serves every model. Todo operations name their Surface instance and use
current-version guards. `update_surface` renames any Surface or replaces or removes its picture
from an absolute image path; it is reviewed in Auto, elevates only for outside-workspace or
symlink images, and settles its durable result in the edit's own transaction. A separate fixed
admin array adds the other type-specific creation tools and user administration only for actual
active admin bots. Every mutation owns its permission policy.

Document tools read the Markdown projection at the latest or an earlier `seq`, write full
replacement Markdown against the `seq` the model read, replace exact text in the latest version,
and list the change log. `edit_document` takes `old_string`, `new_string`, and `replace_all` like
the file edit tools, needs no `seq`, fails without writing when the text is absent or not unique,
and returns only the new `seq`, whether anything changed, and the number of replacements, so a
small change costs a few tokens instead of the document twice. A write applies
only the difference from that version, so people's concurrent edits survive, and it is refused
with an explanation when the document holds content Markdown cannot represent. Blank lines are
content: blocks are one blank line apart and every two more blank lines are an empty paragraph,
so an agent removes or adds empty paragraphs by writing fewer or more of them. Reads skip review;
writes require shared-data Auto review without filesystem elevation.

`create_document_surface` is in the document array, so every agent can make a document. An agent
names the person it is working for as the creator, or null when it works for nobody, and anything
else is refused with the value to pass; an active admin bot may name anyone. Standalone mode has
only the local person, so only null is accepted there. Creation is reviewed in Auto and has the
same optional managed-image boundary as todo creation.

Calendar tools live in their own fixed array merged into the common one. They read and write
timed values as local ISO 8601 date-times in an IANA zone, list occurrences the daemon expanded,
and restore history through ordinary update. Admin bots also receive `create_calendar_surface`.

`read_system_monitor` is an ordinary read tool with no Auto review. It reads a shared daemon-host
snapshot and presents CPU, GPU, memory, disk, and top-five CPU/memory process summaries. Active
admin bots receive `create_system_monitor_surface`, with the same explicit creator, image,
durable replay, authority checks, and permission boundary as other Surface creation tools.

Admin bots receive `create_artifact_surface`, `create_bot_surface`, and `create_task_surface`.
Each names its own target field, requires an explicit creator, and accepts an optional image.
They reject missing or inactive targets as not found and never change the target's own access,
membership, or catalog.
