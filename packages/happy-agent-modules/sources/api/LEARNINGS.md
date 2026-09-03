# API module learnings

## Composer mode

- A null `mode.serviceTier` must reach Agent Base as an explicit `null`, never as an omission and
  never as a sentinel tier string. Agent Base persists the last tier and reads an omitted message
  option as "keep the previous tier", so omission leaves a stale tier in force — including the
  retired `"default"` sentinel written by earlier releases, which Codex rejects on every turn and
  which nothing else ever clears. The same rule applies to every sibling send path that stamps a
  mode on a message: the tier the mode claims is the tier the message must carry.
