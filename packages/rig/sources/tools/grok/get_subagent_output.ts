/* Grok Build tool contract, modified for Rig. Copyright 2023-2026 SpaceXAI; Apache-2.0. */
import { Type } from "@sinclair/typebox";

import { MAX_SUBAGENT_WAIT_TIMEOUT_MS } from "../../agent/context/subagentWaitTimeouts.js";
import { defineTool } from "../../agent/types.js";
import { grokSubagentResultSchema } from "./grokSubagentResultSchema.js";
import { readGrokSubagent } from "./read_grok_subagent.js";
import { waitForGrokSubagents } from "./waitForGrokSubagents.js";

export const grokGetSubagentOutputTool = defineTool({
    name: "get_subagent_output",
    label: "get_subagent_output",
    description:
        "Get status for one or more subagents. A positive timeout_ms waits for completion; omit it or pass 0 for a non-blocking snapshot. Completed output is delivered to the parent transcript.",
    arguments: Type.Object({
        targets: Type.Array(Type.String(), {
            description:
                "Subagent Agent IDs (preferred) or canonical task paths. For one subagent, pass a one-element array. At most 20 targets.",
            maxItems: 20,
            minItems: 1,
        }),
        timeout_ms: Type.Optional(
            Type.Integer({
                description:
                    "Maximum wait in milliseconds. A positive value waits; omit or pass 0 to poll.",
                maximum: MAX_SUBAGENT_WAIT_TIMEOUT_MS,
                minimum: 0,
            }),
        ),
    }),
    returnType: Type.Object({ results: Type.Array(grokSubagentResultSchema) }),
    interruptionMessage: "Waiting for subagent status was interrupted by new input.",
    shouldReviewInAutoMode: () => false,
    steerable: true,
    execute: async ({ targets, timeout_ms = 0 }, context, execution) => {
        const uniqueTargets = [...new Set(targets.map((target) => target.trim()).filter(Boolean))];
        if (uniqueTargets.length === 0) throw new Error("Provide at least one non-empty target.");
        return {
            results:
                timeout_ms > 0
                    ? await waitForGrokSubagents({
                          context,
                          mode: "wait_all",
                          ...(execution.signal === undefined ? {} : { signal: execution.signal }),
                          targets: uniqueTargets,
                          timeoutMs: timeout_ms,
                      })
                    : uniqueTargets.map((target) => readGrokSubagent({ context, target })),
        };
    },
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: (result) =>
        `Checked ${result.results.length} subagent${result.results.length === 1 ? "" : "s"}.`,
    locks: [],
});
