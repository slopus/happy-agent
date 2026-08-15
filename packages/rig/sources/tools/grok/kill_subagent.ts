/* Grok Build tool contract, modified for Rig. Copyright 2023-2026 SpaceXAI; Apache-2.0. */
import { Type } from "@sinclair/typebox";

import { defineTool } from "../../agent/types.js";
import { isDatabaseFailure } from "../../persistence/isDatabaseFailure.js";

export const grokKillSubagentTool = defineTool({
    name: "kill_subagent",
    label: "kill_subagent",
    description: "Stop a subagent by its Agent ID (preferred) or canonical task path.",
    arguments: Type.Object({
        target: Type.String({
            description: "The subagent's Agent ID (preferred) or canonical task path.",
        }),
    }),
    returnType: Type.Object({
        agent_id: Type.Optional(Type.String()),
        path: Type.Optional(Type.String()),
        outcome: Type.Union([Type.Literal("not_found"), Type.Literal("stopped")]),
        message: Type.String(),
        target: Type.String(),
    }),
    shouldReviewInAutoMode: () => false,
    execute: async ({ target }, context) => {
        if (context.subagents === undefined) {
            return {
                target,
                outcome: "not_found",
                message: `Subagent ${target} was not found.`,
            };
        }
        try {
            const stopped = await context.subagents.interrupt(target);
            return {
                agent_id: stopped.agentId,
                path: stopped.path,
                outcome: "stopped",
                message: `Subagent ${stopped.description} was stopped.`,
                target,
            };
        } catch (error) {
            if (isDatabaseFailure(error)) throw error;
            return {
                target,
                outcome: "not_found",
                message: `Subagent ${target} was not found.`,
            };
        }
    },
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: (result) => result.message,
    locks: [],
});
