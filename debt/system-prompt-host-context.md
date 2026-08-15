# Agent Base system prompts lack Rig host context

`SystemPromptFeature` now gives the Agent Base path the provider- and model-specific base prompt,
but that is only the model identity and behavioral contract. The new path still omits the
per-agent host context that Rig must compose around that prompt.

## What is missing

- Environment context: the session working directory, platform, shell, OS version, repository
  state, and the workspace/worktree guidance derived from them.
- The user's global instructions and the applicable `AGENTS.md` and `AGENTS_SECURITY.md` files,
  including discovery from the project root through the session working directory and
  superseding notices when those files change.
- The available skill catalog and its model-facing usage instructions.
- The effective permission mode, sandbox boundaries, protected paths, and tool-specific Auto
  permission guidance.

None of these reaches inference through `RigAgentService` today.

## Why this is host debt

This cannot simply move into `SystemPromptFeature`. One feature instance serves every agent in
the daemon, while each Rig agent has a different working directory, project instruction chain,
permission mode, protected-path set, and potentially a different container. Those values belong
to the host and must be resolved for the agent whose inference is running.

`AGENTS.md` discovery also needs filesystem access through that agent's real sandbox boundary.
The feature package has no such boundary today. As described in
`debt/compute-feature-per-agent.md`, Rig cannot supply one shared `Compute` safely and the current
compute surface has no agent identity with which a Rig-side façade could select the correct
workspace or container. Until a per-agent host-context or compute resolver exists, adding this
logic to `SystemPromptFeature` would either leak one agent's context to another or bypass Rig's
filesystem and permission model.
