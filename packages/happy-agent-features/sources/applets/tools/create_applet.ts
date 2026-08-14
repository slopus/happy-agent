import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    appletSchema,
    appletToolImportInputSchema,
    type AppletToolImportInput,
} from "../Applet.js";
import type { AppletFeature } from "../AppletFeature.js";

/** Create an applet from a host-owned source reference. */
export function createAppletTool(applets: AppletFeature, agentId: string) {
    return defineAgentTool({
        name: "create_applet",
        description:
            "Create a host-managed applet from a source reference. The host controls where the source is copied and served.",
        parameters: appletToolImportInputSchema,
        returnType: Type.Object({ applet: appletSchema }),
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: AppletToolImportInput) => ({
            applet: await applets.createForAgent(ctx, agentId, input),
        }),
        toLLM: ({ applet }) => [
            {
                type: "text",
                text: applets.formatOperationForModel("Applet created", applet),
            },
        ],
    });
}
