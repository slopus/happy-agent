import { Type } from "@sinclair/typebox";

import {
    SUBAGENT_EFFORT_ARGUMENT_DESCRIPTION,
    SUBAGENT_MODEL_ARGUMENT_DESCRIPTION,
} from "../../context/subagentSelectionDescriptions.js";
import {
    describeSpawnCapabilityGrant,
    spawnGrantsCapabilities,
    subagentCapabilitiesArgumentSchema,
} from "../../context/subagentCapabilityDescriptions.js";
import { defineTool } from "../../types.js";

const completedAgentResultSchema = Type.Object({
    agentId: Type.String(),
    output: Type.String(),
    path: Type.String(),
    status: Type.Literal("completed"),
});

const backgroundAgentResultSchema = Type.Object({
    agentId: Type.String(),
    path: Type.String(),
    status: Type.Literal("async_launched"),
});

export const claudeAgentTool = defineTool({
    name: "Agent",
    label: "Agent",
    description:
        "Start a subagent for a focused, self-contained task. Agents run in the background by default and report back when they finish. Set run_in_background to false when the result is needed immediately.",
    arguments: Type.Object({
        capabilities: subagentCapabilitiesArgumentSchema,
        context: Type.Optional(
            Type.Union([Type.Literal("parent"), Type.Literal("task")], {
                description:
                    "Rig extension: use parent to continue with the parent thread context, or task to start with only the delegated prompt. Defaults to task.",
            }),
        ),
        description: Type.String({
            description: "A short, human-readable description of the delegated task.",
        }),
        prompt: Type.String({
            description: "Complete instructions for the subagent.",
        }),
        effort: Type.String({
            description: SUBAGENT_EFFORT_ARGUMENT_DESCRIPTION,
        }),
        model: Type.String({
            description: `${SUBAGENT_MODEL_ARGUMENT_DESCRIPTION} The provider is inferred from recent successful use, the current provider, or the first available match.`,
        }),
        provider: Type.Optional(
            Type.String({
                description:
                    "Child provider ID. The model is inferred from recent successful use, the current model, or the first available model.",
            }),
        ),
        read_only: Type.Optional(
            Type.Boolean({
                description:
                    "Run this child in Read only. Omit or set false to inherit the parent permission mode.",
            }),
        ),
        run_in_background: Type.Optional(
            Type.Boolean({
                description:
                    "Agents run in the background by default. Set to false to wait for the result before continuing.",
            }),
        ),
        service_tier: Type.Optional(
            Type.Literal("priority", {
                description:
                    "Service tier override for the new agent. Omit unless explicitly requested.",
            }),
        ),
    }),
    returnType: Type.Union([completedAgentResultSchema, backgroundAgentResultSchema]),
    describeAutoPermissionAction: describeSpawnCapabilityGrant,
    shouldReviewInAutoMode: spawnGrantsCapabilities,
    execute: async (
        {
            capabilities,
            context: contextMode = "task",
            description,
            effort,
            model,
            prompt,
            provider,
            read_only,
            run_in_background = true,
            service_tier,
        },
        context,
        execution,
    ) => {
        if (context.subagents === undefined || !context.subagents.canSpawn) {
            throw new Error("This agent has reached the maximum subagent depth.");
        }
        const result = await context.subagents.spawn(
            {
                ...(capabilities === undefined || capabilities.length === 0
                    ? {}
                    : { capabilities }),
                description,
                effort,
                ...(run_in_background === true ? { background: true } : {}),
                contextMode,
                ...(contextMode === "parent" && execution.messages !== undefined
                    ? { contextMessages: execution.messages.slice(0, -1) }
                    : {}),
                modelId: model,
                prompt,
                ...(read_only === undefined ? {} : { readOnly: read_only }),
                ...(provider === undefined ? {} : { providerId: provider }),
                ...(service_tier === "priority" ? { serviceTier: "fast" as const } : {}),
                ...(execution.toolCallId !== undefined
                    ? { parentToolCallId: execution.toolCallId }
                    : {}),
            },
            execution.signal,
        );
        if (result.status === "running") {
            return {
                agentId: result.agentId,
                path: result.path,
                status: "async_launched",
            };
        }
        if (result.status !== "completed") {
            throw new Error(result.output);
        }
        return {
            agentId: result.agentId,
            output: result.output,
            path: result.path,
            status: "completed",
        };
    },
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: (result, args) =>
        result.status === "async_launched"
            ? `Running in background: ${args.description}`
            : `Completed: ${args.description}`,
    locks: [],
});
