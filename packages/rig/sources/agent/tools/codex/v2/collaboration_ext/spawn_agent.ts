import { Type } from "@sinclair/typebox";

import {
    SUBAGENT_EFFORT_ARGUMENT_DESCRIPTION,
    SUBAGENT_MODEL_ARGUMENT_DESCRIPTION,
} from "../../../../context/subagentSelectionDescriptions.js";
import {
    createSpawnCapabilityGrantDescriber,
    spawnGrantsCapabilities,
    subagentCapabilitiesArgumentSchema,
} from "../../../../context/subagentCapabilityDescriptions.js";
import { defineTool } from "../../../../types.js";
import { humanizeTaskName } from "../../impl/humanizeTaskName.js";
import { requireSubagentContext } from "../../impl/requireSubagentContext.js";
import { parseCodexForkTurns } from "../impl/parseCodexForkTurns.js";
import { selectCodexForkMessages } from "../impl/selectCodexForkMessages.js";

export const codexExtendedSpawnAgentTool = defineTool({
    name: "spawn_agent",
    label: "spawn_agent",
    namespace: {
        name: "collaboration_ext",
        description: "Tools for spawning sub-agents across providers and model families.",
    },
    description: `Allowed provider/model pairs: any exact provider ID + model ID pair listed in the session's Available models section.
Use this tool for non-GPT models or when crossing providers. Prefer \`collaboration.spawn_agent\` for GPT models because the native tool preserves Codex's encrypted collaboration transport.

Spawn a background subagent with an explicit provider and model.`,
    arguments: Type.Object(
        {
            capabilities: subagentCapabilitiesArgumentSchema,
            task_name: Type.String({
                description:
                    "Lowercase canonical-path leaf using letters, numbers, and underscores.",
            }),
            message: Type.String({
                description: "Initial plain-text task for the new agent.",
            }),
            provider: Type.String({
                description: "Provider ID for the new agent.",
            }),
            model: Type.String({
                description: SUBAGENT_MODEL_ARGUMENT_DESCRIPTION,
            }),
            fork_turns: Type.Optional(
                Type.String({
                    description:
                        "Optional number of turns to fork. Defaults to `all`. Use `none`, `all`, or a positive integer string such as `3` to fork only the most recent turns.",
                }),
            ),
            reasoning_effort: Type.String({
                description: SUBAGENT_EFFORT_ARGUMENT_DESCRIPTION,
            }),
            read_only: Type.Optional(
                Type.Boolean({
                    description:
                        "Run this child in Read only. Omit or set false to inherit the parent permission mode.",
                }),
            ),
            service_tier: Type.Optional(
                Type.Literal("priority", {
                    description:
                        "Service tier override for the new agent. Omit unless explicitly requested.",
                }),
            ),
        },
        { additionalProperties: false },
    ),
    returnType: Type.Object({
        agent_id: Type.String(),
        path: Type.String(),
    }),
    describeAutoPermissionAction: createSpawnCapabilityGrantDescriber({
        inheritsConversationByDefault: true,
    }),
    shouldReviewInAutoMode: spawnGrantsCapabilities,
    execute: async (args, context, execution) => {
        const {
            capabilities,
            fork_turns,
            message,
            model,
            provider,
            read_only,
            reasoning_effort,
            service_tier,
            task_name,
        } = args;
        const subagents = requireSubagentContext(context);
        const availableModels = subagents.availableModels;
        if (
            availableModels !== undefined &&
            !availableModels.some(
                (candidate) => candidate.providerId === provider && candidate.id === model,
            )
        ) {
            throw new Error(`Model '${model}' is not available for provider '${provider}'.`);
        }
        const fork = parseCodexForkTurns(fork_turns);
        const parentMessages = execution.messages?.slice(0, -1);
        const result = await subagents.spawn(
            {
                background: true,
                ...(capabilities === undefined || capabilities.length === 0
                    ? {}
                    : { capabilities }),
                contextMode: fork.contextMode,
                ...(fork.contextMode === "parent" && parentMessages !== undefined
                    ? { contextMessages: selectCodexForkMessages(parentMessages, fork.lastNTurns) }
                    : {}),
                description: humanizeTaskName(task_name),
                effort: reasoning_effort,
                modelId: model,
                providerId: provider,
                ...(read_only === undefined ? {} : { readOnly: read_only }),
                ...(service_tier === "priority" ? { serviceTier: "fast" as const } : {}),
                ...(execution.toolCallId === undefined
                    ? {}
                    : { parentToolCallId: execution.toolCallId }),
                prompt: message,
                taskName: task_name,
            },
            execution.signal,
        );
        return {
            agent_id: result.agentId,
            path: result.path,
        };
    },
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: (_result, args) => `Started background task ${humanizeTaskName(args.task_name)}.`,
    locks: [],
});
