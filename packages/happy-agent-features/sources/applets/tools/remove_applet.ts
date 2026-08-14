import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import { appletNameSchema } from "../Applet.js";
import type { AppletFeature } from "../AppletFeature.js";

const removeAppletInputSchema = Type.Object(
    { name: appletNameSchema },
    { additionalProperties: false },
);

/** Remove one applet through the host catalog. */
export function removeAppletTool(applets: AppletFeature, agentId: string) {
    return defineAgentTool({
        name: "remove_applet",
        description: "Remove an applet from the host catalog.",
        parameters: removeAppletInputSchema,
        returnType: Type.Boolean(),
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, { name }) => await applets.removeForAgent(ctx, agentId, name),
        toLLM: (removed) => [{ type: "text", text: applets.formatRemovalForModel(removed) }],
    });
}
