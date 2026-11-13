# Stable prompt learnings

## The system prompt is fixed and changes are appended

Fable 5.2 on Bedrock failed on the second request of a new task's first turn with `Invalid
signature in thinking block ... The system prompt differs from the one this block was created
with`: automatic naming had renamed the task between the two requests, and the name was in the
system prompt. Moving the name out fixed that case, and the same failure was then reproduced for a
collaborator being created, presence changing, a bot being named, and the permission mode being
switched between turns. Fixing contributors one by one would never end. The direction given was to
limit the system prompt and append changes instead, like a diff, so the prompt cache is never lost.

The module therefore stores the first prompt of a history and returns it for every later request,
and reports later changes as one notice of the changed lines after the next message. It lives in
the modules layer, not in Agent Base: `overrideInstructions` already has the last word on the
prompt for inference and compaction alike, and the history store is emptied in exactly the places
where history is rebuilt and nothing earlier is replayed.

## The notice follows the message, and compares lines

Fresh instructions exist only while a request is being built, after the message boundary, so the
notice is appended at the first inference boundary after a message rather than before the message.
Telling the model before the message would need Agent Base to hand instruction contributions to
the message boundary.

Changes are reported by line of the final prompt, not by contributing module. The system-prompt
module's one contribution is the model prompt, the environment, and AGENTS.md together, so a
section-level notice would repeat tens of kilobytes to change one line, and an earlier override
can replace every contribution anyway.

## AGENTS.md keeps its own notice

AGENTS.md documents were already delivered again in full when they changed. Reporting their lines
here as well would tell the model the same thing twice, so that part of the prompt is excluded
from the comparison.
