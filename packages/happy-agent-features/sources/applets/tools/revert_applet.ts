import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    appletNameSchema,
    appletSchema,
    appletToolRevertInputSchema,
    type AppletToolRevertInput,
} from "../Applet.js";
import type { AppletFeature } from "../AppletFeature.js";

const revertAppletToolInputSchema = Type.Object(
    {
        name: appletNameSchema,
        version: appletToolRevertInputSchema.properties.version,
    },
    { additionalProperties: false },
);

/** Revert the current applet version to one already present in the host catalog. */
export function revertAppletTool(applets: AppletFeature, agentId: string) {
    return defineAgentTool({
        name: "revert_applet",
        description: "Revert an applet to one of its existing versions.",
        parameters: revertAppletToolInputSchema,
        returnType: Type.Object({ applet: appletSchema }),
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, { name, version }: { name: string } & AppletToolRevertInput) => ({
            applet: await applets.revertForAgent(ctx, agentId, name, { version }),
        }),
        toLLM: ({ applet }) => [
            {
                type: "text",
                text: applets.formatOperationForModel("Applet reverted", applet),
            },
        ],
    });
}
