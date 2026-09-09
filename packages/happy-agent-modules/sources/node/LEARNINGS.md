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
