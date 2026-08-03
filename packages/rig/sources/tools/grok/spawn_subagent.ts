/* Grok Build tool contract, modified for Rig. Copyright 2023-2026 SpaceXAI; Apache-2.0. */
import { Type } from "@sinclair/typebox";

import {
    SUBAGENT_EFFORT_ARGUMENT_DESCRIPTION,
    SUBAGENT_MODEL_ARGUMENT_DESCRIPTION,
} from "../../agent/context/subagentSelectionDescriptions.js";
import {
    describeSpawnCapabilityGrant,
    spawnGrantsCapabilities,
    subagentCapabilitiesArgumentSchema,
} from "../../agent/context/subagentCapabilityDescriptions.js";
import { defineTool } from "../../agent/types.js";
import { requireSubagentContext } from "../../agent/tools/codex/impl/requireSubagentContext.js";

export const grokSpawnSubagentTool = defineTool({
    name: "spawn_subagent",
    label: "spawn_subagent",
    description:
        "Launch a subagent to handle a concrete, bounded task. Background subagents return immediately and share the current workspace.",
    arguments: Type.Object({
        capabilities: subagentCapabilitiesArgumentSchema,
        prompt: Type.String({ description: "The full task prompt for the subagent to execute." }),
        description: Type.String({ description: "Short description of the task in 3-5 words." }),
        model: Type.String({
            description: SUBAGENT_MODEL_ARGUMENT_DESCRIPTION,
        }),
        effort: Type.String({
            description: SUBAGENT_EFFORT_ARGUMENT_DESCRIPTION,
        }),
        provider: Type.Optional(
            Type.String({
                description:
                    "Optional provider ID for the new agent. Omit to let Rig select an available provider for the model.",
            }),
        ),
        context: Type.Optional(
            Type.Union([Type.Literal("parent"), Type.Literal("task")], {
                description:
                    "Use parent to continue with the parent thread context, or task to start with only the delegated prompt. Defaults to task.",
            }),
        ),
        subagent_type: Type.Optional(
            Type.String({
                description:
                    'Subagent type. Use "explore" for read-only investigation or "general-purpose" for implementation.',
            }),
        ),
        read_only: Type.Optional(
            Type.Boolean({
                description:
                    "Run this child in Read only. Omit or set false to inherit the parent permission mode.",
            }),
        ),
        background: Type.Optional(
            Type.Boolean({
                description:
                    "Return immediately with the Agent ID and canonical path. Defaults to true; use the output tool to inspect status.",
            }),
        ),
        service_tier: Type.Optional(
            Type.Literal("priority", {
                description:
                    "Service tier override for the new agent. Omit unless explicitly requested.",
            }),
        ),
    }),
    returnType: Type.Object({
        agent_id: Type.String(),
        path: Type.String(),
        status: Type.String(),
        output: Type.Optional(Type.String()),
    }),
    describeAutoPermissionAction: describeSpawnCapabilityGrant,
    shouldReviewInAutoMode: spawnGrantsCapabilities,
    execute: async (
        {
            background = true,
            capabilities,
            context: contextMode = "task",
            description,
            effort,
            model,
            prompt,
            provider,
            read_only,
            service_tier,
            subagent_type,
        },
        context,
        execution,
    ) => {
        const result = await requireSubagentContext(context).spawn(
            {
                background,
                ...(capabilities === undefined || capabilities.length === 0
                    ? {}
                    : { capabilities }),
                contextMode,
                ...(contextMode === "parent" && execution.messages !== undefined
                    ? { contextMessages: execution.messages.slice(0, -1) }
                    : {}),
                description,
                effort,
                modelId: model,
                ...(provider === undefined ? {} : { providerId: provider }),
                prompt,
                ...(read_only !== undefined || subagent_type === "explore"
                    ? { readOnly: read_only ?? true }
                    : {}),
                ...(service_tier === "priority" ? { serviceTier: "fast" as const } : {}),
                taskName: toTaskName(description),
                ...(execution.toolCallId === undefined
                    ? {}
                    : { parentToolCallId: execution.toolCallId }),
            },
            execution.signal,
        );
        if (!background && result.status !== "completed") {
            throw new Error(result.output);
        }
        return {
            agent_id: result.agentId,
            path: result.path,
            status: result.status,
            ...(result.output.length === 0 ? {} : { output: result.output }),
        };
    },
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: (result, args) => {
        const description = args.description.trim() || "Delegated task";
        const punctuation = /[.!?]$/u.test(description) ? "" : ".";
        return `Started a subagent: ${description}${punctuation}`;
    },
    locks: [],
});

function toTaskName(description: string): string {
    const normalized = description
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, "_")
        .replace(/^_+|_+$/gu, "")
        .slice(0, 48);
    return normalized || "delegated_task";
}
