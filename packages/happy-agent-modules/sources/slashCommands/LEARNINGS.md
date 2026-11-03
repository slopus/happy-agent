# Slash command learnings

## Complete skill catalogs must not inherit prompt limits

The 256-command and 256-KiB catalog caps made agent creation fail once the skill installation
outgrew them, even if the model prompt was small. Steve directed the API to return all available
skills. After updating and publishing the client contract, the runtime no longer applies these
aggregate caps. Every command still undergoes per-entry validation, duplicate names are refused,
and images remain separately served. The prompt's skill shortlist never substitutes for the
complete ordered API catalog.

## Startup optimization preserves required discovery

The API requires catalog loading on creation and restoration, before every turn, and before
invocation. Skipping restoration or deferring it until a client opens the agent would violate that
contract. Startup now benefits from Skills sharing concurrent equivalent scans and batching metadata
reads; each agent still loads its own complete catalog and publishes its own changes.

Restoration starts every agent's load but no longer waits for it. Awaited, the loads held readiness
for about two of the three seconds a restart of a thousand agents took, because the restore
transactions serialize and so the scans rarely overlapped to be shared. Four restored agents load
at a time behind the daemon becoming ready; a catalog read, an invocation, or a turn for an agent
still waiting loads it immediately through the same coalesced refresh, so no reader sees less than
before.

Agent Base now restores an agent that owes no work on its first use rather than at start, so a
catalog is loaded when its agent is restored, at start or on first use, and no longer for every
agent right after a restart. A catalog read still loads one not yet loaded, and a turn or
invocation still refreshes first. What changes is that a skill added while the daemon was down
announces `agent.slash_commands.updated` for an untouched agent when that agent is next used or
read, the same as a skill added while the daemon runs.

## Loading latency needs stage-level traces

Restoring hundreds of agents can spend seconds rebuilding command catalogs. A single hook duration
does not distinguish context lookup, skill discovery, and event publication. Command loading now
records nested spans for those stages and each contributor, with skill discovery split into compute
resolution and filesystem scanning. Cached reads do no discovery, and concurrent refreshes still
share one load. Span names contain stable operations and module names, not agent IDs or file paths.

## Command images are separate resources

Command catalogs and events carry only the image ThumbHash needed for immediate rendering. The
module keeps the complete bytes beside the cached private command owner, and the API serves them
from the focused command image endpoint with a content-derived ETag. This keeps bootstrap and live
events small while still making image changes observable through catalog replacement events.
