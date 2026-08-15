# Agent Base system prompts lack Rig host context

`SystemPromptFeature` now gives the Agent Base path the provider- and model-specific base prompt,
but that is only the model identity and behavioral contract. The new path still omits the
per-agent host context that the legacy runtime assembles around that prompt.

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

## Legacy sources

The current legacy path spreads this work across the following files. Line counts are the source
line counts at the time this debt was recorded:

- `packages/rig/sources/agent/prompt/createSystemPrompt.ts` (166 lines) is the host-context
  assembler. It adds the `AGENTS.md` contract, skill instructions, plugin and workspace context,
  permission guidance, protected paths, and the remaining Rig-owned prompt contributions.
- `packages/rig/sources/agent/prompt/instructions.ts` (170 lines) renders the permission modes,
  sandbox limits, workspace rules, available models, and bundled documentation guidance.
- `packages/rig/sources/agent/prompt/codexInstructions.ts` (149 lines) renders the Codex Bedrock
  environment and permission forms.
- `packages/rig-execution/sources/prompts/assembleSystemPrompt.ts` (27 lines) joins the selected
  model prompt, environment, and Rig context; `assembleEnvironmentPrompt.ts` (25 lines) renders
  the working directory, platform, shell, OS version, models, and workspace/worktree guidance.
- `packages/rig/sources/agent/Agent.ts` (965 lines) refreshes global and project instructions
  before inference. `impl/loadAgentsMdInstructions.ts` (55 lines),
  `impl/findAgentsMdPaths.ts` (24 lines), and `impl/reconcileAgentsMdMessages.ts` (69 lines)
  discover, bound, and deliver those files without rewriting prior conversation history.
- `packages/rig/sources/agent/skills/loadAgentSkillCatalog.ts` (27 lines) and
  `skills/loadSkillInstructions.ts` (11 lines) discover skills and render their prompt
  instructions.
- `packages/happy-providers/sources/vendors/claude/impl/renderClaudeSystemPrompt.ts` (19 lines)
  fills Claude's working-directory, repository, platform, shell, and OS placeholders at the
  provider boundary.

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
