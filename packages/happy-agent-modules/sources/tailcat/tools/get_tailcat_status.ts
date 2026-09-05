import { defineAgentTool } from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";

import { tailcatStatusSchema } from "../Tailcat.js";
import type { TailcatModule } from "../TailcatModule.js";
import { formatTailcatStatus } from "./tailcatToolOutput.js";

/** Read the desired and live state of this installation's Tailcat internet exposure. */
export function getTailcatStatusTool(tailcat: TailcatModule, actingAgentId: string) {
    return defineAgentTool({
        name: "get_tailcat_status",
        defer: true,
        capabilities: ["Enable, disable, and inspect Tailcat internet exposure."],
        searchKeywords: ["Tailcat address", "internet tunnel status", "public team server"],
        description:
            "Read whether Tailcat internet exposure is enabled and open. When open, the result includes the stable Tailcat connection address.",
        parameters: Type.Object({}, { additionalProperties: false }),
        returnType: tailcatStatusSchema,
        durable: false,
        reloadable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx) => await tailcat.getStatus(ctx, actingAgentId),
        toLLM: (status) => [{ type: "text", text: formatTailcatStatus(status) }],
    });
}
