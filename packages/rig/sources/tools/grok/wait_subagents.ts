/* Grok Build tool contract, modified for Rig. Copyright 2023-2026 SpaceXAI; Apache-2.0. */
import { Type } from "@sinclair/typebox";

import {
    DEFAULT_SUBAGENT_WAIT_TIMEOUT_MS,
    MAX_SUBAGENT_WAIT_TIMEOUT_MS,
    MIN_SUBAGENT_WAIT_TIMEOUT_MS,
} from "../../agent/context/subagentWaitTimeouts.js";
import { defineTool } from "../../agent/types.js";
import { grokSubagentResultSchema } from "./grokSubagentResultSchema.js";
import { waitForGrokSubagents } from "./waitForGrokSubagents.js";

export const grokWaitSubagentsTool = defineTool({
    name: "wait_subagents",
    label: "wait_subagents",
    description:
        "Wait until any or all specified subagents reach a terminal state. Omit timeout_ms so the wait lasts a full hour. A background subagent that finishes notifies you anyway, even while you are idle, so repeated short waits only spend another full model turn to learn nothing. Use get_subagent_output for a non-blocking status check.",
    arguments: Type.Object({
        targets: Type.Array(Type.String(), {
            description: "Subagent Agent IDs (preferred) or canonical task paths to wait for.",
            maxItems: 20,
            minItems: 1,
        }),
        mode: Type.Union([Type.Literal("wait_any"), Type.Literal("wait_all")], {
            description: "Return when the first task completes or after all tasks complete.",
        }),
        timeout_ms: Type.Optional(
            Type.Integer({
                description: `Maximum wait in milliseconds. Defaults to ${DEFAULT_SUBAGENT_WAIT_TIMEOUT_MS} (one hour), which is almost always right; min ${MIN_SUBAGENT_WAIT_TIMEOUT_MS}, max ${MAX_SUBAGENT_WAIT_TIMEOUT_MS}. Never use it as a polling interval.`,
                maximum: MAX_SUBAGENT_WAIT_TIMEOUT_MS,
                minimum: MIN_SUBAGENT_WAIT_TIMEOUT_MS,
            }),
        ),
    }),
    returnType: Type.Object({
        mode: Type.String(),
        results: Type.Array(grokSubagentResultSchema),
    }),
    interruptionMessage: "Waiting for subagents was interrupted by new input.",
    shouldReviewInAutoMode: () => false,
    steerable: true,
    execute: async (
        { mode, targets, timeout_ms = DEFAULT_SUBAGENT_WAIT_TIMEOUT_MS },
        context,
        execution,
    ) => {
        const uniqueTargets = [...new Set(targets.map((target) => target.trim()).filter(Boolean))];
        if (uniqueTargets.length === 0) throw new Error("Provide at least one non-empty target.");
        const results = await waitForGrokSubagents({
            context,
            mode,
            ...(execution.signal === undefined ? {} : { signal: execution.signal }),
            targets: uniqueTargets,
            timeoutMs: timeout_ms,
        });
        return { mode, results };
    },
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: (result) =>
        `Waited for ${result.results.length} subagent${result.results.length === 1 ? "" : "s"}.`,
    locks: [],
});
