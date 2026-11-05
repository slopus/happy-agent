# Node module learnings

## Installation identity may use a transactional SQL singleton

Node configuration must be available before any conversation agents exist, including in team
deployments. The frozen core supplies a module's shared `AgentKV` only through agent lifecycle
hooks, so that store cannot own this installation's startup identity without a core change.
The user explicitly approved a storage exception for this feature: one bounded transactional
SQL singleton holds the name, normalized avatar bytes, ThumbHash, and content ETag. Do not create
a synthetic conversation agent to obtain storage or change the frozen core for this feature.
Durable Functions own the post-commit write of the name to generated runtime configuration.

## Node identity is separate from P2P and people

The node is the Happy Agent installation, not its P2P identity, a bot, a conversation agent, or
the human profile. Its display information belongs in `config.node`, including desktop bootstrap's
existing config snapshot. Avatar presence is only `{ thumbhash } | null`, never an additional
boolean. Name and avatar changes invalidate config through `config.updated`; only image bytes
need a separate authenticated endpoint.

## Managed pictures share one normalization function

Node, bot, and Surface pictures had duplicated WebP, hash, and ThumbHash processing. They now
call the same bounded managed-image function. Existing decoded-pixel limits remain options;
each owner still handles its own filesystem permissions, persisted representation, and events.

## A new Mac installation looks like that Mac

Steve asked that a first install on a Mac name itself after the Mac and use the user's picture.
The name already came from `scutil --get ComputerName`; the avatar was always `null`. On the first
start only, the node now also reads the account picture with `dscl` (preferring `JPEGPhoto`, which
is the cropped image the system shows, over the original `Picture` file) and converts other
formats with `sips`. This is a convenience default, so every failure is silent and yields no
avatar, detection never runs once the row exists, and the seeding insert stays conditional so a
concurrent start cannot overwrite the first.

## Account-picture detection must not trigger a privacy prompt

Kirill pointed out that reading the account `Picture` file could ask for Desktop, Documents, or
Downloads access, since macOS protects those folders and the record may point anywhere. A first
start must never surprise the person with a permission prompt for a cosmetic default. Directory
reads go through Open Directory rather than the protected folders, and the `JPEGPhoto` bytes are
converted only in a temporary directory; the `Picture` fallback is read only when its normalized
path is under `/Library/User Pictures/` or `/System/Library/`, and is otherwise skipped.
