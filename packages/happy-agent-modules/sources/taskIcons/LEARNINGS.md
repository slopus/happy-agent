# Task icons — learnings

## Each task chooses its own identity through ordinary tools

Automatic naming previously chose an icon from a small prompt enum, independently of the task
agent. Rich top-level tasks now receive BM25 catalog search and a scoped title/icon setter beside
their other tools. They inspect at most ten candidates and decide themselves; no catalog-sized
enum is sent in the prompt. Automatic naming skips those tasks so it cannot race their choices.
Tasks with rich tasks disabled retain ordinary automatic naming and their existing tool set.

Identity writes use a Durable Functions intent keyed by the tool call, following the same pattern
as sidebar status. The runtime forbids writing an agent's metadata from inside its own turn, so
the executor runs outside it and applies the canonical task mutation. It starts as soon as the
tool call's transaction commits, not when the turn ends; the tool once told the model "when this
turn ends", which was untrue, so its text now says the change applies within moments. Both eligibility and human
choices are checked before queueing and again in the write transaction. A later human choice
makes the queued change a completed no-op.

## The daemon owns the artwork and its digest

Bundling a separate catalog in every client limited the available icons and coupled UI releases
to icon selection. The daemon now bundles all artwork, adds its digest to known icon projections,
and serves versioned WebP images through the existing authenticated transport. Clients cache by
digest. A wrong version returns 404 so a mutable URL cannot enter an immutable cache.

The legacy `waveform` choice resolves to canonical `audio` artwork. The logical stored slug stays
unchanged, its projection uses the audio digest, and its versioned route returns the same bytes.
All 139 legacy choices resolve without adding a 2,001st canonical topic or duplicate asset.
